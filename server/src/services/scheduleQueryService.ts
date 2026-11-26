import { db } from '../config/database.js';
import type { ScheduleBlockRecord, Task, TaskInstance } from '../models/types.js';
import { getUserTimezone } from './accountService.js';
import { getAccountDayBoundsUtc, getAccountLocalDateKey } from '../utils/timezone.js';
import { getActiveExternalBusyEvents } from './scheduler.js';
import { getLatestPlanVersion } from './instanceService.js';
import { getExternalPolicyLookup, resolveExternalEventPolicy } from './externalEventPolicyService.js';

export interface UnifiedBlockItem {
  blockId: string;
  taskId: number;
  instanceId: number;
  planVersion: number;
  title: string;
  start: string; // UTC ISO
  end: string;   // UTC ISO
  durationMinutes: number;
  partIndex: number;
  totalParts: number;
  blockStatus: ScheduleBlockRecord['status'];
  instanceStatus: TaskInstance['status'];
  planStatus: TaskInstance['plan_status'];
  allocatedMinutes: number;
  unallocatedMinutes: number;
  isFixed: boolean;
  isCommitted: boolean;
  isConcurrent: boolean;
  urgency: number;
  importance: number;
  scoreScale: number;
  deadline: string | null;
  deadlineKind: 'hard' | 'soft';
  timeMode: 'deadline' | 'daily_fixed' | 'flexible';
  notes: string | null;
  tags: string[];
  energyZone: string | null;
  strategyLabel: string | null;
  businessDate: string;
}

export interface UnifiedRangeQueryResult {
  planVersion: number;
  timezone: string;
  rangeStart: string;
  rangeEnd: string;
  externalEvents: Array<{
    id: string;
    rawId: number;
    uid?: string | null;
    subscriptionId?: number | null;
    subscriptionName: string;
    title: string;
    start: string;
    end: string;
    isAllDay: boolean;
    occurrenceStart: string;
    courseGroupKey: string;
    courseGroupLabel: string;
    allowScheduling: boolean;
    aiReminderEnabled: boolean;
    hasInstanceOverride: boolean;
    groupAllowScheduling: boolean;
    groupAiReminderEnabled: boolean;
    sameNameCount: number;
  }>;
  blocks: UnifiedBlockItem[];
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * 统一按时间区间查询日历分段与外部日程（C05, C06）：
 * - 供网页日历 API、微信自然语言日程查询、卡片渲染器与 ICS 导出共用
 * - 按分段块 [start_time, end_time] 与查询区间 [rangeStart, rangeEnd] 相交过滤，
 *   支持跨日分段在目标日准确返回而不漏查也不带出无关日期块
 */
export function queryScheduleInRange(
  userId: number,
  rangeStartIso: string,
  rangeEndIso: string
): UnifiedRangeQueryResult {
  const tz = getUserTimezone(userId);
  const planVersion = getLatestPlanVersion(userId);

  const extRows = db.prepare(`
    SELECT ee.id, ee.uid, ee.title, ee.start_time, ee.end_time, ee.is_all_day,
           ee.subscription_id, ee.occurrence_start, ee.status, ee.transparency,
           ee.course_group_key, ee.course_group_label,
           ee.generation, cs.name as subscription_name, cs.current_generation
    FROM external_events ee
    LEFT JOIN calendar_subscriptions cs ON cs.id = ee.subscription_id
    WHERE ee.user_id = ?
      AND ee.end_time > ?
      AND ee.start_time < ?
      AND COALESCE(ee.status, 'CONFIRMED') != 'CANCELLED'
      AND (ee.subscription_id IS NULL OR COALESCE(ee.generation, 0) = COALESCE(cs.current_generation, 0))
    ORDER BY ee.start_time ASC
  `).all(userId, rangeStartIso, rangeEndIso) as any[];

  const ignoredRows = db
    .prepare('SELECT subscription_id, event_uid, occurrence_start FROM calendar_ignored_instances WHERE user_id = ?')
    .all(userId) as Array<{ subscription_id: number; event_uid: string; occurrence_start: string }>;
  const ignoredSet = new Set(
    ignoredRows.map(r => `${r.subscription_id}::${r.event_uid}::${r.occurrence_start}`)
  );

  const policyLookup = getExternalPolicyLookup(userId);

  const allActiveTitleRows = db.prepare(`
    SELECT ee.title, ee.subscription_id, ee.uid, ee.occurrence_start, ee.start_time
    FROM external_events ee
    LEFT JOIN calendar_subscriptions cs ON cs.id = ee.subscription_id
    WHERE ee.user_id = ?
      AND COALESCE(ee.status, 'CONFIRMED') != 'CANCELLED'
      AND (ee.subscription_id IS NULL OR COALESCE(ee.generation, 0) = COALESCE(cs.current_generation, 0))
  `).all(userId) as Array<{
    title: string;
    subscription_id: number | null;
    uid: string | null;
    occurrence_start: string | null;
    start_time: string;
  }>;

  const sameNameCountMap = new Map<string, number>();
  for (const r of allActiveTitleRows) {
    const occ = r.occurrence_start || r.start_time;
    if (r.subscription_id && r.uid && ignoredSet.has(`${r.subscription_id}::${r.uid}::${occ}`)) continue;
    const titleKey = String(r.title || '').trim();
    sameNameCountMap.set(titleKey, (sameNameCountMap.get(titleKey) || 0) + 1);
  }

  const externalEvents = extRows
    .filter(e => {
      const occ = e.occurrence_start || e.start_time;
      return !(e.subscription_id && e.uid && ignoredSet.has(`${e.subscription_id}::${e.uid}::${occ}`));
    })
    .map(e => {
      const policy = resolveExternalEventPolicy(e, policyLookup);
      return {
        id: `ext-${e.id}`,
        rawId: e.id,
        uid: e.uid,
        subscriptionId: e.subscription_id ?? null,
        subscriptionName: e.subscription_name || '外部日程',
        title: e.title,
        start: e.start_time,
        end: e.end_time,
        isAllDay: Boolean(e.is_all_day),
        occurrenceStart: policy.occurrenceStart,
        courseGroupKey: policy.groupKey,
        courseGroupLabel: policy.groupLabel,
        allowScheduling: policy.allowScheduling,
        aiReminderEnabled: policy.aiReminderEnabled,
        hasInstanceOverride: policy.hasInstanceOverride,
        groupAllowScheduling: policy.groupAllowScheduling,
        groupAiReminderEnabled: policy.groupAiReminderEnabled,
        sameNameCount: sameNameCountMap.get(String(e.title || '').trim()) || 1,
      };
    });

  const blockRows = db.prepare(`
    SELECT sb.*,
           ti.status as instance_status,
           ti.plan_status,
           ti.allocated_minutes,
           ti.unallocated_minutes,
           ti.business_date,
           t.title, t.urgency, t.importance, t.score_scale,
           t.deadline, t.deadline_kind, t.time_mode, t.notes, t.tags
    FROM schedule_blocks sb
    JOIN task_instances ti ON ti.id = sb.instance_id
    JOIN tasks t ON t.id = sb.task_id
    WHERE sb.user_id = ?
      AND sb.status IN ('planned', 'in_progress', 'completed', 'conflict')
      AND sb.end_time > ?
      AND sb.start_time < ?
      AND ti.status != 'cancelled'
      AND t.status != 'cancelled'
    ORDER BY sb.start_time ASC
  `).all(userId, rangeStartIso, rangeEndIso) as any[];

  const blocks: UnifiedBlockItem[] = blockRows.map(r => ({
    blockId: r.id,
    taskId: r.task_id,
    instanceId: r.instance_id,
    planVersion: r.plan_version,
    title: r.title,
    start: r.start_time,
    end: r.end_time,
    durationMinutes: r.duration_minutes,
    partIndex: r.part_index,
    totalParts: r.total_parts,
    blockStatus: r.status,
    instanceStatus: r.instance_status,
    planStatus: r.plan_status,
    allocatedMinutes: r.allocated_minutes,
    unallocatedMinutes: r.unallocated_minutes,
    isFixed: Boolean(r.is_fixed),
    isCommitted: Boolean(r.is_committed),
    isConcurrent: Boolean(r.is_concurrent),
    urgency: r.urgency,
    importance: r.importance,
    scoreScale: r.score_scale ?? 100,
    deadline: r.deadline || null,
    deadlineKind: r.deadline_kind === 'hard' ? 'hard' : 'soft',
    timeMode: r.time_mode || 'deadline',
    notes: r.notes || null,
    tags: parseTags(r.tags),
    energyZone: r.energy_zone || null,
    strategyLabel: r.strategy_label || null,
    businessDate: r.business_date,
  }));

  return {
    planVersion,
    timezone: tz,
    rangeStart: rangeStartIso,
    rangeEnd: rangeEndIso,
    externalEvents,
    blocks,
  };
}

/**
 * 查询账户本地某一天的日程（相交块 + 外部事件）。
 */
export function queryScheduleForLocalDate(
  userId: number,
  dateKey?: string
): UnifiedRangeQueryResult & { dateKey: string } {
  const tz = getUserTimezone(userId);
  const resolvedDateKey = dateKey && /^\d{4}-\d{2}-\d{2}$/.test(dateKey)
    ? dateKey
    : getAccountLocalDateKey(new Date(), tz);
  const { start, end } = getAccountDayBoundsUtc(resolvedDateKey, tz);
  const res = queryScheduleInRange(userId, start.toISOString(), end.toISOString());
  return { ...res, dateKey: resolvedDateKey };
}

/**
 * 统一待办列表与真实汇总统计（C05：单独统计全部数量，不使用截断列表计算总数；对齐新状态 pending_slot/scheduled/in_progress/completed）
 */
export function queryTodoSummary(
  userId: number,
  limit: number = 12
): {
  counts: {
    total: number;
    inProgress: number;
    scheduled: number;
    pendingSlot: number;
    completed: number;
  };
  items: Task[];
} {
  const countsRow = db.prepare(`
    SELECT
      COUNT(*) as total,
      COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) as in_progress_count,
      COALESCE(SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END), 0) as scheduled_count,
      COALESCE(SUM(CASE WHEN status IN ('pending_slot', 'pending', 'delayed') THEN 1 ELSE 0 END), 0) as pending_count,
      COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed_count
    FROM tasks
    WHERE user_id = ? AND status != 'cancelled'
  `).get(userId) as any;

  const items = db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ? AND status != 'cancelled'
    ORDER BY
      CASE status
        WHEN 'in_progress' THEN 1
        WHEN 'scheduled' THEN 2
        WHEN 'pending_slot' THEN 3
        WHEN 'pending' THEN 3
        WHEN 'delayed' THEN 4
        WHEN 'completed' THEN 5
        ELSE 6
      END ASC,
      urgency DESC,
      scheduled_start ASC
    LIMIT ?
  `).all(userId, limit) as Task[];

  return {
    counts: {
      total: Number(countsRow?.total || 0),
      inProgress: Number(countsRow?.in_progress_count || 0),
      scheduled: Number(countsRow?.scheduled_count || 0),
      pendingSlot: Number(countsRow?.pending_count || 0),
      completed: Number(countsRow?.completed_count || 0),
    },
    items,
  };
}

export function queryUnscheduledTasks(userId: number, limit: number = 10): Task[] {
  return db.prepare(`
    SELECT * FROM tasks
    WHERE user_id = ? AND status IN ('pending_slot', 'pending', 'delayed')
    ORDER BY urgency DESC, importance DESC, created_at ASC
    LIMIT ?
  `).all(userId, limit) as Task[];
}
