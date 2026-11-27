import crypto from 'crypto';
import { Request, Response } from 'express';
import { db } from '../config/database.js';
import { UserSettings } from '../models/types.js';
import { sendClawbotMessageWithReceipt } from '../services/clawbot.js';
import { checkAccountEligibility } from '../services/accountService.js';
import { claimCommandInbox, completeCommandInbox, failCommandInbox } from '../services/inboxService.js';
import { processNaturalLanguageCommand } from '../services/nlCommandService.js';

export async function handleClawbotWebhook(req: Request, res: Response): Promise<void> {
  const { token } = req.params;

  if (!token) {
    res.status(401).json({ error: '缺少 Webhook Token' });
    return;
  }

  // 1. Locate user by webhook token
  const settings = db
    .prepare('SELECT * FROM user_settings WHERE clawbot_webhook_token = ?')
    .get(token) as UserSettings | undefined;
  if (!settings) {
    res.status(401).json({ error: '无效的 Webhook Token' });
    return;
  }

  const userId = settings.user_id;

  // 2. Unified account eligibility check (A02)
  const elig = checkAccountEligibility(userId);
  if (!elig.eligible) {
    res.status(403).json({ success: false, error: elig.message || '账号已被封禁或无权限' });
    return;
  }

  // 3. Extract content & validate sender binding (M08)
  const body = req.body || {};
  const content = (body.content || body.text || body.message || body.msg || '').toString().trim();
  const fromWxid = body.fromUser || body.wxid || body.from || body.sender
    ? String(body.fromUser || body.wxid || body.from || body.sender).trim()
    : '';

  if (settings.clawbot_to_wxid && fromWxid && settings.clawbot_to_wxid !== fromWxid) {
    res.status(403).json({ success: false, error: '发件人与已绑定微信身份不匹配' });
    return;
  }

  if (fromWxid && !settings.clawbot_to_wxid) {
    db.prepare('UPDATE user_settings SET clawbot_to_wxid = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(
      fromWxid,
      userId
    );
    settings.clawbot_to_wxid = fromWxid;
  }

  if (!content) {
    res.json({ success: true, reply: '收到空消息' });
    return;
  }

  // 4. Deduplicate via command_inbox (M02)
  const upstreamMsgId = body.msgId || body.msg_id || body.messageId || body.id;
  const hasUpstreamId = Boolean(upstreamMsgId && String(upstreamMsgId).trim());
  const externalMsgId = hasUpstreamId
    ? `wh:${String(upstreamMsgId).trim()}`
    : `wh:fallback:${crypto.createHash('sha256').update(`${userId}:${fromWxid}:${content}`).digest('hex').slice(0, 24)}`;

  const claim = claimCommandInbox({
    userId,
    channel: 'webhook',
    channelAccountId: String(token),
    senderId: fromWxid || 'webhook',
    externalMsgId,
    idempotencyKey: hasUpstreamId ? String(upstreamMsgId).trim() : null,
    payload: { sender: fromWxid, content },
  });

  if (claim.kind === 'conflict') {
    res.status(409).json({ success: false, error: claim.message });
    return;
  }
  if (claim.kind === 'duplicate_completed') {
    res.json({ ...(claim.response || {}), duplicate: true });
    return;
  }
  if (claim.kind === 'duplicate_processing') {
    res.status(202).json({ success: true, processing: true, reply: '消息正在处理中，请稍候' });
    return;
  }

  try {
    const result = await processNaturalLanguageCommand({
      userId,
      channel: 'webhook',
      senderId: fromWxid || 'webhook',
      content,
      settings,
      skipImages: true,
    });

    // Attempt outbound push ONLY when explicit outbound URL is configured or pushToWeixin is requested
    let outboundOutcome: string = 'skipped';
    if (
      (settings.clawbot_outbound_url && settings.clawbot_outbound_url.trim()) ||
      Boolean(body.pushToWeixin)
    ) {
      const receipt = await sendClawbotMessageWithReceipt(settings, result.replyText, externalMsgId);
      outboundOutcome = receipt.outcome;
    }

    const responseBody = {
      success: true,
      reply: result.replyText,
      outboundOutcome,
      hasUpstreamMsgId: hasUpstreamId,
      diagnostics: result.diagnostics,
    };
    completeCommandInbox(claim.inboxId, responseBody);
    res.json(responseBody);
  } catch (err: any) {
    console.error('[Webhook Processing Error]:', err);
    failCommandInbox(claim.inboxId, err.message || '处理异常');
    const errReply = `⚠️ 助手处理出错：${err.message}`;
    res.status(500).json({
      success: false,
      error: err.message,
      reply: errReply,
    });
  }
}
