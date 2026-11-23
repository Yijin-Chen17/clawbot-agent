import { db } from '../config/database.js';
import type { NotificationOutboxRecord, ScheduleBlockRecord, UserSettings } from '../models/types.js';

/**
 * 计划提交事务内同步通知发件箱（C02, C03）：
 * - 撤销所有旧版计划/已失效/已重排/已完成块对应的 pending/failed 通知
 * - 为新计划中的未完成、未来时段块生成 start 与 end 待投递记录
 * - 若同一 block_id 与相同触发时刻的提醒已经 sent，不重复创建
 */
export function syncOutboxForCommittedPlan(params: {
  userId: number;
  planVersion: number;
  activeBlocks: ScheduleBlockRecord[];
  taskTitlesById: Map<number, string>;
  settings?: UserSettings;
  now?: Date;
}): void {
  const now = params.now || new Date();
  const leadStartMin = params.settings?.reminder_before_start_minutes ?? 5;
  const leadEndMin = params.settings?.reminder_before_end_minutes ?? 5;

  // Cancel all pending/failed notifications from earlier plan versions or non-active blocks
  db.prepare(`
    UPDATE notification_outbox
    SET status = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
      AND status IN ('pending', 'failed')
      AND plan_version < ?
  `).run(params.userId, params.planVersion);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO notification_outbox (
      user_id, instance_id, block_id, plan_version, reminder_type, channel,
      scheduled_fire_at, expires_at, status, idempotency_key, payload_json
    ) VALUES (?, ?, ?, ?, ?, 'auto', ?, ?, 'pending', ?, ?)
  `);

  const alreadySentStmt = db.prepare(`
    SELECT id FROM notification_outbox
    WHERE block_id = ? AND reminder_type = ? AND status IN ('sent', 'unknown') AND scheduled_fire_at = ?
    LIMIT 1
  `);

  for (const block of params.activeBlocks) {
    if (block.status !== 'planned' && block.status !== 'in_progress') continue;

    const startMs = new Date(block.start_time).getTime();
    const endMs = new Date(block.end_time).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;

    const title = params.taskTitlesById.get(block.task_id) || '待办任务';

    // Start reminder (only if block hasn't already started / isn't past grace window)
    if (block.status === 'planned') {
      const startFireMs = startMs - leadStartMin * 60_000;
      const startExpMs = Math.min(endMs, startMs + 10 * 60_000);
      if (now.getTime() <= startExpMs) {
        const startFireIso = new Date(startFireMs).toISOString();
        const sentBefore = alreadySentStmt.get(block.id, 'start', startFireIso);
        if (!sentBefore) {
          const idemKey = `notif:${params.userId}:${block.id}:v${params.planVersion}:start`;
          insertStmt.run(
            params.userId,
            block.instance_id,
            block.id,
            params.planVersion,
            'start',
            startFireIso,
            new Date(startExpMs).toISOString(),
            idemKey,
            JSON.stringify({
              taskId: block.task_id,
              instanceId: block.instance_id,
              blockId: block.id,
              title,
              startTime: block.start_time,
              endTime: block.end_time,
              partIndex: block.part_index,
              totalParts: block.total_parts,
              leadMinutes: leadStartMin,
            })
          );
        }
      }
    }

    // End check-in reminder
    const endFireMs = endMs - leadEndMin * 60_000;
    const endExpMs = endMs + 20 * 60_000;
    if (now.getTime() <= endExpMs) {
      const endFireIso = new Date(endFireMs).toISOString();
      const sentBefore = alreadySentStmt.get(block.id, 'end', endFireIso);
      if (!sentBefore) {
        const idemKey = `notif:${params.userId}:${block.id}:v${params.planVersion}:end`;
        insertStmt.run(
          params.userId,
          block.instance_id,
          block.id,
          params.planVersion,
          'end',
          endFireIso,
          new Date(endExpMs).toISOString(),
          idemKey,
          JSON.stringify({
            taskId: block.task_id,
            instanceId: block.instance_id,
            blockId: block.id,
            title,
            startTime: block.start_time,
            endTime: block.end_time,
            partIndex: block.part_index,
            totalParts: block.total_parts,
            leadMinutes: leadEndMin,
          })
        );
      }
    }
  }
}

export function cancelNotificationsForInstance(instanceId: number): void {
  db.prepare(`
    UPDATE notification_outbox
    SET status = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE instance_id = ? AND status IN ('pending', 'failed')
  `).run(instanceId);
}

export function cancelNotificationsForBlock(blockId: string): void {
  db.prepare(`
    UPDATE notification_outbox
    SET status = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE block_id = ? AND status IN ('pending', 'failed')
  `).run(blockId);
}

/**
 * 带可恢复租约领取待投递提醒（C02, C03）：
 * 进程崩溃后，租约过期即可由新 Worker 接续处理。
 */
export function claimDueNotifications(
  leaseOwner: string,
  now: Date = new Date(),
  limit: number = 25,
  leaseSeconds: number = 60
): NotificationOutboxRecord[] {
  const nowIso = now.toISOString();
  const leaseUntilIso = new Date(now.getTime() + leaseSeconds * 1000).toISOString();

  return db.transaction(() => {
    // 1. Mark expired records
    db.prepare(`
      UPDATE notification_outbox
      SET status = 'expired', lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('pending', 'failed') AND julianday(expires_at) < julianday(?)
    `).run(nowIso);

    // 2. Reclaim crashed 'sending' records whose lease expired
    db.prepare(`
      UPDATE notification_outbox
      SET status = 'unknown',
          last_error = COALESCE(last_error, 'worker lease expired mid-delivery'),
          lease_owner = NULL,
          lease_until = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'sending' AND lease_until IS NOT NULL AND julianday(lease_until) < julianday(?)
    `).run(nowIso);

    // 3. Select due pending or retryable failed notifications
    const due = db.prepare(`
      SELECT * FROM notification_outbox
      WHERE status IN ('pending', 'failed')
        AND julianday(scheduled_fire_at) <= julianday(?)
        AND julianday(expires_at) >= julianday(?)
        AND (next_retry_at IS NULL OR julianday(next_retry_at) <= julianday(?))
        AND (lease_until IS NULL OR julianday(lease_until) < julianday(?))
      ORDER BY scheduled_fire_at ASC
      LIMIT ?
    `).all(nowIso, nowIso, nowIso, nowIso, limit) as NotificationOutboxRecord[];

    if (due.length === 0) return [];

    const claimStmt = db.prepare(`
      UPDATE notification_outbox
      SET status = 'sending', lease_owner = ?, lease_until = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    for (const row of due) {
      claimStmt.run(leaseOwner, leaseUntilIso, row.id);
    }

    return due.map(r => ({ ...r, status: 'sending' as const, lease_owner: leaseOwner, lease_until: leaseUntilIso }));
  })();
}

export function markNotificationSent(outboxId: number, providerMsgId?: string | null): void {
  db.prepare(`
    UPDATE notification_outbox
    SET status = 'sent', provider_msg_id = ?, lease_owner = NULL, lease_until = NULL,
        last_error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(providerMsgId || null, outboxId);
}

export function markNotificationFailed(outboxId: number, errorMessage: string, maxAttempts: number = 3): void {
  const row = db.prepare('SELECT attempt_count FROM notification_outbox WHERE id = ?').get(outboxId) as
    | { attempt_count: number }
    | undefined;
  const nextCount = (row?.attempt_count || 0) + 1;
  const backoffSec = Math.min(300, 30 * 2 ** (nextCount - 1));
  const nextRetry = new Date(Date.now() + backoffSec * 1000).toISOString();

  if (nextCount >= maxAttempts) {
    db.prepare(`
      UPDATE notification_outbox
      SET status = 'failed', attempt_count = ?, next_retry_at = NULL,
          last_error = ?, lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(nextCount, errorMessage, outboxId);
  } else {
    db.prepare(`
      UPDATE notification_outbox
      SET status = 'failed', attempt_count = ?, next_retry_at = ?,
          last_error = ?, lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(nextCount, nextRetry, errorMessage, outboxId);
  }
}

export function markNotificationUnknown(outboxId: number, errorMessage: string): void {
  db.prepare(`
    UPDATE notification_outbox
    SET status = 'unknown', attempt_count = attempt_count + 1,
        last_error = ?, lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(errorMessage, outboxId);
}

export function markNotificationCancelled(outboxId: number, reason: string): void {
  db.prepare(`
    UPDATE notification_outbox
    SET status = 'cancelled', last_error = ?, lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(reason, outboxId);
}

export function markNotificationExpired(outboxId: number): void {
  db.prepare(`
    UPDATE notification_outbox
    SET status = 'expired', lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(outboxId);
}
