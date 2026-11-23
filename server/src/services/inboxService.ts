import crypto from 'crypto';
import { db } from '../config/database.js';
import type { CommandInboxRecord, ConversationDraft } from '../models/types.js';

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
      const payloadHash = hashCommandPayload({ senderId: item.senderId, text: item.text });
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
        JSON.stringify({ text: item.text, contextToken: item.contextToken || null })
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
}> {
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
    };
  });
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
