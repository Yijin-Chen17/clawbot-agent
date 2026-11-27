import crypto from 'crypto';
import ical from 'node-ical';
import icalGenerator, { ICalAlarmType, ICalEventStatus } from 'ical-generator';
import { db } from '../config/database.js';
import { CalendarSubscription } from '../models/types.js';
import { checkAccountEligibility, getUserTimezone } from './accountService.js';
import { queryScheduleInRange } from './scheduleQueryService.js';
import { extractCourseGroup } from './externalEventPolicyService.js';
import { syncExternalNotificationOutboxForUser } from './externalOutboxService.js';

export type CalendarDataFetcher = (url: string) => Promise<Record<string, any>>;
let customCalendarFetcher: CalendarDataFetcher | null = null;

export function setCalendarFetcherForTest(fetcher: CalendarDataFetcher | null): void {
  customCalendarFetcher = fetcher;
}

export function calendarFetchUrl(value: string): string {
  const input = value.trim().replace(/^webcal:\/\//i, 'https://');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('请输入有效的 webcal、http 或 https 日历订阅链接');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password) {
    throw new Error('请输入有效的 webcal、http 或 https 日历订阅链接');
  }
  return url.href;
}

interface ParsedCalendarEvent {
  uid: string;
  recurrenceId: string | null;
  occurrenceStart: string;
  title: string;
  startTime: string;
  endTime: string;
  isAllDay: number;
  status: string;
  transparency: string;
}

function normalizeExdateSet(ev: any): Set<number> {
  const set = new Set<number>();
  if (!ev?.exdate) return set;
  const entries = Array.isArray(ev.exdate) ? ev.exdate : Object.values(ev.exdate);
  for (const val of entries) {
    const dt = val instanceof Date ? val : new Date(val);
    if (!Number.isNaN(dt.getTime())) {
      set.add(dt.getTime());
    }
  }
  return set;
}

function getRecurrenceKey(ev: any): string | null {
  const rec = ev?.recurrenceid;
  if (!rec) return null;
  const dt = rec instanceof Date ? rec : new Date(rec);
  return Number.isNaN(dt.getTime()) ? String(rec) : dt.toISOString();
}

function buildFallbackEventUid(subId: number, ev: any): string {
  const startIso = ev?.start && !Number.isNaN(new Date(ev.start).getTime()) ? new Date(ev.start).toISOString() : '';
  const endIso = ev?.end && !Number.isNaN(new Date(ev.end).getTime()) ? new Date(ev.end).toISOString() : '';
  const seed = `${subId}|${String(ev?.summary || '').trim()}|${startIso}|${endIso}|${ev?.rrule ? String(ev.rrule) : ''}`;
  return `auto-${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16)}`;
}

function computeEventsDigest(events: ParsedCalendarEvent[]): string {
  // Intentionally exclude ephemeral/random VEVENT UIDs so feeds that regenerate UUIDs per fetch
  // (e.g. university timetable exports) do not trigger false "changed" replans every sync.
  const normalized = [...events]
    .sort((a, b) =>
      `${a.startTime}|${a.endTime}|${a.title}|${a.occurrenceStart}`.localeCompare(
        `${b.startTime}|${b.endTime}|${b.title}|${b.occurrenceStart}`
      )
    )
    .map(e => `${e.occurrenceStart}|${e.startTime}|${e.endTime}|${e.title}|${e.status}|${e.transparency}|${e.isAllDay}`);
  return crypto.createHash('sha256').update(normalized.join('\n')).digest('hex');
}

/**
 * 同步单路外部日历订阅（C01, C03, C04）：
 * - 按 UID 合并 RRULE、EXDATE 取消日期、RECURRENCE-ID 单次改期/取消与 TRANSP 透明忙闲标记
 * - 先在内存展开并校验全部事件，任一系列失败则保留上一代次可用快照
 * - 校验订阅代次，防止晚到的旧同步覆盖新快照；仅当事件集合变化时返回 changed: true
 */
export async function syncSubscription(
  sub: CalendarSubscription,
  nowOverride?: Date
): Promise<{ count: number; changed: boolean; generation: number }> {
  const startSubRow = db
    .prepare('SELECT id, COALESCE(current_generation, 0) as current_generation FROM calendar_subscriptions WHERE id = ?')
    .get(sub.id) as { id: number; current_generation: number } | undefined;
  const expectedGeneration = startSubRow?.current_generation ?? 0;

  const attemptNow = nowOverride || new Date();
  const attemptIso = attemptNow.toISOString();
  db.prepare(`
    UPDATE calendar_subscriptions
    SET last_attempt_at = ?
    WHERE id = ?
  `).run(attemptIso, sub.id);

  try {
    const fetchUrl = calendarFetchUrl(sub.url);
    const events = customCalendarFetcher ? await customCalendarFetcher(fetchUrl) : await ical.async.fromURL(fetchUrl);

    const now = attemptNow;
    const futureLimit = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
    const pastLimit = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const vevents: any[] = [];
    for (const k in events) {
      if (!Object.prototype.hasOwnProperty.call(events, k)) continue;
      const ev = events[k] as any;
      if (ev && ev.type === 'VEVENT') vevents.push(ev);
    }

    // Separate master events and RECURRENCE-ID overrides
    const overridesByUid = new Map<string, Map<string, any>>();
    const masters: any[] = [];

    for (const ev of vevents) {
      const uid = String(ev.uid || buildFallbackEventUid(sub.id, ev)).trim();
      const recKey = getRecurrenceKey(ev);
      if (recKey) {
        const map = overridesByUid.get(uid) || new Map<string, any>();
        map.set(recKey, ev);
        overridesByUid.set(uid, map);
      } else {
        masters.push(ev);
      }
    }

    const parsedEvents: ParsedCalendarEvent[] = [];
    const consumedOverrideKeys = new Set<string>();

    for (const ev of masters) {
      const uid = String(ev.uid || buildFallbackEventUid(sub.id, ev)).trim();
      const title = ev.summary || '无标题外部日程';
      const baseStatus = String(ev.status || 'CONFIRMED').toUpperCase();
      const baseTransp = String(ev.transparency || 'OPAQUE').toUpperCase();
      const overrides = overridesByUid.get(uid);

      if (ev.rrule) {
        // Strict RRULE expansion: failure aborts whole sync so previous snapshot stays intact
        const dates: Date[] = ev.rrule.between(pastLimit, futureLimit, true);
        const durationMs = ev.end && ev.start ? Math.max(60000, new Date(ev.end).getTime() - new Date(ev.start).getTime()) : 3600000;
        const exdates = normalizeExdateSet(ev);

        for (const rDate of dates) {
          const rStart = new Date(rDate);
          if (exdates.has(rStart.getTime())) continue;

          const occKey = rStart.toISOString();
          const override = overrides?.get(occKey);
          if (override) {
            consumedOverrideKeys.add(`${uid}::${occKey}`);
            const ovStatus = String(override.status || 'CONFIRMED').toUpperCase();
            if (ovStatus === 'CANCELLED') continue;
            const ovStart = new Date(override.start);
            const ovEnd = override.end ? new Date(override.end) : new Date(ovStart.getTime() + durationMs);
            if (Number.isNaN(ovStart.getTime()) || Number.isNaN(ovEnd.getTime())) {
              throw new Error(`日程「${title}」存在无效的改期例外时间`);
            }
            parsedEvents.push({
              uid,
              recurrenceId: occKey,
              occurrenceStart: occKey,
              title: override.summary || title,
              startTime: ovStart.toISOString(),
              endTime: ovEnd.toISOString(),
              isAllDay: override.datetype === 'date' ? 1 : 0,
              status: ovStatus,
              transparency: String(override.transparency || baseTransp).toUpperCase(),
            });
            continue;
          }

          if (baseStatus === 'CANCELLED') continue;
          const rEnd = new Date(rStart.getTime() + durationMs);
          parsedEvents.push({
            uid,
            recurrenceId: null,
            occurrenceStart: occKey,
            title,
            startTime: rStart.toISOString(),
            endTime: rEnd.toISOString(),
            isAllDay: ev.datetype === 'date' ? 1 : 0,
            status: baseStatus,
            transparency: baseTransp,
          });
        }
      } else if (ev.start) {
        if (baseStatus === 'CANCELLED') continue;
        const start = new Date(ev.start);
        const end = ev.end ? new Date(ev.end) : new Date(start.getTime() + 3600000);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
          throw new Error(`日程「${title}」存在无效的时间格式`);
        }
        if (end >= pastLimit && start <= futureLimit) {
          parsedEvents.push({
            uid,
            recurrenceId: null,
            occurrenceStart: start.toISOString(),
            title,
            startTime: start.toISOString(),
            endTime: end.toISOString(),
            isAllDay: ev.datetype === 'date' ? 1 : 0,
            status: baseStatus,
            transparency: baseTransp,
          });
        }
      }
    }

    // Handle standalone RECURRENCE-ID overrides whose master occurrence fell outside or wasn't present
    for (const [uid, map] of overridesByUid.entries()) {
      for (const [occKey, override] of map.entries()) {
        if (consumedOverrideKeys.has(`${uid}::${occKey}`)) continue;
        const ovStatus = String(override.status || 'CONFIRMED').toUpperCase();
        if (ovStatus === 'CANCELLED' || !override.start) continue;
        const ovStart = new Date(override.start);
        const ovEnd = override.end ? new Date(override.end) : new Date(ovStart.getTime() + 3600000);
        if (ovEnd >= pastLimit && ovStart <= futureLimit) {
          parsedEvents.push({
            uid,
            recurrenceId: occKey,
            occurrenceStart: occKey,
            title: override.summary || '无标题外部日程',
            startTime: ovStart.toISOString(),
            endTime: ovEnd.toISOString(),
            isAllDay: override.datetype === 'date' ? 1 : 0,
            status: ovStatus,
            transparency: String(override.transparency || 'OPAQUE').toUpperCase(),
          });
        }
      }
    }

    const newDigest = computeEventsDigest(parsedEvents);

    const txOutcome = db.transaction(() => {
      const latestSub = db
        .prepare('SELECT id, COALESCE(current_generation, 0) as current_generation FROM calendar_subscriptions WHERE id = ?')
        .get(sub.id) as { id: number; current_generation: number } | undefined;

      if (!latestSub) {
        throw new Error('日历订阅已被删除');
      }
      if (latestSub.current_generation !== expectedGeneration) {
        // Stale sync response must not overwrite newer snapshot generation
        return { count: parsedEvents.length, changed: false, generation: latestSub.current_generation, stale: true };
      }

      const prevRows = db.prepare(`
        SELECT uid, occurrence_start, start_time, end_time, title, status, transparency, is_all_day
        FROM external_events
        WHERE subscription_id = ? AND COALESCE(generation, 0) = ?
      `).all(sub.id, expectedGeneration) as any[];

      const prevParsed: ParsedCalendarEvent[] = prevRows.map(r => ({
        uid: r.uid || '',
        recurrenceId: null,
        occurrenceStart: r.occurrence_start || r.start_time,
        title: r.title,
        startTime: r.start_time,
        endTime: r.end_time,
        isAllDay: r.is_all_day ? 1 : 0,
        status: r.status || 'CONFIRMED',
        transparency: r.transparency || 'OPAQUE',
      }));
      const prevDigest = prevRows.length > 0 ? computeEventsDigest(prevParsed) : '';
      const changed = newDigest !== prevDigest || expectedGeneration === 0;
      const nextGen = expectedGeneration + 1;

      db.prepare('DELETE FROM external_events WHERE subscription_id = ?').run(sub.id);

      const insertStmt = db.prepare(`
        INSERT INTO external_events (
          user_id, subscription_id, uid, generation, recurrence_id,
          status, transparency, occurrence_start, course_group_key, course_group_label,
          title, start_time, end_time, is_all_day
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const item of parsedEvents) {
        const group = extractCourseGroup(item.title);
        insertStmt.run(
          sub.user_id,
          sub.id,
          item.uid,
          nextGen,
          item.recurrenceId,
          item.status,
          item.transparency,
          item.occurrenceStart,
          group.groupKey,
          group.groupLabel,
          item.title,
          item.startTime,
          item.endTime,
          item.isAllDay
        );
      }

      const successIso = (nowOverride || new Date()).toISOString();
      db.prepare(`
        UPDATE calendar_subscriptions
        SET current_generation = ?,
            last_sync_at = datetime('now', 'localtime'),
            last_success_at = ?,
            sync_status = 'ok',
            error_message = NULL
        WHERE id = ?
      `).run(nextGen, successIso, sub.id);

      return { count: parsedEvents.length, changed, generation: nextGen, stale: false };
    })();

    if (!txOutcome.stale) {
      try {
        syncExternalNotificationOutboxForUser(sub.user_id, nowOverride || new Date());
      } catch (err: any) {
        console.warn(`[Calendar] Sync external reminder outbox failed for user #${sub.user_id}:`, err.message);
      }
    }

    return { count: txOutcome.count, changed: txOutcome.changed, generation: txOutcome.generation };
  } catch (err: any) {
    db.prepare(`
      UPDATE calendar_subscriptions
      SET sync_status = 'error', error_message = ?, last_attempt_at = ?
      WHERE id = ?
    `).run(err.message, (nowOverride || new Date()).toISOString(), sub.id);
    throw err;
  }
}

export interface SubscriptionSyncSummaryItem {
  subscriptionId: number;
  name: string;
  success: boolean;
  count: number;
  changed: boolean;
  generation?: number;
  lastSuccessAt?: string | null;
  error?: string;
}

/**
 * 同步用户全部订阅，逐条记录成功/失败并仅在内容变化时提示需要重排（C04）
 */
export async function syncAllUserSubscriptions(userId: number): Promise<{
  totalEvents: number;
  subscriptionsSynced: number;
  failedCount: number;
  anyChanged: boolean;
  results: SubscriptionSyncSummaryItem[];
}> {
  const subs = db
    .prepare('SELECT * FROM calendar_subscriptions WHERE user_id = ?')
    .all(userId) as CalendarSubscription[];

  let totalEvents = 0;
  let subscriptionsSynced = 0;
  let failedCount = 0;
  let anyChanged = false;
  const results: SubscriptionSyncSummaryItem[] = [];

  for (const sub of subs) {
    try {
      const res = await syncSubscription(sub);
      totalEvents += res.count;
      subscriptionsSynced++;
      if (res.changed) anyChanged = true;
      results.push({
        subscriptionId: sub.id,
        name: sub.name,
        success: true,
        count: res.count,
        changed: res.changed,
        generation: res.generation,
        lastSuccessAt: new Date().toISOString(),
      });
    } catch (err: any) {
      failedCount++;
      console.warn(`[Calendar] Failed to sync subscription #${sub.id} (${sub.name}):`, err.message);
      results.push({
        subscriptionId: sub.id,
        name: sub.name,
        success: false,
        count: 0,
        changed: false,
        lastSuccessAt: sub.last_success_at || sub.last_sync_at || null,
        error: err.message,
      });
    }
  }

  return { totalEvents, subscriptionsSynced, failedCount, anyChanged, results };
}

/**
 * 生成专用 TODO ICS 订阅（C05, C06）：
 * - 使用账户业务时区、用户配置的提前提醒分钟数、稳定块 UID
 * - 与网页和微信共用统一查询区间读模型
 */
export function generateUserTodoIcal(userId: number, username: string): string {
  const check = checkAccountEligibility(userId);
  if (!check.eligible) {
    throw new Error(check.message || '账号不可用');
  }

  const tz = getUserTimezone(userId);
  const settings = db
    .prepare('SELECT reminder_before_start_minutes FROM user_settings WHERE user_id = ?')
    .get(userId) as { reminder_before_start_minutes?: number } | undefined;
  const alarmSeconds = Math.max(60, Number(settings?.reminder_before_start_minutes ?? 5) * 60);

  const cal = icalGenerator({
    name: `${username} 的 Clawbot 智能待办日历`,
    description: '由 Clawbot 微信助手与 oxoxox 四象限算法智能规划的待办日历',
    timezone: tz,
  });

  const rangeStart = new Date(Date.now() - 30 * 86400000).toISOString();
  const rangeEnd = new Date(Date.now() + 60 * 86400000).toISOString();
  const { blocks } = queryScheduleInRange(userId, rangeStart, rangeEnd);

  for (const b of blocks) {
    const isCompleted = b.blockStatus === 'completed' || b.instanceStatus === 'completed';
    const statusIcon = isCompleted ? '✅' : b.blockStatus === 'conflict' ? '⚠️' : '📌';
    const partSuffix = b.totalParts > 1 ? ` (${b.partIndex}/${b.totalParts}节)` : '';
    let attrPrefix = '';
    if (b.isFixed) attrPrefix += '[固定] ';
    if (b.isConcurrent) attrPrefix += '[双线程] ';
    const summary = `${statusIcon} ${attrPrefix}${b.title}${partSuffix}`;

    let typeDesc = '';
    if (b.isFixed && b.isConcurrent) typeDesc = '任务属性：固定时间任务 · 双线程任务';
    else if (b.isFixed) typeDesc = '任务属性：固定时间任务（锁定时间段）';
    else if (b.isConcurrent) typeDesc = '任务属性：双线程任务（可与其他日程并行重叠）';

    const descLines = [
      `【Clawbot × oxoxox 智能排程】`,
      `待办事项：${b.title}`,
      typeDesc,
      b.strategyLabel ? `排程策略：${b.strategyLabel}` : '',
      `任务状态：${isCompleted ? '已完成' : b.instanceStatus === 'in_progress' ? '进行中' : '待进行'}`,
      `本段时长：${b.durationMinutes} 分钟`,
      `紧急程度：${b.urgency} / 100  ·  重要程度：${b.importance} / 100`,
      b.deadline ? `截止时间：${new Date(b.deadline).toLocaleString('zh-CN', { timeZone: tz })}` : '',
      b.notes ? `备注：${b.notes}` : '',
    ].filter(Boolean);

    const event = cal.createEvent({
      id: `clawbot-block-${b.blockId}@clawbot.local`,
      start: new Date(b.start),
      end: new Date(b.end),
      summary,
      description: descLines.join('\n'),
      status: isCompleted ? ICalEventStatus.CONFIRMED : ICalEventStatus.TENTATIVE,
    });

    event.createAlarm({
      type: ICalAlarmType.display,
      trigger: alarmSeconds,
      description: `【开始提醒】待办任务【${b.title}】即将开始！`,
    });
  }

  return cal.toString();
}
