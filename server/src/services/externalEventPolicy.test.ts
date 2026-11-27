import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../config/database.js';
import { setupIsolatedTestEnv, seedTestUser, wallClockIso } from '../testHelpers/testDb.js';
import { setCalendarFetcherForTest, syncSubscription } from './calendarSync.js';
import {
  extractCourseGroup,
  listExternalEventGroups,
  upsertExternalGroupRule,
  upsertSingleExternalEventOverride,
} from './externalEventPolicyService.js';
import { getActiveExternalBusyEvents, replanUserTasks } from './scheduler.js';
import { queryScheduleInRange } from './scheduleQueryService.js';
import { createTaskCommand } from './taskService.js';
import {
  processExternalOutboxNotifications,
  syncExternalNotificationOutboxForUser,
} from './externalOutboxService.js';
import { checkCalendarSync } from './reminder.js';
import { setLlmExecutorForTest } from './llm.js';
import { setOutboundSenderForTest } from './clawbot.js';
import { getAccountLocalDateKey, addDaysToDateKey } from '../utils/timezone.js';

describe('External Event Policies, Course Grouping & AI Reminders', () => {
  let cleanup: () => void;
  let userId: number;
  let tomorrowKey: string;

  beforeEach(() => {
    const env = setupIsolatedTestEnv();
    cleanup = env.cleanup;
    const user = seedTestUser({ timezone: 'Asia/Shanghai' });
    userId = user.userId;
    tomorrowKey = addDaysToDateKey(getAccountLocalDateKey(new Date(), 'Asia/Shanghai'), 1);
  });

  afterEach(() => {
    cleanup();
  });

  it('extractCourseGroup normalizes week/room variants into identical course groups', () => {
    const a = extractCourseGroup('[1-16周] 高等数学 @A101');
    const b = extractCourseGroup('高等数学 (第3-18周 单周)');
    const c = extractCourseGroup('高等数学 - 逸夫楼203');
    const d = extractCourseGroup('高等数学');

    assert.equal(a.groupLabel, '高等数学');
    assert.equal(b.groupLabel, '高等数学');
    assert.equal(c.groupLabel, '高等数学');
    assert.equal(d.groupLabel, '高等数学');
    assert.equal(a.groupKey, b.groupKey);
    assert.equal(b.groupKey, c.groupKey);
    assert.equal(c.groupKey, d.groupKey);
  });

  it('supports batch course group scheduling policy, single-event overrides, and survives resync', async () => {
    const subInfo = db
      .prepare("INSERT INTO calendar_subscriptions (user_id, name, url) VALUES (?, '教务课表', 'https://cal.example/course.ics')")
      .run(userId);
    const sub = db.prepare('SELECT * FROM calendar_subscriptions WHERE id = ?').get(subInfo.lastInsertRowid) as any;

    const day1 = tomorrowKey;
    const day2 = addDaysToDateKey(tomorrowKey, 1);

    const makeFeed = () => ({
      math1: {
        type: 'VEVENT',
        uid: 'math-w1',
        summary: '高等数学 (1-16周) @A101',
        start: new Date(wallClockIso(day1, 9, 0)),
        end: new Date(wallClockIso(day1, 11, 0)),
      },
      math2: {
        type: 'VEVENT',
        uid: 'math-w2',
        summary: '[第2周] 高等数学',
        start: new Date(wallClockIso(day2, 9, 0)),
        end: new Date(wallClockIso(day2, 11, 0)),
      },
      english1: {
        type: 'VEVENT',
        uid: 'eng-w1',
        summary: '大学英语 @B202',
        start: new Date(wallClockIso(day1, 14, 0)),
        end: new Date(wallClockIso(day1, 16, 0)),
      },
    });

    setCalendarFetcherForTest(async () => makeFeed());
    await syncSubscription(sub);

    const groups = listExternalEventGroups(userId);
    assert.equal(groups.length, 2);
    const mathGroup = groups.find(g => g.groupLabel === '高等数学');
    assert.ok(mathGroup);
    assert.equal(mathGroup.eventCount, 2);
    assert.equal(mathGroup.allowScheduling, false);
    assert.equal(mathGroup.aiReminderEnabled, true);

    const rangeStart = wallClockIso(day1, 0, 0);
    const rangeEnd = wallClockIso(day2, 23, 59);

    // Initially all 3 events block scheduling
    assert.equal(getActiveExternalBusyEvents(userId, rangeStart, rangeEnd).length, 3);

    // Batch allow scheduling on 高等数学 group
    upsertExternalGroupRule({
      userId,
      subscriptionId: sub.id,
      groupKey: mathGroup.groupKey,
      groupLabel: mathGroup.groupLabel,
      allowScheduling: true,
    });

    // Now only 大学英语 blocks scheduling
    const busyAfterGroup = getActiveExternalBusyEvents(userId, rangeStart, rangeEnd);
    assert.equal(busyAfterGroup.length, 1);
    assert.equal(busyAfterGroup[0].title, '大学英语 @B202');

    // Movable task should be able to occupy the freed 高等数学 morning slot (09:00-11:00) via replanUserTasks
    const movableTask = await createTaskCommand({
      userId,
      rawInput: {
        title: '刷高数习题',
        duration_minutes: 60,
        deadline: wallClockIso(day1, 18, 0),
        urgency: 90,
        importance: 80,
      },
    });
    assert.equal(movableTask.success, true);
    const replanRes = replanUserTasks(userId, { triggerSource: 'test_ext_policy' });
    assert.ok(replanRes.scheduledCount >= 1);

    // Unified view still retains all 3 external events with allowScheduling metadata
    const unified = queryScheduleInRange(userId, rangeStart, rangeEnd);
    assert.equal(unified.externalEvents.length, 3);
    assert.equal(unified.externalEvents.filter(e => e.allowScheduling).length, 2);

    // Override only math-w2 back to occupied (allowScheduling = false)
    const math2Row = db
      .prepare("SELECT id FROM external_events WHERE user_id = ? AND uid = 'math-w2'")
      .get(userId) as { id: number };
    upsertSingleExternalEventOverride({
      userId,
      eventId: math2Row.id,
      allowScheduling: false,
    });

    const busyAfterOverride = getActiveExternalBusyEvents(userId, rangeStart, rangeEnd);
    assert.equal(busyAfterOverride.length, 2);

    // Resync subscription -> group rule & single override persist on new generation
    const latestSub = db.prepare('SELECT * FROM calendar_subscriptions WHERE id = ?').get(sub.id) as any;
    await syncSubscription(latestSub);
    const busyAfterResync = getActiveExternalBusyEvents(userId, rangeStart, rangeEnd);
    assert.equal(busyAfterResync.length, 2);
  });

  it('delivers AI reminders for external events regardless of allowScheduling, including overlapping task context and fallback', async () => {
    const subInfo = db
      .prepare("INSERT INTO calendar_subscriptions (user_id, name, url) VALUES (?, '课程表', 'https://cal.example/course.ics')")
      .run(userId);
    const sub = db.prepare('SELECT * FROM calendar_subscriptions WHERE id = ?').get(subInfo.lastInsertRowid) as any;

    const evStart = wallClockIso(tomorrowKey, 9, 0);
    const evEnd = wallClockIso(tomorrowKey, 11, 0);

    setCalendarFetcherForTest(async () => ({
      course1: {
        type: 'VEVENT',
        uid: 'elective-1',
        summary: '选修课：电影赏析',
        start: new Date(evStart),
        end: new Date(evEnd),
      },
    }));
    await syncSubscription(sub);

    // Mark elective as allowScheduling = true, keep aiReminderEnabled = true
    const group = listExternalEventGroups(userId)[0];
    upsertExternalGroupRule({
      userId,
      subscriptionId: sub.id,
      groupKey: group.groupKey,
      groupLabel: group.groupLabel,
      allowScheduling: true,
      aiReminderEnabled: true,
    });

    // Create a fixed task overlapping 09:30 - 10:30 (allowed because elective is marked free!)
    const created = await createTaskCommand({
      userId,
      rawInput: {
        title: '完成项目报告',
        is_fixed: true,
        scheduled_start: wallClockIso(tomorrowKey, 9, 30),
        scheduled_end: wallClockIso(tomorrowKey, 10, 30),
        duration_minutes: 60,
      },
    });
    assert.equal(created.success, true);

    syncExternalNotificationOutboxForUser(userId, new Date(wallClockIso(tomorrowKey, 8, 0)));

    let capturedPrompt = '';
    setLlmExecutorForTest(async (params) => {
      capturedPrompt = params.messages.map(m => m.content).join('\n');
      return {
        content: 'AI提醒：09:00-11:00 日程上有「选修课：电影赏析」（已设为可占用排程），同时段安排了「完成项目报告」(09:30-10:30)，请注意取舍。',
        usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
      };
    });

    const sentMessages: string[] = [];
    setOutboundSenderForTest(async (_settings, msg) => {
      sentMessages.push(msg);
      return { outcome: 'sent', channel: 'webhook_outbound', providerMsgId: 'ext-msg-1' };
    });

    const fireNow = new Date(new Date(evStart).getTime() - 4 * 60_000);
    const res = await processExternalOutboxNotifications(fireNow, 'test-ext-worker');
    assert.equal(res.sent, 1);
    assert.equal(res.usedAiCount, 1);
    assert.match(capturedPrompt, /可占用排程/);
    assert.match(capturedPrompt, /完成项目报告/);
    assert.match(sentMessages[0], /电影赏析/);

    // Re-syncing must NOT enqueue duplicate reminder for the already-sent fire time
    const resyncOutbox = syncExternalNotificationOutboxForUser(userId, fireNow);
    assert.equal(resyncOutbox.enqueued, 0);

    // Test graceful template fallback when LLM fails on another event
    const ev2Start = wallClockIso(tomorrowKey, 14, 0);
    const ev2End = wallClockIso(tomorrowKey, 15, 0);
    setCalendarFetcherForTest(async () => ({
      course2: {
        type: 'VEVENT',
        uid: 'seminar-2',
        summary: '学术讲座',
        start: new Date(ev2Start),
        end: new Date(ev2End),
      },
    }));
    const latestSub = db.prepare('SELECT * FROM calendar_subscriptions WHERE id = ?').get(sub.id) as any;
    await syncSubscription(latestSub);
    syncExternalNotificationOutboxForUser(userId, fireNow);

    setLlmExecutorForTest(async () => {
      throw new Error('LLM timeout');
    });

    const fireNow2 = new Date(new Date(ev2Start).getTime() - 4 * 60_000);
    const res2 = await processExternalOutboxNotifications(fireNow2, 'test-ext-worker');
    assert.equal(res2.sent, 1);
    assert.equal(res2.usedAiCount, 0);
    assert.match(sentMessages[1], /学术讲座/);
  });

  it('cancels pending external reminders when aiReminderEnabled is turned off', async () => {
    const subInfo = db
      .prepare("INSERT INTO calendar_subscriptions (user_id, name, url) VALUES (?, '课程表', 'https://cal.example/course.ics')")
      .run(userId);
    const sub = db.prepare('SELECT * FROM calendar_subscriptions WHERE id = ?').get(subInfo.lastInsertRowid) as any;

    setCalendarFetcherForTest(async () => ({
      c1: {
        type: 'VEVENT',
        uid: 'pe-1',
        summary: '体育课',
        start: new Date(wallClockIso(tomorrowKey, 16, 0)),
        end: new Date(wallClockIso(tomorrowKey, 17, 30)),
      },
    }));
    await syncSubscription(sub);
    syncExternalNotificationOutboxForUser(userId, new Date(wallClockIso(tomorrowKey, 10, 0)));
    const pendingBeforeDisable = (
      db
        .prepare("SELECT COUNT(*) as c FROM external_notification_outbox WHERE user_id = ? AND status = 'pending'")
        .get(userId) as { c: number }
    ).c;
    assert.equal(pendingBeforeDisable, 1);

    const group = listExternalEventGroups(userId)[0];
    upsertExternalGroupRule({
      userId,
      subscriptionId: sub.id,
      groupKey: group.groupKey,
      groupLabel: group.groupLabel,
      aiReminderEnabled: false,
    });
    const syncAfterDisable = syncExternalNotificationOutboxForUser(
      userId,
      new Date(wallClockIso(tomorrowKey, 10, 0))
    );
    assert.equal(syncAfterDisable.cancelled, 1);

    const pendingCount = (
      db
        .prepare("SELECT COUNT(*) as c FROM external_notification_outbox WHERE user_id = ? AND status = 'pending'")
        .get(userId) as { c: number }
    ).c;
    assert.equal(pendingCount, 0);
  });

  it('deduplicates external reminders and avoids false changed flags when ICS regenerates random UIDs per fetch', async () => {
    const subInfo = db
      .prepare("INSERT INTO calendar_subscriptions (user_id, name, url) VALUES (?, 'UNNC', 'https://cal.example/unnc.ics')")
      .run(userId);
    const subId = Number(subInfo.lastInsertRowid);

    const evStart = wallClockIso(tomorrowKey, 9, 0);
    const evEnd = wallClockIso(tomorrowKey, 11, 0);
    let fetchCount = 0;

    setCalendarFetcherForTest(async () => {
      fetchCount++;
      return {
        c1: {
          type: 'VEVENT',
          uid: `random-uid-round-${fetchCount}`,
          summary: 'COMP1036/L1/01',
          start: new Date(evStart),
          end: new Date(evEnd),
        },
      };
    });

    const sync1 = await syncSubscription(
      db.prepare('SELECT * FROM calendar_subscriptions WHERE id = ?').get(subId) as any
    );
    assert.equal(sync1.changed, true);

    let llmCalls = 0;
    setLlmExecutorForTest(async () => {
      llmCalls++;
      return { content: `AI提醒#${llmCalls}` };
    });

    const sentKeys: Array<string | undefined> = [];
    setOutboundSenderForTest(async (_settings, _msg, idempotencyKey) => {
      sentKeys.push(idempotencyKey);
      return { outcome: 'sent', channel: 'weixin_ilink', providerMsgId: `wx-${sentKeys.length}` };
    });

    // Fire at 08:55
    const t0855 = new Date(new Date(evStart).getTime() - 5 * 60_000 + 5_000);
    syncExternalNotificationOutboxForUser(userId, t0855);
    const res1 = await processExternalOutboxNotifications(t0855, 'worker-1');
    assert.equal(res1.sent, 1);

    // Subsequent sync at 08:56 returns a brand-new random UID -> must NOT report changed or re-send!
    const sync2 = await syncSubscription(
      db.prepare('SELECT * FROM calendar_subscriptions WHERE id = ?').get(subId) as any
    );
    assert.equal(sync2.changed, false);

    const t0856 = new Date(new Date(evStart).getTime() - 4 * 60_000);
    syncExternalNotificationOutboxForUser(userId, t0856);
    const res2 = await processExternalOutboxNotifications(t0856, 'worker-1');
    assert.equal(res2.sent, 0);

    // Even at 09:01 with another new random UID, still must NOT re-send
    const sync3 = await syncSubscription(
      db.prepare('SELECT * FROM calendar_subscriptions WHERE id = ?').get(subId) as any
    );
    assert.equal(sync3.changed, false);
    const t0901 = new Date(new Date(evStart).getTime() + 60_000);
    syncExternalNotificationOutboxForUser(userId, t0901);
    const res3 = await processExternalOutboxNotifications(t0901, 'worker-1');
    assert.equal(res3.sent, 0);
    assert.equal(sentKeys.length, 1);
    assert.equal(llmCalls, 1);
  });

  it('respects calendar_sync_interval_minutes when last_attempt_at is UTC CURRENT_TIMESTAMP and caps failed retries at 3', async () => {
    const subInfo = db
      .prepare("INSERT INTO calendar_subscriptions (user_id, name, url) VALUES (?, 'UNNC', 'https://cal.example/unnc.ics')")
      .run(userId);
    const subId = Number(subInfo.lastInsertRowid);

    const evStart = wallClockIso(tomorrowKey, 9, 0);
    const evEnd = wallClockIso(tomorrowKey, 11, 0);
    let fetchCalls = 0;

    setCalendarFetcherForTest(async () => {
      fetchCalls++;
      return {
        c1: {
          type: 'VEVENT',
          uid: 'stable-uid-1',
          summary: 'COMP1036/L1/01',
          start: new Date(evStart),
          end: new Date(evEnd),
        },
      };
    });

    // Simulate legacy SQLite UTC CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS") set 5 minutes ago
    const fiveMinAgoUtc = new Date(Date.now() - 5 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    db.prepare('UPDATE calendar_subscriptions SET last_attempt_at = ? WHERE id = ?').run(fiveMinAgoUtc, subId);

    // Default interval is 60 min -> checkCalendarSync must NOT sync after just 5 minutes
    await checkCalendarSync(new Date());
    assert.equal(fetchCalls, 0);

    // After 61 minutes -> checkCalendarSync syncs once, and a second tick 1 minute later does not re-sync
    await checkCalendarSync(new Date(Date.now() + 61 * 60_000));
    assert.equal(fetchCalls, 1);
    await checkCalendarSync(new Date(Date.now() + 62 * 60_000));
    assert.equal(fetchCalls, 1);

    // Failed delivery stops retrying after 3 attempts (no infinite 15s spin when next_retry_at is NULL)
    let llmCalls = 0;
    setLlmExecutorForTest(async () => {
      llmCalls++;
      return { content: `AI-${llmCalls}` };
    });
    const usedKeys: Array<string | undefined> = [];
    setOutboundSenderForTest(async (_settings, _msg, idemKey) => {
      usedKeys.push(idemKey);
      return { outcome: 'failed', channel: 'weixin_ilink', error: 'mock error' };
    });

    const fireStartMs = new Date(evStart).getTime() - 5 * 60_000 + 1_000;
    syncExternalNotificationOutboxForUser(userId, new Date(fireStartMs - 60_000));
    for (let i = 0; i < 8; i++) {
      // Advance by 5 minutes each step so backoff never blocks eligible attempts within expires_at,
      // wait: expires_at is +15m after start (20m after fireStart), so use 130s steps across 15m
      const stepTime = new Date(fireStartMs + i * 130_000);
      db.prepare('UPDATE external_notification_outbox SET next_retry_at = NULL WHERE user_id = ?').run(userId);
      await processExternalOutboxNotifications(stepTime, 'worker-retry-test');
    }

    const row = db
      .prepare('SELECT status, attempt_count FROM external_notification_outbox WHERE user_id = ?')
      .get(userId) as { status: string; attempt_count: number };
    assert.equal(row.status, 'failed');
    assert.equal(row.attempt_count, 3);
    assert.equal(usedKeys.length, 3);
    assert.ok(usedKeys[0] && usedKeys[0] === usedKeys[1] && usedKeys[1] === usedKeys[2]);
  });
});
