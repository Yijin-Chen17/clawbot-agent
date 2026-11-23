/**
 * 周期任务重复规则定义与解析工具（服务端）
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

export const DEFAULT_RECURRENCE_RULE: RecurrenceRule = {
  type: 'daily',
  daysOfWeek: [1, 2, 3, 4, 5, 6, 0],
};

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
        daysOfWeek = [1, 2, 3, 4, 5];
      }
      return type === 'weekly' ? { type, daysOfWeek } : { type: 'daily' };
    }
  } catch {
    // 忽略异常
  }
  return { type: 'daily' };
}

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

  const dayOfWeek = date.getDay();
  const activeDays = rule.daysOfWeek || [];
  return activeDays.includes(dayOfWeek);
}
