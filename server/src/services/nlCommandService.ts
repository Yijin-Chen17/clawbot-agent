import { db } from '../config/database.js';
import type { Task, UserSettings } from '../models/types.js';
import { getUserTimezone } from './accountService.js';
import { parseUserMessageWithLLM } from './llm.js';
import { templates } from './clawbot.js';
import {
  consumeConversationDraft,
  getActiveConversationDraft,
  upsertConversationDraft,
} from './inboxService.js';
import {
  createTaskCommand,
  deleteTaskCommand,
  executeQuickActionCommand,
  ignoreExternalCalendarInstance,
  resolveCommandTarget,
  updateTaskCommand,
} from './taskService.js';
import { createScheduleProposal, resolveScheduleProposal } from './proposalService.js';
import { resolveFixedTaskTime } from './fixedTaskTime.js';
import { completeTaskPart, replanUserTasks, rescheduleSingleTask } from './scheduler.js';
import { ensureTaskInstance, getLatestPlanVersion } from './instanceService.js';
import { queryScheduleForLocalDate, queryTodoSummary, queryUnscheduledTasks } from './scheduleQueryService.js';
import { syncAllUserSubscriptions } from './calendarSync.js';
import { formatInAccountTz, formatTimeInAccountTz, getAccountLocalDateKey } from '../utils/timezone.js';
import { renderTodoListImage, renderWeekCalendarImage } from './cardRenderer.js';
import { addDebugLog } from './debugLogger.js';

export interface ProcessNLCommandParams {
  userId: number;
  channel: 'weixin_ilink' | 'webhook' | 'debug_sim';
  senderId: string;
  content: string;
  settings: UserSettings;
  isFirstActivation?: boolean;
  dryRun?: boolean;
  skipImages?: boolean;
}

export interface ProcessNLCommandResult {
  replyText: string;
  imageBuffer?: Buffer;
  diagnostics?: Record<string, any>;
}

function getHelpMessage(isActivation = false): string {
  const prefix = isActivation
    ? `🎉【微信助手激活成功】\n欢迎使用 Clawbot 智能日程管家！\n外部推送通道已打通。\n\n⚠️ 重要须知：根据微信平台规则，外部机器人仅能在您发送消息后的 24 小时内主动下发提醒；请保持每 24 小时至少向我发送一条消息（如回复“查看日历”），以确保每日规划与任务提醒准时送达。\n\n`
    : `📖【Clawbot 微信使用指南与指令集】\n\n`;

  return (
    prefix +
    `📅【查询日程与日历】\n` +
    `• 发送“查看日历”/“日历”/“周日历”：获取完整周 24小时亮色日程网格图（含已排期/未排期汇总）\n` +
    `• 发送“查看任务”/“待办清单”/“todo”：查看待办事项清单图\n` +
    `• 发送“重新排程”/“全部重排”：按最新紧急度与时间自动重排全部可移动日程\n` +
    `• 单次再排期：发送“把 [名称] 改期到明天下午”、“[名称] 换个时间”或“把 [名称] 排到明天10点”\n\n` +
    `✏️【智能添加任务】\n` +
    `• 常规任务：如“明天下午写代码2小时，重要且紧急，周三前交”\n` +
    `• 灵活任务：如“整理桌面1小时”（无需指定截止日期）\n` +
    `• 固定任务：如“安排固定任务 明天下午2点到4点部门开会”\n` +
    `• 双线程任务：如“安排双线程任务 听英文播客1小时”\n\n` +
    `🔄【任务修改、进度与删除】\n` +
    `• 删除/忽略：发送“删除任务 开会”或“删掉下午的会议”\n` +
    `• 修改：发送“把周报时长改成1小时”\n` +
    `• 状态：发送“开始 [名称]”、“完成 [名称]”、“完成第1段 [名称]”、“取消 [名称]”、“停止每日 [名称]”\n` +
    `• 延长时长：发送“时间不够，延半小时”\n\n` +
    `💡 提示：随时回复“help”或“帮助”可重新查看本指令清单。`
  );
}

function findRecentReminderTarget(userId: number): { instanceId: number; blockId: string; taskId: number; title: string } | null {
  const cutoffIso = new Date(Date.now() - 60 * 60_000).toISOString();
  const row = db.prepare(`
    SELECT no.instance_id, no.block_id, ti.task_id, t.title
    FROM notification_outbox no
    JOIN task_instances ti ON ti.id = no.instance_id
    JOIN tasks t ON t.id = ti.task_id
    WHERE no.user_id = ?
      AND no.status = 'sent'
      AND no.updated_at >= ?
      AND ti.status IN ('pending', 'in_progress')
    ORDER BY no.id DESC
    LIMIT 1
  `).get(userId, cutoffIso) as any;

  return row ? { instanceId: row.instance_id, blockId: row.block_id, taskId: row.task_id, title: row.title } : null;
}

function formatTaskScheduleReply(task: Task, tz: string, extraReason?: string | null): string {
  if (!task.scheduled_start || !task.scheduled_end) {
    return templates.scheduleFailed(task.title, task.duration_minutes, extraReason || '暂未找到合适空闲时段');
  }
  let blocks: any[] = [];
  if (task.schedule_blocks) {
    try {
      blocks = JSON.parse(task.schedule_blocks);
    } catch {}
  }
  const sStr = formatInAccountTz(task.scheduled_start, tz);
  const eStr = formatTimeInAccountTz(task.scheduled_end, tz);
  return templates.scheduleSuccess({
    title: task.title,
    startStr: sStr,
    endStr: eStr,
    duration: task.duration_minutes,
    urgency: task.urgency,
    importance: task.importance,
    blocks,
    isFixed: Boolean(task.is_fixed),
    isConcurrent: Boolean(task.is_concurrent),
    timezone: tz,
  });
}

function formatAmbiguousCandidates(candidates: Array<{ id: number; type: string; title: string; date?: string }>): string {
  const lines = candidates.map((c, idx) => {
    const typeLabel = c.type === 'calendar_event' ? '外部日程' : '待办';
    const dateLabel = c.date ? ` (${c.date})` : '';
    return `${idx + 1}. [${typeLabel}] ${c.title}${dateLabel} (ID:${c.id})`;
  });
  return `🔍 找到多个匹配项，请说明更具体的名称、日期或 ID：\n` + lines.join('\n');
}

/**
 * 统一自然语言命令处理管线（M01–M08, A08）：
 * - 扫码微信与 Webhook 共用完全一致的草稿、解析、消歧、校验与回执渲染
 * - 支持 dryRun 演练隔离，不污染真实任务、余额与激活状态
 */
export async function processNaturalLanguageCommand(params: ProcessNLCommandParams): Promise<ProcessNLCommandResult> {
  const { userId, channel, senderId, content, settings, isFirstActivation = false, dryRun = false, skipImages = false } = params;
  const tz = getUserTimezone(userId);
  const threadKey = `${channel}:${senderId || 'default'}`;
  const trimmed = content.trim();

  if (!trimmed) {
    return { replyText: '收到空消息，可回复“帮助”查看指令。', diagnostics: { intent: 'empty' } };
  }

  const lowerTrimmed = trimmed.toLowerCase();

  // Help / explicit greeting on activation
  if (
    lowerTrimmed === 'help' ||
    trimmed === '帮助' ||
    trimmed === '查看帮助' ||
    trimmed === '指令' ||
    trimmed === '指令集' ||
    trimmed === '使用指南' ||
    trimmed === '使用方法' ||
    trimmed === '菜单' ||
    lowerTrimmed === '/help' ||
    (isFirstActivation && /^(你好|hi|hello|在吗|开始)$/i.test(lowerTrimmed))
  ) {
    return {
      replyText: getHelpMessage(isFirstActivation),
      diagnostics: { intent: isFirstActivation ? 'activation_help' : 'help' },
    };
  }

  const activationBanner = isFirstActivation ? '🎉 微信助手已激活！以后每 24 小时发送任意消息即可保持主动提醒畅通。\n\n' : '';
  const withBanner = (res: ProcessNLCommandResult): ProcessNLCommandResult =>
    activationBanner ? { ...res, replyText: activationBanner + res.replyText } : res;

  // Quick deterministic triggers (only in non-dryRun or read-only safe)
  if (
    trimmed === '查看日历' ||
    trimmed === '日历' ||
    trimmed === '今日日历' ||
    trimmed === '周日历' ||
    trimmed === '查看周日历' ||
    trimmed === '本周日历' ||
    trimmed === '本周日程' ||
    trimmed === '一周日程' ||
    trimmed.includes('查看日历') ||
    trimmed.includes('周日历')
  ) {
    let syncInfo = '';
    let unscheduledHint = '';
    if (!dryRun) {
      const syncRes = await syncAllUserSubscriptions(userId);
      replanUserTasks(userId, { triggerSource: 'weixin_view_calendar' });
      const todoSummary = queryTodoSummary(userId, 20);
      const scheduledTotal = todoSummary.counts.scheduled + todoSummary.counts.inProgress;
      const unscheduledTotal = todoSummary.counts.pendingSlot;
      syncInfo = `（外部日程 ${syncRes.totalEvents} 项 · 已排期 ${scheduledTotal} 项 · 未排期 ${unscheduledTotal} 项）`;
      if (unscheduledTotal > 0) {
        const unscheduledList = queryUnscheduledTasks(userId, 5);
        if (unscheduledList.length > 0) {
          unscheduledHint = `\n⏳ 未排期任务：${unscheduledList.map(t => `${t.title}(${t.duration_minutes}m)`).join('、')}${unscheduledTotal > unscheduledList.length ? ' 等' : ''}`;
        }
      }
    }
    let imageBuffer: Buffer | undefined;
    if (!skipImages && channel === 'weixin_ilink') {
      try {
        imageBuffer = await renderWeekCalendarImage(userId);
      } catch {}
    }
    return withBanner({
      replyText: `📅 日历已更新${syncInfo}` + (imageBuffer ? ' 👇' : '') + unscheduledHint,
      imageBuffer,
      diagnostics: { intent: 'view_calendar', dryRun },
    });
  }

  if (
    trimmed === '查看任务' ||
    trimmed === '任务' ||
    trimmed === '我的待办' ||
    trimmed === '待办清单' ||
    trimmed === '任务清单' ||
    lowerTrimmed === 'todo' ||
    lowerTrimmed === 'todolist' ||
    lowerTrimmed === 'tudo' ||
    trimmed.includes('查看任务') ||
    trimmed.includes('待办清单')
  ) {
    const summary = queryTodoSummary(userId, 12);
    let imageBuffer: Buffer | undefined;
    if (!skipImages && channel === 'weixin_ilink') {
      try {
        imageBuffer = await renderTodoListImage(userId);
      } catch {}
    }
    return withBanner({
      replyText: `📝 待办任务清单 (共 ${summary.counts.total} 项：已排期 ${summary.counts.scheduled + summary.counts.inProgress} / 未排期 ${summary.counts.pendingSlot} / 已完成 ${summary.counts.completed})` + (imageBuffer ? ' 👇' : ''),
      imageBuffer,
      diagnostics: { intent: 'view_todos', counts: summary.counts },
    });
  }

  const GLOBAL_REPLAN_EXACT = new Set([
    '重新规划',
    '重新排程',
    '重新排期',
    '全部重排',
    '重排全部',
    '全部重新排程',
    '全部重新排期',
    '刷新排程',
    '更新日历',
    '智能排程',
  ]);

  if (GLOBAL_REPLAN_EXACT.has(trimmed)) {
    if (dryRun) {
      return withBanner({
        replyText: '🔄 [演练模式] 已模拟触发全局重新排程（未修改生产数据）。',
        diagnostics: { intent: 'replan', dryRun: true },
      });
    }
    await syncAllUserSubscriptions(userId);
    const replanRes = replanUserTasks(userId, { triggerSource: 'nl_replan' });
    const todoSummary = queryTodoSummary(userId, 20);
    let imageBuffer: Buffer | undefined;
    if (!skipImages && channel === 'weixin_ilink') {
      try {
        imageBuffer = await renderWeekCalendarImage(userId);
      } catch {}
    }
    return withBanner({
      replyText: `🔄 ${replanRes.summary}（当前已排期 ${todoSummary.counts.scheduled + todoSummary.counts.inProgress} 项 · 未排期 ${todoSummary.counts.pendingSlot} 项）` + (imageBuffer ? ' 👇' : ''),
      imageBuffer,
      diagnostics: { intent: 'replan', replanRes },
    });
  }

  // Load isolated conversation draft (M04)
  const draft = dryRun ? null : getActiveConversationDraft(userId, channel, threadKey);
  let draftPayload: any = null;
  if (draft) {
    try {
      draftPayload = JSON.parse(draft.draft_json);
    } catch {
      draftPayload = null;
    }
  }

  // Fast confirm/reject when a proposal draft is active
  const fastConfirm = /^(确认|好的|好|是|是的|同意|改|修改|调整|同步修改|可以|行|行啊|没问题|ok|yes|y)$/i.test(lowerTrimmed);
  const fastReject = /^(保持|不改|不要|不|否|不是|不用|算了|取消|维持原样|维持|原样|不调整|不用调|no|n)$/i.test(lowerTrimmed);

  if (draft && draft.intent === 'confirm_schedule_swap' && draftPayload?.proposalId && (fastConfirm || fastReject)) {
    const decision = fastConfirm ? 'accept' : 'reject';
    const res = resolveScheduleProposal({
      userId,
      proposalId: draftPayload.proposalId,
      decision,
    });
    if (res.status === 'recomputed' && res.newProposal) {
      upsertConversationDraft({
        userId,
        channel,
        threadKey,
        intent: 'confirm_schedule_swap',
        draftData: { proposalId: res.newProposal.proposalId, newTaskTitle: draftPayload.newTaskTitle, proposal: res.newProposal },
        ttlMinutes: 15,
      });
    } else {
      consumeConversationDraft(userId, channel, threadKey, draft.version);
    }
    return withBanner({
      replyText: res.message,
      diagnostics: { intent: 'confirm_schedule_swap', resolution: res },
    });
  }

  // Call LLM parser (passes dryRun so admin simulator does not deduct user balance)
  const parsed = await parseUserMessageWithLLM(trimmed, settings, draftPayload, { dryRun });

  // Handle active swap proposal via LLM decision
  if (draft && draft.intent === 'confirm_schedule_swap' && draftPayload?.proposalId) {
    if (parsed.swap_decision === 'confirm' || parsed.swap_decision === 'reject') {
      const res = resolveScheduleProposal({
        userId,
        proposalId: draftPayload.proposalId,
        decision: parsed.swap_decision === 'confirm' ? 'accept' : 'reject',
      });
      if (res.status === 'recomputed' && res.newProposal) {
        upsertConversationDraft({
          userId,
          channel,
          threadKey,
          intent: 'confirm_schedule_swap',
          draftData: { proposalId: res.newProposal.proposalId, newTaskTitle: draftPayload.newTaskTitle, proposal: res.newProposal },
          ttlMinutes: 15,
        });
      } else {
        consumeConversationDraft(userId, channel, threadKey, draft.version);
      }
      return withBanner({
        replyText: res.message,
        diagnostics: { intent: 'confirm_schedule_swap', resolution: res, parsed },
      });
    } else {
      // User switched to a new command -> consume stale swap draft and execute new intent
      consumeConversationDraft(userId, channel, threadKey, draft.version);
    }
  }

  if (dryRun) {
    return withBanner({
      replyText: `🧪 [演练模式 · 未写入生产库] 识别意图：${parsed.intent}，标题：${parsed.title || parsed.target_task_name || '-'}`,
      diagnostics: { dryRun: true, intent: parsed.intent, parsed },
    });
  }

  // ==================== Intent Dispatch ====================

  if (parsed.intent === 'query_schedule') {
    const queryDate = parsed.target_date || getAccountLocalDateKey(new Date(), tz);
    const data = queryScheduleForLocalDate(userId, queryDate);
    const lines: string[] = [];

    for (const ev of data.externalEvents) {
      const s = formatTimeInAccountTz(ev.start, tz);
      const e = formatTimeInAccountTz(ev.end, tz);
      lines.push(`• [外部] [${s}-${e}] ${ev.title}`);
    }
    for (const b of data.blocks) {
      const s = formatTimeInAccountTz(b.start, tz);
      const e = formatTimeInAccountTz(b.end, tz);
      const icon = b.blockStatus === 'completed' ? '✅' : b.blockStatus === 'in_progress' ? '▶️' : b.blockStatus === 'conflict' ? '⚠️' : '📌';
      const partSuffix = b.totalParts > 1 ? ` (${b.partIndex}/${b.totalParts}节)` : '';
      lines.push(`• ${icon} [${s}-${e}] ${b.title}${partSuffix} (${b.durationMinutes}m)`);
    }

    const unscheduledList = queryUnscheduledTasks(userId, 5);
    const unscheduledText =
      unscheduledList.length > 0
        ? `\n\n⏳ 未排期任务 (${unscheduledList.length} 项)：\n` +
          unscheduledList.map(t => `• ${t.title} (${t.duration_minutes}m)`).join('\n') +
          `\n💡 回复“把 [任务名称] 排期”可单独安排时段`
        : '';

    const replyText =
      (lines.length > 0
        ? `📅 ${queryDate} 已排期日程：\n` + lines.join('\n')
        : `📅 ${queryDate} 暂无外部日程或已排期任务`) + unscheduledText;

    let imageBuffer: Buffer | undefined;
    if (!skipImages && channel === 'weixin_ilink') {
      try {
        imageBuffer = await renderWeekCalendarImage(userId);
      } catch {}
    }
    return withBanner({
      replyText: replyText + (imageBuffer ? ' 👇' : ''),
      imageBuffer,
      diagnostics: { intent: 'query_schedule', date: queryDate, blockCount: data.blocks.length, extCount: data.externalEvents.length },
    });
  }

  if (parsed.intent === 'status_update') {
    if (draft) consumeConversationDraft(userId, channel, threadKey, draft.version);
    const action = parsed.status_action || 'complete';

    // Global replan via natural language when no target task/time/date is specified and no recent reminder context
    if (
      action === 'reschedule' &&
      !parsed.target_task_name &&
      !parsed.target_date &&
      !parsed.target_start &&
      !parsed.fixed_start &&
      !parsed.reschedule_mode &&
      !findRecentReminderTarget(userId)
    ) {
      await syncAllUserSubscriptions(userId);
      const replanRes = replanUserTasks(userId, { triggerSource: 'nl_global_reschedule' });
      const todoSummary = queryTodoSummary(userId, 20);
      let imageBuffer: Buffer | undefined;
      if (!skipImages && channel === 'weixin_ilink') {
        try {
          imageBuffer = await renderWeekCalendarImage(userId);
        } catch {}
      }
      return withBanner({
        replyText: `🔄 ${replanRes.summary}（当前已排期 ${todoSummary.counts.scheduled + todoSummary.counts.inProgress} 项 · 未排期 ${todoSummary.counts.pendingSlot} 项）` + (imageBuffer ? ' 👇' : ''),
        imageBuffer,
        diagnostics: { intent: 'status_update', action: 'global_reschedule', replanRes },
      });
    }

    let targetTask: Task | undefined;
    let targetInstanceId: number | undefined;
    let targetBlockId: string | undefined;

    if (parsed.target_task_name) {
      const lookupDate = parsed.source_date || (action === 'reschedule' ? undefined : parsed.target_date || undefined);
      const resolved = resolveCommandTarget({
        userId,
        name: parsed.target_task_name,
        type: 'task',
        date: lookupDate,
        includeCompleted: action === 'reopen',
      });
      if (resolved.status === 'ambiguous') {
        return withBanner({
          replyText: formatAmbiguousCandidates(resolved.candidates),
          diagnostics: { intent: 'status_update', ambiguous: resolved.candidates },
        });
      }
      if (resolved.status === 'not_found') {
        return withBanner({
          replyText: `⚠️ ${resolved.message}，请核对任务名称后重试。`,
          diagnostics: { intent: 'status_update', notFound: true },
        });
      }
      if (resolved.status === 'found_task') {
        targetTask = resolved.task;
        targetInstanceId = resolved.instance?.id;
      }
    } else {
      // No explicit name: prefer recent sent reminder context, else single in_progress task
      const recentRem = findRecentReminderTarget(userId);
      if (recentRem) {
        targetTask = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(recentRem.taskId, userId) as Task | undefined;
        targetInstanceId = recentRem.instanceId;
        targetBlockId = recentRem.blockId;
      } else {
        const inProgress = db.prepare(`
          SELECT * FROM tasks WHERE user_id = ? AND status = 'in_progress' ORDER BY scheduled_start ASC
        `).all(userId) as Task[];
        if (inProgress.length === 1) {
          targetTask = inProgress[0];
        } else if (inProgress.length > 1) {
          return withBanner({
            replyText: formatAmbiguousCandidates(
              inProgress.map(t => ({ id: t.id, type: 'task', title: t.title }))
            ),
            diagnostics: { intent: 'status_update', ambiguousCount: inProgress.length },
          });
        }
      }
    }

    if (!targetTask) {
      return withBanner({
        replyText: '⚠️ 未定位到具体任务，请说明任务名称（如“完成 写周报”）。',
        diagnostics: { intent: 'status_update', notFound: true },
      });
    }

    if (action === 'complete_part') {
      const res = completeTaskPart(
        userId,
        targetTask.id,
        parsed.completed_minutes ?? undefined,
        parsed.completed_part_index ?? undefined,
        {
          blockId: parsed.completed_part_index ? undefined : targetBlockId,
          businessDate: parsed.target_date || undefined,
        }
      );
      return withBanner({
        replyText: res.success ? res.message : `⚠️ ${res.message}`,
        diagnostics: { intent: 'status_update', action, res },
      });
    }

    if (action === 'reschedule') {
      const targetStart = parsed.target_start || parsed.fixed_start || undefined;
      const targetEnd = parsed.target_end || parsed.fixed_end || undefined;
      const reschedMode = targetStart
        ? 'specific_time'
        : parsed.target_date
        ? 'specific_date'
        : parsed.reschedule_mode || undefined;
      const bizDate =
        parsed.source_date ||
        (reschedMode !== 'specific_date' && reschedMode !== 'specific_time' ? parsed.target_date || undefined : undefined);

      const res = rescheduleSingleTask({
        userId,
        taskId: targetTask.id,
        instanceId: targetInstanceId,
        blockId: targetBlockId,
        businessDate: bizDate,
        mode: reschedMode,
        targetDate: parsed.target_date || undefined,
        targetTimePeriod: parsed.target_time_period || undefined,
        targetStart,
        targetEnd,
        allowProposal: true,
        unpinFixed: Boolean(targetTask.is_fixed && !targetStart),
        triggerSource: 'nl_single_reschedule',
      });

      if (res.proposal && res.targetInstanceId) {
        const conflictInst = ensureTaskInstance(
          userId,
          res.proposal.conflictTask.id,
          getAccountLocalDateKey(new Date(), tz),
          new Date()
        );
        if (conflictInst) {
          const propRec = createScheduleProposal({
            userId,
            basePlanVersion: getLatestPlanVersion(userId),
            reasonType: res.proposal.type,
            reasonText: res.proposal.reasonText,
            payload: {
              newTaskSpec: {
                title: targetTask.title,
                duration_minutes: targetTask.duration_minutes,
                urgency: targetTask.urgency,
                importance: targetTask.importance,
                time_mode: targetTask.time_mode ?? undefined,
                deadline: targetTask.deadline,
                deadline_kind: targetTask.deadline_kind ?? undefined,
                is_concurrent: Boolean(targetTask.is_concurrent),
              },
              targetTaskId: targetTask.id,
              targetInstanceId: res.targetInstanceId,
              targetInstanceVersion: res.targetInstanceVersion,
              proposal: res.proposal,
              conflictInstanceId: conflictInst.id,
              conflictInstanceVersion: conflictInst.version,
            },
          });

          const propWithId = { ...res.proposal, proposalId: propRec.id };
          upsertConversationDraft({
            userId,
            channel,
            threadKey,
            intent: 'confirm_schedule_swap',
            draftData: {
              proposalId: propRec.id,
              newTaskTitle: targetTask.title,
              proposal: propWithId,
            },
            ttlMinutes: 15,
          });

          const oldS = formatInAccountTz(propWithId.conflictTask.scheduled_start, tz);
          const oldE = formatTimeInAccountTz(propWithId.conflictTask.scheduled_end, tz);
          const confNewS = formatInAccountTz(propWithId.conflictTaskSchedule.start, tz);
          const confNewE = formatTimeInAccountTz(propWithId.conflictTaskSchedule.end, tz);
          const newS = formatInAccountTz(propWithId.newTaskSchedule.start, tz);
          const newE = formatTimeInAccountTz(propWithId.newTaskSchedule.end, tz);

          const replyText =
            `📅【单次再排期 · 冲突调整建议】\n` +
            `将「${targetTask.title}」再排期至 ${newS} ~ ${newE} 时，该时段当前已安排「${propWithId.conflictTask.title}」（原定：${oldS} ~ ${oldE}）。\n\n` +
            `💡 建议同步调整：\n` +
            `• 「${targetTask.title}」改期至：${newS} ~ ${newE}\n` +
            `• 「${propWithId.conflictTask.title}」顺延至：${confNewS} ~ ${confNewE}\n\n` +
            `是否确认同步修改？\n` +
            `👉 回复【确认】或【好】即可同步修改\n` +
            `👉 回复【保持】或【不改】则保持原日程不变`;

          return withBanner({
            replyText,
            diagnostics: { intent: 'status_update', action: 'single_reschedule_proposal', proposal: propWithId },
          });
        }
      }

      if (!res.success) {
        return withBanner({
          replyText: `⚠️ ${res.message}`,
          diagnostics: { intent: 'status_update', action: 'single_reschedule', error: res.message },
        });
      }

      const prevText =
        res.previousSchedule?.start && res.previousSchedule?.end
          ? `\n• 原安排：${formatInAccountTz(res.previousSchedule.start, tz)} ~ ${formatTimeInAccountTz(res.previousSchedule.end, tz)}`
          : '';
      const newBlocks = res.newSchedule?.blocks || [];
      const newText =
        newBlocks.length > 1
          ? `\n• 新安排（共 ${newBlocks.length} 节）：\n` +
            newBlocks
              .map((b, idx) => `  ${idx + 1}. ${formatInAccountTz(b.start, tz)} ~ ${formatTimeInAccountTz(b.end, tz)} (${b.duration}分钟)`)
              .join('\n')
          : res.newSchedule?.start && res.newSchedule?.end
          ? `\n• 新安排：${formatInAccountTz(res.newSchedule.start, tz)} ~ ${formatTimeInAccountTz(res.newSchedule.end, tz)}`
          : '';

      let imageBuffer: Buffer | undefined;
      if (!skipImages && channel === 'weixin_ilink') {
        try {
          imageBuffer = await renderWeekCalendarImage(userId);
        } catch {}
      }

      return withBanner({
        replyText:
          `🔄 已为「${targetTask.title}」完成单次再排期${prevText}${newText}\n• 其余已排定日程保持不变。` +
          (imageBuffer ? ' 👇' : ''),
        imageBuffer,
        diagnostics: { intent: 'status_update', action: 'single_reschedule', res },
      });
    }

    const mappedAction =
      action === 'start'
        ? 'start'
        : action === 'extend'
        ? 'extend'
        : action === 'cancel'
        ? 'cancel'
        : action === 'reopen'
        ? 'reopen'
        : action === 'stop_daily'
        ? 'stop_daily'
        : 'complete';

    const res = executeQuickActionCommand({
      userId,
      taskId: targetTask.id,
      action: mappedAction,
      extendMinutes: parsed.extend_minutes ?? 30,
      businessDate: parsed.target_date || undefined,
    });

    return withBanner({
      replyText: res.success ? res.message : `⚠️ ${res.message}`,
      diagnostics: { intent: 'status_update', action: mappedAction, res, targetInstanceId },
    });
  }

  if (parsed.intent === 'delete_item') {
    if (draft) consumeConversationDraft(userId, channel, threadKey, draft.version);
    const targetName = (
      parsed.delete_target?.name ||
      parsed.title ||
      trimmed.replace(/^(删除|取消|删掉|移除)(任务|日程)?/, '').trim()
    );

    if (!targetName) {
      return withBanner({ replyText: '⚠️ 请说明要删除的任务或日程名称。', diagnostics: { intent: 'delete_item' } });
    }

    const resolved = resolveCommandTarget({
      userId,
      name: targetName,
      type: parsed.delete_target?.type || 'auto',
      date: parsed.delete_target?.date || parsed.target_date || undefined,
      includeCompleted: false,
    });

    if (resolved.status === 'ambiguous') {
      return withBanner({
        replyText: formatAmbiguousCandidates(resolved.candidates),
        diagnostics: { intent: 'delete_item', ambiguous: resolved.candidates },
      });
    }
    if (resolved.status === 'not_found') {
      return withBanner({
        replyText: `⚠️ ${resolved.message}。`,
        diagnostics: { intent: 'delete_item', notFound: true },
      });
    }
    if (resolved.status === 'found_task') {
      const del = deleteTaskCommand(userId, resolved.task.id);
      return withBanner({
        replyText: del.success ? `🗑️ ${del.message}` : `⚠️ ${del.message}`,
        diagnostics: { intent: 'delete_item', deletedTaskId: resolved.task.id },
      });
    }
    const ign = ignoreExternalCalendarInstance(userId, resolved.event.id);
    return withBanner({
      replyText: `🗑️ ${ign.message}`,
      diagnostics: { intent: 'delete_item', ignoredEventId: resolved.event.id },
    });
  }

  if (parsed.intent === 'modify_item') {
    if (draft) consumeConversationDraft(userId, channel, threadKey, draft.version);
    const targetName = parsed.modify_target?.name || parsed.target_task_name || parsed.title || '';
    const resolved = resolveCommandTarget({
      userId,
      name: targetName,
      type: 'task',
      date: parsed.target_date || undefined,
    });

    if (resolved.status === 'ambiguous') {
      return withBanner({
        replyText: formatAmbiguousCandidates(resolved.candidates),
        diagnostics: { intent: 'modify_item', ambiguous: resolved.candidates },
      });
    }
    if (resolved.status !== 'found_task') {
      return withBanner({
        replyText: `⚠️ 未找到待修改的任务「${targetName}」。您可发送“查看任务”核对现有名称。`,
        diagnostics: { intent: 'modify_item', notFound: true },
      });
    }

    const mod = parsed.modify_target || {};
    const updatePayload: Record<string, any> = {};
    if (mod.new_title) updatePayload.title = mod.new_title;
    if (mod.new_duration_minutes) updatePayload.duration_minutes = mod.new_duration_minutes;
    if (mod.new_deadline) updatePayload.deadline = mod.new_deadline;
    if (mod.deadline_kind) updatePayload.deadline_kind = mod.deadline_kind;
    if (mod.is_fixed !== undefined && mod.is_fixed !== null) updatePayload.is_fixed = mod.is_fixed;
    if (mod.is_concurrent !== undefined && mod.is_concurrent !== null) updatePayload.is_concurrent = mod.is_concurrent;
    if (mod.tags) updatePayload.tags = mod.tags;
    if (mod.notes !== undefined) updatePayload.notes = mod.notes;
    if (parsed.time_mode) updatePayload.time_mode = parsed.time_mode;
    if (parsed.recurrence_rule !== undefined && parsed.recurrence_rule !== null) {
      updatePayload.recurrence_rule = parsed.recurrence_rule;
    }
    if (mod.new_start) {
      updatePayload.scheduled_start = mod.new_start;
      updatePayload.is_fixed = true;
    }
    if (mod.new_end) {
      updatePayload.scheduled_end = mod.new_end;
      updatePayload.is_fixed = true;
    }
    if (parsed.fixed_start && !updatePayload.scheduled_start) {
      updatePayload.scheduled_start = parsed.fixed_start;
      updatePayload.is_fixed = true;
    }
    if (parsed.fixed_end && !updatePayload.scheduled_end) {
      updatePayload.scheduled_end = parsed.fixed_end;
      updatePayload.is_fixed = true;
    }

    if (Object.keys(updatePayload).length === 0) {
      return withBanner({
        replyText: `💡 已识别到任务「${resolved.task.title}」，但未检测到具体修改内容（请说明新时间、新时长或截止日期等）。`,
        diagnostics: { intent: 'modify_item', noChanges: true },
      });
    }

    const upd = await updateTaskCommand({
      userId,
      taskId: resolved.task.id,
      rawInput: updatePayload,
    });

    if (!upd.success) {
      return withBanner({
        replyText: `⚠️ 修改失败：${upd.message}`,
        diagnostics: { intent: 'modify_item', error: upd.message },
      });
    }

    return withBanner({
      replyText: upd.task ? `✏️ 已更新：\n${formatTaskScheduleReply(upd.task, tz, upd.instance?.plan_reason)}` : `✏️ ${upd.message}`,
      diagnostics: { intent: 'modify_item', updatedTask: upd.task },
    });
  }

  if (parsed.intent === 'create_task') {
    const prevDraft = draft && draft.intent === 'create_task' ? draftPayload || {} : {};
    const title = parsed.title || prevDraft.title || '';
    if (!title) {
      return withBanner({
        replyText: '📝 请告诉我需要安排的任务名称、预计耗时等信息。',
        diagnostics: { intent: 'create_task', missingTitle: true },
      });
    }

    const fixedTime = resolveFixedTaskTime(parsed, prevDraft);
    const rawDuration =
      fixedTime.duration ||
      parsed.duration_minutes ||
      parsed.estimatedMinutes ||
      prevDraft.duration_minutes ||
      null;
    const deadline = parsed.deadline || parsed.dueDate || prevDraft.deadline || null;
    const deadlineKind = parsed.deadline_kind || prevDraft.deadline_kind || 'soft';
    const timeMode =
      parsed.time_mode ||
      prevDraft.time_mode ||
      (deadline ? 'deadline' : 'flexible');

    const wantsFixed = Boolean(parsed.is_fixed || prevDraft.is_fixed || fixedTime.fixed || parsed.fixed_start);
    const missing = {
      fixed_start: wantsFixed && !fixedTime.start && !parsed.fixed_start && !prevDraft.fixed_start,
      fixed_end: wantsFixed && Boolean(fixedTime.start || parsed.fixed_start || prevDraft.fixed_start) && !fixedTime.end,
      duration: !wantsFixed && (!rawDuration || rawDuration <= 0),
      deadline: false, // Flexible tasks are valid without a deadline (M03)
      urgency: false,
      importance: false,
    };

    const hasMissing = missing.fixed_start || missing.fixed_end || missing.duration;

    const mergedDraft = {
      title,
      notes: parsed.description ?? prevDraft.notes ?? null,
      duration_minutes: rawDuration,
      deadline,
      deadline_kind: deadlineKind,
      time_mode: timeMode,
      recurrence_rule: parsed.recurrence_rule ?? prevDraft.recurrence_rule ?? null,
      importance: parsed.importance ?? prevDraft.importance ?? null,
      importance_tier: parsed.importance_tier ?? prevDraft.importance_tier ?? null,
      impact_signals: parsed.impact_signals ?? prevDraft.impact_signals ?? [],
      urgency: parsed.urgency ?? prevDraft.urgency ?? null,
      urgency_pace: parsed.urgency_pace ?? prevDraft.urgency_pace ?? 'soon',
      tags: parsed.tags ?? prevDraft.tags ?? [],
      is_fixed: wantsFixed,
      fixed_start: fixedTime.start || parsed.fixed_start || prevDraft.fixed_start || null,
      fixed_end: fixedTime.end || parsed.fixed_end || prevDraft.fixed_end || null,
      is_concurrent: parsed.is_concurrent ?? prevDraft.is_concurrent ?? false,
    };

    if (hasMissing) {
      upsertConversationDraft({
        userId,
        channel,
        threadKey,
        intent: 'create_task',
        draftData: mergedDraft,
        missingFields: missing,
        ttlMinutes: 30,
      });
      return withBanner({
        replyText: templates.askMissingFields(title, missing),
        diagnostics: { intent: 'create_task', missing, mergedDraft },
      });
    }

    const createRes = await createTaskCommand({
      userId,
      rawInput: {
        title: mergedDraft.title,
        notes: mergedDraft.notes,
        duration_minutes: mergedDraft.duration_minutes,
        deadline: mergedDraft.deadline,
        deadline_kind: mergedDraft.deadline_kind,
        time_mode: mergedDraft.time_mode,
        recurrence_rule: mergedDraft.recurrence_rule,
        importance: mergedDraft.importance,
        importance_tier: mergedDraft.importance_tier,
        impact_signals: mergedDraft.impact_signals,
        urgency: mergedDraft.urgency,
        urgency_pace: mergedDraft.urgency_pace,
        tags: mergedDraft.tags,
        is_fixed: mergedDraft.is_fixed,
        scheduled_start: mergedDraft.fixed_start,
        scheduled_end: mergedDraft.fixed_end,
        is_concurrent: mergedDraft.is_concurrent,
        auto_schedule: true,
      },
      allowProposal: true,
    });

    if (!createRes.success) {
      return withBanner({
        replyText: `⚠️ 创建失败：${createRes.message}`,
        diagnostics: { intent: 'create_task', error: createRes.message },
      });
    }

    // Only consume draft AFTER business write or proposal persistence succeeded (M04)
    if (draft) {
      consumeConversationDraft(userId, channel, threadKey, draft.version);
    }

    if (createRes.proposal) {
      const prop = createRes.proposal;
      upsertConversationDraft({
        userId,
        channel,
        threadKey,
        intent: 'confirm_schedule_swap',
        draftData: {
          proposalId: prop.proposalId,
          newTaskTitle: title,
          proposal: prop,
        },
        ttlMinutes: 15,
      });

      const oldS = formatInAccountTz(prop.conflictTask.scheduled_start, tz);
      const oldE = formatTimeInAccountTz(prop.conflictTask.scheduled_end, tz);
      const confNewS = formatInAccountTz(prop.conflictTaskSchedule.start, tz);
      const confNewE = formatTimeInAccountTz(prop.conflictTaskSchedule.end, tz);
      const newS = formatInAccountTz(prop.newTaskSchedule.start, tz);
      const newE = formatTimeInAccountTz(prop.newTaskSchedule.end, tz);

      const replyText =
        `📅【日程调整建议】\n` +
        `新待办「${title}」${prop.reasonText}。\n` +
        `该时段当前已安排「${prop.conflictTask.title}」（原定：${oldS} ~ ${oldE}）。\n\n` +
        `💡 建议调整方案：\n` +
        `• 为「${title}」排入：${newS} ~ ${newE}\n` +
        `• 将「${prop.conflictTask.title}」同步修改至：${confNewS} ~ ${confNewE}\n\n` +
        `是否确认同步修改？\n` +
        `👉 回复【确认】或【好】即可同步修改\n` +
        `👉 回复【保持】或【不改】则保持原日程不变`;

      return withBanner({
        replyText,
        diagnostics: { intent: 'create_task', proposal: prop },
      });
    }

    const reply = createRes.task
      ? formatTaskScheduleReply(createRes.task, tz, createRes.instance?.plan_reason)
      : createRes.message;

    return withBanner({
      replyText: reply,
      diagnostics: { intent: 'create_task', taskId: createRes.task?.id, planVersion: createRes.planVersion },
    });
  }

  addDebugLog('Weixin', 'info', `[用户 #${userId}] 未匹配明确指令: "${trimmed}"`);
  return withBanner({
    replyText:
      `💡 未识别到具体日程或任务操作。您可以这样说：\n` +
      `• "明天写代码2小时" / "整理桌面1小时"\n` +
      `• "看看今天的日程" / "查看任务"\n` +
      `• "把写代码改期到明天下午" / "写代码换个时间"\n` +
      `• "完成 写代码" / "延长半小时"\n` +
      `回复“帮助”查看全部指令。`,
    diagnostics: { intent: 'other', parsed },
  });
}
