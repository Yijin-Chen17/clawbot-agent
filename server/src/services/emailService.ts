import nodemailer from 'nodemailer';
import { db } from '../config/database.js';
import { getAppConfig } from '../config/appConfig.js';

export type VerificationCodeType = 'register' | 'reset_password';

export type EmailSender = (mailOptions: {
  from: string;
  to: string;
  subject: string;
  html: string;
}) => Promise<void>;

let customEmailSender: EmailSender | null = null;

export function setEmailSenderForTest(sender: EmailSender | null): void {
  customEmailSender = sender;
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const MAX_FAILED_VERIFY_ATTEMPTS = 5;
const FAILED_VERIFY_WINDOW_MS = 10 * 60 * 1000;
const failedVerifyTracker = new Map<string, { count: number; resetAt: number }>();

export function buildVerificationEmailContent(
  type: VerificationCodeType,
  lang: 'zh' | 'en'
): {
  subject: string;
  subtitle: string;
  greeting: string;
  bodyDesc: string;
  notes: string;
  footerText: string;
} {
  const isEn = lang === 'en';
  const isReset = type === 'reset_password';

  return {
    subject: isReset
      ? isEn
        ? '[Clawbot] Password Reset Verification Code'
        : '【Clawbot】重置密码验证码'
      : isEn
      ? '[Clawbot] Email Registration Verification Code'
      : '【Clawbot】邮箱注册验证码',
    subtitle: isEn
      ? 'WeChat Intelligent Task Planning & Dynamic Scheduling Console'
      : '微信智能日程规划与动态排程管理控制台',
    greeting: isEn ? 'Hello!' : '您好！',
    bodyDesc: isReset
      ? isEn
        ? 'You requested to reset your <strong>Clawbot Tasks</strong> login password. Please enter the following 6-digit verification code on the password reset page:'
        : '您正在通过邮箱验证码重置 <strong>Clawbot</strong> 账号的登录密码。请在重置密码页面输入下方 6 位数字验证码：'
      : isEn
      ? 'You are registering an account for <strong>Clawbot Tasks</strong>. Please enter the following 6-digit verification code on the registration page to complete your account activation:'
      : '您正在注册 <strong>Clawbot</strong> 智能时间规划系统账号。请在注册页面输入下方 6 位数字验证码完成账号激活：',
    notes: isEn
      ? '* This verification code is valid for 10 minutes. Please do not share it with anyone.<br/>* If this was not requested by you, please ignore this email.'
      : '* 验证码有效期为 10 分钟。请勿将验证码泄露给他人。<br/>* 如非您本人操作，请忽略此邮件。',
    footerText: isEn
      ? 'Clawbot Agent · Automated WeChat Schedule Assistant'
      : 'Clawbot Agent · 自动化微信日程协同助手',
  };
}

export function recordVerifyFailure(key: string, nowMs: number = Date.now()): boolean {
  const existing = failedVerifyTracker.get(key);
  if (!existing || existing.resetAt <= nowMs) {
    failedVerifyTracker.set(key, { count: 1, resetAt: nowMs + FAILED_VERIFY_WINDOW_MS });
    return false;
  }
  existing.count += 1;
  return existing.count >= MAX_FAILED_VERIFY_ATTEMPTS;
}

export function clearVerifyFailures(key: string): void {
  failedVerifyTracker.delete(key);
}

/**
 * 发送邮箱验证码（A03）：
 * - 先检查 SMTP 配置与仅针对已成功发送记录做频率限制
 * - 先建 sending 记录，发信成功后再标记 sent 并作废同类型旧验证码
 * - 发信失败不触发 60s 冷却，也不会产生可用验证码
 */
export async function sendEmailVerificationCode(
  email: string,
  type: VerificationCodeType = 'register',
  lang: 'zh' | 'en' = 'zh'
): Promise<{ success: boolean; message: string }> {
  const trimmedEmail = email.trim().toLowerCase();
  const isEn = lang === 'en';

  if (!trimmedEmail || !isValidEmail(trimmedEmail)) {
    throw new Error(isEn ? 'Please enter a valid email address' : '请输入正确的邮箱地址');
  }

  if (type === 'register') {
    const existing = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(trimmedEmail);
    if (existing) {
      throw new Error(
        isEn
          ? 'This email is already registered. Each email can only register one account.'
          : '该邮箱已注册账号，每个邮箱仅限注册一个账号'
      );
    }
  } else if (type === 'reset_password') {
    const user = db.prepare('SELECT id, status FROM users WHERE LOWER(email) = ?').get(trimmedEmail) as
      | { id: number; status: string }
      | undefined;
    if (!user) {
      throw new Error(
        isEn
          ? 'No account is bound to this email address.'
          : '该邮箱未绑定任何账号，请核对后重试'
      );
    }
    if (user.status === 'banned') {
      throw new Error(
        isEn
          ? 'This account has been banned and cannot reset password.'
          : '该账号已被管理员封禁，无法重置密码'
      );
    }
  }

  // Only count successfully delivered codes for 60s cooldown
  const recent = db.prepare(`
    SELECT id FROM email_verification_codes
    WHERE email = ? AND type = ? AND delivery_status = 'sent'
      AND created_at > datetime('now', '-60 seconds')
    LIMIT 1
  `).get(trimmedEmail, type);

  if (recent) {
    throw new Error(
      isEn
        ? 'Verification code requested too frequently, please wait 60 seconds.'
        : '验证码发送过于频繁，请等待 60 秒后重试'
    );
  }

  const config = getAppConfig();
  const { host, port, secure, user, pass, from } = config.smtp;

  if (!customEmailSender && (!host || !user || !pass)) {
    throw new Error(
      isEn
        ? 'SMTP authorization is not configured in config.yaml. Please contact administrator.'
        : '系统尚未配置邮箱 SMTP 发信授权码，请联系管理员在 config.yaml 中填写 SMTP 配置'
    );
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const insertRes = db.prepare(`
    INSERT INTO email_verification_codes (email, code, type, expires_at, used, delivery_status)
    VALUES (?, ?, ?, ?, 0, 'sending')
  `).run(trimmedEmail, code, type, expiresAt);
  const challengeId = Number(insertRes.lastInsertRowid);

  let senderFrom = `"Clawbot Tasks" <${user || 'noreply@clawbot.local'}>`;
  if (from && from.trim() && user) {
    const trimmedFrom = from.trim();
    if (trimmedFrom.includes('<') && trimmedFrom.includes('>')) {
      const match = trimmedFrom.match(/^(.*?)\s*<([^>]+)>/);
      const displayName = match?.[1]?.trim() || 'Clawbot Tasks';
      senderFrom = `"${displayName.replace(/"/g, '')}" <${user}>`;
    } else if (!trimmedFrom.includes('@')) {
      senderFrom = `"${trimmedFrom.replace(/"/g, '')}" <${user}>`;
    }
  }

  const {
    subject: emailSubject,
    subtitle: emailSubtitle,
    greeting,
    bodyDesc,
    notes,
    footerText,
  } = buildVerificationEmailContent(type, lang);

  const mailOptions = {
    from: senderFrom,
    to: trimmedEmail,
    subject: emailSubject,
    html: `
      <div style="max-width: 560px; margin: 0 auto; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
        <div style="background: linear-gradient(135deg, #2563eb, #1d4ed8); padding: 24px; text-align: center;">
          <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.5px;">Clawbot Tasks</h1>
          <p style="color: #dbeafe; margin: 6px 0 0 0; font-size: 13px;">${emailSubtitle}</p>
        </div>
        <div style="padding: 32px 24px; color: #1f2937;">
          <p style="margin: 0 0 16px 0; font-size: 15px;">${greeting}</p>
          <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #4b5563;">
            ${bodyDesc}
          </p>
          <div style="background: #f3f4f6; border: 1px dashed #d1d5db; border-radius: 12px; padding: 18px; text-align: center; margin: 24px 0;">
            <span style="font-family: Menlo, Monaco, Consolas, monospace; font-size: 32px; font-weight: 700; color: #1d4ed8; letter-spacing: 8px;">${code}</span>
          </div>
          <p style="margin: 0; font-size: 12px; color: #9ca3af; line-height: 1.5;">
            ${notes}
          </p>
        </div>
        <div style="background: #f9fafb; padding: 16px; text-align: center; border-top: 1px solid #f3f4f6; color: #9ca3af; font-size: 11px;">
          ${footerText}
        </div>
      </div>
    `,
  };

  try {
    if (customEmailSender) {
      await customEmailSender(mailOptions);
    } else {
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
      });
      await transporter.sendMail(mailOptions);
    }

    db.transaction(() => {
      // Invalidate all previous unused codes for this (email, type)
      db.prepare(`
        UPDATE email_verification_codes
        SET used = 1
        WHERE email = ? AND type = ? AND id != ? AND used = 0
      `).run(trimmedEmail, type, challengeId);

      db.prepare(`
        UPDATE email_verification_codes
        SET delivery_status = 'sent'
        WHERE id = ?
      `).run(challengeId);
      clearVerifyFailures(`${type}:${trimmedEmail}`);
    })();

    return {
      success: true,
      message: isEn
        ? 'Verification code has been sent to your email, valid for 10 minutes.'
        : '验证码已发送至您的邮箱，10分钟内有效',
    };
  } catch (err: any) {
    db.prepare(`
      UPDATE email_verification_codes
      SET delivery_status = 'send_failed', error_message = ?, used = 1
      WHERE id = ?
    `).run(err.message || 'SMTP send failed', challengeId);

    console.error('[EmailService] SMTP 发送邮件失败:', err.message);
    throw new Error(
      isEn
        ? `Failed to send email: ${err.message || 'Please check SMTP settings'}`
        : `邮件发送失败: ${err.message || '请检查 SMTP 配置'}`
    );
  }
}

/**
 * 校验并原子消费最新成功发送的邮箱验证码（可运行于外层事务内，A03）。
 */
export function verifyEmailCode(
  email: string,
  code: string,
  type: VerificationCodeType = 'register'
): boolean {
  const trimmedEmail = email.trim().toLowerCase();
  const trimmedCode = code.trim();

  if (!trimmedEmail || !trimmedCode) return false;

  const attemptKey = `${type}:${trimmedEmail}`;
  const latestSent = db.prepare(`
    SELECT id, code, expires_at, used
    FROM email_verification_codes
    WHERE email = ? AND type = ? AND delivery_status = 'sent' AND used = 0
    ORDER BY id DESC
    LIMIT 1
  `).get(trimmedEmail, type) as any;

  if (!latestSent || latestSent.code !== trimmedCode) {
    const locked = recordVerifyFailure(attemptKey);
    if (locked) {
      db.prepare('UPDATE email_verification_codes SET used = 1 WHERE email = ? AND type = ? AND used = 0')
        .run(trimmedEmail, type);
    }
    return false;
  }

  const isExpired = new Date(latestSent.expires_at).getTime() < Date.now();
  if (isExpired) return false;

  const upd = db
    .prepare("UPDATE email_verification_codes SET used = 1 WHERE id = ? AND used = 0 AND delivery_status = 'sent'")
    .run(latestSent.id);
  if (upd.changes !== 1) return false;

  clearVerifyFailures(attemptKey);
  return true;
}
