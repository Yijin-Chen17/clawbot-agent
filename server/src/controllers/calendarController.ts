import { Request, Response } from 'express';
import { db } from '../config/database.js';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { CalendarSubscription, ExternalEvent, Task, User } from '../models/types.js';
import { syncSubscription, syncAllUserSubscriptions, generateUserTodoIcal } from '../services/calendarSync.js';
import { replanUserTasks } from '../services/scheduler.js';
import { renderCalendarImage, renderTodoListImage } from '../services/cardRenderer.js';

export function listSubscriptions(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const subscriptions = db.prepare(`
    SELECT
      cs.*,
      (SELECT count(*) FROM external_events WHERE subscription_id = cs.id) as event_count
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

  const result = db.prepare(`
    INSERT INTO calendar_subscriptions (user_id, name, url)
    VALUES (?, ?, ?)
  `).run(userId, name.trim(), url.trim());

  const sub = db.prepare('SELECT * FROM calendar_subscriptions WHERE id = ?').get(result.lastInsertRowid) as CalendarSubscription;

  // Try initial sync immediately
  let syncMsg = '';
  try {
    const { count } = await syncSubscription(sub);
    syncMsg = `，并成功同步了 ${count} 条外部日程事件`;
  } catch (err: any) {
    syncMsg = `，但初次同步失败：${err.message}`;
  }

  res.status(201).json({
    message: `日历订阅「${name}」已添加${syncMsg}！`,
    subscription: sub,
  });
}

export function deleteSubscription(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const { id } = req.params;

  db.prepare('DELETE FROM external_events WHERE subscription_id = ? AND user_id = ?').run(id, userId);
  db.prepare('DELETE FROM calendar_subscriptions WHERE id = ? AND user_id = ?').run(id, userId);

  res.json({ message: '日历订阅已移除' });
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

  const sub = db.prepare('SELECT * FROM calendar_subscriptions WHERE id = ? AND user_id = ?').get(id, userId) as CalendarSubscription | undefined;
  if (!sub) {
    res.status(404).json({ error: '日历订阅不存在' });
    return;
  }

  try {
    const { count } = await syncSubscription(sub);
    res.json({ message: `同步成功！已更新 ${count} 条外部日程。` });
  } catch (err: any) {
    res.status(500).json({ error: `同步失败：${err.message}` });
  }
}

/**
 * Combined calendar view for FullCalendar UI:
 * Includes both external calendar busy events and Clawbot TODO scheduled events
 */
export function getCalendarEvents(req: AuthenticatedRequest, res: Response): void {
  const userId = req.user!.id;
  const { start, end } = req.query;

  const startIso = (start as string) || new Date(Date.now() - 15 * 86400000).toISOString();
  const endIso = (end as string) || new Date(Date.now() + 30 * 86400000).toISOString();

  // 1. External events
  const externalEvents = db.prepare(`
    SELECT ee.id, ee.uid, ee.title, ee.start_time as start, ee.end_time as end, ee.is_all_day, ee.subscription_id,
           cs.name as subscription_name
    FROM external_events ee
    LEFT JOIN calendar_subscriptions cs ON cs.id = ee.subscription_id
    WHERE ee.user_id = ? AND ee.end_time >= ? AND ee.start_time <= ?
  `).all(userId, startIso, endIso) as any[];

  // 2. Scheduled tasks
    const tasks = db.prepare(`
    SELECT
      id, title, scheduled_start as start, scheduled_end as end,
      duration_minutes, urgency, importance, score_scale, status, deadline, notes, schedule_blocks,
      is_fixed, is_concurrent
    FROM tasks
    WHERE user_id = ?
      AND scheduled_start IS NOT NULL
      AND scheduled_end IS NOT NULL
      AND scheduled_end >= ?
      AND scheduled_start <= ?
  `).all(userId, startIso, endIso) as any[];

  const formattedEvents = [
    ...externalEvents.map(ev => ({
      id: `ext-${ev.id}`,
      title: ev.title,
      start: ev.start,
      end: ev.end,
      allDay: Boolean(ev.is_all_day),
      subscriptionId: ev.subscription_id,
      subscriptionName: ev.subscription_name || '外部日程',
      backgroundColor: '#0284c7', // Sky / Cyan
      borderColor: '#0284c7',
      extendedProps: {
        type: 'external',
        subscriptionId: ev.subscription_id,
        subscriptionName: ev.subscription_name || '外部日程',
      },
    })),
    ...tasks.flatMap(t => {
      const urg100 = t.score_scale === 100 || t.urgency > 10 ? t.urgency : t.urgency <= 5 ? t.urgency * 20 : t.urgency * 10;
      const imp100 = t.score_scale === 100 || t.importance > 10 ? t.importance : t.importance <= 5 ? t.importance * 20 : t.importance * 10;
      let color = '#3b82f6'; // default blue
      if (t.status === 'completed') color = '#10b981'; // emerald green
      else if (urg100 >= 65) color = '#ef4444';        // red/urgent
      else if (imp100 >= 50) color = '#f59e0b';        // amber/important

      let blocks: any[] = [];
      if (t.schedule_blocks) {
        try {
          blocks = JSON.parse(t.schedule_blocks);
        } catch {}
      }
      if (!Array.isArray(blocks) || blocks.length === 0) {
        blocks = [{ start: t.start, end: t.end }];
      }

      return blocks.map((block, bIdx) => {
        const partSuffix = block.totalParts && block.totalParts > 1 ? ` (${block.partIndex || bIdx + 1}/${block.totalParts}节)` : '';
        let prefix = '';
        if (t.is_fixed) prefix += '📌 ';
        if (t.is_concurrent) prefix += '⚡ ';
        return {
          id: `task-${t.id}-${bIdx}`,
          title: `${prefix}${t.title}${partSuffix}`,
          start: block.start,
          end: block.end,
          backgroundColor: color,
          borderColor: color,
          extendedProps: {
            type: 'task',
            taskId: t.id,
            urgency: t.urgency,
            importance: t.importance,
            duration: block.duration || t.duration_minutes,
            status: t.status,
            deadline: t.deadline,
            notes: t.notes,
            is_fixed: t.is_fixed ? 1 : 0,
            is_concurrent: t.is_concurrent ? 1 : 0,
            isFixed: Boolean(t.is_fixed),
            isConcurrent: Boolean(t.is_concurrent),
            strategyLabel: block.strategyLabel,
            energyZone: block.energyZone,
          },
        };
      });
    }),
  ];

  const subscriptions = db.prepare(`
    SELECT
      cs.*,
      (SELECT count(*) FROM external_events WHERE subscription_id = cs.id) as event_count
    FROM calendar_subscriptions cs
    WHERE cs.user_id = ?
    ORDER BY cs.created_at DESC
  `).all(userId);

  const userRecord = db.prepare('SELECT token_secret FROM users WHERE id = ?').get(userId) as { token_secret: string } | undefined;
  const token = userRecord?.token_secret || '';

  const host = req.get('host') || '127.0.0.1:5178';
  const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';

  res.json({
    events: formattedEvents,
    subscriptions,
    taskColor: (db.prepare('SELECT calendar_color FROM user_settings WHERE user_id = ?').get(userId) as { calendar_color?: string } | undefined)?.calendar_color || null,
    exportUrls: {
      http: `${protocol}://${host}/api/calendar/subscribe/${token}.ics`,
      download: `${protocol}://${host}/api/calendar/export/${token}.ics`,
      token,
    },
  });
}

/**
 * Public endpoint for exporting dedicated TODO list as iCalendar / webcal subscription
 */
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

  const user = db.prepare('SELECT id, username FROM users WHERE token_secret = ?').get(token) as User | undefined;
  if (!user) {
    res.status(404).send('Invalid or expired subscription link');
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

/**
 * Manually trigger full calendar sync and adaptive task replanning
 */
export async function syncAndReplanAll(req: AuthenticatedRequest, res: Response): Promise<void> {
  const userId = req.user!.id;
  try {
    const syncRes = await syncAllUserSubscriptions(userId);
    const replanRes = replanUserTasks(userId);
    res.json({
      message: `同步与自适应排程完成！`,
      totalEvents: syncRes.totalEvents,
      subscriptionsSynced: syncRes.subscriptionsSynced,
      scheduledCount: replanRes.scheduledCount,
      failedCount: replanRes.failedCount,
      summary: replanRes.summary,
    });
  } catch (err: any) {
    res.status(500).json({ error: `处理失败: ${err.message}` });
  }
}

export function replanAll(req: AuthenticatedRequest, res: Response): void {
  try {
    res.json(replanUserTasks(req.user!.id));
  } catch (error: any) {
    res.status(500).json({ error: error.message || '排程失败' });
  }
}

/**
 * Preview today's calendar PNG card
 */
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

/**
 * Preview Todo list PNG card
 */
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
