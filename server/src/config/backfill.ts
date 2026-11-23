import type Database from 'better-sqlite3';
import crypto from 'crypto';
import { getAccountLocalDateKey, parseAccountDateOrIso, resolveAccountTimezone } from '../utils/timezone.js';

export interface ReconciliationReport {
  taskCount: number;
  instanceCount: number;
  blockCount: number;
  planCount: number;
  issues: Array<{ category: string; entityType: string; entityId: string; detail: string }>;
}

/**
 * Safely parse JSON array
 */
function parseJsonArray<T = any>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Backfill existing tasks, completed_dates, and schedule_blocks into
 * task_instances, schedule_plans, schedule_blocks, and migration_reconcile_logs.
 * Preserves all original task IDs and is idempotent.
 */
export function backfillLegacyData(db: Database.Database): void {
  const settingsRows = db.prepare('SELECT user_id, timezone FROM user_settings').all() as Array<{ user_id: number; timezone?: string }>;
  const tzByUser = new Map<number, string>();
  for (const s of settingsRows) {
    tzByUser.set(s.user_id, resolveAccountTimezone(s.timezone));
  }

  const tasks = db.prepare('SELECT * FROM tasks ORDER BY user_id ASC, id ASC').all() as any[];
  if (tasks.length === 0) return;

  const logReconcile = db.prepare(`
    INSERT INTO migration_reconcile_logs (category, entity_type, entity_id, detail_json)
    VALUES (?, ?, ?, ?)
  `);

  const insertInstance = db.prepare(`
    INSERT OR IGNORE INTO task_instances (
      task_id, user_id, business_date, instance_type, status,
      estimated_minutes, completed_minutes, plan_status, allocated_minutes, unallocated_minutes,
      version, started_at, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  `);

  const insertBlock = db.prepare(`
    INSERT OR IGNORE INTO schedule_blocks (
      id, user_id, plan_version, instance_id, task_id,
      start_time, end_time, duration_minutes, part_index, total_parts,
      is_fixed, is_committed, is_concurrent, status,
      energy_zone, strategy_label, break_after_minutes, created_at, updated_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const usersWithPlans = new Set<number>();

  for (const t of tasks) {
    const tz = tzByUser.get(t.user_id) || 'Asia/Shanghai';
    const createdDate = t.created_at ? new Date(t.created_at) : new Date();
    const safeCreated = Number.isNaN(createdDate.getTime()) ? new Date() : createdDate;
    const createdBusinessDate = getAccountLocalDateKey(safeCreated, tz);
    const todayBusinessDate = getAccountLocalDateKey(new Date(), tz);
    const isDaily = t.time_mode === 'daily_fixed';

    const origDur = Number(t.original_duration_minutes) > 0 ? Number(t.original_duration_minutes) : Math.max(1, Number(t.duration_minutes) || 60);
    const remDur = Math.max(0, Number(t.duration_minutes) || 0);
    const completedMins = t.status === 'completed' ? origDur : Math.max(0, origDur - remDur);

    if (Number(t.original_duration_minutes) <= 0 && remDur > 0 && t.status !== 'completed') {
      logReconcile.run('unknown_original_duration', 'task', String(t.id), JSON.stringify({
        title: t.title,
        duration_minutes: t.duration_minutes,
        original_duration_minutes: t.original_duration_minutes,
      }));
    }

    if (t.status === 'in_progress') {
      logReconcile.run('unknown_actual_start', 'task', String(t.id), JSON.stringify({
        title: t.title,
        scheduled_start: t.scheduled_start,
        start_reminder_sent: t.start_reminder_sent,
      }));
    }

    if (t.start_reminder_sent || t.end_reminder_sent) {
      logReconcile.run('legacy_reminder_marker', 'task', String(t.id), JSON.stringify({
        start_reminder_sent: t.start_reminder_sent,
        end_reminder_sent: t.end_reminder_sent,
      }));
    }

    if (isDaily) {
      const doneDates = parseJsonArray<string>(t.completed_dates).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(String(d)));
      for (const dKey of doneDates) {
        insertInstance.run(
          t.id,
          t.user_id,
          dKey,
          'daily',
          'completed',
          origDur,
          origDur,
          'scheduled',
          origDur,
          0,
          null,
          t.updated_at || new Date().toISOString(),
          t.created_at || new Date().toISOString(),
          t.updated_at || new Date().toISOString()
        );
      }

      // Ensure today's daily instance exists if template is not globally completed/cancelled
      if (t.status !== 'cancelled' && !doneDates.includes(todayBusinessDate)) {
        const instStatus = t.status === 'completed' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending';
        insertInstance.run(
          t.id,
          t.user_id,
          todayBusinessDate,
          'daily',
          instStatus,
          origDur,
          instStatus === 'completed' ? origDur : 0,
          t.scheduled_start && t.scheduled_end ? 'scheduled' : 'pending',
          t.scheduled_start && t.scheduled_end ? remDur : 0,
          t.scheduled_start && t.scheduled_end ? 0 : remDur,
          null,
          instStatus === 'completed' ? (t.updated_at || new Date().toISOString()) : null,
          t.created_at || new Date().toISOString(),
          t.updated_at || new Date().toISOString()
        );
      }
    } else {
      const instStatus =
        t.status === 'completed'
          ? 'completed'
          : t.status === 'cancelled'
          ? 'cancelled'
          : t.status === 'in_progress'
          ? 'in_progress'
          : 'pending';

      const parsedBlocks = parseJsonArray<any>(t.schedule_blocks);
      let allocated = 0;
      const validBlocks: any[] = [];
      for (const b of parsedBlocks) {
        const s = b?.start ? new Date(b.start) : null;
        const e = b?.end ? new Date(b.end) : null;
        if (s && e && !Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime()) && s < e) {
          const dur = Number(b.duration) > 0 ? Number(b.duration) : Math.round((e.getTime() - s.getTime()) / 60000);
          validBlocks.push({ ...b, startIso: s.toISOString(), endIso: e.toISOString(), dur });
          if (!b.completed) allocated += dur;
        } else {
          logReconcile.run('invalid_legacy_block', 'task', String(t.id), JSON.stringify({ block: b }));
        }
      }

      if (validBlocks.length === 0 && t.scheduled_start && t.scheduled_end) {
        const s = parseAccountDateOrIso(t.scheduled_start, tz);
        const e = parseAccountDateOrIso(t.scheduled_end, tz);
        if (s && e && s < e) {
          const dur = Math.round((e.getTime() - s.getTime()) / 60000);
          validBlocks.push({ startIso: s.toISOString(), endIso: e.toISOString(), dur, partIndex: 1, totalParts: 1 });
          allocated = dur;
        } else {
          logReconcile.run('invalid_legacy_interval', 'task', String(t.id), JSON.stringify({
            scheduled_start: t.scheduled_start,
            scheduled_end: t.scheduled_end,
          }));
        }
      }

      const unallocated = instStatus === 'completed' || instStatus === 'cancelled' ? 0 : Math.max(0, remDur - allocated);
      const planStatus =
        allocated > 0
          ? unallocated > 0
            ? 'partial'
            : 'scheduled'
          : 'pending';

      insertInstance.run(
        t.id,
        t.user_id,
        createdBusinessDate,
        'once',
        instStatus,
        origDur,
        completedMins,
        planStatus,
        allocated,
        unallocated,
        null,
        instStatus === 'completed' ? (t.updated_at || new Date().toISOString()) : null,
        t.created_at || new Date().toISOString(),
        t.updated_at || new Date().toISOString()
      );

      const instRow = db
        .prepare("SELECT id FROM task_instances WHERE task_id = ? AND instance_type = 'once'")
        .get(t.id) as { id: number } | undefined;

      if (instRow && validBlocks.length > 0 && instStatus !== 'cancelled') {
        usersWithPlans.add(t.user_id);
        validBlocks.forEach((b, idx) => {
          const blockId = b.id && typeof b.id === 'string'
            ? b.id
            : `blk-${t.id}-${instRow.id}-${idx + 1}-${crypto.createHash('sha1').update(`${t.id}:${b.startIso}:${b.endIso}:${idx}`).digest('hex').slice(0, 8)}`;
          const bStatus = b.completed || instStatus === 'completed'
            ? 'completed'
            : instStatus === 'in_progress' && idx === 0
            ? 'in_progress'
            : 'planned';

          insertBlock.run(
            blockId,
            t.user_id,
            instRow.id,
            t.id,
            b.startIso,
            b.endIso,
            b.dur,
            b.partIndex || idx + 1,
            b.totalParts || validBlocks.length,
            t.is_fixed ? 1 : 0,
            t.is_fixed ? 1 : 0,
            t.is_concurrent ? 1 : 0,
            bStatus,
            b.energyZone || null,
            b.strategyLabel || null,
            b.breakAfterMinutes || null,
            t.created_at || new Date().toISOString(),
            t.updated_at || new Date().toISOString()
          );
        });
      }
    }

    // Backfill daily task today blocks if present
    if (isDaily && t.scheduled_start && t.scheduled_end && t.status !== 'cancelled') {
      const s = parseAccountDateOrIso(t.scheduled_start, tz);
      const e = parseAccountDateOrIso(t.scheduled_end, tz);
      if (s && e && s < e) {
        const bDate = getAccountLocalDateKey(s, tz);
        const instRow = db
          .prepare('SELECT id, status FROM task_instances WHERE task_id = ? AND business_date = ?')
          .get(t.id, bDate) as { id: number; status: string } | undefined;
        if (instRow) {
          usersWithPlans.add(t.user_id);
          const dur = Math.round((e.getTime() - s.getTime()) / 60000);
          const blockId = `blk-${t.id}-${instRow.id}-1-${crypto.createHash('sha1').update(`${t.id}:${s.toISOString()}`).digest('hex').slice(0, 8)}`;
          insertBlock.run(
            blockId,
            t.user_id,
            instRow.id,
            t.id,
            s.toISOString(),
            e.toISOString(),
            dur,
            1,
            1,
            t.is_fixed ? 1 : 0,
            t.is_fixed ? 1 : 0,
            t.is_concurrent ? 1 : 0,
            instRow.status === 'completed' ? 'completed' : 'planned',
            null,
            null,
            null,
            t.created_at || new Date().toISOString(),
            t.updated_at || new Date().toISOString()
          );
        }
      }
    }
  }

  const insertPlan = db.prepare(`
    INSERT OR IGNORE INTO schedule_plans (user_id, version, trigger_source, status, summary)
    VALUES (?, 1, 'legacy_backfill', 'committed', 'Initial backfilled schedule plan')
  `);
  for (const uid of usersWithPlans) {
    insertPlan.run(uid);
  }
}

/**
 * Reconcile tasks vs instances vs schedule_blocks invariants.
 */
export function reconcileDatabase(db: Database.Database): ReconciliationReport {
  const taskCount = (db.prepare('SELECT count(*) as c FROM tasks').get() as { c: number }).c;
  const instanceCount = (db.prepare('SELECT count(*) as c FROM task_instances').get() as { c: number }).c;
  const blockCount = (db.prepare("SELECT count(*) as c FROM schedule_blocks WHERE status != 'superseded'").get() as { c: number }).c;
  const planCount = (db.prepare('SELECT count(*) as c FROM schedule_plans').get() as { c: number }).c;

  const issues: ReconciliationReport['issues'] = [];

  // 1. Once tasks missing an instance
  const missingOnce = db.prepare(`
    SELECT t.id, t.title FROM tasks t
    WHERE (t.time_mode IS NULL OR t.time_mode != 'daily_fixed')
      AND NOT EXISTS (SELECT 1 FROM task_instances ti WHERE ti.task_id = t.id)
  `).all() as Array<{ id: number; title: string }>;
  for (const row of missingOnce) {
    issues.push({ category: 'missing_once_instance', entityType: 'task', entityId: String(row.id), detail: row.title });
  }

  // 2. Negative remaining minutes
  const negRemaining = db.prepare(`
    SELECT id, task_id, estimated_minutes, completed_minutes FROM task_instances
    WHERE completed_minutes > estimated_minutes OR estimated_minutes < 0 OR completed_minutes < 0
  `).all() as any[];
  for (const row of negRemaining) {
    issues.push({ category: 'invalid_instance_minutes', entityType: 'task_instance', entityId: String(row.id), detail: JSON.stringify(row) });
  }

  // 3. Invalid block intervals
  const invalidBlocks = db.prepare(`
    SELECT id, start_time, end_time FROM schedule_blocks
    WHERE status != 'superseded' AND julianday(end_time) <= julianday(start_time)
  `).all() as any[];
  for (const row of invalidBlocks) {
    issues.push({ category: 'invalid_block_interval', entityType: 'schedule_block', entityId: String(row.id), detail: JSON.stringify(row) });
  }

  return { taskCount, instanceCount, blockCount, planCount, issues };
}
