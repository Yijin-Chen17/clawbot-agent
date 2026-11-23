import crypto from 'crypto';
import { db } from '../config/database.js';
import type {
  ProgressAction,
  ProgressEvent,
  ScheduleBlockRecord,
  Task,
  TaskInstance,
} from '../models/types.js';
import { getUserTimezone } from './accountService.js';
import { addDaysToDateKey, getAccountLocalDateKey } from '../utils/timezone.js';
import { isDateMatchingRecurrence } from '../utils/recurrence.js';
import { cancelNotificationsForBlock, cancelNotificationsForInstance } from './outboxService.js';

function parseJsonArray<T = any>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? (p as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function getLatestPlanVersion(userId: number): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(version), 0) as v FROM schedule_plans WHERE user_id = ?')
    .get(userId) as { v: number } | undefined;
  return Number(row?.v || 0);
}

export function queueReplanRequest(userId: number, reason: string): number {
  const info = db
    .prepare("INSERT INTO replan_requests (user_id, reason, status) VALUES (?, ?, 'pending')")
    .run(userId, reason);
  return Number(info.lastInsertRowid);
}

/**
 * 为指定任务在对应本地日期（或一次性实例）获取或生成唯一 task_instances 记录。
 */
export function ensureTaskInstance(
  userId: number,
  taskId: number,
  businessDate?: string,
  now: Date = new Date()
): TaskInstance | null {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, userId) as Task | undefined;
  if (!task) return null;

  const tz = getUserTimezone(userId);
  const isDaily = task.time_mode === 'daily_fixed';

  if (!isDaily) {
    const existingOnce = db
      .prepare("SELECT * FROM task_instances WHERE task_id = ? AND user_id = ? AND instance_type = 'once'")
      .get(taskId, userId) as TaskInstance | undefined;
    if (existingOnce) return existingOnce;

    const bDate = businessDate || getAccountLocalDateKey(now, tz);
    const est = Math.max(1, Number(task.original_duration_minutes || task.duration_minutes || 60));
    const rem = Math.max(0, Number(task.duration_minutes ?? est));
    const completed = task.status === 'completed' ? est : Math.max(0, est - rem);
    const status =
      task.status === 'completed'
        ? 'completed'
        : task.status === 'cancelled'
        ? 'cancelled'
        : task.status === 'in_progress'
        ? 'in_progress'
        : 'pending';

    db.prepare(`
      INSERT INTO task_instances (
        task_id, user_id, business_date, instance_type, status,
        estimated_minutes, completed_minutes, plan_status, allocated_minutes, unallocated_minutes, version
      ) VALUES (?, ?, ?, 'once', ?, ?, ?, 'pending', 0, ?, 1)
    `).run(taskId, userId, bDate, status, est, completed, Math.max(0, est - completed));

    return db
      .prepare("SELECT * FROM task_instances WHERE task_id = ? AND user_id = ? AND instance_type = 'once'")
      .get(taskId, userId) as TaskInstance;
  }

  const targetDate = businessDate || getAccountLocalDateKey(now, tz);
  const existingDaily = db
    .prepare('SELECT * FROM task_instances WHERE task_id = ? AND user_id = ? AND business_date = ?')
    .get(taskId, userId, targetDate) as TaskInstance | undefined;
  if (existingDaily) return existingDaily;

  // If template was stopped, do not auto-spawn new future daily instances
  if (task.active_template === 0 || task.status === 'cancelled') {
    return null;
  }

  const doneDates = parseJsonArray<string>(task.completed_dates);
  const est = Math.max(1, Number(task.original_duration_minutes || task.duration_minutes || 60));
  const isDoneOnDate = doneDates.includes(targetDate);

  db.prepare(`
    INSERT OR IGNORE INTO task_instances (
      task_id, user_id, business_date, instance_type, status,
      estimated_minutes, completed_minutes, plan_status, allocated_minutes, unallocated_minutes, version
    ) VALUES (?, ?, ?, 'daily', ?, ?, ?, 'pending', 0, ?, 1)
  `).run(
    taskId,
    userId,
    targetDate,
    isDoneOnDate ? 'completed' : 'pending',
    est,
    isDoneOnDate ? est : 0,
    isDoneOnDate ? 0 : est
  );

  return db
    .prepare('SELECT * FROM task_instances WHERE task_id = ? AND user_id = ? AND business_date = ?')
    .get(taskId, userId, targetDate) as TaskInstance | null;
}

/**
 * 为账户生成未来规划窗口内（默认 14 天）所有活跃周期任务的日实例，
 * 并清理规则变更后不再命中但尚未开始的旧未来实例。
 */
export function ensureHorizonDailyInstancesForUser(
  userId: number,
  now: Date = new Date(),
  horizonDays: number = 14
): TaskInstance[] {
  const tz = getUserTimezone(userId);
  const todayKey = getAccountLocalDateKey(now, tz);
  const dailyTemplates = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ?
      AND time_mode = 'daily_fixed'
      AND COALESCE(active_template, 1) = 1
      AND status != 'cancelled'
  `).all(userId) as Task[];

  const result: TaskInstance[] = [];
  const daysCount = Math.max(1, horizonDays);

  for (const t of dailyTemplates) {
    const startBound =
      t.is_fixed === 1 && t.scheduled_start
        ? getAccountLocalDateKey(new Date(t.scheduled_start), tz)
        : todayKey;
    const minDate = startBound > todayKey ? startBound : todayKey;

    for (let offset = 0; offset < daysCount; offset++) {
      const dateKey = offset === 0 ? todayKey : addDaysToDateKey(todayKey, offset);
      if (dateKey < minDate) continue;
      if (!isDateMatchingRecurrence(dateKey, t.recurrence_rule)) continue;
      const inst = ensureTaskInstance(userId, t.id, dateKey, now);
      if (inst) result.push(inst);
    }

    // Cancel future unstarted pending instances that no longer match updated recurrence rules
    const existingPending = db.prepare(`
      SELECT id, business_date FROM task_instances
      WHERE task_id = ? AND user_id = ? AND instance_type = 'daily'
        AND business_date >= ? AND status = 'pending' AND completed_minutes = 0
    `).all(t.id, userId, todayKey) as Array<{ id: number; business_date: string }>;

    for (const ep of existingPending) {
      if (!isDateMatchingRecurrence(ep.business_date, t.recurrence_rule)) {
        db.prepare(`
          UPDATE task_instances
          SET status = 'cancelled', allocated_minutes = 0, unallocated_minutes = 0,
              cancelled_at = CURRENT_TIMESTAMP, version = version + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(ep.id);
        db.prepare(`
          UPDATE schedule_blocks SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
          WHERE instance_id = ? AND status IN ('planned', 'conflict')
        `).run(ep.id);
        cancelNotificationsForInstance(ep.id);
      }
    }
  }
  return result;
}

/**
 * 为账户生成当日所有活跃每日任务的实例（日切或重排前调用）。
 */
export function ensureTodayDailyInstancesForUser(userId: number, now: Date = new Date()): TaskInstance[] {
  return ensureHorizonDailyInstancesForUser(userId, now, 1);
}

/**
 * 将已经过去的未完成每日实例归档取消，防止阻挡今日滚动排程或重复占位。
 */
export function cancelStalePastDailyInstances(userId: number, todayKey: string): void {
  const staleRows = db.prepare(`
    SELECT id FROM task_instances
    WHERE user_id = ?
      AND instance_type = 'daily'
      AND business_date < ?
      AND status IN ('pending', 'in_progress')
  `).all(userId, todayKey) as Array<{ id: number }>;

  if (staleRows.length === 0) return;
  db.transaction(() => {
    for (const r of staleRows) {
      db.prepare(`
        UPDATE task_instances
        SET status = 'cancelled',
            allocated_minutes = 0,
            unallocated_minutes = 0,
            cancelled_at = CURRENT_TIMESTAMP,
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(r.id);
      db.prepare(`
        UPDATE schedule_blocks
        SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE instance_id = ? AND status IN ('planned', 'in_progress', 'conflict')
      `).run(r.id);
      cancelNotificationsForInstance(r.id);
    }
  })();
}

/**
 * 将最新 task_instances 与有效 schedule_blocks 同步回写至 tasks 兼容投影字段，
 * 确保既有前端和旧测试无感知兼容。
 */
export function syncLegacyTaskProjection(userId: number, taskId: number, now: Date = new Date()): void {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, userId) as Task | undefined;
  if (!task) return;

  const tz = getUserTimezone(userId);
  const todayKey = getAccountLocalDateKey(now, tz);
  const isDaily = task.time_mode === 'daily_fixed';

  let instance: TaskInstance | undefined;
  if (isDaily) {
    instance = db
      .prepare('SELECT * FROM task_instances WHERE task_id = ? AND business_date = ?')
      .get(taskId, todayKey) as TaskInstance | undefined;
    if (!instance) {
      instance = db
        .prepare("SELECT * FROM task_instances WHERE task_id = ? AND business_date >= ? AND status != 'cancelled' ORDER BY business_date ASC LIMIT 1")
        .get(taskId, todayKey) as TaskInstance | undefined;
    }
    if (!instance) {
      instance = db
        .prepare('SELECT * FROM task_instances WHERE task_id = ? ORDER BY business_date DESC LIMIT 1')
        .get(taskId) as TaskInstance | undefined;
    }
  } else {
    instance = db
      .prepare("SELECT * FROM task_instances WHERE task_id = ? AND instance_type = 'once'")
      .get(taskId) as TaskInstance | undefined;
  }

  if (!instance) return;

  const activeBlocks = db.prepare(`
    SELECT * FROM schedule_blocks
    WHERE instance_id = ? AND status IN ('planned', 'in_progress', 'completed', 'conflict')
    ORDER BY start_time ASC
  `).all(instance.id) as ScheduleBlockRecord[];

  const uncompletedBlocks = activeBlocks.filter(b => b.status === 'planned' || b.status === 'in_progress' || b.status === 'conflict');
  const firstStart = uncompletedBlocks[0]?.start_time || activeBlocks[0]?.start_time || null;
  const lastEnd =
    uncompletedBlocks[uncompletedBlocks.length - 1]?.end_time ||
    activeBlocks[activeBlocks.length - 1]?.end_time ||
    null;

  const blockPayload = activeBlocks.map(b => ({
    id: b.id,
    start: b.start_time,
    end: b.end_time,
    duration: b.duration_minutes,
    partIndex: b.part_index,
    totalParts: b.total_parts,
    completed: b.status === 'completed',
    status: b.status,
    isCommitted: Boolean(b.is_committed),
    energyZone: b.energy_zone || undefined,
    strategyLabel: b.strategy_label || undefined,
    breakAfterMinutes: b.break_after_minutes || undefined,
  }));

  const remaining = Math.max(0, instance.estimated_minutes - instance.completed_minutes);

  let nextCompletedDates = parseJsonArray<string>(task.completed_dates);
  if (isDaily) {
    const doneRows = db
      .prepare("SELECT business_date FROM task_instances WHERE task_id = ? AND status = 'completed' ORDER BY business_date ASC")
      .all(taskId) as Array<{ business_date: string }>;
    nextCompletedDates = doneRows.map(r => r.business_date);
  }

  let legacyStatus: Task['status'] = 'pending_slot';
  if (isDaily) {
    if (task.status === 'cancelled' || task.active_template === 0) {
      legacyStatus = task.status === 'cancelled' ? 'cancelled' : (uncompletedBlocks.length > 0 ? 'scheduled' : 'pending_slot');
    } else if (instance.status === 'in_progress') {
      legacyStatus = 'in_progress';
    } else if (uncompletedBlocks.length > 0 || (task.is_fixed === 1 && firstStart)) {
      legacyStatus = 'scheduled';
    } else {
      legacyStatus = 'pending_slot';
    }
  } else {
    if (instance.status === 'completed') legacyStatus = 'completed';
    else if (instance.status === 'cancelled') legacyStatus = 'cancelled';
    else if (instance.status === 'in_progress') legacyStatus = 'in_progress';
    else if (uncompletedBlocks.length > 0) legacyStatus = 'scheduled';
    else legacyStatus = 'pending_slot';
  }

  db.prepare(`
    UPDATE tasks
    SET status = ?,
        duration_minutes = ?,
        scheduled_start = ?,
        scheduled_end = ?,
        schedule_blocks = ?,
        completed_dates = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    legacyStatus,
    isDaily ? instance.estimated_minutes : remaining,
    firstStart,
    lastEnd,
    blockPayload.length > 0 ? JSON.stringify(blockPayload) : null,
    JSON.stringify(nextCompletedDates),
    taskId
  );
}

export interface ProgressCommandInput {
  userId: number;
  commandId?: string;
  taskId?: number;
  instanceId?: number;
  businessDate?: string;
  action: ProgressAction | 'stop_daily';
  blockId?: string;
  partIndex?: number;
  completedMinutes?: number;
  targetRemainingMinutes?: number;
  expectedPlanVersion?: number;
  expectedInstanceVersion?: number;
  reason?: string;
}

export interface ProgressCommandResult {
  success: boolean;
  idempotentReplay?: boolean;
  staleVersion?: boolean;
  currentPlanVersion?: number;
  currentInstanceVersion?: number;
  message: string;
  remainingMinutes: number;
  isAllCompleted: boolean;
  needsReplan: boolean;
  task?: Task;
  instance?: TaskInstance;
}

/**
 * 统一执行进度与实例状态转换（T04, T06, T11）：
 * - 在单个 SQLite 事务内校验权限、版本与有效分段
 * - 按 (user_id, command_id) 去重，重复命令直接返回原结果，不重复扣减工时
 * - 无效/过期分段提交直接拒绝，绝不静默扣除 60 分钟
 */
export function executeInstanceProgressCommand(input: ProgressCommandInput): ProgressCommandResult {
  const commandId = input.commandId || `prog-${crypto.randomUUID()}`;
  const now = new Date();

  const txResult = db.transaction((): ProgressCommandResult => {
    // 1. Command deduplication check
    const existingEvent = db
      .prepare('SELECT * FROM progress_events WHERE user_id = ? AND command_id = ?')
      .get(input.userId, commandId) as ProgressEvent | undefined;

    if (existingEvent) {
      const inst = db.prepare('SELECT * FROM task_instances WHERE id = ?').get(existingEvent.instance_id) as TaskInstance;
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(inst.task_id) as Task;
      const rem = Math.max(0, inst.estimated_minutes - inst.completed_minutes);
      return {
        success: true,
        idempotentReplay: true,
        message: existingEvent.reason || '操作已执行（幂等返回原结果）',
        remainingMinutes: rem,
        isAllCompleted: inst.status === 'completed',
        needsReplan: false,
        task,
        instance: inst,
      };
    }

    // 2. Locate target instance
    const tz = getUserTimezone(input.userId);
    const targetDate = input.businessDate || getAccountLocalDateKey(now, tz);

    let instance: TaskInstance | undefined;
    if (input.instanceId) {
      instance = db
        .prepare('SELECT * FROM task_instances WHERE id = ? AND user_id = ?')
        .get(input.instanceId, input.userId) as TaskInstance | undefined;
    } else if (input.taskId) {
      const ensured = ensureTaskInstance(input.userId, input.taskId, targetDate, now);
      if (ensured) instance = ensured;
    }

    if (!instance) {
      return {
        success: false,
        message: '未找到对应的任务实例',
        remainingMinutes: 0,
        isAllCompleted: false,
        needsReplan: false,
      };
    }

    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(instance.task_id, input.userId) as Task | undefined;
    if (!task) {
      return {
        success: false,
        message: '未找到指定任务',
        remainingMinutes: 0,
        isAllCompleted: false,
        needsReplan: false,
      };
    }

    const currentPlanVersion = getLatestPlanVersion(input.userId);
    if (input.expectedInstanceVersion !== undefined && input.expectedInstanceVersion !== instance.version) {
      return {
        success: false,
        staleVersion: true,
        currentPlanVersion,
        currentInstanceVersion: instance.version,
        message: '任务进度已被更新，请刷新后重试',
        remainingMinutes: Math.max(0, instance.estimated_minutes - instance.completed_minutes),
        isAllCompleted: instance.status === 'completed',
        needsReplan: false,
        task,
        instance,
      };
    }

    if (input.expectedPlanVersion !== undefined && input.expectedPlanVersion !== currentPlanVersion) {
      return {
        success: false,
        staleVersion: true,
        currentPlanVersion,
        currentInstanceVersion: instance.version,
        message: '日程计划已更新为新版本，请刷新最新排程后再提交分段',
        remainingMinutes: Math.max(0, instance.estimated_minutes - instance.completed_minutes),
        isAllCompleted: instance.status === 'completed',
        needsReplan: false,
        task,
        instance,
      };
    }

    const activeBlocks = db.prepare(`
      SELECT * FROM schedule_blocks
      WHERE instance_id = ? AND status IN ('planned', 'in_progress')
      ORDER BY start_time ASC
    `).all(instance.id) as ScheduleBlockRecord[];

    const recordEvent = (
      action: ProgressAction,
      deltaMinutes: number,
      blockId: string | null,
      targetRem: number | null,
      reason: string
    ) => {
      db.prepare(`
        INSERT INTO progress_events (
          user_id, command_id, instance_id, block_id, action, delta_minutes, target_remaining_minutes, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.userId, commandId, instance.id, blockId, action, deltaMinutes, targetRem, reason);
    };

    if (input.action === 'stop_daily') {
      if (task.time_mode !== 'daily_fixed') {
        return {
          success: false,
          message: '仅每日重复任务支持停止每日重复',
          remainingMinutes: Math.max(0, instance.estimated_minutes - instance.completed_minutes),
          isAllCompleted: false,
          needsReplan: false,
          task,
          instance,
        };
      }
      db.prepare('UPDATE tasks SET active_template = 0, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(task.id);
      const futureInstances = db
        .prepare("SELECT id FROM task_instances WHERE task_id = ? AND business_date > ? AND status IN ('pending', 'in_progress')")
        .all(task.id, targetDate) as Array<{ id: number }>;
      for (const fi of futureInstances) {
        db.prepare("UPDATE task_instances SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, version = version + 1 WHERE id = ?").run(fi.id);
        db.prepare("UPDATE schedule_blocks SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE instance_id = ? AND status IN ('planned', 'in_progress')").run(fi.id);
        cancelNotificationsForInstance(fi.id);
      }
      syncLegacyTaskProjection(input.userId, task.id, now);
      return {
        success: true,
        message: `已停止「${task.title}」的后续每日重复生成`,
        remainingMinutes: Math.max(0, instance.estimated_minutes - instance.completed_minutes),
        isAllCompleted: instance.status === 'completed',
        needsReplan: true,
        task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Task,
        instance,
      };
    }

    if (input.action === 'start') {
      if (instance.status === 'completed' || instance.status === 'cancelled') {
        return {
          success: false,
          message: '已完成或已取消的任务无法开始',
          remainingMinutes: 0,
          isAllCompleted: instance.status === 'completed',
          needsReplan: false,
          task,
          instance,
        };
      }

      let targetBlock: ScheduleBlockRecord | undefined;
      if (input.blockId) {
        targetBlock = activeBlocks.find(b => b.id === input.blockId);
      } else {
        targetBlock = activeBlocks[0];
      }

      if (targetBlock) {
        db.prepare("UPDATE schedule_blocks SET status = 'in_progress', is_committed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(targetBlock.id);
      }
      db.prepare(`
        UPDATE task_instances
        SET status = 'in_progress',
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(instance.id);

      const msg = `已开始执行「${task.title}」`;
      recordEvent('start', 0, targetBlock?.id || null, null, msg);
      syncLegacyTaskProjection(input.userId, task.id, now);

      const updatedInst = db.prepare('SELECT * FROM task_instances WHERE id = ?').get(instance.id) as TaskInstance;
      return {
        success: true,
        message: msg,
        remainingMinutes: Math.max(0, updatedInst.estimated_minutes - updatedInst.completed_minutes),
        isAllCompleted: false,
        needsReplan: false,
        task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Task,
        instance: updatedInst,
      };
    }

    if (input.action === 'complete') {
      if (instance.status === 'completed') {
        const msg = task.time_mode === 'daily_fixed'
          ? `每日任务「${task.title}」(${instance.business_date}) 已完成`
          : `任务「${task.title}」已完成`;
        return {
          success: true,
          idempotentReplay: true,
          message: msg,
          remainingMinutes: 0,
          isAllCompleted: true,
          needsReplan: false,
          task,
          instance,
        };
      }

      const delta = Math.max(0, instance.estimated_minutes - instance.completed_minutes);
      db.prepare(`
        UPDATE task_instances
        SET status = 'completed',
            completed_minutes = estimated_minutes,
            allocated_minutes = 0,
            unallocated_minutes = 0,
            completed_at = CURRENT_TIMESTAMP,
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(instance.id);

      db.prepare(`
        UPDATE schedule_blocks
        SET status = 'completed', updated_at = CURRENT_TIMESTAMP
        WHERE instance_id = ? AND status IN ('planned', 'in_progress', 'conflict')
      `).run(instance.id);

      cancelNotificationsForInstance(instance.id);

      const msg =
        task.time_mode === 'daily_fixed'
          ? `每日固定任务「${task.title}」(${instance.business_date}) 已打卡完成！`
          : `✅ 任务「${task.title}」已标记完成！`;

      recordEvent('complete', delta, null, 0, msg);
      queueReplanRequest(input.userId, `complete_instance:${instance.id}`);
      syncLegacyTaskProjection(input.userId, task.id, now);

      const updatedInst = db.prepare('SELECT * FROM task_instances WHERE id = ?').get(instance.id) as TaskInstance;
      return {
        success: true,
        message: msg,
        remainingMinutes: 0,
        isAllCompleted: true,
        needsReplan: true,
        task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Task,
        instance: updatedInst,
      };
    }

    if (input.action === 'cancel') {
      if (instance.status === 'cancelled') {
        return {
          success: true,
          idempotentReplay: true,
          message: `任务「${task.title}」已取消`,
          remainingMinutes: 0,
          isAllCompleted: false,
          needsReplan: false,
          task,
          instance,
        };
      }

      db.prepare(`
        UPDATE task_instances
        SET status = 'cancelled',
            allocated_minutes = 0,
            unallocated_minutes = 0,
            cancelled_at = CURRENT_TIMESTAMP,
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(instance.id);

      db.prepare(`
        UPDATE schedule_blocks
        SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE instance_id = ? AND status IN ('planned', 'in_progress', 'conflict')
      `).run(instance.id);

      cancelNotificationsForInstance(instance.id);
      const msg = `已取消任务「${task.title}」(${instance.business_date})`;
      recordEvent('cancel', 0, null, 0, msg);
      queueReplanRequest(input.userId, `cancel_instance:${instance.id}`);
      syncLegacyTaskProjection(input.userId, task.id, now);

      const updatedInst = db.prepare('SELECT * FROM task_instances WHERE id = ?').get(instance.id) as TaskInstance;
      return {
        success: true,
        message: msg,
        remainingMinutes: 0,
        isAllCompleted: false,
        needsReplan: true,
        task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Task,
        instance: updatedInst,
      };
    }

    if (input.action === 'reopen') {
      const currentRem = Math.max(0, instance.estimated_minutes - instance.completed_minutes);
      const fallbackDur = Math.max(
        1,
        Number(task.original_duration_minutes) || Number(instance.estimated_minutes) || 60
      );
      const targetRem =
        input.targetRemainingMinutes && input.targetRemainingMinutes > 0
          ? Math.round(input.targetRemainingMinutes)
          : currentRem > 0
          ? currentRem
          : fallbackDur;

      const nextEstimated = Math.max(instance.estimated_minutes, targetRem);
      const nextCompleted = Math.max(0, nextEstimated - targetRem);

      db.prepare(`
        UPDATE task_instances
        SET status = 'pending',
            estimated_minutes = ?,
            completed_minutes = ?,
            completed_at = NULL,
            cancelled_at = NULL,
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(nextEstimated, nextCompleted, instance.id);

      // Restore valid future fixed blocks if any, otherwise clear old completed blocks so planner schedules fresh
      const hasValidFutureFixed =
        task.is_fixed === 1 &&
        Boolean(task.scheduled_start && task.scheduled_end) &&
        new Date(task.scheduled_end!).getTime() > now.getTime();

      if (hasValidFutureFixed) {
        db.prepare(`
          UPDATE schedule_blocks
          SET status = 'planned', updated_at = CURRENT_TIMESTAMP
          WHERE instance_id = ? AND status IN ('completed', 'cancelled')
        `).run(instance.id);
      } else {
        db.prepare(`
          UPDATE schedule_blocks
          SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
          WHERE instance_id = ? AND status IN ('completed', 'cancelled')
        `).run(instance.id);
      }

      const msg = `任务「${task.title}」(${instance.business_date}) 已恢复待办，剩余 ${targetRem} 分钟`;
      recordEvent('reopen', 0, null, targetRem, msg);
      queueReplanRequest(input.userId, `reopen_instance:${instance.id}`);
      syncLegacyTaskProjection(input.userId, task.id, now);

      const updatedInst = db.prepare('SELECT * FROM task_instances WHERE id = ?').get(instance.id) as TaskInstance;
      return {
        success: true,
        message: msg,
        remainingMinutes: targetRem,
        isAllCompleted: false,
        needsReplan: true,
        task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Task,
        instance: updatedInst,
      };
    }

    // action === 'complete_part'
    if (instance.status === 'completed' || instance.status === 'cancelled') {
      return {
        success: false,
        message: `任务「${task.title}」已结束，无法继续提交分段进度`,
        remainingMinutes: 0,
        isAllCompleted: instance.status === 'completed',
        needsReplan: false,
        task,
        instance,
      };
    }

    if (task.time_mode === 'daily_fixed' && task.is_fixed === 1) {
      // Daily fixed completes today's instance cleanly
      const delta = Math.max(0, instance.estimated_minutes - instance.completed_minutes);
      db.prepare(`
        UPDATE task_instances
        SET status = 'completed',
            completed_minutes = estimated_minutes,
            completed_at = CURRENT_TIMESTAMP,
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(instance.id);
      db.prepare(`
        UPDATE schedule_blocks SET status = 'completed', updated_at = CURRENT_TIMESTAMP
        WHERE instance_id = ? AND status IN ('planned', 'in_progress')
      `).run(instance.id);
      cancelNotificationsForInstance(instance.id);
      const msg = `已完成今天的固定任务「${task.title}」`;
      recordEvent('complete', delta, null, 0, msg);
      syncLegacyTaskProjection(input.userId, task.id, now);
      const updatedInst = db.prepare('SELECT * FROM task_instances WHERE id = ?').get(instance.id) as TaskInstance;
      return {
        success: true,
        message: msg,
        remainingMinutes: 0,
        isAllCompleted: true,
        needsReplan: false,
        task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Task,
        instance: updatedInst,
      };
    }

    const currentRemaining = Math.max(0, instance.estimated_minutes - instance.completed_minutes);
    let targetBlock: ScheduleBlockRecord | undefined;

    if (input.blockId) {
      // Must exist in ALL blocks for this instance to diagnose stale vs nonexistent
      const allInstBlocks = db
        .prepare('SELECT * FROM schedule_blocks WHERE instance_id = ?')
        .all(instance.id) as ScheduleBlockRecord[];
      const exact = allInstBlocks.find(b => b.id === input.blockId);
      if (!exact) {
        return {
          success: false,
          message: `未找到指定的分段 (${input.blockId})，请刷新最新排程后重试`,
          remainingMinutes: currentRemaining,
          isAllCompleted: false,
          needsReplan: false,
          task,
          instance,
        };
      }
      if (exact.status === 'completed' || exact.status === 'superseded' || exact.status === 'cancelled') {
        return {
          success: false,
          staleVersion: exact.status === 'superseded',
          currentPlanVersion,
          message: exact.status === 'completed' ? '该分段已完成，未重复扣减工时' : '该分段所属计划已换版，请刷新后重试',
          remainingMinutes: currentRemaining,
          isAllCompleted: false,
          needsReplan: false,
          task,
          instance,
        };
      }
      targetBlock = exact;
    } else if (input.partIndex !== undefined) {
      if (!Number.isInteger(input.partIndex) || input.partIndex <= 0) {
        return {
          success: false,
          message: '分段序号无效',
          remainingMinutes: currentRemaining,
          isAllCompleted: false,
          needsReplan: false,
          task,
          instance,
        };
      }
      targetBlock = activeBlocks.find(b => b.part_index === input.partIndex);
      if (!targetBlock) {
        return {
          success: false,
          message: `未找到第 ${input.partIndex} 节有效分段，请刷新后重试（未扣减工时）`,
          remainingMinutes: currentRemaining,
          isAllCompleted: false,
          needsReplan: false,
          task,
          instance,
        };
      }
    } else if (input.completedMinutes === undefined || input.completedMinutes <= 0) {
      // No blockId, no partIndex, no explicit minutes -> require at least one active block to claim
      targetBlock = activeBlocks[0];
      if (!targetBlock) {
        return {
          success: false,
          message: '当前没有可认领的排程分段，请指定实际完成分钟数或先执行排程',
          remainingMinutes: currentRemaining,
          isAllCompleted: false,
          needsReplan: false,
          task,
          instance,
        };
      }
    }

    let minutesDeducted = 0;
    if (input.completedMinutes !== undefined && input.completedMinutes !== null) {
      if (!Number.isFinite(input.completedMinutes) || input.completedMinutes <= 0) {
        return {
          success: false,
          message: '完成工时必须为大于 0 的分钟数',
          remainingMinutes: currentRemaining,
          isAllCompleted: false,
          needsReplan: false,
          task,
          instance,
        };
      }
      minutesDeducted = Math.min(currentRemaining, Math.round(input.completedMinutes));
    } else if (targetBlock) {
      minutesDeducted = Math.min(currentRemaining, Math.max(1, targetBlock.duration_minutes));
    }

    if (minutesDeducted <= 0) {
      return {
        success: false,
        message: '当前无可扣减的剩余工时',
        remainingMinutes: currentRemaining,
        isAllCompleted: false,
        needsReplan: false,
        task,
        instance,
      };
    }

    if (targetBlock) {
      db.prepare("UPDATE schedule_blocks SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(targetBlock.id);
      cancelNotificationsForBlock(targetBlock.id);
    }

    const nextCompleted = Math.min(instance.estimated_minutes, instance.completed_minutes + minutesDeducted);
    const nextRemaining = Math.max(0, instance.estimated_minutes - nextCompleted);
    const isAllCompleted = nextRemaining === 0;

    if (isAllCompleted) {
      db.prepare(`
        UPDATE task_instances
        SET status = 'completed',
            completed_minutes = ?,
            allocated_minutes = 0,
            unallocated_minutes = 0,
            completed_at = CURRENT_TIMESTAMP,
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(nextCompleted, instance.id);
      db.prepare(`
        UPDATE schedule_blocks
        SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE instance_id = ? AND status IN ('planned', 'in_progress', 'conflict')
      `).run(instance.id);
      cancelNotificationsForInstance(instance.id);
    } else {
      db.prepare(`
        UPDATE task_instances
        SET status = CASE WHEN status = 'pending' THEN 'in_progress' ELSE status END,
            completed_minutes = ?,
            started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(nextCompleted, instance.id);
    }

    const msg = isAllCompleted
      ? `✅ 任务「${task.title}」已完成`
      : `✅ 已完成「${task.title}」（${minutesDeducted}分钟），剩余 ${nextRemaining}分钟。`;

    recordEvent('complete_part', minutesDeducted, targetBlock?.id || null, nextRemaining, msg);
    queueReplanRequest(input.userId, `complete_part:${instance.id}`);
    syncLegacyTaskProjection(input.userId, task.id, now);

    const updatedInst = db.prepare('SELECT * FROM task_instances WHERE id = ?').get(instance.id) as TaskInstance;
    return {
      success: true,
      message: msg,
      remainingMinutes: nextRemaining,
      isAllCompleted,
      needsReplan: true,
      task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id) as Task,
      instance: updatedInst,
    };
  });

  return txResult();
}
