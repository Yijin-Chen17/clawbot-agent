import crypto from 'crypto';
import { db } from '../config/database.js';
import type { CommandInboxRecord, ConversationDraft, WeixinReplyOutboxRecord } from '../models/types.js';

export function hashCommandPayload(payload: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
}

export type ClaimInboxResult =
  | { kind: 'claimed'; inboxId: number }
  | { kind: 'duplicate_completed'; response: any; inboxId: number }
  | { kind: 'duplicate_processing'; inboxId: number }
  | { kind: 'conflict'; message: string };

/**
 * 幂等命令入箱（M02, M08）：
 * 按 (user_id, channel, external_msg_id) 或 (user_id, channel, idempotency_key) 去重。
 */
export function claimCommandInbox(params: {
  userId: number;
  channel: CommandInboxRecord['channel'];
  channelAccountId?: string;
  senderId?: string;
  externalMsgId: string;
  idempotencyKey?: string | null;
  payload: unknown;
}): ClaimInboxResult {
  const payloadHash = hashCommandPayload(params.payload);
  const channelAccountId = params.channelAccountId || '';
  const senderId = params.senderId || '';
  const idempotencyKey = params.idempotencyKey || null;

  return db.transaction(() => {
    let existing: CommandInboxRecord | undefined;
    if (idempotencyKey) {
      existing = db
        .prepare('SELECT * FROM command_inbox WHERE user_id = ? AND channel = ? AND idempotency_key = ?')
        .get(params.userId, params.channel, idempotencyKey) as CommandInboxRecord | undefined;
    }
    if (!existing) {
      existing = db
        .prepare('SELECT * FROM command_inbox WHERE user_id = ? AND channel = ? AND external_msg_id = ?')
        .get(params.userId, params.channel, params.externalMsgId) as CommandInboxRecord | undefined;
    }

    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        return { kind: 'conflict', message: '重复的幂等键携带了不同的请求载荷' } as ClaimInboxResult;
      }
      if (existing.status === 'completed') {
        let parsed: any = null;
        try {
          parsed = existing.response_json ? JSON.parse(existing.response_json) : null;
        } catch {}
        return { kind: 'duplicate_completed', response: parsed, inboxId: existing.id } as ClaimInboxResult;
      }
      if (existing.status === 'processing') {
        return { kind: 'duplicate_processing', inboxId: existing.id } as ClaimInboxResult;
      }
      // 'received' or 'failed': re-claim for execution
      db.prepare(`
        UPDATE command_inbox
        SET status = 'processing', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(existing.id);
      return { kind: 'claimed', inboxId: existing.id } as ClaimInboxResult;
    }

    const res = db.prepare(`
      INSERT INTO command_inbox (
        user_id, channel, channel_account_id, sender_id,
        external_msg_id, idempotency_key, payload_hash, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')
    `).run(
      params.userId,
      params.channel,
      channelAccountId,
      senderId,
      params.externalMsgId,
      idempotencyKey,
      payloadHash
    );

    return { kind: 'claimed', inboxId: Number(res.lastInsertRowid) } as ClaimInboxResult;
  })();
}

export function completeCommandInbox(inboxId: number, response: unknown): void {
  db.prepare(`
    UPDATE command_inbox
    SET status = 'completed', response_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(response ?? {}), inboxId);
}

export function failCommandInbox(inboxId: number, errorMessage: string): void {
  db.prepare(`
    UPDATE command_inbox
    SET status = 'failed', response_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify({ error: errorMessage }), inboxId);
}

export interface WeixinInboundItem {
  externalMsgId: string;
  senderId: string;
  text: string;
  contextToken?: string;
  nonTextTypes?: number[];
}

/**
 * 扫码微信长轮询事务提交（M02）：
 * 在同一事务中把整批消息持久化到 command_inbox，再推进 weixin_sync_buf。
 */
export function persistWeixinPollBatch(params: {
  userId: number;
  botId: string;
  nextSyncBuf?: string | null;
  items: WeixinInboundItem[];
}): number[] {
  return db.transaction(() => {
    const insertedInboxIds: number[] = [];

    for (const item of params.items) {
      const payloadHash = hashCommandPayload({
        senderId: item.senderId,
        text: item.text,
        nonTextTypes: item.nonTextTypes || null,
      });
      const existing = db
        .prepare('SELECT id FROM command_inbox WHERE user_id = ? AND channel = ? AND external_msg_id = ?')
        .get(params.userId, 'weixin_ilink', item.externalMsgId) as { id: number } | undefined;

      if (existing) continue;

      const info = db.prepare(`
        INSERT INTO command_inbox (
          user_id, channel, channel_account_id, sender_id,
          external_msg_id, idempotency_key, payload_hash, status, response_json
        ) VALUES (?, 'weixin_ilink', ?, ?, ?, ?, ?, 'received', ?)
      `).run(
        params.userId,
        params.botId,
        item.senderId,
        item.externalMsgId,
        item.externalMsgId,
        payloadHash,
        JSON.stringify({
          text: item.text,
          contextToken: item.contextToken || null,
          nonTextTypes: item.nonTextTypes || undefined,
        })
      );
      insertedInboxIds.push(Number(info.lastInsertRowid));
    }

    if (params.nextSyncBuf !== undefined && params.nextSyncBuf !== null) {
      db.prepare('UPDATE user_settings SET weixin_sync_buf = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?').run(
        params.nextSyncBuf,
        params.userId
      );
    }

    return insertedInboxIds;
  })();
}

export function listPendingWeixinInboxItems(userId: number): Array<{
  inboxId: number;
  senderId: string;
  text: string;
  contextToken?: string | null;
  nonTextTypes?: number[];
}> {
  // Reclaim any items stuck in 'processing' for > 90s (e.g. crash recovery)
  db.prepare(`
    UPDATE command_inbox
    SET status = 'received', updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
      AND channel = 'weixin_ilink'
      AND status = 'processing'
      AND updated_at <= datetime('now', '-90 seconds')
  `).run(userId);

  const rows = db.prepare(`
    SELECT id, sender_id, response_json
    FROM command_inbox
    WHERE user_id = ? AND channel = 'weixin_ilink' AND status = 'received'
    ORDER BY id ASC
  `).all(userId) as Array<{ id: number; sender_id: string; response_json: string | null }>;

  return rows.map(r => {
    let payload: any = {};
    try {
      payload = r.response_json ? JSON.parse(r.response_json) : {};
    } catch {}
    return {
      inboxId: r.id,
      senderId: r.sender_id,
      text: String(payload.text || ''),
      contextToken: payload.contextToken || null,
      nonTextTypes: Array.isArray(payload.nonTextTypes) ? payload.nonTextTypes : undefined,
    };
  });
}

/**
 * 原子认领单条微信入箱消息（单记录状态机：received/failed/stale-processing -> processing）
 */
export function claimWeixinInboxItem(inboxId: number, staleSeconds: number = 90): 'claimed' | 'skip' {
  return db.transaction(() => {
    const row = db
      .prepare('SELECT id, status, updated_at FROM command_inbox WHERE id = ?')
      .get(inboxId) as { id: number; status: string; updated_at: string } | undefined;
    if (!row) return 'skip';
    if (row.status === 'completed') return 'skip';
    if (row.status === 'processing') {
      const stale = db
        .prepare("SELECT 1 as ok FROM command_inbox WHERE id = ? AND updated_at <= datetime('now', ?)")
        .get(inboxId, `-${Math.max(10, staleSeconds)} seconds`) as { ok: number } | undefined;
      if (!stale) return 'skip';
    }
    const res = db
      .prepare("UPDATE command_inbox SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(inboxId);
    return res.changes > 0 ? 'claimed' : 'skip';
  })();
}

// ==================== 微信回复发件箱（可靠投递与部分重试） ====================

export function enqueueWeixinReply(params: {
  userId: number;
  inboxId?: number | null;
  toUserId: string;
  contextToken?: string | null;
  textContent: string;
  imageKind?: 'week_calendar' | 'todo_list' | null;
  imageBase64?: string | null;
  ttlHours?: number;
}): number {
  const expiresAt = new Date(Date.now() + (params.ttlHours ?? 24) * 3600_000).toISOString();
  const info = db
    .prepare(
      `INSERT INTO weixin_reply_outbox (
        user_id, inbox_id, channel, to_user_id, context_token,
        text_content, image_kind, image_base64, text_sent, image_sent,
        status, expires_at
      ) VALUES (?, ?, 'weixin_ilink', ?, ?, ?, ?, ?, 0, ?, 'pending', ?)`
    )
    .run(
      params.userId,
      params.inboxId ?? null,
      params.toUserId,
      params.contextToken || null,
      params.textContent,
      params.imageKind || null,
      params.imageBase64 || null,
      params.imageKind || params.imageBase64 ? 0 : 1,
      expiresAt
    );
  return Number(info.lastInsertRowid);
}

export function claimSingleWeixinReply(
  replyId: number,
  leaseOwner: string,
  leaseSeconds: number = 45
): WeixinReplyOutboxRecord | null {
  const nowIso = new Date().toISOString();
  const leaseUntilIso = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT * FROM weixin_reply_outbox
         WHERE id = ?
           AND status IN ('pending', 'failed')
           AND julianday(expires_at) >= julianday(?)
           AND (lease_until IS NULL OR julianday(lease_until) < julianday(?))`
      )
      .get(replyId, nowIso, nowIso) as WeixinReplyOutboxRecord | undefined;
    if (!row) return null;
    db.prepare(
      `UPDATE weixin_reply_outbox
       SET status = 'sending', lease_owner = ?, lease_until = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(leaseOwner, leaseUntilIso, replyId);
    return { ...row, status: 'sending' as const, lease_owner: leaseOwner, lease_until: leaseUntilIso };
  })();
}

export function claimDueWeixinReplies(
  leaseOwner: string,
  now: Date = new Date(),
  limit: number = 20,
  leaseSeconds: number = 45
): WeixinReplyOutboxRecord[] {
  const nowIso = now.toISOString();
  const leaseUntilIso = new Date(now.getTime() + leaseSeconds * 1000).toISOString();

  return db.transaction(() => {
    db.prepare(
      `UPDATE weixin_reply_outbox
       SET status = 'expired', lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE status IN ('pending', 'failed') AND julianday(expires_at) < julianday(?)`
    ).run(nowIso);

    db.prepare(
      `UPDATE weixin_reply_outbox
       SET status = 'failed', next_retry_at = ?, last_error = COALESCE(last_error, 'reply lease expired'),
           lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE status = 'sending' AND lease_until IS NOT NULL AND julianday(lease_until) < julianday(?)`
    ).run(nowIso, nowIso);

    const due = db
      .prepare(
        `SELECT * FROM weixin_reply_outbox
         WHERE status IN ('pending', 'failed')
           AND attempt_count < 5
           AND julianday(expires_at) >= julianday(?)
           AND (next_retry_at IS NULL OR julianday(next_retry_at) <= julianday(?))
           AND (lease_until IS NULL OR julianday(lease_until) < julianday(?))
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(nowIso, nowIso, nowIso, limit) as WeixinReplyOutboxRecord[];

    if (due.length === 0) return [];
    const upd = db.prepare(
      `UPDATE weixin_reply_outbox
       SET status = 'sending', lease_owner = ?, lease_until = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    );
    for (const row of due) {
      upd.run(leaseOwner, leaseUntilIso, row.id);
    }
    return due.map(r => ({ ...r, status: 'sending' as const, lease_owner: leaseOwner, lease_until: leaseUntilIso }));
  })();
}

export function markWeixinReplySent(
  replyId: number,
  providerMsgId?: string | null,
  textSent: boolean = true,
  imageSent: boolean = true
): void {
  db.prepare(
    `UPDATE weixin_reply_outbox
     SET status = 'sent',
         text_sent = ?,
         image_sent = ?,
         provider_msg_id = COALESCE(?, provider_msg_id),
         last_error = NULL,
         lease_owner = NULL,
         lease_until = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(textSent ? 1 : 0, imageSent ? 1 : 0, providerMsgId || null, replyId);
}

export function markWeixinReplyFailed(params: {
  replyId: number;
  errorMessage: string;
  textSent: boolean;
  imageSent: boolean;
  terminal?: boolean;
  maxAttempts?: number;
}): void {
  const row = db
    .prepare('SELECT attempt_count FROM weixin_reply_outbox WHERE id = ?')
    .get(params.replyId) as { attempt_count: number } | undefined;
  const nextCount = (row?.attempt_count || 0) + 1;
  const maxAttempts = params.maxAttempts ?? 5;
  const isTerminal = Boolean(params.terminal) || nextCount >= maxAttempts;
  const backoffSec = Math.min(300, 5 * 3 ** Math.max(0, nextCount - 1));
  const nextRetry = isTerminal ? null : new Date(Date.now() + backoffSec * 1000).toISOString();

  db.prepare(
    `UPDATE weixin_reply_outbox
     SET status = 'failed',
         text_sent = ?,
         image_sent = ?,
         attempt_count = ?,
         next_retry_at = ?,
         last_error = ?,
         lease_owner = NULL,
         lease_until = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(params.textSent ? 1 : 0, params.imageSent ? 1 : 0, nextCount, nextRetry, params.errorMessage, params.replyId);
}

export interface ScopedSessionTurn {
  role: 'user' | 'assistant';
  text: string;
}

export function appendScopedSessionTurns(
  existingTurns: ScopedSessionTurn[] | undefined,
  userText: string,
  assistantText: string,
  maxTurns: number = 6
): ScopedSessionTurn[] {
  const base = Array.isArray(existingTurns) ? [...existingTurns] : [];
  const compact = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 180);
  if (userText.trim()) base.push({ role: 'user', text: compact(userText) });
  if (assistantText.trim()) base.push({ role: 'assistant', text: compact(assistantText) });
  return base.slice(-maxTurns);
}

// ==================== 会话草稿（M04） ====================

export function getActiveConversationDraft(
  userId: number,
  channel: string,
  threadKey: string,
  now: Date = new Date()
): ConversationDraft | null {
  const row = db
    .prepare('SELECT * FROM conversation_drafts WHERE user_id = ? AND channel = ? AND thread_key = ?')
    .get(userId, channel, threadKey) as ConversationDraft | undefined;

  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    db.prepare('DELETE FROM conversation_drafts WHERE id = ?').run(row.id);
    return null;
  }
  return row;
}

export function upsertConversationDraft(params: {
  userId: number;
  channel: string;
  threadKey: string;
  intent: string;
  draftData: unknown;
  missingFields?: unknown;
  ttlMinutes?: number;
  expectedVersion?: number;
}): ConversationDraft {
  const expiresAt = new Date(Date.now() + (params.ttlMinutes ?? 30) * 60_000).toISOString();
  const draftJson = JSON.stringify(params.draftData ?? {});
  const missingJson = params.missingFields ? JSON.stringify(params.missingFields) : null;

  return db.transaction(() => {
    const existing = db
      .prepare('SELECT * FROM conversation_drafts WHERE user_id = ? AND channel = ? AND thread_key = ?')
      .get(params.userId, params.channel, params.threadKey) as ConversationDraft | undefined;

    if (existing && params.expectedVersion !== undefined && existing.version !== params.expectedVersion) {
      throw new Error('会话草稿已被更新，请重试');
    }

    if (existing) {
      db.prepare(`
        UPDATE conversation_drafts
        SET intent = ?, draft_json = ?, missing_fields_json = ?,
            version = version + 1, expires_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(params.intent, draftJson, missingJson, expiresAt, existing.id);
    } else {
      db.prepare(`
        INSERT INTO conversation_drafts (
          user_id, channel, thread_key, intent, draft_json, missing_fields_json, version, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      `).run(params.userId, params.channel, params.threadKey, params.intent, draftJson, missingJson, expiresAt);
    }

    return db
      .prepare('SELECT * FROM conversation_drafts WHERE user_id = ? AND channel = ? AND thread_key = ?')
      .get(params.userId, params.channel, params.threadKey) as ConversationDraft;
  })();
}

export function consumeConversationDraft(
  userId: number,
  channel: string,
  threadKey: string,
  expectedVersion?: number
): void {
  if (expectedVersion !== undefined) {
    db.prepare('DELETE FROM conversation_drafts WHERE user_id = ? AND channel = ? AND thread_key = ? AND version = ?').run(
      userId,
      channel,
      threadKey,
      expectedVersion
    );
  } else {
    db.prepare('DELETE FROM conversation_drafts WHERE user_id = ? AND channel = ? AND thread_key = ?').run(
      userId,
      channel,
      threadKey
    );
  }
}

export function clearUserDrafts(userId: number, channel?: string): void {
  if (channel) {
    db.prepare('DELETE FROM conversation_drafts WHERE user_id = ? AND channel = ?').run(userId, channel);
  } else {
    db.prepare('DELETE FROM conversation_drafts WHERE user_id = ?').run(userId);
  }
}
