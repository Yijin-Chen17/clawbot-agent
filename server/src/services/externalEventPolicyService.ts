import { db } from '../config/database.js';
import type {
  ExternalEventGroupRule,
  ExternalEventOverride,
} from '../models/types.js';

export interface CourseGroupIdentity {
  groupKey: string;
  groupLabel: string;
}

/**
 * 从外部日程（尤其是教务课表）标题中提取规范化课程/同类日程分组标识：
 * - 剥离首尾常见周次/节次标记，如 [1-16周]、(第3-18周 单周)、(Week 1-16)、(第1-2节)
 * - 剥离末尾 @教室 或带教室/楼栋关键词的分隔后缀，保留课程本体名称
 */
export function extractCourseGroup(rawTitle: string): CourseGroupIdentity {
  const original = String(rawTitle || '').trim() || '未命名外部日程';
  let label = original;

  // Strip leading week/period brackets: [1-16周] 高等数学, 【第1-8周】大学英语
  label = label.replace(/^(?:[\[\(（【]\s*(?:第?\s*\d+(?:\s*[-~～,，、]\s*\d+)*\s*(?:周|节|w|weeks?)|[单双]周|week\s*\d+(?:\s*[-~]\s*\d+)?)\s*[\]\)）】]\s*)+/gi, '');

  // Strip @room / @location at the end (e.g. "高等数学 @A101", "大学物理@教1-203")
  label = label.replace(/\s*[@＠]\s*[^\s@＠]+(?:\s+[^\s@＠]+)*\s*$/u, '');

  // Iteratively strip trailing bracketed week/period/campus tags
  let prev = '';
  while (prev !== label) {
    prev = label;
    label = label
      .replace(/\s*[\[\(（【]\s*(?:第?\s*\d+(?:\s*[-~～,，、]\s*\d+)*\s*(?:周|节|w|weeks?)(?:\s*[单双]周?)?|[单双]周|week\s*\d+(?:\s*[-~]\s*\d+)?|第?\s*\d+\s*[-~～]\s*\d+\s*[节周])\s*[\]\)）】]\s*$/gi, '')
      .replace(/\s*[-/|·]\s*(?:第?\s*\d+(?:\s*[-~～,，、]\s*\d+)*\s*(?:周|节)|[^\s]*(?:教学楼|实验楼|逸夫楼|综合楼|教室|机房|操场|馆|楼|室)\s*[\w\-]*)\s*$/iu, '')
      .trim();
  }

  label = label.replace(/\s+/g, ' ').trim();
  if (!label) {
    label = original.replace(/\s+/g, ' ').trim();
  }

  return {
    groupKey: label.toLowerCase(),
    groupLabel: label,
  };
}

export interface ExternalPolicyLookup {
  groupRules: Map<string, ExternalEventGroupRule>;
  instanceOverrides: Map<string, ExternalEventOverride>;
}

export interface ResolvedExternalEventPolicy {
  subscriptionId: number;
  eventUid: string;
  occurrenceStart: string;
  groupKey: string;
  groupLabel: string;
  allowScheduling: boolean;
  aiReminderEnabled: boolean;
  hasInstanceOverride: boolean;
  overrideAllowScheduling: boolean | null;
  overrideAiReminderEnabled: boolean | null;
  groupAllowScheduling: boolean;
  groupAiReminderEnabled: boolean;
}

export function buildGroupRuleMapKey(subscriptionId: number, groupKey: string): string {
  return `${subscriptionId}::${groupKey}`;
}

export function buildOverrideMapKey(
  subscriptionId: number,
  eventUid: string,
  occurrenceStart: string
): string {
  return `${subscriptionId}::${eventUid}::${occurrenceStart}`;
}

export function getExternalPolicyLookup(userId: number): ExternalPolicyLookup {
  const ruleRows = db
    .prepare('SELECT * FROM external_event_group_rules WHERE user_id = ?')
    .all(userId) as ExternalEventGroupRule[];
  const overrideRows = db
    .prepare('SELECT * FROM external_event_overrides WHERE user_id = ?')
    .all(userId) as ExternalEventOverride[];

  const groupRules = new Map<string, ExternalEventGroupRule>();
  for (const r of ruleRows) {
    groupRules.set(buildGroupRuleMapKey(Number(r.subscription_id || 0), r.group_key), r);
  }

  const instanceOverrides = new Map<string, ExternalEventOverride>();
  for (const o of overrideRows) {
    instanceOverrides.set(
      buildOverrideMapKey(Number(o.subscription_id || 0), o.event_uid, o.occurrence_start),
      o
    );
  }

  return { groupRules, instanceOverrides };
}

export function resolveExternalEventPolicy(
  ev: {
    id: number;
    subscription_id?: number | null;
    uid?: string | null;
    occurrence_start?: string | null;
    start_time: string;
    title: string;
    course_group_key?: string | null;
    course_group_label?: string | null;
  },
  lookup: ExternalPolicyLookup
): ResolvedExternalEventPolicy {
  const subscriptionId = Number(ev.subscription_id ?? 0);
  const eventUid = String(ev.uid || `ext-row-${ev.id}`);
  const occurrenceStart = String(ev.occurrence_start || ev.start_time);

  const computed =
    ev.course_group_key && ev.course_group_label
      ? { groupKey: ev.course_group_key, groupLabel: ev.course_group_label }
      : extractCourseGroup(ev.title);

  const rule = lookup.groupRules.get(buildGroupRuleMapKey(subscriptionId, computed.groupKey));
  const override = lookup.instanceOverrides.get(
    buildOverrideMapKey(subscriptionId, eventUid, occurrenceStart)
  );

  const groupAllowScheduling = rule ? Boolean(rule.allow_scheduling) : false;
  const groupAiReminderEnabled = rule ? Boolean(rule.ai_reminder_enabled) : true;

  const overrideAllowScheduling =
    override && override.allow_scheduling !== null && override.allow_scheduling !== undefined
      ? Boolean(override.allow_scheduling)
      : null;
  const overrideAiReminderEnabled =
    override && override.ai_reminder_enabled !== null && override.ai_reminder_enabled !== undefined
      ? Boolean(override.ai_reminder_enabled)
      : null;

  return {
    subscriptionId,
    eventUid,
    occurrenceStart,
    groupKey: computed.groupKey,
    groupLabel: rule?.group_label || computed.groupLabel,
    allowScheduling: overrideAllowScheduling !== null ? overrideAllowScheduling : groupAllowScheduling,
    aiReminderEnabled: overrideAiReminderEnabled !== null ? overrideAiReminderEnabled : groupAiReminderEnabled,
    hasInstanceOverride: overrideAllowScheduling !== null || overrideAiReminderEnabled !== null,
    overrideAllowScheduling,
    overrideAiReminderEnabled,
    groupAllowScheduling,
    groupAiReminderEnabled,
  };
}

export interface ExternalEventGroupSummary {
  subscriptionId: number;
  subscriptionName: string;
  groupKey: string;
  groupLabel: string;
  eventCount: number;
  upcomingCount: number;
  nextStartTime: string | null;
  sampleTitles: string[];
  allowScheduling: boolean;
  aiReminderEnabled: boolean;
  overrideCount: number;
}

export function listExternalEventGroups(
  userId: number,
  subscriptionIdFilter?: number
): ExternalEventGroupSummary[] {
  const lookup = getExternalPolicyLookup(userId);
  const nowIso = new Date().toISOString();

  const rows = db.prepare(`
    SELECT ee.id, ee.uid, ee.subscription_id, ee.occurrence_start, ee.title,
           ee.start_time, ee.end_time, ee.course_group_key, ee.course_group_label,
           cs.name as subscription_name
    FROM external_events ee
    LEFT JOIN calendar_subscriptions cs ON cs.id = ee.subscription_id
    WHERE ee.user_id = ?
      AND COALESCE(ee.status, 'CONFIRMED') != 'CANCELLED'
      AND (ee.subscription_id IS NULL OR COALESCE(ee.generation, 0) = COALESCE(cs.current_generation, 0))
      AND (? IS NULL OR COALESCE(ee.subscription_id, 0) = ?)
    ORDER BY ee.start_time ASC
  `).all(userId, subscriptionIdFilter ?? null, subscriptionIdFilter ?? null) as any[];

  const ignoredRows = db
    .prepare('SELECT subscription_id, event_uid, occurrence_start FROM calendar_ignored_instances WHERE user_id = ?')
    .all(userId) as Array<{ subscription_id: number; event_uid: string; occurrence_start: string }>;
  const ignoredSet = new Set(
    ignoredRows.map(r => `${r.subscription_id}::${r.event_uid}::${r.occurrence_start}`)
  );

  const groups = new Map<
    string,
    {
      subscriptionId: number;
      subscriptionName: string;
      groupKey: string;
      groupLabel: string;
      eventCount: number;
      upcomingCount: number;
      nextStartTime: string | null;
      sampleTitles: Set<string>;
      allowScheduling: boolean;
      aiReminderEnabled: boolean;
      overrideCount: number;
    }
  >();

  for (const row of rows) {
    const occStart = row.occurrence_start || row.start_time;
    if (row.subscription_id && row.uid && ignoredSet.has(`${row.subscription_id}::${row.uid}::${occStart}`)) {
      continue;
    }

    const policy = resolveExternalEventPolicy(row, lookup);
    const mapKey = buildGroupRuleMapKey(policy.subscriptionId, policy.groupKey);
    let bucket = groups.get(mapKey);
    if (!bucket) {
      bucket = {
        subscriptionId: policy.subscriptionId,
        subscriptionName: row.subscription_name || '外部日程',
        groupKey: policy.groupKey,
        groupLabel: policy.groupLabel,
        eventCount: 0,
        upcomingCount: 0,
        nextStartTime: null,
        sampleTitles: new Set<string>(),
        allowScheduling: policy.groupAllowScheduling,
        aiReminderEnabled: policy.groupAiReminderEnabled,
        overrideCount: 0,
      };
      groups.set(mapKey, bucket);
    }

    bucket.eventCount++;
    if (row.end_time >= nowIso) {
      bucket.upcomingCount++;
      if (!bucket.nextStartTime || row.start_time < bucket.nextStartTime) {
        bucket.nextStartTime = row.start_time;
      }
    }
    if (bucket.sampleTitles.size < 3) {
      bucket.sampleTitles.add(row.title);
    }
    if (policy.hasInstanceOverride) {
      bucket.overrideCount++;
    }
  }

  return Array.from(groups.values())
    .map(g => ({
      subscriptionId: g.subscriptionId,
      subscriptionName: g.subscriptionName,
      groupKey: g.groupKey,
      groupLabel: g.groupLabel,
      eventCount: g.eventCount,
      upcomingCount: g.upcomingCount,
      nextStartTime: g.nextStartTime,
      sampleTitles: Array.from(g.sampleTitles),
      allowScheduling: g.allowScheduling,
      aiReminderEnabled: g.aiReminderEnabled,
      overrideCount: g.overrideCount,
    }))
    .sort((a, b) => {
      if (a.nextStartTime && b.nextStartTime) return a.nextStartTime.localeCompare(b.nextStartTime);
      if (a.nextStartTime) return -1;
      if (b.nextStartTime) return 1;
      return a.groupLabel.localeCompare(b.groupLabel, 'zh-CN');
    });
}

export function upsertSingleExternalEventOverride(params: {
  userId: number;
  eventId: number;
  allowScheduling?: boolean | null;
  aiReminderEnabled?: boolean | null;
}): {
  event: any;
  policy: ResolvedExternalEventPolicy;
} {
  const ev = db
    .prepare('SELECT * FROM external_events WHERE id = ? AND user_id = ?')
    .get(params.eventId, params.userId) as any;

  if (!ev) {
    throw new Error('未找到指定外部日程');
  }

  const subId = Number(ev.subscription_id ?? 0);
  const eventUid = String(ev.uid || `ext-row-${ev.id}`);
  const occStart = String(ev.occurrence_start || ev.start_time);
  const group =
    ev.course_group_key && ev.course_group_label
      ? { groupKey: ev.course_group_key, groupLabel: ev.course_group_label }
      : extractCourseGroup(ev.title);

  const existing = db
    .prepare(
      `SELECT * FROM external_event_overrides
       WHERE user_id = ? AND subscription_id = ? AND event_uid = ? AND occurrence_start = ?`
    )
    .get(params.userId, subId, eventUid, occStart) as ExternalEventOverride | undefined;

  const nextAllow =
    params.allowScheduling === undefined
      ? existing?.allow_scheduling ?? null
      : params.allowScheduling === null
      ? null
      : params.allowScheduling
      ? 1
      : 0;

  const nextRemind =
    params.aiReminderEnabled === undefined
      ? existing?.ai_reminder_enabled ?? null
      : params.aiReminderEnabled === null
      ? null
      : params.aiReminderEnabled
      ? 1
      : 0;

  if (nextAllow === null && nextRemind === null) {
    db.prepare(
      `DELETE FROM external_event_overrides
       WHERE user_id = ? AND subscription_id = ? AND event_uid = ? AND occurrence_start = ?`
    ).run(params.userId, subId, eventUid, occStart);
  } else {
    db.prepare(
      `INSERT INTO external_event_overrides (
        user_id, subscription_id, event_uid, occurrence_start, group_key, title,
        allow_scheduling, ai_reminder_enabled, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, subscription_id, event_uid, occurrence_start) DO UPDATE SET
        group_key = excluded.group_key,
        title = excluded.title,
        allow_scheduling = excluded.allow_scheduling,
        ai_reminder_enabled = excluded.ai_reminder_enabled,
        updated_at = CURRENT_TIMESTAMP`
    ).run(params.userId, subId, eventUid, occStart, group.groupKey, ev.title, nextAllow, nextRemind);
  }

  const lookup = getExternalPolicyLookup(params.userId);
  const policy = resolveExternalEventPolicy(ev, lookup);
  return { event: ev, policy };
}

export function upsertExternalGroupRule(params: {
  userId: number;
  subscriptionId: number;
  groupKey: string;
  groupLabel?: string;
  allowScheduling?: boolean;
  aiReminderEnabled?: boolean;
  resetInstanceOverrides?: boolean;
}): ExternalEventGroupRule {
  const subId = Number(params.subscriptionId || 0);
  const cleanKey = params.groupKey.trim().toLowerCase();
  if (!cleanKey) {
    throw new Error('课程/日程分组标识不能为空');
  }

  const existing = db
    .prepare(
      `SELECT * FROM external_event_group_rules
       WHERE user_id = ? AND subscription_id = ? AND group_key = ?`
    )
    .get(params.userId, subId, cleanKey) as ExternalEventGroupRule | undefined;

  const nextLabel = (params.groupLabel || existing?.group_label || params.groupKey).trim();
  const nextAllow =
    params.allowScheduling !== undefined
      ? params.allowScheduling
        ? 1
        : 0
      : existing?.allow_scheduling ?? 0;
  const nextRemind =
    params.aiReminderEnabled !== undefined
      ? params.aiReminderEnabled
        ? 1
        : 0
      : existing?.ai_reminder_enabled ?? 1;

  const resetOverrides = params.resetInstanceOverrides !== false;

  db.transaction(() => {
    db.prepare(
      `INSERT INTO external_event_group_rules (
        user_id, subscription_id, group_key, group_label,
        allow_scheduling, ai_reminder_enabled, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, subscription_id, group_key) DO UPDATE SET
        group_label = excluded.group_label,
        allow_scheduling = excluded.allow_scheduling,
        ai_reminder_enabled = excluded.ai_reminder_enabled,
        updated_at = CURRENT_TIMESTAMP`
    ).run(params.userId, subId, cleanKey, nextLabel, nextAllow, nextRemind);

    if (resetOverrides) {
      if (params.allowScheduling !== undefined && params.aiReminderEnabled !== undefined) {
        db.prepare(
          `DELETE FROM external_event_overrides
           WHERE user_id = ? AND subscription_id = ? AND group_key = ?`
        ).run(params.userId, subId, cleanKey);
      } else if (params.allowScheduling !== undefined) {
        db.prepare(
          `UPDATE external_event_overrides
           SET allow_scheduling = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE user_id = ? AND subscription_id = ? AND group_key = ?`
        ).run(params.userId, subId, cleanKey);
        db.prepare(
          `DELETE FROM external_event_overrides
           WHERE user_id = ? AND subscription_id = ? AND group_key = ?
             AND allow_scheduling IS NULL AND ai_reminder_enabled IS NULL`
        ).run(params.userId, subId, cleanKey);
      } else if (params.aiReminderEnabled !== undefined) {
        db.prepare(
          `UPDATE external_event_overrides
           SET ai_reminder_enabled = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE user_id = ? AND subscription_id = ? AND group_key = ?`
        ).run(params.userId, subId, cleanKey);
        db.prepare(
          `DELETE FROM external_event_overrides
           WHERE user_id = ? AND subscription_id = ? AND group_key = ?
             AND allow_scheduling IS NULL AND ai_reminder_enabled IS NULL`
        ).run(params.userId, subId, cleanKey);
      }
    }
  })();

  return db
    .prepare(
      `SELECT * FROM external_event_group_rules
       WHERE user_id = ? AND subscription_id = ? AND group_key = ?`
    )
    .get(params.userId, subId, cleanKey) as ExternalEventGroupRule;
}
