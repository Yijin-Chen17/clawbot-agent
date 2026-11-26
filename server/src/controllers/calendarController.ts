import { Request, Response } from 'express';
import { db } from '../config/database.js';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { CalendarSubscription, User } from '../models/types.js';
import { syncSubscription, syncAllUserSubscriptions, generateUserTodoIcal, calendarFetchUrl } from '../services/calendarSync.js';
import { replanUserTasks } from '../services/scheduler.js';
import { renderCalendarImage, renderTodoListImage } from '../services/cardRenderer.js';
import { checkAccountEligibility } from '../services/accountService.js';
import { queryScheduleInRange } from '../services/scheduleQueryService.js';
import { ignoreExternalCalendarInstance } from '../services/taskService.js';
import {
  listExternalEventGroups,
  upsertExternalGroupRule,
  upsertSingleExternalEventOverride,
} from '../services/externalEventPolicyService.js';
import { syncExternalNotificationOutboxForUser } from '../services/externalOutboxService.js';

function parseExternalEventId(raw: string | string[] | undefined): number {
  const s = Array.isArray(raw) ? raw[0] : raw || '';
  const cleaned = s.trim().replace(/^ext-/i, '');
  const n = Number(cleaned);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

export function listSubscriptions(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const subscriptions = db.prepare(`
    SELECT
      cs.*,
      (
        SELECT count(*) FROM external_events ee
        WHERE ee.subscription_id = cs.id
          AND COALESCE(ee.generation, 0) = COALESCE(cs.current_generation, 0)
      ) as event_count
    FROM calendar_subscriptions cs
    WHERE cs.user_id = ?
    ORDER BY cs.created_at DESC
  `).all(userId);

  res.json({ subscriptions });
}

export async function createSubscription(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { name, url } = req.body;

  if (!name || !url) {
    res.status(400).json({ error: '请提供日历名称与订阅链接' });
    return;
  }

  if (typeof name !== 'string' || typeof url !== 'string' || !name.trim()) {
    res.status(400).json({ error: '请提供日历名称与订阅链接' });
    return;
  }
  try {
    calendarFetchUrl(url);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
    return;
  }

  const result = db.prepare(`
    INSERT INTO calendar_subscriptions (user_id, name, url)
    VALUES (?, ?, ?)
  `).run(userId, name.trim(), url.trim());

  const subId = Number(result.lastInsertRowid);
  const sub = db.prepare('SELECT * FROM calendar_subscriptions WHERE id = ?').get(subId) as CalendarSubscription;

  let syncMsg = '';
  let syncOk = true;
  try {
    const { count } = await syncSubscription(sub);
    replanUserTasks(userId, { triggerSource: 'create_subscription' });
    syncMsg = `，并成功同步了 ${count} 条外部日程事件`;
  } catch (err: any) {
    syncOk = false;
    syncMsg = `，但初次同步失败：${err.message}`;
  }

  // Re-fetch updated subscription state (C04)
  const latestSub = db.prepare(`
    SELECT cs.*,
      (SELECT count(*) FROM external_events ee WHERE ee.subscription_id = cs.id AND COALESCE(ee.generation, 0) = COALESCE(cs.current_generation, 0)) as event_count
    FROM calendar_subscriptions cs WHERE cs.id = ?
  `).get(subId);

  res.status(201).json({
    message: `日历订阅「${name}」已添加${syncMsg}！`,
    syncOk,
    subscription: latestSub,
  });
}

export function deleteSubscription(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const { id } = req.params;

  db.transaction(() => {
    db.prepare('DELETE FROM external_events WHERE subscription_id = ? AND user_id = ?').run(id, userId);
    db.prepare('DELETE FROM calendar_ignored_instances WHERE subscription_id = ? AND user_id = ?').run(id, userId);
    db.prepare('DELETE FROM external_event_group_rules WHERE subscription_id = ? AND user_id = ?').run(id, userId);
    db.prepare('DELETE FROM external_event_overrides WHERE subscription_id = ? AND user_id = ?').run(id, userId);
    db.prepare(
      `UPDATE external_notification_outbox
       SET status = 'cancelled', last_error = 'subscription_deleted', lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE subscription_id = ? AND user_id = ? AND status IN ('pending', 'failed')`
    ).run(id, userId);
    db.prepare('DELETE FROM calendar_subscriptions WHERE id = ? AND user_id = ?').run(id, userId);
  })();

  // Replan immediately to reclaim freed time slots (C04)
  const replan = replanUserTasks(userId, { triggerSource: 'delete_subscription' });
  res.json({ message: '日历订阅已移除并已重排空闲时段', planVersion: replan.planVersion });
}

export function ignoreExternalEvent(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const eventId = parseExternalEventId(req.params.id);
  if (!Number.isFinite(eventId)) {
    res.status(400).json({ error: '无效的外部日程 ID' });
    return;
  }
  const resIgn = ignoreExternalCalendarInstance(userId, eventId);
  try {
    syncExternalNotificationOutboxForUser(userId);
  } catch {}
  res.json(resIgn);
}

export function updateExternalEventPolicy(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const eventId = parseExternalEventId(req.params.id);
  if (!Number.isFinite(eventId)) {
    res.status(400).json({ error: '无效的外部日程 ID' });
    return;
  }

  const body = req.body || {};
  const allowScheduling =
    body.allowScheduling === undefined ? undefined : body.allowScheduling === null ? null : Boolean(body.allowScheduling);
  const aiReminderEnabled =
    body.aiReminderEnabled === undefined ? undefined : body.aiReminderEnabled === null ? null : Boolean(body.aiReminderEnabled);
  const matchSameName = Boolean(body.matchSameName);

  if (allowScheduling === undefined && aiReminderEnabled === undefined) {
    res.status(400).json({ error: '请提供要更新的策略字段' });
    return;
  }

  try {
    let resolvedEventId = eventId;
    let target = db
      .prepare('SELECT id, title FROM external_events WHERE id = ? AND user_id = ?')
      .get(resolvedEventId, userId) as { id: number; title: string } | undefined;

    if (!target && (body.uid || body.title)) {
      if (body.uid && body.start) {
        target = db
          .prepare(
            `SELECT id, title FROM external_events
             WHERE user_id = ? AND uid = ? AND (start_time = ? OR occurrence_start = ?)
             ORDER BY id DESC LIMIT 1`
          )
          .get(userId, String(body.uid), String(body.start), String(body.start)) as
          | { id: number; title: string }
          | undefined;
      }
      if (!target && body.title && body.start) {
        target = db
          .prepare(
            `SELECT id, title FROM external_events
             WHERE user_id = ? AND TRIM(title) = TRIM(?) AND start_time = ?
             ORDER BY id DESC LIMIT 1`
          )
          .get(userId, String(body.title), String(body.start)) as
          | { id: number; title: string }
          | undefined;
      }
      if (target) {
        resolvedEventId = target.id;
      }
    }

    if (!target) {
      res.status(404).json({ error: '未找到指定外部日程' });
      return;
    }

    let policy;
    if (matchSameName) {
      const matchingRows = db
        .prepare('SELECT id FROM external_events WHERE user_id = ? AND TRIM(title) = TRIM(?)')
        .all(userId, target.title) as Array<{ id: number }>;
      for (const row of matchingRows) {
        const updated = upsertSingleExternalEventOverride({
          userId,
          eventId: row.id,
          allowScheduling,
          aiReminderEnabled,
        });
        if (row.id === resolvedEventId) {
          policy = updated.policy;
        }
      }
      if (!policy) {
        policy = upsertSingleExternalEventOverride({
          userId,
          eventId: resolvedEventId,
          allowScheduling,
          aiReminderEnabled,
        }).policy;
      }
    } else {
      policy = upsertSingleExternalEventOverride({
        userId,
        eventId: resolvedEventId,
        allowScheduling,
        aiReminderEnabled,
      }).policy;
    }
    syncExternalNotificationOutboxForUser(userId);
    let planVersion: number | undefined;
    if (allowScheduling !== undefined) {
      const replan = replanUserTasks(userId, { triggerSource: 'external_event_policy' });
      planVersion = replan.planVersion;
    }
    res.json({
      success: true,
      policy,
      planVersion,
      message: '已更新该外部日程设置',
    });
  } catch (err: any) {
    res.status(404).json({ error: err.message || '更新失败' });
  }
}

export function listExternalGroups(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const rawSubId = req.query.subscriptionId;
  const subId = rawSubId !== undefined && rawSubId !== '' ? Number(rawSubId) : undefined;
  const groups = listExternalEventGroups(userId, Number.isFinite(subId) ? subId : undefined);
  res.json({ groups });
}

export function updateExternalGroupPolicy(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const body = req.body || {};
  const subscriptionId = Number(body.subscriptionId ?? 0);
  const groupKey = typeof body.groupKey === 'string' ? body.groupKey.trim() : '';
  const groupLabel = typeof body.groupLabel === 'string' ? body.groupLabel.trim() : undefined;

  if (!groupKey) {
    res.status(400).json({ error: '请提供课程/日程分组标识' });
    return;
  }

  const allowScheduling = body.allowScheduling === undefined ? undefined : Boolean(body.allowScheduling);
  const aiReminderEnabled = body.aiReminderEnabled === undefined ? undefined : Boolean(body.aiReminderEnabled);
  const resetInstanceOverrides = body.resetInstanceOverrides === undefined ? true : Boolean(body.resetInstanceOverrides);

  if (allowScheduling === undefined && aiReminderEnabled === undefined && !body.resetInstanceOverrides) {
    res.status(400).json({ error: '请提供要更新的批量策略字段' });
    return;
  }

  const rule = upsertExternalGroupRule({
    userId,
    subscriptionId,
    groupKey,
    groupLabel,
    allowScheduling,
    aiReminderEnabled,
    resetInstanceOverrides,
  });

  syncExternalNotificationOutboxForUser(userId);
  let planVersion: number | undefined;
  if (allowScheduling !== undefined || resetInstanceOverrides) {
    const replan = replanUserTasks(userId, { triggerSource: 'external_group_policy' });
    planVersion = replan.planVersion;
  }

  const groups = listExternalEventGroups(userId);
  res.json({
    success: true,
    rule,
    groups,
    planVersion,
    message: `已更新「${rule.group_label}」的批量排程与提醒设置`,
  });
}

export function updateCalendarColor(req: AuthenticatedRequest, res: Response): void {
  const color = req.body?.color;
  const isReset = color === null || color === '' || color === undefined;
  if (!isReset && (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color))) {
    res.status(400).json({ error: '请选择有效的颜色' });
    return;
  }
  const userId = req.user!.id;
  const targetColor = isReset ? null : color;
  if (req.params.id === 'tasks') {
    db.prepare(`INSERT INTO user_settings (user_id, calendar_color) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET calendar_color = excluded.calendar_color`).run(userId, targetColor);
  } else {
    const result = db.prepare('UPDATE calendar_subscriptions SET color = ? WHERE id = ? AND user_id = ?')
      .run(targetColor, req.params.id, userId);
    if (!result.changes) {
      res.status(404).json({ error: '日历不存在' });
      return;
    }
  }
  res.json({ color: targetColor });
}

export async function syncSubscriptionNow(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  const { id } = req.params;

  const sub = db
    .prepare('SELECT * FROM calendar_subscriptions WHERE id = ? AND user_id = ?')
    .get(id, userId) as CalendarSubscription | undefined;
  if (!sub) {
    res.status(404).json({ error: '日历订阅不存在' });
    return;
  }

  try {
    const syncRes = await syncSubscription(sub);
    let planVersion: number | undefined;
    if (syncRes.changed) {
      const replan = replanUserTasks(userId, { triggerSource: 'sync_subscription' });
      planVersion = replan.planVersion;
    }
    res.json({
      message: `同步成功！已更新 ${syncRes.count} 条外部日程。`,
      ...syncRes,
      planVersion,
    });
  } catch (err: any) {
    res.status(500).json({ error: `同步失败：${err.message}` });
  }
}

/**
 * 统一日历视图查询接口（C05）：与微信和 ICS 共用同一份区间块读模型
 */
export function getCalendarEvents(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const { start, end } = req.query;

  const startIso = (start as string) || new Date(Date.now() - 15 * 86400000).toISOString();
  const endIso = (end as string) || new Date(Date.now() + 30 * 86400000).toISOString();

  const unified = queryScheduleInRange(userId, startIso, endIso);

  const formattedEvents = [
    ...unified.externalEvents.map(ev => ({
      id: ev.id,
      rawId: ev.rawId,
      title: ev.title,
      start: ev.start,
      end: ev.end,
      allDay: ev.isAllDay,
      subscriptionId: ev.subscriptionId,
      subscriptionName: ev.subscriptionName,
      backgroundColor: '#0284c7',
      borderColor: '#0284c7',
      extendedProps: {
        type: 'external',
        rawId: ev.rawId,
        subscriptionId: ev.subscriptionId,
        subscriptionName: ev.subscriptionName,
        uid: ev.uid,
        occurrenceStart: ev.occurrenceStart,
        courseGroupKey: ev.courseGroupKey,
        courseGroupLabel: ev.courseGroupLabel,
        allowScheduling: ev.allowScheduling,
        aiReminderEnabled: ev.aiReminderEnabled,
        hasInstanceOverride: ev.hasInstanceOverride,
        groupAllowScheduling: ev.groupAllowScheduling,
        groupAiReminderEnabled: ev.groupAiReminderEnabled,
        sameNameCount: ev.sameNameCount,
      },
    })),
    ...unified.blocks.map(b => {
      let color = '#3b82f6';
      if (b.blockStatus === 'completed' || b.instanceStatus === 'completed') color = '#10b981';
      else if (b.blockStatus === 'conflict') color = '#dc2626';
      else if (b.urgency >= 65) color = '#ef4444';
      else if (b.importance >= 50) color = '#f59e0b';

      const partSuffix = b.totalParts > 1 ? ` (${b.partIndex}/${b.totalParts}节)` : '';
      let prefix = '';
      if (b.isFixed) prefix += '📌 ';
      if (b.isConcurrent) prefix += '⚡ ';
      if (b.blockStatus === 'conflict') prefix += '⚠️ ';

      return {
        id: b.blockId,
        title: `${prefix}${b.title}${partSuffix}`,
        start: b.start,
        end: b.end,
        backgroundColor: color,
        borderColor: color,
        extendedProps: {
          type: 'task',
          blockId: b.blockId,
          taskId: b.taskId,
          instanceId: b.instanceId,
          planVersion: b.planVersion,
          partIndex: b.partIndex,
          totalParts: b.totalParts,
          urgency: b.urgency,
          importance: b.importance,
          duration: b.durationMinutes,
          status: b.blockStatus === 'completed' ? 'completed' : b.instanceStatus,
          blockStatus: b.blockStatus,
          planStatus: b.planStatus,
          allocatedMinutes: b.allocatedMinutes,
          unallocatedMinutes: b.unallocatedMinutes,
          deadline: b.deadline,
          deadlineKind: b.deadlineKind,
          notes: b.notes,
          tags: b.tags,
          is_fixed: b.isFixed ? 1 : 0,
          is_concurrent: b.isConcurrent ? 1 : 0,
          isFixed: b.isFixed,
          isCommitted: b.isCommitted,
          isConcurrent: b.isConcurrent,
          strategyLabel: b.strategyLabel,
          energyZone: b.energyZone,
          businessDate: b.businessDate,
        },
      };
    }),
  ];

  const subscriptions = db.prepare(`
    SELECT
      cs.*,
      (
        SELECT count(*) FROM external_events ee
        WHERE ee.subscription_id = cs.id
          AND COALESCE(ee.generation, 0) = COALESCE(cs.current_generation, 0)
      ) as event_count
    FROM calendar_subscriptions cs
    WHERE cs.user_id = ?
    ORDER BY cs.created_at DESC
  `).all(userId);

  const userRecord = db.prepare('SELECT token_secret FROM users WHERE id = ?').get(userId) as { token_secret: string } | undefined;
  const token = userRecord?.token_secret || '';

  const host = req.get('host') || '127.0.0.1:5178';
  const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';

  res.json({
    planVersion: unified.planVersion,
    timezone: unified.timezone,
    events: formattedEvents,
    subscriptions,
    externalEventGroups: listExternalEventGroups(userId),
    taskColor: (db.prepare('SELECT calendar_color FROM user_settings WHERE user_id = ?').get(userId) as { calendar_color?: string } | undefined)?.calendar_color || null,
    exportUrls: {
      http: `${protocol}://${host}/api/calendar/subscribe/${token}.ics`,
      download: `${protocol}://${host}/api/calendar/export/${token}.ics`,
      token,
    },
  });
}

export function exportDedicatedIcal(req: Request, res: Response): void {
  const rawToken = Array.isArray(req.params.token) ? req.params.token[0] : (req.params.token || '');
  let token = rawToken.trim();
  if (token.endsWith('.ics')) {
    token = token.substring(0, token.length - 4);
  }

  if (!token) {
    res.status(400).send('Missing subscription token');
    return;
  }

  const user = db.prepare('SELECT id, username, status FROM users WHERE token_secret = ?').get(token) as User | undefined;
  if (!user) {
    res.status(404).send('Invalid or expired subscription link');
    return;
  }

  // Unified eligibility check for public ICS links (A02)
  const elig = checkAccountEligibility(user.id);
  if (!elig.eligible) {
    res.status(403).send(elig.message || 'Account disabled');
    return;
  }

  try {
    const icalContent = generateUserTodoIcal(user.id, user.username);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="clawbot-${user.username}-todos.ics"`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(icalContent);
  } catch (err: any) {
    res.status(500).send(`Error generating calendar: ${err.message}`);
  }
}

export async function syncAndReplanAll(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  try {
    const syncRes = await syncAllUserSubscriptions(userId);
    const replanRes = syncRes.anyChanged ? replanUserTasks(userId, { triggerSource: 'sync_and_replan' }) : null;

    const allFailed = syncRes.results.length > 0 && syncRes.subscriptionsSynced === 0;
    const partialFailed = syncRes.failedCount > 0 && syncRes.subscriptionsSynced > 0;

    res.status(allFailed ? 502 : 200).json({
      success: !allFailed,
      message: allFailed
        ? '全部外部日历同步失败，已保留上一份可用忙时快照'
        : partialFailed
        ? `部分日历同步完成（成功 ${syncRes.subscriptionsSynced}，失败 ${syncRes.failedCount}）`
        : '同步与自适应排程完成！',
      totalEvents: syncRes.totalEvents,
      subscriptionsSynced: syncRes.subscriptionsSynced,
      failedCount: syncRes.failedCount,
      anyChanged: syncRes.anyChanged,
      results: syncRes.results,
      scheduledCount: replanRes?.scheduledCount,
      planVersion: replanRes?.planVersion,
      summary: replanRes?.summary || '外部日程无变化，保持当前排程',
    });
  } catch (err: any) {
    res.status(500).json({ error: `处理失败: ${err.message}` });
  }
}

export function replanAll(req: AuthenticatedRequest, res: Response): void {
  try {
    res.json(replanUserTasks(req.user!.id, { triggerSource: 'manual_replan' }));
  } catch (error: any) {
    res.status(500).json({ error: error.message || '排程失败' });
  }
}

export async function previewCalendarCard(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  try {
    const png = await renderCalendarImage(userId);
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function previewTodoCard(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  try {
    const png = await renderTodoListImage(userId);
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
