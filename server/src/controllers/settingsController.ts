import { Response } from 'express';
import crypto from 'crypto';
import OpenAI from 'openai';
import { db } from '../config/database.js';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { UserSettings } from '../models/types.js';
import { recordApiUsage, getUserUsageStats, clearUserUsageLogs } from '../services/llmPricing.js';
import { getGlobalApiConfig } from '../services/globalApiConfig.js';

export function getSettings(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings | undefined;

  const userRow = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId) as any;
  const userBalance = Number(userRow?.balance || 0);

  const globalConfig = getGlobalApiConfig();
  const hasGlobalLlm = Boolean(
    (globalConfig.api1.apiKey && globalConfig.api1.apiKey.trim().length > 3) ||
    (globalConfig.api2.enabled && globalConfig.api2.apiKey && globalConfig.api2.apiKey.trim().length > 3) ||
    process.env.DEEPSEEK_API_KEY
  );

  const globalModel = globalConfig.api1.model || 'deepseek-chat';
  const isDeepSeek = globalModel.toLowerCase().includes('deepseek');
  const priceInput = globalConfig.pricing.priceInput;
  const priceOutput = globalConfig.pricing.priceOutput;
  const priceCacheHit = globalConfig.pricing.priceCacheHit;

  const host = req.get('host') || 'localhost:5178';
  const protocol = req.protocol;

  const webhookUrl = `${protocol}://${host}/api/webhook/clawbot/${settings?.clawbot_webhook_token || ''}`;
  const icalSubscriptionUrl = `${protocol}://${host}/api/calendar/subscribe/${req.user!.token_secret}.ics`;

  res.json({
    settings: settings || null,
    user_balance: userBalance,
    has_global_llm: hasGlobalLlm,
    global_llm_info: {
      model: globalModel,
      isDeepSeek,
      priceInput,
      priceOutput,
      priceCacheHit,
    },
    urls: {
      webhookUrl,
      icalSubscriptionUrl,
      webcalUrl: icalSubscriptionUrl.replace(/^https?:/, 'webcal:'),
    },
  });
}

export function updateSettings(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const {
    api_mode,
    llm_endpoint,
    llm_api_key,
    llm_model,
    clawbot_outbound_url,
    clawbot_outbound_key,
    clawbot_to_wxid,
    work_slots,
    task_buffer_minutes,
    reminder_before_start_minutes,
    reminder_before_end_minutes,
    calendar_sync_interval_minutes,
    advance_deadline_days,
  } = req.body;

  // Validate work_slots JSON or human-friendly string (e.g. "00:00-02:00, 13:00-18:00")
  let workSlotsStr = work_slots;
  if (typeof work_slots === 'object' && work_slots !== null) {
    workSlotsStr = JSON.stringify(work_slots);
  } else if (typeof work_slots === 'string') {
    try {
      const parsed = JSON.parse(work_slots);
      workSlotsStr = JSON.stringify(parsed);
    } catch {
      // Parse human string like "00:00-02:00, 13:00-18:00"
      const parts = work_slots.split(/[,，;\n\r]+/).map((p: string) => p.trim()).filter(Boolean);
      const parsedSlots: Array<{ start: string; end: string }> = [];
      for (const part of parts) {
        const match = part.match(/^(\d{1,2}:\d{2})\s*[-~至到]\s*(\d{1,2}:\d{2})$/);
        if (match) {
          parsedSlots.push({ start: match[1], end: match[2] });
        }
      }
      if (parsedSlots.length > 0) {
        workSlotsStr = JSON.stringify(parsedSlots);
      } else {
        res.status(400).json({ error: '工作时段格式错误，需形如 00:00-02:00, 13:00-18:00' });
        return;
      }
    }
  }

  db.prepare(`
    INSERT INTO user_settings (
      user_id, api_mode, llm_endpoint, llm_api_key, llm_model,
      clawbot_outbound_url, clawbot_outbound_key, clawbot_to_wxid,
      work_slots, task_buffer_minutes, reminder_before_start_minutes,
      reminder_before_end_minutes, calendar_sync_interval_minutes,
      advance_deadline_days, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      api_mode = COALESCE(excluded.api_mode, user_settings.api_mode),
      llm_endpoint = COALESCE(excluded.llm_endpoint, user_settings.llm_endpoint),
      llm_api_key = COALESCE(excluded.llm_api_key, user_settings.llm_api_key),
      llm_model = COALESCE(excluded.llm_model, user_settings.llm_model),
      clawbot_outbound_url = COALESCE(excluded.clawbot_outbound_url, user_settings.clawbot_outbound_url),
      clawbot_outbound_key = COALESCE(excluded.clawbot_outbound_key, user_settings.clawbot_outbound_key),
      clawbot_to_wxid = COALESCE(excluded.clawbot_to_wxid, user_settings.clawbot_to_wxid),
      work_slots = COALESCE(excluded.work_slots, user_settings.work_slots),
      task_buffer_minutes = COALESCE(excluded.task_buffer_minutes, user_settings.task_buffer_minutes),
      reminder_before_start_minutes = COALESCE(excluded.reminder_before_start_minutes, user_settings.reminder_before_start_minutes),
      reminder_before_end_minutes = COALESCE(excluded.reminder_before_end_minutes, user_settings.reminder_before_end_minutes),
      calendar_sync_interval_minutes = COALESCE(excluded.calendar_sync_interval_minutes, user_settings.calendar_sync_interval_minutes),
      advance_deadline_days = COALESCE(excluded.advance_deadline_days, user_settings.advance_deadline_days),
      updated_at = CURRENT_TIMESTAMP
  `).run(
    userId,
    api_mode ?? 'official',
    llm_endpoint ?? 'https://api.deepseek.com/v1',
    llm_api_key ?? '',
    llm_model ?? 'deepseek-chat',
    clawbot_outbound_url ?? '',
    clawbot_outbound_key ?? '',
    clawbot_to_wxid ?? '',
    workSlotsStr,
    task_buffer_minutes ?? 10,
    reminder_before_start_minutes ?? 5,
    reminder_before_end_minutes ?? 5,
    calendar_sync_interval_minutes ?? 60,
    advance_deadline_days ?? 1
  );

  res.json({ message: '配置已保存成功！' });
}

export function regenerateWebhookToken(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const newToken = crypto.randomBytes(16).toString('hex');

  db.prepare(`
    UPDATE user_settings
    SET clawbot_webhook_token = ?, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(newToken, userId);

  res.json({ message: 'Webhook Token 已重新生成', token: newToken });
}

export async function testLlmApiKey(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { llm_endpoint, llm_api_key, llm_model } = req.body;

  const endpoint = llm_endpoint || 'https://api.deepseek.com/v1';
  let apiKey = llm_api_key;
  if (!apiKey || !apiKey.trim()) {
    const s = db.prepare('SELECT llm_api_key FROM user_settings WHERE user_id = ?').get(userId) as UserSettings | undefined;
    apiKey = s?.llm_api_key;
  }

  if (!apiKey || !apiKey.trim()) {
    res.status(400).json({ success: false, error: '未输入或未保存 API Key，请先填入密钥' });
    return;
  }

  try {
    const client = new OpenAI({
      baseURL: endpoint,
      apiKey: apiKey.trim(),
      timeout: 12000,
    });

    const testRes = await client.chat.completions.create({
      model: llm_model || 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
    });

    let usageNote = '';
    if (testRes.usage) {
      const rec = recordApiUsage(userId, llm_model || 'deepseek-chat', testRes.usage, 'key_test', false);
      if (rec) {
        usageNote = ` (消耗 ${rec.totalTokens} Tokens，折合 ¥${rec.costCny.toFixed(6)})`;
      }
    }

    res.json({
      success: true,
      message: `DeepSeek API Key 验证有效！模型连接正常${usageNote}。`,
    });
  } catch (err: any) {
    const errorMsg =
      err.response?.data?.error?.message ||
      err.message ||
      'API Key 校验失败，请检查 endpoint 或 key 是否正确';
    res.status(400).json({
      success: false,
      error: errorMsg,
    });
  }
}

export function getLlmUsage(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const settings = db.prepare('SELECT llm_model FROM user_settings WHERE user_id = ?').get(userId) as any;
  const model = settings?.llm_model || 'deepseek-chat';
  const stats = getUserUsageStats(userId, model);
  res.json({
    success: true,
    ...stats,
  });
}

export function clearLlmUsage(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  clearUserUsageLogs(userId);
  res.json({
    success: true,
    message: 'API 用量记录已清空',
  });
}

/**
 * 用户使用兑换码为账户余额充值
 */
export function redeemCode(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const { code } = req.body;

  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: '请输入有效的兑换码' });
    return;
  }

  const cleanCode = code.trim().toUpperCase();
  if (cleanCode.length < 5) {
    res.status(400).json({ error: '兑换码格式不正确' });
    return;
  }

  const codeRow = db.prepare('SELECT * FROM redemption_codes WHERE code = ?').get(cleanCode) as any;
  if (!codeRow) {
    res.status(400).json({ error: '兑换码不存在，请核对后重试' });
    return;
  }

  if (codeRow.status !== 'active') {
    res.status(400).json({ error: '该兑换码已被使用或已作废' });
    return;
  }

  let newBalance = 0;
  const runTransaction = db.transaction(() => {
    db.prepare(`
      UPDATE redemption_codes
      SET status = 'used', used_by_user_id = ?, used_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(userId, codeRow.id);

    db.prepare(`
      UPDATE users
      SET balance = ROUND(COALESCE(balance, 0) + ?, 4), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(codeRow.amount, userId);

    const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId) as any;
    newBalance = Number(user?.balance || 0);
  });

  try {
    runTransaction();
    res.json({
      success: true,
      amount: codeRow.amount,
      newBalance,
      message: `兑换成功！已为您充值 ¥${codeRow.amount.toFixed(2)} 元，当前账户余额为 ¥${newBalance.toFixed(2)} 元。`,
    });
  } catch (err: any) {
    res.status(500).json({ error: '兑换处理失败，请稍后重试' });
  }
}
