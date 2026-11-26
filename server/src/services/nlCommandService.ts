import { db } from '../config/database.js';
import type { LLMExtractionAction, Task, UserSettings } from '../models/types.js';
import { getUserTimezone } from './accountService.js';
import { parseUserMessageWithLLM } from './llm.js';
import { templates } from './clawbot.js';
import {
  appendScopedSessionTurns,
  consumeConversationDraft,
  getActiveConversationDraft,
  upsertConversationDraft,
  type ScopedSessionTurn,
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
import {
  queryScheduleForLocalDate,
  queryTodoSummary,
  queryUnscheduledTasks,
  type UnifiedRangeQueryResult,
} from './scheduleQueryService.js';
import { syncAllUserSubscriptions } from './calendarSync.js';
import {
  formatInAccountTz,
  formatTimeInAccountTz,
  getAccountLocalDateKey,
  zonedWallClockToUtc,
} from '../utils/timezone.js';
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
  imageKind?: 'week_calendar' | 'todo_list';
  diagnostics?: Record<string, any>;
}

interface DisambiguationCandidate {
  index: number;
  id: number;
  type: 'task' | 'calendar_event';
  title: string;
  date?: string;
  status?: string;
}

interface ActionExecutionResult {
  replyText: string;
  imageBuffer?: Buffer;
  imageKind?: 'week_calendar' | 'todo_list';
  openedSession?: boolean;
  diagnostics?: Record<string, any>;
}

const HELP_EXACT = new Set([
  'help',
  '/help',
  '帮助',
  '查看帮助',
  '指令',
  '指令集',
  '使用指南',
  '使用方法',
  '菜单',
]);

const VIEW_CALENDAR_EXACT = new Set([
  '查看日历',
  '日历',
  '看看日历',
  '今日日历',
  '周日历',
  '查看周日历',
  '本周日历',
  '本周日程',
  '一周日程',
  '一周日历',
]);

const VIEW_TODOS_EXACT = new Set([
  '查看任务',
  '任务',
  '我的待办',
  '待办',
  '待办清单',
  '任务清单',
  '查看待办',
  'todo',
  'todolist',
  'tudo',
]);

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

const SESSION_CANCEL_RE = /^(取消操作|取消本次|算了|不用了|不弄了|不改了|不安排了|退出|放弃)$/i;
const FAST_CONFIRM_RE = /^(确认|好的|好|是|是的|同意|改|修改|调整|同步修改|可以|行|行啊|没问题|ok|yes|y)$/i;
const FAST_REJECT_RE = /^(保持|不改|不要|不|否|不是|不用|算了|取消|维持原样|维持|原样|不调整|不用调|no|n)$/i;

function normalizeExactTrigger(text: string): string {
  return text.trim().replace(/[。！？!?.，,]+$/g, '').trim().toLowerCase();
}

function getHelpMessage(isActivation = false): string {
  const prefix = isActivation
    ? `🎉【微信助手激活成功】\n欢迎使用 Clawbot 智能日程管家！\n外部推送通道已打通。\n\n⚠️ 重要须知：根据微信平台规则，外部机器人仅能在您发送消息后的 24 小时内主动下发提醒；请保持每 24 小时至少向我发送一条消息（如回复“查看日历”），以确保每日规划与任务提醒准时送达。\n\n`
    : `📖【Clawbot 微信使用指南与指令集】\n\n`;

  return (
    prefix +
    `📅【查询日程与日历】\n` +
    `• 发送“查看日历”/“周日历”：获取完整周 24小时日程网格图\n` +
    `• 发送“查看任务”/“待办清单”：查看待办事项清单图\n` +
    `• 发送“今天有什么安排”/“明天日程”：查看某天日程及剩余空闲时段\n` +
    `• 发送“重新排程”/“全部重排”：按最新紧急度自动重排全部可移动日程\n` +
    `• 单次再排期：如“把 [名称] 改期到明天下午”或“把 [名称] 排到明天10点”\n\n` +
    `✏️【智能添加任务】\n` +
    `• 常规任务：如“明天下午写代码2小时，重要且紧急，周三前交”\n` +
    `• 灵活任务：如“整理桌面1小时”（无需指定截止日期）\n` +
    `• 固定任务：如“安排固定任务 明天下午2点到4点部门开会”\n` +
    `• 双线程任务：如“安排双线程任务 听英文播客1小时”\n\n` +
    `🔄【任务修改、进度与复合指令】\n` +
    `• 删除/忽略：发送“删除任务 开会”或“忽略今天的班会”\n` +
    `• 修改：发送“把周报时长改成1小时”\n` +
    `• 状态：发送“开始 [名称]”、“完成 [名称]”、“完成第1段 [名称]”、“取消 [名称]”、“停止每日 [名称]”\n` +
    `• 延长时长：发送“时间不够，延半小时”\n` +
    `• 复合操作：如“把开会删掉，再安排明天写周报1小时”\n\n` +
    `💡 提示：多轮追问仅针对当前事务，完成或回复“算了”会自动结束上下文。`
  );
}

type RecentReminderTarget =
  | {
      kind: 'task';
      updatedAt: string;
      instanceId: number;
      blockId: string;
      taskId: number;
      title: string;
    }
  | {
      kind: 'external';
      updatedAt: string;
      eventId: number;
      title: string;
    };

function findRecentReminderTarget(userId: number): RecentReminderTarget | null {
  const cutoffIso = new Date(Date.now() - 60 * 60_000).toISOString();
  const taskRow = db
    .prepare(
      `SELECT no.instance_id, no.block_id, no.updated_at, ti.task_id, t.title
       FROM notification_outbox no
       JOIN task_instances ti ON ti.id = no.instance_id
       JOIN tasks t ON t.id = ti.task_id
       WHERE no.user_id = ?
         AND no.status = 'sent'
         AND no.updated_at >= ?
         AND ti.status IN ('pending', 'in_progress')
       ORDER BY no.id DESC
       LIMIT 1`
    )
    .get(userId, cutoffIso) as any;

  const extRow = db
    .prepare(
      `SELECT eno.updated_at, eno.title, ee.id as event_id
       FROM external_notification_outbox eno
       JOIN external_events ee
         ON ee.user_id = eno.user_id
        AND COALESCE(ee.subscription_id, 0) = eno.subscription_id
        AND COALESCE(ee.uid, 'ext-row-' || ee.id) = eno.event_uid
        AND COALESCE(ee.occurrence_start, ee.start_time) = eno.occurrence_start
       WHERE eno.user_id = ?
         AND eno.status = 'sent'
         AND eno.updated_at >= ?
       ORDER BY eno.id DESC
       LIMIT 1`
    )
    .get(userId, cutoffIso) as any;

  if (taskRow && extRow) {
    return String(extRow.updated_at) > String(taskRow.updated_at)
      ? { kind: 'external', updatedAt: extRow.updated_at, eventId: extRow.event_id, title: extRow.title }
      : {
          kind: 'task',
          updatedAt: taskRow.updated_at,
          instanceId: taskRow.instance_id,
          blockId: taskRow.block_id,
          taskId: taskRow.task_id,
          title: taskRow.title,
        };
  }
  if (taskRow) {
    return {
      kind: 'task',
      updatedAt: taskRow.updated_at,
      instanceId: taskRow.instance_id,
      blockId: taskRow.block_id,
      taskId: taskRow.task_id,
      title: taskRow.title,
    };
  }
  if (extRow) {
    return {
      kind: 'external',
      updatedAt: extRow.updated_at,
      eventId: extRow.event_id,
      title: extRow.title,
    };
  }
  return null;
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

function formatProposalConfirmReply(params: {
  newTaskTitle: string;
  proposal: any;
  tz: string;
  mode: 'create' | 'reschedule' | 'recomputed';
  reasonNotice?: string;
}): string {
  const { newTaskTitle, proposal, tz, mode, reasonNotice } = params;
  const oldS = formatInAccountTz(proposal.conflictTask.scheduled_start, tz);
  const oldE = formatTimeInAccountTz(proposal.conflictTask.scheduled_end, tz);
  const confNewS = formatInAccountTz(proposal.conflictTaskSchedule.start, tz);
  const confNewE = formatTimeInAccountTz(proposal.conflictTaskSchedule.end, tz);
  const newS = formatInAccountTz(proposal.newTaskSchedule.start, tz);
  const newE = formatTimeInAccountTz(proposal.newTaskSchedule.end, tz);

  if (mode === 'reschedule') {
    return (
      `📅【单次再排期 · 冲突调整建议】\n` +
      `将「${newTaskTitle}」再排期至 ${newS} ~ ${newE} 时，该时段当前已安排「${proposal.conflictTask.title}」（原定：${oldS} ~ ${oldE}）。\n\n` +
      `💡 建议同步调整：\n` +
      `• 「${newTaskTitle}」改期至：${newS} ~ ${newE}\n` +
      `• 「${proposal.conflictTask.title}」顺延至：${confNewS} ~ ${confNewE}\n\n` +
      `是否确认同步修改？\n` +
      `👉 回复【确认】或【好】即可同步修改\n` +
      `👉 回复【保持】或【不改】则保持原日程不变`
    );
  }

  const header =
    mode === 'recomputed'
      ? `📅【最新日程调整建议】\n${reasonNotice || '原方案已失效，已按最新日程重新计算调整建议。'}\n\n`
      : `📅【日程调整建议】\n新待办「${newTaskTitle}」${proposal.reasonText}。\n`;

  return (
    header +
    `目标时段当前已安排「${proposal.conflictTask.title}」（原定：${oldS} ~ ${oldE}）。\n\n` +
    `💡 建议调整方案：\n` +
    `• 为「${newTaskTitle}」排入：${newS} ~ ${newE}\n` +
    `• 将「${proposal.conflictTask.title}」同步修改至：${confNewS} ~ ${confNewE}\n\n` +
    `是否确认同步修改？\n` +
    `👉 回复【确认】或【好】即可同步修改\n` +
    `👉 回复【保持】或【不改】则保持原日程不变`
  );
}

function formatAmbiguousCandidates(
  actionLabel: string,
  candidates: DisambiguationCandidate[]
): string {
  const lines = candidates.map((c) => {
    const typeLabel = c.type === 'calendar_event' ? '外部日程' : '待办';
    const dateLabel = c.date ? ` (${c.date})` : '';
    return `${c.index}. [${typeLabel}] ${c.title}${dateLabel} (ID:${c.id})`;
  });
  return (
    `🔍 找到多个匹配项，请选择要「${actionLabel}」的目标：\n` +
    lines.join('\n') +
    `\n\n👉 直接回复序号（如“1”）、ID 或更具体名称即可（回复“算了”取消）`
  );
}

function parsePureDurationMinutes(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (/^半\s*(个)?\s*小时$/.test(t) || t === '半小时') return 30;
  const numOnly = t.match(/^(\d+(?:\.\d+)?)\s*(分钟|分|m|min|mins|minute|minutes)?$/);
  if (numOnly) {
    const v = Math.round(Number(numOnly[1]));
    return v > 0 && v <= 10000 ? v : null;
  }
  const hourOnly = t.match(/^(\d+(?:\.\d+)?)\s*(个)?\s*(小时|钟头|h|hr|hrs|hour|hours)$/);
  if (hourOnly) {
    const v = Math.round(Number(hourOnly[1]) * 60);
    return v > 0 && v <= 10000 ? v : null;
  }
  const hourMin = t.match(/^(\d+)\s*(?:个)?\s*(?:小时|h)\s*(\d+)\s*(?:分钟|分|m)?$/);
  if (hourMin) {
    const v = Number(hourMin[1]) * 60 + Number(hourMin[2]);
    return v > 0 && v <= 10000 ? v : null;
  }
  return null;
}

function parseCandidateSelectionFromText(
  text: string,
  candidates: DisambiguationCandidate[]
): DisambiguationCandidate | null {
  const trimmed = text.trim();
  // Match "1", "第1个", "选1", "第一个"
  const idxMatch = trimmed.match(/^(?:第|选|选择)?\s*(\d{1,2})\s*(?:个|项|号)?$/);
  if (idxMatch) {
    const idx = Number(idxMatch[1]);
    const found = candidates.find((c) => c.index === idx);
    if (found) return found;
  }
  // Match "ID:15" or "#15"
  const idMatch = trimmed.match(/^(?:id[:：]?|#)\s*(\d+)$/i);
  if (idMatch) {
    const id = Number(idMatch[1]);
    const found = candidates.find((c) => c.id === id);
    if (found) return found;
  }
  // Exact title match
  const lower = trimmed.toLowerCase();
  const titleMatched = candidates.filter((c) => c.title.trim().toLowerCase() === lower);
  if (titleMatched.length === 1) return titleMatched[0];
  return null;
}

function summarizeRemainingFreeWindows(
  queryDate: string,
  tz: string,
  settings: UserSettings,
  scheduleData: UnifiedRangeQueryResult,
  now: Date
): string[] {
  const todayKey = getAccountLocalDateKey(now, tz);
  if (queryDate < todayKey) return [];

  let workSlots: Array<{ start: string; end: string }> = [
    { start: '09:00', end: '12:00' },
    { start: '13:00', end: '18:00' },
    { start: '19:00', end: '22:00' },
  ];
  try {
    const parsed = JSON.parse(settings.work_slots || '[]');
    if (Array.isArray(parsed) && parsed.length > 0) {
      workSlots = parsed;
    }
  } catch {}

  const dayStartMs = zonedWallClockToUtc(queryDate, 0, 0, 0, 0, tz).getTime();
  const minStartMs = queryDate === todayKey ? Math.max(dayStartMs, now.getTime()) : dayStartMs;

  let freeIntervals: Array<{ start: number; end: number }> = [];
  for (const ws of workSlots) {
    const [sh, sm] = String(ws.start || '09:00').split(':').map(Number);
    const [eh, em] = String(ws.end || '18:00').split(':').map(Number);
    if (!Number.isFinite(sh) || !Number.isFinite(eh)) continue;
    const s = zonedWallClockToUtc(queryDate, sh, sm || 0, 0, 0, tz).getTime();
    const e =
      eh >= 24
        ? dayStartMs + 24 * 3600_000
        : zonedWallClockToUtc(queryDate, eh, em || 0, 0, 0, tz).getTime();
    const clampedStart = Math.max(s, minStartMs);
    if (e > clampedStart) {
      freeIntervals.push({ start: clampedStart, end: e });
    }
  }

  const busyIntervals: Array<{ start: number; end: number }> = [];
  for (const ev of scheduleData.externalEvents) {
    if (ev.isAllDay || ev.allowScheduling) continue;
    busyIntervals.push({ start: new Date(ev.start).getTime(), end: new Date(ev.end).getTime() });
  }
  for (const b of scheduleData.blocks) {
    if (b.isConcurrent || b.blockStatus === 'completed') continue;
    busyIntervals.push({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() });
  }

  for (const busy of busyIntervals) {
    const next: Array<{ start: number; end: number }> = [];
    for (const seg of freeIntervals) {
      if (busy.end <= seg.start || busy.start >= seg.end) {
        next.push(seg);
      } else {
        if (busy.start > seg.start) next.push({ start: seg.start, end: busy.start });
        if (busy.end < seg.end) next.push({ start: busy.end, end: seg.end });
      }
    }
    freeIntervals = next;
  }

  return freeIntervals
    .filter((seg) => seg.end - seg.start >= 20 * 60_000)
    .slice(0, 4)
    .map((seg) => `${formatTimeInAccountTz(new Date(seg.start), tz)}-${formatTimeInAccountTz(new Date(seg.end), tz)}`);
}

function getActionLabel(parsed: LLMExtractionAction): string {
  if (parsed.intent === 'delete_item') return '删除/忽略';
  if (parsed.intent === 'modify_item') return '修改';
  const act = parsed.status_action || 'complete';
  const map: Record<string, string> = {
    start: '开始',
    complete: '完成',
    complete_part: '打卡分段',
    extend: '延长',
    reschedule: '再排期',
    cancel: '取消',
    reopen: '恢复',
    stop_daily: '停止每日',
  };
  return map[act] || '更新';
}

async function renderOptionalImage(
  kind: 'week_calendar' | 'todo_list',
  userId: number,
  channel: ProcessNLCommandParams['channel'],
  skipImages: boolean
): Promise<Buffer | undefined> {
  if (skipImages || channel !== 'weixin_ilink') return undefined;
  try {
    return kind === 'week_calendar'
      ? await renderWeekCalendarImage(userId)
      : await renderTodoListImage(userId);
  } catch {
    return undefined;
  }
}

async function resolveProposalAndBuildReply(params: {
  userId: number;
  channel: ProcessNLCommandParams['channel'];
  threadKey: string;
  draftVersion?: number;
  draftPayload: any;
  decision: 'accept' | 'reject';
  userText: string;
  tz: string;
}): Promise<ActionExecutionResult> {
  const { userId, channel, threadKey, draftVersion, draftPayload, decision, userText, tz } = params;
  const res = resolveScheduleProposal({
    userId,
    proposalId: draftPayload.proposalId,
    decision,
  });

  if (res.status === 'recomputed' && res.newProposal) {
    const newTitle = draftPayload.newTaskTitle || res.newProposal.conflictTask?.title || '新任务';
    const replyText = formatProposalConfirmReply({
      newTaskTitle: newTitle,
      proposal: res.newProposal,
      tz,
      mode: 'recomputed',
      reasonNotice: res.message,
    });
    const nextTurns = appendScopedSessionTurns(draftPayload.turns, userText, replyText);
    upsertConversationDraft({
      userId,
      channel,
      threadKey,
      intent: 'confirm_schedule_swap',
      draftData: {
        sessionType: 'confirm_schedule_swap',
        proposalId: res.newProposal.proposalId,
        newTaskTitle: newTitle,
        proposal: res.newProposal,
        turns: nextTurns,
      },
      ttlMinutes: 15,
    });
    return {
      replyText,
      openedSession: true,
      diagnostics: { intent: 'confirm_schedule_swap', resolution: res },
    };
  }

  consumeConversationDraft(userId, channel, threadKey, draftVersion);
  return {
    replyText: res.message,
    diagnostics: { intent: 'confirm_schedule_swap', resolution: res },
  };
}

async function executeStatusUpdateOnResolvedTarget(params: {
  userId: number;
  channel: ProcessNLCommandParams['channel'];
  threadKey: string;
  tz: string;
  skipImages: boolean;
  parsed: LLMExtractionAction;
  targetTask: Task;
  targetInstanceId?: number;
  targetBlockId?: string;
  userText: string;
}): Promise<ActionExecutionResult> {
  const { userId, channel, threadKey, tz, skipImages, parsed, targetTask, targetInstanceId, targetBlockId, userText } =
    params;
  const action = parsed.status_action || 'complete';

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
    return {
      replyText: res.success ? res.message : `⚠️ ${res.message}`,
      diagnostics: { intent: 'status_update', action, res },
    };
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
        const replyText = formatProposalConfirmReply({
          newTaskTitle: targetTask.title,
          proposal: propWithId,
          tz,
          mode: 'reschedule',
        });

        upsertConversationDraft({
          userId,
          channel,
          threadKey,
          intent: 'confirm_schedule_swap',
          draftData: {
            sessionType: 'confirm_schedule_swap',
            proposalId: propRec.id,
            newTaskTitle: targetTask.title,
            proposal: propWithId,
            turns: appendScopedSessionTurns([], userText, replyText),
          },
          ttlMinutes: 15,
        });

        return {
          replyText,
          openedSession: true,
          diagnostics: { intent: 'status_update', action: 'single_reschedule_proposal', proposal: propWithId },
        };
      }
    }

    if (!res.success) {
      return {
        replyText: `⚠️ ${res.message}`,
        diagnostics: { intent: 'status_update', action: 'single_reschedule', error: res.message },
      };
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

    const imageBuffer = await renderOptionalImage('week_calendar', userId, channel, skipImages);
    return {
      replyText:
        `🔄 已为「${targetTask.title}」完成单次再排期${prevText}${newText}\n• 其余已排定日程保持不变。` +
        (imageBuffer ? ' 👇' : ''),
      imageBuffer,
      imageKind: imageBuffer ? 'week_calendar' : undefined,
      diagnostics: { intent: 'status_update', action: 'single_reschedule', res },
    };
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

  return {
    replyText: res.success ? res.message : `⚠️ ${res.message}`,
    diagnostics: { intent: 'status_update', action: mappedAction, res, targetInstanceId },
  };
}

async function executeModifyOnResolvedTask(params: {
  userId: number;
  tz: string;
  parsed: LLMExtractionAction;
  targetTask: Task;
}): Promise<ActionExecutionResult> {
  const { userId, tz, parsed, targetTask } = params;
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
    return {
      replyText: `💡 已定位到任务「${targetTask.title}」，但未检测到具体修改内容（请说明新时间、新时长或截止日期等）。`,
      diagnostics: { intent: 'modify_item', noChanges: true },
    };
  }

  const upd = await updateTaskCommand({
    userId,
    taskId: targetTask.id,
    rawInput: updatePayload,
  });

  if (!upd.success) {
    return {
      replyText: `⚠️ 修改失败：${upd.message}`,
      diagnostics: { intent: 'modify_item', error: upd.message },
    };
  }

  return {
    replyText: upd.task ? `✏️ 已更新：\n${formatTaskScheduleReply(upd.task, tz, upd.instance?.plan_reason)}` : `✏️ ${upd.message}`,
    diagnostics: { intent: 'modify_item', updatedTask: upd.task },
  };
}

function openDisambiguationSession(params: {
  userId: number;
  channel: ProcessNLCommandParams['channel'];
  threadKey: string;
  userText: string;
  parsed: LLMExtractionAction;
  rawCandidates: Array<{ id: number; type: 'task' | 'calendar_event'; title: string; date?: string; status?: string }>;
}): ActionExecutionResult {
  const { userId, channel, threadKey, userText, parsed, rawCandidates } = params;
  const candidates: DisambiguationCandidate[] = rawCandidates.map((c, idx) => ({
    index: idx + 1,
    id: c.id,
    type: c.type,
    title: c.title,
    date: c.date,
    status: c.status,
  }));
  const actionLabel = getActionLabel(parsed);
  const replyText = formatAmbiguousCandidates(actionLabel, candidates);

  upsertConversationDraft({
    userId,
    channel,
    threadKey,
    intent: 'disambiguate_target',
    draftData: {
      sessionType: 'disambiguate_target',
      actionLabel,
      parsedAction: parsed,
      candidates,
      turns: appendScopedSessionTurns([], userText, replyText),
    },
    ttlMinutes: 15,
  });

  return {
    replyText,
    openedSession: true,
    diagnostics: { intent: parsed.intent, ambiguous: candidates },
  };
}

async function executeCandidateSelection(params: {
  userId: number;
  channel: ProcessNLCommandParams['channel'];
  threadKey: string;
  tz: string;
  skipImages: boolean;
  userText: string;
  candidate: DisambiguationCandidate;
  parsedAction: LLMExtractionAction;
}): Promise<ActionExecutionResult> {
  const { userId, channel, threadKey, tz, skipImages, userText, candidate, parsedAction } = params;

  if (parsedAction.intent === 'delete_item') {
    if (candidate.type === 'task') {
      const del = deleteTaskCommand(userId, candidate.id);
      return {
        replyText: del.success ? `🗑️ ${del.message}` : `⚠️ ${del.message}`,
        diagnostics: { intent: 'delete_item', deletedTaskId: candidate.id },
      };
    }
    const ign = ignoreExternalCalendarInstance(userId, candidate.id);
    return {
      replyText: `🗑️ ${ign.message}`,
      diagnostics: { intent: 'delete_item', ignoredEventId: candidate.id },
    };
  }

  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(candidate.id, userId) as Task | undefined;
  if (!task) {
    return { replyText: `⚠️ 目标任务「${candidate.title}」已不存在。` };
  }

  if (parsedAction.intent === 'modify_item') {
    return executeModifyOnResolvedTask({ userId, tz, parsed: parsedAction, targetTask: task });
  }

  const inst = ensureTaskInstance(
    userId,
    task.id,
    candidate.date || getAccountLocalDateKey(new Date(), tz),
    new Date()
  );
  return executeStatusUpdateOnResolvedTarget({
    userId,
    channel,
    threadKey,
    tz,
    skipImages,
    parsed: parsedAction,
    targetTask: task,
    targetInstanceId: inst?.id,
    userText,
  });
}

async function executeSingleParsedAction(params: {
  userId: number;
  channel: ProcessNLCommandParams['channel'];
  threadKey: string;
  tz: string;
  settings: UserSettings;
  userText: string;
  parsed: LLMExtractionAction;
  activeCreateDraft?: { version: number; payload: any } | null;
  skipImages: boolean;
}): Promise<ActionExecutionResult> {
  const { userId, channel, threadKey, tz, settings, userText, parsed, activeCreateDraft, skipImages } = params;

  if (parsed.intent === 'query_schedule') {
    const queryDate = parsed.target_date || getAccountLocalDateKey(new Date(), tz);
    const data = queryScheduleForLocalDate(userId, queryDate);
    const lines: string[] = [];

    for (const ev of data.externalEvents) {
      const s = formatTimeInAccountTz(ev.start, tz);
      const e = formatTimeInAccountTz(ev.end, tz);
      const schedTag = ev.allowScheduling ? '·可排程' : '';
      lines.push(`• [外部${schedTag}] [${s}-${e}] ${ev.title}`);
    }
    for (const b of data.blocks) {
      const s = formatTimeInAccountTz(b.start, tz);
      const e = formatTimeInAccountTz(b.end, tz);
      const icon = b.blockStatus === 'completed' ? '✅' : b.blockStatus === 'in_progress' ? '▶️' : b.blockStatus === 'conflict' ? '⚠️' : '📌';
      const partSuffix = b.totalParts > 1 ? ` (${b.partIndex}/${b.totalParts}节)` : '';
      lines.push(`• ${icon} [${s}-${e}] ${b.title}${partSuffix} (${b.durationMinutes}m)`);
    }

    const freeSlots = summarizeRemainingFreeWindows(queryDate, tz, settings, data, new Date());
    const freeText = freeSlots.length > 0 ? `\n\n🟢 当日可用空闲：${freeSlots.join('、')}` : '';

    const unscheduledList = queryUnscheduledTasks(userId, 5);
    const unscheduledText =
      unscheduledList.length > 0
        ? `\n\n⏳ 未排期任务 (${unscheduledList.length} 项)：\n` +
          unscheduledList.map((t) => `• ${t.title} (${t.duration_minutes}m)`).join('\n') +
          `\n💡 回复“把 [任务名称] 排期”可单独安排时段`
        : '';

    const replyText =
      (lines.length > 0
        ? `📅 ${queryDate} 日程安排：\n` + lines.join('\n')
        : `📅 ${queryDate} 暂无外部日程或已排期任务`) +
      freeText +
      unscheduledText;

    const wantsImage = /(日历|周历|图|视图)/.test(userText);
    const imageBuffer = wantsImage ? await renderOptionalImage('week_calendar', userId, channel, skipImages) : undefined;
    return {
      replyText: replyText + (imageBuffer ? ' 👇' : ''),
      imageBuffer,
      imageKind: imageBuffer ? 'week_calendar' : undefined,
      diagnostics: {
        intent: 'query_schedule',
        date: queryDate,
        blockCount: data.blocks.length,
        extCount: data.externalEvents.length,
        freeSlots,
      },
    };
  }

  if (parsed.intent === 'status_update') {
    const action = parsed.status_action || 'complete';

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
      const imageBuffer = await renderOptionalImage('week_calendar', userId, channel, skipImages);
      return {
        replyText:
          `🔄 ${replanRes.summary}（当前已排期 ${todoSummary.counts.scheduled + todoSummary.counts.inProgress} 项 · 未排期 ${todoSummary.counts.pendingSlot} 项）` +
          (imageBuffer ? ' 👇' : ''),
        imageBuffer,
        imageKind: imageBuffer ? 'week_calendar' : undefined,
        diagnostics: { intent: 'status_update', action: 'global_reschedule', replanRes },
      };
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
        return openDisambiguationSession({
          userId,
          channel,
          threadKey,
          userText,
          parsed,
          rawCandidates: resolved.candidates,
        });
      }
      if (resolved.status === 'not_found') {
        return {
          replyText: `⚠️ ${resolved.message}，请核对任务名称后重试。`,
          diagnostics: { intent: 'status_update', notFound: true },
        };
      }
      if (resolved.status === 'found_task') {
        targetTask = resolved.task;
        targetInstanceId = resolved.instance?.id;
      }
    } else {
      const recentRem = findRecentReminderTarget(userId);
      if (recentRem?.kind === 'external') {
        if (action === 'cancel') {
          const ign = ignoreExternalCalendarInstance(userId, recentRem.eventId);
          return {
            replyText: `🗑️ ${ign.message}`,
            diagnostics: { intent: 'status_update', action: 'ignore_recent_external', eventId: recentRem.eventId },
          };
        }
        return {
          replyText: `📆 刚才提醒的是外部日程「${recentRem.title}」。若要本地忽略它可回复“忽略”，若要操作其他待办请说明任务名称。`,
          diagnostics: { intent: 'status_update', recentExternalOnly: true },
        };
      }

      if (recentRem?.kind === 'task') {
        targetTask = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(recentRem.taskId, userId) as Task | undefined;
        targetInstanceId = recentRem.instanceId;
        targetBlockId = recentRem.blockId;
      } else {
        const inProgress = db
          .prepare(`SELECT * FROM tasks WHERE user_id = ? AND status = 'in_progress' ORDER BY scheduled_start ASC`)
          .all(userId) as Task[];
        if (inProgress.length === 1) {
          targetTask = inProgress[0];
        } else if (inProgress.length > 1) {
          return openDisambiguationSession({
            userId,
            channel,
            threadKey,
            userText,
            parsed,
            rawCandidates: inProgress.map((t) => ({ id: t.id, type: 'task', title: t.title, status: t.status })),
          });
        }
      }
    }

    if (!targetTask) {
      return {
        replyText: '⚠️ 未定位到具体任务，请说明任务名称（如“完成 写周报”）。',
        diagnostics: { intent: 'status_update', notFound: true },
      };
    }

    return executeStatusUpdateOnResolvedTarget({
      userId,
      channel,
      threadKey,
      tz,
      skipImages,
      parsed,
      targetTask,
      targetInstanceId,
      targetBlockId,
      userText,
    });
  }

  if (parsed.intent === 'delete_item') {
    const explicitName = (
      parsed.delete_target?.name ||
      parsed.title ||
      userText.replace(/^(删除|取消|删掉|移除|忽略)(任务|日程)?/, '').trim()
    );

    if (!explicitName) {
      const recentRem = findRecentReminderTarget(userId);
      if (recentRem?.kind === 'external') {
        const ign = ignoreExternalCalendarInstance(userId, recentRem.eventId);
        return {
          replyText: `🗑️ ${ign.message}`,
          diagnostics: { intent: 'delete_item', ignoredEventId: recentRem.eventId },
        };
      }
      if (recentRem?.kind === 'task') {
        const del = deleteTaskCommand(userId, recentRem.taskId);
        return {
          replyText: del.success ? `🗑️ ${del.message}` : `⚠️ ${del.message}`,
          diagnostics: { intent: 'delete_item', deletedTaskId: recentRem.taskId },
        };
      }
      return { replyText: '⚠️ 请说明要删除的任务或日程名称。', diagnostics: { intent: 'delete_item' } };
    }

    const resolved = resolveCommandTarget({
      userId,
      name: explicitName,
      type: parsed.delete_target?.type || 'auto',
      date: parsed.delete_target?.date || parsed.target_date || undefined,
      includeCompleted: false,
    });

    if (resolved.status === 'ambiguous') {
      return openDisambiguationSession({
        userId,
        channel,
        threadKey,
        userText,
        parsed,
        rawCandidates: resolved.candidates,
      });
    }
    if (resolved.status === 'not_found') {
      return {
        replyText: `⚠️ ${resolved.message}。`,
        diagnostics: { intent: 'delete_item', notFound: true },
      };
    }
    if (resolved.status === 'found_task') {
      const del = deleteTaskCommand(userId, resolved.task.id);
      return {
        replyText: del.success ? `🗑️ ${del.message}` : `⚠️ ${del.message}`,
        diagnostics: { intent: 'delete_item', deletedTaskId: resolved.task.id },
      };
    }
    const ign = ignoreExternalCalendarInstance(userId, resolved.event.id);
    return {
      replyText: `🗑️ ${ign.message}`,
      diagnostics: { intent: 'delete_item', ignoredEventId: resolved.event.id },
    };
  }

  if (parsed.intent === 'modify_item') {
    const targetName = parsed.modify_target?.name || parsed.target_task_name || parsed.title || '';
    const resolved = resolveCommandTarget({
      userId,
      name: targetName,
      type: 'task',
      date: parsed.target_date || undefined,
    });

    if (resolved.status === 'ambiguous') {
      return openDisambiguationSession({
        userId,
        channel,
        threadKey,
        userText,
        parsed,
        rawCandidates: resolved.candidates,
      });
    }
    if (resolved.status !== 'found_task') {
      return {
        replyText: `⚠️ 未找到待修改的任务「${targetName}」。您可发送“查看任务”核对现有名称。`,
        diagnostics: { intent: 'modify_item', notFound: true },
      };
    }

    return executeModifyOnResolvedTask({ userId, tz, parsed, targetTask: resolved.task });
  }

  if (parsed.intent === 'create_task') {
    const prevDraft = activeCreateDraft?.payload || {};
    const title = parsed.title || prevDraft.title || '';

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
      title: !title,
      fixed_start: wantsFixed && !fixedTime.start && !parsed.fixed_start && !prevDraft.fixed_start,
      fixed_end: wantsFixed && Boolean(fixedTime.start || parsed.fixed_start || prevDraft.fixed_start) && !fixedTime.end,
      duration: !wantsFixed && (!rawDuration || rawDuration <= 0),
      deadline: false,
      urgency: false,
      importance: false,
    };

    const hasMissing = missing.title || missing.fixed_start || missing.fixed_end || missing.duration;

    const mergedDraft = {
      sessionType: 'create_task_fill',
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
      missing,
    };

    if (hasMissing) {
      const replyText = missing.title
        ? `📝 请补充这项任务的名称（回复“算了”可取消）：`
        : `${templates.askMissingFields(title, missing)}\n（回复“算了”可取消本次安排）`;
      const nextTurns = appendScopedSessionTurns(prevDraft.turns, userText, replyText);
      upsertConversationDraft({
        userId,
        channel,
        threadKey,
        intent: 'create_task',
        draftData: { ...mergedDraft, turns: nextTurns },
        missingFields: missing,
        ttlMinutes: 30,
      });
      return {
        replyText,
        openedSession: true,
        diagnostics: { intent: 'create_task', missing, mergedDraft },
      };
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
      return {
        replyText: `⚠️ 创建失败：${createRes.message}`,
        diagnostics: { intent: 'create_task', error: createRes.message },
      };
    }

    // 任务已进入落库或提案流转，自动关闭 create_task 填槽草稿
    if (activeCreateDraft) {
      consumeConversationDraft(userId, channel, threadKey, activeCreateDraft.version);
    }

    if (createRes.proposal) {
      const prop = createRes.proposal;
      const replyText = formatProposalConfirmReply({
        newTaskTitle: title,
        proposal: prop,
        tz,
        mode: 'create',
      });
      upsertConversationDraft({
        userId,
        channel,
        threadKey,
        intent: 'confirm_schedule_swap',
        draftData: {
          sessionType: 'confirm_schedule_swap',
          proposalId: prop.proposalId,
          newTaskTitle: title,
          proposal: prop,
          turns: appendScopedSessionTurns(prevDraft.turns, userText, replyText),
        },
        ttlMinutes: 15,
      });

      return {
        replyText,
        openedSession: true,
        diagnostics: { intent: 'create_task', proposal: prop },
      };
    }

    const reply = createRes.task
      ? formatTaskScheduleReply(createRes.task, tz, createRes.instance?.plan_reason)
      : createRes.message;

    return {
      replyText: reply,
      diagnostics: { intent: 'create_task', taskId: createRes.task?.id, planVersion: createRes.planVersion },
    };
  }

  addDebugLog('Weixin', 'info', `[用户 #${userId}] 未匹配明确指令: "${userText}"`);
  return {
    replyText:
      `💡 未识别到具体日程或任务操作。您可以这样说：\n` +
      `• "明天写代码2小时" / "整理桌面1小时"\n` +
      `• "看看今天的日程" / "查看任务"\n` +
      `• "把写代码改期到明天下午" / "写代码换个时间"\n` +
      `• "完成 写代码" / "延长半小时"\n` +
      `回复“帮助”查看全部指令。`,
    diagnostics: { intent: 'other', parsed },
  };
}

/**
 * 统一自然语言命令处理管线（M01–M08, A08）：
 * - 事件级短上下文：多轮对话仅围绕当前未完成事务（补全字段 / 消歧选择 / 冲突确认），事务结束或取消即自动关闭
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

  const normalizedExact = normalizeExactTrigger(trimmed);

  // 1. 严格快捷指令（仅整句匹配，不误伤复合句）
  if (HELP_EXACT.has(normalizedExact) || (isFirstActivation && /^(你好|hi|hello|在吗|开始)$/i.test(normalizedExact))) {
    return {
      replyText: getHelpMessage(isFirstActivation),
      diagnostics: { intent: isFirstActivation ? 'activation_help' : 'help' },
    };
  }

  const activationBanner = isFirstActivation ? '🎉 微信助手已激活！以后每 24 小时发送任意消息即可保持主动提醒畅通。\n\n' : '';
  const withBanner = (res: ProcessNLCommandResult): ProcessNLCommandResult =>
    activationBanner ? { ...res, replyText: activationBanner + res.replyText } : res;

  if (VIEW_CALENDAR_EXACT.has(normalizedExact)) {
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
          unscheduledHint = `\n⏳ 未排期任务：${unscheduledList.map((t) => `${t.title}(${t.duration_minutes}m)`).join('、')}${unscheduledTotal > unscheduledList.length ? ' 等' : ''}`;
        }
      }
    }
    const imageBuffer = await renderOptionalImage('week_calendar', userId, channel, skipImages);
    return withBanner({
      replyText: `📅 日历已更新${syncInfo}` + (imageBuffer ? ' 👇' : '') + unscheduledHint,
      imageBuffer,
      imageKind: imageBuffer ? 'week_calendar' : undefined,
      diagnostics: { intent: 'view_calendar', dryRun },
    });
  }

  if (VIEW_TODOS_EXACT.has(normalizedExact)) {
    const summary = queryTodoSummary(userId, 12);
    const imageBuffer = await renderOptionalImage('todo_list', userId, channel, skipImages);
    return withBanner({
      replyText:
        `📝 待办任务清单 (共 ${summary.counts.total} 项：已排期 ${summary.counts.scheduled + summary.counts.inProgress} / 未排期 ${summary.counts.pendingSlot} / 已完成 ${summary.counts.completed})` +
        (imageBuffer ? ' 👇' : ''),
      imageBuffer,
      imageKind: imageBuffer ? 'todo_list' : undefined,
      diagnostics: { intent: 'view_todos', counts: summary.counts },
    });
  }

  if (GLOBAL_REPLAN_EXACT.has(normalizedExact)) {
    if (dryRun) {
      return withBanner({
        replyText: '🔄 [演练模式] 已模拟触发全局重新排程（未修改生产数据）。',
        diagnostics: { intent: 'replan', dryRun: true },
      });
    }
    await syncAllUserSubscriptions(userId);
    const replanRes = replanUserTasks(userId, { triggerSource: 'nl_replan' });
    const todoSummary = queryTodoSummary(userId, 20);
    const imageBuffer = await renderOptionalImage('week_calendar', userId, channel, skipImages);
    return withBanner({
      replyText:
        `🔄 ${replanRes.summary}（当前已排期 ${todoSummary.counts.scheduled + todoSummary.counts.inProgress} 项 · 未排期 ${todoSummary.counts.pendingSlot} 项）` +
        (imageBuffer ? ' 👇' : ''),
      imageBuffer,
      imageKind: imageBuffer ? 'week_calendar' : undefined,
      diagnostics: { intent: 'replan', replanRes },
    });
  }

  // 2. 加载当前事件级短上下文草稿
  const draft = dryRun ? null : getActiveConversationDraft(userId, channel, threadKey);
  let draftPayload: any = null;
  if (draft) {
    try {
      draftPayload = JSON.parse(draft.draft_json);
    } catch {
      draftPayload = null;
    }
  }

  // 2a. 存在活跃事件会话时的快速确定性响应（不调 LLM）
  if (draft && draftPayload) {
    if (draft.intent === 'confirm_schedule_swap' && draftPayload.proposalId) {
      const fastConfirm = FAST_CONFIRM_RE.test(normalizedExact);
      const fastReject = FAST_REJECT_RE.test(normalizedExact);
      if (fastConfirm || fastReject) {
        const res = await resolveProposalAndBuildReply({
          userId,
          channel,
          threadKey,
          draftVersion: draft.version,
          draftPayload,
          decision: fastConfirm ? 'accept' : 'reject',
          userText: trimmed,
          tz,
        });
        return withBanner(res);
      }
    }

    if (SESSION_CANCEL_RE.test(normalizedExact)) {
      consumeConversationDraft(userId, channel, threadKey, draft.version);
      return withBanner({
        replyText: '👌 已取消当前交互操作。',
        diagnostics: { intent: 'session_cancelled', cancelledDraftIntent: draft.intent },
      });
    }

    if (draft.intent === 'disambiguate_target' && Array.isArray(draftPayload.candidates)) {
      const matchedCandidate = parseCandidateSelectionFromText(trimmed, draftPayload.candidates);
      if (matchedCandidate && draftPayload.parsedAction) {
        consumeConversationDraft(userId, channel, threadKey, draft.version);
        const execRes = await executeCandidateSelection({
          userId,
          channel,
          threadKey,
          tz,
          skipImages,
          userText: trimmed,
          candidate: matchedCandidate,
          parsedAction: draftPayload.parsedAction,
        });
        return withBanner(execRes);
      }
    }

    if (draft.intent === 'create_task') {
      if (draftPayload.missing?.duration && !draftPayload.missing?.title) {
        const fastDur = parsePureDurationMinutes(trimmed);
        if (fastDur) {
          const syntheticAction: LLMExtractionAction = {
            intent: 'create_task',
            duration_minutes: fastDur,
          };
          const execRes = await executeSingleParsedAction({
            userId,
            channel,
            threadKey,
            tz,
            settings,
            userText: trimmed,
            parsed: syntheticAction,
            activeCreateDraft: { version: draft.version, payload: draftPayload },
            skipImages,
          });
          return withBanner(execRes);
        }
      }
      if (
        draftPayload.missing?.title &&
        trimmed.length <= 40 &&
        !/^(查看|看看|删除|删掉|取消|修改|把|帮我查|重新|开始|完成|延长)/.test(trimmed)
      ) {
        const syntheticAction: LLMExtractionAction = {
          intent: 'create_task',
          title: trimmed,
        };
        const execRes = await executeSingleParsedAction({
          userId,
          channel,
          threadKey,
          tz,
          settings,
          userText: trimmed,
          parsed: syntheticAction,
          activeCreateDraft: { version: draft.version, payload: draftPayload },
          skipImages,
        });
        return withBanner(execRes);
      }
    }
  }

  // 3. 调用 LLM 提取意图（仅携带当前活跃事件上下文，无长期全局历史）
  const parsed = await parseUserMessageWithLLM(trimmed, settings, draftPayload, { dryRun });

  if (dryRun) {
    return withBanner({
      replyText: `🧪 [演练模式 · 未写入生产库] 识别意图：${parsed.intent}，标题：${parsed.title || parsed.target_task_name || '-'}`,
      diagnostics: { dryRun: true, intent: parsed.intent, parsed },
    });
  }

  // 3a. 若当前有活跃事件会话，先处理退出/确认/选候选/切换逻辑
  let activeCreateDraft: { version: number; payload: any } | null = null;
  if (draft && draftPayload) {
    if (parsed.session_action === 'cancel_session') {
      if (draft.intent === 'confirm_schedule_swap' && draftPayload.proposalId) {
        const res = await resolveProposalAndBuildReply({
          userId,
          channel,
          threadKey,
          draftVersion: draft.version,
          draftPayload,
          decision: 'reject',
          userText: trimmed,
          tz,
        });
        return withBanner(res);
      }
      consumeConversationDraft(userId, channel, threadKey, draft.version);
      return withBanner({
        replyText: '👌 已取消当前交互操作。',
        diagnostics: { intent: 'session_cancelled', parsed },
      });
    }

    if (draft.intent === 'confirm_schedule_swap' && draftPayload.proposalId) {
      if (parsed.swap_decision === 'confirm' || parsed.swap_decision === 'reject') {
        const res = await resolveProposalAndBuildReply({
          userId,
          channel,
          threadKey,
          draftVersion: draft.version,
          draftPayload,
          decision: parsed.swap_decision === 'confirm' ? 'accept' : 'reject',
          userText: trimmed,
          tz,
        });
        return withBanner(res);
      }
      // 用户切换新指令 -> 自动结束旧提案草稿
      consumeConversationDraft(userId, channel, threadKey, draft.version);
    } else if (draft.intent === 'disambiguate_target' && Array.isArray(draftPayload.candidates)) {
      const candidates = draftPayload.candidates as DisambiguationCandidate[];
      let chosen: DisambiguationCandidate | undefined;
      if (parsed.selected_candidate_index) {
        chosen = candidates.find((c) => c.index === parsed.selected_candidate_index);
      } else if (parsed.selected_candidate_id) {
        chosen = candidates.find((c) => c.id === parsed.selected_candidate_id);
      } else if (parsed.target_task_name) {
        const sub = candidates.filter((c) =>
          c.title.toLowerCase().includes(String(parsed.target_task_name).toLowerCase())
        );
        if (sub.length === 1) chosen = sub[0];
      }

      if (chosen && draftPayload.parsedAction) {
        consumeConversationDraft(userId, channel, threadKey, draft.version);
        const execRes = await executeCandidateSelection({
          userId,
          channel,
          threadKey,
          tz,
          skipImages,
          userText: trimmed,
          candidate: chosen,
          parsedAction: draftPayload.parsedAction,
        });
        return withBanner(execRes);
      }

      // 用户发起新指令 -> 自动关闭消歧草稿
      if (parsed.session_action === 'switch_new' || parsed.intent !== 'other') {
        consumeConversationDraft(userId, channel, threadKey, draft.version);
      } else {
        const nextTurns = appendScopedSessionTurns(draftPayload.turns, trimmed, '请回复序号或 ID 选择目标。');
        upsertConversationDraft({
          userId,
          channel,
          threadKey,
          intent: 'disambiguate_target',
          draftData: { ...draftPayload, turns: nextTurns },
          ttlMinutes: 15,
        });
        return withBanner({
          replyText: formatAmbiguousCandidates(draftPayload.actionLabel || '操作', candidates),
          diagnostics: { intent: 'disambiguate_target', retry: true },
        });
      }
    } else if (draft.intent === 'create_task') {
      if (parsed.session_action === 'switch_new' || (parsed.intent !== 'create_task' && parsed.intent !== 'other')) {
        consumeConversationDraft(userId, channel, threadKey, draft.version);
      } else if (parsed.intent === 'other') {
        const titleLabel = draftPayload.title || '新任务';
        const replyText = draftPayload.missing?.title
          ? '📝 当前正在补充任务信息，请告诉我任务名称（回复“算了”可取消）：'
          : `${templates.askMissingFields(titleLabel, draftPayload.missing || { duration: true })}\n（回复“算了”可取消本次安排）`;
        upsertConversationDraft({
          userId,
          channel,
          threadKey,
          intent: 'create_task',
          draftData: {
            ...draftPayload,
            turns: appendScopedSessionTurns(draftPayload.turns, trimmed, replyText),
          },
          missingFields: draftPayload.missing,
          ttlMinutes: 30,
        });
        return withBanner({
          replyText,
          diagnostics: { intent: 'create_task', promptAgain: true },
        });
      } else {
        activeCreateDraft = { version: draft.version, payload: draftPayload };
      }
    }
  }

  // 4. 执行主动作 + 可选的复合后续动作
  const mainRes = await executeSingleParsedAction({
    userId,
    channel,
    threadKey,
    tz,
    settings,
    userText: trimmed,
    parsed,
    activeCreateDraft,
    skipImages,
  });

  if (
    !mainRes.openedSession &&
    Array.isArray(parsed.extra_actions) &&
    parsed.extra_actions.length > 0 &&
    parsed.intent !== 'other'
  ) {
    const replies = [mainRes.replyText];
    let finalImg = mainRes.imageBuffer;
    let finalImgKind = mainRes.imageKind;

    for (const extra of parsed.extra_actions.slice(0, 2)) {
      if (!extra || extra.intent === 'other') continue;
      const subRes = await executeSingleParsedAction({
        userId,
        channel,
        threadKey,
        tz,
        settings,
        userText: trimmed,
        parsed: extra,
        activeCreateDraft: null,
        skipImages,
      });
      if (subRes.replyText) replies.push(subRes.replyText);
      if (subRes.imageBuffer && !finalImg) {
        finalImg = subRes.imageBuffer;
        finalImgKind = subRes.imageKind;
      }
      if (subRes.openedSession) break;
    }

    return withBanner({
      replyText: replies.join('\n\n'),
      imageBuffer: finalImg,
      imageKind: finalImgKind,
      diagnostics: {
        ...(mainRes.diagnostics || {}),
        compoundCount: replies.length,
      },
    });
  }

  return withBanner({
    replyText: mainRes.replyText,
    imageBuffer: mainRes.imageBuffer,
    imageKind: mainRes.imageKind,
    diagnostics: mainRes.diagnostics,
  });
}
