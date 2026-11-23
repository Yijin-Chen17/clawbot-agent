import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { db } from '../config/database.js';
import { getDataDir, JWT_SECRET } from '../config/env.js';
import { User } from '../models/types.js';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { sendEmailVerificationCode, verifyEmailCode, isValidEmail, type VerificationCodeType } from '../services/emailService.js';
import { recordAuditLog } from '../services/accountService.js';
import { weixinTransitManager } from '../services/weixinGateway.js';

function removeLocalAvatarFile(avatarUrl?: string | null): void {
  if (!avatarUrl || !avatarUrl.startsWith('/uploads/avatars/')) return;
  const avatarsDir = path.join(getDataDir(), 'uploads', 'avatars');
  const filename = path.basename(avatarUrl);
  const fullPath = path.join(avatarsDir, filename);
  if (fs.existsSync(fullPath)) {
    try {
      fs.unlinkSync(fullPath);
    } catch {}
  }
}

export function deleteUserAccountWithCleanup(userId: number, actorUserId?: number | null): void {
  const userRow = db.prepare('SELECT id, username, avatar_url FROM users WHERE id = ?').get(userId) as
    | { id: number; username: string; avatar_url?: string }
    | undefined;
  if (!userRow) return;

  try {
    weixinTransitManager.stopWorker(userId);
  } catch {}

  db.transaction(() => {
    // Anonymize/unlink financial redemption codes while preserving code audit history (A09)
    db.prepare('UPDATE redemption_codes SET created_by = NULL WHERE created_by = ?').run(userId);
    db.prepare('UPDATE redemption_codes SET used_by_user_id = NULL WHERE used_by_user_id = ?').run(userId);

    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    recordAuditLog(actorUserId ?? userId, userId, 'delete_account', { username: userRow.username });
  })();

  removeLocalAvatarFile(userRow.avatar_url);
}

async function handleSendEmailCode(req: Request, res: Response, type: VerificationCodeType): Promise<void> {
  const { email, lang } = req.body;
  const userLang: 'zh' | 'en' = lang === 'en' ? 'en' : 'zh';

  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: userLang === 'en' ? 'Please enter a valid email address' : '请输入有效的邮箱地址' });
    return;
  }

  try {
    const result = await sendEmailVerificationCode(email, type, userLang);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || (userLang === 'en' ? 'Failed to send verification code' : '发送验证码失败') });
  }
}

export async function sendRegisterCode(req: Request, res: Response): Promise<void> {
  await handleSendEmailCode(req, res, 'register');
}

export async function sendResetPasswordCode(req: Request, res: Response): Promise<void> {
  await handleSendEmailCode(req, res, 'reset_password');
}

export function resetPassword(req: Request, res: Response): void {
  const { email, code, newPassword, lang } = req.body;
  const isEn = lang === 'en';

  if (!email || typeof email !== 'string' || !isValidEmail(email.trim())) {
    res.status(400).json({ error: isEn ? 'Please enter a valid email address' : '请输入有效的绑定邮箱' });
    return;
  }

  if (!code || typeof code !== 'string' || code.trim().length !== 6) {
    res.status(400).json({ error: isEn ? 'Please enter the 6-digit verification code' : '请输入 6 位邮箱验证码' });
    return;
  }

  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    res.status(400).json({ error: isEn ? 'New password must be at least 6 characters' : '新密码长度至少需要 6 位' });
    return;
  }

  const trimmedEmail = email.trim().toLowerCase();
  const user = db.prepare('SELECT id, status FROM users WHERE LOWER(email) = ?').get(trimmedEmail) as
    | { id: number; status: string }
    | undefined;

  if (!user) {
    res.status(404).json({ error: isEn ? 'No account is bound to this email address' : '该邮箱未绑定任何账号' });
    return;
  }

  if (user.status === 'banned') {
    res.status(403).json({ error: isEn ? 'This account has been banned and cannot reset password' : '该账号已被管理员封禁，无法重置密码' });
    return;
  }

  const salt = bcrypt.genSaltSync(10);
  const newHash = bcrypt.hashSync(newPassword, salt);

  const ok = db.transaction(() => {
    const codeValid = verifyEmailCode(trimmedEmail, code, 'reset_password');
    if (!codeValid) return false;

    db.prepare(`
      UPDATE users
      SET password_hash = ?,
          session_version = COALESCE(session_version, 1) + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newHash, user.id);
    return true;
  })();

  if (!ok) {
    res.status(400).json({ error: isEn ? 'Invalid or expired verification code' : '邮箱验证码错误、已失效或已过期，请重新获取' });
    return;
  }

  res.json({
    message: isEn
      ? 'Password reset successful! Please sign in with your new password.'
      : '密码重置成功，请使用新密码登录！',
  });
}

export function checkUsername(req: Request, res: Response): void {
  const username = String(req.query.username || '').trim();
  if (!username) {
    res.status(400).json({ available: false, message: '请输入用户名' });
    return;
  }

  if (username.length < 3) {
    res.json({ available: false, message: '用户名至少需要 3 位字符' });
    return;
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    res.json({ available: false, message: '该用户名已被占用，请更换其他用户名' });
  } else {
    res.json({ available: true, message: '用户名可用' });
  }
}

export function register(req: Request, res: Response): void {
  const { username, password, email, code } = req.body;

  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: '请提供有效的账号和密码' });
    return;
  }

  if (!email || typeof email !== 'string' || !isValidEmail(email.trim())) {
    res.status(400).json({ error: '请输入有效的注册邮箱' });
    return;
  }

  if (!code || typeof code !== 'string' || code.trim().length !== 6) {
    res.status(400).json({ error: '请输入 6 位邮箱验证码' });
    return;
  }

  if (username.length < 3 || password.length < 6) {
    res.status(400).json({ error: '账号至少 3 位，密码至少 6 位' });
    return;
  }

  const trimmedEmail = email.trim().toLowerCase();
  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(password, salt);
  const tokenSecret = crypto.randomBytes(24).toString('hex');
  const webhookToken = crypto.randomBytes(16).toString('hex');

  try {
    const created = db.transaction(() => {
      const existingUsername = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
      if (existingUsername) {
        return { error: { status: 409, message: '该账号已存在，请更换其他账号' } };
      }

      const existingEmail = db.prepare('SELECT id FROM users WHERE LOWER(email) = ?').get(trimmedEmail);
      if (existingEmail) {
        return { error: { status: 409, message: '该邮箱已被注册，每个邮箱仅限注册一个账号' } };
      }

      const codeValid = verifyEmailCode(trimmedEmail, code, 'register');
      if (!codeValid) {
        return { error: { status: 400, message: '邮箱验证码错误或已过期，请重新获取' } };
      }

      // 邮箱验证后直接放行 approved (A01)
      const result = db.prepare(`
        INSERT INTO users (username, email, password_hash, role, status, token_secret, session_version, nickname, avatar_url)
        VALUES (?, ?, ?, 'user', 'approved', ?, 1, '', '')
      `).run(username, trimmedEmail, passwordHash, tokenSecret);

      const userId = Number(result.lastInsertRowid);
      db.prepare(`
        INSERT INTO user_settings (user_id, clawbot_webhook_token)
        VALUES (?, ?)
      `).run(userId, webhookToken);

      return { userId };
    })();

    if ('error' in created && created.error) {
      res.status(created.error.status).json({ error: created.error.message });
      return;
    }

    const userId = created.userId!;
    const token = jwt.sign(
      { id: userId, username, role: 'user', sv: 1 },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      message: '注册成功，欢迎使用！',
      token,
      user: {
        id: userId,
        username,
        email: trimmedEmail,
        nickname: '',
        avatar_url: '',
        role: 'user',
        status: 'approved',
        token_secret: tokenSecret,
      },
    });
  } catch (err: any) {
    res.status(409).json({ error: '注册失败，用户名或邮箱可能已被占用' });
  }
}

export function login(req: Request, res: Response): void {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: '请输入账号/邮箱和密码' });
    return;
  }

  const trimmedLogin = String(username).trim();
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR LOWER(email) = ?').get(trimmedLogin, trimmedLogin.toLowerCase()) as User | undefined;
  if (!user || !user.password_hash) {
    res.status(401).json({ error: '账号或密码错误' });
    return;
  }

  const match = bcrypt.compareSync(password, user.password_hash);
  if (!match) {
    res.status(401).json({ error: '账号或密码错误' });
    return;
  }

  if (user.status === 'banned') {
    res.status(403).json({ error: '账号已被管理员封禁，无法登录系统' });
    return;
  }

  if (user.status === 'pending') {
    res.status(403).json({ error: '账号正在审核中，请联系管理员审核放行后再登录' });
    return;
  }

  if (user.status === 'rejected') {
    res.status(403).json({ error: '账号已被管理员拒绝访问，如有疑问请联系管理员' });
    return;
  }

  const sv = Number(user.session_version ?? 1);
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, sv },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  res.json({
    message: '登录成功',
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email || '',
      nickname: user.nickname || '',
      avatar_url: user.avatar_url || '',
      role: user.role,
      status: user.status,
      token_secret: user.token_secret,
    },
  });
}

export function getMe(req: AuthenticatedRequest, res: Response): void {
  if (!req.user) {
    res.status(401).json({ error: '未登录' });
    return;
  }

  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      email: req.user.email || '',
      nickname: req.user.nickname || '',
      avatar_url: req.user.avatar_url || '',
      role: req.user.role,
      status: req.user.status,
      token_secret: req.user.token_secret,
      created_at: req.user.created_at,
    },
  });
}

export function updateProfile(req: AuthenticatedRequest, res: Response): void {
  if (!req.user) {
    res.status(401).json({ error: '未登录' });
    return;
  }

  const { nickname } = req.body;
  if (typeof nickname !== 'string') {
    res.status(400).json({ error: '昵称格式不正确' });
    return;
  }

  const trimmed = nickname.trim().slice(0, 50);

  db.prepare(`
    UPDATE users
    SET nickname = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(trimmed, req.user.id);

  const updatedUser = db.prepare(`
    SELECT id, username, nickname, avatar_url, role, status, token_secret, created_at
    FROM users WHERE id = ?
  `).get(req.user.id) as User;

  res.json({
    message: '个人信息修改成功',
    user: updatedUser,
  });
}

export function uploadAvatar(req: AuthenticatedRequest, res: Response): void {
  if (!req.user) {
    res.status(401).json({ error: '未登录' });
    return;
  }

  const { avatarData } = req.body;
  if (!avatarData || typeof avatarData !== 'string') {
    res.status(400).json({ error: '缺少头像图片数据' });
    return;
  }

  const matches = avatarData.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/);
  if (!matches) {
    res.status(400).json({ error: '只支持上传 PNG, JPG, JPEG, WEBP 或 GIF 格式图片' });
    return;
  }

  const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
  const base64Content = matches[2];
  const buffer = Buffer.from(base64Content, 'base64');

  const MAX_SIZE = 2 * 1024 * 1024;
  if (buffer.length > MAX_SIZE) {
    res.status(400).json({ error: '头像图片大小不能超过 2MB，请先压缩或选择更小的图片' });
    return;
  }

  const avatarsDir = path.join(getDataDir(), 'uploads', 'avatars');
  if (!fs.existsSync(avatarsDir)) {
    fs.mkdirSync(avatarsDir, { recursive: true });
  }

  const filename = `avatar_${req.user.id}_${Date.now()}.${ext}`;
  const filePath = path.join(avatarsDir, filename);

  try {
    fs.writeFileSync(filePath, buffer);

    const oldUser = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.user.id) as { avatar_url?: string };
    removeLocalAvatarFile(oldUser?.avatar_url);

    const publicUrl = `/uploads/avatars/${filename}`;
    db.prepare(`
      UPDATE users
      SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(publicUrl, req.user.id);

    res.json({
      message: '头像上传成功',
      avatar_url: publicUrl,
    });
  } catch (err: any) {
    res.status(500).json({ error: `保存头像失败: ${err.message}` });
  }
}

export function changePassword(req: AuthenticatedRequest, res: Response): void {
  if (!req.user) {
    res.status(401).json({ error: '未登录' });
    return;
  }

  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword || typeof oldPassword !== 'string' || typeof newPassword !== 'string') {
    res.status(400).json({ error: '请输入原密码和新密码' });
    return;
  }

  if (newPassword.length < 6) {
    res.status(400).json({ error: '新密码长度至少需要 6 位字符' });
    return;
  }

  const record = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id) as { password_hash: string } | undefined;
  if (!record || !record.password_hash) {
    res.status(404).json({ error: '未找到用户信息' });
    return;
  }

  const match = bcrypt.compareSync(oldPassword, record.password_hash);
  if (!match) {
    res.status(400).json({ error: '当前密码输入错误，请重新确认' });
    return;
  }

  const salt = bcrypt.genSaltSync(10);
  const newHash = bcrypt.hashSync(newPassword, salt);

  const newSv = db.transaction(() => {
    db.prepare(`
      UPDATE users
      SET password_hash = ?,
          session_version = COALESCE(session_version, 1) + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(newHash, req.user!.id);
    const row = db.prepare('SELECT session_version FROM users WHERE id = ?').get(req.user!.id) as { session_version: number };
    return Number(row?.session_version || 1);
  })();

  const newToken = jwt.sign(
    { id: req.user.id, username: req.user.username, role: req.user.role, sv: newSv },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  res.json({
    message: '密码修改成功！新密码哈希已安全更新，旧会话已全部失效。',
    token: newToken,
  });
}

export function deleteMyAccount(req: AuthenticatedRequest, res: Response): void {
  if (!req.user) {
    res.status(401).json({ error: '未登录' });
    return;
  }

  if (req.user.role === 'admin' && req.user.username === 'admin') {
    res.status(400).json({ error: '默认超级管理员账号不可注销' });
    return;
  }

  const { password } = req.body;
  if (!password || typeof password !== 'string') {
    res.status(400).json({ error: '请输入当前密码以确认注销' });
    return;
  }

  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id) as any;
  if (!user || !user.password_hash) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }

  const match = bcrypt.compareSync(password, user.password_hash);
  if (!match) {
    res.status(400).json({ error: '密码错误，无法注销账号' });
    return;
  }

  deleteUserAccountWithCleanup(req.user.id, req.user.id);

  res.json({
    success: true,
    message: '您的账号及全部关联数据（日程、待办、设置）已彻底注销删除',
  });
}
