import { db } from '../config/database.js';
import type { User, UserSettings } from '../models/types.js';
import { DEFAULT_TIMEZONE, resolveAccountTimezone } from '../utils/timezone.js';

export interface AccountEligibilityResult {
  eligible: boolean;
  reason?: 'not_found' | 'banned' | 'pending' | 'rejected' | 'session_revoked';
  message?: string;
  user?: User;
}

/**
 * Shared account eligibility check across HTTP auth, Webhook, Weixin Gateway, public ICS, and background workers (A02).
 */
export function checkAccountEligibility(
  userId: number,
  expectedSessionVersion?: number
): AccountEligibilityResult {
  const user = db.prepare(`
    SELECT id, username, email, nickname, avatar_url, role, status, balance, token_secret,
           COALESCE(session_version, 1) as session_version, created_at, updated_at
    FROM users WHERE id = ?
  `).get(userId) as User | undefined;

  if (!user) {
    return { eligible: false, reason: 'not_found', message: '用户不存在' };
  }

  if (user.status === 'banned') {
    return { eligible: false, reason: 'banned', message: '账号已被管理员封禁', user };
  }
  if (user.status === 'pending') {
    return { eligible: false, reason: 'pending', message: '账号正在审核中，请等待审核通过', user };
  }
  if (user.status === 'rejected') {
    return { eligible: false, reason: 'rejected', message: '账号访问已被拒绝', user };
  }
  if (user.status !== 'approved') {
    return { eligible: false, reason: 'rejected', message: '账号状态异常', user };
  }

  if (expectedSessionVersion !== undefined && Number(user.session_version ?? 1) !== Number(expectedSessionVersion)) {
    return { eligible: false, reason: 'session_revoked', message: '登录凭证已因密码变更而失效，请重新登录', user };
  }

  return { eligible: true, user };
}

export function incrementSessionVersion(userId: number): void {
  db.prepare(`
    UPDATE users
    SET session_version = COALESCE(session_version, 1) + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(userId);
}

export function getUserTimezone(userId: number): string {
  const row = db.prepare('SELECT timezone FROM user_settings WHERE user_id = ?').get(userId) as
    | { timezone?: string }
    | undefined;
  return resolveAccountTimezone(row?.timezone || DEFAULT_TIMEZONE);
}

export function getUserSettingsSafe(userId: number): UserSettings | undefined {
  return db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings | undefined;
}

export function recordAuditLog(
  actorUserId: number | null,
  targetUserId: number | null,
  action: string,
  detail?: Record<string, any>
): void {
  try {
    db.prepare(`
      INSERT INTO audit_logs (actor_user_id, target_user_id, action, detail_json)
      VALUES (?, ?, ?, ?)
    `).run(actorUserId, targetUserId, action, detail ? JSON.stringify(detail) : null);
  } catch (err: any) {
    console.warn('[AuditLog] Failed to insert audit log:', err.message);
  }
}
