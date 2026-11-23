import { db } from '../config/database.js';
import { getGlobalApiConfig, parseNonNegativeRate } from './globalApiConfig.js';

export interface DeepSeekPricingPeriod {
  isPeak: boolean;
  isDeepSeek?: boolean;
  periodLabel: string;
  beijingTimeStr: string;
  rates: {
    cacheHitPerMillion: number;
    cacheMissPerMillion: number;
    outputPerMillion: number;
  };
}

export type ModelPricingPeriod = DeepSeekPricingPeriod;

/**
 * 获取当前北京时间 (UTC+8) 的峰谷时段信息与单价（元/百万 Tokens）
 */
export function getDeepSeekPricingPeriod(
  date: Date = new Date(),
  model: string = 'deepseek-chat'
): DeepSeekPricingPeriod {
  const bjFormatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });

  const parts = bjFormatter.formatToParts(date);
  const getPart = (type: string) => parts.find((p) => p.type === type)?.value || '';

  const hour = parseInt(getPart('hour'), 10) || 0;
  const minute = parseInt(getPart('minute'), 10) || 0;
  const timeInMinutes = hour * 60 + minute;

  const weekdayStr = getPart('weekday');
  const isWeekend =
    weekdayStr.includes('六') ||
    weekdayStr.includes('日') ||
    weekdayStr.includes('Sat') ||
    weekdayStr.includes('Sun');

  let isPeak = false;
  let periodLabel = '谷时 (空闲5折时段)';

  if (isWeekend) {
    isPeak = false;
    periodLabel = '谷时 (周末全天5折)';
  } else {
    const isMorningPeak = timeInMinutes >= 540 && timeInMinutes < 720;
    const isAfternoonPeak = timeInMinutes >= 840 && timeInMinutes < 1080;

    if (isMorningPeak || isAfternoonPeak) {
      isPeak = true;
      periodLabel = '峰时 (工作日高峰)';
    } else {
      isPeak = false;
      periodLabel = '谷时 (工作日空闲5折)';
    }
  }

  const isReasoner = model.toLowerCase().includes('reasoner') || model.toLowerCase().includes('r1');

  let cacheHitPerMillion = isPeak ? 0.5 : 0.1;
  let cacheMissPerMillion = isPeak ? 2.0 : 1.0;
  let outputPerMillion = isPeak ? 8.0 : 4.0;

  if (isReasoner) {
    cacheHitPerMillion = isPeak ? 1.0 : 0.2;
    cacheMissPerMillion = isPeak ? 4.0 : 2.0;
    outputPerMillion = isPeak ? 16.0 : 8.0;
  }

  const beijingTimeStr = `${getPart('year')}-${getPart('month')}-${getPart('day')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (${weekdayStr})`;

  return {
    isPeak,
    isDeepSeek: true,
    periodLabel,
    beijingTimeStr,
    rates: {
      cacheHitPerMillion,
      cacheMissPerMillion,
      outputPerMillion,
    },
  };
}

/**
 * 依据模型类型获取生效的定价规则与费率（元/百万 Tokens）：
 * 修复 A11：显式单价 0 严格按零计算，仅缺失或无效时回退默认值。
 */
export function getModelPricingPeriod(
  date: Date = new Date(),
  model: string = 'deepseek-chat',
  _isOfficial: boolean = false
): ModelPricingPeriod {
  const isDeepSeek = model.toLowerCase().includes('deepseek');
  if (isDeepSeek) {
    return getDeepSeekPricingPeriod(date, model);
  }

  const globalCfg = getGlobalApiConfig();
  const cacheMissPerMillion = parseNonNegativeRate(globalCfg.pricing.priceInput, 2.0);
  const outputPerMillion = parseNonNegativeRate(globalCfg.pricing.priceOutput, 8.0);
  const cacheHitPerMillion = parseNonNegativeRate(globalCfg.pricing.priceCacheHit, 0.5);

  const bjFormatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const parts = bjFormatter.formatToParts(date);
  const getPart = (type: string) => parts.find((p) => p.type === type)?.value || '';
  const hour = getPart('hour');
  const minute = getPart('minute');
  const weekdayStr = getPart('weekday');
  const beijingTimeStr = `${getPart('year')}-${getPart('month')}-${getPart('day')} ${hour}:${minute} (${weekdayStr})`;

  return {
    isPeak: false,
    isDeepSeek: false,
    periodLabel: `自定义单价 (输入: ¥${cacheMissPerMillion}/M, 输出: ¥${outputPerMillion}/M, 缓存: ¥${cacheHitPerMillion}/M)`,
    beijingTimeStr,
    rates: {
      cacheHitPerMillion,
      cacheMissPerMillion,
      outputPerMillion,
    },
  };
}

export interface ApiUsageRecord {
  id?: number;
  userId: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  isPeak: boolean;
  costCny: number;
  inputCostCny: number;
  outputCostCny: number;
  requestType: string;
  isOfficial?: boolean;
  requestId?: string | null;
  createdAt?: string;
}

export function calculateUsageCost(
  usage: any,
  rates: ModelPricingPeriod['rates']
): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  inputCostCny: number;
  outputCostCny: number;
  costCny: number;
} {
  const promptTokens = Math.max(0, Number(usage?.prompt_tokens || 0));
  const completionTokens = Math.max(0, Number(usage?.completion_tokens || 0));
  const totalTokens = Math.max(0, Number(usage?.total_tokens || (promptTokens + completionTokens)));

  const cacheHitTokens = Math.max(
    0,
    Number(usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0)
  );
  const cacheMissTokens = Math.max(
    0,
    Number(usage?.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHitTokens))
  );

  const inputCostCny =
    (cacheHitTokens / 1_000_000) * rates.cacheHitPerMillion +
    (cacheMissTokens / 1_000_000) * rates.cacheMissPerMillion;
  const outputCostCny = (completionTokens / 1_000_000) * rates.outputPerMillion;
  const costCny = Number((inputCostCny + outputCostCny).toFixed(6));

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheHitTokens,
    cacheMissTokens,
    inputCostCny,
    outputCostCny,
    costCny,
  };
}

/**
 * 估算单次官方调用的最大预留金额（A05, A11）。
 * 若费率全为 0（免费模型），预留金额为 0，仍允许调用且扣费为 0。
 */
export function estimateReservationAmountCny(
  model: string,
  estimatedPromptTokens: number = 4000,
  estimatedMaxOutputTokens: number = 1500
): { reserveCny: number; period: ModelPricingPeriod } {
  const period = getModelPricingPeriod(new Date(), model, true);
  const maxCost =
    (estimatedPromptTokens / 1_000_000) * period.rates.cacheMissPerMillion +
    (estimatedMaxOutputTokens / 1_000_000) * period.rates.outputPerMillion;
  return {
    reserveCny: Number(Math.max(0, maxCost).toFixed(6)),
    period,
  };
}

/**
 * 官方模型调用前原子预留额度（A05）。
 * 同一 requestId 幂等返回；免费（reserveCny === 0）时直接允许并登记 0 预留。
 */
export function reserveOfficialLlmBalance(params: {
  requestId: string;
  userId: number;
  purpose: string;
  model: string;
  estimatedPromptTokens?: number;
  estimatedMaxOutputTokens?: number;
}): {
  ok: boolean;
  reservedCny: number;
  remainingBalance: number;
  period: ModelPricingPeriod;
  error?: string;
} {
  const { requestId, userId, purpose, model, estimatedPromptTokens, estimatedMaxOutputTokens } = params;
  const { reserveCny, period } = estimateReservationAmountCny(
    model,
    estimatedPromptTokens,
    estimatedMaxOutputTokens
  );

  return db.transaction(() => {
    const existing = db
      .prepare('SELECT * FROM llm_reservations WHERE request_id = ?')
      .get(requestId) as any;
    if (existing) {
      const userRow = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId) as { balance?: number } | undefined;
      return {
        ok: true,
        reservedCny: Number(existing.reserved_cny || 0),
        remainingBalance: Number(userRow?.balance || 0),
        period,
      };
    }

    const userRow = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId) as { balance?: number } | undefined;
    if (!userRow) {
      return { ok: false, reservedCny: 0, remainingBalance: 0, period, error: '用户不存在' };
    }

    const currentBalance = Number(userRow.balance || 0);
    if (reserveCny > 0) {
      // 只要余额 > 0 即可预留（最多预留 min(reserveCny, currentBalance) 当余额不足单次预估上限但 > 0，或严格按 reserveCny）
      // 为防止高并发透支同时兼容小额余额用户（如 ¥0.01），若余额 <= 0 直接拒绝；否则按 min(reserveCny, currentBalance) 预留并锁定额度
      if (currentBalance <= 0) {
        return {
          ok: false,
          reservedCny: 0,
          remainingBalance: currentBalance,
          period,
          error: '账户额度已用尽 (¥0.00)。请在设置中兑换充值码或联系管理员。',
        };
      }
      const actualReserve = Number(Math.min(reserveCny, currentBalance).toFixed(6));
      const upd = db.prepare(`
        UPDATE users
        SET balance = ROUND(balance - ?, 6), updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND balance >= ?
      `).run(actualReserve, userId, actualReserve);

      if (upd.changes !== 1) {
        return {
          ok: false,
          reservedCny: 0,
          remainingBalance: currentBalance,
          period,
          error: '账户额度不足，请稍后重试或充值',
        };
      }

      db.prepare(`
        INSERT INTO llm_reservations (request_id, user_id, purpose, model, reserved_cny, status, rate_snapshot_json)
        VALUES (?, ?, ?, ?, ?, 'reserved', ?)
      `).run(requestId, userId, purpose, model, actualReserve, JSON.stringify(period));

      const after = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId) as { balance?: number };
      return {
        ok: true,
        reservedCny: actualReserve,
        remainingBalance: Number(after?.balance || 0),
        period,
      };
    }

    // 零费率免费模型：不要求正余额，登记 0 元预留
    db.prepare(`
      INSERT INTO llm_reservations (request_id, user_id, purpose, model, reserved_cny, status, rate_snapshot_json)
      VALUES (?, ?, ?, ?, 0, 'reserved', ?)
    `).run(requestId, userId, purpose, model, JSON.stringify(period));

    return {
      ok: true,
      reservedCny: 0,
      remainingBalance: currentBalance,
      period,
    };
  })();
}

/**
 * 按 requestId 幂等结算官方模型调用费用并退回/补扣差额（A05, A06, A11）。
 */
export function settleOfficialLlmReservation(params: {
  requestId: string;
  userId: number;
  model: string;
  usage: any;
  requestType: string;
}): ApiUsageRecord | null {
  const { requestId, userId, model, usage, requestType } = params;

  try {
    return db.transaction(() => {
      const resRow = db
        .prepare('SELECT * FROM llm_reservations WHERE request_id = ?')
        .get(requestId) as any;

      if (resRow && resRow.status === 'settled') {
        const existingLog = db
          .prepare('SELECT * FROM api_usage_logs WHERE request_id = ? LIMIT 1')
          .get(requestId) as any;
        if (existingLog) {
          return {
            id: existingLog.id,
            userId: existingLog.user_id,
            model: existingLog.model,
            promptTokens: existingLog.prompt_tokens,
            completionTokens: existingLog.completion_tokens,
            totalTokens: existingLog.total_tokens,
            cacheHitTokens: existingLog.cache_hit_tokens,
            cacheMissTokens: existingLog.cache_miss_tokens,
            isPeak: Boolean(existingLog.is_peak),
            costCny: existingLog.cost_cny,
            inputCostCny: existingLog.input_cost_cny,
            outputCostCny: existingLog.output_cost_cny,
            requestType: existingLog.request_type,
            isOfficial: Boolean(existingLog.is_official),
            requestId,
          };
        }
        return null;
      }

      let period: ModelPricingPeriod;
      try {
        period = resRow?.rate_snapshot_json
          ? JSON.parse(resRow.rate_snapshot_json)
          : getModelPricingPeriod(new Date(), model, true);
      } catch {
        period = getModelPricingPeriod(new Date(), model, true);
      }

      const calc = calculateUsageCost(usage || {}, period.rates);
      const reserved = Number(resRow?.reserved_cny || 0);
      const diff = Number((calc.costCny - reserved).toFixed(6));

      let finalStatus: 'settled' | 'reconcile' = 'settled';
      let errorMsg: string | null = null;

      if (diff < 0) {
        // Refund unused reservation
        db.prepare(`
          UPDATE users
          SET balance = ROUND(balance + ?, 6), updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(Math.abs(diff), userId);
      } else if (diff > 0) {
        const userRow = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId) as { balance?: number } | undefined;
        const avail = Number(userRow?.balance || 0);
        if (avail >= diff) {
          db.prepare(`
            UPDATE users
            SET balance = ROUND(balance - ?, 6), updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND balance >= ?
          `).run(diff, userId, diff);
        } else {
          // Deduct remaining available balance and flag shortfall in reconcile queue
          if (avail > 0) {
            db.prepare('UPDATE users SET balance = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
          }
          finalStatus = 'reconcile';
          errorMsg = `actual_cost (${calc.costCny}) exceeded reserved (${reserved}) + balance (${avail})`;
        }
      }

      const insertRes = db.prepare(`
        INSERT INTO api_usage_logs (
          user_id, model, prompt_tokens, completion_tokens, total_tokens,
          cache_hit_tokens, cache_miss_tokens, is_peak, cost_cny,
          input_cost_cny, output_cost_cny, request_type, is_official, request_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(
        userId,
        model,
        calc.promptTokens,
        calc.completionTokens,
        calc.totalTokens,
        calc.cacheHitTokens,
        calc.cacheMissTokens,
        period.isPeak ? 1 : 0,
        calc.costCny,
        calc.inputCostCny,
        calc.outputCostCny,
        requestType,
        requestId
      );

      if (resRow) {
        db.prepare(`
          UPDATE llm_reservations
          SET status = ?, actual_cny = ?, error_message = ?, settled_at = CURRENT_TIMESTAMP
          WHERE request_id = ?
        `).run(finalStatus, calc.costCny, errorMsg, requestId);
      } else {
        db.prepare(`
          INSERT INTO llm_reservations (request_id, user_id, purpose, model, reserved_cny, actual_cny, status, rate_snapshot_json, error_message, settled_at)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `).run(requestId, userId, requestType, model, calc.costCny, finalStatus, JSON.stringify(period), errorMsg);
      }

      return {
        id: Number(insertRes.lastInsertRowid),
        userId,
        model,
        ...calc,
        isPeak: period.isPeak,
        requestType,
        isOfficial: true,
        requestId,
      };
    })();
  } catch (err: any) {
    console.error('[API Usage] Failed to settle reservation:', err.message);
    try {
      db.prepare(`
        UPDATE llm_reservations
        SET status = 'reconcile', error_message = ?
        WHERE request_id = ? AND status = 'reserved'
      `).run(err.message, requestId);
    } catch {}
    return null;
  }
}

/**
 * 调用失败时释放预留额度。
 */
export function releaseOfficialLlmReservation(requestId: string, errorMessage?: string): void {
  try {
    db.transaction(() => {
      const resRow = db
        .prepare("SELECT * FROM llm_reservations WHERE request_id = ? AND status = 'reserved'")
        .get(requestId) as any;
      if (!resRow) return;

      const reserved = Number(resRow.reserved_cny || 0);
      if (reserved > 0) {
        db.prepare(`
          UPDATE users
          SET balance = ROUND(balance + ?, 6), updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(reserved, resRow.user_id);
      }

      db.prepare(`
        UPDATE llm_reservations
        SET status = 'released', actual_cny = 0, error_message = ?, settled_at = CURRENT_TIMESTAMP
        WHERE request_id = ?
      `).run(errorMessage || null, requestId);
    })();
  } catch (err: any) {
    console.error('[API Usage] Failed to release reservation:', err.message);
  }
}

/**
 * 记录一次 API 调用的 Token 消耗并自动按峰谷/自定义费率折算金额
 */
export function recordApiUsage(
  userId: number,
  model: string,
  usage: any,
  requestType: string = 'weixin_chat',
  isOfficial: boolean = false,
  requestId?: string
): ApiUsageRecord | null {
  if (!usage || !userId) return null;

  const { isPeak, rates } = getModelPricingPeriod(new Date(), model, isOfficial);
  const calc = calculateUsageCost(usage, rates);

  try {
    const stmt = db.prepare(`
      INSERT INTO api_usage_logs (
        user_id, model, prompt_tokens, completion_tokens, total_tokens,
        cache_hit_tokens, cache_miss_tokens, is_peak, cost_cny,
        input_cost_cny, output_cost_cny, request_type, is_official, request_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      userId,
      model,
      calc.promptTokens,
      calc.completionTokens,
      calc.totalTokens,
      calc.cacheHitTokens,
      calc.cacheMissTokens,
      isPeak ? 1 : 0,
      calc.costCny,
      calc.inputCostCny,
      calc.outputCostCny,
      requestType,
      isOfficial ? 1 : 0,
      requestId || null
    );

    return {
      id: Number(info.lastInsertRowid),
      userId,
      model,
      ...calc,
      isPeak,
      requestType,
      isOfficial,
      requestId: requestId || null,
    };
  } catch (err: any) {
    console.error('[API Usage] Failed to record usage log:', err.message);
    return null;
  }
}

export interface DailyHistoryPoint {
  label: string;
  date: string;
  cost_cny: number;
  tokens: number;
  requests: number;
}

export interface UserUsageStats {
  summary: {
    totalRequests: number;
    totalTokens: number;
    promptTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    completionTokens: number;
    totalCostCny: number;
    inputCostCny: number;
    outputCostCny: number;
    savedCostCny: number;
    cacheHitRate: number;
  };
  scope?: 'official' | 'all';
  currentStatus: DeepSeekPricingPeriod;
  dailyHistory: {
    '1d': DailyHistoryPoint[];
    '7d': DailyHistoryPoint[];
    '30d': DailyHistoryPoint[];
  };
  recentLogs?: Array<{
    id: number;
    user_id?: number;
    username?: string;
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cache_hit_tokens: number;
    cache_miss_tokens: number;
    is_peak: number;
    cost_cny: number;
    input_cost_cny: number;
    output_cost_cny: number;
    request_type: string;
    is_official?: number;
    created_at: string;
  }>;
}

/**
 * 查询指定用户的用量统计汇总与前 1天/7天/30天 价格曲线数据（仅查询未隐藏的个人记录）
 */
export function getUserUsageStats(userId: number, currentModel: string = 'deepseek-chat'): UserUsageStats {
  const currentStatus = getModelPricingPeriod(new Date(), currentModel);

  try {
    const agg = db.prepare(`
      SELECT 
        COUNT(*) as total_requests,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
        COALESCE(SUM(cache_hit_tokens), 0) as cache_hit_tokens,
        COALESCE(SUM(cache_miss_tokens), 0) as cache_miss_tokens,
        COALESCE(SUM(completion_tokens), 0) as completion_tokens,
        COALESCE(SUM(cost_cny), 0) as total_cost_cny,
        COALESCE(SUM(input_cost_cny), 0) as input_cost_cny,
        COALESCE(SUM(output_cost_cny), 0) as output_cost_cny
      FROM api_usage_logs
      WHERE user_id = ? AND COALESCE(user_hidden, 0) = 0
    `).get(userId) as any;

    const totalRequests = agg?.total_requests || 0;
    const totalTokens = agg?.total_tokens || 0;
    const promptTokens = agg?.prompt_tokens || 0;
    const cacheHitTokens = agg?.cache_hit_tokens || 0;
    const cacheMissTokens = agg?.cache_miss_tokens || 0;
    const completionTokens = agg?.completion_tokens || 0;
    const totalCostCny = agg?.total_cost_cny || 0;
    const inputCostCny = agg?.input_cost_cny || 0;
    const outputCostCny = agg?.output_cost_cny || 0;

    const baselineCost =
      (promptTokens / 1_000_000) * currentStatus.rates.cacheMissPerMillion +
      (completionTokens / 1_000_000) * currentStatus.rates.outputPerMillion;
    const savedCostCny = Math.max(0, baselineCost - totalCostCny);
    const cacheHitRate = promptTokens > 0 ? (cacheHitTokens / promptTokens) * 100 : 0;

    const dailyHistory = getDailyHistory(userId);

    return {
      summary: {
        totalRequests,
        totalTokens,
        promptTokens,
        cacheHitTokens,
        cacheMissTokens,
        completionTokens,
        totalCostCny,
        inputCostCny,
        outputCostCny,
        savedCostCny,
        cacheHitRate,
      },
      currentStatus,
      dailyHistory,
    };
  } catch (err: any) {
    console.error('[API Usage] Failed to query stats:', err.message);
    return {
      summary: {
        totalRequests: 0,
        totalTokens: 0,
        promptTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        completionTokens: 0,
        totalCostCny: 0,
        inputCostCny: 0,
        outputCostCny: 0,
        savedCostCny: 0,
        cacheHitRate: 0,
      },
      currentStatus,
      dailyHistory: {
        '1d': [],
        '7d': [],
        '30d': [],
      },
    };
  }
}

export function getDailyHistory(userId: number): {
  '1d': DailyHistoryPoint[];
  '7d': DailyHistoryPoint[];
  '30d': DailyHistoryPoint[];
} {
  const todayRows = db.prepare(`
    SELECT 
      strftime('%H:00', created_at, '+8 hours') as hour,
      COUNT(*) as requests,
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(cost_cny), 0) as cost_cny
    FROM api_usage_logs
    WHERE user_id = ? AND COALESCE(user_hidden, 0) = 0 AND date(created_at, '+8 hours') = date('now', '+8 hours')
    GROUP BY hour
  `).all(userId) as any[];

  const todayMap = new Map<string, { requests: number; tokens: number; cost_cny: number }>();
  todayRows.forEach((r) => {
    todayMap.set(r.hour, {
      requests: Number(r.requests) || 0,
      tokens: Number(r.tokens) || 0,
      cost_cny: Number(r.cost_cny) || 0,
    });
  });

  const history1d: DailyHistoryPoint[] = [];
  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, '0') + ':00';
    const found = todayMap.get(hh);
    history1d.push({
      label: hh,
      date: hh,
      cost_cny: found ? Number(found.cost_cny.toFixed(6)) : 0,
      tokens: found ? found.tokens : 0,
      requests: found ? found.requests : 0,
    });
  }

  const rows7d = db.prepare(`
    SELECT 
      date(created_at, '+8 hours') as day,
      COUNT(*) as requests,
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(cost_cny), 0) as cost_cny
    FROM api_usage_logs
    WHERE user_id = ? AND COALESCE(user_hidden, 0) = 0 AND date(created_at, '+8 hours') >= date('now', '+8 hours', '-6 days')
    GROUP BY day
  `).all(userId) as any[];

  const map7d = new Map<string, { requests: number; tokens: number; cost_cny: number }>();
  rows7d.forEach((r) => {
    map7d.set(r.day, {
      requests: Number(r.requests) || 0,
      tokens: Number(r.tokens) || 0,
      cost_cny: Number(r.cost_cny) || 0,
    });
  });

  const history7d: DailyHistoryPoint[] = [];
  const now = new Date();
  const bjNow = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(bjNow.getTime() - i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const label = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    const found = map7d.get(dateStr);
    history7d.push({
      label,
      date: dateStr,
      cost_cny: found ? Number(found.cost_cny.toFixed(6)) : 0,
      tokens: found ? found.tokens : 0,
      requests: found ? found.requests : 0,
    });
  }

  const rows30d = db.prepare(`
    SELECT 
      date(created_at, '+8 hours') as day,
      COUNT(*) as requests,
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(cost_cny), 0) as cost_cny
    FROM api_usage_logs
    WHERE user_id = ? AND COALESCE(user_hidden, 0) = 0 AND date(created_at, '+8 hours') >= date('now', '+8 hours', '-29 days')
    GROUP BY day
  `).all(userId) as any[];

  const map30d = new Map<string, { requests: number; tokens: number; cost_cny: number }>();
  rows30d.forEach((r) => {
    map30d.set(r.day, {
      requests: Number(r.requests) || 0,
      tokens: Number(r.tokens) || 0,
      cost_cny: Number(r.cost_cny) || 0,
    });
  });

  const history30d: DailyHistoryPoint[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(bjNow.getTime() - i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const label = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    const found = map30d.get(dateStr);
    history30d.push({
      label,
      date: dateStr,
      cost_cny: found ? Number(found.cost_cny.toFixed(6)) : 0,
      tokens: found ? found.tokens : 0,
      requests: found ? found.requests : 0,
    });
  }

  return {
    '1d': history1d,
    '7d': history7d,
    '30d': history30d,
  };
}

/**
 * 个人清屏：仅隐藏用户个人统计可见范围，不删除管理员统计的不可变流水（A06）
 */
export function clearUserUsageLogs(userId: number): boolean {
  try {
    db.prepare('UPDATE api_usage_logs SET user_hidden = 1 WHERE user_id = ?').run(userId);
    return true;
  } catch (err: any) {
    console.error('[API Usage] Failed to hide user logs:', err.message);
    return false;
  }
}

export function getGlobalDailyHistory(scope: 'official' | 'all' = 'official'): {
  '1d': DailyHistoryPoint[];
  '7d': DailyHistoryPoint[];
  '30d': DailyHistoryPoint[];
} {
  const filter = scope === 'official' ? 'is_official = 1 AND ' : '';

  const todayRows = db.prepare(`
    SELECT 
      strftime('%H:00', created_at, '+8 hours') as hour,
      COUNT(*) as requests,
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(cost_cny), 0) as cost_cny
    FROM api_usage_logs
    WHERE ${filter}date(created_at, '+8 hours') = date('now', '+8 hours')
    GROUP BY hour
  `).all() as any[];

  const todayMap = new Map<string, { requests: number; tokens: number; cost_cny: number }>();
  todayRows.forEach((r) => {
    todayMap.set(r.hour, {
      requests: Number(r.requests) || 0,
      tokens: Number(r.tokens) || 0,
      cost_cny: Number(r.cost_cny) || 0,
    });
  });

  const history1d: DailyHistoryPoint[] = [];
  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2, '0') + ':00';
    const found = todayMap.get(hh);
    history1d.push({
      label: hh,
      date: hh,
      cost_cny: found ? Number(found.cost_cny.toFixed(6)) : 0,
      tokens: found ? found.tokens : 0,
      requests: found ? found.requests : 0,
    });
  }

  const rows7d = db.prepare(`
    SELECT 
      date(created_at, '+8 hours') as day,
      COUNT(*) as requests,
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(cost_cny), 0) as cost_cny
    FROM api_usage_logs
    WHERE ${filter}date(created_at, '+8 hours') >= date('now', '+8 hours', '-6 days')
    GROUP BY day
  `).all() as any[];

  const map7d = new Map<string, { requests: number; tokens: number; cost_cny: number }>();
  rows7d.forEach((r) => {
    map7d.set(r.day, {
      requests: Number(r.requests) || 0,
      tokens: Number(r.tokens) || 0,
      cost_cny: Number(r.cost_cny) || 0,
    });
  });

  const history7d: DailyHistoryPoint[] = [];
  const now = new Date();
  const bjNow = new Date(now.getTime() + (now.getTimezoneOffset() + 480) * 60000);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(bjNow.getTime() - i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const label = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    const found = map7d.get(dateStr);
    history7d.push({
      label,
      date: dateStr,
      cost_cny: found ? Number(found.cost_cny.toFixed(6)) : 0,
      tokens: found ? found.tokens : 0,
      requests: found ? found.requests : 0,
    });
  }

  const rows30d = db.prepare(`
    SELECT 
      date(created_at, '+8 hours') as day,
      COUNT(*) as requests,
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(cost_cny), 0) as cost_cny
    FROM api_usage_logs
    WHERE ${filter}date(created_at, '+8 hours') >= date('now', '+8 hours', '-29 days')
    GROUP BY day
  `).all() as any[];

  const map30d = new Map<string, { requests: number; tokens: number; cost_cny: number }>();
  rows30d.forEach((r) => {
    map30d.set(r.day, {
      requests: Number(r.requests) || 0,
      tokens: Number(r.tokens) || 0,
      cost_cny: Number(r.cost_cny) || 0,
    });
  });

  const history30d: DailyHistoryPoint[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(bjNow.getTime() - i * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const label = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    const found = map30d.get(dateStr);
    history30d.push({
      label,
      date: dateStr,
      cost_cny: found ? Number(found.cost_cny.toFixed(6)) : 0,
      tokens: found ? found.tokens : 0,
      requests: found ? found.requests : 0,
    });
  }

  return {
    '1d': history1d,
    '7d': history7d,
    '30d': history30d,
  };
}

export function getGlobalUsageStats(
  currentModel?: string,
  scope: 'official' | 'all' = 'official'
): UserUsageStats {
  const effectiveModel = currentModel || getGlobalApiConfig().api1.model || 'deepseek-chat';
  const currentStatus = getModelPricingPeriod(new Date(), effectiveModel, true);
  const whereClause = scope === 'official' ? 'WHERE is_official = 1' : '';

  try {
    const agg = db.prepare(`
      SELECT 
        COUNT(*) as total_requests,
        COALESCE(SUM(total_tokens), 0) as total_tokens,
        COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
        COALESCE(SUM(cache_hit_tokens), 0) as cache_hit_tokens,
        COALESCE(SUM(cache_miss_tokens), 0) as cache_miss_tokens,
        COALESCE(SUM(completion_tokens), 0) as completion_tokens,
        COALESCE(SUM(cost_cny), 0) as total_cost_cny,
        COALESCE(SUM(input_cost_cny), 0) as input_cost_cny,
        COALESCE(SUM(output_cost_cny), 0) as output_cost_cny
      FROM api_usage_logs
      ${whereClause}
    `).get() as any;

    const totalRequests = agg?.total_requests || 0;
    const totalTokens = agg?.total_tokens || 0;
    const promptTokens = agg?.prompt_tokens || 0;
    const cacheHitTokens = agg?.cache_hit_tokens || 0;
    const cacheMissTokens = agg?.cache_miss_tokens || 0;
    const completionTokens = agg?.completion_tokens || 0;
    const totalCostCny = agg?.total_cost_cny || 0;
    const inputCostCny = agg?.input_cost_cny || 0;
    const outputCostCny = agg?.output_cost_cny || 0;

    const baselineCost =
      (promptTokens / 1_000_000) * currentStatus.rates.cacheMissPerMillion +
      (completionTokens / 1_000_000) * currentStatus.rates.outputPerMillion;
    const savedCostCny = Math.max(0, baselineCost - totalCostCny);
    const cacheHitRate = promptTokens > 0 ? (cacheHitTokens / promptTokens) * 100 : 0;

    const dailyHistory = getGlobalDailyHistory(scope);

    const recentLogs = db.prepare(`
      SELECT 
        l.id, l.user_id, u.username, l.model, l.prompt_tokens, l.completion_tokens,
        l.total_tokens, l.cache_hit_tokens, l.cache_miss_tokens, l.is_peak,
        l.cost_cny, l.input_cost_cny, l.output_cost_cny, l.request_type,
        l.is_official, l.created_at
      FROM api_usage_logs l
      LEFT JOIN users u ON l.user_id = u.id
      ${scope === 'official' ? 'WHERE l.is_official = 1' : ''}
      ORDER BY l.id DESC
      LIMIT 15
    `).all() as any[];

    return {
      summary: {
        totalRequests,
        totalTokens,
        promptTokens,
        cacheHitTokens,
        cacheMissTokens,
        completionTokens,
        totalCostCny,
        inputCostCny,
        outputCostCny,
        savedCostCny,
        cacheHitRate,
      },
      scope,
      currentStatus,
      dailyHistory,
      recentLogs,
    };
  } catch (err: any) {
    console.error('[API Usage] Failed to query global stats:', err.message);
    return {
      summary: {
        totalRequests: 0,
        totalTokens: 0,
        promptTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        completionTokens: 0,
        totalCostCny: 0,
        inputCostCny: 0,
        outputCostCny: 0,
        savedCostCny: 0,
        cacheHitRate: 0,
      },
      scope,
      currentStatus,
      dailyHistory: {
        '1d': [],
        '7d': [],
        '30d': [],
      },
      recentLogs: [],
    };
  }
}
