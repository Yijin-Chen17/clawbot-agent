import crypto from 'crypto';
import cron from 'node-cron';
import { db } from '../config/database.js';
import { CalendarSubscription, ScheduleBlockRecord, TaskInstance, UserSettings } from '../models/types.js';
import { templates, sendClawbotMessageWithReceipt } from './clawbot.js';
import { syncSubscription } from './calendarSync.js';
import { checkAccountEligibility, getUserTimezone } from './accountService.js';
import { getAccountLocalDateKey, formatTimeInAccountTz } from '../utils/timezone.js';
import { replanUserTasks } from './scheduler.js';
import {
  claimDueNotifications,
  markNotificationCancelled,
  markNotificationExpired,
  markNotificationFailed,
  markNotificationSent,
  markNotificationUnknown,
} from './outboxService.js';

const lastDailyRolloverByUser = new Map<number, string>();
const PROCESS_LEASE_OWNER = `worker-${process.pid}-${crypto.randomUUID().slice(0, 6)}`;

export interface ScheduleBlockReminderState {
  start: string;
  end: string;
  duration?: number;
  partIndex?: number;
  totalParts?: number;
  completed?: boolean;
  startReminderSent?: boolean;
  endReminderSent?: boolean;
}

/**
 * 保留既有纯函数辅助以兼容单测
 */
export function findDueReminderBlockIndex(
  blocks: ScheduleBlockReminderState[],
  now: Date,
  leadMinutes: number,
  mode: 'start' | 'end'
): number {
  for (let idx = 0; idx < blocks.length; idx++) {
    const b = blocks[idx];
    if (!b || b.completed) continue;
    const rawTime = mode === 'start' ? b.start : b.end;
    const targetTime = new Date(rawTime);
    if (Number.isNaN(targetTime.getTime())) continue;

    if (mode === 'start') {
      if (b.startReminderSent) continue;
      const triggerTime = new Date(targetTime.getTime() - leadMinutes * 60 * 1000);
      if (now >= triggerTime && now <= new Date(targetTime.getTime() + 3 * 60 * 1000)) {
        return idx;
      }
    } else {
      if (b.endReminderSent) continue;
      const triggerTime = new Date(targetTime.getTime() - leadMinutes * 60 * 1000);
      if (now >= triggerTime && now <= new Date(targetTime.getTime() + 15 * 60 * 1000)) {
        return idx;
      }
    }
  }
  return -1;
}

let rolloverRunning = false;
let notificationsRunning = false;
let calendarSyncRunning = false;

/**
 * 拆分后台调度器为三个独立作业：日切重排、通知投递、外部日历同步（A02, C02, C03）
 */
export function startReminderScheduler() {
  console.log('⏰ [Scheduler] Rollover, Outbox Notification & Calendar Sync Workers started');

  // 1. Daily rollover per account timezone (every 30s)
  cron.schedule('*/30 * * * * *', () => {
    if (rolloverRunning) return;
    rolloverRunning = true;
    try {
      runDailyRolloverCycle(new Date());
    } catch (err: any) {
      console.error('[Rollover Error]:', err.message);
    } finally {
      rolloverRunning = false;
    }
  });

  // 2. Notification outbox consumer (every 15s, non-blocking relative to calendar sync)
  cron.schedule('*/15 * * * * *', async () => {
    if (notificationsRunning) return;
    notificationsRunning = true;
    try {
      await processOutboxNotifications(new Date());
    } catch (err: any) {
      console.error('[Outbox Error]:', err.message);
    } finally {
      notificationsRunning = false;
    }
  });

  // 3. Calendar sync worker (every 60s)
  cron.schedule('0 * * * * *', async () => {
    if (calendarSyncRunning) return;
    calendarSyncRunning = true;
    try {
      await checkCalendarSync(new Date());
    } catch (err: any) {
      console.error('[CalendarSync Error]:', err.message);
    } finally {
      calendarSyncRunning = false;
    }
  });
}

/**
 * 按账户本地日期执行日切重排（A02, C06）
 */
export function runDailyRolloverCycle(now: Date = new Date()): number[] {
  const users = db.prepare(`
    SELECT DISTINCT t.user_id
    FROM tasks t
    JOIN users u ON u.id = t.user_id
    WHERE u.status = 'approved'
      AND t.status != 'cancelled'
      AND (
        (t.time_mode = 'daily_fixed' AND COALESCE(t.active_template, 1) = 1)
        OR (t.is_fixed = 0 AND t.status IN ('scheduled', 'in_progress', 'pending_slot') AND t.scheduled_end IS NOT NULL)
      )
  `).all() as Array<{ user_id: number }>;

  const replannedUsers: number[] = [];
  for (const { user_id } of users) {
    const tz = getUserTimezone(user_id);
    const localToday = getAccountLocalDateKey(now, tz);
    if (lastDailyRolloverByUser.get(user_id) === localToday) continue;

    // Check if user has daily templates lacking today's instance or expired movable blocks
    const needsDaily = db.prepare(`
      SELECT 1 FROM tasks t
      WHERE t.user_id = ?
        AND t.time_mode = 'daily_fixed'
        AND COALESCE(t.active_template, 1) = 1
        AND t.status != 'cancelled'
        AND NOT EXISTS (
          SELECT 1 FROM task_instances ti WHERE ti.task_id = t.id AND ti.business_date = ?
        )
      LIMIT 1
    `).get(user_id, localToday);

    const hasPastMovable = db.prepare(`
      SELECT 1 FROM schedule_blocks
      WHERE user_id = ? AND status = 'planned' AND is_fixed = 0
        AND julianday(end_time) < julianday(?)
      LIMIT 1
    `).get(user_id, now.toISOString());

    if (needsDaily || hasPastMovable) {
      replanUserTasks(user_id, { triggerSource: 'daily_rollover', now });
      replannedUsers.push(user_id);
    }
    lastDailyRolloverByUser.set(user_id, localToday);
  }
  return replannedUsers;
}

/**
 * 从持久化发件箱领取并投递到期提醒（C02, C03）：
 * - 投递前再次核对账号资格、实例状态、分段有效性
 * - 渠道接受只更新 notification_outbox 为 sent，绝不把实例改成 in_progress
 * - 失败按退避重试，超时记录 unknown 等待核对，失效/已取消则撤销
 */
export async function processOutboxNotifications(
  now: Date = new Date(),
  leaseOwner: string = PROCESS_LEASE_OWNER
): Promise<{ processed: number; sent: number; failed: number; unknown: number; cancelled: number }> {
  const due = claimDueNotifications(leaseOwner, now, 30, 60);
  let sent = 0;
  let failed = 0;
  let unknown = 0;
  let cancelled = 0;

  for (const item of due) {
    const elig = checkAccountEligibility(item.user_id);
    if (!elig.eligible) {
      markNotificationCancelled(item.id, `account_ineligible:${elig.reason}`);
      cancelled++;
      continue;
    }

    const inst = db.prepare('SELECT * FROM task_instances WHERE id = ?').get(item.instance_id) as TaskInstance | undefined;
    if (!inst || inst.status === 'completed' || inst.status === 'cancelled') {
      markNotificationCancelled(item.id, 'instance_terminal');
      cancelled++;
      continue;
    }

    const block = db.prepare('SELECT * FROM schedule_blocks WHERE id = ?').get(item.block_id) as ScheduleBlockRecord | undefined;
    if (!block || (block.status !== 'planned' && block.status !== 'in_progress')) {
      markNotificationCancelled(item.id, 'block_inactive_or_superseded');
      cancelled++;
      continue;
    }

    if (new Date(item.expires_at).getTime() < now.getTime()) {
      markNotificationExpired(item.id);
      continue;
    }

    const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(item.user_id) as UserSettings | undefined;
    if (!settings) {
      markNotificationFailed(item.id, 'missing_user_settings');
      failed++;
      continue;
    }

    let payload: any = {};
    try {
      payload = JSON.parse(item.payload_json);
    } catch {}

    const tz = getUserTimezone(item.user_id);
    const partLabel = payload.totalParts && payload.totalParts > 1 ? ` (${payload.partIndex}/${payload.totalParts}节)` : '';
    const titleLabel = `${payload.title || '待办任务'}${partLabel}`;

    const msg =
      item.reminder_type === 'start'
        ? templates.reminderBeforeStart(
            titleLabel,
            formatTimeInAccountTz(block.start_time, tz),
            formatTimeInAccountTz(block.end_time, tz),
            payload.leadMinutes ?? settings.reminder_before_start_minutes ?? 5
          )
        : templates.reminderBeforeEnd(
            titleLabel,
            payload.leadMinutes ?? settings.reminder_before_end_minutes ?? 5
          );

    const receipt = await sendClawbotMessageWithReceipt(settings, msg, item.idempotency_key);
    if (receipt.outcome === 'sent') {
      markNotificationSent(item.id, receipt.providerMsgId);
      sent++;
    } else if (receipt.outcome === 'unknown') {
      markNotificationUnknown(item.id, receipt.error || 'delivery_outcome_unknown');
      unknown++;
    } else {
      markNotificationFailed(item.id, receipt.error || 'delivery_failed');
      failed++;
    }
  }

  return { processed: due.length, sent, failed, unknown, cancelled };
}

/**
 * 定时同步外部日历订阅（A02, C03, C04）：
 * - 跳过已封禁/未放行账号
 * - 基于 last_attempt_at 节流，防止失败订阅每轮高频重试
 * - 仅在内容确实发生变更时重排用户任务
 */
export async function checkCalendarSync(now: Date = new Date()): Promise<void> {
  const subs = db.prepare(`
    SELECT cs.*, us.calendar_sync_interval_minutes
    FROM calendar_subscriptions cs
    JOIN user_settings us ON cs.user_id = us.user_id
    JOIN users u ON u.id = cs.user_id
    WHERE u.status = 'approved'
  `).all() as (CalendarSubscription & { calendar_sync_interval_minutes: number })[];

  const usersToReplan = new Set<number>();

  for (const sub of subs) {
    const intervalMin = Math.max(5, sub.calendar_sync_interval_minutes || 60);
    const lastReference = sub.last_attempt_at || sub.last_sync_at;
    const lastMs = lastReference ? new Date(lastReference).getTime() : 0;

    if (now.getTime() - lastMs >= intervalMin * 60 * 1000) {
      try {
        const res = await syncSubscription(sub);
        if (res.changed) {
          usersToReplan.add(sub.user_id);
        }
      } catch (err: any) {
        console.error(`[CalendarSync] Auto-sync failed for #${sub.id}:`, err.message);
      }
    }
  }

  for (const uid of usersToReplan) {
    try {
      replanUserTasks(uid, { triggerSource: 'calendar_auto_sync' });
    } catch (err: any) {
      console.error(`[CalendarSync] Replan after auto-sync failed for user #${uid}:`, err.message);
    }
  }
}
