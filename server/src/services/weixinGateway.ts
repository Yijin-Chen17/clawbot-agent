import crypto from 'node:crypto';
import axios from 'axios';
import { db } from '../config/database.js';
import { UserSettings, Task, ConversationState, ExternalEvent } from '../models/types.js';
import { parseUserMessageWithLLM } from './llm.js';
import { scheduleTask, replanUserTasks, completeTaskPart, computeTodayBusyMinutes } from './scheduler.js';
import {
  calculateDynamicImportance,
  calculateDynamicUrgency,
  inferTierFromScore,
  normalizeScoreTo100,
  type ImpactSignal,
  type TimeMode,
} from '../utils/priorityAlgorithm.js';
import { syncAllUserSubscriptions } from './calendarSync.js';
import { renderCalendarImage, renderWeekCalendarImage, renderTodoListImage } from './cardRenderer.js';
import { templates } from './clawbot.js';
import { addDebugLog } from './debugLogger.js';

const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com';
const ILINK_APP_ID = 'bot';
const ILINK_CLIENT_VERSION = '132106'; // 2.4.10 encoded: ((2&0xff)<<16)|((4&0xff)<<8)|(10&0xff)
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

/**
 * In-memory context token store: userId -> contextToken
 */
const contextTokenMap = new Map<number, string>();

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

  // QR Code expires after 5 minutes
  if (Date.now() - session.startedAt > 5 * 60 * 1000) {
    activeQRSessions.delete(userId);
    return { status: 'expired' };
  }

  const url = `${FIXED_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(session.qrcode)}`;

  try {
    const resp = await axios.get(url, {
      headers: buildHeaders(),
      timeout: 30000, // 30s long poll
    });

    const data = resp.data;
    const status = data.status || 'wait';

    if (status === 'confirmed' && data.bot_token) {
      const botToken = data.bot_token;
      const botId = data.ilink_bot_id || '';
      const wxUserId = data.ilink_user_id || '';
      const baseUrl = data.baseurl || FIXED_BASE_URL;

      // Persist credentials for this user in SQLite
      db.prepare(`
        UPDATE user_settings
        SET
          weixin_connected = 1,
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

      // Start isolated message transit worker for this user
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
 * Matching official OpenClaw Weixin channel wire format
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

  const clientId = `openclaw-weixin-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const url = `${baseUrl.replace(/\/$/, '')}/ilink/bot/sendmessage`;

  const payload = {
    msg: {
      from_user_id: fromBotId || '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2, // MessageType.BOT = 2
      message_state: 2, // MessageState.FINISH = 2
      context_token: contextToken || undefined,
      item_list: [
        {
          type: 1, // MessageItemType.TEXT = 1
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
    addDebugLog('Weixin', 'info', `🚀 下发消息至微信用户: ${toUserId.slice(0, 16)}...`, {
      clientId,
      hasContextToken: Boolean(contextToken),
      preview: text.length > 80 ? text.slice(0, 80) + '...' : text,
    });

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

/**
 * Send image card to WeChat user via Tencent CDN
 */
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

    addDebugLog('Weixin', 'info', `🚀 请求微信 CDN 上传凭据 (图片大小: ${Math.round(rawsize / 1024)}KB)`);

    // 1. Get CDN upload URL
    const uploadUrlEndpoint = `${baseUrl.replace(/\/$/, '')}/ilink/bot/getuploadurl`;
    const uploadUrlResp = await axios.post(
      uploadUrlEndpoint,
      {
        filekey,
        media_type: 1, // IMAGE
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

    addDebugLog('Weixin', 'info', `📤 上传密文图片至微信 CDN...`);

    // 2. Upload ciphertext to CDN
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

    addDebugLog('Weixin', 'success', `✅ 微信 CDN 上传成功，正在下发图片卡片...`);

    // 3. Send Image Message to user
    const sendEndpoint = `${baseUrl.replace(/\/$/, '')}/ilink/bot/sendmessage`;
    const clientId = generateClientId();

    const payload = {
      msg: {
        from_user_id: botId || '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        context_token: contextToken || undefined,
        item_list: [
          {
            type: 2, // IMAGE
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
      addDebugLog('Weixin', 'success', `✅ 微信图片下发成功 (ID: ${data.message_id || 'ok'})`);
      return { success: true, data, message_id: data.message_id };
    } else {
      const errMsg = data.errmsg || `ret=${data.ret ?? data.errcode}`;
      addDebugLog('Weixin', 'error', `❌ 微信图片下发拒绝: ${errMsg}`, data);
      return { success: false, data, error: errMsg };
    }
  } catch (err: any) {
    const detail = err.response?.data || err.message;
    addDebugLog('Weixin', 'error', `❌ 微信图片流程异常: ${err.message}`, detail);
    return { success: false, error: String(detail) };
  }
}

/**
 * Build rich WeChat help instructions
 */
function getHelpMessage(isActivation = false): string {
  const prefix = isActivation
    ? `🎉【微信助手激活成功】\n欢迎使用 Clawbot 智能日程管家！\n外部推送通道已打通。\n\n⚠️ 重要须知：根据微信平台规则，外部机器人仅能在您发送消息后的 24 小时内主动下发提醒；请保持每 24 小时至少向我发送一条消息（如回复“查看日历”），以确保每日规划与任务提醒准时送达。\n\n`
    : `📖【Clawbot 微信使用指南与指令集】\n\n`;

  return (
    prefix +
    `📅【查询日程与日历】\n` +
    `• 发送“查看日历”/“日历”/“周日历”：获取完整周 24小时亮色日程网格图\n` +
    `• 发送“查看任务”/“待办清单”/“todo”：查看待办事项清单图\n` +
    `• 发送“重新排程”/“智能排程”：按最新紧急度与时间自动重排\n\n` +
    `✏️【智能添加任务】\n` +
    `• 常规任务：如“明天下午写代码2小时，重要且紧急，周三前交”\n` +
    `• 固定任务：如“安排固定任务 明天下午2点到4点部门开会”（固定时段，不参与自动重排）\n` +
    `• 双线程任务：如“安排双线程任务 听英文播客1小时”（允许与其他日程时间重叠）\n` +
    `• 长期/考试任务：如“15天后期末考复习20小时”（系统将自动按每天1~2小时均衡分段并在截止前完成）\n\n` +
    `🔄【任务修改与删除】\n` +
    `• 删除：发送“删除任务 开会”或“删掉下午的复习”\n` +
    `• 修改：发送“把明天的复习改成固定任务：明天上午10点”或“把周报时长改成1小时”\n` +
    `• 分段完成：发送“完成任务 [名称]”或“完成第1段任务”（自动扣减总耗时，如 5h-2h=3h）\n` +
    `• 延长时长：发送“时间不够，延半小时”\n\n` +
    `💡 提示：随时回复“help”或“帮助”可重新查看本指令清单。`
  );
}

/**
 * 4. Process incoming user WeChat message through LLM & Scheduler
 */
export async function processWeChatMessage(
  userId: number,
  content: string,
  fromUserId: string
): Promise<{
  replyText: string;
  imageBuffer?: Buffer;
  diagnostics?: Record<string, any>;
}> {
  const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings;
  if (!settings) {
    return { replyText: '⚠️ 用户未初始化配置' };
  }

  addDebugLog('Weixin', 'info', `📩 接收到微信用户 #${userId} 文本: "${content}"`);

  // Track activation & last active timestamp for 24h interactive window
  const isFirstActivation = !settings.weixin_activated;
  db.prepare(`
    UPDATE user_settings
    SET weixin_activated = 1,
        weixin_last_active_at = datetime('now', 'localtime')
    WHERE user_id = ?
  `).run(userId);

  const trimmed = content.trim();

  // First message activation welcome
  if (isFirstActivation) {
    addDebugLog('Weixin', 'success', `🎉 用户 #${userId} 发送首条消息完成激活`);
    return {
      replyText: getHelpMessage(true),
      diagnostics: { intent: 'activation' },
    };
  }

  // Help command
  if (
    trimmed.toLowerCase() === 'help' ||
    trimmed === '帮助' ||
    trimmed === '查看帮助' ||
    trimmed === '指令' ||
    trimmed === '指令集' ||
    trimmed === '使用指南' ||
    trimmed === '使用方法' ||
    trimmed === '菜单' ||
    trimmed.toLowerCase() === '/help'
  ) {
    return {
      replyText: getHelpMessage(false),
      diagnostics: { intent: 'help' },
    };
  }

  // 1. Direct Trigger Command: "查看日历" / "今日日程" / "刷新日历" / "我的日历" / "周日历" / "本周日历"
  if (
    trimmed === '查看日历' ||
    trimmed === '日历' ||
    trimmed === '今日日历' ||
    trimmed === '今日日程' ||
    trimmed === '查看日程' ||
    trimmed === '刷新日历' ||
    trimmed === '我的日历' ||
    trimmed === '日程安排' ||
    trimmed === '周日历' ||
    trimmed === '查看周日历' ||
    trimmed === '本周日历' ||
    trimmed === '本周日程' ||
    trimmed === '一周日程' ||
    trimmed.includes('查看日历') ||
    trimmed.includes('周日历')
  ) {
    addDebugLog('Weixin', 'info', `[用户 #${userId}] 触发指令: 查看完整周日历并刷新`);
    const syncRes = await syncAllUserSubscriptions(userId);
    const replanRes = replanUserTasks(userId);
    let imageBuffer: Buffer | undefined;
    try {
      imageBuffer = await renderWeekCalendarImage(userId);
    } catch (e: any) {
      addDebugLog('Weixin', 'error', `生成完整周日历图片失败: ${e.message}`);
    }

    const replyText =
      `📅 日历已更新 (外部日程 ${syncRes.totalEvents} 项 / 待办 ${replanRes.scheduledCount} 项)` +
      (imageBuffer ? ' 👇' : '');

    return {
      replyText,
      imageBuffer,
      diagnostics: { intent: 'view_calendar', syncRes, replanRes },
    };
  }

  // 2. Direct Trigger Command: "查看任务" / "待办清单" / "todo" / "tudo"
  if (
    trimmed === '查看任务' ||
    trimmed === '任务' ||
    trimmed === '我的待办' ||
    trimmed === '待办清单' ||
    trimmed === '任务清单' ||
    trimmed.toLowerCase() === 'todo' ||
    trimmed.toLowerCase() === 'todolist' ||
    trimmed.toLowerCase() === 'tudo' ||
    trimmed.includes('查看任务') ||
    trimmed.includes('待办清单')
  ) {
    addDebugLog('Weixin', 'info', `[用户 #${userId}] 触发指令: 查看待办任务清单`);
    let imageBuffer: Buffer | undefined;
    try {
      imageBuffer = await renderTodoListImage(userId);
    } catch (e: any) {
      addDebugLog('Weixin', 'error', `生成待办清单卡片图片失败: ${e.message}`);
    }

    const countRow = db.prepare(`SELECT count(*) as c FROM tasks WHERE user_id = ? AND status IN ('scheduled', 'in_progress', 'pending')`).get(userId) as any;
    const taskCount = countRow?.c || 0;

    const replyText =
      `📝 待办任务清单 (共 ${taskCount} 项)` +
      (imageBuffer ? ' 👇' : '');

    return {
      replyText,
      imageBuffer,
      diagnostics: { intent: 'view_todos', taskCount },
    };
  }

  // 3. Direct Trigger Command: "重新规划" / "重新排程" / "智能重新排程"
  if (
    trimmed === '重新规划' ||
    trimmed === '重新排程' ||
    trimmed === '刷新排程' ||
    trimmed === '更新日历' ||
    trimmed === '智能排程' ||
    trimmed.includes('重新排程') ||
    trimmed.includes('重新规划')
  ) {
    addDebugLog('Weixin', 'info', `[用户 #${userId}] 触发指令: 强制重新排程`);
    await syncAllUserSubscriptions(userId);
    const replanRes = replanUserTasks(userId);
    let imageBuffer: Buffer | undefined;
    try {
      imageBuffer = await renderWeekCalendarImage(userId);
    } catch (e: any) {
      addDebugLog('Weixin', 'error', `生成完整周日历卡片图片失败: ${e.message}`);
    }

    const replyText =
      `🔄 重新排程完成：共规划 ${replanRes.scheduledCount} 项` +
      (imageBuffer ? ' 👇' : '');

    return {
      replyText,
      imageBuffer,
      diagnostics: { intent: 'replan', replanRes },
    };
  }

  // Check multi-turn conversation state
  const existingConv = db.prepare('SELECT * FROM conversation_states WHERE user_id = ?').get(userId) as ConversationState | undefined;
  let pendingTask: any = null;
  let pendingSwapData: any = null;

  if (existingConv && existingConv.pending_task_json) {
    try {
      if (existingConv.current_intent === 'confirm_schedule_swap') {
        pendingSwapData = JSON.parse(existingConv.pending_task_json);
      } else {
        pendingTask = JSON.parse(existingConv.pending_task_json);
      }
    } catch {
      pendingTask = null;
      pendingSwapData = null;
    }
  }

  // 快捷极速识别（纯单字/极短无歧义词优先快速通道）
  const lowerTrimmed = trimmed.toLowerCase();
  const fastConfirm = /^(确认|好的|好|是|是的|同意|改|修改|调整|同步修改|可以|行|行啊|没问题|ok|yes|y)$/i.test(lowerTrimmed);
  const fastReject = /^(保持|不改|不要|不|否|不是|不用|算了|取消|维持原样|维持|原样|不调整|不用调|no|n)$/i.test(lowerTrimmed);

  if (pendingSwapData && pendingSwapData.proposal && pendingSwapData.newTask && (fastConfirm || fastReject)) {
    if (fastConfirm) {
      db.prepare('DELETE FROM conversation_states WHERE user_id = ?').run(userId);
      const { newTask, proposal } = pendingSwapData;
      const prop = proposal;

      // 1. 同步更新被顶替的任务
      db.prepare(`
        UPDATE tasks
        SET scheduled_start = ?,
            scheduled_end = ?,
            schedule_blocks = ?,
            is_fixed = 1,
            status = 'scheduled',
            updated_at = datetime('now', 'localtime')
        WHERE id = ? AND user_id = ?
      `).run(
        prop.conflictTaskSchedule.start,
        prop.conflictTaskSchedule.end,
        prop.conflictTaskSchedule.blocks ? JSON.stringify(prop.conflictTaskSchedule.blocks) : null,
        prop.conflictTask.id,
        userId
      );

      // 2. 插入新任务并锁定
      db.prepare(`
        INSERT INTO tasks (
          user_id, title, duration_minutes, original_duration_minutes, urgency, importance,
          deadline, scheduled_start, scheduled_end, is_fixed, is_concurrent, status, schedule_blocks,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'scheduled', ?, datetime('now', 'localtime'), datetime('now', 'localtime'))
      `).run(
        userId,
        newTask.title,
        newTask.duration,
        newTask.originalDuration || newTask.duration,
        newTask.urgency,
        newTask.importance,
        newTask.deadline || null,
        prop.newTaskSchedule.start,
        prop.newTaskSchedule.end,
        newTask.isConcurrent ? 1 : 0,
        prop.newTaskSchedule.blocks ? JSON.stringify(prop.newTaskSchedule.blocks) : null
      );

      const newS = new Date(prop.newTaskSchedule.start).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
      const newE = new Date(prop.newTaskSchedule.end).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
      const confS = new Date(prop.conflictTaskSchedule.start).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
      const confE = new Date(prop.conflictTaskSchedule.end).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

      const replyText =
        `✅ 已为您同步调整日程并锁定：\n` +
        `1. 「${newTask.title}」已安排：${newS} ~ ${newE}\n` +
        `2. 「${prop.conflictTask.title}」已同步修改至：${confS} ~ ${confE}\n\n` +
        `📌 一旦安排日历，事件均已固定锁定。`;

      addDebugLog('Scheduler', 'success', `用户 #${userId} 快捷确认同步修改日程: ${newTask.title} 替换 ${prop.conflictTask.title}`);
      return { replyText, diagnostics: { intent: 'confirm_schedule_swap', action: 'applied' } };
    } else {
      db.prepare('DELETE FROM conversation_states WHERE user_id = ?').run(userId);
      const { newTask } = pendingSwapData;

      let replyText = '';
      if (newTask.directPlan && newTask.directPlan.start && newTask.directPlan.end) {
        db.prepare(`
          INSERT INTO tasks (
            user_id, title, duration_minutes, original_duration_minutes, urgency, importance,
            deadline, scheduled_start, scheduled_end, is_fixed, is_concurrent, status, schedule_blocks,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'scheduled', ?, datetime('now', 'localtime'), datetime('now', 'localtime'))
        `).run(
          userId,
          newTask.title,
          newTask.duration,
          newTask.originalDuration || newTask.duration,
          newTask.urgency,
          newTask.importance,
          newTask.deadline || null,
          newTask.directPlan.start,
          newTask.directPlan.end,
          newTask.isConcurrent ? 1 : 0,
          newTask.directPlan.blocks || null
        );

        const dStart = new Date(newTask.directPlan.start).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
        const dEnd = new Date(newTask.directPlan.end).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

        replyText =
          `👌 已保持原日程不变。\n` +
          `「${newTask.title}」已安排至其他可用空闲时段：${dStart} ~ ${dEnd}。`;
      } else {
        db.prepare(`
          INSERT INTO tasks (
            user_id, title, duration_minutes, original_duration_minutes, urgency, importance,
            deadline, is_fixed, is_concurrent, status, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'pending_slot', datetime('now', 'localtime'), datetime('now', 'localtime'))
        `).run(
          userId,
          newTask.title,
          newTask.duration,
          newTask.originalDuration || newTask.duration,
          newTask.urgency,
          newTask.importance,
          newTask.deadline || null,
          newTask.isConcurrent ? 1 : 0
        );

        replyText =
          `👌 已保持原日程不变。\n` +
          `由于暂无合适空闲时段，「${newTask.title}」已放入待安排清单。`;
      }

      addDebugLog('Scheduler', 'info', `用户 #${userId} 快捷拒绝调整，保持原日程: ${newTask.title}`);
      return { replyText, diagnostics: { intent: 'confirm_schedule_swap', action: 'kept' } };
    }
  }

  try {
    let parsed: any;
    // Check if user has configured LLM API Key
    if (!settings.llm_api_key || !settings.llm_api_key.trim()) {
      addDebugLog('LLM', 'warn', `用户 #${userId} 未配置 DeepSeek API Key，无法进行语义解析`);
      return {
        replyText:
          `⚠️【系统提醒】您尚未在管理后台配置大模型 API Key。\n` +
          `请登录管理面板（http://${settings.weixin_base_url ? '管理地址' : '5178'}）在「设置」中填入您的 DeepSeek API Key 即可开启智能规划。`,
        diagnostics: { error: '未配置 LLM API Key' },
      };
    }

    parsed = await parseUserMessageWithLLM(content, settings, pendingSwapData || pendingTask);
    addDebugLog('LLM', 'success', `用户 #${userId} 语义解析成功`, parsed);

    // 如果处于日程调整待确认状态，由 LLM 结构化判断返回结果
    if (pendingSwapData && pendingSwapData.proposal && pendingSwapData.newTask) {
      if (parsed.swap_decision === 'confirm') {
        db.prepare('DELETE FROM conversation_states WHERE user_id = ?').run(userId);
        const { newTask, proposal } = pendingSwapData;
        const prop = proposal;

        // 1. 同步更新被顶替的任务
        db.prepare(`
          UPDATE tasks
          SET scheduled_start = ?,
              scheduled_end = ?,
              schedule_blocks = ?,
              is_fixed = 1,
              status = 'scheduled',
              updated_at = datetime('now', 'localtime')
          WHERE id = ? AND user_id = ?
        `).run(
          prop.conflictTaskSchedule.start,
          prop.conflictTaskSchedule.end,
          prop.conflictTaskSchedule.blocks ? JSON.stringify(prop.conflictTaskSchedule.blocks) : null,
          prop.conflictTask.id,
          userId
        );

        // 2. 插入新任务并锁定
        db.prepare(`
          INSERT INTO tasks (
            user_id, title, duration_minutes, original_duration_minutes, urgency, importance,
            deadline, scheduled_start, scheduled_end, is_fixed, is_concurrent, status, schedule_blocks,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'scheduled', ?, datetime('now', 'localtime'), datetime('now', 'localtime'))
        `).run(
          userId,
          newTask.title,
          newTask.duration,
          newTask.originalDuration || newTask.duration,
          newTask.urgency,
          newTask.importance,
          newTask.deadline || null,
          prop.newTaskSchedule.start,
          prop.newTaskSchedule.end,
          newTask.isConcurrent ? 1 : 0,
          prop.newTaskSchedule.blocks ? JSON.stringify(prop.newTaskSchedule.blocks) : null
        );

        const newS = new Date(prop.newTaskSchedule.start).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
        const newE = new Date(prop.newTaskSchedule.end).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
        const confS = new Date(prop.conflictTaskSchedule.start).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
        const confE = new Date(prop.conflictTaskSchedule.end).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

        const replyText =
          `✅ 已为您同步调整日程并锁定：\n` +
          `1. 「${newTask.title}」已安排：${newS} ~ ${newE}\n` +
          `2. 「${prop.conflictTask.title}」已同步修改至：${confS} ~ ${confE}\n\n` +
          `📌 一旦安排日历，事件均已固定锁定。`;

        addDebugLog('Scheduler', 'success', `LLM 判定用户同意调整日程: ${newTask.title} 替换 ${prop.conflictTask.title}`);
        return { replyText, diagnostics: { intent: 'confirm_schedule_swap', action: 'applied', parsed } };
      } else if (parsed.swap_decision === 'reject') {
        db.prepare('DELETE FROM conversation_states WHERE user_id = ?').run(userId);
        const { newTask } = pendingSwapData;

        let replyText = '';
        if (newTask.directPlan && newTask.directPlan.start && newTask.directPlan.end) {
          db.prepare(`
            INSERT INTO tasks (
              user_id, title, duration_minutes, original_duration_minutes, urgency, importance,
              score_scale, deadline, scheduled_start, scheduled_end, is_fixed, is_concurrent, status, schedule_blocks,
              created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 100, ?, ?, ?, 1, ?, 'scheduled', ?, datetime('now', 'localtime'), datetime('now', 'localtime'))
          `).run(
            userId,
            newTask.title,
            newTask.duration,
            newTask.originalDuration || newTask.duration,
            newTask.urgency,
            newTask.importance,
            newTask.deadline || null,
            newTask.directPlan.start,
            newTask.directPlan.end,
            newTask.isConcurrent ? 1 : 0,
            newTask.directPlan.blocks || null
          );

          const dStart = new Date(newTask.directPlan.start).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
          const dEnd = new Date(newTask.directPlan.end).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

          replyText =
            `👌 已保持原日程不变。\n` +
            `「${newTask.title}」已安排至其他可用空闲时段：${dStart} ~ ${dEnd}。`;
        } else {
          db.prepare(`
            INSERT INTO tasks (
              user_id, title, duration_minutes, original_duration_minutes, urgency, importance,
              score_scale, deadline, is_fixed, is_concurrent, status, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 100, ?, 0, ?, 'pending_slot', datetime('now', 'localtime'), datetime('now', 'localtime'))
          `).run(
            userId,
            newTask.title,
            newTask.duration,
            newTask.originalDuration || newTask.duration,
            newTask.urgency,
            newTask.importance,
            newTask.deadline || null,
            newTask.isConcurrent ? 1 : 0
          );

          replyText =
            `👌 已保持原日程不变。\n` +
            `由于暂无合适空闲时段，「${newTask.title}」已放入待安排清单。`;
        }

        addDebugLog('Scheduler', 'info', `LLM 判定用户拒绝调整，保持原日程: ${newTask.title}`);
        return { replyText, diagnostics: { intent: 'confirm_schedule_swap', action: 'kept', parsed } };
      } else {
        // 用户发送了其它新指令 (swap_decision === 'other' 或其他意图)：
        // 自动清除待确认状态，无缝流转处理新请求
        db.prepare('DELETE FROM conversation_states WHERE user_id = ?').run(userId);
        addDebugLog('Scheduler', 'info', `LLM 判定用户在日程确认中发送了新指令 (intent: ${parsed.intent}, swap_decision: ${parsed.swap_decision})，自动清除待确认状态，直接流转执行新请求`);
      }
    }

    if (parsed.intent === 'status_update') {
      db.prepare('DELETE FROM conversation_states WHERE user_id = ?').run(userId);
      const action = parsed.status_action || 'complete';

      let activeTask: Task | undefined;
      if (parsed.target_task_name) {
        activeTask = db.prepare(`
          SELECT * FROM tasks
          WHERE user_id = ? AND title LIKE ? AND status IN ('scheduled', 'in_progress', 'pending_slot')
          ORDER BY id DESC LIMIT 1
        `).get(userId, `%${parsed.target_task_name}%`) as Task | undefined;
      }
      if (!activeTask) {
        activeTask = db.prepare(`
          SELECT * FROM tasks
          WHERE user_id = ? AND status IN ('scheduled', 'in_progress')
          ORDER BY CASE status WHEN 'in_progress' THEN 1 ELSE 2 END, scheduled_start ASC
          LIMIT 1
        `).get(userId) as Task | undefined;
      }

      if (!activeTask) {
        const reply = '当前没有正在进行或排程中的待办任务。';
        return { replyText: reply, diagnostics: { intent: parsed.intent, parsed } };
      }

      if (action === 'complete_part') {
        const partIdx = parsed.completed_part_index ?? undefined;
        const compMin = parsed.completed_minutes ?? undefined;
        const res = completeTaskPart(userId, activeTask.id, compMin, partIdx);
        addDebugLog('Scheduler', 'success', `待办 #${activeTask.id} (${activeTask.title}) 完成部分分段: 剩余 ${res.remainingMinutes}m`);
        return { replyText: res.message, diagnostics: { intent: parsed.intent, parsed, res } };
      } else if (action === 'complete') {
        db.prepare("UPDATE tasks SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(activeTask.id);
        const reply = templates.taskCompleted(activeTask.title);
        addDebugLog('Scheduler', 'success', `待办 #${activeTask.id} (${activeTask.title}) 标记为已完成`);
        return { replyText: reply, diagnostics: { intent: parsed.intent, parsed, action: 'completed' } };
      } else if (action === 'extend') {
        const extMin = parsed.extend_minutes || 30;
        const currentEnd = new Date(activeTask.scheduled_end || new Date());
        const newEnd = new Date(currentEnd.getTime() + extMin * 60 * 1000);
        const newEndStr = newEnd.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

        db.prepare(`
          UPDATE tasks
          SET scheduled_end = ?, duration_minutes = duration_minutes + ?, end_reminder_sent = 0, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(newEnd.toISOString(), extMin, activeTask.id);

        const reply = templates.taskExtended(activeTask.title, extMin, newEndStr);
        addDebugLog('Scheduler', 'info', `待办 #${activeTask.id} (${activeTask.title}) 延长 ${extMin}m 至 ${newEndStr}`);
        return { replyText: reply, diagnostics: { intent: parsed.intent, parsed, action: 'extend', extMin } };
      } else if (action === 'reschedule') {
        const plan = scheduleTask(userId, {
          id: activeTask.id,
          title: activeTask.title,
          duration_minutes: activeTask.duration_minutes,
          urgency: activeTask.urgency,
          importance: activeTask.importance,
          deadline: activeTask.deadline,
        });

        if (plan.success && plan.scheduled_start && plan.scheduled_end) {
          db.prepare(`
            UPDATE tasks
            SET scheduled_start = ?, scheduled_end = ?, schedule_blocks = ?, status = 'scheduled', start_reminder_sent = 0, end_reminder_sent = 0, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(plan.scheduled_start, plan.scheduled_end, plan.schedule_blocks || null, activeTask.id);
          replanUserTasks(userId);

          const sStr = new Date(plan.scheduled_start).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
          const eStr = new Date(plan.scheduled_end).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
          const reply = templates.taskRescheduled(activeTask.title, sStr, eStr);
          addDebugLog('Scheduler', 'success', `待办 #${activeTask.id} (${activeTask.title}) 重新排程成功: ${sStr} ~ ${eStr}`);
          return { replyText: reply, diagnostics: { intent: parsed.intent, parsed, plan } };
        } else {
          const reply = `⚠️ 重新安排失败：${plan.message}`;
          return { replyText: reply, diagnostics: { intent: parsed.intent, parsed, plan } };
        }
      } else {
        return { replyText: '已了解您的状态更新。', diagnostics: { intent: parsed.intent, parsed } };
      }
    } else if (parsed.intent === 'delete_item') {
      db.prepare('DELETE FROM conversation_states WHERE user_id = ?').run(userId);
      const targetName = (
        parsed.delete_target?.name ||
        parsed.title ||
        trimmed.replace(/^(删除|取消|删掉|移除)(任务|日程)?/, '').trim()
      );

      if (!targetName) {
        return { replyText: '⚠️ 请说明要删除的任务或日程名称。' };
      }

      // 1. 先查找匹配待办任务
      const matchedTask = db.prepare(`
        SELECT * FROM tasks
        WHERE user_id = ? AND title LIKE ? AND status != 'completed'
        ORDER BY id DESC LIMIT 1
      `).get(userId, `%${targetName}%`) as Task | undefined;

      if (matchedTask) {
        db.prepare('DELETE FROM tasks WHERE id = ?').run(matchedTask.id);
        replanUserTasks(userId);
        addDebugLog('Scheduler', 'success', `用户 #${userId} 删除了任务 #${matchedTask.id} (${matchedTask.title})`);
        return {
          replyText: `🗑️ 已删除任务「${matchedTask.title}」`,
          diagnostics: { intent: 'delete_item', deletedTaskId: matchedTask.id }
        };
      }

      // 2. 查找匹配外部日历日程
      const matchedEvent = db.prepare(`
        SELECT * FROM external_events
        WHERE user_id = ? AND title LIKE ?
        ORDER BY id DESC LIMIT 1
      `).get(userId, `%${targetName}%`) as ExternalEvent | undefined;

      if (matchedEvent) {
        db.prepare('DELETE FROM external_events WHERE id = ?').run(matchedEvent.id);
        replanUserTasks(userId);
        addDebugLog('Scheduler', 'success', `用户 #${userId} 删除了日程 #${matchedEvent.id} (${matchedEvent.title})`);
        return {
          replyText: `🗑️ 已删除日程「${matchedEvent.title}」`,
          diagnostics: { intent: 'delete_item', deletedEventId: matchedEvent.id }
        };
      }

      return {
        replyText: `⚠️ 未找到包含「${targetName}」的任务或日程。`,
        diagnostics: { intent: 'delete_item', targetName, notFound: true }
      };
    } else if (parsed.intent === 'modify_item') {
      db.prepare('DELETE FROM conversation_states WHERE user_id = ?').run(userId);
      const targetName = parsed.modify_target?.name || parsed.target_task_name || parsed.title || '';

      const matchedTask = db.prepare(`
        SELECT * FROM tasks
        WHERE user_id = ? AND title LIKE ? AND status != 'completed'
        ORDER BY id DESC LIMIT 1
      `).get(userId, `%${targetName}%`) as Task | undefined;

      if (!matchedTask) {
        return {
          replyText: `⚠️ 未找到待修改的任务「${targetName}」。您可发送“查看任务”核对现有名称。`,
          diagnostics: { intent: 'modify_item', targetName }
        };
      }

      const mod = parsed.modify_target || {};
      const updates: string[] = [];
      const params: any[] = [];

      if (mod.new_title) {
        updates.push('title = ?');
        params.push(mod.new_title);
      }
      if (mod.new_duration_minutes) {
        updates.push('duration_minutes = ?');
        params.push(mod.new_duration_minutes);
      }
      if (mod.new_deadline) {
        updates.push('deadline = ?');
        params.push(mod.new_deadline);
      }
      if (mod.is_fixed !== undefined && mod.is_fixed !== null) {
        updates.push('is_fixed = ?');
        params.push(mod.is_fixed ? 1 : 0);
      }
      if (mod.is_concurrent !== undefined && mod.is_concurrent !== null) {
        updates.push('is_concurrent = ?');
        params.push(mod.is_concurrent ? 1 : 0);
      }
      if (mod.new_start && mod.new_end) {
        updates.push('scheduled_start = ?', 'scheduled_end = ?', 'is_fixed = 1');
        params.push(mod.new_start, mod.new_end);
      } else if (parsed.fixed_start && parsed.fixed_end) {
        updates.push('scheduled_start = ?', 'scheduled_end = ?', 'is_fixed = 1');
        params.push(parsed.fixed_start, parsed.fixed_end);
      }

      if (updates.length === 0) {
        return { replyText: `💡 已识别到任务「${matchedTask.title}」，但未检测到具体修改内容（可明确说明新时间、新时长或设为固定任务等）。` };
      }

      updates.push("updated_at = datetime('now', 'localtime')");
      params.push(matchedTask.id);

      db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      replanUserTasks(userId);

      const updatedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(matchedTask.id) as Task;
      let extraInfo = '';
      if (updatedTask.is_fixed) {
        extraInfo += `\n• 状态：已设为固定任务（指定时间，不参与自动重排）`;
      }
      if (updatedTask.is_concurrent) {
        extraInfo += `\n• 属性：已设为双线程任务（允许与其他日程重叠）`;
      }
      if (updatedTask.scheduled_start && updatedTask.scheduled_end) {
        extraInfo += `\n• 最新排程：${new Date(updatedTask.scheduled_start).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} ~ ${new Date(updatedTask.scheduled_end).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
      }

      addDebugLog('Scheduler', 'success', `用户 #${userId} 修改了任务 #${matchedTask.id} (${matchedTask.title})`);
      return {
        replyText: `✏️ 已更新任务「${updatedTask.title}」${extraInfo}`,
        diagnostics: { intent: 'modify_item', updatedTask }
      };
    } else if (parsed.intent === 'query_schedule') {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      const todayTasks = db.prepare(`
        SELECT * FROM tasks
        WHERE user_id = ? AND scheduled_start >= ? AND scheduled_start <= ?
        ORDER BY scheduled_start ASC
      `).all(userId, todayStart.toISOString(), todayEnd.toISOString()) as Task[];

      let imageBuffer: Buffer | undefined;
      try {
        imageBuffer = await renderWeekCalendarImage(userId);
      } catch (e: any) {
        addDebugLog('Weixin', 'error', `生成完整周日历图片失败: ${e.message}`);
      }

      const todayStr = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
      const reply = templates.scheduleQueryList(todayTasks, todayStr) + (imageBuffer ? ' 👇' : '');
      addDebugLog('Scheduler', 'info', `查询日程，共找到今日 ${todayTasks.length} 项，并生成完整周日历图片`);
      return { replyText: reply, imageBuffer, diagnostics: { intent: parsed.intent, todayTasksCount: todayTasks.length } };
    } else if (parsed.intent === 'create_task') {
      const title = parsed.title || pendingTask?.title || '未命名任务';
      const duration = parsed.duration_minutes || parsed.estimatedMinutes || pendingTask?.duration_minutes || pendingTask?.estimatedMinutes || null;
      const deadline = parsed.deadline || pendingTask?.deadline || null;
      const dueDate = parsed.dueDate || (deadline ? deadline.split('T')[0] : null) || pendingTask?.dueDate || null;
      const resolvedDeadline = !deadline && dueDate ? `${dueDate}T23:59:59` : deadline;
      const timeMode: TimeMode =
        parsed.time_mode || pendingTask?.time_mode || (resolvedDeadline ? 'deadline' : 'flexible');
      const impactSignals = (parsed.impact_signals || pendingTask?.impact_signals || []) as ImpactSignal[];

      const rawImp = parsed.importance ?? pendingTask?.importance ?? 70;
      let importance = normalizeScoreTo100(rawImp, rawImp <= 10 ? 10 : 100);
      if (parsed.importance_tier) {
        importance = calculateDynamicImportance({
          tier: parsed.importance_tier,
          estimatedMinutes: duration || 60,
          impactSignals,
          isFixed: Boolean(parsed.is_fixed),
        }).importance;
      }
      const importanceTier = parsed.importance_tier || inferTierFromScore(importance);

      const rawUrg = parsed.urgency ?? pendingTask?.urgency ?? null;
      const fallbackUrg = rawUrg !== null ? normalizeScoreTo100(rawUrg, rawUrg <= 10 ? 10 : 100) : 55;
      const urgency =
        resolvedDeadline || dueDate || timeMode === 'daily_fixed'
          ? calculateDynamicUrgency({
              timeMode,
              dueDate: dueDate || resolvedDeadline,
              estimatedMinutes: duration || 30,
              importance,
              scheduledStart: parsed.fixed_start || null,
              scheduledEnd: parsed.fixed_end || null,
              dailyBusyMinutesAhead: computeTodayBusyMinutes(userId),
              fallbackUrgency: fallbackUrg,
            }).urgency
          : fallbackUrg;

      const merged = {
        title,
        duration_minutes: duration,
        urgency,
        importance,
        importance_tier: importanceTier,
        impact_signals: impactSignals,
        time_mode: timeMode,
        deadline: resolvedDeadline,
        dueDate,
      };
      const missing = {
        duration: !duration || duration <= 0,
        deadline: !resolvedDeadline && !dueDate && timeMode !== 'daily_fixed',
        urgency: false, // 紧迫度依据截止期与日程负荷自动推导，不强制追问
        importance: !importance,
      };

      const hasMissing = missing.duration || missing.deadline;

      if (hasMissing) {
        db.prepare(`
          INSERT INTO conversation_states (user_id, current_intent, pending_task_json, missing_fields, updated_at)
          VALUES (?, 'create_task', ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id) DO UPDATE SET
            pending_task_json = excluded.pending_task_json,
            missing_fields = excluded.missing_fields,
            updated_at = CURRENT_TIMESTAMP
        `).run(userId, JSON.stringify(merged), JSON.stringify(missing));

        const reply = templates.askMissingFields(title, missing);
        addDebugLog('LLM', 'info', `任务要素缺失，向用户追问: ${title}`, missing);
        return { replyText: reply, diagnostics: { intent: parsed.intent, merged, missing } };
      } else {
        db.prepare('DELETE FROM conversation_states WHERE user_id = ?').run(userId);

        const isFixed = parsed.is_fixed ? 1 : 0;
        const isConcurrent = parsed.is_concurrent ? 1 : 0;
        const fixedStart = parsed.fixed_start || null;
        const fixedEnd = parsed.fixed_end || null;
        const originalDuration = duration || 60;

        if (isFixed && fixedStart && fixedEnd) {
          const singleBlock = [{ start: fixedStart, end: fixedEnd, duration: duration! }];
          db.prepare(`
            INSERT INTO tasks (
              user_id, title, duration_minutes, original_duration_minutes, urgency, importance,
              importance_tier, impact_signals, time_mode, score_scale,
              deadline, scheduled_start, scheduled_end, is_fixed, is_concurrent, status, schedule_blocks
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 100, ?, ?, ?, ?, ?, 'scheduled', ?)
          `).run(
            userId, title, duration, originalDuration, urgency, importance,
            importanceTier, JSON.stringify(impactSignals), timeMode,
            resolvedDeadline, fixedStart, fixedEnd, 1, isConcurrent, JSON.stringify(singleBlock)
          );

          replanUserTasks(userId);

          const sStr = new Date(fixedStart).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
          const eStr = new Date(fixedEnd).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

          const reply = templates.scheduleSuccess({
            title,
            startStr: sStr,
            endStr: eStr,
            duration: duration!,
            urgency: urgency!,
            importance: importance!,
            blocks: singleBlock,
            isFixed: true,
            isConcurrent: Boolean(isConcurrent),
          });

          return {
            replyText: reply,
            diagnostics: { intent: parsed.intent, fixed: true, task: merged }
          };
        }

        const plan = scheduleTask(userId, {
          title,
          duration_minutes: duration!,
          urgency: urgency!,
          importance: importance!,
          deadline: resolvedDeadline,
        });

        // 如果触发了顶替或有效时间内无法完成的调整建议，提醒用户是否同步修改
        if (plan.proposal) {
          const prop = plan.proposal;
          const conflictTitle = prop.conflictTask.title;

          const oldS = new Date(prop.conflictTask.scheduled_start).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
          const oldE = new Date(prop.conflictTask.scheduled_end).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

          const confNewS = new Date(prop.conflictTaskSchedule.start).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
          const confNewE = new Date(prop.conflictTaskSchedule.end).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

          const newS = new Date(prop.newTaskSchedule.start).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
          const newE = new Date(prop.newTaskSchedule.end).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

          db.prepare(`
            INSERT INTO conversation_states (user_id, current_intent, pending_task_json, missing_fields, updated_at)
            VALUES (?, 'confirm_schedule_swap', ?, NULL, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET
              current_intent = 'confirm_schedule_swap',
              pending_task_json = excluded.pending_task_json,
              missing_fields = NULL,
              updated_at = CURRENT_TIMESTAMP
          `).run(userId, JSON.stringify({
            newTask: {
              title,
              duration: duration!,
              originalDuration,
              urgency: urgency!,
              importance: importance!,
              deadline: resolvedDeadline,
              isConcurrent: Boolean(isConcurrent),
              directPlan: plan.success ? {
                start: plan.scheduled_start,
                end: plan.scheduled_end,
                blocks: plan.schedule_blocks,
              } : null,
            },
            proposal: prop,
          }));

          const replyText =
            `📅【日程调整建议】\n` +
            `新待办「${title}」${prop.reasonText}。\n` +
            `该时段当前已安排「${conflictTitle}」（原定：${oldS} ~ ${oldE}）。\n\n` +
            `💡 建议调整方案：\n` +
            `• 为「${title}」排入：${newS} ~ ${newE}\n` +
            `• 将「${conflictTitle}」同步修改至：${confNewS} ~ ${confNewE}\n\n` +
            `是否确认同步修改「${conflictTitle}」到 ${confNewS} ~ ${confNewE}？\n` +
            `👉 回复【确认】或【好】即可同步修改\n` +
            `👉 回复【保持】或【不改】则保持原日程不变`;

          addDebugLog('Scheduler', 'info', `为用户 #${userId} 提供日程调整/顶替建议: ${title} 顶替 ${conflictTitle}`);
          return { replyText, diagnostics: { intent: parsed.intent, proposal: prop, task: merged } };
        }

        if (plan.success && plan.scheduled_start && plan.scheduled_end) {
          db.prepare(`
            INSERT INTO tasks (
              user_id, title, duration_minutes, original_duration_minutes, urgency, importance,
              importance_tier, impact_signals, time_mode, score_scale,
              deadline, scheduled_start, scheduled_end, is_fixed, is_concurrent, status, schedule_blocks
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 100, ?, ?, ?, 0, ?, 'scheduled', ?)
          `).run(
            userId, title, duration, originalDuration, urgency, importance,
            importanceTier, JSON.stringify(impactSignals), timeMode,
            resolvedDeadline, plan.scheduled_start, plan.scheduled_end, isConcurrent, plan.schedule_blocks || null
          );

          // Dynamically optimize and adjust other pending tasks
          replanUserTasks(userId);

          const updatedTask = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND title = ? ORDER BY id DESC LIMIT 1').get(userId, title) as Task;
          const actualStart = updatedTask?.scheduled_start || plan.scheduled_start;
          const actualEnd = updatedTask?.scheduled_end || plan.scheduled_end;

          let parsedBlocks: any[] = [];
          if (updatedTask?.schedule_blocks) {
            try {
              parsedBlocks = JSON.parse(updatedTask.schedule_blocks);
            } catch {}
          }
          if (!Array.isArray(parsedBlocks) || parsedBlocks.length === 0) {
            if (plan.schedule_blocks) {
              try {
                parsedBlocks = JSON.parse(plan.schedule_blocks);
              } catch {}
            }
          }

          const sStr = new Date(actualStart).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
          const eStr = new Date(actualEnd).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

          const reply = templates.scheduleSuccess({
            title,
            startStr: sStr,
            endStr: eStr,
            duration: duration!,
            urgency: urgency!,
            importance: importance!,
            blocks: parsedBlocks,
            isFixed: true,
            isConcurrent: Boolean(isConcurrent),
          });
          addDebugLog('Scheduler', 'success', `新待办规划排程成功: "${title}" (${sStr} ~ ${eStr})`);
          return { replyText: reply, diagnostics: { intent: parsed.intent, plan, task: merged } };
        } else {
          db.prepare(`
            INSERT INTO tasks (
              user_id, title, duration_minutes, original_duration_minutes, urgency, importance,
              importance_tier, impact_signals, time_mode, score_scale,
              deadline, is_fixed, is_concurrent, status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 100, ?, 0, ?, 'pending_slot')
          `).run(
            userId, title, duration, originalDuration, urgency, importance,
            importanceTier, JSON.stringify(impactSignals), timeMode,
            resolvedDeadline, isConcurrent
          );

          const reply = templates.scheduleFailed(title, duration!, plan.message);
          addDebugLog('Scheduler', 'warn', `新待办规划未找到合适时隙，置为待安排: "${title}" (${plan.message})`);
          return { replyText: reply, diagnostics: { intent: parsed.intent, plan, task: merged } };
        }
      }
    } else {
      return {
        replyText: '💡 未识别到具体日程或任务。可回复“帮助”查看指令。',
        diagnostics: { intent: 'other' }
      };
    }
  } catch (err: any) {
    addDebugLog('Weixin', 'error', `处理微信指令异常: ${err.message}`, err.stack);
    return {
      replyText: `⚠️ 助手处理出错：${err.message}\n请检查管理后台设置中 DeepSeek API Key 是否配置有效。`,
      diagnostics: { error: err.message },
    };
  }
}

/**
 * 5. Isolated Background Transit Worker Manager
 * Multi-tenant: Each user has their own independent long-poll worker!
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
      SELECT user_id FROM user_settings
      WHERE weixin_connected = 1 AND weixin_bot_token != ''
    `).all() as { user_id: number }[];

    addDebugLog('Weixin', 'info', `🌟 初始化多租户微信轮询: 共 ${connectedUsers.length} 位已连接用户`);
    for (const u of connectedUsers) {
      this.startWorker(u.user_id);
    }
  }

  public getWorkerStatusList() {
    const allSettings = db.prepare(`
      SELECT us.*, u.username, u.role
      FROM user_settings us
      JOIN users u ON us.user_id = u.id
      ORDER BY us.user_id ASC
    `).all() as (UserSettings & { username: string; role: string })[];

    return allSettings.map((s) => {
      const worker = this.activeWorkers.get(s.user_id);
      return {
        userId: s.user_id,
        username: s.username,
        role: s.role,
        weixinConnected: Boolean(s.weixin_connected),
        weixinBotId: s.weixin_bot_id || '',
        weixinUserId: s.weixin_user_id || '',
        weixinBaseUrl: s.weixin_base_url || FIXED_BASE_URL,
        hasBotToken: Boolean(s.weixin_bot_token && s.weixin_bot_token.length > 5),
        hasSyncBuf: Boolean(s.weixin_sync_buf),
        hasContextToken: Boolean(s.weixin_context_token || contextTokenMap.has(s.user_id)),
        hasLlmKey: Boolean(s.llm_api_key && s.llm_api_key.length > 3),
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

  private async runLongPollLoop(userId: number, signal: AbortSignal) {
    while (!signal.aborted) {
      const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings | undefined;
      if (!settings || !settings.weixin_connected || !settings.weixin_bot_token) {
        this.stopWorker(userId);
        break;
      }

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
            timeout: 35000, // 35s long-poll
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
            addDebugLog('Weixin', 'error', `[用户 #${userId}] 微信登录凭证已失效 (errcode -14)，请重新在设置中扫码`);
            this.stopWorker(userId);
            break;
          }
          await new Promise((r) => setTimeout(r, 4000));
          continue;
        }

        // Valid successful getupdates poll response
        if (worker) worker.lastError = undefined;

        if (data.get_updates_buf && data.get_updates_buf !== syncBuf) {
          db.prepare('UPDATE user_settings SET weixin_sync_buf = ? WHERE user_id = ?').run(data.get_updates_buf, userId);
        }

        const msgs = data.msgs || [];
        if (msgs.length > 0) {
          addDebugLog('Weixin', 'info', `[用户 #${userId}] 收到 ${msgs.length} 条微信消息更新`);
        }

        for (const msg of msgs) {
          const fromUserId = msg.from_user_id;
          // Ignore messages sent by the bot itself
          if (fromUserId === botId) continue;

          // Cache context_token if present
          if (msg.context_token) {
            contextTokenMap.set(userId, msg.context_token);
            db.prepare('UPDATE user_settings SET weixin_context_token = ? WHERE user_id = ?').run(msg.context_token, userId);
            addDebugLog('Weixin', 'info', `[用户 #${userId}] 更新会话 context_token 成功`);
          }

          const itemList = msg.item_list || [];
          for (const item of itemList) {
            if (item.type === 1 && item.text_item?.text) {
              const userText = item.text_item.text.trim();
              addDebugLog('Weixin', 'info', `📩 微信来信 (用户 #${userId}): "${userText}"`);

              // Process through scheduling pipeline
              const { replyText, imageBuffer } = await processWeChatMessage(userId, userText, fromUserId);

              // Use the context token from msg or memory
              const activeContextToken = msg.context_token || contextTokenMap.get(userId) || settings.weixin_context_token;

              // Send text reply back to user
              await sendWeixinTextMessage(
                baseUrl,
                botToken,
                botId,
                fromUserId,
                replyText,
                activeContextToken
              );

              // If an image card was generated (e.g. for "查看日历" or "查看任务"), send image message
              if (imageBuffer) {
                await sendWeixinImageMessage(
                  baseUrl,
                  botToken,
                  botId,
                  fromUserId,
                  imageBuffer,
                  activeContextToken
                );
              }
            }
          }
        }
      } catch (err: any) {
        if (signal.aborted) break;

        // Long-poll timeout is expected and normal
        if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
          continue;
        }

        if (worker) worker.lastError = err.message;
        addDebugLog('Weixin', 'warn', `[用户 #${userId}] 微信轮询连接异常: ${err.message}`);
        // Gentle backoff before retrying
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
}

export const weixinTransitManager = new WeixinTransitManager();
