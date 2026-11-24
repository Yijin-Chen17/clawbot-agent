import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { db } from '../config/database.js';
import { JWT_SECRET } from '../config/env.js';
import { createMockResponse, seedTestUser, setupIsolatedTestEnv, wallClockIso } from '../testHelpers/testDb.js';
import { requireAuth } from '../middleware/auth.js';
import {
  completePartTask,
  createTask,
  exportBackup,
  importBackup,
  listTasks,
  quickActionTask,
  updateTask,
} from '../controllers/taskController.js';
import { exportDedicatedIcal, getCalendarEvents, replanAll } from '../controllers/calendarController.js';
import { banUser } from '../controllers/adminController.js';
import { replanUserTasks } from './scheduler.js';
import { setLlmExecutorForTest } from './llm.js';
import { getAccountLocalTimeHm } from '../utils/timezone.js';

describe('End-to-End Integration: Recurrence Rollover, Controllers, Auth Revocation & Backup', () => {
  let cleanup: () => void;
  let userId: number;
  let adminId: number;
  let userToken: string;

  beforeEach(() => {
    const env = setupIsolatedTestEnv();
    cleanup = env.cleanup;
    const seeded = seedTestUser({ username: 'e2e_user', timezone: 'Asia/Shanghai' });
    userId = seeded.userId;
    adminId = seedTestUser({ username: 'e2e_admin', role: 'admin', timezone: 'Asia/Shanghai' }).userId;
    userToken = jwt.sign(
      { id: userId, username: seeded.username, role: 'user', sv: 1 },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
  });

  afterEach(() => {
    cleanup();
  });

  it('persists weekly recurrence_rule, skips non-matching weekdays on rollover, and materializes fixed blocks on matching days', async () => {
    // 2026-12-07 is Monday (day 1), 2026-12-08 is Tuesday (day 2), 2026-12-09 is Wednesday (day 3)
    const monIso = wallClockIso('2026-12-07', 20, 0);
    const monEndIso = wallClockIso('2026-12-07', 20, 45);

    const createMock = createMockResponse();
    await createTask(
      {
        user: { id: userId },
        headers: {},
        body: {
          title: '每周一三夜跑',
          time_mode: 'daily_fixed',
          recurrence_rule: JSON.stringify({ type: 'weekly', daysOfWeek: [1, 3] }),
          is_fixed: 1,
          scheduled_start: monIso,
          scheduled_end: monEndIso,
          duration_minutes: 45,
        },
      } as any,
      createMock.res
    );

    assert.equal(createMock.getStatus(), 201);
    const taskId = createMock.getBody().task.id;
    assert.equal(createMock.getBody().task.recurrence_rule, '{"type":"weekly","daysOfWeek":[1,3]}');

    // Monday replan -> active block exists for 2026-12-07
    const mondayNow = new Date('2026-12-07T08:00:00+08:00');
    replanUserTasks(userId, { triggerSource: 'test_mon', now: mondayNow });
    const monBlocks = db
      .prepare("SELECT * FROM schedule_blocks sb JOIN task_instances ti ON ti.id = sb.instance_id WHERE sb.task_id = ? AND ti.business_date = '2026-12-07' AND sb.status = 'planned'")
      .all(taskId) as any[];
    assert.equal(monBlocks.length, 1);

    // Tuesday replan -> does NOT spawn instance or block on 2026-12-08
    const tuesdayNow = new Date('2026-12-08T08:00:00+08:00');
    replanUserTasks(userId, { triggerSource: 'test_tue', now: tuesdayNow });
    const tueInst = db
      .prepare("SELECT * FROM task_instances WHERE task_id = ? AND business_date = '2026-12-08'")
      .get(taskId);
    assert.equal(tueInst, undefined);

    // Wednesday replan -> automatically materializes fixed block on 2026-12-09
    const wedNow = new Date('2026-12-09T08:00:00+08:00');
    replanUserTasks(userId, { triggerSource: 'test_wed', now: wedNow });
    const wedBlocks = db
      .prepare("SELECT sb.*, ti.business_date FROM schedule_blocks sb JOIN task_instances ti ON ti.id = sb.instance_id WHERE sb.task_id = ? AND ti.business_date = '2026-12-09' AND sb.status = 'planned'")
      .all(taskId) as any[];
    assert.equal(wedBlocks.length, 1);
    assert.equal(wedBlocks[0].is_fixed, 1);
    assert.equal(wedBlocks[0].duration_minutes, 45);

    // Backup export + import preserves recurrence_rule
    const expMock = createMockResponse();
    exportBackup({ user: { id: userId } } as any, expMock.res);
    assert.equal(expMock.getBody().tasks[0].recurrenceRule, '{"type":"weekly","daysOfWeek":[1,3]}');

    const restoreUser = seedTestUser({ username: 'restore_rec', timezone: 'Asia/Shanghai' }).userId;
    const impMock = createMockResponse();
    importBackup(
      { user: { id: restoreUser }, headers: {}, body: { data: expMock.getBody(), mode: 'merge' } } as any,
      impMock.res
    );
    assert.equal(impMock.getStatus(), 200);
    const restoredTask = db.prepare('SELECT recurrence_rule FROM tasks WHERE user_id = ?').get(restoreUser) as any;
    assert.equal(restoredTask.recurrence_rule, '{"type":"weekly","daysOfWeek":[1,3]}');
  });

  it('verifies full Web controller flow: Auth -> Create -> List -> Update -> Replan -> Events -> Complete-part -> Quick-action -> iCal -> Ban', async () => {
    setLlmExecutorForTest(async () => ({ content: '{}' }));

    // 1. Auth middleware accepts valid token
    let authedUser: any = null;
    const authReq: any = { headers: { authorization: `Bearer ${userToken}` } };
    const authRes = createMockResponse();
    requireAuth(authReq, authRes.res, () => {
      authedUser = authReq.user;
    });
    assert.equal(authedUser?.id, userId);

    // 2. Create task
    const cMock = createMockResponse();
    await createTask(
      {
        user: { id: userId },
        headers: { 'idempotency-key': 'e2e-create-1' },
        body: {
          title: '端到端验证任务',
          duration_minutes: 90,
          time_mode: 'flexible',
          importance_tier: 'vital',
          tags: ['测试'],
        },
      } as any,
      cMock.res
    );
    assert.equal(cMock.getStatus(), 201);
    const taskId = cMock.getBody().task.id;

    // 3. ReplanAll controller (the exact route CalendarView calls)
    const replanMock = createMockResponse();
    replanAll({ user: { id: userId } } as any, replanMock.res);
    assert.equal(replanMock.getStatus(), 200);
    assert.equal(replanMock.getBody().success, true);

    // 4. List tasks & get calendar events
    const listMock = createMockResponse();
    listTasks({ user: { id: userId }, query: {} } as any, listMock.res);
    assert.equal(listMock.getStatus(), 200);
    assert.equal(listMock.getBody().tasks.length, 1);

    const eventsMock = createMockResponse();
    getCalendarEvents(
      {
        user: { id: userId },
        query: {
          start: new Date(Date.now() - 86_400_000).toISOString(),
          end: new Date(Date.now() + 14 * 86_400_000).toISOString(),
        },
        get: () => '127.0.0.1:5178',
        protocol: 'http',
      } as any,
      eventsMock.res
    );
    assert.equal(eventsMock.getStatus(), 200);
    const taskEvents = eventsMock.getBody().events.filter((e: any) => e.extendedProps?.type === 'task');
    assert.ok(taskEvents.length >= 1);

    // 5. Update task title
    const updMock = createMockResponse();
    await updateTask(
      {
        user: { id: userId },
        params: { id: String(taskId) },
        headers: {},
        body: { title: '端到端验证任务(已更新)' },
      } as any,
      updMock.res
    );
    assert.equal(updMock.getStatus(), 200);

    // 6. Complete-part by block_id
    const partMock = createMockResponse();
    completePartTask(
      {
        user: { id: userId },
        params: { id: String(taskId) },
        headers: {},
        body: { block_id: taskEvents[0].extendedProps.blockId },
      } as any,
      partMock.res
    );
    assert.equal(partMock.getStatus(), 200);
    assert.equal(partMock.getBody().success, true);

    // 7. Quick-action complete & reopen
    const compMock = createMockResponse();
    quickActionTask(
      { user: { id: userId }, params: { id: String(taskId) }, headers: {}, body: { action: 'complete' } } as any,
      compMock.res
    );
    assert.equal(compMock.getStatus(), 200);
    assert.equal(compMock.getBody().task.status, 'completed');

    const reopenMock = createMockResponse();
    quickActionTask(
      { user: { id: userId }, params: { id: String(taskId) }, headers: {}, body: { action: 'reopen' } } as any,
      reopenMock.res
    );
    assert.equal(reopenMock.getStatus(), 200);
    assert.notEqual(reopenMock.getBody().task.status, 'completed');

    // 8. Export iCal feed
    const icsMock = createMockResponse();
    exportDedicatedIcal({ params: { token: 'secret-token.ics' } } as any, icsMock.res);
    assert.equal(icsMock.getStatus(), 200);
    assert.ok(String(icsMock.getBody()).includes('端到端验证任务(已更新)'));

    // 9. Ban user -> blocks JWT & public iCal immediately
    const banMock = createMockResponse();
    banUser({ user: { id: adminId }, params: { id: String(userId) } } as any, banMock.res);
    assert.equal(banMock.getStatus(), 200);

    const authBlockedMock = createMockResponse();
    let nextCalled = false;
    requireAuth(
      { headers: { authorization: `Bearer ${userToken}` } } as any,
      authBlockedMock.res,
      () => {
        nextCalled = true;
      }
    );
    assert.equal(nextCalled, false);
    assert.equal(authBlockedMock.getStatus(), 403);

    const icsBlockedMock = createMockResponse();
    exportDedicatedIcal({ params: { token: 'secret-token.ics' } } as any, icsBlockedMock.res);
    assert.equal(icsBlockedMock.getStatus(), 403);
  });

  it('schedules all 14-day recurring movable occurrences at the same wall-clock slot with exception fallback, and schedules Q4 flexible tasks when slots are free', async () => {
    // 1. Add movable weekly recurring task (Mon/Wed/Fri) + external blocker ONLY on Wednesday 09:00-10:00
    const resWeekly = db.prepare(`
      INSERT INTO tasks (
        user_id, title, duration_minutes, original_duration_minutes,
        urgency, importance, importance_tier, time_mode, recurrence_rule,
        is_fixed, is_concurrent, status, score_scale, active_template
      ) VALUES (?, '每周一三五背单词', 45, 45, 55, 60, 'support', 'daily_fixed', '{"type":"weekly","daysOfWeek":[1,3,5]}', 0, 0, 'pending_slot', 100, 1)
    `).run(userId);
    const weeklyTaskId = Number(resWeekly.lastInsertRowid);

    // Block Wednesday 2026-12-09 09:00-10:00
    db.prepare(`
      INSERT INTO external_events (user_id, title, start_time, end_time, status, transparency)
      VALUES (?, '周三例会', ?, ?, 'CONFIRMED', 'OPAQUE')
    `).run(userId, wallClockIso('2026-12-09', 9, 0), wallClockIso('2026-12-09', 10, 0));

    // 2. Also add a low-importance Q4 flexible task (previously dropped as q4_filtered or rejected by positive switching penalty)
    const resQ4 = db.prepare(`
      INSERT INTO tasks (
        user_id, title, duration_minutes, original_duration_minutes,
        urgency, importance, importance_tier, time_mode, urgency_pace,
        is_fixed, is_concurrent, status, score_scale
      ) VALUES (?, '整理收藏夹(Q4)', 30, 30, 15, 18, 'minor', 'flexible', 'later', 0, 0, 'pending_slot', 100)
    `).run(userId);
    const q4TaskId = Number(resQ4.lastInsertRowid);

    const mondayMorning = new Date('2026-12-07T08:00:00+08:00');
    const replan = replanUserTasks(userId, { triggerSource: 'test_14d_align', now: mondayMorning });
    assert.equal(replan.success, true);

    // 2026-12-07..2026-12-20 has 6 Mon/Wed/Fri occurrences: 12-07, 12-09, 12-11, 12-14, 12-16, 12-18
    const weeklyBlocks = db
      .prepare(`
        SELECT sb.start_time, sb.end_time, ti.business_date
        FROM schedule_blocks sb
        JOIN task_instances ti ON ti.id = sb.instance_id
        WHERE sb.task_id = ? AND sb.status = 'planned'
        ORDER BY ti.business_date ASC
      `)
      .all(weeklyTaskId) as Array<{ start_time: string; end_time: string; business_date: string }>;

    assert.equal(weeklyBlocks.length, 6);
    assert.deepEqual(
      weeklyBlocks.map(b => b.business_date),
      ['2026-12-07', '2026-12-09', '2026-12-11', '2026-12-14', '2026-12-16', '2026-12-18']
    );

    // Non-conflicting days must share identical wall-clock position!
    const normalDaysHm = weeklyBlocks
      .filter(b => b.business_date !== '2026-12-09')
      .map(b => getAccountLocalTimeHm(new Date(b.start_time), 'Asia/Shanghai'));
    assert.ok(new Set(normalDaysHm).size === 1, `Expected uniform slot across normal days, got ${normalDaysHm.join(', ')}`);

    // Conflict day (12-09) automatically falls back to a valid non-overlapping time
    const wedBlock = weeklyBlocks.find(b => b.business_date === '2026-12-09')!;
    assert.ok(new Date(wedBlock.start_time).getTime() >= new Date(wallClockIso('2026-12-09', 10, 0)).getTime());

    // Q4 low-importance flexible task must NOT be left empty when calendar has free slots
    const q4Blocks = db
      .prepare("SELECT * FROM schedule_blocks WHERE task_id = ? AND status = 'planned'")
      .all(q4TaskId) as any[];
    assert.equal(q4Blocks.length, 1);
  });

  it('schedules future daily/weekly fallback & split chunks without afternoon hijack and blocks overlapping fixed recurrences', async () => {
    // 1. Long movable Q1 daily task (120m > 90m) replanned at 13:05 afternoon + external block on 2026-12-09 morning
    const resDaily = db.prepare(`
      INSERT INTO tasks (
        user_id, title, duration_minutes, original_duration_minutes,
        urgency, importance, importance_tier, time_mode, recurrence_rule,
        is_fixed, is_concurrent, status, score_scale, active_template
      ) VALUES (?, '每日深度阅读', 120, 120, 80, 85, 'vital', 'daily_fixed', '{"type":"daily"}', 0, 0, 'pending_slot', 100, 1)
    `).run(userId);
    const dailyTaskId = Number(resDaily.lastInsertRowid);

    // Weekly task (Mon/Wed/Fri) where 2026-12-09 (Wed) blocks 09:00-18:00 so it MUST fall back to evening on 12-09
    const resWeekly = db.prepare(`
      INSERT INTO tasks (
        user_id, title, duration_minutes, original_duration_minutes,
        urgency, importance, importance_tier, time_mode, recurrence_rule,
        is_fixed, is_concurrent, status, score_scale, active_template
      ) VALUES (?, '每周一三五练琴', 45, 45, 65, 70, 'support', 'daily_fixed', '{"type":"weekly","daysOfWeek":[1,3,5]}', 0, 0, 'pending_slot', 100, 1)
    `).run(userId);
    const weeklyTaskId = Number(resWeekly.lastInsertRowid);

    // Block 2026-12-09 09:00-12:00 and 13:00-18:00
    db.prepare(`
      INSERT INTO external_events (user_id, title, start_time, end_time, status, transparency)
      VALUES (?, '周三全天外出', ?, ?, 'CONFIRMED', 'OPAQUE')
    `).run(userId, wallClockIso('2026-12-09', 9, 0), wallClockIso('2026-12-09', 18, 0));

    // Replan in the afternoon (13:05)
    const tuesdayAfternoon = new Date('2026-12-08T13:05:00+08:00');
    const replan = replanUserTasks(userId, { triggerSource: 'test_afternoon_fallback', now: tuesdayAfternoon });
    assert.equal(replan.success, true);

    // All 14 instances of the 120m daily task must be fully scheduled (no dropped 30m tail on future days!)
    const dailyInstances = db
      .prepare("SELECT business_date, plan_status, allocated_minutes, unallocated_minutes FROM task_instances WHERE task_id = ? ORDER BY business_date ASC")
      .all(dailyTaskId) as Array<{ business_date: string; plan_status: string; allocated_minutes: number; unallocated_minutes: number }>;
    assert.equal(dailyInstances.length, 14);
    for (const inst of dailyInstances) {
      assert.equal(inst.plan_status, 'scheduled', `Expected full schedule on ${inst.business_date}, got ${inst.plan_status}`);
      assert.equal(inst.allocated_minutes, 120);
      assert.equal(inst.unallocated_minutes, 0);
    }

    // Future normal days for the Q1 daily task must pick a peak slot (not 13:05 afternoon low-energy!)
    const firstFutureDailyBlock = db
      .prepare(`
        SELECT sb.start_time FROM schedule_blocks sb
        JOIN task_instances ti ON ti.id = sb.instance_id
        WHERE sb.task_id = ? AND ti.business_date = '2026-12-10' AND sb.status = 'planned'
        ORDER BY sb.start_time ASC LIMIT 1
      `)
      .get(dailyTaskId) as { start_time: string };
    const hmFuture = getAccountLocalTimeHm(new Date(firstFutureDailyBlock.start_time), 'Asia/Shanghai');
    assert.notEqual(hmFuture, '13:05');

    // Weekly task on 2026-12-09 (future conflict day) MUST fall back to evening >= 19:00 instead of being dropped
    const wedWeeklyBlocks = db
      .prepare(`
        SELECT sb.start_time, sb.end_time FROM schedule_blocks sb
        JOIN task_instances ti ON ti.id = sb.instance_id
        WHERE sb.task_id = ? AND ti.business_date = '2026-12-09' AND sb.status = 'planned'
      `)
      .all(weeklyTaskId) as Array<{ start_time: string; end_time: string }>;
    assert.equal(wedWeeklyBlocks.length, 1);
    assert.ok(new Date(wedWeeklyBlocks[0].start_time).getTime() >= new Date(wallClockIso('2026-12-09', 19, 0)).getTime());

    // 2. Fixed recurring overlap guard: Mon/Wed fixed task at 20:00-21:00 vs Daily fixed task at 20:00-21:00 created on Tuesday
    const monWedCreate = createMockResponse();
    await createTask(
      {
        user: { id: userId },
        headers: {},
        body: {
          title: '周一三固定课程',
          time_mode: 'daily_fixed',
          recurrence_rule: JSON.stringify({ type: 'weekly', daysOfWeek: [1, 3] }),
          is_fixed: 1,
          scheduled_start: wallClockIso('2026-12-07', 20, 0),
          scheduled_end: wallClockIso('2026-12-07', 21, 0),
          duration_minutes: 60,
        },
      } as any,
      monWedCreate.res
    );
    assert.equal(monWedCreate.getStatus(), 201);

    const dailyFixedConflict = createMockResponse();
    await createTask(
      {
        user: { id: userId },
        headers: {},
        body: {
          title: '每日固定冲突任务',
          time_mode: 'daily_fixed',
          recurrence_rule: JSON.stringify({ type: 'daily' }),
          is_fixed: 1,
          scheduled_start: wallClockIso('2026-12-08', 20, 0), // Tuesday: clear today, collides Wednesday!
          scheduled_end: wallClockIso('2026-12-08', 21, 0),
          duration_minutes: 60,
        },
      } as any,
      dailyFixedConflict.res
    );
    assert.equal(dailyFixedConflict.getStatus(), 409);
  });
});
