/**
 * 周期任务重复规则定义与解析工具
 * 支持：
 * 1. 每日重复 (daily)
 * 2. 每周特定星期几重复 (weekly: [0, 1, 2, 3, 4, 5, 6] 对应周日到周六)
 */

export type RecurrenceType = 'daily' | 'weekly';

export interface RecurrenceRule {
  type: RecurrenceType;
  /**
   * 0 = 周日 (Sunday), 1 = 周一 (Monday), ..., 6 = 周六 (Saturday)
   * 仅在 type === 'weekly' 时使用
   */
  daysOfWeek?: number[];
}

/**
 * 默认每日重复规则
 */
export const DEFAULT_RECURRENCE_RULE: RecurrenceRule = {
  type: 'daily',
  daysOfWeek: [1, 2, 3, 4, 5, 6, 0],
};

/**
 * 将字符串解析为 RecurrenceRule 对象
 */
export function parseRecurrenceRule(raw?: string | null): RecurrenceRule {
  if (!raw) {
    return { type: 'daily' };
  }
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === 'object') {
      const type: RecurrenceType = parsed.type === 'weekly' ? 'weekly' : 'daily';
      let daysOfWeek: number[] | undefined;
      if (Array.isArray(parsed.daysOfWeek)) {
        daysOfWeek = parsed.daysOfWeek
          .map((d: any) => Number(d))
          .filter((d: number) => !isNaN(d) && d >= 0 && d <= 6);
      }
      if (type === 'weekly' && (!daysOfWeek || daysOfWeek.length === 0)) {
        daysOfWeek = [1, 2, 3, 4, 5]; // 默认工作日
      }
      return type === 'weekly' ? { type, daysOfWeek } : { type: 'daily' };
    }
  } catch {
    // 忽略异常
  }
  return { type: 'daily' };
}

/**
 * 将 RecurrenceRule 对象序列化为存储 JSON 字符串
 */
export function stringifyRecurrenceRule(rule?: RecurrenceRule | null): string {
  if (!rule || rule.type === 'daily') {
    return JSON.stringify({ type: 'daily' });
  }
  const cleanDays = Array.from(new Set(rule.daysOfWeek || [])).sort();
  return JSON.stringify({
    type: 'weekly',
    daysOfWeek: cleanDays.length > 0 ? cleanDays : [1, 2, 3, 4, 5],
  });
}

/**
 * 判断指定日期（本地时区 Date 对象或 YYYY-MM-DD 字符串）是否命中该周期任务
 */
export function isDateMatchingRecurrence(
  dateInput: Date | string,
  ruleInput?: RecurrenceRule | string | null
): boolean {
  const rule = typeof ruleInput === 'string' || !ruleInput ? parseRecurrenceRule(ruleInput) : ruleInput;
  if (rule.type === 'daily') {
    return true;
  }
  let date: Date;
  if (typeof dateInput === 'string') {
    if (dateInput.includes('T')) {
      date = new Date(dateInput);
    } else {
      const [y, m, d] = dateInput.split('-').map(Number);
      date = new Date(y, m - 1, d);
    }
  } else {
    date = dateInput;
  }

  const dayOfWeek = date.getDay(); // 0 是周日, 1 是周一...
  const activeDays = rule.daysOfWeek || [];
  return activeDays.includes(dayOfWeek);
}

/**
 * 生成人类友好的描述摘要
 */
export function formatRecurrenceSummary(
  ruleInput?: RecurrenceRule | string | null,
  language: 'zh' | 'en' = 'zh'
): string {
  const rule = typeof ruleInput === 'string' || !ruleInput ? parseRecurrenceRule(ruleInput) : ruleInput;
  if (rule.type === 'daily') {
    return language === 'en' ? 'Every day' : '每日重复';
  }

  const days = rule.daysOfWeek || [];
  if (days.length === 7) {
    return language === 'en' ? 'Every day' : '每日重复';
  }
  if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) {
    return language === 'en' ? 'Weekdays (Mon–Fri)' : '工作日 (周一至周五)';
  }
  if (days.length === 2 && [0, 6].every((d) => days.includes(d))) {
    return language === 'en' ? 'Weekends (Sat & Sun)' : '周末 (周六、周日)';
  }

  const zhLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const enLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // 排序：周一到周六，周日放最后更符合习惯
  const sorted = [...days].sort((a, b) => {
    const aOrder = a === 0 ? 7 : a;
    const bOrder = b === 0 ? 7 : b;
    return aOrder - bOrder;
  });

  const names = sorted.map((d) => (language === 'en' ? enLabels[d] : zhLabels[d]));
  return language === 'en' ? `Every ${names.join(', ')}` : `每周 ${names.join('、')}`;
}
