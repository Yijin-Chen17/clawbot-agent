import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { db } from '../config/database.js';
import { UserSettings } from '../models/types.js';
import {
  requestLoginQRCode,
  checkLoginQRStatus,
  sendWeixinTextMessage,
  weixinTransitManager,
  clearWeixinMemoryContext,
} from '../services/weixinGateway.js';
import { clearUserDrafts } from '../services/inboxService.js';

export async function getQRCode(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  try {
    const qrData = await requestLoginQRCode(userId);
    res.json({
      success: true,
      qrcode: qrData.qrcode,
      qrcodeUrl: qrData.qrcodeUrl,
    });
  } catch (err: any) {
    res.status(500).json({ error: '获取微信登录二维码失败：' + err.message });
  }
}

export async function getStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings | undefined;

  if (settings && settings.weixin_connected && settings.weixin_bot_token) {
    res.json({
      connected: true,
      weixinStatus: settings.weixin_status || 'connected',
      weixinUserId: settings.weixin_user_id || '已连接',
      weixinBotId: settings.weixin_bot_id,
      status: 'confirmed',
    });
    return;
  }

  if (settings?.weixin_status === 'rebind_required') {
    res.json({
      connected: false,
      weixinStatus: 'rebind_required',
      status: 'rebind_required',
      error: '微信登录凭证已失效，请重新扫码绑定',
    });
    return;
  }

  try {
    const qrStatus = await checkLoginQRStatus(userId);
    res.json({
      connected: qrStatus.status === 'confirmed',
      weixinStatus: qrStatus.status === 'confirmed' ? 'connected' : 'disconnected',
      status: qrStatus.status,
      weixinUserId: qrStatus.userId,
    });
  } catch (err: any) {
    res.json({
      connected: false,
      weixinStatus: settings?.weixin_status || 'disconnected',
      status: 'wait',
      error: err.message,
    });
  }
}

export function unbindWeixin(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;

  weixinTransitManager.stopWorker(userId);
  clearWeixinMemoryContext(userId);

  db.transaction(() => {
    db.prepare(`
      UPDATE user_settings
      SET
        weixin_connected = 0,
        weixin_status = 'disconnected',
        weixin_bot_token = '',
        weixin_bot_id = '',
        weixin_user_id = '',
        weixin_sync_buf = '',
        weixin_context_token = '',
        weixin_activated = 0,
        weixin_last_active_at = NULL,
        clawbot_to_wxid = '',
        updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ?
    `).run(userId);

    clearUserDrafts(userId, 'weixin_ilink');
  })();

  res.json({ message: '已成功解除微信配对绑定' });
}

export async function sendTestMessage(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings | undefined;

  if (!settings || !settings.weixin_connected || !settings.weixin_bot_token || !settings.weixin_user_id) {
    res.status(400).json({ error: '当前账号尚未绑定微信，请先扫码登录配对' });
    return;
  }

  const result = await sendWeixinTextMessage(
    settings.weixin_base_url || 'https://ilinkai.weixin.qq.com',
    settings.weixin_bot_token,
    settings.weixin_bot_id || '',
    settings.weixin_user_id,
    '🎉 恭喜！您的微信已成功与 Clawbot 智能时间规划助手完成配对连接。\n您现在可以直接在此向我发送日常时间安排或任务需求了～',
    settings.weixin_context_token
  );

  if (result.success) {
    res.json({ message: '测试消息已成功推送至您的微信！请在手机端查收。' });
  } else {
    res.status(500).json({ error: '消息推送失败：' + (result.error || '请稍后重试或重新扫码绑定') });
  }
}
