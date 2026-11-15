import { db } from '../config/database.js';

export interface DeepSeekPricingPeriod {
  isPeak: boolean;
  periodLabel: string;
  beijingTimeStr: string;
  rates: {
    cacheHitPerMillion: number;
    cacheMissPerMillion: number;
    outputPerMillion: number;
  };
}

/**
 * 获取当前北京时间 (UTC+8) 的峰谷时段信息与单价（元/百万 Tokens）
 * 规则：
 * - 峰时（高峰时段）：北京时间周一至周五 09:00 - 12:00 与 14:00 - 18:00
 * - 谷时（空闲时段）：其余所有时段，包括工作日夜间/早晨，以及周末（周六、周日）全天统一享受半价（5折）
 */
export function getDeepSeekPricingPeriod(
  date: Date = new Date(),
  model: string = 'deepseek-chat'
): DeepSeekPricingPeriod {
  // 转换到北京时间 (Asia/Shanghai)
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

  // 获取星期几（周日为 0，周六为 6）
  const weekdayStr = getPart('weekday');
  const isWeekend = weekdayStr.includes('六') || weekdayStr.includes('日') || weekdayStr.includes('Sat') || weekdayStr.includes('Sun');

  let isPeak = false;
  let periodLabel = '谷时 (空闲5折时段)';

  if (isWeekend) {
    isPeak = false;
    periodLabel = '谷时 (周末全天5折)';
  } else {
    // 工作日：09:00 - 12:00 (540 ~ 720) 或 14:00 - 18:00 (840 ~ 1080)
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

  // 每百万 Tokens 价格（元）
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
    periodLabel,
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
  createdAt?: string;
}

/**
 * 记录一次 API 调用的 Token 消耗并自动按峰谷价格折算金额
 */
export function recordApiUsage(
  userId: number,
  model: string,
  usage: any,
  requestType: string = 'weixin_chat'
): ApiUsageRecord | null {
  if (!usage || !userId) return null;

  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const totalTokens = usage.total_tokens || (promptTokens + completionTokens);

  // 解析缓存命中 Token（DeepSeek 直接返回 prompt_cache_hit_tokens，或 prompt_tokens_details.cached_tokens）
  const cacheHitTokens =
    usage.prompt_cache_hit_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    0;

  const cacheMissTokens =
    usage.prompt_cache_miss_tokens ??
    Math.max(0, promptTokens - cacheHitTokens);

  const { isPeak, rates } = getDeepSeekPricingPeriod(new Date(), model);

  const inputCostCny =
    (cacheHitTokens / 1_000_000) * rates.cacheHitPerMillion +
    (cacheMissTokens / 1_000_000) * rates.cacheMissPerMillion;

  const outputCostCny = (completionTokens / 1_000_000) * rates.outputPerMillion;
  const costCny = inputCostCny + outputCostCny;

  try {
    const stmt = db.prepare(`
      INSERT INTO api_usage_logs (
        user_id, model, prompt_tokens, completion_tokens, total_tokens,
        cache_hit_tokens, cache_miss_tokens, is_peak, cost_cny,
        input_cost_cny, output_cost_cny, request_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      userId,
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      cacheHitTokens,
      cacheMissTokens,
      isPeak ? 1 : 0,
      costCny,
      inputCostCny,
      outputCostCny,
      requestType
    );

    return {
      userId,
      model,
      promptTokens,
      completionTokens,
      totalTokens,
      cacheHitTokens,
      cacheMissTokens,
      isPeak,
      costCny,
      inputCostCny,
      outputCostCny,
      requestType,
    };
  } catch (err: any) {
    console.error('[API Usage] Failed to record usage log:', err.message);
    return null;
  }
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
    savedCostCny: number; // 相比于全峰时未命中价格节省的金额
    cacheHitRate: number; // 命中百分比 0 ~ 100
  };
  currentStatus: DeepSeekPricingPeriod;
  recentLogs: Array<{
    id: number;
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
    created_at: string;
  }>;
}

/**
 * 查询指定用户的用量统计汇总与最近调用明细
 */
export function getUserUsageStats(userId: number, currentModel: string = 'deepseek-chat'): UserUsageStats {
  const currentStatus = getDeepSeekPricingPeriod(new Date(), currentModel);

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
      WHERE user_id = ?
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

    // 计算如果全按高峰期标准未命中价格计算的基础理论成本：
    // (Prompt / 1M * 2.0) + (Output / 1M * 8.0)
    const baselineCost = (promptTokens / 1_000_000) * 2.0 + (completionTokens / 1_000_000) * 8.0;
    const savedCostCny = Math.max(0, baselineCost - totalCostCny);

    const cacheHitRate = promptTokens > 0 ? (cacheHitTokens / promptTokens) * 100 : 0;

    const recentLogs = db.prepare(`
      SELECT 
        id, model, prompt_tokens, completion_tokens, total_tokens,
        cache_hit_tokens, cache_miss_tokens, is_peak, cost_cny,
        input_cost_cny, output_cost_cny, request_type, created_at
      FROM api_usage_logs
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 50
    `).all(userId) as any[];

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
      recentLogs,
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
      recentLogs: [],
    };
  }
}

/**
 * 清空用户的 API 用量记录
 */
export function clearUserUsageLogs(userId: number): boolean {
  try {
    db.prepare('DELETE FROM api_usage_logs WHERE user_id = ?').run(userId);
    return true;
  } catch (err: any) {
    console.error('[API Usage] Failed to clear logs:', err.message);
    return false;
  }
}
