import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../config/database.js';
import {
  setupIsolatedTestEnv,
  seedTestUser,
  createMockResponse,
  wallClockIso,
} from '../testHelpers/testDb.js';
import {
  listPendingWeixinInboxItems,
  persistWeixinPollBatch,
} from './inboxService.js';
import { handleClawbotWebhook } from '../controllers/webhookController.js';
import { processWeChatMessage } from './weixinGateway.js';
import { setLlmExecutorForTest } from './llm.js';
import { setOutboundSenderForTest } from './clawbot.js';
import { setCalendarFetcherForTest, syncSubscription } from './calendarSync.js';
import { createTaskCommand, ignoreExternalCalendarInstance } from './taskService.js';
import { executeInstanceProgressCommand } from './instanceService.js';
import { processOutboxNotifications } from './reminder.js';
import { getActiveExternalBusyEvents } from './scheduler.js';
import { getAccountLocalDateKey } from '../utils/timezone.js';

describe('Batch 3: Command Inbox, Weixin/Webhook Channels, Outbox Delivery & Calendar Sync', () => {
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

  it('persists Weixin iLink poll batches before ack and recovers pending items across restart (M02)', () => {
    const inserted = persistWeixinPollBatch({
      userId,
      botId: 'bot-1',
      nextSyncBuf: 'sync-cursor-42',
      items: [
        { externalMsgId: 'wx-msg-1', senderId: 'u-wx-1', text: '明天上午写方案 60分钟' },
        { externalMsgId: 'wx-msg-2', senderId: 'u-wx-1', text: '查看待办' },
      ],
    });
    assert.equal(inserted.length, 2);

    // Duplicate batch poll should skip existing externalMsgIds
    const dup = persistWeixinPollBatch({
      userId,
      botId: 'bot-1',
      nextSyncBuf: 'sync-cursor-42',
      items: [
        { externalMsgId: 'wx-msg-1', senderId: 'u-wx-1', text: '明天上午写方案 60分钟' },
      ],
    });
    assert.equal(dup.length, 0);

    const savedSettings = db.prepare('SELECT weixin_sync_buf FROM user_settings WHERE user_id = ?').get(userId) as any;
    assert.equal(savedSettings.weixin_sync_buf, 'sync-cursor-42');

    // Simulated restart recovery loads uncompleted inbox items
    const recovered = listPendingWeixinInboxItems(userId);
    assert.equal(recovered.length, 2);
    assert.equal(recovered[0].text, '明天上午写方案 60分钟');
  });

  it('enforces webhook sender binding, duplicate msgId idempotency, and conflicting msgId 409 (M02, M08)', async () => {
    setLlmExecutorForTest(async () => ({
      content: JSON.stringify({
        intent: 'create_task',
        title: '客户电话跟进',
        duration_minutes: 30,
        time_mode: 'flexible',
        importance_tier: 'support',
      }),
    }));
    setOutboundSenderForTest(async () => ({ outcome: 'sent', channel: 'webhook_outbound', providerMsgId: 'mock-out-1' }));

    const tokenRow = db.prepare('SELECT clawbot_webhook_token FROM user_settings WHERE user_id = ?').get(userId) as any;

    // 1. Wrong sender rejected (seedTestUser set clawbot_to_wxid = 'wxid_test_1')
    const wrongSenderMock = createMockResponse();
    await handleClawbotWebhook(
      {
        params: { token: tokenRow.clawbot_webhook_token },
        body: { fromUser: 'attacker_wxid', content: '删除所有任务', msgId: 'wh-1' },
      } as any,
      wrongSenderMock.res
    );
    assert.equal(wrongSenderMock.getStatus(), 403);

    // 2. Valid message succeeds and creates exactly 1 task
    const okMock = createMockResponse();
    await handleClawbotWebhook(
      {
        params: { token: tokenRow.clawbot_webhook_token },
        body: { fromUser: 'wxid_test_1', content: '提醒我跟进客户 30分钟', msgId: 'wh-msg-100' },
      } as any,
      okMock.res
    );
    assert.equal(okMock.getStatus(), 200);
    assert.equal((db.prepare('SELECT COUNT(*) as c FROM tasks WHERE user_id = ?').get(userId) as any).c, 1);

    // 3. Replaying same msgId + same payload returns cached duplicate without inserting a second task
    const replayMock = createMockResponse();
    await handleClawbotWebhook(
      {
        params: { token: tokenRow.clawbot_webhook_token },
        body: { fromUser: 'wxid_test_1', content: '提醒我跟进客户 30分钟', msgId: 'wh-msg-100' },
      } as any,
      replayMock.res
    );
    assert.equal(replayMock.getStatus(), 200);
    assert.equal(replayMock.getBody().duplicate, true);
    assert.equal((db.prepare('SELECT COUNT(*) as c FROM tasks WHERE user_id = ?').get(userId) as any).c, 1);

    // 4. Reusing same msgId with conflicting payload returns 409 Conflict
    const conflictMock = createMockResponse();
    await handleClawbotWebhook(
      {
        params: { token: tokenRow.clawbot_webhook_token },
        body: { fromUser: 'wxid_test_1', content: '完全不同的指令', msgId: 'wh-msg-100' },
      } as any,
      conflictMock.res
    );
    assert.equal(conflictMock.getStatus(), 409);
  });

  it('executes command on first Weixin activation instead of dropping it and blocks wrong sender (M05, M08)', async () => {
    db.prepare("UPDATE user_settings SET weixin_user_id = 'wx-owner-1', weixin_activated = 0 WHERE user_id = ?").run(
      userId
    );
    setLlmExecutorForTest(async () => ({
      content: JSON.stringify({
        intent: 'create_task',
        title: '首条激活任务',
        duration_minutes: 40,
        time_mode: 'flexible',
        importance_tier: 'support',
      }),
    }));

    const mismatched = await processWeChatMessage(userId, '添加测试', 'wx-stranger');
    assert.equal(mismatched.diagnostics?.rejectedSenderMismatch, true);
    assert.equal((db.prepare('SELECT COUNT(*) as c FROM tasks WHERE user_id = ?').get(userId) as any).c, 0);

    const firstMsg = await processWeChatMessage(userId, '帮我安排首条激活任务 40分钟', 'wx-owner-1');
    assert.ok(firstMsg.replyText.includes('首条激活任务'));
    assert.equal((db.prepare('SELECT COUNT(*) as c FROM tasks WHERE user_id = ?').get(userId) as any).c, 1);
    const s = db.prepare('SELECT weixin_activated FROM user_settings WHERE user_id = ?').get(userId) as any;
    assert.equal(s.weixin_activated, 1);
  });

  it('delivers outbox notifications without forcing in_progress and handles failed/unknown/cancel states (C02, C03)', async () => {
    const startIso = wallClockIso(tomorrowKey, 10, 0);
    const endIso = wallClockIso(tomorrowKey, 11, 0);
    const created = await createTaskCommand({
      userId,
      rawInput: {
        title: '出箱测试任务',
        is_fixed: true,
        scheduled_start: startIso,
        scheduled_end: endIso,
        duration_minutes: 60,
      },
    });
    assert.equal(created.success, true);

    const outboxRows = db
      .prepare("SELECT * FROM notification_outbox WHERE user_id = ? AND status = 'pending' ORDER BY scheduled_fire_at ASC")
      .all(userId) as any[];
    assert.equal(outboxRows.length, 1); // Start-only pure reminder; no end check-in reminder
    const startNotif = outboxRows.find(r => r.reminder_type === 'start');
    assert.ok(startNotif);
    assert.equal(outboxRows.some(r => r.reminder_type === 'end'), false);

    // 1. Deliver start notification at its fire time -> outcome 'sent', instance MUST remain 'pending'
    let outcomeToReturn: 'sent' | 'failed' | 'unknown' = 'sent';
    const sentMessages: string[] = [];
    setOutboundSenderForTest(async (_s, msg) => {
      sentMessages.push(msg);
      return {
        outcome: outcomeToReturn,
        channel: 'webhook_outbound',
        providerMsgId: outcomeToReturn === 'sent' ? 'msg-sent-1' : undefined,
        error: outcomeToReturn === 'sent' ? undefined : `err-${outcomeToReturn}`,
      };
    });

    const startFireNow = new Date(new Date(startNotif.scheduled_fire_at).getTime() + 1000);
    const res1 = await processOutboxNotifications(startFireNow, 'test-worker-1');
    assert.equal(res1.sent, 1);
    assert.equal(sentMessages[0].includes('请回复「开始」'), false);

    const instAfterSent = db.prepare('SELECT status FROM task_instances WHERE id = ?').get(startNotif.instance_id) as any;
    assert.equal(instAfterSent.status, 'pending'); // Never forced to in_progress

    // 2. Deliver another task's notification with 'unknown' outcome -> recorded unknown and not reclaimed blindly
    const tUnknown = await createTaskCommand({
      userId,
      rawInput: {
        title: '未知回执测试任务',
        is_fixed: true,
        scheduled_start: wallClockIso(tomorrowKey, 12, 0),
        scheduled_end: wallClockIso(tomorrowKey, 13, 0),
        duration_minutes: 60,
      },
    });
    assert.equal(tUnknown.success, true);
    const unknownNotif = db
      .prepare("SELECT * FROM notification_outbox WHERE user_id = ? AND status = 'pending' ORDER BY scheduled_fire_at ASC LIMIT 1")
      .get(userId) as any;
    outcomeToReturn = 'unknown';
    const unknownFireNow = new Date(new Date(unknownNotif.scheduled_fire_at).getTime() + 1000);
    const res2 = await processOutboxNotifications(unknownFireNow, 'test-worker-1');
    assert.equal(res2.unknown, 1);
    const res2Again = await processOutboxNotifications(new Date(unknownFireNow.getTime() + 120_000), 'test-worker-1');
    assert.equal(res2Again.processed, 0);

    // 3. Create another task, fail once -> marks failed with backoff, then completing instance cancels it
    const t2 = await createTaskCommand({
      userId,
      rawInput: {
        title: '撤销测试任务',
        is_fixed: true,
        scheduled_start: wallClockIso(tomorrowKey, 14, 0),
        scheduled_end: wallClockIso(tomorrowKey, 15, 0),
        duration_minutes: 60,
      },
    });
    const t2Notif = db
      .prepare("SELECT * FROM notification_outbox WHERE user_id = ? AND status = 'pending' ORDER BY scheduled_fire_at ASC LIMIT 1")
      .get(userId) as any;
    outcomeToReturn = 'failed';
    const failRes = await processOutboxNotifications(new Date(new Date(t2Notif.scheduled_fire_at).getTime() + 1000));
    assert.equal(failRes.failed, 1);

    // Complete task -> remaining pending/failed notifications get cancelled
    executeInstanceProgressCommand({ userId, taskId: t2.task!.id, action: 'complete' });
    const activeLeft = (
      db
        .prepare("SELECT COUNT(*) as c FROM notification_outbox WHERE instance_id = ? AND status IN ('pending', 'failed')")
        .get(t2Notif.instance_id) as any
    ).c;
    assert.equal(activeLeft, 0);
  });

  it('merges RRULE/EXDATE/RECURRENCE-ID/CANCELLED/TRANSPARENT, keeps snapshot on error, and honors ignored instances (C01, C04)', async () => {
    const subInfo = db
      .prepare("INSERT INTO calendar_subscriptions (user_id, name, url) VALUES (?, '公司日历', 'https://cal.example/ics')")
      .run(userId);
    const sub = db.prepare('SELECT * FROM calendar_subscriptions WHERE id = ?').get(subInfo.lastInsertRowid) as any;

    const occ1 = new Date(`${tomorrowKey}T09:00:00+08:00`);
    const occ2 = new Date(occ1.getTime() + 86_400_000);
    const occ3 = new Date(occ1.getTime() + 2 * 86_400_000);
    const occ2RescheduledStart = new Date(occ2.getTime() + 2 * 3600_000); // shifted from 09:00 to 11:00
    const occ2RescheduledEnd = new Date(occ2RescheduledStart.getTime() + 3600_000);

    setCalendarFetcherForTest(async () => ({
      master1: {
        type: 'VEVENT',
        uid: 'rec-standup',
        summary: '每日站会',
        start: occ1,
        end: new Date(occ1.getTime() + 1800_000),
        rrule: {
          between: () => [occ1, occ2, occ3],
        },
        exdate: {
          ex3: occ3, // occ3 excluded via EXDATE
        },
      },
      override2: {
        type: 'VEVENT',
        uid: 'rec-standup',
        summary: '每日站会(改期)',
        recurrenceid: occ2,
        start: occ2RescheduledStart,
        end: occ2RescheduledEnd,
      },
      transparentEvt: {
        type: 'VEVENT',
        uid: 'free-fyi',
        summary: '同事休假提醒(不占用)',
        start: new Date(occ1.getTime() + 3 * 3600_000),
        end: new Date(occ1.getTime() + 5 * 3600_000),
        transparency: 'TRANSPARENT',
      },
    }));

    const sync1 = await syncSubscription(sub);
    assert.equal(sync1.changed, true);
    assert.equal(sync1.count, 3); // occ1 + rescheduled occ2 + transparentEvt (occ3 excluded)

    // Only OPAQUE CONFIRMED events block scheduling
    const rangeStart = new Date(occ1.getTime() - 3600_000).toISOString();
    const rangeEnd = new Date(occ3.getTime() + 86_400_000).toISOString();
    const busy = getActiveExternalBusyEvents(userId, rangeStart, rangeEnd);
    assert.equal(busy.length, 2); // occ1 & rescheduled occ2; transparentEvt excluded!

    // Ignore occ1 and resync -> ignored instance stays suppressed
    const occ1Row = db
      .prepare("SELECT id FROM external_events WHERE user_id = ? AND uid = 'rec-standup' AND recurrence_id IS NULL")
      .get(userId) as any;
    ignoreExternalCalendarInstance(userId, occ1Row.id);

    const subAfterIgnore = db.prepare('SELECT * FROM calendar_subscriptions WHERE id = ?').get(sub.id) as any;
    setCalendarFetcherForTest(async () => ({
      broken: {
        type: 'VEVENT',
        uid: 'broken-rrule',
        summary: '坏规则事件',
        start: occ1,
        rrule: {
          between: () => {
            throw new Error('Invalid RRULE');
          },
        },
      },
    }));

    await assert.rejects(() => syncSubscription(subAfterIgnore), /Invalid RRULE/);

    // Previous generation & events stayed intact and ignored instance stays filtered
    const busyAfterFail = getActiveExternalBusyEvents(userId, rangeStart, rangeEnd);
    assert.equal(busyAfterFail.length, 1); // only rescheduled occ2 remains active!
    assert.equal(busyAfterFail[0].title, '每日站会(改期)');
  });
});
