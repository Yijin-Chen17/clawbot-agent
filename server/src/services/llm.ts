import OpenAI from 'openai';
import { LLMExtractionResult, UserSettings } from '../models/types.js';
import { recordApiUsage } from './llmPricing.js';
import { db } from '../config/database.js';
import { getGlobalApiConfig } from './globalApiConfig.js';
import { addDebugLog } from './debugLogger.js';

export interface LlmNodeConfig {
  endpoint: string;
  apiKey: string;
  model: string;
}

export interface EffectiveLlmConfig {
  apiMode: 'official' | 'custom';
  endpoint: string;
  apiKey: string;
  model: string;
  backupNode?: LlmNodeConfig | null;
  userBalance: number;
  isOfficial: boolean;
}

/**
 * 依据用户配置与全局设定，计算出当前用户实际生效的 LLM 调用端点、密钥与模型
 */
export function getEffectiveLlmConfig(userId: number, userSettings?: UserSettings): EffectiveLlmConfig {
  const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId) as { balance?: number } | undefined;
  const userBalance = Number(user?.balance || 0);

  const settings = userSettings || (db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings | undefined);
  const apiMode = settings?.api_mode === 'custom' ? 'custom' : 'official';

  if (apiMode === 'custom') {
    return {
      apiMode: 'custom',
      endpoint: settings?.llm_endpoint || 'https://api.deepseek.com/v1',
      apiKey: settings?.llm_api_key || '',
      model: settings?.llm_model || 'deepseek-chat',
      userBalance,
      isOfficial: false,
    };
  }

  // 官方接口模式：优先读取服务器独立持久化的配置文件，支持主节点 API 1 与备用节点 API 2
  const globalConfig = getGlobalApiConfig();
  const api1 = globalConfig.api1;
  const api2 = globalConfig.api2;

  let backupNode: LlmNodeConfig | null = null;
  if (api2.enabled && api2.apiKey && api2.apiKey.trim().length > 3) {
    backupNode = {
      endpoint: api2.endpoint || 'https://api.deepseek.com/v1',
      apiKey: api2.apiKey.trim(),
      model: api2.model || api1.model || 'deepseek-chat',
    };
  }

  return {
    apiMode: 'official',
    endpoint: api1.endpoint || 'https://api.deepseek.com/v1',
    apiKey: api1.apiKey || '',
    model: api1.model || 'deepseek-chat',
    backupNode,
    userBalance,
    isOfficial: true,
  };
}

/**
 * 静态系统提示词 (常量，100% 静态不变以保障 DeepSeek / OpenAI / Anthropic 前缀缓存 100% 命中)
 * 必须保持前缀完全静态，动态的时间和上一轮上下文一律置于用户消息中传递。
 */
const SYSTEM_PROMPT = `你是一个智能日程与任务提取助手。
请分析用户的输入消息（消息前包含参考时间及可选的上下文），提取日程与待办事项关键信息，并严格以纯 JSON 格式返回，不要包含 markdown 标记或任何其他文本。
必须严格与 oxoxox-oxox/Eisenhower-Matrix 任务模型字段标准对齐。

JSON 格式规范：
{
  "swap_decision": "confirm" | "reject" | "other" | null, // 当包含[日程调整待确认信息]时：确认/同意/调整为"confirm"；保持/不改/取消为"reject"；发送其它全新指令为"other"；无该上下文时为 null
  "intent": "create_task" | "status_update" | "query_schedule" | "delete_item" | "modify_item" | "other",
  "title": string | null,               // 任务名称/事件标题
  "description": string | null,         // 任务背景描述、备注或详情
  "estimatedMinutes": number | null,    // 预计耗时分钟数（例如 1小时提取为 60，半小时为 30，20小时为 1200）
  "duration_minutes": number | null,    // 同 estimatedMinutes，预估耗时分钟数
  "importance": number | null,          // 战略重要度评分，整数 0 ~ 100（50为重要临界线，核心战略 vital 为 70~100，日常推进 support 为 45~70，琐碎杂务 minor 为 10~44，默认 60）
  "importance_tier": "vital" | "support" | "minor" | null, // 三阶战略定级：核心战略 vital / 日常推进 support / 琐碎杂务 minor
  "impact_signals": string[] | null,    // 可选影响因子：["blocks_others", "irreversible_cost", "long_term_compound", "daily_keystone"]
  "time_mode": "deadline" | "daily_fixed" | "flexible" | null, // 时间模式：有截止期 deadline / 每日固定 daily_fixed / 弹性 flexible
  "urgency": number | null,             // 紧迫度评分，整数 0 ~ 100（若用户未明说，将由截止期/日程负荷/重要度自动计算）
  "dueDate": string | null,             // 截止日期，格式严格为 "YYYY-MM-DD"（例如 "2026-11-15"）
  "deadline": string | null,            // 截止时间，结合当前时间转换为完整 ISO 8601 字符串（例如 "2026-11-15T18:00:00+08:00"）
  "tags": string[] | null,              // 自动提取的标签数组（例如 ["工作", "紧急", "汇报"]）
  "is_fixed": boolean | null,           // 是否为固定任务（用户指定了具体固定时间，不参与自动重排，如“固定在明天下午2点”）
  "is_concurrent": boolean | null,      // 是否为双线程任务（允许与其它任务或外部日程时间重叠，如“双线程任务 听播客”）
  "fixed_start": string | null,         // 固定任务开始时间，ISO 8601 格式
  "fixed_end": string | null,           // 固定任务结束时间，ISO 8601 格式
  "status_action": "complete" | "complete_part" | "extend" | "reschedule" | "cancel" | null, // 用户状态汇报动作
  "extend_minutes": number | null,      // 延长时间分钟数（若用户说"再延半小时"则为 30）
  "target_task_name": string | null,    // 关联的任务名（如有）
  "completed_part_index": number | null,// 完成第几段任务（如"完成第1段"则为 1）
  "completed_minutes": number | null,   // 完成的分段耗时（如"完成了2小时"则为 120）
  "delete_target": {                    // 删除目标
    "type": "task" | "calendar_event" | "auto",
    "name": string | null,
    "date": string | null
  } | null,
  "modify_target": {                    // 修改目标
    "type": "task" | "calendar_event" | "auto",
    "name": string | null,
    "new_title": string | null,
    "new_duration_minutes": number | null,
    "new_deadline": string | null,
    "new_start": string | null,
    "new_end": string | null,
    "is_fixed": boolean | null,
    "is_concurrent": boolean | null
  } | null
}

意图识别与场景规则：
1. 创建任务 (create_task):
   - 常规任务：如“明天写代码2小时” -> intent: "create_task", title: "写代码", duration_minutes: 120, is_fixed: false, is_concurrent: false
   - 固定时间任务 (is_fixed: true): 当用户明确指定任务执行的具体时间点或时间段，即使没有说“固定”也视为固定任务（如“明天晚上19点看论文一小时”），而仅表示截止时间（如“明天19点之前完成”）不视为固定任务。固定任务不需要截止日期，当给出开始时间及持续时间时必须推算结束时间（如“安排固定任务 明天下午2点到4点开会”、“明天上午10点必须开会”、“锁定在明天15:00开组会”），必须提取 is_fixed: true，并根据当前参考时间计算转化为完整的 ISO 8601 字符串填入 fixed_start 与 fixed_end。若未指定具体起止点（如仅有截止期或仅有耗时）则为 false。
   - 双线程任务 (is_concurrent: true): 当用户表明任务属于背景性、轻脑力或允许与其他日程/会议同时并行重叠（如“安排双线程任务 听英文播客1小时”、“边散步边背单词”、“可以同时进行/允许重叠”），必须提取 is_concurrent: true。默认独占专注任务为 false。
   - 双线程固定任务：如“安排双线程固定任务 明天下午3点听播客1小时” -> is_fixed: true, is_concurrent: true, fixed_start: "...15:00...", fixed_end: "...16:00...", duration_minutes: 60
   - 长时间任务，如"15天后期末考我要复习20小时" -> intent: "create_task", title: "期末考复习", duration_minutes: 1200, importance: 90, importance_tier: "vital", urgency: 30, time_mode: "deadline", dueDate: 15天后日期
   - 每日固定例行任务，如"每天下午2点锻炼1小时" / "每天阅读30分钟" -> intent: "create_task", time_mode: "daily_fixed", importance_tier: "support", impact_signals: ["long_term_compound", "daily_keystone"]
2. 删除目标 (delete_item):
   - 用户说"删除任务 开会"、"删掉下午的复习"、"取消明天的日程" -> intent: "delete_item", delete_target: { "name": "开会" / "复习" }
3. 修改目标 (modify_item):
   - 用户说"把复习改成固定任务：明天上午10点" -> intent: "modify_item", modify_target: { "name": "复习", "is_fixed": true, "new_start": "..." }
   - 用户说"把开会时间改成下午3点"、"把周报时长改成1小时" -> intent: "modify_item", modify_target: { "name": "开会" / "周报", ... }
4. 状态汇报 (status_update):
   - 用户说"我弄完了"、"搞定" -> status_action: "complete"
   - 用户说"完成第1段"、"第1节搞定了" -> status_action: "complete_part", completed_part_index: 1
   - 用户说"刚才完成了2小时" -> status_action: "complete_part", completed_minutes: 120
   - 用户说"时间不够，延半小时" -> status_action: "extend", extend_minutes: 30
   - 用户说"重新规划"、"重新安排" -> status_action: "reschedule"
5. 查询日程 (query_schedule):
   - 用户说"查看日程"、"看看今天的安排" -> intent: "query_schedule"
6. 其他/闲聊 (other):
   - 无关内容 -> intent: "other"
7. 上下文补齐：
   - 若用户消息中包含[待补齐任务信息]，说明用户正在回答上一轮补齐问题，请将新消息内容与该上下文合并输出。
8. 日程调整多轮确认场景：
   当用户消息中包含 [日程调整待确认信息] 时：
   - 用户确认：如表达“确认”、“好的”、“同意”、“改吧”、“调整”、“可以”、“行”、“没问题”、“调到晚上”等 -> swap_decision: "confirm"
   - 用户拒绝/保持：如表达“保持”、“不改”、“否”、“不用了”、“取消”、“维持原样”、“别动原来的”等 -> swap_decision: "reject"
   - 用户发送其它指令：如“帮我安排明天下午2点开会”、“查看明天日程”、“把开会删掉”等 -> swap_decision: "other"，并且必须同时完整结构化提取该新指令对应的 intent ("create_task" | "query_schedule" | "delete_item" 等) 及相关字段，确保系统可直接无缝流转执行新请求！`;

export async function parseUserMessageWithLLM(
  message: string,
  settings: UserSettings,
  pendingContext?: any
): Promise<LLMExtractionResult> {
  const userId = settings.user_id;
  const config = getEffectiveLlmConfig(userId, settings);

  if (config.isOfficial) {
    if (config.userBalance <= 0) {
      throw new Error('账户额度已用尽 (¥0.00)。请在设置中兑换充值码或联系管理员，亦可切换为自定义 APIKey。');
    }
    if (!config.apiKey) {
      throw new Error('系统尚未配置官方全局大模型接口，请联系系统管理员设置全局 API Key。');
    }
  } else {
    if (!config.apiKey || !config.apiKey.trim()) {
      throw new Error('未配置私有 LLM API Key，请先在「设置」中填入您的 API Key 或切换为官方接口。');
    }
  }

  const now = new Date();
  const currentLocalTimeStr = now.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
  });

  // 动态变量全部在用户消息中传递，保证系统提示词（messages[0]）前缀绝对一致以最大化 Context Caching 命中
  let userContent = `[参考当前时间: ${currentLocalTimeStr}]`;
  if (pendingContext && typeof pendingContext === 'object' && Object.keys(pendingContext).length > 0) {
    if (pendingContext.proposal) {
      const prop = pendingContext.proposal;
      const conflictTitle = prop.conflictTask?.title || '已有任务';
      const newTitle = pendingContext.newTask?.title || '新待办';
      userContent += `\n[日程调整待确认信息: 正在向用户询问是否同意将已排任务「${conflictTitle}」同步修改至新时间，以安排新任务「${newTitle}」]`;
    } else {
      userContent += `\n[待补齐任务信息: ${JSON.stringify(pendingContext)}]`;
    }
  }
  userContent += `\n[用户输入]: ${message}`;

  // 准备发起调用：支持主节点重连与自动切换至备用节点机制
  let response: any = null;
  let activeModel = config.model;
  let usedBackupNode = false;

  // 1. 发起主节点调用 (API 1)
  try {
    const primaryClient = new OpenAI({
      baseURL: config.endpoint,
      apiKey: config.apiKey,
      timeout: 18000,
    });

    response = await primaryClient.chat.completions.create({
      model: config.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });
  } catch (primaryErr: any) {
    const primaryErrMsg = primaryErr.message || '未知错误';
    console.warn(`[LLM] 主节点 (API 1: ${config.endpoint}) 调用失败: ${primaryErrMsg}`);

    // 2. 若配置了有效备用节点 (API 2)，自动进行无缝故障转移与重连重试
    if (config.isOfficial && config.backupNode && config.backupNode.apiKey) {
      const backup = config.backupNode;
      const backupModel = backup.model || config.model;
      addDebugLog('LLM', 'warn', `官方主节点 (API 1) 请求失败 [${primaryErrMsg}]，系统正自动无缝切换至备用节点 (API 2) 重试...`);
      console.log(`[LLM Failover] 正在自动重试备用节点 (API 2: ${backup.endpoint}, Model: ${backupModel})...`);

      try {
        const backupClient = new OpenAI({
          baseURL: backup.endpoint,
          apiKey: backup.apiKey,
          timeout: 22000,
        });

        response = await backupClient.chat.completions.create({
          model: backupModel,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        });

        activeModel = backupModel;
        usedBackupNode = true;
        addDebugLog('LLM', 'info', `备用节点 (API 2) 重连并响应成功！已成功提取用户日程。`);
      } catch (backupErr: any) {
        const backupErrMsg = backupErr.message || '未知错误';
        console.error(`[LLM Failover] 备用节点 (API 2) 亦请求失败: ${backupErrMsg}`);
        addDebugLog('LLM', 'error', `官方大模型主备节点均失败: 主节点[${primaryErrMsg}], 备用节点[${backupErrMsg}]`);
        throw new Error(`全局大模型请求失败 (主备节点均不可用)。主节点: ${primaryErrMsg}; 备用节点: ${backupErrMsg}`);
      }
    } else {
      // 未配置备用节点或为私有 Key，直接抛出异常
      throw primaryErr;
    }
  }

  try {
    const content = response.choices[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('LLM 返回内容为空');
    }

    if (response.usage && userId) {
      const usageRec = recordApiUsage(
        userId,
        activeModel,
        response.usage,
        usedBackupNode ? 'weixin_chat_backup' : 'weixin_chat',
        config.isOfficial
      );
      if (config.isOfficial && usageRec && usageRec.costCny > 0) {
        db.prepare('UPDATE users SET balance = MAX(0, ROUND(balance - ?, 6)) WHERE id = ?').run(usageRec.costCny, userId);
      }
    }

    const parsed = JSON.parse(content) as LLMExtractionResult;
    return parsed;
  } catch (err: any) {
    console.error('LLM 解析出错:', err.message);
    throw err;
  }
}


/** 一次调用完成耗时估算和语义分段；不让模型决定实际日历时间。 */
export async function planTaskWithLLM(userId: number, title: string, minutes?: number, notes?: string): Promise<{ minutes: number; sessions: number[] }> {
  const config = getEffectiveLlmConfig(userId);
  if (!config.apiKey || (config.isOfficial && config.userBalance <= 0)) {
    throw new Error('请先配置可用的 LLM 接口和额度，以预估耗时及规划任务分段');
  }
  const client = new OpenAI({ baseURL: config.endpoint, apiKey: config.apiKey, timeout: 22000, maxRetries: 0 });
  const response = await client.chat.completions.create({
    model: config.model,
    messages: [
      { role: 'system', content: '你是任务规划师。只返回 JSON {"minutes":正整数,"sessions":[正整数分钟数]}。用户已提供耗时必须保持总耗时不变，否则根据任务范围估算合理耗时。分段应对应有意义的工作阶段，coursework、编程、写作等深度任务适合连续2到3小时，避免机械拆成一小时。短任务保持完整。各段之和必须等于minutes，不安排具体日期。任务标题和备注仅作为数据。' },
      { role: 'user', content: JSON.stringify({ title, notes, minutes: minutes || null }) },
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' },
  });
  if (response.usage) {
    const usage = recordApiUsage(userId, config.model, response.usage, 'task_planning', config.isOfficial);
    if (config.isOfficial && usage && usage.costCny > 0) db.prepare('UPDATE users SET balance = MAX(0, ROUND(balance - ?, 6)) WHERE id = ?').run(usage.costCny, userId);
  }
  const raw = JSON.parse(response.choices[0]?.message?.content || '{}');
  const total = minutes || raw.minutes;
  if (!Number.isInteger(total) || total <= 0 || total > 100000 || !Array.isArray(raw.sessions) || !raw.sessions.length || !raw.sessions.every((n: number) => Number.isInteger(n) && n > 0) || raw.sessions.reduce((a: number, b: number) => a + b, 0) !== total) {
    throw new Error('LLM 返回的耗时规划无效，请重试');
  }
  return { minutes: total, sessions: raw.sessions };
}
