import crypto from 'crypto';
import { Response } from 'express';
import { db } from '../config/database.js';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { Task, TaskInstance } from '../models/types.js';
import { recurringDebt } from '../services/calendarOptimizer.js';
import { completeTaskPart, replanUserTasks, rescheduleSingleTask } from '../services/scheduler.js';
import {
  createTaskCommand,
  deleteTaskCommand,
  executeQuickActionCommand,
  updateTaskCommand,
} from '../services/taskService.js';
import { createScheduleProposal, resolveScheduleProposal } from '../services/proposalService.js';
import { claimCommandInbox, completeCommandInbox, failCommandInbox } from '../services/inboxService.js';
import { ensureTaskInstance, getLatestPlanVersion } from '../services/instanceService.js';
import { commitBackupImport, exportUserBackup, previewBackupImport } from '../services/backupService.js';
import { parseTagsArray } from '../services/taskCommandSchema.js';
import { getUserTimezone } from '../services/accountService.js';
import { getAccountLocalDateKey } from '../utils/timezone.js';

export function listTasks(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const { status, search } = req.query;
  const tz = getUserTimezone(userId);
  const todayKey = getAccountLocalDateKey(new Date(), tz);

  let query = 'SELECT * FROM tasks WHERE user_id = ?';
  const params: any[] = [userId];

  if (status && typeof status === 'string' && status !== 'all') {
    query += ' AND status = ?';
    params.push(status);
  }

  if (search && typeof search === 'string') {
    query += ' AND title LIKE ?';
    params.push(`%${search}%`);
  }

  query += " ORDER BY CASE status WHEN 'in_progress' THEN 1 WHEN 'scheduled' THEN 2 WHEN 'pending_slot' THEN 3 ELSE 4 END, scheduled_start ASC, created_at DESC";

  const tasks = db.prepare(query).all(...params) as Task[];
  const instances = db
    .prepare('SELECT * FROM task_instances WHERE user_id = ? ORDER BY business_date DESC')
    .all(userId) as TaskInstance[];

  const instByTask = new Map<number, TaskInstance>();
  for (const inst of instances) {
    if (inst.instance_type === 'once') {
      instByTask.set(inst.task_id, inst);
    } else if (inst.business_date === todayKey && !instByTask.has(inst.task_id)) {
      instByTask.set(inst.task_id, inst);
    }
  }

  const today = new Date();
  const planVersion = getLatestPlanVersion(userId);

  res.json({
    planVersion,
    timezone: tz,
    tasks: tasks.map(task => {
      const inst = instByTask.get(task.id);
      const parsedTags = parseTagsArray(task.tags);
      const base = {
        ...task,
        tags: parsedTags,
        instance_id: inst?.id,
        instance_version: inst?.version,
        instance_status: inst?.status,
        plan_status: inst?.plan_status,
        allocated_minutes: inst?.allocated_minutes,
        unallocated_minutes: inst?.unallocated_minutes,
        plan_reason: inst?.plan_reason,
      };
      return task.time_mode === 'daily_fixed'
        ? { ...base, recurring_debt: recurringDebt(task, today) }
        : base;
    }),
  });
}

function getIdempotencyKey(req: AuthenticatedRequest): string | null {
  const h = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  if (req.body?.command_id && typeof req.body.command_id === 'string') return req.body.command_id.trim();
  return null;
}

export async function createTask(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const idemKey = getIdempotencyKey(req);

  let inboxId: number | null = null;
  if (idemKey) {
    const claim = claimCommandInbox({
      userId,
      channel: 'web',
      senderId: String(userId),
      externalMsgId: `web:${idemKey}`,
      idempotencyKey: idemKey,
      payload: req.body || {},
    });
    if (claim.kind === 'conflict') {
      res.status(409).json({ error: claim.message });
      return;
    }
    if (claim.kind === 'duplicate_completed') {
      res.status(claim.response?.statusCode || 201).json(claim.response?.body || claim.response);
      return;
    }
    if (claim.kind === 'duplicate_processing') {
      res.status(409).json({ error: '相同请求正在处理中，请稍候' });
      return;
    }
    inboxId = claim.inboxId;
  }

  try {
    const result = await createTaskCommand({
      userId,
      rawInput: req.body || {},
      allowProposal: false,
    });

    if (!result.success) {
      if (inboxId) failCommandInbox(inboxId, result.message);
      res.status(result.statusCode).json({ error: result.message });
      return;
    }

    const body = {
      message: result.message,
      task: result.task ? { ...result.task, tags: parseTagsArray(result.task.tags) } : result.task,
      instance: result.instance,
      planVersion: result.planVersion,
      proposal: result.proposal || null,
      replan: result.replan,
    };

    if (inboxId) completeCommandInbox(inboxId, { statusCode: result.statusCode, body });
    res.status(result.statusCode).json(body);
  } catch (err: any) {
    if (inboxId) failCommandInbox(inboxId, err.message);
    res.status(500).json({ error: err.message || '创建任务失败' });
  }
}

export async function updateTask(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const taskId = Number(req.params.id);
  const idemKey = getIdempotencyKey(req);

  let inboxId: number | null = null;
  if (idemKey) {
    const claim = claimCommandInbox({
      userId,
      channel: 'web',
      senderId: String(userId),
      externalMsgId: `web:update:${taskId}:${idemKey}`,
      idempotencyKey: idemKey,
      payload: { taskId, body: req.body || {} },
    });
    if (claim.kind === 'conflict') {
      res.status(409).json({ error: claim.message });
      return;
    }
    if (claim.kind === 'duplicate_completed') {
      res.status(claim.response?.statusCode || 200).json(claim.response?.body || claim.response);
      return;
    }
    if (claim.kind === 'duplicate_processing') {
      res.status(409).json({ error: '相同更新请求正在处理中' });
      return;
    }
    inboxId = claim.inboxId;
  }

  try {
    const result = await updateTaskCommand({
      userId,
      taskId,
      rawInput: req.body || {},
    });

    if (!result.success) {
      if (inboxId) failCommandInbox(inboxId, result.message);
      res.status(result.statusCode).json({ error: result.message });
      return;
    }

    const body = {
      message: result.message,
      task: result.task ? { ...result.task, tags: parseTagsArray(result.task.tags) } : result.task,
      instance: result.instance,
      planVersion: result.planVersion,
      replan: result.replan,
    };
    if (inboxId) completeCommandInbox(inboxId, { statusCode: 200, body });
    res.json(body);
  } catch (err: any) {
    if (inboxId) failCommandInbox(inboxId, err.message);
    res.status(500).json({ error: err.message || '更新任务失败' });
  }
}

export function completePartTask(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const taskId = Number(req.params.id);
  const {
    completed_minutes,
    part_index,
    block_id,
    blockId,
    expected_plan_version,
    expected_instance_version,
    business_date,
    command_id,
  } = req.body || {};

  const resolvedCmdId = command_id || getIdempotencyKey(req) || undefined;
  const result = completeTaskPart(userId, taskId, completed_minutes, part_index, {
    blockId: block_id || blockId,
    commandId: resolvedCmdId,
    expectedPlanVersion: expected_plan_version !== undefined ? Number(expected_plan_version) : undefined,
    expectedInstanceVersion: expected_instance_version !== undefined ? Number(expected_instance_version) : undefined,
    businessDate: business_date,
  });

  if (!result.success) {
    res.status(result.staleVersion ? 409 : 400).json({
      error: result.message,
      staleVersion: result.staleVersion,
      currentPlanVersion: result.currentPlanVersion,
    });
    return;
  }

  res.json(result);
}

export function deleteTask(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const taskId = Number(req.params.id);
  const del = deleteTaskCommand(userId, taskId);
  if (!del.success) {
    res.status(404).json({ error: del.message });
    return;
  }
  res.json({ message: del.message, planVersion: del.planVersion });
}

export function deleteAllTasks(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  db.transaction(() => {
    db.prepare(`
      UPDATE notification_outbox
      SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND status IN ('pending', 'failed')
    `).run(userId);
    db.prepare('DELETE FROM tasks WHERE user_id = ?').run(userId);
  })();
  const replan = replanUserTasks(userId, { triggerSource: 'clear_all_tasks' });
  res.json({ success: true, message: '已清空全部待办任务', planVersion: replan.planVersion });
}

export async function rescheduleTask(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const taskId = Number(req.params.id);
  const {
    mode,
    target_date,
    target_time_period,
    target_start,
    target_end,
    business_date,
    instance_id,
    block_id,
    unpin_fixed,
    allow_proposal,
  } = req.body || {};

  try {
    const result = rescheduleSingleTask({
      userId,
      taskId,
      instanceId: instance_id !== undefined ? Number(instance_id) : undefined,
      blockId: typeof block_id === 'string' ? block_id : undefined,
      businessDate: typeof business_date === 'string' ? business_date : undefined,
      mode: mode || undefined,
      targetDate: typeof target_date === 'string' ? target_date : undefined,
      targetTimePeriod: target_time_period || undefined,
      targetStart: typeof target_start === 'string' ? target_start : undefined,
      targetEnd: typeof target_end === 'string' ? target_end : undefined,
      unpinFixed: Boolean(unpin_fixed),
      allowProposal: allow_proposal !== undefined ? Boolean(allow_proposal) : true,
      triggerSource: 'web_single_reschedule',
    });

    if (result.proposal && result.task && result.targetInstanceId) {
      const tz = getUserTimezone(userId);
      const conflictInst = ensureTaskInstance(
        userId,
        result.proposal.conflictTask.id,
        getAccountLocalDateKey(new Date(), tz),
        new Date()
      );
      if (conflictInst) {
        const propRec = createScheduleProposal({
          userId,
          basePlanVersion: getLatestPlanVersion(userId),
          reasonType: result.proposal.type,
          reasonText: result.proposal.reasonText,
          payload: {
            newTaskSpec: {
              title: result.task.title,
              duration_minutes: result.task.duration_minutes,
              urgency: result.task.urgency,
              importance: result.task.importance,
              time_mode: result.task.time_mode ?? undefined,
              deadline: result.task.deadline,
              deadline_kind: result.task.deadline_kind ?? undefined,
              is_concurrent: Boolean(result.task.is_concurrent),
            },
            targetTaskId: result.task.id,
            targetInstanceId: result.targetInstanceId,
            targetInstanceVersion: result.targetInstanceVersion,
            proposal: result.proposal,
            conflictInstanceId: conflictInst.id,
            conflictInstanceVersion: conflictInst.version,
          },
        });
        res.json({
          success: true,
          message: result.message,
          task: { ...result.task, tags: parseTagsArray(result.task.tags) },
          previousSchedule: result.previousSchedule,
          proposal: { ...result.proposal, proposalId: propRec.id },
        });
        return;
      }
    }

    if (!result.success) {
      res.status(result.statusCode || 400).json({
        error: result.message,
        previousSchedule: result.previousSchedule,
      });
      return;
    }

    res.json({
      success: true,
      message: result.message,
      task: result.task ? { ...result.task, tags: parseTagsArray(result.task.tags) } : result.task,
      instance: result.instance,
      planVersion: result.planVersion,
      previousSchedule: result.previousSchedule,
      newSchedule: result.newSchedule,
    });
  } catch (error: any) {
    res.status(400).json({ error: error.message || '单次再排期失败' });
  }
}

/**
 * 仅接受服务端颁发的 proposalId，禁止直接提交客户端构造的完整排程时段（T07）。
 */
export function applyProposal(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const { proposalId, decision } = req.body || {};

  if (!proposalId || typeof proposalId !== 'string') {
    res.status(400).json({ error: '缺少服务端提案编号 proposalId，请刷新后重试' });
    return;
  }

  const resolvedDecision = decision === 'reject' ? 'reject' : 'accept';
  const result = resolveScheduleProposal({
    userId,
    proposalId,
    decision: resolvedDecision,
  });

  if (result.status === 'not_found') {
    res.status(404).json({ error: result.message });
    return;
  }

  if (result.status === 'recomputed') {
    res.status(409).json({
      success: false,
      stale: true,
      message: result.message,
      newProposal: result.newProposal,
    });
    return;
  }

  res.json({
    success: result.success,
    status: result.status,
    message: result.message,
    taskId: result.taskId,
    planVersion: result.planVersion,
  });
}

export function quickActionTask(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const taskId = Number(req.params.id);
  const { action, extend_minutes = 30, business_date, target_remaining_minutes, command_id } = req.body || {};

  const allowed = new Set(['start', 'complete', 'reopen', 'cancel', 'extend', 'stop_daily']);
  if (!allowed.has(action)) {
    res.status(400).json({ error: '未知动作' });
    return;
  }

  const result = executeQuickActionCommand({
    userId,
    taskId,
    action,
    extendMinutes: Number(extend_minutes),
    businessDate: business_date,
    targetRemainingMinutes: target_remaining_minutes !== undefined ? Number(target_remaining_minutes) : undefined,
    commandId: command_id || getIdempotencyKey(req) || undefined,
  });

  if (!result.success) {
    res.status(result.statusCode).json({ error: result.message });
    return;
  }

  res.json({
    message: result.message,
    task: result.task,
    planVersion: result.planVersion,
  });
}

export function exportBackup(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  res.json(exportUserBackup(userId));
}

export function previewBackup(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const mode = req.body?.mode === 'replace' ? 'replace' : 'merge';
  const payload = req.body?.data ?? req.body?.tasks ?? req.body;
  res.json(previewBackupImport(userId, payload, mode));
}

export function importBackup(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const mode = req.body?.mode === 'replace' ? 'replace' : 'merge';
  const payload = req.body?.data ?? req.body?.tasks ?? req.body;
  const idemKey = getIdempotencyKey(req) || crypto.createHash('sha256').update(JSON.stringify({ mode, payload })).digest('hex').slice(0, 24);

  const claim = claimCommandInbox({
    userId,
    channel: 'web',
    senderId: String(userId),
    externalMsgId: `web:backup:${idemKey}`,
    idempotencyKey: `backup:${idemKey}`,
    payload: { mode, payload },
  });

  if (claim.kind === 'conflict') {
    res.status(409).json({ error: claim.message });
    return;
  }
  if (claim.kind === 'duplicate_completed') {
    res.json(claim.response);
    return;
  }
  if (claim.kind === 'duplicate_processing') {
    res.status(409).json({ error: '备份导入正在执行中，请勿重复提交' });
    return;
  }

  try {
    const result = commitBackupImport(userId, payload, mode);
    completeCommandInbox(claim.inboxId, result);
    res.json(result);
  } catch (err: any) {
    failCommandInbox(claim.inboxId, err.message);
    res.status(500).json({ error: err.message || '备份导入失败' });
  }
}
