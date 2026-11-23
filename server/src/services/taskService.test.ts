import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../config/database.js';
import { setupIsolatedTestEnv, seedTestUser, createMockResponse, wallClockIso } from '../testHelpers/testDb.js';
import {
  createTaskCommand,
  executeQuickActionCommand,
  resolveCommandTarget,
} from './taskService.js';
import { completeTaskPart } from './scheduler.js';
import { ensureTaskInstance } from './instanceService.js';
import { setLlmExecutorForTest } from './llm.js';
import { checkAccountEligibility, incrementSessionVersion } from './accountService.js';
import { updateSettings } from '../controllers/settingsController.js';
import { addDaysToDateKey, getAccountLocalDateKey } from '../utils/timezone.js';

describe('Batch 1: Unified Task Write, Validation, Disambiguation, Daily Isolation & Settings Patch', () => {
  let cleanup: () => void;
  let userId: number;
  let tomorrowKey: string;

  beforeEach(() => {
    const env = setupIsolatedTestEnv();
    cleanup = env.cleanup;
    userId = seedTestUser({ timezone: 'Asia/Shanghai' }).userId;
    tomorrowKey = getAccountLocalDateKey(new Date(Date.now() + 86_400_000), 'Asia/Shanghai');
  });

  afterEach(() => {
    cleanup();
  });

  it('allows creating a flexible task without deadline and works when explicit duration bypasses LLM failures', async () => {
    setLlmExecutorForTest(async () => {
      throw new Error('LLM unavailable');
    });

    const result = await createTaskCommand({
      userId,
      rawInput: {
        title: '整理设计文档',
        duration_minutes: 45,
        time_mode: 'flexible',
        importance_tier: 'support',
        tags: ['工作', '文档', '工作'],
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.statusCode, 201);
    assert.ok(result.task);
    assert.equal(result.task.deadline, null);
    assert.equal(result.task.deadline_kind, 'soft');
    assert.equal(result.task.duration_minutes, 45);
    assert.deepEqual(JSON.parse(result.task.tags || '[]'), ['工作', '文档']);

    const inst = db
      .prepare("SELECT * FROM task_instances WHERE task_id = ? AND instance_type = 'once'")
      .get(result.task.id) as any;
    assert.ok(inst);
    assert.equal(inst.estimated_minutes, 45);
  });

  it('rejects negative/inverted fixed intervals, fixed overlaps, and hard-deadline violations without mutating DB', async () => {
    const startA = wallClockIso(tomorrowKey, 10, 0);
    const endA = wallClockIso(tomorrowKey, 11, 0);

    // Inverted interval
    const inverted = await createTaskCommand({
      userId,
      rawInput: {
        title: '错误固定任务',
        is_fixed: true,
        scheduled_start: endA,
        scheduled_end: startA,
      },
    });
    assert.equal(inverted.success, false);
    assert.equal(inverted.statusCode, 400);

    // Valid fixed task
    const valid = await createTaskCommand({
      userId,
      rawInput: {
        title: '团队周会',
        is_fixed: true,
        scheduled_start: startA,
        scheduled_end: endA,
        duration_minutes: 60,
      },
    });
    assert.equal(valid.success, true);

    // Overlapping non-concurrent fixed task
    const startOverlap = wallClockIso(tomorrowKey, 10, 30);
    const endOverlap = wallClockIso(tomorrowKey, 11, 30);
    const overlap = await createTaskCommand({
      userId,
      rawInput: {
        title: '冲突会议',
        is_fixed: true,
        scheduled_start: startOverlap,
        scheduled_end: endOverlap,
        duration_minutes: 60,
      },
    });
    assert.equal(overlap.success, false);
    assert.equal(overlap.statusCode, 409);

    // Fixed slot ending after hard deadline
    const lateStart = wallClockIso(tomorrowKey, 15, 0);
    const lateEnd = wallClockIso(tomorrowKey, 16, 0);
    const earlyDeadline = wallClockIso(tomorrowKey, 14, 0);
    const violation = await createTaskCommand({
      userId,
      rawInput: {
        title: '超期固定任务',
        is_fixed: true,
        scheduled_start: lateStart,
        scheduled_end: lateEnd,
        duration_minutes: 60,
        deadline: earlyDeadline,
        deadline_kind: 'hard',
      },
    });
    assert.equal(violation.success, false);
    assert.equal(violation.statusCode, 400);

    const count = (db.prepare('SELECT COUNT(*) as c FROM tasks WHERE user_id = ?').get(userId) as any).c;
    assert.equal(count, 1);
  });

  it('disambiguates multiple overlapping task candidates instead of falling back to one (M01)', async () => {
    await createTaskCommand({
      userId,
      rawInput: { title: '季度周报初稿', duration_minutes: 60, time_mode: 'flexible' },
    });
    await createTaskCommand({
      userId,
      rawInput: { title: '季度周报终版', duration_minutes: 60, time_mode: 'flexible' },
    });

    const ambig = resolveCommandTarget({ userId, name: '周报', type: 'task' });
    assert.equal(ambig.status, 'ambiguous');
    if (ambig.status === 'ambiguous') {
      assert.equal(ambig.candidates.length, 2);
    }

    const notFound = resolveCommandTarget({ userId, name: '不存在的任务', type: 'task' });
    assert.equal(notFound.status, 'not_found');

    const exact = resolveCommandTarget({ userId, name: '季度周报终版', type: 'task' });
    assert.equal(exact.status, 'found_task');
    if (exact.status === 'found_task') {
      assert.equal(exact.task.title, '季度周报终版');
    }
  });

  it('rejects invalid/nonexistent part completions and ensures commandId idempotency (T04)', async () => {
    const created = await createTaskCommand({
      userId,
      rawInput: { title: '分段编码任务', duration_minutes: 120, time_mode: 'flexible' },
    });
    assert.equal(created.success, true);
    const taskId = created.task!.id;

    // Nonexistent partIndex 99 should fail without deducting 60 minutes
    const badPart = completeTaskPart(userId, taskId, undefined, 99);
    assert.equal(badPart.success, false);
    const afterBad = db.prepare('SELECT duration_minutes FROM tasks WHERE id = ?').get(taskId) as any;
    assert.equal(afterBad.duration_minutes, 120);

    // Nonexistent blockId should fail
    const badBlock = completeTaskPart(userId, taskId, 30, undefined, { blockId: 'nonexistent-blk' });
    assert.equal(badBlock.success, false);

    // Duplicate commandId only deducts once
    const first = completeTaskPart(userId, taskId, 45, undefined, { commandId: 'cmd-dedup-1' });
    assert.equal(first.success, true);
    assert.equal(first.remainingMinutes, 75);

    const dup = completeTaskPart(userId, taskId, 45, undefined, { commandId: 'cmd-dedup-1' });
    assert.equal(dup.success, true);
    const afterDup = db.prepare('SELECT duration_minutes FROM tasks WHERE id = ?').get(taskId) as any;
    assert.equal(afterDup.duration_minutes, 75);
  });

  it('isolates daily task completion per businessDate and stops future generation on stop_daily (T06)', async () => {
    const startToday = wallClockIso(tomorrowKey, 20, 0);
    const endToday = wallClockIso(tomorrowKey, 20, 30);

    const dailyRes = await createTaskCommand({
      userId,
      rawInput: {
        title: '每日英语听力',
        time_mode: 'daily_fixed',
        is_fixed: true,
        scheduled_start: startToday,
        scheduled_end: endToday,
        duration_minutes: 30,
      },
    });
    assert.equal(dailyRes.success, true);
    const taskId = dailyRes.task!.id;

    // Complete only on tomorrowKey
    const comp = executeQuickActionCommand({
      userId,
      taskId,
      action: 'complete',
      businessDate: tomorrowKey,
    });
    assert.equal(comp.success, true);

    const doneInst = ensureTaskInstance(userId, taskId, tomorrowKey);
    assert.equal(doneInst?.status, 'completed');

    // Day after tomorrow should still start as a pending daily instance
    const dayAfterKey = addDaysToDateKey(tomorrowKey, 1);
    const nextInst = ensureTaskInstance(userId, taskId, dayAfterKey);
    assert.ok(nextInst);
    assert.equal(nextInst.status, 'pending');

    // Stop daily template -> cancels future materialized instances & prevents generating further ones
    const stopRes = executeQuickActionCommand({ userId, taskId, action: 'stop_daily' });
    assert.equal(stopRes.success, true);

    const thirdDayKey = addDaysToDateKey(tomorrowKey, 2);
    const thirdInst = ensureTaskInstance(userId, taskId, thirdDayKey);
    assert.ok(!thirdInst || thirdInst.status === 'cancelled');

    const farFutureKey = addDaysToDateKey(tomorrowKey, 20);
    assert.equal(ensureTaskInstance(userId, taskId, farFutureKey), null);
  });

  it('applies partial settings patch preserving outbound fields & validates session_version revocation (A02, A04)', () => {
    const req: any = {
      user: { id: userId },
      body: {
        task_buffer_minutes: 15,
      },
    };
    const mock = createMockResponse();
    updateSettings(req, mock.res);

    assert.equal(mock.getStatus(), 200);
    const saved = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as any;
    assert.equal(saved.task_buffer_minutes, 15);
    assert.equal(saved.clawbot_outbound_url, 'https://outbound.example/push');
    assert.equal(saved.clawbot_outbound_key, 'outbound-secret');
    assert.equal(saved.clawbot_to_wxid, 'wxid_test_1');

    // Optimistic conflict when expected_updated_at mismatches
    const staleReq: any = {
      user: { id: userId },
      body: {
        task_buffer_minutes: 20,
        expected_updated_at: '1999-01-01 00:00:00',
      },
    };
    const staleMock = createMockResponse();
    updateSettings(staleReq, staleMock.res);
    assert.equal(staleMock.getStatus(), 409);

    // Session version revocation check
    assert.equal(checkAccountEligibility(userId, 1).eligible, true);
    incrementSessionVersion(userId);
    assert.equal(checkAccountEligibility(userId, 1).eligible, false);
    assert.equal(checkAccountEligibility(userId, 2).eligible, true);
  });
});
