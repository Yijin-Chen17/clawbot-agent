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
  isOfficial?: boolean;
  createdAt?: string;
}

/**
 * 记录一次 API 调用的 Token 消耗并自动按峰谷价格折算金额
 */
export function recordApiUsage(
  userId: number,
  model: string,
  usage: any,
  requestType: string = 'weixin_chat',
  isOfficial: boolean = false
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
        input_cost_cny, output_cost_cny, request_type, is_official
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      requestType,
      isOfficial ? 1 : 0
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
      isOfficial,
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
 * 查询指定用户的用量统计汇总与前 1天/7天/30天 价格曲线数据
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

    const baselineCost = (promptTokens / 1_000_000) * 2.0 + (completionTokens / 1_000_000) * 8.0;
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

/**
 * 统计前 1 天 (按小时) / 7 天 / 30 天每日资费消耗曲线数据
 */
export function getDailyHistory(userId: number): {
  '1d': DailyHistoryPoint[];
  '7d': DailyHistoryPoint[];
  '30d': DailyHistoryPoint[];
} {
  // 1. 今日 24 小时 (1d)
  const todayRows = db.prepare(`
    SELECT 
      strftime('%H:00', created_at, '+8 hours') as hour,
      COUNT(*) as requests,
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(cost_cny), 0) as cost_cny
    FROM api_usage_logs
    WHERE user_id = ? AND date(created_at, '+8 hours') = date('now', '+8 hours')
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

  // 2. 过去 7 天 (7d)
  const rows7d = db.prepare(`
    SELECT 
      date(created_at, '+8 hours') as day,
      COUNT(*) as requests,
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(cost_cny), 0) as cost_cny
    FROM api_usage_logs
    WHERE user_id = ? AND date(created_at, '+8 hours') >= date('now', '+8 hours', '-6 days')
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

  // 3. 过去 30 天 (30d)
  const rows30d = db.prepare(`
    SELECT 
      date(created_at, '+8 hours') as day,
      COUNT(*) as requests,
      COALESCE(SUM(total_tokens), 0) as tokens,
      COALESCE(SUM(cost_cny), 0) as cost_cny
    FROM api_usage_logs
    WHERE user_id = ? AND date(created_at, '+8 hours') >= date('now', '+8 hours', '-29 days')
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

/**
 * 统计全平台前 1 天 / 7 天 / 30 天每日资费消耗曲线数据
 * @param scope 'official' (仅统计官方全局接口) 或 'all' (包含用户私有 Key)
 */
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

/**
 * 查询全平台用量统计汇总与前 1天/7天/30天 价格曲线数据
 * @param scope 'official' (默认，仅统计官方全局接口) 或 'all' (全平台所有调用，包含用户私有Key)
 */
export function getGlobalUsageStats(
  currentModel: string = 'deepseek-chat',
  scope: 'official' | 'all' = 'official'
): UserUsageStats {
  const currentStatus = getDeepSeekPricingPeriod(new Date(), currentModel);
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

    const baselineCost = (promptTokens / 1_000_000) * 2.0 + (completionTokens / 1_000_000) * 8.0;
    const savedCostCny = Math.max(0, baselineCost - totalCostCny);
    const cacheHitRate = promptTokens > 0 ? (cacheHitTokens / promptTokens) * 100 : 0;

    const dailyHistory = getGlobalDailyHistory(scope);

    // 查询最近 15 条全局用量调用日志
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
