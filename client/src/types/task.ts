import {
  calculateQuadrant100,
  PRIORITY_THRESHOLD,
  type ImpactSignal,
  type ImportanceTier,
  type TimeMode,
  type UrgencyPace,
} from '../utils/priorityAlgorithm';

export type QuadrantId = 'q1' | 'q2' | 'q3' | 'q4';

export interface TaskItem {
  id: string;
  title: string;
  description?: string;
  // 核心二维量化分值：0 ~ 100（50 为象限阈值）
  importance: number;         // 重要度评分 (0 ~ 100)
  urgency: number;            // 紧迫度评分 (0 ~ 100)
  importanceTier?: ImportanceTier;
  impactSignals?: ImpactSignal[];
  timeMode?: TimeMode;
  urgencyPace?: UrgencyPace;
  importanceManualOverride?: number | null;
  scoreScale?: number;
  useAutoUrgency?: boolean;   // 是否启用动态紧迫度引擎 (默认 true)
  isImportant: boolean;       // importance >= 50
  isUrgent: boolean;          // urgency >= 50
  quadrant: QuadrantId;       // 自动计算派生
  isCompleted: boolean;       // 是否彻底完成（每日固定任务表示今日已完成）
  completedDates?: string[];  // 已完成当天目标的日期列表 (YYYY-MM-DD)
  deadlineAt?: string | null;
  deadlineKind?: 'hard' | 'soft';
  dueDate?: string | null;    // 截止日期 (YYYY-MM-DD 或 ISO)
  tags: string[];             // 自定义标签
  estimatedMinutes?: number;  // 预计耗时 (分钟)
  isFixed?: boolean;          // 固定任务
  isConcurrent?: boolean;     // 双线程任务
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  createdAt: string;          // ISO 字符串
  completedAt?: string | null;// 完成时间
  algorithmStatusText?: string;// 算法给出的时间迫近描述
}

export interface QuadrantMeta {
  id: QuadrantId;
  name: string;
  englishName: string;
  action: string;
  shortAction: string;
  description: string;
  themeColor: {
    badgeBg: string;
    badgeText: string;
    border: string;
    cardBorderHover: string;
    bgTint: string;
    accentDot: string;
    headerBg: string;
    headerText: string;
  };
}

export type FilterStatus = 'all' | 'pending' | 'completed';

export interface TaskFilterOptions {
  searchQuery: string;
  tag: string | null;
  status: FilterStatus;
}

/**
 * 根据重要度 (0-100) 与 紧迫度 (0-100) 严格自动计算所属象限（临界线 50）
 */
export function calculateQuadrant(
  importance: number,
  urgency: number,
  threshold: number = PRIORITY_THRESHOLD
): QuadrantId {
  return calculateQuadrant100(importance, urgency, threshold);
}

/**
 * 将 Date 格式化为本地时区的 YYYY-MM-DD 字符串（避免 toISOString 的 UTC 跨日偏移）
 */
export function formatLocalDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 判断指定日期 (YYYY-MM-DD) 是否为该任务的最后一天（即设置了截止日期且当前日期 >= 截止日期）
 */
export function isTaskLastDay(task: Pick<TaskItem, 'dueDate'>, targetDateStr: string): boolean {
  if (!task.dueDate) return false;
  return targetDateStr >= task.dueDate;
}
