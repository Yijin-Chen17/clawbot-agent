import {
  deadlineMs,
  recurringDebt,
  selectCalendarBlocksDetailed,
  type OptimizerRejectReason,
  type Window,
} from './calendarOptimizer.js';
import { db } from '../config/database.js';
import {
  Task,
  TaskInstance,
  ScheduleBlockRecord,
  UserSettings,
  WorkSlot,
} from '../models/types.js';
import {
  calculateQuadrant100,
  normalizeScoreTo100,
  calculateDynamicUrgency,
} from '../utils/priorityAlgorithm.js';
import {
  DEFAULT_TIMEZONE,
  addDaysToDateKey,
  getAccountLocalDateKey,
  parseAccountDateOrIso,
  resolveAccountTimezone,
  zonedWallClockToUtc,
} from '../utils/timezone.js';
import { getUserTimezone } from './accountService.js';
import {
  ensureTaskInstance,
  ensureTodayDailyInstancesForUser,
  executeInstanceProgressCommand,
  getLatestPlanVersion,
  queueReplanRequest,
  syncLegacyTaskProjection,
} from './instanceService.js';
import {
  commitSchedulePlan,
  getCurrentCalendarGenerations,
  type ProposedInstancePlan,
} from './planCommitService.js';

export type EnergyZoneType = 'peak' | 'moderate' | 'low' | 'fragment';

export interface TimeSlot {
  start: Date;
  end: Date;
  durationMinutes: number;
  energyZone?: EnergyZoneType;
}

export interface ScheduledTaskBlock {
  id: string;
  taskId: number;
  title: string;
  start: Date;
  end: Date;
  durationMinutes: number;
  partIndex?: number;
  totalParts?: number;
  isSplit: boolean;
  quadrant: 'q1' | 'q2' | 'q3' | 'q4';
  importance: number;
  urgency: number;
  energyZone?: EnergyZoneType;
  strategyLabel?: string;
  breakAfterMinutes?: number;
}

export interface RestBlock {
  id: string;
  type: 'lunch' | 'dinner' | 'break';
  title: string;
  start: Date;
  end: Date;
  durationMinutes: number;
}

export interface WorkWindow {
  startHour: number;
  endHour: number;
}

export interface ScheduleOptions {
  targetDate: Date;
  timezone?: string;
  workStartHour?: number;
  workEndHour?: number;
  workWindows?: WorkWindow[];
  bufferMinutes?: number;
  taskRestMinutes?: number;
  maxContinuousMinutes?: number;
  maxDailyTaskMinutes?: number;
  exactDailyCapMinutes?: number;
  autoFilterQ4?: boolean;
  lunchStartHour?: number;
  lunchEndHour?: number;
  dinnerStartHour?: number;
  dinnerEndHour?: number;
  minChunkMinutes?: number;
  allowSplit?: boolean;
  advanceDeadlineDays?: number;
  releaseTimeMs?: number;
  futureWindows?: Window[];
  allocationDebt?: Map<number, number>;
  collectWindows?: (windows: Window[]) => void;
}

export interface ScheduleProposal {
  proposalId?: string;
  type: 'deadline_risk' | 'priority_gain';
  conflictTask: {
    id: number;
    instanceId?: number;
    title: string;
    scheduled_start: string;
    scheduled_end: string;
    duration_minutes: number;
    session_plan?: string | null;
    urgency: number;
    importance: number;
    deadline?: string | null;
  };
  reasonText: string;
  newTaskSchedule: {
    start: string;
    end: string;
    blocks?: any[];
  };
  conflictTaskSchedule: {
    start: string;
    end: string;
    blocks?: any[];
  };
}

export interface SchedulingResult {
  success: boolean;
  scheduled_start?: string;
  scheduled_end?: string;
  schedule_blocks?: string;
  message: string;
  reasonCode?: string;
  proposal?: ScheduleProposal;
}

export const EFFECTIVE_DAILY_CAP_MINUTES = 360;

/**
 * 格式化为本地 YYYY-MM-DD（支持指定账户时区）
 */
export function formatLocalDate(date: Date = new Date(), timezone?: string): string {
  if (timezone) {
    return getAccountLocalDateKey(date, timezone);
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 解析截止日期（纯日期 YYYY-MM-DD 按指定时区或本地当天 23:59:59 语义解析）
 */
export function parseDeadlineDate(rawDeadline?: string | null, timezone?: string): Date | null {
  if (!rawDeadline) return null;
  if (timezone) {
    return parseAccountDateOrIso(rawDeadline, timezone);
  }
  const trimmed = String(rawDeadline).trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [y, m, d] = trimmed.split('-').map(Number);
    return new Date(y, m - 1, d, 23, 59, 59);
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizeDeadlineIso(rawDeadline?: string | null, timezone?: string): string | null {
  const parsed = parseDeadlineDate(rawDeadline, timezone);
  return parsed ? parsed.toISOString() : null;
}

function buildDayTime(targetDate: Date, dayKey: string, hourDecimal: number, timezone?: string): Date {
  const wholeHours = Math.floor(hourDecimal);
  const mins = Math.round((hourDecimal - wholeHours) * 60);
  if (timezone) {
    if (wholeHours >= 24) {
      const nextDay = addDaysToDateKey(dayKey, 1);
      return zonedWallClockToUtc(nextDay, wholeHours - 24, mins, 0, 0, timezone);
    }
    return zonedWallClockToUtc(dayKey, wholeHours, mins, 0, 0, timezone);
  }
  const d = new Date(targetDate);
  d.setHours(wholeHours, mins, 0, 0);
  return d;
}

function getHourDecimalInTz(date: Date, timezone?: string): number {
  if (!timezone) {
    return date.getHours() + date.getMinutes() / 60;
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveAccountTimezone(timezone),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const h = Number(parts.find(p => p.type === 'hour')?.value || '0');
  const m = Number(parts.find(p => p.type === 'minute')?.value || '0');
  return (h === 24 ? 0 : h) + m / 60;
}

function parseClockToHour(clock: string, isEndBoundary: boolean): number | null {
  const match = String(clock || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 24 || m < 0 || m >= 60) {
    return null;
  }
  if (h === 24 && m > 0) return null;
  if (isEndBoundary && h === 0 && m === 0) return 24;
  return h + m / 60;
}

/**
 * 解析用户配置的 work_slots 为当日不重叠的有序工作窗口
 */
export function parseWorkSlotWindows(settings?: UserSettings): {
  workStartHour: number;
  workEndHour: number;
  workWindows: WorkWindow[];
} {
  const fallback: WorkWindow[] = [{ startHour: 8, endHour: 22 }];
  if (!settings || settings.work_slots === undefined || settings.work_slots === null) {
    return { workStartHour: 8, workEndHour: 22, workWindows: fallback };
  }

  try {
    let parsedSlots: WorkSlot[] = [];
    if (Array.isArray(settings.work_slots)) {
      parsedSlots = settings.work_slots;
    } else if (typeof settings.work_slots === 'string') {
      const trimmed = settings.work_slots.trim();
      if (!trimmed) {
        return { workStartHour: 0, workEndHour: 0, workWindows: [] };
      }
      if (trimmed.startsWith('[')) {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) parsedSlots = parsed;
      } else {
        const parts = trimmed.split(/[,，;\n\r]+/).map(p => p.trim()).filter(Boolean);
        for (const part of parts) {
          const match = part.match(/^(\d{1,2}:\d{2})\s*[-~至到]\s*(\d{1,2}:\d{2})$/);
          if (match) {
            parsedSlots.push({ start: match[1], end: match[2] });
          }
        }
      }
    }

    if (!Array.isArray(parsedSlots) || parsedSlots.length === 0) {
      return { workStartHour: 0, workEndHour: 0, workWindows: [] };
    }

    const raw: WorkWindow[] = [];
    for (const s of parsedSlots) {
      const startHour = parseClockToHour(s?.start, false);
      const endHour = parseClockToHour(s?.end, true);
      if (startHour === null || endHour === null) continue;

      if (endHour <= startHour) {
        if (startHour < 24) {
          raw.push({ startHour: Math.max(0, startHour), endHour: 24 });
        }
        if (endHour > 0 && endHour < 24) {
          raw.push({ startHour: 0, endHour: Math.min(24, endHour) });
        }
      } else {
        raw.push({
          startHour: Math.max(0, startHour),
          endHour: Math.min(24, endHour),
        });
      }
    }

    if (raw.length === 0) {
      return { workStartHour: 0, workEndHour: 0, workWindows: [] };
    }

    raw.sort((a, b) => a.startHour - b.startHour || a.endHour - b.endHour);
    const merged: WorkWindow[] = [];
    for (const w of raw) {
      const prev = merged[merged.length - 1];
      if (prev && w.startHour <= prev.endHour) {
        prev.endHour = Math.max(prev.endHour, w.endHour);
      } else {
        merged.push({ ...w });
      }
    }

    return {
      workStartHour: merged[0].startHour,
      workEndHour: merged[merged.length - 1].endHour,
      workWindows: merged,
    };
  } catch {
    return { workStartHour: 0, workEndHour: 0, workWindows: [] };
  }
}

export interface FixedCalendarBlock {
  id: string;
  title: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
}

/**
 * 读取有效的外部日历忙时事件（过滤旧代次、取消事件、透明空闲事件与用户本地忽略的实例 C01）
 */
export function getActiveExternalBusyEvents(
  userId: number,
  rangeStartIso: string,
  rangeEndIso: string
): FixedCalendarBlock[] {
  const rows = db.prepare(`
    SELECT ee.id, ee.uid, ee.subscription_id, ee.title, ee.start_time, ee.end_time, ee.is_all_day,
           ee.generation, ee.status, ee.transparency, ee.occurrence_start,
           cs.current_generation
    FROM external_events ee
    LEFT JOIN calendar_subscriptions cs ON cs.id = ee.subscription_id
    WHERE ee.user_id = ?
      AND ee.end_time >= ?
      AND ee.start_time <= ?
      AND COALESCE(ee.status, 'CONFIRMED') != 'CANCELLED'
      AND COALESCE(ee.transparency, 'OPAQUE') != 'TRANSPARENT'
      AND (ee.subscription_id IS NULL OR COALESCE(ee.generation, 0) = COALESCE(cs.current_generation, 0))
    ORDER BY ee.start_time ASC
  `).all(userId, rangeStartIso, rangeEndIso) as any[];

  const ignoredRows = db.prepare(`
    SELECT subscription_id, event_uid, occurrence_start
    FROM calendar_ignored_instances
    WHERE user_id = ?
  `).all(userId) as Array<{ subscription_id: number; event_uid: string; occurrence_start: string }>;

  const ignoredSet = new Set(
    ignoredRows.map(r => `${r.subscription_id}::${r.event_uid}::${r.occurrence_start}`)
  );

  const result: FixedCalendarBlock[] = [];
  for (const e of rows) {
    const occStart = e.occurrence_start || e.start_time;
    if (e.subscription_id && e.uid && ignoredSet.has(`${e.subscription_id}::${e.uid}::${occStart}`)) {
      continue;
    }
    const start = new Date(e.start_time);
    const end = new Date(e.end_time);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) continue;
    result.push({
      id: `ext-${e.id}`,
      title: e.title,
      start,
      end,
      isAllDay: Boolean(e.is_all_day),
    });
  }
  return result;
}

/**
 * 将已排程任务拆解为独立的 schedule_blocks 占用区间
 */
export function taskToBusyEvents(
  task: Pick<Task, 'id' | 'title' | 'scheduled_start' | 'scheduled_end' | 'schedule_blocks' | 'time_mode' | 'recurrence_rule' | 'is_fixed' | 'completed_dates'>,
  idPrefix: string = 'task',
  horizonBaseDate?: Date,
  horizonDays: number = 0,
  timezone?: string
): FixedCalendarBlock[] {
  const results: FixedCalendarBlock[] = [];

  let parsedBlocks: any[] = [];
  if (task.schedule_blocks) {
    try {
      const raw = typeof task.schedule_blocks === 'string'
        ? JSON.parse(task.schedule_blocks)
        : task.schedule_blocks;
      if (Array.isArray(raw)) {
        parsedBlocks = raw;
      }
    } catch {}
  }

  const baseIntervals: { start: Date; end: Date }[] = [];
  if (parsedBlocks.length > 0) {
    parsedBlocks.forEach((b) => {
      if (b?.completed === true || b?.status === 'completed' || b?.status === 'cancelled' || b?.status === 'superseded') return;
      const s = new Date(b?.start || b?.start_time);
      const e = new Date(b?.end || b?.end_time);
      if (!Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime()) && s < e) {
        baseIntervals.push({ start: s, end: e });
      }
    });
  } else if (task.scheduled_start && task.scheduled_end) {
    const s = new Date(task.scheduled_start);
    const e = new Date(task.scheduled_end);
    if (!Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime()) && s < e) {
      baseIntervals.push({ start: s, end: e });
    }
  }

  baseIntervals.forEach((iv, idx) => {
    results.push({
      id: `${idPrefix}-${task.id}-${idx}`,
      title: `[已排] ${task.title}`,
      start: iv.start,
      end: iv.end,
      isAllDay: false,
    });
  });

  if (
    task.time_mode === 'daily_fixed' &&
    task.is_fixed === 1 &&
    horizonBaseDate &&
    horizonDays > 1 &&
    baseIntervals.length > 0
  ) {
    const existingDayKeys = new Set(baseIntervals.map(iv => formatLocalDate(iv.start, timezone)));
    let completedDates: string[] = [];
    if (task.completed_dates) {
      try {
        const parsed = typeof task.completed_dates === 'string'
          ? JSON.parse(task.completed_dates)
          : task.completed_dates;
        if (Array.isArray(parsed)) completedDates = parsed;
      } catch {}
    }

    const baseKey = formatLocalDate(horizonBaseDate, timezone);
    for (let dayOffset = 1; dayOffset < horizonDays; dayOffset++) {
      let dayKey: string;
      let targetDay: Date;
      if (timezone) {
        dayKey = addDaysToDateKey(baseKey, dayOffset);
        targetDay = zonedWallClockToUtc(dayKey, 0, 0, 0, 0, timezone);
      } else {
        targetDay = new Date(horizonBaseDate);
        targetDay.setDate(targetDay.getDate() + dayOffset);
        dayKey = formatLocalDate(targetDay);
      }
      if (existingDayKeys.has(dayKey) || completedDates.includes(dayKey)) continue;
      if (!isDateMatchingRecurrence(targetDay, task.recurrence_rule)) continue;

      baseIntervals.forEach((iv, idx) => {
        const durationMs = iv.end.getTime() - iv.start.getTime();
        let projStart: Date;
        if (timezone) {
          const hm = getHourDecimalInTz(iv.start, timezone);
          const h = Math.floor(hm);
          const m = Math.round((hm - h) * 60);
          projStart = zonedWallClockToUtc(dayKey, h, m, 0, 0, timezone);
        } else {
          projStart = new Date(targetDay);
          projStart.setHours(iv.start.getHours(), iv.start.getMinutes(), iv.start.getSeconds(), 0);
        }
        const projEnd = new Date(projStart.getTime() + durationMs);
        results.push({
          id: `${idPrefix}-${task.id}-d${dayOffset}-${idx}`,
          title: `[固定每日] ${task.title}`,
          start: projStart,
          end: projEnd,
          isAllDay: false,
        });
      });
    }
  }

  return results;
}

/**
 * 将长耗时任务按最长专注时长均衡切分任务
 */
export function splitIntoFocusSessions(
  totalMinutes: number,
  maxSessionMinutes: number = 90,
  _minTailMinutes: number = 20
): number[] {
  if (totalMinutes <= 0 || maxSessionMinutes <= 0) return [];
  const count = Math.ceil(totalMinutes / maxSessionMinutes);
  if (count === 1) return [totalMinutes];
  const base = Math.floor(totalMinutes / count / 5) * 5;
  const sessions = Array<number>(count).fill(base);
  let remainder = totalMinutes - base * count;
  for (let i = 0; remainder > 0; i = (i + 1) % count) {
    const increment = Math.min(5, remainder, maxSessionMinutes - sessions[i]);
    sessions[i] += increment;
    remainder -= increment;
  }
  return sessions;
}

export function classifySlotEnergy(start: Date, durationMinutes: number, timezone?: string): EnergyZoneType {
  if (durationMinutes < 45) {
    return 'fragment';
  }
  const startHour = getHourDecimalInTz(start, timezone);
  if (startHour >= 12.8 && startHour < 14.4) {
    return 'low';
  }
  if ((startHour >= 7.5 && startHour < 12.0) || (startHour >= 14.4 && startHour < 18.0)) {
    return 'peak';
  }
  return 'moderate';
}

export function getStrategyLabel(zone: EnergyZoneType, quadrant: string, isSessionSplit: boolean): string {
  if (quadrant === 'q3') {
    if (zone === 'fragment') return '碎片时间高效填补';
    if (zone === 'low') return '午后轻量缓冲排程';
    return '浅层事务集中处理';
  }
  if (zone === 'peak') {
    return isSessionSplit ? '黄金时段·番茄节律切分' : '黄金深度专注段';
  }
  if (zone === 'moderate') {
    return isSessionSplit ? '晚间沉浸·节律切分' : '晚间完整推进段';
  }
  if (zone === 'low') {
    return '午后过渡推进段';
  }
  return '紧凑间隙利用';
}

export function calculateQuadrant(
  importance: number,
  urgency: number,
  scoreScale?: number | null
): 'q1' | 'q2' | 'q3' | 'q4' {
  const imp = normalizeScoreTo100(importance, scoreScale);
  const urg = normalizeScoreTo100(urgency, scoreScale);
  return calculateQuadrant100(imp, urg);
}

/**
 * 计算今日剩余工作窗口内的已占用分钟数（基于真实外部日历与独占 schedule_blocks，排除并行轨）
 */
export function computeTodayBusyMinutes(
  userId: number,
  currentTime: Date = new Date(),
  excludeTaskId?: number
): number {
  const tz = getUserTimezone(userId);
  const todayKey = getAccountLocalDateKey(currentTime, tz);
  const dayEnd = zonedWallClockToUtc(todayKey, 22, 0, 0, 0, tz);
  if (dayEnd.getTime() <= currentTime.getTime()) return 0;

  const startIso = currentTime.toISOString();
  const endIso = dayEnd.toISOString();

  const extEvents = getActiveExternalBusyEvents(userId, startIso, endIso).filter(e => !e.isAllDay);
  const intervals: { start: number; end: number }[] = [];

  for (const ev of extEvents) {
    intervals.push({
      start: Math.max(currentTime.getTime(), ev.start.getTime()),
      end: Math.min(dayEnd.getTime(), ev.end.getTime()),
    });
  }

  // Prefer v2 schedule_blocks joined with task_instances when available, else fallback to tasks
  const activeBlocks = db.prepare(`
    SELECT sb.start_time, sb.end_time, sb.task_id, sb.is_concurrent
    FROM schedule_blocks sb
    JOIN task_instances ti ON ti.id = sb.instance_id
    WHERE sb.user_id = ?
      AND sb.status IN ('planned', 'in_progress')
      AND ti.status IN ('pending', 'in_progress')
      AND sb.is_concurrent = 0
      AND sb.end_time > ?
      AND sb.start_time < ?
  `).all(userId, startIso, endIso) as Array<{ start_time: string; end_time: string; task_id: number }>;

  if (activeBlocks.length > 0) {
    for (const b of activeBlocks) {
      if (excludeTaskId !== undefined && b.task_id === excludeTaskId) continue;
      const sMs = Math.max(currentTime.getTime(), new Date(b.start_time).getTime());
      const eMs = Math.min(dayEnd.getTime(), new Date(b.end_time).getTime());
      if (eMs > sMs) intervals.push({ start: sMs, end: eMs });
    }
  } else {
    const scheduledTasks = db.prepare(`
      SELECT id, title, scheduled_start, scheduled_end, schedule_blocks, time_mode, is_fixed, is_concurrent, completed_dates
      FROM tasks
      WHERE user_id = ? AND status IN ('scheduled', 'in_progress')
        AND scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL
        AND scheduled_end > ? AND scheduled_start < ?
    `).all(userId, startIso, endIso) as Task[];

    for (const t of scheduledTasks) {
      if (excludeTaskId !== undefined && t.id === excludeTaskId) continue;
      if (t.is_concurrent === 1) continue;
      if (t.time_mode === 'daily_fixed' && t.completed_dates) {
        try {
          const doneDates = JSON.parse(t.completed_dates);
          if (Array.isArray(doneDates) && doneDates.includes(todayKey)) continue;
        } catch {}
      }
      const busyBlocks = taskToBusyEvents(t, 'busy', undefined, 0, tz);
      for (const block of busyBlocks) {
        const sMs = Math.max(currentTime.getTime(), block.start.getTime());
        const eMs = Math.min(dayEnd.getTime(), block.end.getTime());
        if (eMs > sMs) intervals.push({ start: sMs, end: eMs });
      }
    }
  }

  intervals.sort((a, b) => a.start - b.start);
  let busyMs = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const iv of intervals) {
    if (iv.end <= iv.start) continue;
    if (curStart === -1) {
      curStart = iv.start;
      curEnd = iv.end;
    } else if (iv.start <= curEnd) {
      curEnd = Math.max(curEnd, iv.end);
    } else {
      busyMs += curEnd - curStart;
      curStart = iv.start;
      curEnd = iv.end;
    }
  }
  if (curStart !== -1) busyMs += curEnd - curStart;
  return Math.round(busyMs / 60000);
}

export function computeTaskPriorityScore(task: {
  importance: number;
  urgency: number;
  score_scale?: number | null;
  time_mode?: string | null;
  deadline?: string | null;
}, targetDate: Date, timezone?: string): number {
  const imp = normalizeScoreTo100(task.importance, task.score_scale);
  const urg = normalizeScoreTo100(task.urgency, task.score_scale);
  const quad = calculateQuadrant100(imp, urg);

  let baseScore = imp * 1.6 + urg * 1.2;

  if (quad === 'q1') baseScore += 150;
  else if (quad === 'q2') baseScore += 80;
  else if (quad === 'q3') baseScore += 20;

  if (task.time_mode === 'daily_fixed') {
    baseScore += 60;
  }

  const due = parseDeadlineDate(task.deadline, timezone);
  if (due) {
    const diffDays = (due.getTime() - targetDate.getTime()) / (1000 * 3600 * 24);
    if (diffDays <= 1) {
      baseScore += 120;
    } else if (diffDays <= 3) {
      baseScore += 60;
    } else if (diffDays <= 7) {
      baseScore += 20;
    }
  }

  return baseScore;
}

function rejectReasonMessage(code: OptimizerRejectReason | 'q4_filtered', isHard: boolean): string {
  switch (code) {
    case 'q4_filtered':
      return '象限 IV：默认不自动排程';
    case 'hard_deadline_violation':
      return '不可逾期：截止前尚有未分配工作量';
    case 'outside_work_window':
      return '当前无可用工作时段窗口';
    case 'search_budget_exhausted':
      return '搜索空间超出单轮上限，暂未找到可行安排';
    case 'insufficient_capacity':
    default:
      return isHard ? '不可逾期：截止前尚有未分配工作量' : '当天没有更多合适的空闲时段';
  }
}

/**
 * 单日排程核心算法（支持账户时区和细粒度未排原因诊断）
 */
export function runSingleDaySchedule(
  tasks: Task[],
  fixedEvents: { id: string; title: string; start: Date; end: Date; isAllDay: boolean }[],
  options: ScheduleOptions
): {
  scheduledBlocks: ScheduledTaskBlock[];
  scheduledTaskIds: Set<number>;
  unscheduledTaskIds: { taskId: number; remainingMinutes: number; reason: string; reasonCode: string }[];
} {
  const {
    targetDate,
    timezone,
    workStartHour = 8.0,
    workEndHour = 22.0,
    workWindows,
    bufferMinutes = 10,
    taskRestMinutes = 10,
    maxContinuousMinutes = 90,
    maxDailyTaskMinutes = 330,
    exactDailyCapMinutes,
    autoFilterQ4 = true,
    lunchStartHour = 12.0,
    lunchEndHour = 13.0,
    dinnerStartHour = 18.0,
    dinnerEndHour = 19.0,
    minChunkMinutes = 30,
    allowSplit = true,
    advanceDeadlineDays = 0,
    releaseTimeMs,
  } = options;

  const targetDateStr = formatLocalDate(targetDate, timezone);
  const todayStr = formatLocalDate(new Date(), timezone);

  const dayStart = buildDayTime(targetDate, targetDateStr, workStartHour, timezone);
  const dayEnd = buildDayTime(targetDate, targetDateStr, workEndHour, timezone);

  const dayFixedEvents = fixedEvents
    .map(e => {
      const clippedStart = new Date(Math.max(e.start.getTime(), dayStart.getTime()));
      const clippedEnd = new Date(Math.min(e.end.getTime(), dayEnd.getTime()));
      return { ...e, start: clippedStart, end: clippedEnd };
    })
    .filter(e => e.start < e.end)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const internalBufferIntervals: { start: Date; end: Date; durationMinutes: number }[] = [];
  for (const ev of dayFixedEvents) {
    if (bufferMinutes > 0 && ev.end.getTime() < dayEnd.getTime()) {
      const bufEnd = new Date(Math.min(dayEnd.getTime(), ev.end.getTime() + bufferMinutes * 60 * 1000));
      const overlapsNext = dayFixedEvents.some(
        other => other.id !== ev.id && other.start.getTime() < bufEnd.getTime() && other.end.getTime() > ev.end.getTime()
      );
      if (!overlapsNext && bufEnd.getTime() > ev.end.getTime()) {
        internalBufferIntervals.push({
          start: new Date(ev.end),
          end: bufEnd,
          durationMinutes: Math.round((bufEnd.getTime() - ev.end.getTime()) / 60000),
        });
      }
    }
  }

  const baseLunchStart = buildDayTime(targetDate, targetDateStr, lunchStartHour, timezone);
  const baseLunchEnd = buildDayTime(targetDate, targetDateStr, lunchEndHour, timezone);
  const maxLunchEnd = buildDayTime(targetDate, targetDateStr, 13.5, timezone);

  let actualLunchStart = new Date(baseLunchStart);
  for (const ev of dayFixedEvents) {
    if (ev.start < baseLunchEnd && ev.end > actualLunchStart && ev.end.getTime() > actualLunchStart.getTime()) {
      actualLunchStart = new Date(ev.end.getTime());
    }
  }
  const actualLunchEnd = new Date(
    Math.min(dayEnd.getTime(), maxLunchEnd.getTime(), actualLunchStart.getTime() + (lunchEndHour - lunchStartHour) * 3600 * 1000)
  );

  const baseDinnerStart = buildDayTime(targetDate, targetDateStr, dinnerStartHour, timezone);
  const baseDinnerEnd = buildDayTime(targetDate, targetDateStr, dinnerEndHour, timezone);
  const maxDinnerEnd = buildDayTime(targetDate, targetDateStr, 19.5, timezone);

  let actualDinnerStart = new Date(baseDinnerStart);
  for (const ev of dayFixedEvents) {
    if (ev.start < baseDinnerEnd && ev.end > actualDinnerStart && ev.end.getTime() > actualDinnerStart.getTime()) {
      actualDinnerStart = new Date(ev.end.getTime());
    }
  }
  const actualDinnerEnd = new Date(
    Math.min(dayEnd.getTime(), maxDinnerEnd.getTime(), actualDinnerStart.getTime() + (dinnerEndHour - dinnerStartHour) * 3600 * 1000)
  );

  const visualRestBlocks: RestBlock[] = [];
  if (actualLunchEnd > actualLunchStart) {
    visualRestBlocks.push({
      id: `rest-lunch-${targetDate.getTime()}`,
      type: 'lunch',
      title: '午间休息',
      start: actualLunchStart,
      end: actualLunchEnd,
      durationMinutes: Math.round((actualLunchEnd.getTime() - actualLunchStart.getTime()) / 60000),
    });
  }
  if (actualDinnerEnd > actualDinnerStart) {
    visualRestBlocks.push({
      id: `rest-dinner-${targetDate.getTime()}`,
      type: 'dinner',
      title: '晚间休息',
      start: actualDinnerStart,
      end: actualDinnerEnd,
      durationMinutes: Math.round((actualDinnerEnd.getTime() - actualDinnerStart.getTime()) / 60000),
    });
  }

  const allBusyEntities: { start: Date; end: Date }[] = [
    ...dayFixedEvents.map(e => ({ start: e.start, end: e.end })),
    ...visualRestBlocks.map(r => ({ start: r.start, end: r.end })),
    ...internalBufferIntervals.map(b => ({ start: b.start, end: b.end })),
  ].sort((a, b) => a.start.getTime() - b.start.getTime());

  const mergedBusy: { start: Date; end: Date }[] = [];
  for (const entity of allBusyEntities) {
    if (mergedBusy.length === 0) {
      mergedBusy.push({ start: new Date(entity.start), end: new Date(entity.end) });
    } else {
      const last = mergedBusy[mergedBusy.length - 1];
      if (entity.start.getTime() <= last.end.getTime()) {
        if (entity.end.getTime() > last.end.getTime()) {
          last.end = new Date(entity.end);
        }
      } else {
        mergedBusy.push({ start: new Date(entity.start), end: new Date(entity.end) });
      }
    }
  }

  const rawFreeSlots: TimeSlot[] = [];
  let currentCursor = new Date(dayStart);

  for (const busy of mergedBusy) {
    if (busy.start.getTime() > currentCursor.getTime()) {
      const durationMin = Math.floor((busy.start.getTime() - currentCursor.getTime()) / 60000);
      if (durationMin >= 15) {
        rawFreeSlots.push({
          start: new Date(currentCursor),
          end: new Date(busy.start),
          durationMinutes: durationMin,
        });
      }
    }
    if (busy.end.getTime() > currentCursor.getTime()) {
      currentCursor = new Date(busy.end);
    }
  }

  if (currentCursor.getTime() < dayEnd.getTime()) {
    const durationMin = Math.floor((dayEnd.getTime() - currentCursor.getTime()) / 60000);
    if (durationMin >= 15) {
      rawFreeSlots.push({
        start: new Date(currentCursor),
        end: new Date(dayEnd),
        durationMinutes: durationMin,
      });
    }
  }

  let constrainedFreeSlots: TimeSlot[] = rawFreeSlots;
  if (Array.isArray(workWindows) && workWindows.length > 0) {
    const allowedIntervals = workWindows
      .map(w => {
        const ws = buildDayTime(targetDate, targetDateStr, w.startHour, timezone);
        const we = buildDayTime(targetDate, targetDateStr, w.endHour, timezone);
        return { startMs: ws.getTime(), endMs: we.getTime() };
      })
      .filter(iv => iv.endMs > iv.startMs);

    const intersected: TimeSlot[] = [];
    for (const slot of rawFreeSlots) {
      for (const win of allowedIntervals) {
        const sMs = Math.max(slot.start.getTime(), win.startMs);
        const eMs = Math.min(slot.end.getTime(), win.endMs);
        const durMin = Math.floor((eMs - sMs) / 60000);
        if (durMin >= 15) {
          intersected.push({
            start: new Date(sMs),
            end: new Date(eMs),
            durationMinutes: durMin,
          });
        }
      }
    }
    constrainedFreeSlots = intersected.sort((a, b) => a.start.getTime() - b.start.getTime());
  } else if (Array.isArray(workWindows) && workWindows.length === 0) {
    constrainedFreeSlots = [];
  }

  const workingFreeSlots: TimeSlot[] = constrainedFreeSlots.map(slot => ({
    start: new Date(slot.start),
    end: new Date(slot.end),
    durationMinutes: slot.durationMinutes,
    energyZone: classifySlotEnergy(slot.start, slot.durationMinutes, timezone),
  }));

  const refreshSlots = () => {
    for (const s of workingFreeSlots) {
      s.durationMinutes = Math.max(0, Math.floor((s.end.getTime() - s.start.getTime()) / 60000));
      if (s.durationMinutes > 0) {
        s.energyZone = classifySlotEnergy(s.start, s.durationMinutes, timezone);
      }
    }
  };

  if (releaseTimeMs !== undefined) {
    for (const s of workingFreeSlots) {
      if (s.end.getTime() <= releaseTimeMs) {
        s.start = new Date(s.end);
      } else if (s.start.getTime() < releaseTimeMs) {
        s.start = new Date(releaseTimeMs);
      }
    }
    refreshSlots();
  }

  const dayAnchor = buildDayTime(targetDate, targetDateStr, 0, timezone);
  const windows = workingFreeSlots
    .filter(s => s.durationMinutes > 0)
    .map(s => ({ start: s.start.getTime(), end: s.end.getTime(), day: dayAnchor.getTime() }));
  options.collectWindows?.(windows);

  const scheduledBlocks: ScheduledTaskBlock[] = [];
  const scheduledTaskIds = new Set<number>();
  const unscheduledTaskIds: { taskId: number; remainingMinutes: number; reason: string; reasonCode: string }[] = [];

  const active = tasks.filter(task => {
    if (task.status === 'completed' || task.status === 'cancelled' || targetDateStr < todayStr) return false;
    if (task.time_mode === 'daily_fixed') {
      if (targetDateStr !== todayStr) return false;
      try {
        if (JSON.parse(task.completed_dates || '[]').includes(targetDateStr)) return false;
      } catch {}
    }
    const quadrant = calculateQuadrant(task.importance, task.urgency, task.score_scale);
    if (autoFilterQ4 && quadrant === 'q4' && task.deadline_kind !== 'hard') {
      unscheduledTaskIds.push({
        taskId: task.id,
        remainingMinutes: task.duration_minutes || 45,
        reason: rejectReasonMessage('q4_filtered', false),
        reasonCode: 'q4_filtered',
      });
      return false;
    }
    return true;
  });

  const cap = exactDailyCapMinutes !== undefined ? exactDailyCapMinutes : maxDailyTaskMinutes + 30;
  const { placements, rejectedReasons } = selectCalendarBlocksDetailed(
    active,
    windows,
    options.futureWindows || [],
    {
      cap,
      rest: taskRestMinutes,
      maxChunk: maxContinuousMinutes,
      minChunk: minChunkMinutes,
      allowSplit,
      advanceDeadlineDays,
      debt: options.allocationDebt,
    }
  );

  for (const [index, task] of active.entries()) {
    const parts = placements.filter(p => p.index === index);
    const quadrant = calculateQuadrant(task.importance, task.urgency, task.score_scale);
    const isSplit = parts.length > 1;
    for (const [part, p] of parts.entries()) {
      const start = new Date(p.start);
      const energyZone = classifySlotEnergy(start, p.minutes, timezone);
      scheduledBlocks.push({
        id: `sched-${task.id}-p${part + 1}-${p.start}`,
        taskId: task.id,
        title: task.title,
        start,
        end: new Date(p.start + p.minutes * 60_000),
        durationMinutes: p.minutes,
        partIndex: part + 1,
        totalParts: parts.length,
        isSplit,
        quadrant,
        importance: task.importance,
        urgency: task.urgency,
        energyZone,
        strategyLabel: getStrategyLabel(energyZone, quadrant, isSplit),
        breakAfterMinutes: p.rest || undefined,
      });
    }
    const remainingMinutes = Math.max(
      0,
      Math.ceil(task.duration_minutes || 45) - parts.reduce((sum, p) => sum + p.minutes, 0)
    );
    if (!remainingMinutes) {
      scheduledTaskIds.add(task.id);
    } else {
      const rCode = rejectedReasons.get(task.id) || (windows.length === 0 ? 'outside_work_window' : 'insufficient_capacity');
      unscheduledTaskIds.push({
        taskId: task.id,
        remainingMinutes,
        reason: rejectReasonMessage(rCode, task.deadline_kind === 'hard'),
        reasonCode: rCode,
      });
    }
  }

  scheduledBlocks.sort((a, b) => a.start.getTime() - b.start.getTime());
  return { scheduledBlocks, scheduledTaskIds, unscheduledTaskIds };
}

function getHorizonWindows(
  now: Date,
  days: number,
  events: FixedCalendarBlock[],
  options: Omit<ScheduleOptions, 'targetDate'>
): Window[][] {
  const baseKey = options.timezone ? getAccountLocalDateKey(now, options.timezone) : null;
  return Array.from({ length: days }, (_, offset) => {
    let targetDate: Date;
    if (options.timezone && baseKey) {
      const dk = addDaysToDateKey(baseKey, offset);
      targetDate = zonedWallClockToUtc(dk, 0, 0, 0, 0, options.timezone);
    } else {
      targetDate = new Date(now);
      targetDate.setDate(targetDate.getDate() + offset);
    }
    let result: Window[] = [];
    runSingleDaySchedule([], events, {
      ...options,
      targetDate,
      releaseTimeMs: offset === 0 ? options.releaseTimeMs : undefined,
      collectWindows: windows => { result = windows; },
    });
    return result;
  });
}

/**
 * 在多日规划窗口内为同轨待办执行滚动排程
 */
export function scheduleTaskGroupInHorizon(
  groupTasks: Task[],
  fixedEvents: FixedCalendarBlock[],
  now: Date,
  horizonDays: number,
  config: {
    timezone?: string;
    workStartHour: number;
    workEndHour: number;
    workWindows: WorkWindow[];
    bufferMinutes: number;
    advanceDeadlineDays: number;
    releaseTimeMsToday: number;
    exactDailyCapMinutes?: number;
  },
  taskAllocations: Map<number, ScheduledTaskBlock[]>,
  remainingTaskIds: Set<number>,
  rejectReasonByTaskId?: Map<number, { code: string; text: string }>
): void {
  if (groupTasks.length === 0) return;

  const taskMap = new Map<number, Task>(groupTasks.map(t => [t.id, { ...t }]));
  const progress = groupTasks.map(task => Math.max(0, (task.original_duration_minutes || 0) - task.duration_minutes));
  const totalProgress = progress.reduce((sum, minutes) => sum + minutes, 0);
  const weights = groupTasks.map(task => 0.2 + (normalizeScoreTo100(task.importance, task.score_scale) / 100) ** 2);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const balances = weights.map((weight, index) => (totalWeight > 0 ? totalProgress * weight / totalWeight : 0) - progress[index]);
  const scale = Math.max(1, ...balances.map(balance => Math.abs(balance) / 120));
  const allocationDebt = new Map(groupTasks.map((task, index) => [task.id, balances[index] / scale]));

  const horizonWindows = getHorizonWindows(now, horizonDays, fixedEvents, {
    timezone: config.timezone,
    workStartHour: config.workStartHour,
    workEndHour: config.workEndHour,
    workWindows: config.workWindows,
    bufferMinutes: config.bufferMinutes,
    releaseTimeMs: config.releaseTimeMsToday,
  });

  const baseKey = config.timezone ? getAccountLocalDateKey(now, config.timezone) : null;

  for (let dayOffset = 0; dayOffset < horizonDays; dayOffset++) {
    const candidates = Array.from(remainingTaskIds)
      .map(id => taskMap.get(id)!)
      .filter(Boolean);
    if (candidates.length === 0) break;

    let targetDate: Date;
    if (config.timezone && baseKey) {
      const dk = addDaysToDateKey(baseKey, dayOffset);
      targetDate = zonedWallClockToUtc(dk, 0, 0, 0, 0, config.timezone);
    } else {
      targetDate = new Date(now);
      targetDate.setDate(targetDate.getDate() + dayOffset);
    }

    const dayResult = runSingleDaySchedule(candidates, fixedEvents, {
      targetDate,
      timezone: config.timezone,
      workStartHour: config.workStartHour,
      workEndHour: config.workEndHour,
      workWindows: config.workWindows,
      bufferMinutes: config.bufferMinutes,
      taskRestMinutes: 10,
      maxContinuousMinutes: 90,
      maxDailyTaskMinutes: 330,
      exactDailyCapMinutes: config.exactDailyCapMinutes ?? EFFECTIVE_DAILY_CAP_MINUTES,
      autoFilterQ4: true,
      lunchStartHour: 12.0,
      lunchEndHour: 13.0,
      dinnerStartHour: 18.0,
      dinnerEndHour: 19.0,
      minChunkMinutes: 30,
      allowSplit: true,
      advanceDeadlineDays: config.advanceDeadlineDays,
      releaseTimeMs: dayOffset === 0 ? config.releaseTimeMsToday : undefined,
      allocationDebt,
      futureWindows: horizonWindows.slice(dayOffset + 1).flat(),
    });

    for (const block of dayResult.scheduledBlocks) {
      if (!taskAllocations.has(block.taskId)) {
        taskAllocations.set(block.taskId, []);
      }
      taskAllocations.get(block.taskId)!.push(block);
    }

    for (const scheduledId of dayResult.scheduledTaskIds) {
      remainingTaskIds.delete(scheduledId);
    }

    for (const unsched of dayResult.unscheduledTaskIds) {
      rejectReasonByTaskId?.set(unsched.taskId, { code: unsched.reasonCode, text: unsched.reason });
      if (unsched.reasonCode !== 'q4_filtered') {
        const tRef = taskMap.get(unsched.taskId);
        if (tRef) {
          tRef.duration_minutes = unsched.remainingMinutes;
        }
      } else {
        remainingTaskIds.delete(unsched.taskId);
      }
    }
  }
}

function intervalsOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime();
}

/**
 * 依据统一约束快照执行全局多日滚动排程，并在单个事务内原子提交新版本计划（T03, T08, T09, T10, T12, C06）。
 */
export function replanUserTasks(
  userId: number,
  options?: { preserveTaskIds?: Set<number>; triggerSource?: string; now?: Date }
): {
  success: boolean;
  planVersion?: number;
  totalTasks: number;
  scheduledCount: number;
  failedCount: number;
  partialCount: number;
  conflictCount?: number;
  tasks: Task[];
  summary: string;
} {
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = options?.now ? new Date(options.now.getTime()) : new Date();
    const tz = getUserTimezone(userId);
    const todayKey = getAccountLocalDateKey(now, tz);
    const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings | undefined;
    const { workStartHour, workEndHour, workWindows } = parseWorkSlotWindows(settings);
    const bufferMinutes = settings?.task_buffer_minutes ?? 10;
    const advanceDeadlineDays = settings?.advance_deadline_days ?? 1;
    const horizonDays = 14;

    // 1. Ensure active daily templates have today's instance & legacy tasks have instances
    ensureTodayDailyInstancesForUser(userId, now);
    const rawTasks = db.prepare(`
      SELECT * FROM tasks
      WHERE user_id = ? AND status != 'cancelled'
    `).all(userId) as Task[];

    for (const t of rawTasks) {
      if (t.status !== 'completed' && t.time_mode !== 'daily_fixed') {
        ensureTaskInstance(userId, t.id, todayKey, now);
      }
    }

    const basePlanVersion = getLatestPlanVersion(userId);
    const calendarGens = getCurrentCalendarGenerations(userId);

    // Load all active instances joined with their task definitions
    const activeInstances = db.prepare(`
      SELECT ti.*, t.title, t.importance, t.urgency, t.score_scale, t.importance_tier,
             t.impact_signals, t.time_mode, t.urgency_pace, t.deadline, t.deadline_kind,
             t.is_fixed, t.is_concurrent, t.session_plan, t.original_duration_minutes,
             t.completed_dates, t.created_at as task_created_at, t.active_template
      FROM task_instances ti
      JOIN tasks t ON t.id = ti.task_id
      WHERE ti.user_id = ?
        AND ti.status IN ('pending', 'in_progress')
        AND t.status != 'cancelled'
    `).all(userId) as Array<TaskInstance & Task & { task_created_at: string; active_template: number }>;

    if (activeInstances.length === 0) {
      const committed = commitSchedulePlan({
        userId,
        expectedPlanVersion: basePlanVersion,
        expectedCalendarGenerations: calendarGens,
        triggerSource: options?.triggerSource || 'replan',
        summary: '暂无可排程的待办事项',
        instancePlans: [],
        taskTitlesById: new Map(),
        settings,
        now,
      });
      if (committed.stale) continue;
      return {
        success: true,
        planVersion: committed.planVersion,
        totalTasks: 0,
        scheduledCount: 0,
        failedCount: 0,
        partialCount: 0,
        conflictCount: 0,
        tasks: [],
        summary: '暂无可排程的待办事项',
      };
    }

    const horizonEnd = new Date(now.getTime() + horizonDays * 86400000);
    const externalBusy = getActiveExternalBusyEvents(userId, now.toISOString(), horizonEnd.toISOString());

    // Load existing blocks for active instances
    const activeBlocksRows = db.prepare(`
      SELECT * FROM schedule_blocks
      WHERE user_id = ? AND status IN ('planned', 'in_progress', 'completed', 'conflict')
      ORDER BY start_time ASC
    `).all(userId) as ScheduleBlockRecord[];

    const blocksByInstance = new Map<number, ScheduleBlockRecord[]>();
    for (const b of activeBlocksRows) {
      const list = blocksByInstance.get(b.instance_id) || [];
      list.push(b);
      blocksByInstance.set(b.instance_id, list);
    }

    const preserveIds = options?.preserveTaskIds;
    const todayBusyMinutes = computeTodayBusyMinutes(userId, now);
    const taskTitlesById = new Map<number, string>();

    const exclusiveFixedBusy: FixedCalendarBlock[] = [...externalBusy];
    const concurrentFixedBusy: FixedCalendarBlock[] = [];

    const preservedByInstance = new Map<number, ScheduleBlockRecord[]>();
    const conflictedBlockIdsByInstance = new Map<number, string[]>();
    const movableTasksToSchedule: Task[] = [];
    const instanceByTaskId = new Map<number, typeof activeInstances[number]>();
    const remainingNeededByInstance = new Map<number, number>();

    for (const row of activeInstances) {
      taskTitlesById.set(row.task_id, row.title);

      // Refresh urgency dynamically for both daily_fixed AND normal tasks (T09)
      const imp100 = normalizeScoreTo100(row.importance, row.score_scale);
      const instBlocks = blocksByInstance.get(row.id) || [];
      const firstBlock = instBlocks.find(b => b.status === 'planned' || b.status === 'in_progress');
      const lastBlock = instBlocks[instBlocks.length - 1];

      const urgRes = calculateDynamicUrgency({
        timeMode: row.time_mode || (row.deadline ? 'deadline' : 'flexible'),
        dueDate: row.deadline || null,
        estimatedMinutes: Math.max(1, row.estimated_minutes - row.completed_minutes),
        importance: imp100,
        urgencyPace: row.urgency_pace || 'soon',
        scheduledStart: firstBlock?.start_time || null,
        scheduledEnd: lastBlock?.end_time || null,
        isCompletedToday: false,
        dailyBusyMinutesAhead: todayBusyMinutes,
        workEndHour,
        currentTime: now,
      });

      const debtBoost = row.time_mode === 'daily_fixed' ? Math.round(15 * recurringDebt({ created_at: row.task_created_at, completed_dates: row.completed_dates }, now)) : 0;
      const nextUrgency = Math.min(100, urgRes.urgency + debtBoost);
      db.prepare('UPDATE tasks SET urgency = ?, importance = ?, score_scale = 100 WHERE id = ?').run(
        nextUrgency,
        imp100,
        row.task_id
      );
      row.urgency = nextUrgency;
      row.importance = imp100;

      // Protected blocks on this instance: completed, in_progress, is_fixed, is_committed, or preserveTaskIds
      const isForcePreserved = Boolean(preserveIds?.has(row.task_id));
      const protectedBlocks: ScheduleBlockRecord[] = [];
      const conflictIds: string[] = [];

      for (const b of instBlocks) {
        const isProtected =
          b.status === 'completed' ||
          b.status === 'in_progress' ||
          b.status === 'conflict' ||
          b.is_fixed === 1 ||
          b.is_committed === 1 ||
          isForcePreserved;
        if (!isProtected) continue;

        protectedBlocks.push(b);

        if (b.status === 'completed') continue;

        const bs = new Date(b.start_time);
        const be = new Date(b.end_time);

        // Check if fixed/committed exclusive block now conflicts with external busy events
        if (row.is_concurrent !== 1 && (b.is_fixed === 1 || b.is_committed === 1) && b.status !== 'in_progress') {
          const hitsExternal = externalBusy.some(ext => intervalsOverlap(bs, be, ext.start, ext.end));
          if (hitsExternal) {
            conflictIds.push(b.id);
          }
        }

        const busyEntry: FixedCalendarBlock = {
          id: `protected-${b.id}`,
          title: `[受保护] ${row.title}`,
          start: bs,
          end: be,
          isAllDay: false,
        };
        if (row.is_concurrent === 1) {
          concurrentFixedBusy.push(busyEntry);
        } else {
          exclusiveFixedBusy.push(busyEntry);
        }
      }

      // Daily fixed template future projection into busy events across horizon
      if (row.time_mode === 'daily_fixed' && row.is_fixed === 1 && row.active_template !== 0 && protectedBlocks.length > 0) {
        const baseTaskShape = {
          id: row.task_id,
          title: row.title,
          scheduled_start: protectedBlocks[0].start_time,
          scheduled_end: protectedBlocks[protectedBlocks.length - 1].end_time,
          schedule_blocks: JSON.stringify(protectedBlocks.map(b => ({ start: b.start_time, end: b.end_time }))),
          time_mode: row.time_mode,
          is_fixed: 1,
          completed_dates: row.completed_dates,
        };
        const projected = taskToBusyEvents(baseTaskShape, 'daily-fixed-proj', now, horizonDays, tz).slice(protectedBlocks.length);
        if (row.is_concurrent === 1) concurrentFixedBusy.push(...projected);
        else exclusiveFixedBusy.push(...projected);
      }

      preservedByInstance.set(row.id, protectedBlocks);
      if (conflictIds.length > 0) {
        conflictedBlockIdsByInstance.set(row.id, conflictIds);
      }

      const activeProtectedMins = protectedBlocks
        .filter(b => b.status !== 'completed')
        .reduce((sum, b) => sum + b.duration_minutes, 0);
      const totalRemMins = Math.max(0, row.estimated_minutes - row.completed_minutes);
      const unallocatedToPlan = Math.max(0, totalRemMins - activeProtectedMins);
      remainingNeededByInstance.set(row.id, unallocatedToPlan);

      // Fixed tasks keep their fixed blocks; only non-fixed instances with unallocated minutes get scheduled
      if (row.is_fixed !== 1 && !isForcePreserved && unallocatedToPlan > 0) {
        // Use task_id as key in optimizer (one active instance per once task, today's instance for daily_fixed)
        instanceByTaskId.set(row.task_id, row);
        movableTasksToSchedule.push({
          id: row.task_id,
          user_id: userId,
          title: row.title,
          duration_minutes: unallocatedToPlan,
          original_duration_minutes: row.original_duration_minutes || row.estimated_minutes,
          session_plan: row.session_plan,
          urgency: row.urgency,
          importance: row.importance,
          importance_tier: row.importance_tier,
          impact_signals: row.impact_signals,
          time_mode: row.time_mode,
          urgency_pace: row.urgency_pace,
          completed_dates: row.completed_dates,
          score_scale: 100,
          deadline_kind: row.deadline_kind,
          deadline: row.deadline,
          scheduled_start: null,
          scheduled_end: null,
          is_fixed: 0,
          is_concurrent: row.is_concurrent,
          status: 'pending_slot',
          start_reminder_sent: 0,
          end_reminder_sent: 0,
          created_at: row.task_created_at,
          updated_at: row.updated_at,
        });
      }
    }

    const releaseTimeMsToday = Math.ceil(now.getTime() / (5 * 60 * 1000)) * (5 * 60 * 1000);
    const horizonConfig = {
      timezone: tz,
      workStartHour,
      workEndHour,
      workWindows,
      bufferMinutes,
      advanceDeadlineDays,
      releaseTimeMsToday,
      exactDailyCapMinutes: EFFECTIVE_DAILY_CAP_MINUTES,
    };

    const taskAllocations = new Map<number, ScheduledTaskBlock[]>();
    const remainingTaskIds = new Set<number>(movableTasksToSchedule.map(t => t.id));
    const rejectReasonByTaskId = new Map<number, { code: string; text: string }>();

    const exclusiveTasks = movableTasksToSchedule.filter(t => t.is_concurrent !== 1);
    const concurrentTasks = movableTasksToSchedule.filter(t => t.is_concurrent === 1);

    scheduleTaskGroupInHorizon(
      exclusiveTasks,
      exclusiveFixedBusy,
      now,
      horizonDays,
      horizonConfig,
      taskAllocations,
      remainingTaskIds,
      rejectReasonByTaskId
    );
    scheduleTaskGroupInHorizon(
      concurrentTasks,
      concurrentFixedBusy,
      now,
      horizonDays,
      { ...horizonConfig, bufferMinutes: 0 },
      taskAllocations,
      remainingTaskIds,
      rejectReasonByTaskId
    );

    const instancePlans: ProposedInstancePlan[] = [];
    let scheduledCount = 0;
    let failedCount = 0;
    let partialCount = 0;
    let hardPending = 0;
    let conflictCount = 0;

    for (const row of activeInstances) {
      const preserved = preservedByInstance.get(row.id) || [];
      const conflictIds = conflictedBlockIdsByInstance.get(row.id) || [];
      const activeProtectedMins = preserved
        .filter(b => b.status !== 'completed')
        .reduce((sum, b) => sum + b.duration_minutes, 0);

      let allocatedMovable = taskAllocations.get(row.task_id) || [];
      const stillUnallocated = remainingTaskIds.has(row.task_id);
      const rejectInfo = rejectReasonByTaskId.get(row.task_id);

      // Hard deadline check: must fit 100% before deadline, otherwise drop movable blocks and keep pending
      if (row.deadline_kind === 'hard' && row.is_fixed !== 1) {
        const due = parseDeadlineDate(row.deadline, tz);
        const violatesDue = due ? allocatedMovable.some(b => b.end.getTime() > due.getTime()) : false;
        if (stillUnallocated || violatesDue) {
          allocatedMovable = [];
          hardPending++;
        }
      }

      const sortedNew = [...allocatedMovable].sort((a, b) => a.start.getTime() - b.start.getTime());
      const newMins = sortedNew.reduce((s, b) => s + b.durationMinutes, 0);
      const totalAllocated = activeProtectedMins + newMins;
      const totalRemNeeded = Math.max(0, row.estimated_minutes - row.completed_minutes);
      const unallocatedMins = Math.max(0, totalRemNeeded - totalAllocated);

      let planStatus: ProposedInstancePlan['planStatus'] = 'pending';
      let planReason: string | null = null;

      if (conflictIds.length > 0) {
        planStatus = 'conflict';
        planReason = '已固定或已确认时段与外部日程冲突';
        conflictCount++;
      } else if (totalAllocated > 0 && unallocatedMins === 0) {
        planStatus = 'scheduled';
        scheduledCount++;
      } else if (totalAllocated > 0 && unallocatedMins > 0) {
        planStatus = 'partial';
        planReason = rejectInfo?.text || '超出规划窗口或当日容量，已部分排入';
        scheduledCount++;
        partialCount++;
      } else {
        planStatus = 'pending';
        planReason =
          row.deadline_kind === 'hard' && rejectInfo?.code !== 'q4_filtered'
            ? '不可逾期：截止前容量不足，未能完整排入'
            : rejectInfo?.text || '暂无合适空闲时段';
        failedCount++;
      }

      const totalParts = preserved.filter(b => b.status !== 'completed').length + sortedNew.length;
      const preservedOffset = preserved.filter(b => b.status !== 'completed').length;

      instancePlans.push({
        instanceId: row.id,
        taskId: row.task_id,
        planStatus,
        allocatedMinutes: totalAllocated,
        unallocatedMinutes: unallocatedMins,
        planReason,
        preservedBlocks: preserved,
        conflictedBlockIds: conflictIds,
        newBlocks: sortedNew.map((b, idx) => ({
          startTime: b.start.toISOString(),
          endTime: b.end.toISOString(),
          durationMinutes: b.durationMinutes,
          partIndex: preservedOffset + idx + 1,
          totalParts,
          isFixed: false,
          isCommitted: false,
          isConcurrent: row.is_concurrent === 1,
          energyZone: b.energyZone,
          strategyLabel: b.strategyLabel,
          breakAfterMinutes: b.breakAfterMinutes,
        })),
      });
    }

    const summary = `智能排程完成：共将 ${scheduledCount} 项任务排入日历${partialCount > 0 ? `（其中 ${partialCount} 项仅部分排入）` : ''}${failedCount > 0 ? `，${failedCount} 项待办未分配` : ''}${hardPending > 0 ? `，其中 ${hardPending} 项不可逾期任务未找到完整方案` : ''}${conflictCount > 0 ? `，${conflictCount} 项存在日历冲突` : ''}`;

    const commitRes = commitSchedulePlan({
      userId,
      expectedPlanVersion: basePlanVersion,
      expectedCalendarGenerations: calendarGens,
      triggerSource: options?.triggerSource || 'replan',
      summary,
      instancePlans,
      taskTitlesById,
      settings,
      now,
    });

    if (commitRes.stale) {
      continue; // Retry once on concurrent version change
    }

    const allUpdatedTasks = db.prepare(`
      SELECT * FROM tasks
      WHERE user_id = ? AND status IN ('scheduled', 'in_progress', 'completed')
      ORDER BY scheduled_start ASC
    `).all(userId) as Task[];

    return {
      success: true,
      planVersion: commitRes.planVersion,
      totalTasks: activeInstances.length,
      scheduledCount,
      failedCount,
      partialCount,
      conflictCount,
      tasks: allUpdatedTasks,
      summary,
    };
  }

  return {
    success: false,
    totalTasks: 0,
    scheduledCount: 0,
    failedCount: 0,
    partialCount: 0,
    tasks: [],
    summary: '排程提交版本冲突，请重试',
  };
}

/**
 * 在未来 14 天时间窗口内模拟单任务排程（与全局重排共用相同容量、时区与截止约束 T08, T10）
 */
function simulateTaskInHorizon(
  userId: number,
  task: {
    id?: number;
    title: string;
    duration_minutes: number;
    session_plan?: string | null;
    deadline_kind?: Task['deadline_kind'];
    urgency_pace?: Task['urgency_pace'];
    time_mode?: Task['time_mode'];
    is_concurrent?: number;
    completed_dates?: string | null;
    score_scale?: number | null;
    urgency: number;
    importance: number;
    deadline?: string | null;
  },
  fixedEvents: FixedCalendarBlock[],
  settings?: UserSettings,
  occupiedDailyMinutes?: Map<string, number>
): {
  success: boolean;
  scheduled_start?: string;
  scheduled_end?: string;
  schedule_blocks?: string;
  accumulatedBlocks: ScheduledTaskBlock[];
  reasonCode: string;
  message: string;
} {
  const now = new Date();
  const tz = resolveAccountTimezone(settings?.timezone);
  const simTask: Task = {
    id: task.id || -999,
    user_id: userId,
    title: task.title,
    duration_minutes: task.duration_minutes,
    session_plan: task.session_plan,
    deadline_kind: task.deadline_kind,
    urgency_pace: task.urgency_pace,
    time_mode: task.time_mode,
    is_concurrent: task.is_concurrent,
    completed_dates: task.completed_dates,
    score_scale: task.score_scale,
    urgency: task.urgency,
    importance: task.importance,
    deadline: task.deadline || null,
    scheduled_start: null,
    scheduled_end: null,
    status: 'scheduled',
    start_reminder_sent: 0,
    end_reminder_sent: 0,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };

  const simQuad = calculateQuadrant(task.importance, task.urgency, task.score_scale);
  if (simQuad === 'q4' && task.deadline_kind !== 'hard') {
    return {
      success: false,
      reasonCode: 'q4_filtered',
      message: '象限 IV（不重要且不紧急）：默认不自动排程占用核心时段',
      accumulatedBlocks: [],
    };
  }

  const { workStartHour, workEndHour, workWindows } = parseWorkSlotWindows(settings);
  const bufferMinutes = task.is_concurrent === 1 ? 0 : (settings?.task_buffer_minutes ?? 10);
  const advanceDeadlineDays = settings?.advance_deadline_days ?? 1;
  const releaseTimeMsToday = Math.ceil(now.getTime() / (5 * 60 * 1000)) * (5 * 60 * 1000);
  const accumulatedBlocks: ScheduledTaskBlock[] = [];
  let remainingMinutesToSim = task.duration_minutes;
  const maxDays = task.time_mode === 'daily_fixed' ? 1 : 14;
  const horizonWindows = getHorizonWindows(now, maxDays, fixedEvents, {
    timezone: tz,
    workStartHour,
    workEndHour,
    workWindows,
    bufferMinutes,
    releaseTimeMs: releaseTimeMsToday,
  });

  const baseKey = getAccountLocalDateKey(now, tz);
  let lastReasonCode = 'insufficient_capacity';

  for (let dayOffset = 0; dayOffset < maxDays; dayOffset++) {
    if (remainingMinutesToSim <= 0) break;
    const dayKey = addDaysToDateKey(baseKey, dayOffset);
    const targetDate = zonedWallClockToUtc(dayKey, 0, 0, 0, 0, tz);

    const usedOnDay = occupiedDailyMinutes?.get(dayKey) || 0;
    const remainingCapMinutes = Math.max(0, EFFECTIVE_DAILY_CAP_MINUTES - usedOnDay);
    if (remainingCapMinutes <= 0) continue;

    simTask.duration_minutes = remainingMinutesToSim;

    const dayResult = runSingleDaySchedule([simTask], fixedEvents, {
      targetDate,
      timezone: tz,
      workStartHour,
      workEndHour,
      workWindows,
      bufferMinutes,
      taskRestMinutes: 10,
      maxContinuousMinutes: 90,
      maxDailyTaskMinutes: 330,
      exactDailyCapMinutes: remainingCapMinutes,
      autoFilterQ4: true,
      advanceDeadlineDays,
      releaseTimeMs: dayOffset === 0 ? releaseTimeMsToday : undefined,
      futureWindows: horizonWindows.slice(dayOffset + 1).flat(),
    });

    const blocks = dayResult.scheduledBlocks.filter(b => b.taskId === simTask.id);
    if (blocks.length > 0) {
      accumulatedBlocks.push(...blocks);
      const allocatedToday = blocks.reduce((sum, b) => sum + b.durationMinutes, 0);
      remainingMinutesToSim = Math.max(0, remainingMinutesToSim - allocatedToday);
    }
    const unsched = dayResult.unscheduledTaskIds.find(u => u.taskId === simTask.id);
    if (unsched) lastReasonCode = unsched.reasonCode;
  }

  const due = parseDeadlineDate(task.deadline, tz);
  const violatesHard =
    task.deadline_kind === 'hard' &&
    due &&
    accumulatedBlocks.some(b => b.end.getTime() > due.getTime());

  if (accumulatedBlocks.length > 0 && remainingMinutesToSim <= 0 && !violatesHard) {
    const sorted = [...accumulatedBlocks].sort((a, b) => a.start.getTime() - b.start.getTime());
    const sStart = sorted[0].start.toISOString();
    const sEnd = sorted[sorted.length - 1].end.toISOString();
    const totalParts = sorted.length;
    const blockPayload = sorted.map((b, idx) => ({
      start: b.start.toISOString(),
      end: b.end.toISOString(),
      duration: b.durationMinutes,
      partIndex: idx + 1,
      totalParts,
      energyZone: b.energyZone,
      strategyLabel: b.strategyLabel,
      breakAfterMinutes: b.breakAfterMinutes,
    }));

    return {
      success: true,
      scheduled_start: sStart,
      scheduled_end: sEnd,
      schedule_blocks: JSON.stringify(blockPayload),
      accumulatedBlocks,
      reasonCode: 'ok',
      message: '排程计算成功',
    };
  }

  return {
    success: false,
    reasonCode: task.deadline_kind === 'hard' ? 'hard_deadline_violation' : lastReasonCode,
    message:
      task.deadline_kind === 'hard'
        ? '排程窗口内未找到能在硬截止前完整完成的方案。'
        : rejectReasonMessage(lastReasonCode as OptimizerRejectReason, false),
    accumulatedBlocks: [],
  };
}

/**
 * 针对单任务执行试排与冲突提案计算
 */
export function scheduleTask(
  userId: number,
  task: {
    id?: number;
    title: string;
    duration_minutes: number;
    session_plan?: string | null;
    deadline_kind?: Task['deadline_kind'];
    urgency_pace?: Task['urgency_pace'];
    time_mode?: Task['time_mode'];
    is_concurrent?: number;
    completed_dates?: string | null;
    score_scale?: number | null;
    urgency: number;
    importance: number;
    deadline?: string | null;
  }
): SchedulingResult {
  const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings | undefined;
  const tz = resolveAccountTimezone(settings?.timezone);
  const now = new Date();
  const horizonEnd = new Date(now.getTime() + 14 * 86400000);
  const parsedFixedEvents = getActiveExternalBusyEvents(userId, now.toISOString(), horizonEnd.toISOString());

  const existingScheduledTasks = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ?
      AND status IN ('scheduled', 'in_progress')
      AND scheduled_start IS NOT NULL
      AND scheduled_end IS NOT NULL
      AND (? IS NULL OR id != ?)
    ORDER BY scheduled_start ASC
  `).all(userId, task.id || null, task.id || null) as Task[];

  const buildBusyAndDailyLoad = (items: Task[], isConcurrentTrack: boolean) => {
    const busy: FixedCalendarBlock[] = isConcurrentTrack ? [] : [...parsedFixedEvents];
    const dailyMinutes = new Map<string, number>();

    for (const et of items) {
      if (isConcurrentTrack) {
        if (et.is_concurrent === 1) {
          busy.push(...taskToBusyEvents(et, 'task', now, 14, tz));
        }
        continue;
      }
      if (et.is_concurrent === 1) continue;
      const blocks = taskToBusyEvents(et, 'task', now, 14, tz);
      busy.push(...blocks);
      // Match global replan: only movable (non-fixed) tasks count toward daily auto-schedule capacity
      if (et.is_fixed !== 1) {
        for (const b of blocks) {
          const dayKey = getAccountLocalDateKey(b.start, tz);
          const mins = Math.max(0, Math.round((b.end.getTime() - b.start.getTime()) / 60000));
          dailyMinutes.set(dayKey, (dailyMinutes.get(dayKey) || 0) + mins);
        }
      }
    }

    return { busy, dailyMinutes };
  };

  const isConcurrentTask = task.is_concurrent === 1;
  const { busy: baseFixedEvents, dailyMinutes: occupiedDailyMinutes } = buildBusyAndDailyLoad(existingScheduledTasks, isConcurrentTask);

  const directPlan = simulateTaskInHorizon(userId, task, baseFixedEvents, settings, occupiedDailyMinutes);

  if (
    isConcurrentTask ||
    task.time_mode === 'daily_fixed' ||
    (calculateQuadrant(task.importance, task.urgency, task.score_scale) === 'q4' && task.deadline_kind !== 'hard')
  ) {
    return directPlan;
  }

  let cannotFinishInTime = false;
  const newTaskDeadline = parseDeadlineDate(task.deadline, tz);
  if (!directPlan.success) {
    cannotFinishInTime = true;
  } else if (newTaskDeadline) {
    const directEndTime = new Date(directPlan.scheduled_end!).getTime();
    if (directEndTime > newTaskDeadline.getTime()) {
      cannotFinishInTime = true;
    }
  }

  const newTaskScore = computeTaskPriorityScore(task, now, tz);

  // Only future, unstarted, movable, non-daily tasks are eligible to be swapped
  const futureCandidates = existingScheduledTasks.filter(t => {
    if (t.is_fixed === 1 || t.time_mode === 'daily_fixed' || t.is_concurrent === 1 || t.status === 'in_progress') {
      return false;
    }
    const startTime = new Date(t.scheduled_start!).getTime();
    const endTime = new Date(t.scheduled_end!).getTime();
    return startTime > now.getTime() && endTime > now.getTime();
  });

  interface ViableProposal {
    candidate: Task;
    simNew: ReturnType<typeof simulateTaskInHorizon>;
    simCandidate: ReturnType<typeof simulateTaskInHorizon>;
    scoreDiff: number;
    timeSavedMinutes: number;
  }

  const viableProposals: ViableProposal[] = [];

  for (const candidate of futureCandidates) {
    const candidateScore = computeTaskPriorityScore(candidate, now, tz);
    const candidateStartTime = new Date(candidate.scheduled_start!).getTime();

    let isCandidateEligible = false;

    if (cannotFinishInTime) {
      if (!newTaskDeadline || candidateStartTime < newTaskDeadline.getTime()) {
        isCandidateEligible = true;
      }
    } else if (directPlan.scheduled_start) {
      const directStartTime = new Date(directPlan.scheduled_start).getTime();
      const isEarlier = candidateStartTime < directStartTime - 45 * 60 * 1000;
      const scoreDiff = newTaskScore - candidateScore;
      const newUrg = normalizeScoreTo100(task.urgency, 100);
      const candUrg = normalizeScoreTo100(candidate.urgency, candidate.score_scale);
      const newImp = normalizeScoreTo100(task.importance, 100);
      const urgDiff = newUrg - candUrg;
      const isSignificantGain =
        scoreDiff >= 120 ||
        urgDiff >= 25 ||
        (newImp >= 70 && newUrg >= 70 && candUrg < 60);

      if (isEarlier && isSignificantGain) {
        isCandidateEligible = true;
      }
    }

    if (!isCandidateEligible) continue;

    const remainingWithoutCandidate = existingScheduledTasks.filter(t => t.id !== candidate.id);
    const { busy: testFixedWithoutCandidate, dailyMinutes: dailyWithoutCandidate } = buildBusyAndDailyLoad(
      remainingWithoutCandidate,
      false
    );

    const simNew = simulateTaskInHorizon(userId, task, testFixedWithoutCandidate, settings, dailyWithoutCandidate);
    if (!simNew.success || !simNew.scheduled_start || !simNew.scheduled_end) continue;

    if (newTaskDeadline && new Date(simNew.scheduled_end).getTime() > newTaskDeadline.getTime()) {
      continue;
    }

    if (!cannotFinishInTime && directPlan.scheduled_start) {
      if (new Date(simNew.scheduled_start).getTime() >= new Date(directPlan.scheduled_start).getTime()) {
        continue;
      }
    }

    const newSimBusyBlocks =
      simNew.accumulatedBlocks.length > 0
        ? simNew.accumulatedBlocks.map((b, idx) => ({
            id: `sim-new-task-${idx}`,
            title: task.title,
            start: b.start,
            end: b.end,
            isAllDay: false,
          }))
        : [
            {
              id: 'sim-new-task-0',
              title: task.title,
              start: new Date(simNew.scheduled_start),
              end: new Date(simNew.scheduled_end),
              isAllDay: false,
            },
          ];

    const testFixedWithNewTask = [...testFixedWithoutCandidate, ...newSimBusyBlocks];
    const dailyWithNewTask = new Map(dailyWithoutCandidate);
    for (const b of newSimBusyBlocks) {
      const dk = getAccountLocalDateKey(b.start, tz);
      const mins = Math.max(0, Math.round((b.end.getTime() - b.start.getTime()) / 60000));
      dailyWithNewTask.set(dk, (dailyWithNewTask.get(dk) || 0) + mins);
    }

    const simCandidate = simulateTaskInHorizon(userId, candidate, testFixedWithNewTask, settings, dailyWithNewTask);
    if (!simCandidate.success || !simCandidate.scheduled_start || !simCandidate.scheduled_end) {
      continue;
    }

    const candidateDeadline = parseDeadlineDate(candidate.deadline, tz);
    if (candidateDeadline && new Date(simCandidate.scheduled_end).getTime() > candidateDeadline.getTime()) {
      continue;
    }

    const timeSavedMinutes = directPlan.scheduled_start
      ? Math.round((new Date(directPlan.scheduled_start).getTime() - new Date(simNew.scheduled_start).getTime()) / 60000)
      : 120;

    viableProposals.push({
      candidate,
      simNew,
      simCandidate,
      scoreDiff: newTaskScore - candidateScore,
      timeSavedMinutes,
    });
  }

  let bestProposal: ScheduleProposal | undefined;

  if (viableProposals.length > 0) {
    viableProposals.sort((a, b) => {
      if (cannotFinishInTime) {
        return new Date(a.simNew.scheduled_end!).getTime() - new Date(b.simNew.scheduled_end!).getTime();
      }
      return b.scoreDiff * 2 + b.timeSavedMinutes / 10 - (a.scoreDiff * 2 + a.timeSavedMinutes / 10);
    });

    const best = viableProposals[0];
    const reasonText = cannotFinishInTime
      ? task.deadline
        ? `截止时间紧迫（${new Date(task.deadline).toLocaleString('zh-CN', { timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}），原日程无充足空闲时段按时完成`
        : '原日程无充足空闲时段在有效时间内完成'
      : `重要紧迫度更高（优先级评分 ${Math.round(newTaskScore)} vs ${Math.round(computeTaskPriorityScore(best.candidate, now, tz))}），顶替排入黄金时段可大幅提升推进效率`;

    bestProposal = {
      type: cannotFinishInTime ? 'deadline_risk' : 'priority_gain',
      conflictTask: {
        id: best.candidate.id,
        title: best.candidate.title,
        scheduled_start: best.candidate.scheduled_start!,
        scheduled_end: best.candidate.scheduled_end!,
        duration_minutes: best.candidate.duration_minutes,
        urgency: best.candidate.urgency,
        importance: best.candidate.importance,
        deadline: best.candidate.deadline,
      },
      reasonText,
      newTaskSchedule: {
        start: best.simNew.scheduled_start!,
        end: best.simNew.scheduled_end!,
        blocks: best.simNew.schedule_blocks ? JSON.parse(best.simNew.schedule_blocks) : [],
      },
      conflictTaskSchedule: {
        start: best.simCandidate.scheduled_start!,
        end: best.simCandidate.scheduled_end!,
        blocks: best.simCandidate.schedule_blocks ? JSON.parse(best.simCandidate.schedule_blocks) : [],
      },
    };
  }

  if (bestProposal) {
    return {
      success: directPlan.success,
      scheduled_start: directPlan.scheduled_start,
      scheduled_end: directPlan.scheduled_end,
      schedule_blocks: directPlan.schedule_blocks,
      reasonCode: directPlan.reasonCode,
      message: directPlan.success ? '排程计算成功，但有更优调整建议' : '按原日程无法在有效时间内完成，已生成同步调整建议',
      proposal: bestProposal,
    };
  }

  return directPlan;
}

/**
 * 完成分段任务或指定时长的部分任务（委派给统一的实例进度命令并触发重排 T04, T06）
 */
export function completeTaskPart(
  userId: number,
  taskId: number,
  completedMinutes?: number,
  partIndex?: number,
  options?: {
    blockId?: string;
    commandId?: string;
    expectedPlanVersion?: number;
    expectedInstanceVersion?: number;
    businessDate?: string;
  }
): {
  success: boolean;
  staleVersion?: boolean;
  currentPlanVersion?: number;
  message: string;
  remainingMinutes: number;
  isAllCompleted: boolean;
  task?: Task;
} {
  const res = executeInstanceProgressCommand({
    userId,
    taskId,
    action: 'complete_part',
    completedMinutes,
    partIndex,
    blockId: options?.blockId,
    commandId: options?.commandId,
    expectedPlanVersion: options?.expectedPlanVersion,
    expectedInstanceVersion: options?.expectedInstanceVersion,
    businessDate: options?.businessDate,
  });

  if (res.success && res.needsReplan) {
    replanUserTasks(userId, { triggerSource: 'complete_part' });
    const latestTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
    return {
      success: true,
      message: res.message,
      remainingMinutes: res.remainingMinutes,
      isAllCompleted: res.isAllCompleted,
      task: latestTask || res.task,
    };
  }

  return {
    success: res.success,
    staleVersion: res.staleVersion,
    currentPlanVersion: res.currentPlanVersion,
    message: res.message,
    remainingMinutes: res.remainingMinutes,
    isAllCompleted: res.isAllCompleted,
    task: res.task,
  };
}

export function buildExtendedScheduleBlocks(
  rawScheduleBlocks: string | null | undefined,
  scheduledStart: string | null | undefined,
  scheduledEnd: string | null | undefined,
  currentDurationMinutes: number,
  newEnd: Date,
  extendMinutes: number
): string | null {
  let blocks: any[] = [];
  if (rawScheduleBlocks) {
    try {
      const parsed = typeof rawScheduleBlocks === 'string'
        ? JSON.parse(rawScheduleBlocks)
        : rawScheduleBlocks;
      if (Array.isArray(parsed)) {
        blocks = parsed.map(b => ({ ...b }));
      }
    } catch {}
  }

  const newEndIso = newEnd.toISOString();

  if (blocks.length > 0) {
    const lastIdx = blocks.length - 1;
    const last = blocks[lastIdx];
    const lastStartMs = new Date(last.start).getTime();
    const fallbackOldDur = !Number.isNaN(lastStartMs) && scheduledEnd
      ? Math.max(0, Math.round((new Date(scheduledEnd).getTime() - lastStartMs) / 60000))
      : 0;
    const prevBlockDur = typeof last.duration === 'number' && last.duration > 0
      ? last.duration
      : fallbackOldDur;
    last.end = newEndIso;
    last.duration = Math.max(1, prevBlockDur + extendMinutes);
    return JSON.stringify(blocks);
  }

  if (scheduledStart) {
    return JSON.stringify([
      {
        start: scheduledStart,
        end: newEndIso,
        duration: Math.max(1, currentDurationMinutes + extendMinutes),
      },
    ]);
  }

  return null;
}

/**
 * 延长任务当前排程结束时间（T05）：
 * - 先校验实例非终态（已完成/已取消不可延长）
 * - 校验硬截止时间：延长后不得晚于 deadline
 * - 校验延伸段是否落入有效工作窗口（若配置了 work_slots）
 * - 校验是否与同轨外部日程或固定/已确认块重叠；冲突时保留原计划不写入
 */
export function extendTaskDuration(
  userId: number,
  taskId: number,
  extendMinutes: number = 30
): {
  success: boolean;
  message: string;
  conflictType?: 'terminal_status' | 'hard_deadline' | 'external_conflict' | 'fixed_block_conflict' | 'work_window_violation';
  newEnd?: Date;
  newEndStr?: string;
  task?: Task;
} {
  const now = new Date();
  const tz = getUserTimezone(userId);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, userId) as Task | undefined;
  if (!task) {
    return { success: false, message: '未找到指定任务' };
  }

  const todayKey = getAccountLocalDateKey(now, tz);
  const instance = ensureTaskInstance(userId, taskId, todayKey, now);
  if (!instance) {
    return { success: false, message: '未找到任务实例' };
  }

  if (instance.status === 'completed' || instance.status === 'cancelled' || task.status === 'completed' || task.status === 'cancelled') {
    return {
      success: false,
      conflictType: 'terminal_status',
      message: '已完成或已取消的任务无法延长时段',
    };
  }

  const activeBlocks = db.prepare(`
    SELECT * FROM schedule_blocks
    WHERE instance_id = ? AND status IN ('planned', 'in_progress')
    ORDER BY start_time ASC
  `).all(instance.id) as ScheduleBlockRecord[];

  const targetBlock = activeBlocks.find(b => b.status === 'in_progress') || activeBlocks[activeBlocks.length - 1];
  const currentEndIso = targetBlock?.end_time || task.scheduled_end;
  if (!currentEndIso) {
    return { success: false, message: '该任务未安排时间，无法延长' };
  }

  const extMin = Number(extendMinutes) > 0 ? Math.round(Number(extendMinutes)) : 30;
  const currentEnd = new Date(currentEndIso);
  const newEnd = new Date(currentEnd.getTime() + extMin * 60 * 1000);

  // 1. Check hard deadline constraint
  if (task.deadline_kind === 'hard' && task.deadline) {
    const due = parseDeadlineDate(task.deadline, tz);
    if (due && newEnd.getTime() > due.getTime()) {
      const dueStr = due.toLocaleString('zh-CN', { timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
      return {
        success: false,
        conflictType: 'hard_deadline',
        message: `延长 ${extMin} 分钟后将超出硬截止时间（${dueStr}），原计划已保留`,
      };
    }
  }

  const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings | undefined;
  const { workWindows } = parseWorkSlotWindows(settings);

  // 2. Check work window containment for non-fixed tasks when workWindows are configured
  if (task.is_fixed !== 1 && workWindows.length > 0) {
    const extStartKey = getAccountLocalDateKey(currentEnd, tz);
    const extEndKey = getAccountLocalDateKey(new Date(newEnd.getTime() - 1), tz);
    const fitsInAnyWindow = (dateKey: string, s: Date, e: Date) =>
      workWindows.some(w => {
        const ws = buildDayTime(s, dateKey, w.startHour, tz);
        const we = buildDayTime(s, dateKey, w.endHour, tz);
        return s.getTime() >= ws.getTime() && e.getTime() <= we.getTime();
      });

    const fitsStartDay = fitsInAnyWindow(extStartKey, currentEnd, newEnd);
    const fitsEndDay = extStartKey !== extEndKey ? fitsInAnyWindow(extEndKey, currentEnd, newEnd) : false;
    if (!fitsStartDay && !fitsEndDay) {
      return {
        success: false,
        conflictType: 'work_window_violation',
        message: `延长 ${extMin} 分钟后超出配置的工作时段，原计划已保留`,
      };
    }
  }

  // 3. Check conflict against same-track external events & fixed/committed blocks
  if (task.is_concurrent !== 1) {
    const externalBusy = getActiveExternalBusyEvents(userId, currentEnd.toISOString(), newEnd.toISOString());
    const hitExt = externalBusy.find(e => intervalsOverlap(currentEnd, newEnd, e.start, e.end));
    if (hitExt) {
      return {
        success: false,
        conflictType: 'external_conflict',
        message: `延长时段与外部日程「${hitExt.title}」冲突，原计划已保留`,
      };
    }
  }

  const otherProtectedBlocks = db.prepare(`
    SELECT sb.*, t.title
    FROM schedule_blocks sb
    JOIN tasks t ON t.id = sb.task_id
    WHERE sb.user_id = ?
      AND sb.instance_id != ?
      AND sb.status IN ('planned', 'in_progress')
      AND sb.is_concurrent = ?
      AND (sb.is_fixed = 1 OR sb.is_committed = 1 OR sb.status = 'in_progress')
      AND sb.end_time > ?
      AND sb.start_time < ?
  `).all(userId, instance.id, task.is_concurrent ? 1 : 0, currentEnd.toISOString(), newEnd.toISOString()) as Array<ScheduleBlockRecord & { title: string }>;

  if (otherProtectedBlocks.length > 0) {
    return {
      success: false,
      conflictType: 'fixed_block_conflict',
      message: `延长时段与已锁定任务「${otherProtectedBlocks[0].title}」冲突，原计划已保留`,
    };
  }

  // 4. All checks passed -> apply atomically and trigger replan for movable tasks
  db.transaction(() => {
    db.prepare(`
      UPDATE task_instances
      SET estimated_minutes = estimated_minutes + ?,
          version = version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(extMin, instance.id);

    if (targetBlock) {
      db.prepare(`
        UPDATE schedule_blocks
        SET end_time = ?,
            duration_minutes = duration_minutes + ?,
            is_committed = 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(newEnd.toISOString(), extMin, targetBlock.id);
    }

    db.prepare(`
      INSERT INTO progress_events (user_id, command_id, instance_id, block_id, action, delta_minutes, reason)
      VALUES (?, ?, ?, ?, 'extend', ?, ?)
    `).run(userId, `ext-${taskId}-${Date.now()}`, instance.id, targetBlock?.id || null, extMin, `延长 ${extMin} 分钟`);

    db.prepare(`
      UPDATE tasks
      SET original_duration_minutes = COALESCE(original_duration_minutes, duration_minutes) + ?,
          end_reminder_sent = 0,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(extMin, taskId);

    queueReplanRequest(userId, `extend_instance:${instance.id}`);
    syncLegacyTaskProjection(userId, taskId, now);
  })();

  replanUserTasks(userId, { preserveTaskIds: new Set([taskId]), triggerSource: 'extend' });

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
  const newEndStr = newEnd.toLocaleTimeString('zh-CN', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  return {
    success: true,
    message: `任务「${task.title}」已延长 ${extMin} 分钟`,
    newEnd,
    newEndStr,
    task: updated,
  };
}
