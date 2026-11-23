import crypto from 'node:crypto';
import axios from 'axios';
import { db } from '../config/database.js';
import { UserSettings } from '../models/types.js';
import { getEffectiveLlmConfig, getConfiguredNodes } from './llm.js';
import { addDebugLog } from './debugLogger.js';
import { checkAccountEligibility } from './accountService.js';
import {
  claimCommandInbox,
  completeCommandInbox,
  failCommandInbox,
  listPendingWeixinInboxItems,
  persistWeixinPollBatch,
  type WeixinInboundItem,
} from './inboxService.js';
import { processNaturalLanguageCommand } from './nlCommandService.js';

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
  contextToken?: string
): Promise<{ success: boolean; data?: any; error?: string; message_id?: string; ret?: number }> {
  if (!botToken || !toUserId) {
    return { success: false, error: '缺少 botToken 或 toUserId' };
  }

  const clientId = generateClientId();
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

    const data = resp.data || {};
    const isError =
      (data.ret !== undefined && data.ret !== 0) ||
      (data.errcode !== undefined && data.errcode !== 0);

    if (!isError) {
      addDebugLog('Weixin', 'success', `✅ 微信消息发送成功 (ID: ${data.message_id || 'ok'})`);
      return { success: true, data, message_id: data.message_id, ret: 0 };
    } else {
      const errMsg = data.errmsg || `ret=${data.ret ?? data.errcode ?? 'unknown'}`;
      addDebugLog('Weixin', 'error', `❌ 微信消息发送拒绝: ${errMsg}`, data);
      return { success: false, data, error: errMsg, ret: data.ret ?? data.errcode };
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
): Promise<{ success: boolean; data?: any; error?: string; message_id?: string }> {
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

    const data = sendResp.data || {};
    const isError =
      (data.ret !== undefined && data.ret !== 0) ||
      (data.errcode !== undefined && data.errcode !== 0);

    if (!isError) {
      return { success: true, data, message_id: data.message_id };
    } else {
      const errMsg = data.errmsg || `ret=${data.ret ?? data.errcode}`;
      return { success: false, data, error: errMsg };
    }
  } catch (err: any) {
    const detail = err.response?.data || err.message;
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
          weixin_last_active_at = datetime('now', 'localtime')
      WHERE user_id = ?
    `).run(userId);
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

/**
 * 5. Isolated Background Transit Worker Manager
 */
class WeixinTransitManager {
  private activeWorkers = new Map<
    number,
    {
      abortController: AbortController;
      running: boolean;
      startedAt: number;
      lastPollAt: number;
      lastError?: string;
    }
  >();

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
    this.activeWorkers.set(userId, {
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
    this.runLongPollLoop(userId, abortController.signal);
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

  private async drainPendingInbox(userId: number, settings: UserSettings): Promise<void> {
    const pending = listPendingWeixinInboxItems(userId);
    for (const item of pending) {
      const claim = claimCommandInbox({
        userId,
        channel: 'weixin_ilink',
        channelAccountId: settings.weixin_bot_id || '',
        senderId: item.senderId,
        externalMsgId: `wx-exec-${item.inboxId}`,
        payload: { senderId: item.senderId, text: item.text },
      });
      if (claim.kind !== 'claimed') continue;

      try {
        const { replyText, imageBuffer } = await processWeChatMessage(userId, item.text, item.senderId);
        const baseUrl = settings.weixin_base_url || FIXED_BASE_URL;
        const botToken = settings.weixin_bot_token || '';
        const botId = settings.weixin_bot_id || '';
        const activeContextToken = item.contextToken || contextTokenMap.get(userId) || settings.weixin_context_token;

        const textRes = await sendWeixinTextMessage(
          baseUrl,
          botToken,
          botId,
          item.senderId,
          replyText,
          activeContextToken
        );

        let imageOk = true;
        if (imageBuffer) {
          const imgRes = await sendWeixinImageMessage(
            baseUrl,
            botToken,
            botId,
            item.senderId,
            imageBuffer,
            activeContextToken
          );
          imageOk = imgRes.success;
        }

        // Mark both the polled inbox row and execution guard completed
        completeCommandInbox(item.inboxId, { replyText, textSent: textRes.success, imageSent: imageOk });
        completeCommandInbox(claim.inboxId, { replyText, textSent: textRes.success, imageSent: imageOk });
      } catch (err: any) {
        failCommandInbox(item.inboxId, err.message || '处理异常');
        failCommandInbox(claim.inboxId, err.message || '处理异常');
      }
    }
  }

  private async runLongPollLoop(userId: number, signal: AbortSignal) {
    while (!signal.aborted) {
      const elig = checkAccountEligibility(userId);
      if (!elig.eligible) {
        this.stopWorker(userId);
        break;
      }

      const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings | undefined;
      if (!settings || !settings.weixin_connected || !settings.weixin_bot_token) {
        this.stopWorker(userId);
        break;
      }

      // First drain any crash-recovered received messages in command_inbox (M02)
      await this.drainPendingInbox(userId, settings);

      const worker = this.activeWorkers.get(userId);
      if (worker) {
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

        const data = resp.data || {};
        const isApiError =
          (data.ret !== undefined && data.ret !== 0) ||
          (data.errcode !== undefined && data.errcode !== 0);

        if (isApiError) {
          const errCode = data.errcode ?? data.ret;
          const errMsg = data.errmsg || '';
          if (worker) worker.lastError = `ret=${errCode} errmsg=${errMsg}`;
          addDebugLog('Weixin', 'warn', `[用户 #${userId}] getupdates 返回错误码: ${errCode} (${errMsg})`);
          if (errCode === -14) {
            // Mark credential expired / rebind_required in DB so status page reflects reality (M05)
            db.prepare(`
              UPDATE user_settings
              SET weixin_connected = 0,
                  weixin_status = 'rebind_required',
                  updated_at = CURRENT_TIMESTAMP
              WHERE user_id = ?
            `).run(userId);
            addDebugLog('Weixin', 'error', `[用户 #${userId}] 微信登录凭证已失效 (errcode -14)，状态已设为待重新绑定`);
            this.stopWorker(userId);
            break;
          }
          await new Promise((r) => setTimeout(r, 4000));
          continue;
        }

        if (worker) worker.lastError = undefined;

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
          itemList.forEach((item: any, itemIdx: number) => {
            if (item.type === 1 && item.text_item?.text) {
              const userText = item.text_item.text.trim();
              if (!userText) return;
              const rawMsgId = msg.msg_id || msg.msgid || msg.message_id || msg.client_id;
              const externalMsgId = rawMsgId
                ? `${rawMsgId}:${itemIdx}`
                : `wx:${crypto.createHash('sha256').update(`${syncBuf}:${fromUserId}:${itemIdx}:${userText}`).digest('hex').slice(0, 24)}`;
              inboundItems.push({
                externalMsgId,
                senderId: fromUserId,
                text: userText,
                contextToken: msg.context_token,
              });
            }
          });
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

        await this.drainPendingInbox(userId, settings);
      } catch (err: any) {
        if (signal.aborted) break;
        if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
          continue;
        }
        if (worker) worker.lastError = err.message;
        addDebugLog('Weixin', 'warn', `[用户 #${userId}] 微信轮询连接异常: ${err.message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
}

export const weixinTransitManager = new WeixinTransitManager();
