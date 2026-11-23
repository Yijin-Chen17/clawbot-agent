import { formatLocalDate, replanUserTasks } from './scheduler.js';
import cron from 'node-cron';
import { db } from '../config/database.js';
import { Task, UserSettings, CalendarSubscription } from '../models/types.js';
import { templates, sendClawbotMessage } from './clawbot.js';
import { syncSubscription } from './calendarSync.js';

const lastDailyRolloverByUser = new Map<number, string>();

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
 * 查找下一个待触发开始/结束提醒的未完成调度块索引（兼容单块与跨多天拆分块）
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

function parseTaskScheduleBlocks(raw?: string | null): ScheduleBlockReminderState[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.map(b => ({ ...b })) : [];
  } catch {
    return [];
  }
}

export function startReminderScheduler() {
  console.log('⏰ [Scheduler] Reminder & Calendar Sync Worker started (Every 30s)');

  // Run every 30 seconds
  cron.schedule('*/30 * * * * *', async () => {
    try {
      const now = new Date();
      const today = formatLocalDate(now);
      const todayStartIso = new Date(today + 'T00:00:00').toISOString();
      // 跨零点后对所有含每日固定任务（含浮动 is_fixed=0 与固定 is_fixed=1）或已过期浮动任务的用户自动日切重排（每人每天一次）
      const users = db.prepare(`
        SELECT DISTINCT user_id FROM tasks
        WHERE status IN ('scheduled', 'in_progress', 'pending_slot')
          AND (
            time_mode = 'daily_fixed'
            OR (is_fixed = 0 AND scheduled_end IS NOT NULL AND julianday(scheduled_end) < julianday(?))
          )
      `).all(todayStartIso) as { user_id: number }[];
      for (const { user_id } of users) {
        if (lastDailyRolloverByUser.get(user_id) !== today) {
          replanUserTasks(user_id);
          lastDailyRolloverByUser.set(user_id, today);
        }
      }
      await checkStartReminders();
      await checkEndReminders();
      await checkCalendarSync();
    } catch (err: any) {
      console.error('[Scheduler Error]:', err.message);
    }
  });
}

/**
 * Check and send start reminders (supports per-block reminders on split tasks)
 */
async function checkStartReminders() {
  const now = new Date();

  const candidateTasks = db.prepare(`
    SELECT t.*, u.username
    FROM tasks t
    JOIN users u ON t.user_id = u.id
    WHERE t.status IN ('scheduled', 'in_progress')
      AND t.scheduled_start IS NOT NULL
  `).all() as (Task & { username: string })[];

  for (const task of candidateTasks) {
    const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(task.user_id) as UserSettings;
    if (!settings) continue;

    const leadMinutes = settings.reminder_before_start_minutes ?? 5;
    const blocks = parseTaskScheduleBlocks(task.schedule_blocks);

    if (blocks.length > 0) {
      const dueIdx = findDueReminderBlockIndex(blocks, now, leadMinutes, 'start');
      if (dueIdx === -1) continue;

      const block = blocks[dueIdx];
      block.startReminderSent = true;
      const allStarted = blocks.every(b => b.completed || b.startReminderSent);

      db.prepare(`
        UPDATE tasks
        SET schedule_blocks = ?,
            start_reminder_sent = ?,
            status = 'in_progress'
        WHERE id = ?
      `).run(JSON.stringify(blocks), allStarted ? 1 : 0, task.id);

      const sTime = new Date(block.start);
      const eTime = new Date(block.end);
      const sStr = sTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
      const eStr = eTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
      const partLabel = block.totalParts && block.totalParts > 1 ? ` (${block.partIndex || dueIdx + 1}/${block.totalParts}节)` : '';

      const msg = templates.reminderBeforeStart(`${task.title}${partLabel}`, sStr, eStr, leadMinutes);
      await sendClawbotMessage(settings, msg);
      console.log(`[Reminder] Sent START reminder for task #${task.id} (${task.title}${partLabel}) to user #${task.user_id}`);
      continue;
    }

    if (task.start_reminder_sent !== 0 || task.status !== 'scheduled') continue;
    const startTime = new Date(task.scheduled_start!);
    const triggerTime = new Date(startTime.getTime() - leadMinutes * 60 * 1000);

    if (now >= triggerTime && now <= new Date(startTime.getTime() + 3 * 60 * 1000)) {
      const sStr = startTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
      const eStr = task.scheduled_end ? new Date(task.scheduled_end).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';

      db.prepare("UPDATE tasks SET start_reminder_sent = 1, status = 'in_progress' WHERE id = ?").run(task.id);

      const msg = templates.reminderBeforeStart(task.title, sStr, eStr, leadMinutes);
      await sendClawbotMessage(settings, msg);
      console.log(`[Reminder] Sent START reminder for task #${task.id} (${task.title}) to user #${task.user_id}`);
    }
  }
}

/**
 * Check and send approaching end reminders (supports per-block check-in on split tasks)
 */
async function checkEndReminders() {
  const now = new Date();

  const activeTasks = db.prepare(`
    SELECT t.*, u.username
    FROM tasks t
    JOIN users u ON t.user_id = u.id
    WHERE t.status IN ('scheduled', 'in_progress')
      AND t.scheduled_end IS NOT NULL
  `).all() as (Task & { username: string })[];

  for (const task of activeTasks) {
    const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(task.user_id) as UserSettings;
    if (!settings) continue;

    const leadMinutes = settings.reminder_before_end_minutes ?? 5;
    const blocks = parseTaskScheduleBlocks(task.schedule_blocks);

    if (blocks.length > 0) {
      const dueIdx = findDueReminderBlockIndex(blocks, now, leadMinutes, 'end');
      if (dueIdx === -1) continue;

      const block = blocks[dueIdx];
      block.endReminderSent = true;
      const allEnded = blocks.every(b => b.completed || b.endReminderSent);

      db.prepare(`
        UPDATE tasks
        SET schedule_blocks = ?,
            end_reminder_sent = ?
        WHERE id = ?
      `).run(JSON.stringify(blocks), allEnded ? 1 : 0, task.id);

      const partLabel = block.totalParts && block.totalParts > 1 ? ` (${block.partIndex || dueIdx + 1}/${block.totalParts}节)` : '';
      const msg = templates.reminderBeforeEnd(`${task.title}${partLabel}`, leadMinutes);
      await sendClawbotMessage(settings, msg);
      console.log(`[Reminder] Sent END check-in for task #${task.id} (${task.title}${partLabel}) to user #${task.user_id}`);
      continue;
    }

    if (task.end_reminder_sent !== 0) continue;
    const endTime = new Date(task.scheduled_end!);
    const triggerTime = new Date(endTime.getTime() - leadMinutes * 60 * 1000);

    if (now >= triggerTime && now <= new Date(endTime.getTime() + 15 * 60 * 1000)) {
      db.prepare("UPDATE tasks SET end_reminder_sent = 1 WHERE id = ?").run(task.id);

      const msg = templates.reminderBeforeEnd(task.title, leadMinutes);
      await sendClawbotMessage(settings, msg);
      console.log(`[Reminder] Sent END check-in for task #${task.id} (${task.title}) to user #${task.user_id}`);
    }
  }
}

/**
 * Periodically sync external calendar subscriptions
 */
async function checkCalendarSync() {
  const subs = db.prepare(`
    SELECT cs.*, us.calendar_sync_interval_minutes
    FROM calendar_subscriptions cs
    JOIN user_settings us ON cs.user_id = us.user_id
  `).all() as (CalendarSubscription & { calendar_sync_interval_minutes: number })[];

  const now = new Date();
  const usersToReplan = new Set<number>();

  for (const sub of subs) {
    const intervalMin = sub.calendar_sync_interval_minutes || 60;
    const lastSync = sub.last_sync_at ? new Date(sub.last_sync_at) : new Date(0);

    if (now.getTime() - lastSync.getTime() >= intervalMin * 60 * 1000) {
      try {
        console.log(`[CalendarSync] Auto-syncing calendar subscription #${sub.id} (${sub.name})...`);
        await syncSubscription(sub);
        usersToReplan.add(sub.user_id);
      } catch (err: any) {
        console.error(`[CalendarSync] Auto-sync failed for #${sub.id}:`, err.message);
      }
    }
  }

  for (const uid of usersToReplan) {
    try {
      replanUserTasks(uid);
    } catch (err: any) {
      console.error(`[CalendarSync] Replan after auto-sync failed for user #${uid}:`, err.message);
    }
  }
}
