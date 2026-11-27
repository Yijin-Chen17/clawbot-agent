import crypto from 'node:crypto';
import axios from 'axios';
import { db } from '../config/database.js';
import { UserSettings } from '../models/types.js';
import { getEffectiveLlmConfig, getConfiguredNodes } from './llm.js';
import { addDebugLog } from './debugLogger.js';
import { checkAccountEligibility } from './accountService.js';
import {
  claimDueWeixinReplies,
  claimSingleWeixinReply,
  claimWeixinInboxItem,
  completeCommandInbox,
  enqueueWeixinReply,
  failCommandInbox,
  listPendingWeixinInboxItems,
  markWeixinReplyFailed,
  markWeixinReplySent,
  persistWeixinPollBatch,
  type WeixinInboundItem,
} from './inboxService.js';
import { processNaturalLanguageCommand } from './nlCommandService.js';
import { renderTodoListImage, renderWeekCalendarImage } from './cardRenderer.js';

const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com';
const ILINK_APP_ID = 'bot';
const ILINK_CLIENT_VERSION = '132106';
const BOT_TYPE = '3';

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function generateClientId(): string {
  return `openclaw-weixin-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_CLIENT_VERSION,
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (token) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

interface ActiveQRSession {
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
}

const activeQRSessions = new Map<number, ActiveQRSession>();
const contextTokenMap = new Map<number, string>();

export function markWeixinRebindRequired(userId: number, reason?: string): void {
  db.prepare(`
    UPDATE user_settings
    SET weixin_connected = 0,
        weixin_status = 'rebind_required',
        updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(userId);
  weixinTransitManager.stopWorker(userId);
  addDebugLog('Weixin', 'error', `[用户 #${userId}] 微信登录凭证已失效${reason ? ` (${reason})` : ''}，状态已设为待重新绑定`);
}

function isCredentialExpiredCode(code: unknown): boolean {
  return code === -14 || String(code) === '-14';
}

function isWeixinResponseValid(respStatus: number, data: any): { ok: boolean; errCode?: number; errMsg?: string } {
  if (respStatus >= 400) {
    return { ok: false, errMsg: `HTTP ${respStatus}` };
  }
  if (data === null || data === undefined) {
    return { ok: false, errMsg: '空响应体' };
  }
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return { ok: true };
    try {
      const parsed = JSON.parse(trimmed);
      data = parsed;
    } catch {
      return { ok: false, errMsg: `非预期文本响应: ${trimmed.slice(0, 120)}` };
    }
  }
  if (typeof data !== 'object') {
    return { ok: false, errMsg: '响应格式异常' };
  }
  const hasRetError = data.ret !== undefined && data.ret !== 0;
  const hasErrCode = data.errcode !== undefined && data.errcode !== 0;
  if (hasRetError || hasErrCode) {
    const errCode = Number(data.errcode ?? data.ret);
    const errMsg = data.errmsg || `ret=${data.ret ?? data.errcode ?? 'unknown'}`;
    return { ok: false, errCode, errMsg };
  }
  return { ok: true };
}

export function clearWeixinMemoryContext(userId: number): void {
  contextTokenMap.delete(userId);
  activeQRSessions.delete(userId);
}

/**
 * 1. Request new QR Code for pairing
 */
export async function requestLoginQRCode(userId: number): Promise<{ qrcode: string; qrcodeUrl: string }> {
  const url = `${FIXED_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`;
  addDebugLog('Weixin', 'info', `用户 #${userId} 请求微信登录配对二维码`, { url });

  const resp = await axios.post(
    url,
    { local_token_list: [] },
    { headers: buildHeaders(), timeout: 15000 }
  );

  const data = resp.data;
  if (!data.qrcode) {
    addDebugLog('Weixin', 'error', `获取微信二维码失败`, data);
    throw new Error('微信接口返回二维码失败: ' + JSON.stringify(data));
  }

  const session: ActiveQRSession = {
    qrcode: data.qrcode,
    qrcodeUrl: data.qrcode_img_content || `https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=${data.qrcode}&bot_type=${BOT_TYPE}`,
    startedAt: Date.now(),
  };

  activeQRSessions.set(userId, session);
  addDebugLog('Weixin', 'success', `成功生成配对二维码: ${session.qrcode.slice(0, 16)}...`);
  return { qrcode: session.qrcode, qrcodeUrl: session.qrcodeUrl };
}

/**
 * 2. Check QR Code scanning & confirmation status (Long-poll)
 */
export async function checkLoginQRStatus(userId: number): Promise<{
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  userId?: string;
  botId?: string;
}> {
  const session = activeQRSessions.get(userId);
  if (!session) {
    return { status: 'expired' };
  }

  if (Date.now() - session.startedAt > 5 * 60 * 1000) {
    activeQRSessions.delete(userId);
    return { status: 'expired' };
  }

  const url = `${FIXED_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}`;

  try {
    const resp = await axios.get(url, {
      headers: buildHeaders(),
      timeout: 30000,
    });

    const data = resp.data;
    const status = data.status || 'wait';

    if (status === 'confirmed' && data.bot_token) {
      const botToken = data.bot_token;
      const botId = data.ilink_bot_id || '';
      const wxUserId = data.ilink_user_id || '';
      const baseUrl = data.baseurl || FIXED_BASE_URL;

      db.prepare(`
        UPDATE user_settings
        SET
          weixin_connected = 1,
          weixin_status = 'connected',
          weixin_bot_token = ?,
          weixin_bot_id = ?,
          weixin_user_id = ?,
          weixin_base_url = ?,
          clawbot_to_wxid = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).run(botToken, botId, wxUserId, baseUrl, wxUserId, userId);

      activeQRSessions.delete(userId);
      addDebugLog('Weixin', 'success', `用户 #${userId} 扫码配对成功！已连接微信账号 ${wxUserId}`);
      weixinTransitManager.startWorker(userId);

      return { status: 'confirmed', userId: wxUserId, botId };
    }

    return { status };
  } catch (err: any) {
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      return { status: 'wait' };
    }
    addDebugLog('Weixin', 'warn', `[Weixin QR Poll] 轮询网络异常: ${err.message}`);
    return { status: 'wait' };
  }
}

/**
 * 3. Send text message to user on WeChat via iLink API
 */
export async function sendWeixinTextMessage(
  baseUrl: string,
  botToken: string,
  fromBotId: string,
  toUserId: string,
  text: string,
  contextToken?: string,
  clientIdOverride?: string
): Promise<{ success: boolean; data?: any; error?: string; message_id?: string; ret?: number }> {
  if (!botToken || !toUserId) {
    return { success: false, error: '缺少 botToken 或 toUserId' };
  }

  const clientId = clientIdOverride?.trim() || generateClientId();
  const url = `${baseUrl.replace(/\/$/, '')}/ilink/bot/sendmessage`;

  const payload = {
    msg: {
      from_user_id: fromBotId || '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: contextToken || undefined,
      item_list: [
        {
          type: 1,
          text_item: { text },
        },
      ],
    },
    base_info: {
      channel_version: '2.4.10',
      bot_agent: 'OpenClaw',
    },
  };

  try {
    const resp = await axios.post(url, payload, {
      headers: buildHeaders(botToken),
      timeout: 15000,
    });

    const check = isWeixinResponseValid(resp.status, resp.data);
    const data = typeof resp.data === 'object' && resp.data !== null ? resp.data : {};

    if (check.ok) {
      addDebugLog('Weixin', 'success', `✅ 微信消息发送成功 (ID: ${data.message_id || 'ok'})`);
      return { success: true, data, message_id: data.message_id, ret: 0 };
    } else {
      const errMsg = check.errMsg || '发送被拒绝';
      addDebugLog('Weixin', 'error', `❌ 微信消息发送拒绝: ${errMsg}`, resp.data);
      return { success: false, data, error: errMsg, ret: check.errCode };
    }
  } catch (err: any) {
    const errDetail = err.response?.data || err.message;
    addDebugLog('Weixin', 'error', `❌ 微信网络下发异常: ${err.message}`, errDetail);
    return { success: false, error: String(errDetail) };
  }
}

function encryptAes128Ecb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export async function sendWeixinImageMessage(
  baseUrl: string,
  botToken: string,
  botId: string,
  toUserId: string,
  imageBuffer: Buffer,
  contextToken?: string
): Promise<{ success: boolean; data?: any; error?: string; message_id?: string; ret?: number }> {
  try {
    const rawsize = imageBuffer.length;
    const rawfilemd5 = crypto.createHash('md5').update(imageBuffer).digest('hex');
    const aeskey = crypto.randomBytes(16);
    const aeskeyHex = aeskey.toString('hex');
    const aeskeyBase64 = Buffer.from(aeskeyHex, 'utf-8').toString('base64');
    const ciphertext = encryptAes128Ecb(imageBuffer, aeskey);
    const filesize = ciphertext.length;
    const filekey = crypto.randomBytes(16).toString('hex');

    const uploadUrlEndpoint = `${baseUrl.replace(/\/$/, '')}/ilink/bot/getuploadurl`;
    const uploadUrlResp = await axios.post(
      uploadUrlEndpoint,
      {
        filekey,
        media_type: 1,
        to_user_id: toUserId,
        rawsize,
        rawfilemd5,
        filesize,
        no_need_thumb: true,
        aeskey: aeskey.toString('hex'),
        base_info: {
          channel_version: '2.4.10',
          bot_agent: 'OpenClaw',
        },
      },
      {
        headers: buildHeaders(botToken),
        timeout: 20000,
      }
    );

    const uploadData = uploadUrlResp.data;
    const uploadFullUrl = uploadData.upload_full_url?.trim();
    const uploadParam = uploadData.upload_param;
    const cdnBaseUrl = 'https://novac2c.cdn.weixin.qq.com/c2c';

    let cdnTargetUrl: string;
    if (uploadFullUrl) {
      cdnTargetUrl = uploadFullUrl;
    } else if (uploadParam) {
      cdnTargetUrl = `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
    } else {
      throw new Error(`微信接口未返回 CDN 上传地址: ${JSON.stringify(uploadData)}`);
    }

    const cdnResp = await axios.post(cdnTargetUrl, ciphertext, {
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      timeout: 30000,
    });

    const downloadParam = cdnResp.headers['x-encrypted-param'];
    if (!downloadParam) {
      throw new Error('微信 CDN 上传响应缺少 x-encrypted-param 响应头');
    }

    const sendEndpoint = `${baseUrl.replace(/\/$/, '')}/ilink/bot/sendmessage`;
    const clientId = generateClientId();

    const payload = {
      msg: {
        from_user_id: botId || '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken || undefined,
        item_list: [
          {
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: downloadParam,
                aes_key: aeskeyBase64,
                encrypt_type: 1,
              },
              mid_size: filesize,
            },
          },
        ],
      },
      base_info: {
        channel_version: '2.4.10',
        bot_agent: 'OpenClaw',
      },
    };

    const sendResp = await axios.post(sendEndpoint, payload, {
      headers: buildHeaders(botToken),
      timeout: 15000,
    });

    const check = isWeixinResponseValid(sendResp.status, sendResp.data);
    const data = typeof sendResp.data === 'object' && sendResp.data !== null ? sendResp.data : {};

    if (check.ok) {
      addDebugLog('Weixin', 'success', `🖼️ 微信图片消息发送成功 (ID: ${data.message_id || 'ok'})`);
      return { success: true, data, message_id: data.message_id, ret: 0 };
    } else {
      const errMsg = check.errMsg || '图片发送被拒绝';
      addDebugLog('Weixin', 'error', `❌ 微信图片消息发送拒绝: ${errMsg}`, sendResp.data);
      return { success: false, data, error: errMsg, ret: check.errCode };
    }
  } catch (err: any) {
    const detail = err.response?.data || err.message;
    addDebugLog('Weixin', 'error', `❌ 微信图片上传/发送异常: ${err.message}`, detail);
    return { success: false, error: String(detail) };
  }
}

/**
 * 4. Process incoming user WeChat message through shared NL Command Pipeline (M01-M08, A02, A08)
 */
export async function processWeChatMessage(
  userId: number,
  content: string,
  fromUserId: string,
  options?: { dryRun?: boolean; skipImages?: boolean }
): Promise<{
  replyText: string;
  imageBuffer?: Buffer;
  imageKind?: 'week_calendar' | 'todo_list';
  diagnostics?: Record<string, any>;
}> {
  const dryRun = Boolean(options?.dryRun);

  const elig = checkAccountEligibility(userId);
  if (!elig.eligible) {
    return { replyText: `⚠️ ${elig.message || '账号已被封禁或未启用'}` };
  }

  const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings | undefined;
  if (!settings) {
    return { replyText: '⚠️ 用户未初始化配置' };
  }

  // Verify sender binding when bound (M08)
  if (!dryRun && settings.weixin_user_id && fromUserId && settings.weixin_user_id !== fromUserId) {
    addDebugLog('Weixin', 'warn', `忽略非绑定发件人消息: userId=${userId}, from=${fromUserId}`);
    return {
      replyText: '⚠️ 当前消息发送方与已绑定的微信身份不匹配，操作已拒绝。',
      diagnostics: { rejectedSenderMismatch: true },
    };
  }

  const isFirstActivation = !settings.weixin_activated;
  if (!dryRun) {
    db.prepare(`
      UPDATE user_settings
      SET weixin_activated = 1,
          weixin_last_active_at = ?
      WHERE user_id = ?
    `).run(new Date().toISOString(), userId);
  }

  try {
    return await processNaturalLanguageCommand({
      userId,
      channel: dryRun ? 'debug_sim' : 'weixin_ilink',
      senderId: fromUserId,
      content,
      settings,
      isFirstActivation: dryRun ? false : isFirstActivation,
      dryRun,
      skipImages: options?.skipImages,
    });
  } catch (err: any) {
    addDebugLog('Weixin', 'error', `处理微信指令异常: ${err.message}`, err.stack);
    return {
      replyText: `⚠️ 助手处理出错：${err.message}`,
      diagnostics: { error: err.message },
    };
  }
}

async function deliverWeixinReplyRecord(
  record: {
    id: number;
    user_id: number;
    to_user_id: string;
    context_token?: string | null;
    text_content: string;
    image_kind?: 'week_calendar' | 'todo_list' | null;
    image_base64?: string | null;
    text_sent: number;
    image_sent: number;
  },
  immediateImageBuffer?: Buffer
): Promise<boolean> {
  const elig = checkAccountEligibility(record.user_id);
  if (!elig.eligible) {
    markWeixinReplyFailed({
      replyId: record.id,
      errorMessage: `account_ineligible:${elig.reason}`,
      textSent: Boolean(record.text_sent),
      imageSent: Boolean(record.image_sent),
      terminal: true,
    });
    return false;
  }

  const settings = db
    .prepare('SELECT * FROM user_settings WHERE user_id = ?')
    .get(record.user_id) as UserSettings | undefined;
  if (!settings || !settings.weixin_connected || !settings.weixin_bot_token) {
    markWeixinReplyFailed({
      replyId: record.id,
      errorMessage: '微信未连接或缺少 bot_token',
      textSent: Boolean(record.text_sent),
      imageSent: Boolean(record.image_sent),
      terminal: true,
    });
    return false;
  }

  const baseUrl = settings.weixin_base_url || FIXED_BASE_URL;
  const botToken = settings.weixin_bot_token;
  const botId = settings.weixin_bot_id || '';
  const activeContextToken =
    record.context_token || contextTokenMap.get(record.user_id) || settings.weixin_context_token || undefined;

  let textSent = Boolean(record.text_sent);
  let imageSent = Boolean(record.image_sent);
  let providerMsgId: string | undefined;

  if (!textSent) {
    const textRes = await sendWeixinTextMessage(
      baseUrl,
      botToken,
      botId,
      record.to_user_id,
      record.text_content,
      activeContextToken
    );
    if (!textRes.success) {
      const expired = isCredentialExpiredCode(textRes.ret);
      if (expired) {
        markWeixinRebindRequired(record.user_id, 'sendmessage -14');
      }
      markWeixinReplyFailed({
        replyId: record.id,
        errorMessage: textRes.error || '文本消息发送失败',
        textSent: false,
        imageSent,
        terminal: expired,
      });
      return false;
    }
    textSent = true;
    providerMsgId = textRes.message_id ? String(textRes.message_id) : undefined;
  }

  if (!imageSent) {
    let imgBuf = immediateImageBuffer;
    if (!imgBuf) {
      if (record.image_kind === 'week_calendar') {
        imgBuf = await renderWeekCalendarImage(record.user_id);
      } else if (record.image_kind === 'todo_list') {
        imgBuf = await renderTodoListImage(record.user_id);
      } else if (record.image_base64) {
        imgBuf = Buffer.from(record.image_base64, 'base64');
      }
    }

    if (imgBuf) {
      const imgRes = await sendWeixinImageMessage(
        baseUrl,
        botToken,
        botId,
        record.to_user_id,
        imgBuf,
        activeContextToken
      );
      if (!imgRes.success) {
        const expired = isCredentialExpiredCode(imgRes.ret);
        if (expired) {
          markWeixinRebindRequired(record.user_id, 'sendmessage image -14');
        }
        markWeixinReplyFailed({
          replyId: record.id,
          errorMessage: imgRes.error || '图片消息发送失败',
          textSent,
          imageSent: false,
          terminal: expired,
        });
        return false;
      }
      providerMsgId = providerMsgId || (imgRes.message_id ? String(imgRes.message_id) : undefined);
    }
    imageSent = true;
  }

  markWeixinReplySent(record.id, providerMsgId, textSent, imageSent);
  return true;
}

export async function processPendingWeixinReplies(
  now: Date = new Date(),
  leaseOwner: string = `wx-reply-${process.pid}`
): Promise<{ processed: number; sent: number; failed: number }> {
  const due = claimDueWeixinReplies(leaseOwner, now, 20, 45);
  let sent = 0;
  let failed = 0;
  for (const rec of due) {
    try {
      const ok = await deliverWeixinReplyRecord(rec);
      if (ok) sent++;
      else failed++;
    } catch (err: any) {
      markWeixinReplyFailed({
        replyId: rec.id,
        errorMessage: err?.message || '回复投递异常',
        textSent: Boolean(rec.text_sent),
        imageSent: Boolean(rec.image_sent),
      });
      failed++;
    }
  }
  return { processed: due.length, sent, failed };
}

/**
 * 5. Isolated Background Transit Worker Manager
 */
class WeixinTransitManager {
  private activeWorkers = new Map<
    number,
    {
      gen: number;
      abortController: AbortController;
      running: boolean;
      startedAt: number;
      lastPollAt: number;
      lastError?: string;
    }
  >();
  private workerSeq = 1;
  private drainingUsers = new Set<number>();
  private drainQueuedUsers = new Set<number>();

  private isWorkerCurrent(userId: number, gen: number, signal: AbortSignal): boolean {
    if (signal.aborted) return false;
    const w = this.activeWorkers.get(userId);
    return Boolean(w && w.running && w.gen === gen);
  }

  public startWorker(userId: number) {
    this.stopWorker(userId);

    const elig = checkAccountEligibility(userId);
    if (!elig.eligible) {
      return;
    }

    const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings | undefined;
    if (!settings || !settings.weixin_connected || !settings.weixin_bot_token) {
      return;
    }

    const abortController = new AbortController();
    const now = Date.now();
    const gen = this.workerSeq++;
    this.activeWorkers.set(userId, {
      gen,
      abortController,
      running: true,
      startedAt: now,
      lastPollAt: now,
    });

    addDebugLog(
      'Weixin',
      'info',
      `🚀 启动用户 #${userId} 的微信独立轮询管道 (WxUser: ${settings.weixin_user_id || 'unnamed'})`
    );
    this.scheduleDrain(userId);
    this.runLongPollLoop(userId, abortController.signal, gen);
  }

  public stopWorker(userId: number) {
    const worker = this.activeWorkers.get(userId);
    if (worker) {
      worker.running = false;
      worker.abortController.abort();
      this.activeWorkers.delete(userId);
      addDebugLog('Weixin', 'info', `🛑 已停止用户 #${userId} 的微信轮询管道`);
    }
  }

  public startAllActiveWorkers() {
    const connectedUsers = db.prepare(`
      SELECT us.user_id
      FROM user_settings us
      JOIN users u ON u.id = us.user_id
      WHERE u.status = 'approved'
        AND us.weixin_connected = 1
        AND us.weixin_bot_token != ''
    `).all() as { user_id: number }[];

    addDebugLog('Weixin', 'info', `🌟 初始化多租户微信轮询: 共 ${connectedUsers.length} 位已连接用户`);
    for (const u of connectedUsers) {
      this.startWorker(u.user_id);
    }
  }

  public getWorkerStatusList() {
    const allSettings = db.prepare(`
      SELECT us.*, u.username, u.role, u.status as account_status, u.balance
      FROM user_settings us
      JOIN users u ON us.user_id = u.id
      ORDER BY us.user_id ASC
    `).all() as (UserSettings & { username: string; role: string; account_status: string; balance?: number })[];

    return allSettings.map((s) => {
      const worker = this.activeWorkers.get(s.user_id);
      const llmConfig = getEffectiveLlmConfig(s.user_id, s);
      const nodes = getConfiguredNodes(llmConfig);
      const isLlmConfigured = llmConfig.isOfficial
        ? nodes.length > 0 && Number(s.balance || 0) > 0
        : nodes.length > 0;

      return {
        userId: s.user_id,
        username: s.username,
        role: s.role,
        accountStatus: s.account_status,
        apiMode: llmConfig.apiMode,
        balance: Number(s.balance || 0),
        weixinConnected: Boolean(s.weixin_connected),
        weixinStatus: s.weixin_status || (s.weixin_connected ? 'connected' : 'disconnected'),
        weixinBotId: s.weixin_bot_id || '',
        weixinUserId: s.weixin_user_id || '',
        weixinBaseUrl: s.weixin_base_url || FIXED_BASE_URL,
        hasBotToken: Boolean(s.weixin_bot_token && s.weixin_bot_token.length > 5),
        hasSyncBuf: Boolean(s.weixin_sync_buf),
        hasContextToken: Boolean(s.weixin_context_token || contextTokenMap.has(s.user_id)),
        hasLlmKey: isLlmConfigured,
        workerRunning: Boolean(worker?.running),
        startedAt: worker?.startedAt ? new Date(worker.startedAt).toISOString() : null,
        lastPollAt: worker?.lastPollAt ? new Date(worker.lastPollAt).toISOString() : null,
        lastError: worker?.lastError,
      };
    });
  }

  public resetSyncBuf(userId: number) {
    db.prepare('UPDATE user_settings SET weixin_sync_buf = "" WHERE user_id = ?').run(userId);
    addDebugLog('Weixin', 'info', `用户 #${userId} 的 weixin_sync_buf 已重置为初始状态`);
    this.startWorker(userId);
  }

  private scheduleDrain(userId: number) {
    if (this.drainingUsers.has(userId)) {
      this.drainQueuedUsers.add(userId);
      return;
    }
    this.drainingUsers.add(userId);
    void (async () => {
      try {
        do {
          this.drainQueuedUsers.delete(userId);
          await this.drainPendingInbox(userId);
        } while (this.drainQueuedUsers.has(userId));
      } catch (err: any) {
        addDebugLog('Weixin', 'error', `[用户 #${userId}] 异步处理队列异常: ${err?.message || err}`);
      } finally {
        this.drainingUsers.delete(userId);
      }
    })();
  }

  private async drainPendingInbox(userId: number): Promise<void> {
    const pending = listPendingWeixinInboxItems(userId);
    for (const item of pending) {
      const claimStatus = claimWeixinInboxItem(item.inboxId, 90);
      if (claimStatus !== 'claimed') continue;

      const settings = db
        .prepare('SELECT * FROM user_settings WHERE user_id = ?')
        .get(userId) as UserSettings | undefined;
      if (!settings || !settings.weixin_connected || !settings.weixin_bot_token) {
        failCommandInbox(item.inboxId, '微信未连接');
        continue;
      }

      try {
        let replyText = '';
        let imageBuffer: Buffer | undefined;
        let imageKind: 'week_calendar' | 'todo_list' | undefined;

        if (!item.text.trim() && item.nonTextTypes && item.nonTextTypes.length > 0) {
          replyText =
            '💡 目前暂只支持文字消息指令，无法直接识别语音、图片或文件。\n请直接发送文字告诉我您的安排，或回复「帮助」查看示例。';
        } else {
          const result = await processWeChatMessage(userId, item.text, item.senderId);
          replyText = result.replyText;
          imageBuffer = result.imageBuffer;
          imageKind = result.imageKind;
        }

        const activeContextToken =
          item.contextToken || contextTokenMap.get(userId) || settings.weixin_context_token || undefined;
        const customImageBase64 = !imageKind && imageBuffer ? imageBuffer.toString('base64') : null;

        // 业务结果完成与回复出箱原子落库；若后续发送失败，后台 15s Worker 会自动重试
        const replyId = db.transaction(() => {
          completeCommandInbox(item.inboxId, {
            replyText,
            hasImage: Boolean(imageBuffer || imageKind),
            imageKind: imageKind || null,
          });
          return enqueueWeixinReply({
            userId,
            inboxId: item.inboxId,
            toUserId: item.senderId,
            contextToken: activeContextToken,
            textContent: replyText,
            imageKind: imageKind || null,
            imageBase64: customImageBase64,
          });
        })();

        const claimedReply = claimSingleWeixinReply(replyId, `wx-imm-${process.pid}`, 45);
        if (claimedReply) {
          await deliverWeixinReplyRecord(claimedReply, imageBuffer);
        }
      } catch (err: any) {
        failCommandInbox(item.inboxId, err.message || '处理异常');
      }
    }
  }

  private async runLongPollLoop(userId: number, signal: AbortSignal, gen: number) {
    while (this.isWorkerCurrent(userId, gen, signal)) {
      const elig = checkAccountEligibility(userId);
      if (!elig.eligible) {
        if (this.isWorkerCurrent(userId, gen, signal)) this.stopWorker(userId);
        break;
      }

      const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings | undefined;
      if (!settings || !settings.weixin_connected || !settings.weixin_bot_token) {
        if (this.isWorkerCurrent(userId, gen, signal)) this.stopWorker(userId);
        break;
      }

      const worker = this.activeWorkers.get(userId);
      if (worker && worker.gen === gen) {
        worker.lastPollAt = Date.now();
      }

      const baseUrl = settings.weixin_base_url || FIXED_BASE_URL;
      const botToken = settings.weixin_bot_token;
      const botId = settings.weixin_bot_id || '';
      const syncBuf = settings.weixin_sync_buf || '';

      try {
        const url = `${baseUrl.replace(/\/$/, '')}/ilink/bot/getupdates`;
        const resp = await axios.post(
          url,
          {
            get_updates_buf: syncBuf,
            base_info: {
              channel_version: '2.4.10',
              bot_agent: 'OpenClaw',
            },
          },
          {
            headers: buildHeaders(botToken),
            timeout: 35000,
            signal,
          }
        );

        if (!this.isWorkerCurrent(userId, gen, signal)) break;

        const data = resp.data || {};
        const isApiError =
          (data.ret !== undefined && data.ret !== 0) ||
          (data.errcode !== undefined && data.errcode !== 0);

        if (isApiError) {
          const errCode = data.errcode ?? data.ret;
          const errMsg = data.errmsg || '';
          if (worker && worker.gen === gen) worker.lastError = `ret=${errCode} errmsg=${errMsg}`;
          addDebugLog('Weixin', 'warn', `[用户 #${userId}] getupdates 返回错误码: ${errCode} (${errMsg})`);
          if (isCredentialExpiredCode(errCode)) {
            markWeixinRebindRequired(userId, `getupdates ${errCode}`);
            break;
          }
          await new Promise((r) => setTimeout(r, 4000));
          continue;
        }

        if (worker && worker.gen === gen) worker.lastError = undefined;

        const msgs = data.msgs || [];
        const inboundItems: WeixinInboundItem[] = [];

        for (const msg of msgs) {
          const fromUserId = msg.from_user_id;
          if (!fromUserId || fromUserId === botId) continue;

          if (msg.context_token) {
            contextTokenMap.set(userId, msg.context_token);
            db.prepare('UPDATE user_settings SET weixin_context_token = ? WHERE user_id = ?').run(msg.context_token, userId);
          }

          const itemList = msg.item_list || [];
          const rawMsgId = msg.msg_id || msg.msgid || msg.message_id || msg.client_id;
          let hasTextItem = false;
          const nonTextTypes: number[] = [];

          itemList.forEach((item: any, itemIdx: number) => {
            if (item.type === 1 && item.text_item?.text) {
              const userText = item.text_item.text.trim();
              if (!userText) return;
              hasTextItem = true;
              const externalMsgId = rawMsgId
                ? `${rawMsgId}:${itemIdx}`
                : `wx:${crypto.createHash('sha256').update(`${syncBuf}:${fromUserId}:${itemIdx}:${userText}`).digest('hex').slice(0, 24)}`;
              inboundItems.push({
                externalMsgId,
                senderId: fromUserId,
                text: userText,
                contextToken: msg.context_token,
              });
            } else if (item?.type && item.type !== 1) {
              nonTextTypes.push(Number(item.type));
            }
          });

          if (!hasTextItem && nonTextTypes.length > 0) {
            const externalMsgId = rawMsgId
              ? `${rawMsgId}:nontext`
              : `wx-nt:${crypto.createHash('sha256').update(`${syncBuf}:${fromUserId}:${nonTextTypes.join(',')}`).digest('hex').slice(0, 24)}`;
            inboundItems.push({
              externalMsgId,
              senderId: fromUserId,
              text: '',
              contextToken: msg.context_token,
              nonTextTypes,
            });
          }
        }

        // Persist entire batch to command_inbox AND advance sync_buf in one atomic transaction (M02)
        const nextBuf = data.get_updates_buf && data.get_updates_buf !== syncBuf ? data.get_updates_buf : null;
        if (inboundItems.length > 0 || nextBuf) {
          persistWeixinPollBatch({
            userId,
            botId,
            nextSyncBuf: nextBuf,
            items: inboundItems,
          });
        }

        if (inboundItems.length > 0) {
          this.scheduleDrain(userId);
        }
      } catch (err: any) {
        if (!this.isWorkerCurrent(userId, gen, signal)) break;
        if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
          continue;
        }
        if (worker && worker.gen === gen) worker.lastError = err.message;
        addDebugLog('Weixin', 'warn', `[用户 #${userId}] 微信轮询连接异常: ${err.message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
}

export const weixinTransitManager = new WeixinTransitManager();
