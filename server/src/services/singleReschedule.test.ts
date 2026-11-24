import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../config/database.js';
import { UserSettings } from '../models/types.js';
import { createMockResponse, seedTestUser, setupIsolatedTestEnv, wallClockIso } from '../testHelpers/testDb.js';
import { applyProposal, createTask, rescheduleTask } from '../controllers/taskController.js';
import { replanUserTasks, rescheduleSingleTask } from './scheduler.js';
import { processNaturalLanguageCommand } from './nlCommandService.js';
import { setLlmExecutorForTest } from './llm.js';
import { renderTodoListImage, renderWeekCalendarImage } from './cardRenderer.js';
import { addDaysToDateKey, getAccountLocalDateKey } from '../utils/timezone.js';

describe('Single-Task Rescheduling, Calendar Scheduled/Unscheduled Status & Agent NL Flow', () => {
  let cleanup: () => void;
  let userId: number;
  let settings: UserSettings;
  let todayKey: string;
  let tomorrowKey: string;
  let dayAfterKey: string;

  beforeEach(() => {
    const env = setupIsolatedTestEnv();
    cleanup = env.cleanup;
    const seeded = seedTestUser({ username: 'resched_u', timezone: 'Asia/Shanghai' });
    userId = seeded.userId;
    settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings;
    todayKey = getAccountLocalDateKey(new Date(), 'Asia/Shanghai');
    tomorrowKey = addDaysToDateKey(todayKey, 1);
    dayAfterKey = addDaysToDateKey(todayKey, 2);
  });

  afterEach(() => {
    cleanup();
  });

  it('reschedules a single task via next_slot without disturbing other scheduled tasks, and supports specific_date/time', async () => {
    const c1 = createMockResponse();
    await createTask(
      {
        user: { id: userId },
        headers: {},
        body: {
          title: '写周报',
          duration_minutes: 60,
          time_mode: 'flexible',
          importance_tier: 'vital',
        },
      } as any,
      c1.res
    );
    assert.equal(c1.getStatus(), 201);
    const taskA = c1.getBody().task;

    const c2 = createMockResponse();
    await createTask(
      {
        user: { id: userId },
        headers: {},
        body: {
          title: '阅读技术文档',
          duration_minutes: 60,
          time_mode: 'flexible',
          importance_tier: 'support',
        },
      } as any,
      c2.res
    );
    assert.equal(c2.getStatus(), 201);
    const taskB = c2.getBody().task;

    const fixedStartBefore = db.prepare('SELECT scheduled_start, scheduled_end FROM tasks WHERE id = ?').get(taskB.id) as any;
    const taskABefore = db.prepare('SELECT scheduled_start, scheduled_end FROM tasks WHERE id = ?').get(taskA.id) as any;
    assert.ok(taskABefore.scheduled_start);
    assert.ok(fixedStartBefore.scheduled_start);

    // 1. next_slot moves taskA to a different slot, leaving taskB untouched
    const resMock = createMockResponse();
    await rescheduleTask(
      {
        user: { id: userId },
        params: { id: String(taskA.id) },
        body: { mode: 'next_slot' },
      } as any,
      resMock.res
    );
    assert.equal(resMock.getStatus(), 200);
    assert.equal(resMock.getBody().success, true);
    assert.notEqual(resMock.getBody().task.scheduled_start, taskABefore.scheduled_start);

    const taskBAfter = db.prepare('SELECT scheduled_start, scheduled_end FROM tasks WHERE id = ?').get(taskB.id) as any;
    assert.equal(taskBAfter.scheduled_start, fixedStartBefore.scheduled_start);
    assert.equal(taskBAfter.scheduled_end, fixedStartBefore.scheduled_end);

    // 2. specific_date + afternoon preference places taskA on dayAfterKey in the afternoon
    const dateMock = createMockResponse();
    await rescheduleTask(
      {
        user: { id: userId },
        params: { id: String(taskA.id) },
        body: {
          mode: 'specific_date',
          target_date: dayAfterKey,
          target_time_period: 'afternoon',
        },
      } as any,
      dateMock.res
    );
    assert.equal(dateMock.getStatus(), 200);
    const placedDate = getAccountLocalDateKey(new Date(dateMock.getBody().task.scheduled_start), 'Asia/Shanghai');
    assert.equal(placedDate, dayAfterKey);

    // 3. specific_time colliding with taskB generates proposal & applyProposal updates existing taskA without duplicating
    const conflictMock = createMockResponse();
    await rescheduleTask(
      {
        user: { id: userId },
        params: { id: String(taskA.id) },
        body: {
          mode: 'specific_time',
          target_start: fixedStartBefore.scheduled_start,
          target_end: fixedStartBefore.scheduled_end,
          allow_proposal: true,
        },
      } as any,
      conflictMock.res
    );
    assert.equal(conflictMock.getStatus(), 200);
    assert.ok(conflictMock.getBody().proposal?.proposalId);

    const applyMock = createMockResponse();
    applyProposal(
      {
        user: { id: userId },
        body: { proposalId: conflictMock.getBody().proposal.proposalId, decision: 'accept' },
      } as any,
      applyMock.res
    );
    assert.equal(applyMock.getStatus(), 200);
    assert.equal(applyMock.getBody().taskId, taskA.id);

    const totalTaskRows = db.prepare('SELECT count(*) as cnt FROM tasks WHERE user_id = ?').get(userId) as { cnt: number };
    assert.equal(totalTaskRows.cnt, 2);

    const taskAFinal = db.prepare('SELECT scheduled_start FROM tasks WHERE id = ?').get(taskA.id) as any;
    assert.equal(new Date(taskAFinal.scheduled_start).toISOString(), new Date(fixedStartBefore.scheduled_start).toISOString());
  });

  it('reschedules only a single day occurrence of a recurring task without altering other days', () => {
    const startIso = wallClockIso(tomorrowKey, 9, 0);
    const endIso = wallClockIso(tomorrowKey, 9, 45);
    const ins = db.prepare(`
      INSERT INTO tasks (
        user_id, title, duration_minutes, original_duration_minutes,
        urgency, importance, importance_tier, time_mode, recurrence_rule,
        is_fixed, is_concurrent, scheduled_start, scheduled_end, status, score_scale, active_template
      ) VALUES (?, '每日英语口语', 45, 45, 60, 75, 'support', 'daily_fixed', '{"type":"daily"}', 1, 0, ?, ?, 'scheduled', 100, 1)
    `).run(userId, startIso, endIso);
    const taskId = Number(ins.lastInsertRowid);

    const morningNow = new Date(wallClockIso(tomorrowKey, 7, 0));
    replanUserTasks(userId, { triggerSource: 'test_daily', now: morningNow });

    const newTargetStart = wallClockIso(tomorrowKey, 15, 0);
    const newTargetEnd = wallClockIso(tomorrowKey, 15, 45);
    const res = rescheduleSingleTask({
      userId,
      taskId,
      businessDate: tomorrowKey,
      mode: 'specific_time',
      targetStart: newTargetStart,
      targetEnd: newTargetEnd,
      now: morningNow,
    });
    assert.equal(res.success, true);

    const tomorrowBlocks = db.prepare(`
      SELECT sb.start_time FROM schedule_blocks sb
      JOIN task_instances ti ON ti.id = sb.instance_id
      WHERE sb.task_id = ? AND ti.business_date = ? AND sb.status = 'planned'
    `).all(taskId, tomorrowKey) as Array<{ start_time: string }>;
    assert.equal(tomorrowBlocks.length, 1);
    assert.equal(new Date(tomorrowBlocks[0].start_time).toISOString(), new Date(newTargetStart).toISOString());

    const dayAfterBlocks = db.prepare(`
      SELECT sb.start_time FROM schedule_blocks sb
      JOIN task_instances ti ON ti.id = sb.instance_id
      WHERE sb.task_id = ? AND ti.business_date = ? AND sb.status = 'planned'
    `).all(taskId, dayAfterKey) as Array<{ start_time: string }>;
    assert.equal(dayAfterBlocks.length, 1);
    assert.equal(
      new Date(dayAfterBlocks[0].start_time).toISOString(),
      new Date(wallClockIso(dayAfterKey, 9, 0)).toISOString()
    );
  });

  it('handles Agent single-task reschedule NL commands without global replan hijack and renders scheduled/unscheduled calendar cards', async () => {
    const c1 = createMockResponse();
    await createTask(
      {
        user: { id: userId },
        headers: {},
        body: { title: '准备周会PPT', duration_minutes: 60, time_mode: 'flexible', importance_tier: 'vital' },
      } as any,
      c1.res
    );
    const taskId = c1.getBody().task.id;

    // Also seed an unscheduled pending_slot task to verify unscheduled counts in Agent replies & cards
    db.prepare(`
      INSERT INTO tasks (user_id, title, duration_minutes, original_duration_minutes, urgency, importance, time_mode, status, score_scale)
      VALUES (?, '未排期备忘项', 30, 30, 30, 30, 'flexible', 'pending_slot', 100)
    `).run(userId);

    setLlmExecutorForTest(async () => ({
      content: JSON.stringify({
        intent: 'status_update',
        status_action: 'reschedule',
        target_task_name: '准备周会PPT',
        reschedule_mode: 'specific_date',
        target_date: dayAfterKey,
        target_time_period: 'afternoon',
      }),
    }));

    // Crucially: "把准备周会PPT重新排程到后天下午" contains "重新排程", must NOT be hijacked by global replan!
    const nlRes = await processNaturalLanguageCommand({
      userId,
      channel: 'webhook',
      senderId: 'u1',
      content: '把准备周会PPT重新排程到后天下午',
      settings,
      skipImages: true,
    });

    assert.ok(nlRes.replyText.includes('单次再排期'), `Unexpected reply: ${nlRes.replyText}`);
    assert.ok(nlRes.replyText.includes('准备周会PPT'));
    assert.equal(nlRes.diagnostics?.action, 'single_reschedule');

    const updated = db.prepare('SELECT scheduled_start FROM tasks WHERE id = ?').get(taskId) as any;
    assert.equal(getAccountLocalDateKey(new Date(updated.scheduled_start), 'Asia/Shanghai'), dayAfterKey);

    // Verify 查看日历 reports 已排期 / 未排期
    const calQueryRes = await processNaturalLanguageCommand({
      userId,
      channel: 'webhook',
      senderId: 'u1',
      content: '查看日历',
      settings,
      skipImages: true,
    });
    assert.ok(calQueryRes.replyText.includes('已排期'));
    assert.ok(calQueryRes.replyText.includes('未排期'));

    // Verify SVG/PNG card renderers succeed cleanly
    const calPng = await renderWeekCalendarImage(userId);
    assert.ok(Buffer.isBuffer(calPng) && calPng.length > 100);
    const todoPng = await renderTodoListImage(userId);
    assert.ok(Buffer.isBuffer(todoPng) && todoPng.length > 100);
  });
});
