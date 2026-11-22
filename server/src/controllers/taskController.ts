import { Response } from 'express';
import { planTaskWithLLM } from '../services/llm.js';
import { db } from '../config/database.js';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { Task } from '../models/types.js';
import {
  scheduleTask,
  replanUserTasks,
  completeTaskPart,
  computeTodayBusyMinutes,
  formatLocalDate,
} from '../services/scheduler.js';
import {
  calculateDynamicImportance,
  calculateDynamicUrgency,
  inferTierFromScore,
  normalizeScoreTo100,
  type ImpactSignal,
  type ImportanceTier,
  type TimeMode,
  type UrgencyPace,
} from '../utils/priorityAlgorithm.js';

function parseJsonArray<T = string>(raw: unknown): T[] {
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

export function listTasks(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const { status, search } = req.query;

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
  res.json({ tasks });
}

export async function createTask(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const {
    title,
    duration_minutes: inputDuration,
    urgency,
    importance,
    importance_tier,
    impact_signals,
    time_mode,
    urgency_pace,
    importance_manual_override,
    score_scale,
    deadline,
    scheduled_start,
    scheduled_end,
    is_fixed = 0,
    is_concurrent = 0,
    auto_schedule = true,
    notes,
  } = req.body;

  if (!title) {
    res.status(400).json({ error: '请输入任务标题' });
    return;
  }

  if (inputDuration !== undefined && inputDuration !== null && inputDuration !== '' &&
      (!Number.isInteger(Number(inputDuration)) || Number(inputDuration) <= 0 || Number(inputDuration) > 100000)) {
    res.status(400).json({ error: '预计耗时必须为有效的正整数分钟数' });
    return;
  }
  let duration_minutes = Number(inputDuration);
  let sessions: number[] = [];
  try {
    const plan = await planTaskWithLLM(userId, title, duration_minutes > 0 ? duration_minutes : undefined, notes);
    duration_minutes = plan.minutes;
    sessions = plan.sessions;
  } catch {
    if (!(duration_minutes > 0)) {
      res.status(400).json({ error: '无法预估任务耗时，请检查 LLM 配置或填写预计耗时' });
      return;
    }
    // 显式耗时在 LLM 不可用时仍可创建，保持任务整体性。
    sessions = [duration_minutes];
  }
  const sessionPlan = JSON.stringify(sessions);
  const parsedSignals = parseJsonArray<ImpactSignal>(impact_signals);
  const manualOverrideNum =
    importance_manual_override !== undefined &&
    importance_manual_override !== null &&
    importance_manual_override !== ''
      ? normalizeScoreTo100(Number(importance_manual_override), score_scale ?? 100)
      : null;

  let resolvedTier: ImportanceTier;
  let resolvedImportance: number;
  if (importance_tier === 'vital' || importance_tier === 'support' || importance_tier === 'minor') {
    resolvedTier = importance_tier;
    resolvedImportance = calculateDynamicImportance({
      tier: resolvedTier,
      estimatedMinutes: Number(duration_minutes),
      impactSignals: parsedSignals,
      isFixed: Boolean(is_fixed),
      manualOverride: manualOverrideNum,
    }).importance;
  } else {
    resolvedImportance =
      importance !== undefined && importance !== null
        ? normalizeScoreTo100(Number(importance), score_scale)
        : 58;
    resolvedTier = inferTierFromScore(resolvedImportance);
  }

  const resolvedTimeMode: TimeMode =
    time_mode === 'daily_fixed' || time_mode === 'flexible' || time_mode === 'deadline'
      ? time_mode
      : deadline
      ? 'deadline'
      : 'flexible';
  const resolvedPace: UrgencyPace =
    urgency_pace === 'urgent' || urgency_pace === 'later' || urgency_pace === 'soon'
      ? urgency_pace
      : 'soon';

  const fallbackUrg100 =
    urgency !== undefined && urgency !== null
      ? normalizeScoreTo100(Number(urgency), score_scale)
      : 50;

  const todayBusyMinutes = computeTodayBusyMinutes(userId);
  const resolvedUrgency = calculateDynamicUrgency({
    timeMode: resolvedTimeMode,
    dueDate: deadline || null,
    estimatedMinutes: Number(duration_minutes),
    importance: resolvedImportance,
    urgencyPace: resolvedPace,
    scheduledStart: scheduled_start || null,
    scheduledEnd: scheduled_end || null,
    dailyBusyMinutesAhead: todayBusyMinutes,
    fallbackUrgency: fallbackUrg100,
  }).urgency;

  let finalStart: string | null = scheduled_start || null;
  let finalEnd: string | null = scheduled_end || null;
  let status = 'pending_slot';
  let scheduleMsg = '';
  let scheduleBlocks: string | null = null;
  let proposal: any = null;

  if (is_fixed && finalStart && finalEnd) {
    status = 'scheduled';
    scheduleMsg = '固定任务已创建并锁定时间段！';
    scheduleBlocks = JSON.stringify([{ start: finalStart, end: finalEnd, duration: Number(duration_minutes) }]);
  } else if (auto_schedule) {
    const plan = scheduleTask(userId, {
      title,
      session_plan: sessionPlan,
      duration_minutes: Number(duration_minutes),
      urgency: resolvedUrgency,
      importance: resolvedImportance,
      deadline: deadline || null,
    });

    if (plan.proposal) {
      proposal = plan.proposal;
    }

    if (plan.success && plan.scheduled_start && plan.scheduled_end) {
      finalStart = plan.scheduled_start;
      finalEnd = plan.scheduled_end;
      scheduleBlocks = plan.schedule_blocks || null;
      status = 'scheduled';
      scheduleMsg = is_fixed ? '任务已成功排程入日历并锁定！' : '任务已成功智能排程入日历！';
    } else {
      scheduleMsg = plan.message || '未找到合适时间槽，待手动调整。';
    }
  }

  const result = db.prepare(`
    INSERT INTO tasks (
      user_id, title, duration_minutes, original_duration_minutes, urgency, importance,
      importance_tier, impact_signals, time_mode, urgency_pace, importance_manual_override,
      score_scale, completed_dates,
      deadline, scheduled_start, scheduled_end, is_fixed, is_concurrent, status, schedule_blocks, notes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 100, '[]', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    title,
    Number(duration_minutes),
    Number(duration_minutes),
    resolvedUrgency,
    resolvedImportance,
    resolvedTier,
    JSON.stringify(parsedSignals),
    resolvedTimeMode,
    resolvedPace,
    manualOverrideNum,
    deadline || null,
    finalStart,
    finalEnd,
    is_fixed ? 1 : 0,
    is_concurrent ? 1 : 0,
    status,
    scheduleBlocks,
    notes || null
  );

  const newId = result.lastInsertRowid;
  db.prepare('UPDATE tasks SET session_plan = ? WHERE id = ?').run(sessionPlan, newId);
  replanUserTasks(userId);
  const newTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(newId);

  res.status(201).json({
    message: scheduleMsg || '任务已创建并已智能排程入日历',
    task: newTask,
    proposal,
  });
}

export async function updateTask(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { id } = req.params;
  const {
    title,
    duration_minutes,
    urgency,
    importance,
    importance_tier,
    impact_signals,
    time_mode,
    urgency_pace,
    importance_manual_override,
    score_scale,
    deadline,
    scheduled_start,
    scheduled_end,
    is_fixed,
    is_concurrent,
    status,
    notes,
  } = req.body;

  const existing = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, userId) as Task | undefined;
  if (!existing) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }

  const nextDuration = duration_minutes !== undefined ? Number(duration_minutes) : existing.duration_minutes;
  const nextIsFixed = is_fixed !== undefined ? (is_fixed ? 1 : 0) : (existing.is_fixed ?? 0);
  const nextSignals =
    impact_signals !== undefined
      ? parseJsonArray<ImpactSignal>(impact_signals)
      : parseJsonArray<ImpactSignal>(existing.impact_signals);

  const nextManualOverride =
    importance_manual_override !== undefined
      ? (importance_manual_override !== null && importance_manual_override !== ''
          ? normalizeScoreTo100(Number(importance_manual_override), score_scale ?? 100)
          : null)
      : existing.importance_manual_override ?? null;

  const nextTierRaw = importance_tier !== undefined ? importance_tier : existing.importance_tier;
  let nextImportance: number;
  let resolvedTier: ImportanceTier;

  if (nextTierRaw === 'vital' || nextTierRaw === 'support' || nextTierRaw === 'minor') {
    resolvedTier = nextTierRaw;
    if (
      importance_tier !== undefined ||
      impact_signals !== undefined ||
      importance_manual_override !== undefined ||
      duration_minutes !== undefined ||
      is_fixed !== undefined
    ) {
      nextImportance = calculateDynamicImportance({
        tier: resolvedTier,
        estimatedMinutes: nextDuration,
        impactSignals: nextSignals,
        isFixed: Boolean(nextIsFixed),
        manualOverride: nextManualOverride,
      }).importance;
    } else if (importance !== undefined) {
      nextImportance = normalizeScoreTo100(Number(importance), score_scale);
    } else {
      nextImportance = normalizeScoreTo100(existing.importance, existing.score_scale);
    }
  } else {
    nextImportance =
      importance !== undefined
        ? normalizeScoreTo100(Number(importance), score_scale)
        : normalizeScoreTo100(existing.importance, existing.score_scale);
    resolvedTier = inferTierFromScore(nextImportance);
  }

  const nextDeadline = deadline !== undefined ? deadline : existing.deadline;
  const nextScheduledStart = scheduled_start !== undefined ? scheduled_start : existing.scheduled_start;
  const nextScheduledEnd = scheduled_end !== undefined ? scheduled_end : existing.scheduled_end;

  const nextTimeMode: TimeMode =
    time_mode === 'daily_fixed' || time_mode === 'flexible' || time_mode === 'deadline'
      ? time_mode
      : existing.time_mode === 'daily_fixed' || existing.time_mode === 'flexible' || existing.time_mode === 'deadline'
      ? existing.time_mode
      : nextDeadline
      ? 'deadline'
      : 'flexible';

  const nextPace: UrgencyPace =
    urgency_pace === 'urgent' || urgency_pace === 'later' || urgency_pace === 'soon'
      ? urgency_pace
      : existing.urgency_pace === 'urgent' || existing.urgency_pace === 'later' || existing.urgency_pace === 'soon'
      ? existing.urgency_pace
      : 'soon';

  const completedDates = parseJsonArray<string>(existing.completed_dates);
  const todayStr = formatLocalDate(new Date());
  const isCompletedToday = completedDates.includes(todayStr);

  const fallbackUrg100 =
    urgency !== undefined
      ? normalizeScoreTo100(Number(urgency), score_scale)
      : normalizeScoreTo100(existing.urgency, existing.score_scale);

  const nextUrgency = calculateDynamicUrgency({
    timeMode: nextTimeMode,
    dueDate: nextDeadline || null,
    estimatedMinutes: nextDuration,
    importance: nextImportance,
    urgencyPace: nextPace,
    scheduledStart: nextScheduledStart || null,
    scheduledEnd: nextScheduledEnd || null,
    isCompletedToday,
    dailyBusyMinutesAhead: computeTodayBusyMinutes(userId, new Date(), existing.id),
    fallbackUrgency: fallbackUrg100,
  }).urgency;

  db.prepare(`
    UPDATE tasks
    SET
      title = COALESCE(?, title),
      duration_minutes = COALESCE(?, duration_minutes),
      urgency = ?,
      importance = ?,
      importance_tier = ?,
      impact_signals = ?,
      time_mode = ?,
      urgency_pace = ?,
      importance_manual_override = ?,
      score_scale = 100,
      deadline = ?,
      scheduled_start = ?,
      scheduled_end = ?,
      is_fixed = COALESCE(?, is_fixed),
      is_concurrent = COALESCE(?, is_concurrent),
      status = COALESCE(?, status),
      notes = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(
    title,
    duration_minutes,
    nextUrgency,
    nextImportance,
    resolvedTier,
    JSON.stringify(nextSignals),
    nextTimeMode,
    nextPace,
    nextManualOverride,
    nextDeadline,
    nextScheduledStart,
    nextScheduledEnd,
    nextIsFixed,
    is_concurrent !== undefined ? (is_concurrent ? 1 : 0) : existing.is_concurrent,
    status,
    notes !== undefined ? notes : existing.notes,
    id,
    userId
  );

  if (nextDuration !== existing.duration_minutes || (title && title !== existing.title)) {
    let sessions = [nextDuration];
    try {
      sessions = (await planTaskWithLLM(userId, title || existing.title, nextDuration, notes || existing.notes || undefined)).sessions;
    } catch {}
    db.prepare('UPDATE tasks SET session_plan = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(sessions), id, userId);
  }
  replanUserTasks(userId);

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  res.json({ message: '任务更新成功并已排程入日历', task: updated });
}

export function completePartTask(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const { id } = req.params;
  const { completed_minutes, part_index } = req.body;

  const result = completeTaskPart(userId, Number(id), completed_minutes, part_index);
  if (!result.success) {
    res.status(400).json({ error: result.message });
    return;
  }
  res.json(result);
}

export function deleteTask(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const { id } = req.params;

  db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(id, userId);
  replanUserTasks(userId);
  res.json({ message: '任务已删除并自适应更新日历排程' });
}

export async function rescheduleTask(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { id } = req.params;

  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, userId) as Task | undefined;
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }

  let sessionPlan = task.session_plan;
  if (!sessionPlan) {
    try {
      sessionPlan = JSON.stringify((await planTaskWithLLM(userId, task.title, task.duration_minutes, task.notes || undefined)).sessions);
    } catch {
      sessionPlan = JSON.stringify([task.duration_minutes]);
    }
  }
  const plan = scheduleTask(userId, {
    id: task.id,
    title: task.title,
    duration_minutes: task.duration_minutes,
    session_plan: sessionPlan,
    urgency: task.urgency,
    importance: task.importance,
    deadline: task.deadline,
  });

  if (!plan.success || !plan.scheduled_start || !plan.scheduled_end) {
    res.status(400).json({ error: plan.message, proposal: plan.proposal });
    return;
  }

  if (plan.success && plan.scheduled_start && plan.scheduled_end) {
    db.prepare(`
      UPDATE tasks
      SET scheduled_start = ?,
          scheduled_end = ?,
          schedule_blocks = ?,
          is_fixed = ?,
          status = 'scheduled',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(plan.scheduled_start, plan.scheduled_end, plan.schedule_blocks || null, task.is_fixed ? 1 : 0, id);
  }

  db.prepare('UPDATE tasks SET session_plan = ? WHERE id = ?').run(sessionPlan, id);
  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task;

  res.json({
    message: updated.scheduled_start ? '任务已完成自适应重新排程并同步锁定至日历' : '排程失败，暂无合适空闲时段',
    task: updated,
    proposal: plan.proposal,
  });
}

export function applyProposal(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const { proposal, newTask } = req.body;
  if (!proposal || !proposal.conflictTask || !proposal.newTaskSchedule || !proposal.conflictTaskSchedule) {
    res.status(400).json({ error: '调整建议数据不完整' });
    return;
  }

  // 1. 同步调整 conflictTask
  db.prepare(`
    UPDATE tasks
    SET scheduled_start = ?,
        scheduled_end = ?,
        schedule_blocks = ?,
        is_fixed = 1,
        status = 'scheduled',
        updated_at = datetime('now', 'localtime')
    WHERE id = ? AND user_id = ?
  `).run(
    proposal.conflictTaskSchedule.start,
    proposal.conflictTaskSchedule.end,
    proposal.conflictTaskSchedule.blocks ? JSON.stringify(proposal.conflictTaskSchedule.blocks) : null,
    proposal.conflictTask.id,
    userId
  );

  // 2. 插入或更新 newTask
  let taskId = newTask?.id;
  if (taskId) {
    db.prepare(`
      UPDATE tasks
      SET scheduled_start = ?,
          scheduled_end = ?,
          schedule_blocks = ?,
          is_fixed = 1,
          status = 'scheduled',
          updated_at = datetime('now', 'localtime')
      WHERE id = ? AND user_id = ?
    `).run(
      proposal.newTaskSchedule.start,
      proposal.newTaskSchedule.end,
      proposal.newTaskSchedule.blocks ? JSON.stringify(proposal.newTaskSchedule.blocks) : null,
      taskId,
      userId
    );
  } else if (newTask) {
    const resInsert = db.prepare(`
      INSERT INTO tasks (
        user_id, title, duration_minutes, original_duration_minutes, urgency, importance,
        score_scale, deadline, scheduled_start, scheduled_end, is_fixed, is_concurrent, status, schedule_blocks,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 100, ?, ?, ?, 1, ?, 'scheduled', ?, datetime('now', 'localtime'), datetime('now', 'localtime'))
    `).run(
      userId,
      newTask.title,
      Number(newTask.duration_minutes || 60),
      Number(newTask.duration_minutes || 60),
      normalizeScoreTo100(Number(newTask.urgency ?? 50), newTask.score_scale ?? 100),
      normalizeScoreTo100(Number(newTask.importance ?? 50), newTask.score_scale ?? 100),
      newTask.deadline || null,
      proposal.newTaskSchedule.start,
      proposal.newTaskSchedule.end,
      newTask.is_concurrent ? 1 : 0,
      proposal.newTaskSchedule.blocks ? JSON.stringify(proposal.newTaskSchedule.blocks) : null
    );
    taskId = resInsert.lastInsertRowid;
  }

  res.json({
    success: true,
    message: `已同步调整「${proposal.conflictTask.title}」并锁定新日程`,
    taskId,
  });
}

export function quickActionTask(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const { id } = req.params;
  const { action, extend_minutes = 30 } = req.body;

  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, userId) as Task | undefined;
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }

  if (action === 'complete') {
    const todayStr = formatLocalDate(new Date());
    const completedDates = parseJsonArray<string>(task.completed_dates);
    if (!completedDates.includes(todayStr)) {
      completedDates.push(todayStr);
    }

    if (task.time_mode === 'daily_fixed') {
      db.prepare(`
        UPDATE tasks
        SET completed_dates = ?, urgency = 15, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(JSON.stringify(completedDates), id);
      res.json({ message: `每日固定任务「${task.title}」今日已打卡完成，明日自动恢复！` });
      return;
    }

    db.prepare(`
      UPDATE tasks
      SET status = 'completed', completed_dates = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(completedDates), id);
    res.json({ message: `任务「${task.title}」已标记完成！` });
    return;
  }

  if (action === 'reopen') {
    const todayStr = formatLocalDate(new Date());
    const completedDates = parseJsonArray<string>(task.completed_dates).filter((d) => d !== todayStr);

    if (task.time_mode === 'daily_fixed') {
      const imp100 = normalizeScoreTo100(task.importance, task.score_scale);
      const nextUrgency = calculateDynamicUrgency({
        timeMode: 'daily_fixed',
        dueDate: task.deadline || null,
        estimatedMinutes: task.duration_minutes,
        importance: imp100,
        scheduledStart: task.scheduled_start,
        scheduledEnd: task.scheduled_end,
        isCompletedToday: false,
        dailyBusyMinutesAhead: computeTodayBusyMinutes(userId, new Date(), task.id),
      }).urgency;
      db.prepare(`
        UPDATE tasks
        SET completed_dates = ?, urgency = ?, status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(JSON.stringify(completedDates), nextUrgency, task.scheduled_start ? 'scheduled' : 'pending_slot', id);
      res.json({ message: `任务「${task.title}」已恢复今日待办！` });
      return;
    }

    db.prepare(`
      UPDATE tasks
      SET status = 'scheduled', completed_dates = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(completedDates), id);
    res.json({ message: `任务「${task.title}」已重新标为进行中！` });
    return;
  }

  if (action === 'extend') {
    if (!task.scheduled_end) {
      res.status(400).json({ error: '该任务未安排时间，无法延长' });
      return;
    }
    const currentEnd = new Date(task.scheduled_end);
    const newEnd = new Date(currentEnd.getTime() + Number(extend_minutes) * 60 * 1000);
    const newDuration = task.duration_minutes + Number(extend_minutes);

    db.prepare(`
      UPDATE tasks
      SET
        scheduled_end = ?,
        duration_minutes = ?,
        end_reminder_sent = 0,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newEnd.toISOString(), newDuration, id);

    res.json({ message: `任务「${task.title}」已延长 ${extend_minutes} 分钟` });
    return;
  }

  res.status(400).json({ error: '未知动作' });
}
