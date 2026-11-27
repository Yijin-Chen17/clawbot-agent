import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../config/database.js';
import { setupIsolatedTestEnv, seedTestUser, wallClockIso } from '../testHelpers/testDb.js';
import {
  claimDueWeixinReplies,
  claimWeixinInboxItem,
  completeCommandInbox,
  enqueueWeixinReply,
  getActiveConversationDraft,
  listPendingWeixinInboxItems,
  markWeixinReplyFailed,
  markWeixinReplySent,
  persistWeixinPollBatch,
} from './inboxService.js';
import { processNaturalLanguageCommand } from './nlCommandService.js';
import { checkWeixinProactiveEligibility } from './clawbot.js';
import { processExternalOutboxNotifications, syncExternalNotificationOutboxForUser } from './externalOutboxService.js';
import { setLlmExecutorForTest } from './llm.js';
import { createTaskCommand } from './taskService.js';
import { getAccountLocalDateKey } from '../utils/timezone.js';
import type { UserSettings } from '../models/types.js';

describe('Weixin Messaging Reliability & Scoped Interaction Sessions', () => {
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

  it('uses single-row command_inbox claim and recovers stale processing items without deadlock', () => {
    const ids = persistWeixinPollBatch({
      userId,
      botId: 'bot-1',
      nextSyncBuf: 'buf-1',
      items: [{ externalMsgId: 'wx-100', senderId: 'u-1', text: '查看任务', contextToken: 'ctx-1' }],
    });
    assert.equal(ids.length, 1);

    assert.equal(claimWeixinInboxItem(ids[0], 90), 'claimed');
    // Actively processing -> skipped
    assert.equal(claimWeixinInboxItem(ids[0], 90), 'skip');

    // Simulate crash leaving row in 'processing' for > 90s
    db.prepare("UPDATE command_inbox SET updated_at = datetime('now', '-120 seconds') WHERE id = ?").run(ids[0]);
    const recovered = listPendingWeixinInboxItems(userId);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].inboxId, ids[0]);
    assert.equal(claimWeixinInboxItem(ids[0], 90), 'claimed');

    completeCommandInbox(ids[0], { replyText: 'ok' });
    assert.equal(claimWeixinInboxItem(ids[0], 90), 'skip');
  });

  it('tracks text_sent and image_sent separately in weixin_reply_outbox for safe retries', () => {
    const replyId = enqueueWeixinReply({
      userId,
      toUserId: 'wx-user-1',
      contextToken: 'ctx-abc',
      textContent: '📅 日历已更新 👇',
      imageKind: 'week_calendar',
    });

    const claimed1 = claimDueWeixinReplies('worker-1', new Date(), 10, 45);
    assert.equal(claimed1.length, 1);
    assert.equal(claimed1[0].text_sent, 0);
    assert.equal(claimed1[0].image_sent, 0);

    // Simulate text succeeded, image failed -> retry keeps text_sent = 1
    markWeixinReplyFailed({
      replyId,
      errorMessage: 'CDN upload timeout',
      textSent: true,
      imageSent: false,
    });

    // Make retry immediately due for test
    db.prepare("UPDATE weixin_reply_outbox SET next_retry_at = datetime('now', '-5 seconds') WHERE id = ?").run(replyId);
    const claimed2 = claimDueWeixinReplies('worker-1', new Date(), 10, 45);
    assert.equal(claimed2.length, 1);
    assert.equal(claimed2[0].text_sent, 1);
    assert.equal(claimed2[0].image_sent, 0);

    markWeixinReplySent(replyId, 'msg-img-1', true, true);
    const finalRow = db.prepare('SELECT status, text_sent, image_sent FROM weixin_reply_outbox WHERE id = ?').get(replyId) as any;
    assert.equal(finalRow.status, 'sent');
    assert.equal(finalRow.text_sent, 1);
    assert.equal(finalRow.image_sent, 1);
  });

  it('skips external AI LLM generation when WeChat proactive delivery window is expired or missing context_token', async () => {
    db.prepare(`
      UPDATE user_settings
      SET clawbot_outbound_url = '',
          weixin_connected = 1,
          weixin_bot_token = 'bot-tok',
          weixin_user_id = 'wx-u-1',
          weixin_context_token = '',
          weixin_last_active_at = ?
      WHERE user_id = ?
    `).run(new Date(Date.now() - 26 * 3600_000).toISOString(), userId);

    const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings;
    const elig = checkWeixinProactiveEligibility(settings, new Date());
    assert.equal(elig.ok, false);

    let llmCalled = 0;
    setLlmExecutorForTest(async () => {
      llmCalled++;
      return { content: 'AI 提醒' };
    });

    const startIso = new Date(Date.now() + 3 * 60_000).toISOString();
    const endIso = new Date(Date.now() + 63 * 60_000).toISOString();
    db.prepare(`
      INSERT INTO external_events (user_id, uid, title, start_time, end_time, status, transparency)
      VALUES (?, 'ext-due-1', '高等数学', ?, ?, 'CONFIRMED', 'OPAQUE')
    `).run(userId, startIso, endIso);

    syncExternalNotificationOutboxForUser(userId, new Date());
    const res = await processExternalOutboxNotifications(new Date(), 'test-ext-worker');
    assert.equal(res.failed, 1);
    assert.equal(llmCalled, 0);
  });

  it('runs scoped create_task multi-turn fill (duration & cancel) and auto-closes context on completion', async () => {
    const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings;
    let llmCalls = 0;
    setLlmExecutorForTest(async () => {
      llmCalls++;
      return {
        content: JSON.stringify({
          intent: 'create_task',
          title: '写季度总结',
          time_mode: 'flexible',
        }),
      };
    });

    // Turn 1: missing duration -> opens scoped create_task session
    const t1 = await processNaturalLanguageCommand({
      userId,
      channel: 'weixin_ilink',
      senderId: 'wx-u-1',
      content: '帮我安排写季度总结',
      settings,
      skipImages: true,
    });
    assert.ok(t1.replyText.includes('预计耗时'));
    assert.ok(getActiveConversationDraft(userId, 'weixin_ilink', 'weixin_ilink:wx-u-1'));

    // Turn 2: fast duration reply without needing extra LLM call -> creates task and auto-closes draft
    const t2 = await processNaturalLanguageCommand({
      userId,
      channel: 'weixin_ilink',
      senderId: 'wx-u-1',
      content: '1.5小时',
      settings,
      skipImages: true,
    });
    assert.equal(llmCalls, 1);
    assert.ok(t2.replyText.includes('写季度总结'));
    assert.ok(t2.replyText.includes('90分钟'));
    assert.equal(getActiveConversationDraft(userId, 'weixin_ilink', 'weixin_ilink:wx-u-1'), null);

    // Turn 3: another missing-field task cancelled with "算了" -> auto-closes without creating or cancelling tasks
    const t3 = await processNaturalLanguageCommand({
      userId,
      channel: 'weixin_ilink',
      senderId: 'wx-u-1',
      content: '安排写周报',
      settings,
      skipImages: true,
    });
    assert.ok(t3.replyText.includes('预计耗时'));
    assert.ok(getActiveConversationDraft(userId, 'weixin_ilink', 'weixin_ilink:wx-u-1'));

    const t4 = await processNaturalLanguageCommand({
      userId,
      channel: 'weixin_ilink',
      senderId: 'wx-u-1',
      content: '算了',
      settings,
      skipImages: true,
    });
    assert.ok(t4.replyText.includes('已取消'));
    assert.equal(getActiveConversationDraft(userId, 'weixin_ilink', 'weixin_ilink:wx-u-1'), null);
  });

  it('supports scoped disambiguation session ("1"/"2") and auto-closes after resolving target', async () => {
    const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings;
    await createTaskCommand({
      userId,
      rawInput: { title: '项目周会A', duration_minutes: 30, time_mode: 'flexible' },
    });
    await createTaskCommand({
      userId,
      rawInput: { title: '项目周会B', duration_minutes: 45, time_mode: 'flexible' },
    });

    setLlmExecutorForTest(async () => ({
      content: JSON.stringify({
        intent: 'delete_item',
        delete_target: { type: 'task', name: '项目周会' },
      }),
    }));

    const r1 = await processNaturalLanguageCommand({
      userId,
      channel: 'weixin_ilink',
      senderId: 'wx-u-1',
      content: '删除项目周会',
      settings,
      skipImages: true,
    });
    assert.ok(r1.replyText.includes('1.'));
    assert.ok(r1.replyText.includes('2.'));
    const draft = getActiveConversationDraft(userId, 'weixin_ilink', 'weixin_ilink:wx-u-1');
    assert.equal(draft?.intent, 'disambiguate_target');

    // Reply "2" -> deletes candidate #2 and auto-closes session
    const r2 = await processNaturalLanguageCommand({
      userId,
      channel: 'weixin_ilink',
      senderId: 'wx-u-1',
      content: '2',
      settings,
      skipImages: true,
    });
    assert.ok(r2.replyText.includes('已删除任务'));
    assert.equal(getActiveConversationDraft(userId, 'weixin_ilink', 'weixin_ilink:wx-u-1'), null);
    const remaining = db.prepare('SELECT title FROM tasks WHERE user_id = ?').all(userId) as Array<{ title: string }>;
    assert.equal(remaining.length, 1);
  });

  it('does not hijack compound sentences with exact quick triggers and executes extra_actions', async () => {
    const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings;
    await createTaskCommand({
      userId,
      rawInput: { title: '旧会议', duration_minutes: 30, time_mode: 'flexible' },
    });

    setLlmExecutorForTest(async () => ({
      content: JSON.stringify({
        intent: 'delete_item',
        delete_target: { type: 'task', name: '旧会议' },
        extra_actions: [
          {
            intent: 'create_task',
            title: '新代码评审',
            duration_minutes: 45,
            time_mode: 'flexible',
          },
        ],
      }),
    }));

    const res = await processNaturalLanguageCommand({
      userId,
      channel: 'weixin_ilink',
      senderId: 'wx-u-1',
      content: '查看任务后把旧会议删掉，再安排新代码评审45分钟',
      settings,
      skipImages: true,
    });
    assert.ok(res.replyText.includes('已删除任务「旧会议」'));
    assert.ok(res.replyText.includes('新代码评审'));
  });

  it('shows full new times when recomputing a stale schedule proposal and reports free windows on query_schedule', async () => {
    const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings;
    const tLow = await createTaskCommand({
      userId,
      rawInput: {
        title: '原有低优任务',
        duration_minutes: 60,
        time_mode: 'flexible',
        importance_tier: 'minor',
        importance: 30,
        urgency: 40,
      },
    });
    assert.equal(tLow.success, true);

    setLlmExecutorForTest(async () => ({
      content: JSON.stringify({
        intent: 'query_schedule',
        target_date: tomorrowKey,
      }),
    }));
    const qRes = await processNaturalLanguageCommand({
      userId,
      channel: 'weixin_ilink',
      senderId: 'wx-u-1',
      content: '明天日程',
      settings,
      skipImages: true,
    });
    assert.ok(qRes.replyText.includes(tomorrowKey));
    assert.ok(qRes.replyText.includes('当日可用空闲'));

    // Also test stale proposal recompute display via create_task proposal flow
    // Block tomorrow 09:00-10:00 with a fixed task to force proposal or create a conflicting swap proposal
    const lowStart = wallClockIso(tomorrowKey, 9, 0);
    const lowEnd = wallClockIso(tomorrowKey, 10, 0);
    const { upsertConversationDraft } = await import('./inboxService.js');
    const { createScheduleProposal } = await import('./proposalService.js');
    const { getLatestPlanVersion, ensureTaskInstance } = await import('./instanceService.js');
    const conflictInst = ensureTaskInstance(userId, tLow.task!.id, tomorrowKey)!;
    const propRec = createScheduleProposal({
      userId,
      basePlanVersion: Math.max(0, getLatestPlanVersion(userId) - 1), // stale plan version triggers recompute!
      reasonType: 'priority_gain',
      reasonText: '优先级更高',
      payload: {
        newTaskSpec: {
          title: '高优汇报',
          duration_minutes: 60,
          urgency: 90,
          importance: 95,
          time_mode: 'deadline',
          deadline: wallClockIso(tomorrowKey, 12, 0),
          deadline_kind: 'hard',
        },
        proposal: {
          type: 'priority_gain',
          conflictTask: {
            id: tLow.task!.id,
            title: tLow.task!.title,
            scheduled_start: lowStart,
            scheduled_end: lowEnd,
            duration_minutes: 60,
            urgency: 40,
            importance: 30,
            deadline: null,
          },
          reasonText: '优先级更高',
          newTaskSchedule: { start: lowStart, end: lowEnd },
          conflictTaskSchedule: {
            start: wallClockIso(tomorrowKey, 10, 10),
            end: wallClockIso(tomorrowKey, 11, 10),
          },
        },
        conflictInstanceId: conflictInst.id,
        conflictInstanceVersion: conflictInst.version,
      },
    });

    upsertConversationDraft({
      userId,
      channel: 'weixin_ilink',
      threadKey: 'weixin_ilink:wx-u-1',
      intent: 'confirm_schedule_swap',
      draftData: {
        sessionType: 'confirm_schedule_swap',
        proposalId: propRec.id,
        newTaskTitle: '高优汇报',
        proposal: JSON.parse(propRec.payload_json).proposal,
      },
      ttlMinutes: 15,
    });

    const confirmRes = await processNaturalLanguageCommand({
      userId,
      channel: 'weixin_ilink',
      senderId: 'wx-u-1',
      content: '确认',
      settings,
      skipImages: true,
    });
    assert.ok(
      confirmRes.replyText.includes('建议调整方案') || confirmRes.replyText.includes('原提案已失效'),
      `Unexpected reply: ${confirmRes.replyText}`
    );
    if (confirmRes.replyText.includes('最新日程调整建议')) {
      assert.ok(confirmRes.replyText.includes('高优汇报'));
      assert.ok(confirmRes.replyText.includes('同步修改至'));
    }
  });
});
