import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { db } from '../config/database.js';
import { JWT_SECRET } from '../config/env.js';
import { User } from '../models/types.js';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { sendEmailVerificationCode, verifyEmailCode, isValidEmail } from '../services/emailService.js';

export async function sendRegisterCode(req: Request, res: Response): Promise<void> {
  const { email } = req.body;
  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: '请输入有效的邮箱地址' });
    return;
  }

  try {
    const result = await sendEmailVerificationCode(email, 'register');
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || '发送验证码失败' });
  }
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

  const existingUsername = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existingUsername) {
    res.status(409).json({ error: '该账号已存在，请更换其他账号' });
    return;
  }

  const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(trimmedEmail);
  if (existingEmail) {
    res.status(409).json({ error: '该邮箱已被注册，每个邮箱仅限注册一个账号' });
    return;
  }

  const codeValid = verifyEmailCode(trimmedEmail, code, 'register');
  if (!codeValid) {
    res.status(400).json({ error: '邮箱验证码错误或已过期，请重新获取' });
    return;
  }

  const salt = bcrypt.genSaltSync(10);
  const passwordHash = bcrypt.hashSync(password, salt);
  const tokenSecret = crypto.randomBytes(24).toString('hex');
  const webhookToken = crypto.randomBytes(16).toString('hex');

  // 直接审核放行 approved，无需管理员手动审核
  const result = db.prepare(`
    INSERT INTO users (username, email, password_hash, role, status, token_secret, nickname, avatar_url)
    VALUES (?, ?, ?, 'user', 'approved', ?, '', '')
  `).run(username, trimmedEmail, passwordHash, tokenSecret);

  const userId = Number(result.lastInsertRowid);

  // Initialize user settings
  db.prepare(`
    INSERT INTO user_settings (user_id, clawbot_webhook_token)
    VALUES (?, ?)
  `).run(userId, webhookToken);

  const token = jwt.sign(
    { id: userId, username, role: 'user' },
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
}

export function login(req: Request, res: Response): void {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400).json({ error: '请输入账号/邮箱和密码' });
    return;
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username) as User | undefined;
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

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
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

/**
 * 修改个人信息 (支持修改昵称，账号 username 严格只读不可改)
 */
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

/**
 * 上传个人头像 (严格限制文件大小 <= 2MB，仅支持常规图片格式)
 */
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

  // Parse Data URL: data:image/(png|jpeg|jpg|webp|gif);base64,...
  const matches = avatarData.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/);
  if (!matches) {
    res.status(400).json({ error: '只支持上传 PNG, JPG, JPEG, WEBP 或 GIF 格式图片' });
    return;
  }

  const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
  const base64Content = matches[2];
  const buffer = Buffer.from(base64Content, 'base64');

  // 严格限制头像大小最大 2MB
  const MAX_SIZE = 2 * 1024 * 1024;
  if (buffer.length > MAX_SIZE) {
    res.status(400).json({ error: '头像图片大小不能超过 2MB，请先压缩或选择更小的图片' });
    return;
  }

  const avatarsDir = path.resolve(process.cwd(), 'data/uploads/avatars');
  if (!fs.existsSync(avatarsDir)) {
    fs.mkdirSync(avatarsDir, { recursive: true });
  }

  const filename = `avatar_${req.user.id}_${Date.now()}.${ext}`;
  const filePath = path.join(avatarsDir, filename);

  try {
    fs.writeFileSync(filePath, buffer);

    // 删除旧的本地头像文件以节约磁盘空间
    const oldUser = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.user.id) as { avatar_url?: string };
    if (oldUser?.avatar_url && oldUser.avatar_url.startsWith('/uploads/avatars/')) {
      const oldFilename = path.basename(oldUser.avatar_url);
      const oldPath = path.join(avatarsDir, oldFilename);
      if (fs.existsSync(oldPath)) {
        try {
          fs.unlinkSync(oldPath);
        } catch {
          // ignore unlink error
        }
      }
    }

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

/**
 * 修改密码 (服务器只保存密码哈希，用户密码不可明文保存)
 */
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

  db.prepare(`
    UPDATE users
    SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newHash, req.user.id);

  res.json({
    message: '密码修改成功！新密码哈希已安全更新。',
  });
}

/**
 * 用户自主注销/删除账号及全部数据
 */
export function deleteMyAccount(req: AuthenticatedRequest, res: Response): void {
  if (!req.user) {
    res.status(401).json({ error: '未登录' });
    return;
  }

  // 保护初始默认 admin 账号
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

  // 执行级联删除
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);

  res.json({
    success: true,
    message: '您的账号及全部关联数据（日程、待办、设置）已彻底注销删除',
  });
}
