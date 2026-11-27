import { Response } from 'express';
import crypto from 'crypto';
import OpenAI from 'openai';
import { db } from '../config/database.js';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { UserSettings } from '../models/types.js';
import { recordApiUsage, getUserUsageStats, clearUserUsageLogs } from '../services/llmPricing.js';
import { getGlobalApiConfig } from '../services/globalApiConfig.js';
import { isOfficialGlobalLlmConfigured } from '../services/llm.js';
import { replanUserTasks } from '../services/scheduler.js';
import { isValidTimeZone } from '../utils/timezone.js';

export function getSettings(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings | undefined;

  const userRow = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId) as any;
  const userBalance = Number(userRow?.balance || 0);

  const globalConfig = getGlobalApiConfig();
  const hasGlobalLlm = isOfficialGlobalLlmConfigured();

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
    },
  });
}

function parseWorkSlotsInput(work_slots: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof work_slots === 'object' && work_slots !== null) {
    if (!Array.isArray(work_slots)) {
      return { ok: false, error: '工作时段格式错误' };
    }
    return { ok: true, value: JSON.stringify(work_slots) };
  }
  if (typeof work_slots === 'string') {
    try {
      const parsed = JSON.parse(work_slots);
      if (!Array.isArray(parsed)) {
        return { ok: false, error: '工作时段必须为数组' };
      }
      return { ok: true, value: JSON.stringify(parsed) };
    } catch {
      const parts = work_slots.split(/[,，;\n\r]+/).map((p: string) => p.trim()).filter(Boolean);
      const parsedSlots: Array<{ start: string; end: string }> = [];
      for (const part of parts) {
        const match = part.match(/^(\d{1,2}:\d{2})\s*[-~至到]\s*(\d{1,2}:\d{2})$/);
        if (match) {
          parsedSlots.push({ start: match[1], end: match[2] });
        }
      }
      if (parsedSlots.length > 0) {
        return { ok: true, value: JSON.stringify(parsedSlots) };
      }
      return { ok: false, error: '工作时段格式错误，需形如 00:00-02:00, 13:00-18:00' };
    }
  }
  return { ok: false, error: '工作时段格式错误' };
}

/**
 * 局部更新用户偏好设置（A04）：
 * - 未显式传入的字段严格保留现有数据库值，绝不覆盖或清空未传配置
 * - 与旧值比对后仅在影响排程的字段确实发生变化时触发重排
 * - 支持可选 expected_updated_at 并发版本检查
 */
export function updateSettings(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const body = req.body || {};

  const existing = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings | undefined;
  if (body.expected_updated_at && existing && existing.updated_at !== body.expected_updated_at) {
    res.status(409).json({
      error: '设置已被其他会话更新，请刷新后重试',
      currentUpdatedAt: existing.updated_at,
    });
    return;
  }

  let nextWorkSlotsStr: string | undefined;
  if (body.work_slots !== undefined) {
    const parsed = parseWorkSlotsInput(body.work_slots);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    nextWorkSlotsStr = parsed.value;
  }

  if (body.timezone !== undefined && !isValidTimeZone(body.timezone)) {
    res.status(400).json({ error: '无效的 IANA 时区标识' });
    return;
  }

  const validLockModes = new Set(['none', 'hours', 'today', 'this_week']);
  if (body.schedule_lock_mode !== undefined && !validLockModes.has(String(body.schedule_lock_mode))) {
    res.status(400).json({ error: '无效的日程锁定范围模式' });
    return;
  }

  let nextLockHours = Number(existing?.schedule_lock_hours ?? 0);
  if (body.schedule_lock_hours !== undefined) {
    const parsedLockHours = Number(body.schedule_lock_hours);
    if (!Number.isFinite(parsedLockHours) || parsedLockHours < 0 || parsedLockHours > 168) {
      res.status(400).json({ error: '锁定小时数需在 0 到 168 小时之间' });
      return;
    }
    nextLockHours = Math.round(parsedLockHours);
  }
  const nextLockMode = (
    body.schedule_lock_mode !== undefined
      ? String(body.schedule_lock_mode)
      : existing?.schedule_lock_mode ?? 'none'
  ) as 'none' | 'hours' | 'today' | 'this_week';
  if (nextLockMode === 'hours' && nextLockHours <= 0) {
    nextLockHours = 4;
  } else if (nextLockMode !== 'hours' && body.schedule_lock_mode !== undefined && body.schedule_lock_hours === undefined) {
    nextLockHours = 0;
  }

  const nextApiMode =
    body.api_mode !== undefined
      ? body.api_mode === 'custom'
        ? 'custom'
        : 'official'
      : existing?.api_mode ?? 'official';
  const nextEndpoint = body.llm_endpoint !== undefined ? String(body.llm_endpoint) : existing?.llm_endpoint ?? 'https://api.deepseek.com/v1';
  const nextApiKey = body.llm_api_key !== undefined ? String(body.llm_api_key) : existing?.llm_api_key ?? '';
  const nextModel = body.llm_model !== undefined ? String(body.llm_model) : existing?.llm_model ?? 'deepseek-chat';
  const nextOutboundUrl = body.clawbot_outbound_url !== undefined ? String(body.clawbot_outbound_url) : existing?.clawbot_outbound_url ?? '';
  const nextOutboundKey = body.clawbot_outbound_key !== undefined ? String(body.clawbot_outbound_key) : existing?.clawbot_outbound_key ?? '';
  const nextToWxid = body.clawbot_to_wxid !== undefined ? String(body.clawbot_to_wxid) : existing?.clawbot_to_wxid ?? '';
  const workSlotsToSave =
    nextWorkSlotsStr !== undefined
      ? nextWorkSlotsStr
      : existing?.work_slots ?? '[{"start":"09:00","end":"12:00"},{"start":"13:00","end":"18:00"},{"start":"19:00","end":"24:00"},{"start":"00:00","end":"02:00"}]';
  const nextBuffer = body.task_buffer_minutes !== undefined ? Number(body.task_buffer_minutes) : existing?.task_buffer_minutes ?? 10;
  const nextRemStart =
    body.reminder_before_start_minutes !== undefined
      ? Number(body.reminder_before_start_minutes)
      : existing?.reminder_before_start_minutes ?? 5;
  const nextRemEnd =
    body.reminder_before_end_minutes !== undefined
      ? Number(body.reminder_before_end_minutes)
      : existing?.reminder_before_end_minutes ?? 5;
  const nextSyncInt =
    body.calendar_sync_interval_minutes !== undefined
      ? Number(body.calendar_sync_interval_minutes)
      : existing?.calendar_sync_interval_minutes ?? 60;
  const nextAdvanceDays =
    body.advance_deadline_days !== undefined
      ? Number(body.advance_deadline_days)
      : existing?.advance_deadline_days ?? 1;
  const nextTimezone =
    body.timezone !== undefined ? String(body.timezone).trim() : existing?.timezone ?? 'Asia/Shanghai';

  const schedulingChanged =
    !existing ||
    existing.work_slots !== workSlotsToSave ||
    Number(existing.task_buffer_minutes) !== nextBuffer ||
    Number(existing.advance_deadline_days ?? 1) !== nextAdvanceDays ||
    (existing.timezone || 'Asia/Shanghai') !== nextTimezone;

  db.prepare(`
    INSERT INTO user_settings (
      user_id, api_mode, llm_endpoint, llm_api_key, llm_model,
      clawbot_outbound_url, clawbot_outbound_key, clawbot_to_wxid,
      work_slots, task_buffer_minutes, reminder_before_start_minutes,
      reminder_before_end_minutes, calendar_sync_interval_minutes,
      advance_deadline_days, schedule_lock_mode, schedule_lock_hours, timezone, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      api_mode = excluded.api_mode,
      llm_endpoint = excluded.llm_endpoint,
      llm_api_key = excluded.llm_api_key,
      llm_model = excluded.llm_model,
      clawbot_outbound_url = excluded.clawbot_outbound_url,
      clawbot_outbound_key = excluded.clawbot_outbound_key,
      clawbot_to_wxid = excluded.clawbot_to_wxid,
      work_slots = excluded.work_slots,
      task_buffer_minutes = excluded.task_buffer_minutes,
      reminder_before_start_minutes = excluded.reminder_before_start_minutes,
      reminder_before_end_minutes = excluded.reminder_before_end_minutes,
      calendar_sync_interval_minutes = excluded.calendar_sync_interval_minutes,
      advance_deadline_days = excluded.advance_deadline_days,
      schedule_lock_mode = excluded.schedule_lock_mode,
      schedule_lock_hours = excluded.schedule_lock_hours,
      timezone = excluded.timezone,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    userId,
    nextApiMode,
    nextEndpoint,
    nextApiKey,
    nextModel,
    nextOutboundUrl,
    nextOutboundKey,
    nextToWxid,
    workSlotsToSave,
    nextBuffer,
    nextRemStart,
    nextRemEnd,
    nextSyncInt,
    nextAdvanceDays,
    nextLockMode,
    nextLockHours,
    nextTimezone
  );

  if (schedulingChanged) {
    try {
      replanUserTasks(userId);
    } catch (err) {
      console.warn('[Settings] Replan after settings update warning:', err);
    }
  }

  const updated = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings;
  res.json({ message: '配置已保存成功！', settings: updated, replanned: schedulingChanged });
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
      message: `API Key 验证有效！模型连接正常${usageNote}。`,
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
    message: '个人用量视图已清空（系统审计流水已保留）',
  });
}

/**
 * 用户使用兑换码为账户余额充值（A06：事务内条件认领 + 核对影响行数）
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

  try {
    const result = db.transaction(() => {
      const codeRow = db.prepare('SELECT * FROM redemption_codes WHERE code = ?').get(cleanCode) as any;
      if (!codeRow) {
        return { error: { status: 400, message: '兑换码不存在，请核对后重试' } };
      }

      const claim = db.prepare(`
        UPDATE redemption_codes
        SET status = 'used', used_by_user_id = ?, used_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'active'
      `).run(userId, codeRow.id);

      if (claim.changes !== 1) {
        return { error: { status: 400, message: '该兑换码已被使用或已作废' } };
      }

      db.prepare(`
        UPDATE users
        SET balance = ROUND(COALESCE(balance, 0) + ?, 4), updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(codeRow.amount, userId);

      const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId) as any;
      return {
        amount: Number(codeRow.amount),
        newBalance: Number(user?.balance || 0),
      };
    })();

    if ('error' in result && result.error) {
      res.status(result.error.status).json({ error: result.error.message });
      return;
    }

    res.json({
      success: true,
      amount: result.amount,
      newBalance: result.newBalance,
      message: `兑换成功！已为您充值 ¥${result.amount!.toFixed(2)} 元，当前账户余额为 ¥${result.newBalance!.toFixed(2)} 元。`,
    });
  } catch (err: any) {
    res.status(500).json({ error: '兑换处理失败，请稍后重试' });
  }
}
