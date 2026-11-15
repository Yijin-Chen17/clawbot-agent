import OpenAI from 'openai';
import { LLMExtractionResult, UserSettings } from '../models/types.js';
import { recordApiUsage } from './llmPricing.js';

export async function parseUserMessageWithLLM(
  message: string,
  settings: UserSettings,
  pendingContext?: any
): Promise<LLMExtractionResult> {
  const endpoint = settings.llm_endpoint || 'https://api.deepseek.com/v1';
  const apiKey = settings.llm_api_key || process.env.DEEPSEEK_API_KEY || '';
  const model = settings.llm_model || 'deepseek-chat';

  if (!apiKey) {
    throw new Error('未配置 LLM API Key，请先在管理后台设置中填入 DeepSeek API Key');
  }

  const client = new OpenAI({
    baseURL: endpoint,
    apiKey: apiKey,
  });

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

  const systemPrompt = `你是一个智能日程与任务提取助手。
当前时间上下文是：${currentLocalTimeStr}（中国标准时间）。
请分析用户的微信消息，提取日程与待办事项关键信息，并严格以纯 JSON 格式返回，不要包含 markdown 标记或任何其他文本。
必须严格与 oxoxox-oxox/Eisenhower-Matrix 任务模型字段标准对齐。

JSON 格式规范：
{
  "intent": "create_task" | "status_update" | "query_schedule" | "delete_item" | "modify_item" | "other",
  "title": string | null,               // 任务名称/事件标题
  "description": string | null,         // 任务背景描述、备注或详情
  "estimatedMinutes": number | null,    // 预计耗时分钟数（例如 1小时提取为 60，半小时为 30，20小时为 1200）
  "duration_minutes": number | null,    // 同 estimatedMinutes，预估耗时分钟数
  "importance": number | null,          // 战略重要度评分，浮点数 0.0 ~ 10.0（5.0为重要临界线，涉及核心交付、领导、关键考试为 7.0~9.0，一般事务为 2.0~4.0，默认 7.0）
  "urgency": number | null,             // 紧迫度评分，浮点数 0.0 ~ 10.0（若用户未明说，将依据截止期迫近算法由 dueDate 自动计算，可设为 null 或 2.0~5.0）
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
   - 用户说"明天下午写代码2小时" -> intent: "create_task", title: "写代码", duration_minutes: 120
   - 用户说"安排固定任务 明天下午2点到4点开会" -> intent: "create_task", title: "开会", is_fixed: true, fixed_start: "...14:00...", fixed_end: "...16:00...", duration_minutes: 120
   - 用户说"安排双线程任务 听英文播客1小时" -> intent: "create_task", title: "听英文播客", is_concurrent: true, duration_minutes: 60
   - 长时间任务，如"15天后期末考我要复习20小时" -> intent: "create_task", title: "期末考复习", duration_minutes: 1200, importance: 9.0, urgency: 3.0, dueDate: 15天后日期
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
7. 若用户正在回答上一轮补齐问题（当前待补齐上下文：${JSON.stringify(pendingContext || null)}），请将新消息与该上下文合并。`;

  try {
    const response = await client.chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('LLM 返回内容为空');
    }

    if (response.usage && settings.user_id) {
      recordApiUsage(settings.user_id, model, response.usage, 'weixin_chat');
    }

    const parsed = JSON.parse(content) as LLMExtractionResult;
    return parsed;
  } catch (err: any) {
    console.error('LLM 解析出错:', err.message);
    throw err;
  }
}
