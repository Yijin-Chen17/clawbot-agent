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
});
