import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../config/database.js';
import { setupIsolatedTestEnv, seedTestUser, wallClockIso } from '../testHelpers/testDb.js';
import { createTaskCommand, executeQuickActionCommand } from './taskService.js';
import { queryScheduleForLocalDate, queryScheduleInRange } from './scheduleQueryService.js';
import { generateUserTodoIcal } from './calendarSync.js';
import { commitBackupImport, exportUserBackup, previewBackupImport } from './backupService.js';
import { addDaysToDateKey, getAccountLocalDateKey } from '../utils/timezone.js';

describe('Batch 4: Unified Schedule Query, iCal Export Consistency & v2 Backup Merge', () => {
  let cleanup: () => void;
  let userId: number;
  let username: string;
  let tomorrowKey: string;

  beforeEach(() => {
    const env = setupIsolatedTestEnv();
    cleanup = env.cleanup;
    const seeded = seedTestUser({
      timezone: 'Asia/Shanghai',
      workSlotsJson: JSON.stringify([
        { start: '09:00', end: '18:00' },
        { start: '23:00', end: '24:00' },
        { start: '00:00', end: '02:00' },
      ]),
    });
    userId = seeded.userId;
    username = seeded.username;
    tomorrowKey = getAccountLocalDateKey(new Date(Date.now() + 86_400_000), 'Asia/Shanghai');
  });

  afterEach(() => {
    cleanup();
  });

  it('queries cross-midnight schedule blocks across local date bounds and keeps iCal feed consistent (C05, C06)', async () => {
    const crossStart = wallClockIso(tomorrowKey, 23, 30);
    const nextDayKey = addDaysToDateKey(tomorrowKey, 1);
    const crossEnd = wallClockIso(nextDayKey, 1, 0);

    const created = await createTaskCommand({
      userId,
      rawInput: {
        title: '跨零点上线窗口',
        is_fixed: true,
        scheduled_start: crossStart,
        scheduled_end: crossEnd,
        duration_minutes: 90,
      },
    });
    assert.equal(created.success, true);

    // Day 1 query (tomorrowKey) and Day 2 query (nextDayKey) must BOTH see the overlapping block
    const day1 = queryScheduleForLocalDate(userId, tomorrowKey);
    const day2 = queryScheduleForLocalDate(userId, nextDayKey);
    assert.ok(day1.blocks.some(b => b.taskId === created.task!.id));
    assert.ok(day2.blocks.some(b => b.taskId === created.task!.id));

    const range = queryScheduleInRange(userId, crossStart, crossEnd);
    assert.equal(range.blocks.length, 1);
    assert.equal(range.blocks[0].title, '跨零点上线窗口');

    const ics = generateUserTodoIcal(userId, username);
    assert.ok(ics.includes('跨零点上线窗口'));
    assert.ok(ics.includes('X-WR-TIMEZONE:Asia/Shanghai'));
    assert.ok(ics.includes('BEGIN:VALARM'));
  });

  it('exports v2 backup and imports idempotently with merge preview preserving hard deadlines, tags & fixed flags (C07)', async () => {
    const fixedStart = wallClockIso(tomorrowKey, 10, 0);
    const fixedEnd = wallClockIso(tomorrowKey, 11, 0);
    const hardRes = await createTaskCommand({
      userId,
      rawInput: {
        title: '重要固定硬截止',
        is_fixed: true,
        is_concurrent: true,
        scheduled_start: fixedStart,
        scheduled_end: fixedEnd,
        duration_minutes: 60,
        deadline: wallClockIso(tomorrowKey, 12, 0),
        deadline_kind: 'hard',
        tags: ['核心', '架构'],
      },
    });
    assert.equal(hardRes.success, true);

    const dailyRes = await createTaskCommand({
      userId,
      rawInput: {
        title: '每日打卡背词',
        time_mode: 'daily_fixed',
        is_fixed: true,
        scheduled_start: wallClockIso(tomorrowKey, 15, 0),
        scheduled_end: wallClockIso(tomorrowKey, 15, 30),
        duration_minutes: 30,
      },
    });
    assert.equal(dailyRes.success, true);
    executeQuickActionCommand({
      userId,
      taskId: dailyRes.task!.id,
      action: 'complete',
      businessDate: tomorrowKey,
    });

    const exported = exportUserBackup(userId);
    assert.equal(exported.schemaVersion, 2);
    assert.equal(exported.tasks.length, 2);

    // Import into same user under merge -> 100% skipped as duplicates
    const samePreview = previewBackupImport(userId, exported, 'merge');
    assert.equal(samePreview.newCount, 0);
    assert.equal(samePreview.duplicateCount, 2);

    // Import into a brand new user under merge -> imports 2, then repeating merge skips 2
    const targetUser = seedTestUser({ username: 'restore_user', timezone: 'Asia/Shanghai' }).userId;
    const firstImport = commitBackupImport(targetUser, exported, 'merge');
    assert.equal(firstImport.success, true);
    assert.equal(firstImport.importedCount, 2);
    assert.equal(firstImport.skippedCount, 0);

    const importedHard = db
      .prepare("SELECT * FROM tasks WHERE user_id = ? AND title = '重要固定硬截止'")
      .get(targetUser) as any;
    assert.equal(importedHard.deadline_kind, 'hard');
    assert.equal(importedHard.is_fixed, 1);
    assert.equal(importedHard.is_concurrent, 1);
    assert.deepEqual(JSON.parse(importedHard.tags), ['核心', '架构']);

    const secondImport = commitBackupImport(targetUser, exported, 'merge');
    assert.equal(secondImport.importedCount, 0);
    assert.equal(secondImport.skippedCount, 2);
    assert.equal((db.prepare('SELECT COUNT(*) as c FROM tasks WHERE user_id = ?').get(targetUser) as any).c, 2);
  });
});
