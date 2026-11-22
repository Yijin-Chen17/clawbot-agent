import { resolveFixedTaskTime } from '../services/fixedTaskTime.js';
import { Request, Response } from 'express';
import { db } from '../config/database.js';
import { UserSettings, Task, ConversationState } from '../models/types.js';
import { parseUserMessageWithLLM } from '../services/llm.js';
import { scheduleTask, computeTodayBusyMinutes, replanUserTasks } from '../services/scheduler.js';
import { templates, sendClawbotMessage } from '../services/clawbot.js';
import {
  calculateDynamicImportance,
  calculateDynamicUrgency,
  inferTierFromScore,
  normalizeScoreTo100,
  type ImpactSignal,
  type TimeMode,
} from '../utils/priorityAlgorithm.js';

export async function handleClawbotWebhook(req: Request, res: Response): Promise<void> {
  const { token } = req.params;

  if (!token) {
    res.status(401).json({ error: '缺少 Webhook Token' });
    return;
  }

  // 1. Locate user by webhook token
  const settings = db.prepare('SELECT * FROM user_settings WHERE clawbot_webhook_token = ?').get(token) as UserSettings | undefined;
  if (!settings) {
    res.status(401).json({ error: '无效的 Webhook Token' });
    return;
  }

  const userId = settings.user_id;

  // 2. Extract content from payload
  const body = req.body || {};
  const content = (body.content || body.text || body.message || body.msg || '').toString().trim();
  const fromWxid = body.fromUser || body.wxid || body.from || body.sender;

  // Auto-record user wxid if provided and not yet set
  if (fromWxid && !settings.clawbot_to_wxid) {
    db.prepare('UPDATE user_settings SET clawbot_to_wxid = ? WHERE user_id = ?').run(fromWxid, userId);
    settings.clawbot_to_wxid = fromWxid;
  }

  if (!content) {
    res.json({ reply: '收到空消息' });
    return;
  }

  // 3. Check for existing multi-turn pending state
  const existingConv = db.prepare('SELECT * FROM conversation_states WHERE user_id = ?').get(userId) as ConversationState | undefined;
  let pendingTask: any = null;
  if (existingConv && existingConv.pending_task_json) {
    try {
      pendingTask = JSON.parse(existingConv.pending_task_json);
    } catch {
      pendingTask = null;
    }
  }

  let replyText = '';

  try {
    // 4. LLM parses the user message into structured fields
    const parsed = await parseUserMessageWithLLM(content, settings, pendingTask);
    console.log(`[Webhook] User #${userId} LLM parsed result:`, parsed);

    // 5. State Machine Handling
    if (parsed.intent === 'status_update') {
      // Clear pending conversation state if user switched to status reporting
      db.prepare('DELETE FROM conversation_states WHERE user_id = ?').run(userId);

      const action = parsed.status_action || 'complete';

      // Find nearest active or recent task
      const activeTask = db.prepare(`
        SELECT * FROM tasks
        WHERE user_id = ? AND status IN ('scheduled', 'in_progress')
        ORDER BY CASE status WHEN 'in_progress' THEN 1 ELSE 2 END, scheduled_start ASC
        LIMIT 1
      `).get(userId) as Task | undefined;

      if (!activeTask) {
        replyText = '💡 当前没有正在进行或排程中的待办任务，无需更新状态。';
      } else if (action === 'complete') {
        db.prepare(`
          UPDATE tasks
          SET status = 'completed', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(activeTask.id);
        replyText = templates.taskCompleted(activeTask.title);
      } else if (action === 'extend') {
        const extMin = parsed.extend_minutes || 30;
        const currentEnd = new Date(activeTask.scheduled_end || new Date());
        const newEnd = new Date(currentEnd.getTime() + extMin * 60 * 1000);
        const newEndStr = newEnd.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

        db.prepare(`
          UPDATE tasks
          SET
            scheduled_end = ?,
            duration_minutes = duration_minutes + ?,
            end_reminder_sent = 0,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(newEnd.toISOString(), extMin, activeTask.id);

        replyText = templates.taskExtended(activeTask.title, extMin, newEndStr);
      } else if (action === 'reschedule') {
        const plan = scheduleTask(userId, {
          id: activeTask.id,
          title: activeTask.title,
          duration_minutes: activeTask.duration_minutes,
          urgency: activeTask.urgency,
          importance: activeTask.importance,
          deadline: activeTask.deadline,
        });

        if (plan.success && plan.scheduled_start && plan.scheduled_end) {
          db.prepare(`
            UPDATE tasks
            SET
              scheduled_start = ?,
              scheduled_end = ?,
              schedule_blocks = ?,
              status = 'scheduled',
              start_reminder_sent = 0,
              end_reminder_sent = 0,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(plan.scheduled_start, plan.scheduled_end, plan.schedule_blocks || null, activeTask.id);
          replanUserTasks(userId);

          const sStr = new Date(plan.scheduled_start).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
          const eStr = new Date(plan.scheduled_end).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
          replyText = templates.taskRescheduled(activeTask.title, sStr, eStr);
        } else {
          replyText = `⚠️ 重新安排失败：${plan.message}`;
        }
      }
    } else if (parsed.intent === 'query_schedule') {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);

      const todayTasks = db.prepare(`
        SELECT * FROM tasks
        WHERE user_id = ?
          AND scheduled_start >= ?
          AND scheduled_start <= ?
        ORDER BY scheduled_start ASC
      `).all(userId, todayStart.toISOString(), todayEnd.toISOString()) as Task[];

      const todayStr = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
      replyText = templates.scheduleQueryList(todayTasks, todayStr);
    } else if (parsed.intent === 'create_task') {
      // Merge with pending task if present
      const title = parsed.title || pendingTask?.title || '未命名任务';
      const fixedTime = resolveFixedTaskTime(parsed, pendingTask || {});
      const duration = fixedTime.duration || parsed.duration_minutes || parsed.estimatedMinutes || pendingTask?.duration_minutes || null;
      const deadline = parsed.deadline || pendingTask?.deadline || null;
      const timeMode: TimeMode =
        parsed.time_mode || pendingTask?.time_mode || (deadline ? 'deadline' : 'flexible');
      const impactSignals = (parsed.impact_signals || pendingTask?.impact_signals || []) as ImpactSignal[];

      let importance: number | null =
        parsed.importance !== undefined && parsed.importance !== null
          ? normalizeScoreTo100(parsed.importance, parsed.importance <= 10 ? 10 : 100)
          : pendingTask?.importance !== undefined && pendingTask?.importance !== null
          ? normalizeScoreTo100(pendingTask.importance, pendingTask.importance <= 10 ? 10 : 100)
          : null;

      if (parsed.importance_tier) {
        importance = calculateDynamicImportance({
          tier: parsed.importance_tier,
          estimatedMinutes: duration || 60,
          impactSignals,
          isFixed: Boolean(parsed.is_fixed),
        }).importance;
      }

      const importanceTier = parsed.importance_tier || (importance !== null ? inferTierFromScore(importance) : 'support');
      const rawUrgency =
        parsed.urgency !== undefined && parsed.urgency !== null
          ? normalizeScoreTo100(parsed.urgency, parsed.urgency <= 10 ? 10 : 100)
          : pendingTask?.urgency !== undefined && pendingTask?.urgency !== null
          ? normalizeScoreTo100(pendingTask.urgency, pendingTask.urgency <= 10 ? 10 : 100)
          : null;

      const urgency =
        deadline || timeMode === 'daily_fixed'
          ? calculateDynamicUrgency({
              timeMode,
              dueDate: deadline,
              estimatedMinutes: duration || 60,
              importance: importance ?? 58,
              dailyBusyMinutesAhead: computeTodayBusyMinutes(userId),
              fallbackUrgency: rawUrgency ?? 50,
            }).urgency
          : rawUrgency;

      const merged = {
        title,
        duration_minutes: duration,
        urgency,
        importance,
        importance_tier: importanceTier,
        impact_signals: impactSignals,
        time_mode: timeMode,
        deadline,
        is_fixed: fixedTime.fixed, fixed_start: fixedTime.start, fixed_end: fixedTime.end,
      };

      // Check missing fields
      const missing = {
        duration: !duration || duration <= 0,
        deadline: !deadline && timeMode !== 'daily_fixed' && !fixedTime.fixed,
        urgency: false,
        importance: importance === null,
      };

      const hasMissing = missing.duration || missing.deadline || missing.importance || (fixedTime.fixed && !fixedTime.end);

      if (hasMissing) {
        // Save pending conversation state
        db.prepare(`
          INSERT INTO conversation_states (user_id, current_intent, pending_task_json, missing_fields, updated_at)
          VALUES (?, 'create_task', ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id) DO UPDATE SET
            pending_task_json = excluded.pending_task_json,
            missing_fields = excluded.missing_fields,
            updated_at = CURRENT_TIMESTAMP
        `).run(userId, JSON.stringify(merged), JSON.stringify(missing));

        replyText = templates.askMissingFields(title, missing);
      } else {
        // All critical fields are available! Run scheduling algorithm!
        db.prepare('DELETE FROM conversation_states WHERE user_id = ?').run(userId);
        const finalUrgency = urgency ?? 55;

        if (fixedTime.fixed && fixedTime.start && fixedTime.end) {
          const blocks = JSON.stringify([{ start: fixedTime.start, end: fixedTime.end, duration }]);
          db.prepare(`INSERT INTO tasks (user_id, title, duration_minutes, original_duration_minutes, urgency, importance,
            importance_tier, impact_signals, time_mode, score_scale, deadline, scheduled_start, scheduled_end, is_fixed, status, schedule_blocks)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 100, ?, ?, ?, 1, 'scheduled', ?)`)
            .run(userId, title, duration, duration, finalUrgency, importance, importanceTier, JSON.stringify(impactSignals), timeMode,
              deadline, fixedTime.start, fixedTime.end, blocks);
          replanUserTasks(userId);
          replyText = `已安排「${title}」：${new Date(fixedTime.start).toLocaleString('zh-CN')}，持续 ${duration} 分钟。`;
        } else {
        const plan = scheduleTask(userId, {
          title,
          duration_minutes: duration!,
          urgency: finalUrgency,
          importance: importance!,
          deadline: deadline,
        });

        if (plan.success && plan.scheduled_start && plan.scheduled_end) {
          db.prepare(`
            INSERT INTO tasks (
              user_id, title, duration_minutes, urgency, importance,
              importance_tier, impact_signals, time_mode, score_scale,
              deadline, scheduled_start, scheduled_end, is_fixed, status, schedule_blocks
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 100, ?, ?, ?, 0, 'scheduled', ?)
          `).run(
            userId,
            title,
            duration,
            finalUrgency,
            importance,
            importanceTier,
            JSON.stringify(impactSignals),
            timeMode,
            deadline,
            plan.scheduled_start,
            plan.scheduled_end,
            plan.schedule_blocks || null
          );

          const sStr = new Date(plan.scheduled_start).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
          const eStr = new Date(plan.scheduled_end).toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });

          replyText = templates.scheduleSuccess(title, sStr, eStr, duration!, finalUrgency, importance!);
        } else {
          // Save as pending slot
          db.prepare(`
            INSERT INTO tasks (
              user_id, title, duration_minutes, urgency, importance,
              importance_tier, impact_signals, time_mode, score_scale,
              deadline, status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 100, ?, 'pending_slot')
          `).run(userId, title, duration, finalUrgency, importance, importanceTier, JSON.stringify(impactSignals), timeMode, deadline);

          replyText = templates.scheduleFailed(title, duration!, plan.message);
        }
      }
      }
    } else {
      replyText =
        `🤖【Clawbot 时间管理助手】\n` +
        `收到您的消息！您可以随时对我说：\n` +
        `• "安排明天下午写代码，耗时90分钟，加急5分，周三前交"\n` +
        `• "看看今天的日程"\n` +
        `• "当前任务搞定了 / 提前完成"\n` +
        `• "时间不够，延长半小时"`;
    }
  } catch (err: any) {
    console.error('[Webhook Processing Error]:', err);
    replyText = `⚠️ 助手处理出错：${err.message}\n请检查管理面板中配置的 DeepSeek API Key 是否有效。`;
  }

  // Attempt to push back through Clawbot outbound API
  await sendClawbotMessage(settings, replyText);

  // Also return response directly in HTTP JSON response
  res.json({
    success: true,
    reply: replyText,
  });
}
