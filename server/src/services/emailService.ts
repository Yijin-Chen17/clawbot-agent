import nodemailer from 'nodemailer';
import { db } from '../config/database.js';
import { getAppConfig } from '../config/appConfig.js';

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * 发送邮箱验证码
 */
export async function sendEmailVerificationCode(
  email: string,
  type: 'register' = 'register',
  lang: 'zh' | 'en' = 'zh'
): Promise<{ success: boolean; message: string }> {
  const trimmedEmail = email.trim().toLowerCase();
  const isEn = lang === 'en';

  if (!trimmedEmail || !isValidEmail(trimmedEmail)) {
    throw new Error(isEn ? 'Please enter a valid email address' : '请输入正确的邮箱地址');
  }

  // 若为注册验证码，检查该邮箱是否已被占用（一个邮箱只能注册一个账号）
  if (type === 'register') {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(trimmedEmail);
    if (existing) {
      throw new Error(
        isEn
          ? 'This email is already registered. Each email can only register one account.'
          : '该邮箱已注册账号，每个邮箱仅限注册一个账号'
      );
    }
  }

  // 频率限制：检查 60 秒内是否已经给该邮箱发过
  const recent = db.prepare(`
    SELECT id FROM email_verification_codes
    WHERE email = ? AND created_at > datetime('now', '-60 seconds')
    LIMIT 1
  `).get(trimmedEmail);

  if (recent) {
    throw new Error(
      isEn
        ? 'Verification code requested too frequently, please wait 60 seconds.'
        : '验证码发送过于频繁，请等待 60 秒后重试'
    );
  }

  // 生成 6 位随机纯数字验证码
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10分钟有效

  // 写入验证码数据库
  db.prepare(`
    INSERT INTO email_verification_codes (email, code, type, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(trimmedEmail, code, type, expiresAt);

  const config = getAppConfig();
  const { host, port, secure, user, pass, from } = config.smtp;

  // 如果 SMTP 尚未配置或授权码为空
  if (!host || !user || !pass) {
    console.warn(`\n==================================================`);
    console.warn(`[SMTP Warning] 系统尚未在 config.yaml 中配置 SMTP 授权码！`);
    console.warn(`[SMTP Mock Code] 目标邮箱: ${trimmedEmail} | 验证码: ${code}`);
    console.warn(`==================================================\n`);
    throw new Error(
      isEn
        ? 'SMTP authorization is not configured in config.yaml. Please contact administrator.'
        : '系统尚未配置邮箱 SMTP 发信授权码，请联系管理员在 config.yaml 中填写 SMTP 配置'
    );
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
  });

  // 严格规范发件人 (From)，防止 163/QQ/网易企业邮等报 553 Mail from must equal authorized user
  let senderFrom = `"Clawbot Tasks" <${user}>`;
  if (from && from.trim()) {
    const trimmedFrom = from.trim();
    if (trimmedFrom.includes('<') && trimmedFrom.includes('>')) {
      const match = trimmedFrom.match(/^(.*?)\s*<([^>]+)>/);
      if (match) {
        const displayName = match[1].trim() || 'Clawbot Tasks';
        // 保证尖括号内的邮箱与 SMTP 认证账号一致
        senderFrom = `"${displayName.replace(/"/g, '')}" <${user}>`;
      } else {
        senderFrom = `"${trimmedFrom.replace(/"/g, '')}" <${user}>`;
      }
    } else if (trimmedFrom.includes('@')) {
      // 若仅填写了邮箱
      senderFrom = `"Clawbot Tasks" <${user}>`;
    } else {
      // 若仅填写了发信昵称（如 "Clawbot"）
      senderFrom = `"${trimmedFrom.replace(/"/g, '')}" <${user}>`;
    }
  }

  // 邮件标题（不包含具体验证码，保护安全，避免在邮件列表预览或通知首页直接泄露）
  const emailSubject = isEn
    ? '[Clawbot] Email Registration Verification Code'
    : '【Clawbot】邮箱注册验证码';

  const emailSubtitle = isEn
    ? 'WeChat Intelligent Task Planning & Dynamic Scheduling Console'
    : '微信智能日程规划与动态排程管理控制台';

  const greeting = isEn ? 'Hello!' : '您好！';

  const bodyDesc = isEn
    ? 'You are registering an account for <strong>Clawbot Tasks</strong>. Please enter the following 6-digit verification code on the registration page to complete your account activation:'
    : '您正在注册 <strong>Clawbot</strong> 智能时间规划系统账号。请在注册页面输入下方 6 位数字验证码完成账号激活：';

  const notes = isEn
    ? '* This verification code is valid for 10 minutes. Please do not share it with anyone.<br/>* If this was not requested by you, please ignore this email.'
    : '* 验证码有效期为 10 分钟。请勿将验证码泄露给他人。<br/>* 如非您本人操作，请忽略此邮件。';

  const footerText = isEn
    ? 'Clawbot Agent · Automated WeChat Schedule Assistant'
    : 'Clawbot Agent · 自动化微信日程协同助手';

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
    await transporter.sendMail(mailOptions);
    return {
      success: true,
      message: isEn
        ? 'Verification code has been sent to your email, valid for 10 minutes.'
        : '验证码已发送至您的邮箱，10分钟内有效',
    };
  } catch (err: any) {
    console.error('[EmailService] SMTP 发送邮件失败:', err.message);
    throw new Error(
      isEn
        ? `Failed to send email: ${err.message || 'Please check SMTP settings'}`
        : `邮件发送失败: ${err.message || '请检查 SMTP 配置'}`
    );
  }
}

/**
 * 校验邮箱验证码
 */
export function verifyEmailCode(
  email: string,
  code: string,
  type: string = 'register'
): boolean {
  const trimmedEmail = email.trim().toLowerCase();
  const trimmedCode = code.trim();

  if (!trimmedEmail || !trimmedCode) return false;

  const record = db.prepare(`
    SELECT id, expires_at, used
    FROM email_verification_codes
    WHERE email = ? AND code = ? AND type = ? AND used = 0
    ORDER BY id DESC
    LIMIT 1
  `).get(trimmedEmail, trimmedCode, type) as any;

  if (!record) return false;

  const isExpired = new Date(record.expires_at).getTime() < Date.now();
  if (isExpired) return false;

  // 标记已使用，防止重放
  db.prepare('UPDATE email_verification_codes SET used = 1 WHERE id = ?').run(record.id);
  return true;
}
