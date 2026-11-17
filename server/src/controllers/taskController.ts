import { Response } from 'express';
import { db } from '../config/database.js';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { Task } from '../models/types.js';
import { scheduleTask, replanUserTasks, completeTaskPart } from '../services/scheduler.js';

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

export function createTask(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const {
    title,
    duration_minutes = 60,
    urgency = 3,
    importance = 3,
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
      duration_minutes: Number(duration_minutes),
      urgency: Number(urgency),
      importance: Number(importance),
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
      scheduleMsg = '任务已成功自动排程入日历并锁定！';
    } else {
      scheduleMsg = plan.message || '未找到合适时间槽，待手动调整。';
    }
  }

  const result = db.prepare(`
    INSERT INTO tasks (
      user_id, title, duration_minutes, original_duration_minutes, urgency, importance,
      deadline, scheduled_start, scheduled_end, is_fixed, is_concurrent, status, schedule_blocks, notes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    title,
    Number(duration_minutes),
    Number(duration_minutes),
    Number(urgency),
    Number(importance),
    deadline || null,
    finalStart,
    finalEnd,
    status === 'scheduled' ? 1 : (is_fixed ? 1 : 0),
    is_concurrent ? 1 : 0,
    status,
    scheduleBlocks,
    notes || null
  );

  const newId = result.lastInsertRowid;
  replanUserTasks(userId);
  const newTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(newId);

  res.status(201).json({
    message: scheduleMsg || '任务已创建并已智能排程入日历',
    task: newTask,
    proposal,
  });
}

export function updateTask(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const { id } = req.params;
  const {
    title,
    duration_minutes,
    urgency,
    importance,
    deadline,
    scheduled_start,
    scheduled_end,
    is_fixed,
    is_concurrent,
    status,
    notes,
    auto_schedule,
  } = req.body;

  const existing = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, userId) as Task | undefined;
  if (!existing) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }

  db.prepare(`
    UPDATE tasks
    SET
      title = COALESCE(?, title),
      duration_minutes = COALESCE(?, duration_minutes),
      urgency = COALESCE(?, urgency),
      importance = COALESCE(?, importance),
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
    urgency,
    importance,
    deadline !== undefined ? deadline : existing.deadline,
    scheduled_start !== undefined ? scheduled_start : existing.scheduled_start,
    scheduled_end !== undefined ? scheduled_end : existing.scheduled_end,
    is_fixed !== undefined ? (is_fixed ? 1 : 0) : existing.is_fixed,
    is_concurrent !== undefined ? (is_concurrent ? 1 : 0) : existing.is_concurrent,
    status,
    notes !== undefined ? notes : existing.notes,
    id,
    userId
  );

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

export function rescheduleTask(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const { id } = req.params;

  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(id, userId) as Task | undefined;
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }

  // 解除该任务的原有时间占用，以便为它寻找新时隙
  db.prepare(`
    UPDATE tasks
    SET scheduled_start = NULL, scheduled_end = NULL, schedule_blocks = NULL, is_fixed = 0, status = 'pending_slot'
    WHERE id = ?
  `).run(id);

  const plan = scheduleTask(userId, {
    id: task.id,
    title: task.title,
    duration_minutes: task.duration_minutes,
    urgency: task.urgency,
    importance: task.importance,
    deadline: task.deadline,
  });

  if (plan.success && plan.scheduled_start && plan.scheduled_end) {
    db.prepare(`
      UPDATE tasks
      SET scheduled_start = ?,
          scheduled_end = ?,
          schedule_blocks = ?,
          is_fixed = 1,
          status = 'scheduled',
          updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(plan.scheduled_start, plan.scheduled_end, plan.schedule_blocks || null, id);
  }

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
        deadline, scheduled_start, scheduled_end, is_fixed, is_concurrent, status, schedule_blocks,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'scheduled', ?, datetime('now', 'localtime'), datetime('now', 'localtime'))
    `).run(
      userId,
      newTask.title,
      Number(newTask.duration_minutes || 60),
      Number(newTask.duration_minutes || 60),
      Number(newTask.urgency || 3),
      Number(newTask.importance || 3),
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
    db.prepare(`
      UPDATE tasks
      SET status = 'completed', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
    res.json({ message: `任务「${task.title}」已标记完成！` });
    return;
  }

  if (action === 'reopen') {
    db.prepare(`
      UPDATE tasks
      SET status = 'scheduled', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
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
