import crypto from 'crypto';
import { db } from '../config/database.js';
import type { ExternalNotificationOutboxRecord, UserSettings } from '../models/types.js';
import { checkAccountEligibility, getUserTimezone } from './accountService.js';
import { getExternalPolicyLookup, resolveExternalEventPolicy } from './externalEventPolicyService.js';
import { formatTimeInAccountTz, getAccountLocalDateKey, zonedWallClockToUtc } from '../utils/timezone.js';
import { invokeLlmWithFailover } from './llm.js';
import { checkWeixinProactiveEligibility, sendClawbotMessageWithReceipt, templates } from './clawbot.js';

const LOOKAHEAD_DAYS = 7;

function buildExternalReminderTimes(params: {
  startTimeIso: string;
  endTimeIso: string;
  isAllDay: boolean;
  leadMinutes: number;
  timezone: string;
}): { fireMs: number; expiresMs: number } | null {
  const startMs = new Date(params.startTimeIso).getTime();
  const endMs = new Date(params.endTimeIso).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;

  if (params.isAllDay) {
    const localDateKey = getAccountLocalDateKey(new Date(startMs), params.timezone);
    const morningFire = zonedWallClockToUtc(localDateKey, 8, 30, 0, 0, params.timezone).getTime();
    return {
      fireMs: morningFire,
      expiresMs: morningFire + 3 * 3600_000,
    };
  }

  const fireMs = startMs - Math.max(1, params.leadMinutes) * 60_000;
  const expiresMs = Math.min(endMs, startMs + 15 * 60_000);
  return { fireMs, expiresMs };
}

/**
 * 同步用户外部日历事件的 AI 提醒发件箱（无论外部日程是否设为可占用排程，只要未关闭提醒即入队）：
 * - 覆盖未来 7 天内的当前有效代次、未取消、未忽略且开启 AI 提醒的外部事件
 * - 若事件已取消/被忽略/关闭提醒/在同步中移除，则自动撤销对应的 pending/failed 提醒
 * - 已发送（sent/unknown）的同一触发时刻提醒绝不重复入队
 */
export function syncExternalNotificationOutboxForUser(
  userId: number,
  now: Date = new Date()
): { enqueued: number; cancelled: number } {
  const elig = checkAccountEligibility(userId);
  if (!elig.eligible) {
    const res = db
      .prepare(
        `UPDATE external_notification_outbox
         SET status = 'cancelled', last_error = 'account_ineligible', lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND status IN ('pending', 'failed')`
      )
      .run(userId);
    return { enqueued: 0, cancelled: res.changes };
  }

  const tz = getUserTimezone(userId);
  const settings = db
    .prepare('SELECT reminder_before_start_minutes FROM user_settings WHERE user_id = ?')
    .get(userId) as { reminder_before_start_minutes?: number } | undefined;
  const leadMinutes = Math.max(1, Number(settings?.reminder_before_start_minutes ?? 5));

  const windowStartIso = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const windowEndIso = new Date(now.getTime() + LOOKAHEAD_DAYS * 86_400_000).toISOString();

  const extRows = db
    .prepare(
      `SELECT ee.id, ee.uid, ee.subscription_id, ee.occurrence_start, ee.title,
              ee.start_time, ee.end_time, ee.is_all_day, ee.course_group_key, ee.course_group_label,
              cs.name as subscription_name
       FROM external_events ee
       LEFT JOIN calendar_subscriptions cs ON cs.id = ee.subscription_id
       WHERE ee.user_id = ?
         AND ee.end_time >= ?
         AND ee.start_time <= ?
         AND COALESCE(ee.status, 'CONFIRMED') != 'CANCELLED'
         AND (ee.subscription_id IS NULL OR COALESCE(ee.generation, 0) = COALESCE(cs.current_generation, 0))
       ORDER BY ee.start_time ASC`
    )
    .all(userId, windowStartIso, windowEndIso) as any[];

  const ignoredRows = db
    .prepare('SELECT subscription_id, event_uid, occurrence_start FROM calendar_ignored_instances WHERE user_id = ?')
    .all(userId) as Array<{ subscription_id: number; event_uid: string; occurrence_start: string }>;
  const ignoredSet = new Set(
    ignoredRows.map(r => `${r.subscription_id}::${r.event_uid}::${r.occurrence_start}`)
  );

  const lookup = getExternalPolicyLookup(userId);

  const activeByKey = new Map<
    string,
    {
      subscriptionId: number;
      eventUid: string;
      occurrenceStart: string;
      title: string;
      startTime: string;
      endTime: string;
      isAllDay: number;
      allowScheduling: number;
      fireIso: string;
      expiresIso: string;
      payloadJson: string;
    }
  >();

  for (const row of extRows) {
    const occStart = String(row.occurrence_start || row.start_time);
    if (row.subscription_id && row.uid && ignoredSet.has(`${row.subscription_id}::${row.uid}::${occStart}`)) {
      continue;
    }

    const policy = resolveExternalEventPolicy(row, lookup);
    if (!policy.aiReminderEnabled) continue;

    const times = buildExternalReminderTimes({
      startTimeIso: row.start_time,
      endTimeIso: row.end_time,
      isAllDay: Boolean(row.is_all_day),
      leadMinutes,
      timezone: tz,
    });
    if (!times) continue;
    if (now.getTime() > times.expiresMs) continue;

    const key = `${policy.subscriptionId}::${policy.eventUid}::${policy.occurrenceStart}`;
    activeByKey.set(key, {
      subscriptionId: policy.subscriptionId,
      eventUid: policy.eventUid,
      occurrenceStart: policy.occurrenceStart,
      title: row.title,
      startTime: row.start_time,
      endTime: row.end_time,
      isAllDay: row.is_all_day ? 1 : 0,
      allowScheduling: policy.allowScheduling ? 1 : 0,
      fireIso: new Date(times.fireMs).toISOString(),
      expiresIso: new Date(times.expiresMs).toISOString(),
      payloadJson: JSON.stringify({
        subscriptionId: policy.subscriptionId,
        subscriptionName: row.subscription_name || '外部日程',
        eventUid: policy.eventUid,
        occurrenceStart: policy.occurrenceStart,
        groupKey: policy.groupKey,
        groupLabel: policy.groupLabel,
        title: row.title,
        startTime: row.start_time,
        endTime: row.end_time,
        isAllDay: Boolean(row.is_all_day),
        allowScheduling: policy.allowScheduling,
        leadMinutes,
      }),
    });
  }

  let enqueued = 0;
  let cancelled = 0;

  db.transaction(() => {
    const pendingOrFailed = db
      .prepare(
        `SELECT * FROM external_notification_outbox
         WHERE user_id = ? AND status IN ('pending', 'failed')`
      )
      .all(userId) as ExternalNotificationOutboxRecord[];

    const cancelStmt = db.prepare(
      `UPDATE external_notification_outbox
       SET status = 'cancelled', last_error = ?, lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    );

    const pendingByKey = new Map<string, ExternalNotificationOutboxRecord>();
    for (const rec of pendingOrFailed) {
      const k = `${rec.subscription_id}::${rec.event_uid}::${rec.occurrence_start}`;
      const desired = activeByKey.get(k);
      if (!desired || desired.fireIso !== rec.scheduled_fire_at) {
        cancelStmt.run(desired ? 'rescheduled' : 'event_removed_or_reminder_disabled', rec.id);
        cancelled++;
      } else {
        pendingByKey.set(k, rec);
      }
    }

    const alreadySentStmt = db.prepare(
      `SELECT id FROM external_notification_outbox
       WHERE user_id = ? AND subscription_id = ? AND event_uid = ? AND occurrence_start = ?
         AND scheduled_fire_at = ? AND status IN ('sent', 'unknown')
       LIMIT 1`
    );

    const updatePendingStmt = db.prepare(
      `UPDATE external_notification_outbox
       SET title = ?, start_time = ?, end_time = ?, is_all_day = ?, allow_scheduling = ?,
           expires_at = ?, payload_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    );

    const insertStmt = db.prepare(
      `INSERT OR IGNORE INTO external_notification_outbox (
        user_id, subscription_id, event_uid, occurrence_start, title,
        start_time, end_time, is_all_day, allow_scheduling,
        scheduled_fire_at, expires_at, status, idempotency_key, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    );

    for (const [k, item] of activeByKey.entries()) {
      const sentBefore = alreadySentStmt.get(
        userId,
        item.subscriptionId,
        item.eventUid,
        item.occurrenceStart,
        item.fireIso
      );
      if (sentBefore) continue;

      const existingPending = pendingByKey.get(k);
      if (existingPending) {
        updatePendingStmt.run(
          item.title,
          item.startTime,
          item.endTime,
          item.isAllDay,
          item.allowScheduling,
          item.expiresIso,
          item.payloadJson,
          existingPending.id
        );
        continue;
      }

      const hash = crypto
        .createHash('sha1')
        .update(`${userId}:${k}:${item.fireIso}`)
        .digest('hex')
        .slice(0, 16);
      const idemKey = `extnotif:${userId}:${hash}`;

      const info = insertStmt.run(
        userId,
        item.subscriptionId,
        item.eventUid,
        item.occurrenceStart,
        item.title,
        item.startTime,
        item.endTime,
        item.isAllDay,
        item.allowScheduling,
        item.fireIso,
        item.expiresIso,
        idemKey,
        item.payloadJson
      );
      if (info.changes > 0) enqueued++;
    }
  })();

  return { enqueued, cancelled };
}

export function syncAllApprovedUsersExternalOutbox(now: Date = new Date()): void {
  const users = db
    .prepare(
      `SELECT DISTINCT ee.user_id
       FROM external_events ee
       JOIN users u ON u.id = ee.user_id
       WHERE u.status = 'approved'`
    )
    .all() as Array<{ user_id: number }>;

  for (const { user_id } of users) {
    try {
      syncExternalNotificationOutboxForUser(user_id, now);
    } catch (err: any) {
      console.warn(`[ExternalOutbox] Sync failed for user #${user_id}:`, err.message);
    }
  }
}

function claimDueExternalNotifications(
  leaseOwner: string,
  now: Date = new Date(),
  limit: number = 25,
  leaseSeconds: number = 60
): ExternalNotificationOutboxRecord[] {
  const nowIso = now.toISOString();
  const leaseUntilIso = new Date(now.getTime() + leaseSeconds * 1000).toISOString();

  return db.transaction(() => {
    db.prepare(
      `UPDATE external_notification_outbox
       SET status = 'expired', lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE status IN ('pending', 'failed') AND julianday(expires_at) < julianday(?)`
    ).run(nowIso);

    db.prepare(
      `UPDATE external_notification_outbox
       SET status = 'unknown',
           last_error = COALESCE(last_error, 'worker lease expired mid-delivery'),
           lease_owner = NULL,
           lease_until = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE status = 'sending' AND lease_until IS NOT NULL AND julianday(lease_until) < julianday(?)`
    ).run(nowIso);

    const due = db
      .prepare(
        `SELECT * FROM external_notification_outbox
         WHERE status IN ('pending', 'failed')
           AND julianday(scheduled_fire_at) <= julianday(?)
           AND julianday(expires_at) >= julianday(?)
           AND (next_retry_at IS NULL OR julianday(next_retry_at) <= julianday(?))
           AND (lease_until IS NULL OR julianday(lease_until) < julianday(?))
         ORDER BY scheduled_fire_at ASC
         LIMIT ?`
      )
      .all(nowIso, nowIso, nowIso, nowIso, limit) as ExternalNotificationOutboxRecord[];

    if (due.length === 0) return [];

    const claimStmt = db.prepare(
      `UPDATE external_notification_outbox
       SET status = 'sending', lease_owner = ?, lease_until = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    );
    for (const row of due) {
      claimStmt.run(leaseOwner, leaseUntilIso, row.id);
    }

    return due.map(r => ({
      ...r,
      status: 'sending' as const,
      lease_owner: leaseOwner,
      lease_until: leaseUntilIso,
    }));
  })();
}

function markExternalNotificationSent(outboxId: number, providerMsgId?: string | null): void {
  db.prepare(
    `UPDATE external_notification_outbox
     SET status = 'sent', provider_msg_id = ?, lease_owner = NULL, lease_until = NULL,
         last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(providerMsgId || null, outboxId);
}

function markExternalNotificationFailed(outboxId: number, errorMessage: string, maxAttempts: number = 3): void {
  const row = db
    .prepare('SELECT attempt_count FROM external_notification_outbox WHERE id = ?')
    .get(outboxId) as { attempt_count: number } | undefined;
  const nextCount = (row?.attempt_count || 0) + 1;
  const backoffSec = Math.min(300, 30 * 2 ** (nextCount - 1));
  const nextRetry = new Date(Date.now() + backoffSec * 1000).toISOString();

  if (nextCount >= maxAttempts) {
    db.prepare(
      `UPDATE external_notification_outbox
       SET status = 'failed', attempt_count = ?, next_retry_at = NULL,
           last_error = ?, lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(nextCount, errorMessage, outboxId);
  } else {
    db.prepare(
      `UPDATE external_notification_outbox
       SET status = 'failed', attempt_count = ?, next_retry_at = ?,
           last_error = ?, lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(nextCount, nextRetry, errorMessage, outboxId);
  }
}

function markExternalNotificationUnknown(outboxId: number, errorMessage: string): void {
  db.prepare(
    `UPDATE external_notification_outbox
     SET status = 'unknown', attempt_count = attempt_count + 1,
         last_error = ?, lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(errorMessage, outboxId);
}

function markExternalNotificationCancelled(outboxId: number, reason: string): void {
  db.prepare(
    `UPDATE external_notification_outbox
     SET status = 'cancelled', last_error = ?, lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(reason, outboxId);
}

function markExternalNotificationExpired(outboxId: number): void {
  db.prepare(
    `UPDATE external_notification_outbox
     SET status = 'expired', lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(outboxId);
}

interface NearbyTaskSummary {
  title: string;
  startStr: string;
  endStr: string;
  overlaps: boolean;
}

function queryNearbyScheduledTasks(
  userId: number,
  startIso: string,
  endIso: string,
  tz: string
): NearbyTaskSummary[] {
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  const windowStartIso = new Date(startMs - 30 * 60_000).toISOString();
  const windowEndIso = new Date(endMs + 30 * 60_000).toISOString();

  const rows = db
    .prepare(
      `SELECT sb.start_time, sb.end_time, t.title
       FROM schedule_blocks sb
       JOIN task_instances ti ON ti.id = sb.instance_id
       JOIN tasks t ON t.id = sb.task_id
       WHERE sb.user_id = ?
         AND sb.status IN ('planned', 'in_progress')
         AND ti.status IN ('pending', 'in_progress')
         AND t.status != 'cancelled'
         AND sb.end_time > ?
         AND sb.start_time < ?
       ORDER BY sb.start_time ASC
       LIMIT 6`
    )
    .all(userId, windowStartIso, windowEndIso) as Array<{
    start_time: string;
    end_time: string;
    title: string;
  }>;

  return rows.map(r => {
    const bStart = new Date(r.start_time).getTime();
    const bEnd = new Date(r.end_time).getTime();
    return {
      title: r.title,
      startStr: formatTimeInAccountTz(r.start_time, tz),
      endStr: formatTimeInAccountTz(r.end_time, tz),
      overlaps: bStart < endMs && bEnd > startMs,
    };
  });
}

async function generateExternalEventAiMessage(params: {
  userId: number;
  settings: UserSettings;
  title: string;
  subscriptionName: string;
  groupLabel: string;
  startTimeIso: string;
  endTimeIso: string;
  isAllDay: boolean;
  allowScheduling: boolean;
  leadMinutes: number;
  tz: string;
  nearbyTasks: NearbyTaskSummary[];
}): Promise<{ text: string; usedAi: boolean }> {
  const startStr = formatTimeInAccountTz(params.startTimeIso, params.tz);
  const endStr = formatTimeInAccountTz(params.endTimeIso, params.tz);
  const overlappingTasks = params.nearbyTasks.filter(t => t.overlaps);
  const adjacentTasks = params.nearbyTasks.filter(t => !t.overlaps);

  const fallbackText = templates.externalEventReminder({
    title: params.title,
    subscriptionName: params.subscriptionName,
    startStr,
    endStr,
    isAllDay: params.isAllDay,
    allowScheduling: params.allowScheduling,
    leadMinutes: params.leadMinutes,
    overlappingTasks: overlappingTasks.map(t => `${t.title} (${t.startStr}-${t.endStr})`),
  });

  try {
    const occupancyDesc = params.allowScheduling
      ? '用户已将此日程标记为「可占用排程」（系统允许在此时间段穿插安排其他待办，但用户仍希望 AI 提醒日程上有该事项）。'
      : '此日程当前为「占用时间段」（系统已避开此时段，未在此时段排入待办任务）。';

    const overlapDesc =
      overlappingTasks.length > 0
        ? `同时段已排入的待办任务：${overlappingTasks.map(t => `「${t.title}」(${t.startStr}-${t.endStr})`).join('、')}`
        : '同时段无重叠的待办任务。';

    const adjacentDesc =
      adjacentTasks.length > 0
        ? `前后30分钟内邻近待办：${adjacentTasks.map(t => `「${t.title}」(${t.startStr}-${t.endStr})`).join('、')}`
        : '前后30分钟内无其他待办。';

    const timeDesc = params.isAllDay
      ? `全天日程（今日 ${getAccountLocalDateKey(new Date(params.startTimeIso), params.tz)}）`
      : `${startStr} ~ ${endStr}（约 ${params.leadMinutes} 分钟后开始）`;

    const resp = await invokeLlmWithFailover({
      userId: params.userId,
      settings: params.settings,
      purpose: 'external_event_reminder',
      temperature: 0.4,
      responseFormatJson: false,
      timeoutMs: 10000,
      estimatedPromptTokens: 600,
      estimatedMaxOutputTokens: 220,
      messages: [
        {
          role: 'system',
          content:
            '你是 Clawbot 个人日程 AI 助手。请根据外部导入日历（如课程表/会议）和当前排程上下文，生成一条发送给用户的微信提醒消息。\n' +
            '要求：\n' +
            '1. 清晰点明外部日程名称、时间段与来源日历；\n' +
            '2. 明确体现当前排程占用状态：若为「可占用排程」，提醒用户虽然已让出时段但日程上仍有此课程/安排，若存在重叠待办务必指出，提醒注意时间取舍；若为「占用状态」，温和提示准备前往或开始；\n' +
            '3. 若有前后邻近待办，简短顺带提示衔接；\n' +
            '4. 控制在 120 字以内，纯文本自然口吻，不要使用 Markdown 标题或代码块。',
        },
        {
          role: 'user',
          content:
            `外部日程：${params.title}\n` +
            `课程/分组归类：${params.groupLabel}\n` +
            `来源日历：${params.subscriptionName}\n` +
            `时间：${timeDesc}\n` +
            `排程策略：${occupancyDesc}\n` +
            `${overlapDesc}\n` +
            `${adjacentDesc}`,
        },
      ],
    });

    const cleaned = resp.content.trim();
    if (cleaned) {
      return { text: cleaned, usedAi: true };
    }
  } catch (err: any) {
    console.warn(`[ExternalReminder] LLM generation fallback for user #${params.userId}:`, err.message);
  }

  return { text: fallbackText, usedAi: false };
}

/**
 * 领取并投递到期的外部日历 AI 提醒：
 * - 投递前再次核对账号资格、事件是否依然存在且未忽略、最新规则是否仍开启提醒
 * - 实时读取最新 allowScheduling 状态与重叠待办上下文，交由 AI 生成提醒文案（不可用时降级为清晰模板）
 */
export async function processExternalOutboxNotifications(
  now: Date = new Date(),
  leaseOwner: string = `ext-worker-${process.pid}`
): Promise<{ processed: number; sent: number; failed: number; unknown: number; cancelled: number; usedAiCount: number }> {
  const due = claimDueExternalNotifications(leaseOwner, now, 25, 60);
  let sent = 0;
  let failed = 0;
  let unknown = 0;
  let cancelled = 0;
  let usedAiCount = 0;

  for (const item of due) {
    const elig = checkAccountEligibility(item.user_id);
    if (!elig.eligible) {
      markExternalNotificationCancelled(item.id, `account_ineligible:${elig.reason}`);
      cancelled++;
      continue;
    }

    if (new Date(item.expires_at).getTime() < now.getTime()) {
      markExternalNotificationExpired(item.id);
      continue;
    }

    // Re-verify event still exists in active generation and isn't ignored/cancelled
    const ev = db
      .prepare(
        `SELECT ee.*, cs.name as subscription_name, cs.current_generation
         FROM external_events ee
         LEFT JOIN calendar_subscriptions cs ON cs.id = ee.subscription_id
         WHERE ee.user_id = ?
           AND COALESCE(ee.subscription_id, 0) = ?
           AND COALESCE(ee.uid, 'ext-row-' || ee.id) = ?
           AND COALESCE(ee.occurrence_start, ee.start_time) = ?
           AND COALESCE(ee.status, 'CONFIRMED') != 'CANCELLED'
           AND (ee.subscription_id IS NULL OR COALESCE(ee.generation, 0) = COALESCE(cs.current_generation, 0))
         LIMIT 1`
      )
      .get(item.user_id, item.subscription_id, item.event_uid, item.occurrence_start) as any;

    if (!ev) {
      markExternalNotificationCancelled(item.id, 'external_event_inactive_or_removed');
      cancelled++;
      continue;
    }

    if (ev.subscription_id && ev.uid) {
      const ignored = db
        .prepare(
          `SELECT 1 FROM calendar_ignored_instances
           WHERE user_id = ? AND subscription_id = ? AND event_uid = ? AND occurrence_start = ?
           LIMIT 1`
        )
        .get(item.user_id, ev.subscription_id, ev.uid, ev.occurrence_start || ev.start_time);
      if (ignored) {
        markExternalNotificationCancelled(item.id, 'external_event_ignored');
        cancelled++;
        continue;
      }
    }

    const lookup = getExternalPolicyLookup(item.user_id);
    const latestPolicy = resolveExternalEventPolicy(ev, lookup);
    if (!latestPolicy.aiReminderEnabled) {
      markExternalNotificationCancelled(item.id, 'ai_reminder_disabled');
      cancelled++;
      continue;
    }

    const settings = db
      .prepare('SELECT * FROM user_settings WHERE user_id = ?')
      .get(item.user_id) as UserSettings | undefined;
    if (!settings) {
      markExternalNotificationFailed(item.id, 'missing_user_settings');
      failed++;
      continue;
    }

    const deliveryCheck = checkWeixinProactiveEligibility(settings, now);
    if (!deliveryCheck.ok) {
      markExternalNotificationFailed(item.id, deliveryCheck.reason || 'delivery_channel_unavailable');
      failed++;
      continue;
    }

    let payload: any = {};
    try {
      payload = JSON.parse(item.payload_json);
    } catch {}

    const tz = getUserTimezone(item.user_id);
    const leadMinutes = Number(payload.leadMinutes ?? settings.reminder_before_start_minutes ?? 5);
    const nearbyTasks = queryNearbyScheduledTasks(item.user_id, ev.start_time, ev.end_time, tz);

    const { text: msg, usedAi } = await generateExternalEventAiMessage({
      userId: item.user_id,
      settings,
      title: ev.title,
      subscriptionName: ev.subscription_name || payload.subscriptionName || '外部日程',
      groupLabel: latestPolicy.groupLabel,
      startTimeIso: ev.start_time,
      endTimeIso: ev.end_time,
      isAllDay: Boolean(ev.is_all_day),
      allowScheduling: latestPolicy.allowScheduling,
      leadMinutes,
      tz,
      nearbyTasks,
    });
    if (usedAi) usedAiCount++;

    const receipt = await sendClawbotMessageWithReceipt(settings, msg, item.idempotency_key);
    if (receipt.outcome === 'sent') {
      markExternalNotificationSent(item.id, receipt.providerMsgId);
      sent++;
    } else if (receipt.outcome === 'unknown') {
      markExternalNotificationUnknown(item.id, receipt.error || 'delivery_outcome_unknown');
      unknown++;
    } else {
      markExternalNotificationFailed(item.id, receipt.error || 'delivery_failed');
      failed++;
    }
  }

  return { processed: due.length, sent, failed, unknown, cancelled, usedAiCount };
}
