import { TaskModal, type TaskModalSavePayload } from './TaskModal';
import type { TaskItem as EditableTask } from '../types/task';
import { inferTierFromScore, type ImpactSignal, type TimeMode, type UrgencyPace } from '../utils/priorityAlgorithm';
import { PlanningProgress, type PlanningState } from './PlanningProgress';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { normalizeScoreTo100 } from '../utils/priorityAlgorithm';
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Calendar as CalendarIcon,
  Trash2,
  Copy,
  Check,
  Clock,
  Download,
  Share2,
  Menu,
  PanelLeftClose,
  PanelLeft,
} from 'lucide-react';

// Google Calendar standard 24-hour grid constants
const CALENDAR_HOURS = 24;
const HOUR_HEIGHT = 36; // Compact event height
const GRID_HEIGHT = CALENDAR_HOURS * HOUR_HEIGHT; // 864px

const CALENDAR_PALETTE = [
  '#039BE5', // Peacock / Google Blue
  '#33B679', // Sage / Green
  '#8E24AA', // Grape / Purple
  '#E67C73', // Flamingo / Coral
  '#F6BF26', // Banana / Amber
  '#F4511E', // Tangerine / Orange
  '#3F51B5', // Indigo
  '#009688', // Teal
  '#616161', // Graphite
];

interface CalendarSubscription {
  id: number;
  name: string;
  url: string;
  event_count: number;
  sync_status: 'ok' | 'error';
  last_sync_at: string | null;
}

interface CalendarEventItem {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  backgroundColor?: string;
  borderColor?: string;
  subscriptionId?: number;
  subscriptionName?: string;
  extendedProps?: {
    type: 'external' | 'task';
    taskId?: number;
    urgency?: number;
    importance?: number;
    duration?: number;
    status?: string;
    deadline?: string;
    notes?: string;
    subscriptionId?: number;
    subscriptionName?: string;
  };
}

interface TaskItem {
  id: number;
  title: string;
  duration_minutes: number;
  original_duration_minutes?: number | null;
  time_mode?: string;
  importance_tier?: 'vital' | 'support' | 'minor' | null;
  impact_signals?: string | null;
  urgency_pace?: 'urgent' | 'soon' | 'later' | null;
  importance_manual_override?: number | null;
  deadline_kind?: 'hard' | 'soft' | null;
  completed_dates?: string | null;
  urgency: number;
  importance: number;
  score_scale?: number | null;
  deadline: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  schedule_blocks?: string | null;
  status: string;
  notes: string | null;
  is_fixed?: number;
  is_concurrent?: number;
  updated_at?: string;
  created_at?: string;
}

type TimedSegment =
  | {
      kind: 'event';
      id: string;
      title: string;
      start: string;
      end: string;
      allDay: boolean;
      color: string;
      event: CalendarEventItem;
    }
  | {
      kind: 'task';
      id: string;
      title: string;
      start: string;
      end: string;
      allDay: boolean;
      color: string;
      qClass: string;
      qName: string;
      task: TaskItem;
    };

interface PositionedItem<T> {
  item: T;
  column: number;
  columns: number;
  conflict: boolean;
}

function parseDbIso(dateStr?: string | null): Date | null {
  if (!dateStr) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(dateStr)) {
    return new Date(dateStr.replace(' ', 'T') + 'Z');
  }
  return new Date(dateStr);
}

// Start of week on Monday: 周一到周五在左，周六周日在右
function startOfWeek(date: Date): Date {
  const next = new Date(date);
  const day = next.getDay(); // 0 is Sun, 1 is Mon...
  const diff = next.getDate() - day + (day === 0 ? -6 : 1);
  next.setDate(diff);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dateKeyFromIso(iso: string): string {
  return localDateKey(new Date(iso));
}

function formatHourLabel(hour: number, locale: string): string {
  if (hour === 0) return '';
  if (locale.startsWith('zh')) {
    return `${String(hour).padStart(2, '0')}:00`;
  }
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return '12 PM';
  return `${hour - 12} PM`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatMonthHeading(start: Date, locale: string): string {
  const end = addDays(start, 6);
  if (locale.startsWith('zh')) {
    if (start.getFullYear() === end.getFullYear()) {
      if (start.getMonth() === end.getMonth()) {
        return `${start.getFullYear()}年${start.getMonth() + 1}月`;
      }
      return `${start.getFullYear()}年${start.getMonth() + 1}月 – ${end.getMonth() + 1}月`;
    }
    return `${start.getFullYear()}年${start.getMonth() + 1}月 – ${end.getFullYear()}年${end.getMonth() + 1}月`;
  }
  const startMonth = start.toLocaleDateString('en-US', { month: 'long' });
  const endMonth = end.toLocaleDateString('en-US', { month: 'long' });
  if (start.getFullYear() === end.getFullYear() && startMonth === endMonth) {
    return `${startMonth} ${start.getFullYear()}`;
  }
  return `${start.toLocaleDateString('en-US', { month: 'short' })} – ${endMonth} ${end.getFullYear()}`;
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return (
    new Date(aStart).getTime() < new Date(bEnd).getTime() &&
    new Date(aEnd).getTime() > new Date(bStart).getTime()
  );
}

function segmentRange(
  start: string,
  end: string,
  dayStart: string,
  dayEnd: string
): { start: string; end: string } | null {
  if (!overlaps(start, end, dayStart, dayEnd)) return null;
  return {
    start: new Date(Math.max(new Date(start).getTime(), new Date(dayStart).getTime())).toISOString(),
    end: new Date(Math.min(new Date(end).getTime(), new Date(dayEnd).getTime())).toISOString(),
  };
}

// Assign columns for overlapping items in calendar
function layoutDayItems<T extends { start: string; end: string }>(items: T[]): PositionedItem<T>[] {
  const sorted = [...items].sort(
    (a, b) =>
      new Date(a.start).getTime() - new Date(b.start).getTime() ||
      new Date(a.end).getTime() - new Date(b.end).getTime()
  );

  const result: PositionedItem<T>[] = [];
  let cluster: T[] = [];
  let clusterEnd = 0;

  const flush = () => {
    if (cluster.length === 0) return;
    const columnEnds: number[] = [];
    const placed: Array<{ item: T; column: number }> = [];

    for (const item of cluster) {
      const start = new Date(item.start).getTime();
      const end = new Date(item.end).getTime();
      let column = columnEnds.findIndex((value) => value <= start);
      if (column === -1) {
        column = columnEnds.length;
        columnEnds.push(end);
      } else {
        columnEnds[column] = end;
      }
      placed.push({ item, column });
    }

    const columns = Math.max(1, columnEnds.length);
    const conflict = cluster.length > 1;
    for (const entry of placed) {
      result.push({ ...entry, columns, conflict });
    }
    cluster = [];
    clusterEnd = 0;
  };

  for (const item of sorted) {
    const start = new Date(item.start).getTime();
    const end = new Date(item.end).getTime();
    if (cluster.length > 0 && start >= clusterEnd) {
      flush();
    }
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();

  return result;
}

function getTaskQuadrant(importance: number, urgency: number, scoreScale?: number | null) {
  const imp = normalizeScoreTo100(importance, scoreScale) >= 50;
  const urg = normalizeScoreTo100(urgency, scoreScale) >= 50;
  if (imp && urg) return { key: 'q1', name: 'Do First', color: '#EF4444' };
  if (imp && !urg) return { key: 'q2', name: 'Schedule', color: '#3B82F6' };
  if (!imp && urg) return { key: 'q3', name: 'Delegate', color: '#F59E0B' };
  return { key: 'q4', name: 'Eliminate', color: '#9CA3AF' };
}

function safeCopyToClipboard(text: string): boolean {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}

  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    textArea.style.top = '-9999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand('copy');
    textArea.remove();
    return successful;
  } catch (err) {
    console.error('Fallback copy failed: ', err);
    return false;
  }
}

interface CalendarViewProps {
  onOpenMobileMenu?: () => void;
  onNewTask?: () => void;
}

export const CalendarView: React.FC<CalendarViewProps> = ({ onOpenMobileMenu }) => {
  const { user } = useAuth();
  const { isDark, t, language } = useTheme();
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [events, setEvents] = useState<CalendarEventItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [subscriptions, setSubscriptions] = useState<CalendarSubscription[]>([]);
  const [loading, setLoading] = useState(true);

  // Left sidebar collapse toggle (Google Calendar main drawer toggle)
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Mini calendar month cursor
  const [miniMonthDate, setMiniMonthDate] = useState(() => new Date(weekStart));

  // Current live time for red indicator line
  const [currentTime, setCurrentTime] = useState(() => new Date());

  // Dialogs & Modals
  const [showCalendarsModal, setShowCalendarsModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [selectedItem, setSelectedItem] = useState<TimedSegment | null>(null);
  const [selectedDueTask, setSelectedDueTask] = useState<TaskItem | null>(null);
  const [editingTask, setEditingTask] = useState<TaskItem | null>(null);
  const [editError, setEditError] = useState('');

  const openCalendarItem = (item: TimedSegment) => {
    setSelectedItem(item);
  };

  const editInitialTask = (task: TaskItem): EditableTask => {
    let impactSignals: ImpactSignal[] = [];
    try {
      const parsed = JSON.parse(task.impact_signals || '[]');
      if (Array.isArray(parsed)) impactSignals = parsed;
    } catch {}
    const importance = normalizeScoreTo100(task.importance, task.score_scale);
    const urgency = normalizeScoreTo100(task.urgency, task.score_scale);
    const quadrant = getTaskQuadrant(task.importance, task.urgency, task.score_scale).key as EditableTask['quadrant'];
    return {
      id: String(task.id), title: task.title, description: task.notes || '', importance, urgency,
      importanceTier: task.importance_tier || inferTierFromScore(importance), impactSignals,
      timeMode: (task.time_mode || (task.deadline ? 'deadline' : 'flexible')) as TimeMode,
      urgencyPace: (task.urgency_pace || 'soon') as UrgencyPace,
      importanceManualOverride: task.importance_manual_override == null ? null : normalizeScoreTo100(task.importance_manual_override, task.score_scale),
      deadlineAt: task.deadline, deadlineKind: task.deadline_kind || 'soft', dueDate: task.deadline,
      estimatedMinutes: task.duration_minutes, isFixed: Boolean(task.is_fixed), isConcurrent: Boolean(task.is_concurrent),
      scheduledStart: task.scheduled_start, scheduledEnd: task.scheduled_end,
      isImportant: importance >= 50, isUrgent: urgency >= 50, quadrant,
      isCompleted: task.status === 'completed', tags: [], createdAt: task.created_at || new Date().toISOString(),
    };
  };

  const saveCalendarTask = async (taskId: number, data: TaskModalSavePayload) => {
    setEditError('');
    setPlanning({ title: '正在更新日程', status: 'working' });
    try {
      const response = await api.put(`/tasks/${taskId}`, {
        title: data.title, notes: data.description || '', duration_minutes: data.estimatedMinutes,
        importance: data.importance, urgency: data.urgency, importance_tier: data.importanceTier,
        impact_signals: data.impactSignals, time_mode: data.timeMode, urgency_pace: data.urgencyPace,
        importance_manual_override: data.importanceManualOverride, score_scale: 100,
        deadline_kind: data.deadlineKind,
        deadline: data.dueDate ? (data.dueDate.includes('T') ? new Date(data.dueDate).toISOString() : data.dueDate) : null,
        scheduled_start: data.scheduledStart || null, scheduled_end: data.scheduledEnd || null,
        is_fixed: data.isFixed ? 1 : 0, is_concurrent: data.isConcurrent ? 1 : 0,
      });
      setEditingTask(null);
      setEditError('');
      setPlanning({ title: '日程已更新', status: 'success', detail: response.data.message });
      await fetchData();
    } catch (error) {
      const err = error as { response?: { data?: { error?: string } } };
      setEditError(err.response?.data?.error || '保存失败，请重试');
      setPlanning(null);
    }
  };

  // Add subscription form
  const [newSubName, setNewSubName] = useState('');
  const [newSubUrl, setNewSubUrl] = useState('');
  const [submittingSub, setSubmittingSub] = useState(false);
  const [copiedType, setCopiedType] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  const [serverExportUrls, setServerExportUrls] = useState<{
    http: string;
    download: string;
    token: string;
  } | null>(null);

  const effectiveToken = serverExportUrls?.token || user?.token_secret || user?.calendar_token || '';
  const icalExportUrl = serverExportUrls?.http || (effectiveToken ? `${window.location.origin}/api/calendar/subscribe/${effectiveToken}.ics` : '');
  const downloadUrl = serverExportUrls?.download || (effectiveToken ? `${window.location.origin}/api/calendar/export/${effectiveToken}.ics` : '');

  // Live timer for red current time line
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  // Sync mini calendar month when weekStart changes
  useEffect(() => {
    setMiniMonthDate(new Date(weekStart));
  }, [weekStart]);

  const handleCopyLink = (linkToCopy: string, type: string) => {
    const ok = safeCopyToClipboard(linkToCopy);
    if (ok) {
      setCopiedType(type);
      setTimeout(() => setCopiedType(null), 2000);
    } else {
      alert(`请手动复制：\n${linkToCopy}`);
    }
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      const rangeStart = addDays(weekStart, -7).toISOString();
      const rangeEnd = addDays(weekStart, 14).toISOString();
      const [eventsRes, tasksRes] = await Promise.all([
        api.get('/calendar/events', { params: { start: rangeStart, end: rangeEnd } }),
        api.get('/tasks'),
      ]);
      setEvents(eventsRes.data.events || []);
      setSubscriptions(eventsRes.data.subscriptions || []);
      setTasks(tasksRes.data.tasks || []);
      if (eventsRes.data.exportUrls) {
        setServerExportUrls(eventsRes.data.exportUrls);
      }
    } catch (err) {
      console.error('Failed to load calendar data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [weekStart]);

  // Auto-scroll to morning hours (08:00) on mount / week change
  useEffect(() => {
    if (scrollRef.current) {
      const now = new Date();
      const targetHour = Math.max(7, now.getHours() - 1);
      scrollRef.current.scrollTop = targetHour * HOUR_HEIGHT;
    }
  }, [weekStart]);

  // Edge resistance for wheel and touch input, with a spring back to the scroll boundary.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const columns = Array.from(container.querySelectorAll<HTMLElement>('[data-calendar-timeline]'));
    if (!columns.length) return;
    let offset = 0;
    let touchY: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reset = () => {
      offset = 0;
      columns.forEach(column => {
        column.style.transition = 'transform 460ms cubic-bezier(.2, 1.65, .3, 1)';
        column.style.transform = 'translateY(0px)';
      });
    };
    const pull = (delta: number) => {
      const atTop = container.scrollTop <= 0 && delta < 0;
      const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 1 && delta > 0;
      if (!atTop && !atBottom) return false;
      if (timer) clearTimeout(timer);
      offset = Math.max(-36, Math.min(36, offset - delta * 0.22 * (1 - Math.abs(offset) / 45)));
      columns.forEach(column => {
        column.style.transition = 'none';
        column.style.transform = `translateY(${offset}px)`;
      });
      if (touchY === null) timer = setTimeout(reset, 100);
      return true;
    };
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && pull(event.deltaY)) event.preventDefault();
    };
    const start = (event: TouchEvent) => { touchY = event.touches.length === 1 ? event.touches[0].clientY : null; };
    const move = (event: TouchEvent) => {
      if (touchY === null || event.touches.length !== 1) return;
      const y = event.touches[0].clientY;
      const delta = touchY - y;
      touchY = y;
      if (pull(delta)) event.preventDefault();
    };
    const end = () => { touchY = null; if (timer) clearTimeout(timer); reset(); };
    container.addEventListener('wheel', wheel, { passive: false });
    container.addEventListener('touchstart', start, { passive: true });
    container.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);
    return () => {
      if (timer) clearTimeout(timer);
      container.removeEventListener('wheel', wheel);
      container.removeEventListener('touchstart', start);
      container.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', end);
      window.removeEventListener('touchcancel', end);
      columns.forEach(column => { column.style.transform = ''; column.style.transition = ''; });
    };
  }, []);

  // Map subscriptions to colors
  const subColorMap = useMemo(() => {
    const map = new Map<number, string>();
    subscriptions.forEach((s, idx) => {
      map.set(s.id, CALENDAR_PALETTE[idx % CALENDAR_PALETTE.length]);
    });
    return map;
  }, [subscriptions]);

  const todayKey = localDateKey(new Date());
  const weekStartKey = localDateKey(weekStart);

  // 7 Days Data (Sunday through Saturday)
  const dayData = useMemo(() => {
    return Array.from({ length: 7 }, (_, index) => {
      const date = addDays(weekStart, index);
      const key = localDateKey(date);

      // Window: 00:00:00 of this date to 00:00:00 of next date (standard 24h day)
      const windowStart = new Date(date);
      windowStart.setHours(0, 0, 0, 0);

      const windowEnd = new Date(addDays(date, 1));
      windowEnd.setHours(0, 0, 0, 0);

      const windowStartIso = windowStart.toISOString();
      const windowEndIso = windowEnd.toISOString();

      const allDayItems: TimedSegment[] = [];
      const timedItems: TimedSegment[] = [];

      // 1. External Events
      events
        .filter((ev) => ev.extendedProps?.type === 'external')
        .forEach((ev) => {
          const color =
            (ev.subscriptionId && subColorMap.get(ev.subscriptionId)) || '#039BE5';
          if (ev.allDay) {
            const startMs = new Date(ev.start).getTime();
            const endMs = new Date(ev.end).getTime();
            const startsOn = dateKeyFromIso(ev.start);
            // RFC 5545 全天事件的 DTEND 为次日 00:00（左闭右开），减去 1ms 得到实际最后一天
            const endsOn = endMs > startMs ? localDateKey(new Date(endMs - 1)) : startsOn;
            if (key >= startsOn && key <= endsOn) {
              allDayItems.push({
                kind: 'event',
                id: ev.id,
                title: ev.title,
                start: ev.start,
                end: ev.end,
                allDay: true,
                color,
                event: ev,
              });
            }
            return;
          }

          const range = segmentRange(ev.start, ev.end, windowStartIso, windowEndIso);
          if (range) {
            timedItems.push({
              kind: 'event',
              id: ev.id,
              title: ev.title,
              start: range.start,
              end: range.end,
              allDay: false,
              color,
              event: ev,
            });
          }
        });

      // 2. Scheduled and Completed Tasks (优先展示真实 schedule_blocks；无排程记录的已完成任务按完成时间倒推)
      const parseCompletedDates = (raw?: string | null): string[] => {
        if (!raw) return [];
        try {
          const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      };

      tasks.forEach((t) => {
        const completedDates = parseCompletedDates(t.completed_dates);
        const isCompletedForDay =
          t.status === 'completed' || (t.time_mode === 'daily_fixed' && completedDates.includes(key));

        let blocks: { start: string; end: string; partIndex?: number; totalParts?: number; completed?: boolean }[] = [];

        if (t.schedule_blocks) {
          try {
            const parsedBlocks = typeof t.schedule_blocks === 'string' ? JSON.parse(t.schedule_blocks) : t.schedule_blocks;
            if (Array.isArray(parsedBlocks)) {
              blocks = parsedBlocks;
            }
          } catch {}
        }
        if (blocks.length === 0 && t.scheduled_start && t.scheduled_end) {
          blocks = [{ start: t.scheduled_start, end: t.scheduled_end }];
        }
        if (blocks.length === 0 && t.status === 'completed') {
          const compEnd = parseDbIso(t.updated_at) || (t.deadline ? new Date(t.deadline) : new Date(t.created_at || Date.now()));
          const durMs = (t.original_duration_minutes || t.duration_minutes || 30) * 60000;
          const compStart = new Date(compEnd.getTime() - durMs);
          blocks = [{ start: compStart.toISOString(), end: compEnd.toISOString() }];
        }

        blocks.forEach((block, bIdx) => {
          const range = segmentRange(
            block.start,
            block.end,
            windowStartIso,
            windowEndIso
          );
          if (range) {
            const blockDone = isCompletedForDay || Boolean(block.completed);
            const quad = getTaskQuadrant(t.importance, t.urgency, t.score_scale);
            const partSuffix = block.totalParts && block.totalParts > 1 ? ` (${block.partIndex || bIdx + 1}/${block.totalParts}节)` : '';
            let titlePrefix = blockDone ? '✓ ' : '';
            if (!blockDone) {
              if (t.is_fixed) titlePrefix += '📌 ';
              if (t.is_concurrent) titlePrefix += '⚡ ';
            }

            let qBadge = blockDone ? '已完成' : quad.name;
            if (!blockDone) {
              if (t.is_fixed && t.is_concurrent) qBadge = '固定·双线程';
              else if (t.is_fixed) qBadge = '固定任务';
              else if (t.is_concurrent) qBadge = '双线程';
            }

            timedItems.push({
              kind: 'task',
              id: `task-${t.id}-${bIdx}-${blockDone ? 'done' : 'active'}`,
              title: `${titlePrefix}${t.title}${partSuffix}`,
              start: range.start,
              end: range.end,
              allDay: false,
              color: blockDone ? '#10B981' : quad.color,
              qClass: quad.key,
              qName: qBadge,
              task: t,
            });
          }
        });
      });

      // 3. Due tasks for this day
      const dueTasks = tasks
        .filter((t) => {
          if (!t.deadline || t.status === 'completed') return false;
          if (dateKeyFromIso(t.deadline) !== key) return false;
          if (t.time_mode === 'daily_fixed' && parseCompletedDates(t.completed_dates).includes(key)) {
            return false;
          }
          return true;
        })
        .sort((a, b) => b.urgency - a.urgency || b.importance - a.importance);

      return {
        date,
        key,
        windowStartMs: windowStart.getTime(),
        allDay: allDayItems,
        timed: layoutDayItems(timedItems),
        due: dueTasks,
      };
    });
  }, [weekStart, events, tasks, subColorMap]);

  // Overdue tasks
  const overdueTasks = useMemo(() => {
    return tasks
      .filter((t) => {
        if (!t.deadline || t.status === 'completed') return false;
        if (t.time_mode === 'daily_fixed' && t.completed_dates) {
          try {
            const doneDates = JSON.parse(t.completed_dates);
            if (Array.isArray(doneDates) && doneDates.includes(todayKey)) return false;
          } catch {}
        }
        return dateKeyFromIso(t.deadline) < weekStartKey;
      })
      .sort((a, b) => b.urgency - a.urgency || b.importance - a.importance);
  }, [tasks, weekStartKey, todayKey]);

  // Due groups this week
  const dueGroups = useMemo(() => {
    return dayData.filter((d) => d.due.length > 0);
  }, [dayData]);

  // Mini calendar matrix calculation (Monday to Sunday)
  const miniCalendarGrid = useMemo(() => {
    const year = miniMonthDate.getFullYear();
    const month = miniMonthDate.getMonth();
    const firstDayOfMonth = new Date(year, month, 1);
    const dayOfWeek = firstDayOfMonth.getDay(); // 0 is Sun
    const startDay = (dayOfWeek + 6) % 7; // 0 for Mon, 6 for Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const days: { date: Date; isCurrentMonth: boolean; key: string }[] = [];

    // Prev month days
    for (let i = startDay - 1; i >= 0; i--) {
      const d = new Date(year, month, -i);
      days.push({ date: d, isCurrentMonth: false, key: localDateKey(d) });
    }
    // Current month days
    for (let i = 1; i <= daysInMonth; i++) {
      const d = new Date(year, month, i);
      days.push({ date: d, isCurrentMonth: true, key: localDateKey(d) });
    }
    // Next month days to fill 35 or 42 slots
    const remaining = 42 - days.length;
    for (let i = 1; i <= remaining; i++) {
      const d = new Date(year, month + 1, i);
      days.push({ date: d, isCurrentMonth: false, key: localDateKey(d) });
    }
    return days;
  }, [miniMonthDate]);

  // Handlers for subscriptions & replanning
  const handleAddSubscription = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSubName.trim() || !newSubUrl.trim()) return;
    setSubmittingSub(true);
    try {
      await api.post('/calendar/subscriptions', {
        name: newSubName.trim(),
        url: newSubUrl.trim(),
      });
      setNewSubName('');
      setNewSubUrl('');
      fetchData();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      alert(error.response?.data?.error || '添加订阅失败');
    } finally {
      setSubmittingSub(false);
    }
  };

  const handleDeleteSubscription = async (id: number) => {
    if (!confirm('确定删除该外部日历吗？关联事件将一并移除。')) return;
    try {
      await api.delete(`/calendar/subscriptions/${id}`);
      fetchData();
    } catch {
      alert('删除失败');
    }
  };

  const handleSyncSubscription = async (id: number) => {
    try {
      await api.post(`/calendar/subscriptions/${id}/sync`);
      fetchData();
    } catch {
      alert('同步失败');
    }
  };

  const [replanLoading, setReplanLoading] = useState(false);
  const [planning, setPlanning] = useState<PlanningState | null>(null);

  const handleSyncAndReplanAll = async () => {
    setReplanLoading(true);
    setPlanning({ title: '正在重排全部日程', status: 'working' });
    try {
      const response = await api.post('/calendar/replan');
      setPlanning({ title: '日程已更新', status: 'success', detail: response.data.summary });
      await fetchData();
    } catch (e: any) {
      setPlanning({ title: '排程失败', status: 'error', detail: e.response?.data?.error || e.message });
    } finally {
      setReplanLoading(false);
    }
  };

  const handleCompletePart = async (taskId: number) => {
    try {
      const res = await api.post(`/tasks/${taskId}/complete-part`, {});
      alert(res.data.message);
      setSelectedItem(null);
      setSelectedDueTask(null);
      fetchData();
    } catch (err: any) {
      alert(err.response?.data?.error || '操作失败');
    }
  };

  const handleCompleteTask = async (taskId: number) => {
    try {
      await api.post(`/tasks/${taskId}/action`, { action: 'complete' });
      setSelectedItem(null);
      setSelectedDueTask(null);
      fetchData();
    } catch (err: any) {
      alert(err.response?.data?.error || '操作失败');
    }
  };

  const handleDeleteCalendarTask = async (taskId: number) => {
    if (!confirm('确定删除该待办任务吗？')) return;
    try {
      await api.delete(`/tasks/${taskId}`);
      setSelectedItem(null);
      setSelectedDueTask(null);
      fetchData();
    } catch (err: any) {
      alert(err.response?.data?.error || '删除失败');
    }
  };

  // Current time position in minutes from midnight
  const currentMinutesFromMidnight = currentTime.getHours() * 60 + currentTime.getMinutes();
  const currentLineTop = (currentMinutesFromMidnight / 60) * HOUR_HEIGHT;

  // 周一到周五在左，周六周日在右
  const weekDayLabels = language.startsWith('zh')
    ? ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
    : ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

  return (
    <div className="w-full h-full flex flex-col overflow-hidden bg-white dark:bg-[#1e1f20] text-gray-900 dark:text-gray-100 select-none">
      {planning && <PlanningProgress state={planning} onClose={() => setPlanning(null)} />}
      {/* 1. Google Calendar 经典顶部工具栏 */}
      <header className="h-14 px-3 sm:px-5 border-b border-gray-200/80 dark:border-neutral-800 flex items-center justify-between gap-3 shrink-0 bg-white dark:bg-[#1e1f20] transition-colors">
        {/* 左侧：菜单切换 + 今天按钮 + 翻周箭头 + 月份年份 */}
        <div className="flex items-center gap-2 sm:gap-3">
          {onOpenMobileMenu && (
            <button
              type="button"
              onClick={onOpenMobileMenu}
              className="md:hidden p-2 rounded-full text-gray-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 transition cursor-pointer"
              title="打开侧边菜单"
            >
              <Menu className="w-5 h-5" />
            </button>
          )}

          {/* 桌面端切换左抽屉 */}
          <button
            type="button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="hidden md:flex p-2 rounded-full text-gray-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 transition cursor-pointer"
            title={sidebarOpen ? '收起左侧面板' : '展开左侧面板'}
          >
            {sidebarOpen ? <PanelLeftClose className="w-5 h-5" /> : <PanelLeft className="w-5 h-5" />}
          </button>

          {/* Google 经典圆角药丸 Today 按钮 */}
          <button
            type="button"
            onClick={() => setWeekStart(startOfWeek(new Date()))}
            className="px-4 py-1.5 rounded-full border border-gray-300 dark:border-neutral-700 hover:bg-gray-100 dark:hover:bg-neutral-800 text-xs font-medium text-gray-700 dark:text-neutral-200 transition cursor-pointer"
          >
            {t('common.today', '今天')}
          </button>

          {/* 上一周 / 下一周 翻页按钮 */}
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => setWeekStart((prev) => addDays(prev, -7))}
              aria-label="Previous week"
              className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-neutral-800 text-gray-600 dark:text-neutral-300 transition cursor-pointer"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={() => setWeekStart((prev) => addDays(prev, 7))}
              aria-label="Next week"
              className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-neutral-800 text-gray-600 dark:text-neutral-300 transition cursor-pointer"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>

          {/* 月份年份标题 (如: November 2026 / 2026年11月) */}
          <h2 className="text-lg sm:text-xl font-normal text-gray-800 dark:text-gray-100 tracking-tight ml-1 sm:ml-2">
            {formatMonthHeading(weekStart, language)}
          </h2>
        </div>

        {/* 右侧：重排、日历管理、导出与刷新 */}
        <div className="flex items-center gap-2">
          {loading && (
            <span className="text-xs text-blue-600 dark:text-blue-400 font-medium hidden sm:flex items-center gap-1.5">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span>{t('common.loading')}</span>
            </span>
          )}

          <button
            onClick={handleSyncAndReplanAll}
            disabled={replanLoading}
            title={t('calendar.replan')}
            className="hidden sm:flex items-center gap-1.5 px-3.5 py-1.5 bg-blue-50 dark:bg-blue-950/60 hover:bg-blue-100 dark:hover:bg-blue-900/60 text-blue-700 dark:text-blue-300 border border-blue-200/90 dark:border-blue-800 rounded-full text-xs font-medium transition cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${replanLoading ? 'animate-spin' : ''}`} />
            <span>{replanLoading ? '正在重排' : '重排全部'}</span>
          </button>

          <button
            onClick={() => setShowExportModal(true)}
            title={t('calendar.export_btn')}
            className="p-2 sm:px-3 sm:py-1.5 rounded-full border border-gray-300 dark:border-neutral-700 hover:bg-gray-100 dark:hover:bg-neutral-800 text-gray-700 dark:text-neutral-200 text-xs font-medium transition cursor-pointer flex items-center gap-1"
          >
            <Share2 className="w-4 h-4 text-gray-600 dark:text-neutral-300" />
            <span className="hidden sm:inline">{t('calendar.export_btn')}</span>
          </button>

          <button
            onClick={() => setShowCalendarsModal(true)}
            className="p-2 sm:px-3 sm:py-1.5 rounded-full border border-gray-300 dark:border-neutral-700 hover:bg-gray-100 dark:hover:bg-neutral-800 text-gray-700 dark:text-neutral-200 text-xs font-medium transition cursor-pointer flex items-center gap-1.5"
            title={t('calendar.manage_btn')}
          >
            <CalendarIcon className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            <span className="hidden sm:inline">{t('calendar.manage_btn')}</span>
            {subscriptions.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 font-mono">
                {subscriptions.length}
              </span>
            )}
          </button>

          <button
            onClick={() => fetchData()}
            className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-neutral-800 text-gray-600 dark:text-neutral-300 transition cursor-pointer"
            title={t('calendar.refresh_btn')}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {/* 2. 主体区：左侧 Google Calendar 抽屉 + 右侧周视图网格 */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* 左侧抽屉 (Google Calendar Left Sidebar: 迷你月历 + 待办清单) */}
        {sidebarOpen && (
          <aside className="w-64 xl:w-72 shrink-0 overflow-y-auto overflow-x-hidden p-4 space-y-5 scrollbar-thin hidden md:flex flex-col bg-white dark:bg-[#1e1f20]">
            {/* Google Calendar 经典迷你月历组件 */}
            <div className="bg-transparent select-none">
              <div className="flex items-center justify-between mb-2 px-1">
                <span className="text-xs font-semibold text-gray-800 dark:text-gray-200">
                  {miniMonthDate.getFullYear()}年 {miniMonthDate.getMonth() + 1}月
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setMiniMonthDate(new Date(miniMonthDate.getFullYear(), miniMonthDate.getMonth() - 1, 1))}
                    className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-neutral-800 text-gray-500 cursor-pointer"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setMiniMonthDate(new Date(miniMonthDate.getFullYear(), miniMonthDate.getMonth() + 1, 1))}
                    className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-neutral-800 text-gray-500 cursor-pointer"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* 星期缩写行 (周一至周日) */}
              <div className="grid grid-cols-7 text-center text-[10px] font-medium text-gray-400 dark:text-neutral-500 mb-1">
                <span>一</span>
                <span>二</span>
                <span>三</span>
                <span>四</span>
                <span>五</span>
                <span>六</span>
                <span>日</span>
              </div>

              {/* 日期网格 */}
              <div className="grid grid-cols-7 gap-y-0.5 text-center text-xs">
                {miniCalendarGrid.map((item, idx) => {
                  const isToday = item.key === todayKey;
                  const itemTime = item.date.getTime();
                  const weekStartTime = weekStart.getTime();
                  const weekEndTime = addDays(weekStart, 7).getTime();
                  const isCurrentWeek = itemTime >= weekStartTime && itemTime < weekEndTime;

                  return (
                    <button
                      key={`mini-${idx}-${item.key}`}
                      type="button"
                      onClick={() => setWeekStart(startOfWeek(item.date))}
                      className={`h-7 w-7 mx-auto rounded-full flex items-center justify-center text-[11px] transition cursor-pointer ${
                        isToday
                          ? 'bg-blue-600 text-white font-bold'
                          : isCurrentWeek
                          ? 'bg-blue-100 dark:bg-blue-950/80 text-blue-700 dark:text-blue-300 font-semibold'
                          : item.isCurrentMonth
                          ? 'text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800'
                          : 'text-gray-300 dark:text-neutral-600'
                      }`}
                    >
                      {item.date.getDate()}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 我的日历列表 (Google Calendar 经典抽屉列表) */}
            <div className="space-y-2 pt-2 border-t border-gray-100 dark:border-neutral-800">
              <div className="flex items-center justify-between text-xs font-semibold text-gray-800 dark:text-gray-200">
                <span>我的日历</span>
                <span className="text-[10px] text-gray-400 font-normal">
                  {subscriptions.length + 1} 个源
                </span>
              </div>
              <div className="space-y-1 text-xs">
                {/* Clawbot 主待办 */}
                <div className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-neutral-800/60">
                  <span className="w-3 h-3 rounded-sm bg-blue-600 shrink-0" />
                  <span className="text-gray-700 dark:text-neutral-300 truncate">Clawbot 待办日程</span>
                </div>
                {/* 订阅外部日历 */}
                {subscriptions.map((sub, idx) => {
                  const color = CALENDAR_PALETTE[idx % CALENDAR_PALETTE.length];
                  return (
                    <div
                      key={sub.id}
                      className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-gray-50 dark:hover:bg-neutral-800/60 group"
                    >
                      <div className="flex items-center gap-2.5 truncate min-w-0">
                        <span
                          className="w-3 h-3 rounded-sm shrink-0"
                          style={{ backgroundColor: color }}
                        />
                        <span className="text-gray-700 dark:text-neutral-300 truncate">{sub.name}</span>
                      </div>
                      <span className="text-[10px] text-gray-400 font-mono shrink-0">
                        {sub.event_count}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 截止待办提醒 (Due Tasks) */}
            <div className="space-y-2 pt-2 border-t border-gray-100 dark:border-neutral-800 flex-1">
              <div className="flex items-center justify-between text-xs font-semibold text-gray-800 dark:text-gray-200">
                <span>{t('calendar.due_title', '截止待办')}</span>
                {overdueTasks.length > 0 && (
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-rose-100 dark:bg-rose-950 text-rose-600 dark:text-rose-400 font-bold">
                    逾期 {overdueTasks.length}
                  </span>
                )}
              </div>

              <div className="space-y-1.5">
                {overdueTasks.slice(0, 4).map((t) => (
                  <button
                    key={`overdue-${t.id}`}
                    type="button"
                    onClick={() => setSelectedDueTask(t)}
                    className="w-full text-left p-2 rounded-xl bg-rose-50/70 dark:bg-rose-950/30 hover:bg-rose-100/70 dark:hover:bg-rose-900/40 border border-rose-200/60 dark:border-rose-900/60 transition cursor-pointer"
                  >
                    <div className="text-xs font-medium text-rose-700 dark:text-rose-300 truncate">
                      {t.title}
                    </div>
                    <div className="text-[10px] text-rose-500 font-mono mt-0.5">
                      {t.deadline ? new Date(t.deadline).toLocaleDateString() : '已逾期'} · {t.duration_minutes}m
                    </div>
                  </button>
                ))}

                {dueGroups.slice(0, 3).map((group) => (
                  <div key={`due-grp-${group.key}`} className="space-y-1">
                    <div className="text-[10px] text-gray-400 font-medium px-1 mt-2">
                      {group.date.getMonth() + 1}月{group.date.getDate()}日 ({weekDayLabels[(group.date.getDay() + 6) % 7]})
                    </div>
                    {group.due.slice(0, 3).map((t) => (
                      <button
                        key={`due-${t.id}`}
                        type="button"
                        onClick={() => setSelectedDueTask(t)}
                        className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-neutral-800 transition cursor-pointer flex items-center justify-between text-xs"
                      >
                        <span className="truncate text-gray-700 dark:text-neutral-300">{t.title}</span>
                        <span className="text-[10px] text-gray-400 font-mono shrink-0 ml-1">
                          {t.duration_minutes}m
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </aside>
        )}

        {/* 右侧核心：Google Calendar 经典 Week 视图网格 */}
        <div
          ref={scrollRef}
          className="flex-1 bg-white dark:bg-[#1e1f20] overflow-y-auto overflow-x-auto overscroll-contain relative transition-colors scrollbar-thin"
        >
          <div
            className="grid min-w-[780px] bg-white dark:bg-[#1e1f20]"
            style={{
              gridTemplateColumns: '56px repeat(7, minmax(0, 1fr))',
            }}
          >
            {/* ================= Row 1: Sticky Day Headers ================= */}
            {/* 时区单元格 (左上角) */}
            <div className="sticky top-0 z-30 h-18 bg-white dark:bg-[#1e1f20] border-b border-gray-200/80 dark:border-neutral-800 flex items-end justify-end pr-2 pb-1 text-[11px] font-mono text-gray-400 dark:text-neutral-500 select-none">
              GMT+8
            </div>

            {/* 7 个日期列表头 (Google Calendar 经典星期 + 圆圈日期) */}
            {dayData.map((d) => {
              const isToday = d.key === todayKey;
              const dayOfWeek = (d.date.getDay() + 6) % 7; // 0 is Mon, 6 is Sun
              return (
                <div
                  key={`head-${d.key}`}
                  className="sticky top-0 z-30 h-18 flex flex-col items-center justify-center border-l border-b border-gray-200/80 dark:border-neutral-800 bg-white dark:bg-[#1e1f20] select-none py-1"
                >
                  {/* 星期简写 (SUN / 周日) */}
                  <span
                    className={`text-[11px] uppercase tracking-wider font-medium leading-none ${
                      isToday
                        ? 'text-blue-600 dark:text-blue-400 font-bold'
                        : 'text-gray-500 dark:text-neutral-400'
                    }`}
                  >
                    {weekDayLabels[dayOfWeek]}
                  </span>

                  {/* Google 经典圆圈日期号 */}
                  <button
                    type="button"
                    onClick={() => setWeekStart(startOfWeek(d.date))}
                    className={`w-10 h-10 mt-1 rounded-full flex items-center justify-center text-xl transition cursor-pointer ${
                      isToday
                        ? 'bg-blue-600 text-white font-medium shadow-xs'
                        : 'text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-neutral-800 font-normal'
                    }`}
                  >
                    {d.date.getDate()}
                  </button>
                </div>
              );
            })}

            {/* ================= Row 2: Sticky All-Day Row ================= */}
            <div className="sticky top-18 z-20 min-h-[32px] bg-white dark:bg-[#1e1f20] border-b border-gray-200/80 dark:border-neutral-800 flex items-center justify-end px-2 text-[10px] text-gray-400 dark:text-neutral-500 font-medium">
              {t('calendar.all_day', '全天')}
            </div>

            {dayData.map((d) => (
              <div
                key={`allday-${d.key}`}
                className="sticky top-18 z-20 min-h-[32px] bg-white dark:bg-[#1e1f20] border-l border-b border-gray-200/80 dark:border-neutral-800 p-1 flex flex-col gap-1"
              >
                {d.allDay.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => openCalendarItem(item)}
                    className="w-full text-left text-[11px] font-medium px-2 py-0.5 rounded-[4px] truncate text-white shadow-2xs hover:brightness-95 transition cursor-pointer"
                    style={{ backgroundColor: item.color }}
                  >
                    {item.title}
                  </button>
                ))}
              </div>
            ))}

            {/* ================= Row 3: 24-Hour Time Grid (00:00 to 23:59) ================= */}
            {/* 时间轴刻度栏 */}
            <div
              data-calendar-timeline
              className="relative select-none bg-white dark:bg-[#1e1f20]"
              style={{ height: GRID_HEIGHT }}
            >
              {Array.from({ length: CALENDAR_HOURS }, (_, hour) => (
                <span
                  key={`hour-label-${hour}`}
                  className="absolute right-2 text-[10px] sm:text-[11px] text-gray-400 dark:text-neutral-500 font-normal -translate-y-1/2 pr-1"
                  style={{ top: hour * HOUR_HEIGHT }}
                >
                  {formatHourLabel(hour, language)}
                </span>
              ))}
            </div>

            {/* 7 个日历天的主体列 */}
            {dayData.map((d) => {
              const isToday = d.key === todayKey;

              return (
                <div
                  key={`col-${d.key}`}
                  data-calendar-timeline
                  className="relative border-l border-gray-200/80 dark:border-neutral-800 bg-white dark:bg-[#1e1f20]"
                  style={{ height: GRID_HEIGHT }}
                >
                  {/* 水平整点网格细线 */}
                  {Array.from({ length: CALENDAR_HOURS }, (_, i) => (
                    <div
                      key={`line-${i}`}
                      className="absolute left-0 right-0 border-b border-gray-100 dark:border-neutral-800/70 pointer-events-none"
                      style={{ top: i * HOUR_HEIGHT, height: HOUR_HEIGHT }}
                    />
                  ))}

                  {/* Google Calendar 经典当前时间红线与红点指示器 */}
                  {isToday && (
                    <div
                      className="absolute left-0 right-0 z-20 pointer-events-none flex items-center"
                      style={{ top: `${currentLineTop}px` }}
                    >
                      <div className="w-3 h-3 rounded-full bg-[#EA4335] -ml-1.5 shrink-0 shadow-xs" />
                      <div className="flex-1 h-[2px] bg-[#EA4335]" />
                    </div>
                  )}

                  {/* Google Calendar 风格日程与待办卡片 */}
                  {d.timed.map((pos) => {
                    const seg = pos.item;
                    const startD = new Date(seg.start);
                    const endD = new Date(seg.end);

                    const startMinutes = Math.max(0, Math.round((startD.getTime() - d.windowStartMs) / 60000));
                    const endMinutes = Math.min(24 * 60, Math.round((endD.getTime() - d.windowStartMs) / 60000));
                    const durationMinutes = Math.max(15, endMinutes - startMinutes);

                    const top = (startMinutes / 60) * HOUR_HEIGHT;
                    const height = Math.max(16, (durationMinutes / 60) * HOUR_HEIGHT - 2);
                    const widthPct = 100 / pos.columns;
                    const leftPct = pos.column * widthPct;

                    const isTask = seg.kind === 'task';
                    const isCompact = height < 28;

                    return (
                      <button
                        key={seg.id}
                        type="button"
                        onClick={() => openCalendarItem(seg)}
                        title={`${seg.title} (${formatTime(seg.start)} - ${formatTime(seg.end)})`}
                        className={`absolute rounded p-1 text-left transition-all z-10 hover:z-20 shadow-xs hover:shadow-md hover:brightness-95 cursor-pointer overflow-hidden border-l-[3.5px] leading-tight ${
                          isCompact ? 'flex items-center gap-1.5 py-0 px-1.5' : ''
                        }`}
                        style={{
                          top: `${top}px`,
                          height: `${height}px`,
                          left: `${leftPct}%`,
                          width: `calc(${widthPct}% - 2px)`,
                          borderLeftColor: seg.color,
                          backgroundColor: isDark
                            ? `color-mix(in srgb, ${seg.color} 35%, #202124)`
                            : `color-mix(in srgb, ${seg.color} 18%, #ffffff)`,
                        }}
                      >
                        {isCompact ? (
                          <div className="flex items-center gap-1.5 w-full min-w-0">
                            <span
                              className="text-[10px] font-semibold truncate leading-tight flex-1"
                              style={{ color: isDark ? '#ffffff' : '#1f2937' }}
                            >
                              {seg.title}
                            </span>
                            <span
                              className="text-[9px] font-mono shrink-0 opacity-75"
                              style={{ color: isDark ? '#e5e7eb' : '#4b5563' }}
                            >
                              {formatTime(seg.start)}
                            </span>
                          </div>
                        ) : (
                          <>
                            {/* 标题 */}
                            <div
                              className="text-[11px] font-semibold truncate leading-tight"
                              style={{ color: isDark ? '#ffffff' : '#1f2937' }}
                            >
                              {seg.title}
                            </div>

                            {/* 时间段 */}
                            <div
                              className="text-[10px] font-mono truncate mt-0.5 opacity-80"
                              style={{ color: isDark ? '#e5e7eb' : '#4b5563' }}
                            >
                              {formatTime(seg.start)} – {formatTime(seg.end)}
                            </div>

                            {/* 附属标签 (高度充足时展示) */}
                            {height >= 44 && (
                              <div
                                className="text-[9px] truncate mt-0.5 opacity-70 font-medium"
                                style={{ color: isDark ? '#d1d5db' : '#6b7280' }}
                              >
                                {isTask ? seg.qName : seg.event.subscriptionName || '外部日程'}
                              </div>
                            )}
                          </>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ===================== 对话框与模态框 ===================== */}
      {/* 1. 日历订阅与同步管理模态框 */}
      {showCalendarsModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#1e1f20] rounded-3xl max-w-lg w-full p-6 shadow-2xl space-y-4 border border-gray-200 dark:border-neutral-800 animate-fadeIn transition-colors">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-neutral-800">
              <h3 className="text-base font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <CalendarIcon className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                <span>日历订阅与同步源</span>
              </h3>
              <button
                onClick={() => setShowCalendarsModal(false)}
                className="w-8 h-8 rounded-full text-gray-400 hover:bg-gray-100 dark:hover:bg-neutral-800 flex items-center justify-center text-sm font-bold transition cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Clawbot 导出地址 */}
            <div className="p-3 bg-gray-50 dark:bg-[#28292a] rounded-xl border border-gray-200/80 dark:border-neutral-700/80 space-y-1.5 text-xs">
              <label className="block font-semibold text-gray-700 dark:text-neutral-300 text-[11px]">
                Clawbot 专属待办日历 (导出到 Apple / Google / Outlook)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={icalExportUrl}
                  className="w-full px-3 py-1.5 bg-white dark:bg-[#232425] border border-gray-200 dark:border-neutral-700 rounded-lg font-mono text-[11px] text-gray-700 dark:text-neutral-300 select-all"
                />
                <button
                  type="button"
                  onClick={() => handleCopyLink(icalExportUrl, 'calendars-modal')}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg shrink-0 flex items-center gap-1 transition cursor-pointer"
                >
                  {copiedType === 'calendars-modal' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedType === 'calendars-modal' ? '已复制' : '复制'}</span>
                </button>
              </div>
            </div>

            {/* 添加外部 iCal 订阅 */}
            <form onSubmit={handleAddSubscription} className="space-y-2 pt-1 text-xs">
              <span className="font-bold text-gray-800 dark:text-gray-200 text-xs">
                + 导入外部 iCal 订阅
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  type="text"
                  value={newSubName}
                  onChange={(e) => setNewSubName(e.target.value)}
                  placeholder="日历名称 (例如: 公司会议)"
                  className="px-3 py-2 bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700 rounded-xl outline-none"
                  required
                />
                <input
                  type="url"
                  value={newSubUrl}
                  onChange={(e) => setNewSubUrl(e.target.value)}
                  placeholder="https://... 订阅 URL"
                  className="px-3 py-2 bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700 rounded-xl outline-none"
                  required
                />
              </div>
              <div className="flex justify-end pt-1">
                <button
                  type="submit"
                  disabled={submittingSub}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium rounded-xl transition cursor-pointer shadow-xs"
                >
                  {submittingSub ? '添加中...' : '确认添加订阅'}
                </button>
              </div>
            </form>

            {/* 已订阅日历列表 */}
            <div className="space-y-2 pt-2 border-t border-gray-100 dark:border-neutral-800">
              <span className="font-bold text-gray-800 dark:text-gray-200 text-xs">已订阅日历</span>
              {subscriptions.length === 0 ? (
                <div className="text-gray-400 text-xs py-3 text-center">暂无外部订阅源</div>
              ) : (
                <div className="space-y-2 max-h-48 overflow-y-auto pr-1 scrollbar-thin">
                  {subscriptions.map((s, idx) => {
                    const color = CALENDAR_PALETTE[idx % CALENDAR_PALETTE.length];
                    return (
                      <div
                        key={s.id}
                        className="flex items-center justify-between p-2.5 bg-gray-50 dark:bg-[#252627] rounded-xl border border-gray-200/80 dark:border-neutral-800 text-xs"
                      >
                        <div className="flex items-center gap-2.5 truncate flex-1 min-w-0">
                          <span
                            className="w-3 h-3 rounded-full shrink-0"
                            style={{ backgroundColor: color }}
                          />
                          <div className="truncate">
                            <span className="font-semibold text-gray-900 dark:text-gray-100">
                              {s.name}
                            </span>
                            <div className="text-[10px] text-gray-400 truncate font-mono">
                              {s.event_count} 个事件 · {s.sync_status === 'ok' ? '已同步' : '同步异常'}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0 ml-2">
                          <button
                            type="button"
                            onClick={() => handleSyncSubscription(s.id)}
                            className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-gray-200 dark:hover:bg-neutral-700 rounded-lg transition cursor-pointer"
                            title="立即同步"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteSubscription(s.id)}
                            className="p-1.5 text-gray-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition cursor-pointer"
                            title="删除订阅"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 2. 导出订阅链接模态框 */}
      {showExportModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#1e1f20] rounded-3xl max-w-lg w-full p-6 shadow-2xl space-y-4 border border-gray-200 dark:border-neutral-800 animate-fadeIn transition-colors">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-neutral-800">
              <h3 className="text-base font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <Share2 className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                <span>导出 Clawbot 待办日历</span>
              </h3>
              <button
                onClick={() => setShowExportModal(false)}
                className="w-8 h-8 rounded-full text-gray-400 hover:bg-gray-100 dark:hover:bg-neutral-800 flex items-center justify-center text-sm font-bold transition cursor-pointer"
              >
                ✕
              </button>
            </div>


            {/* HTTPS 日历订阅链接 */}
            <div className="p-3 bg-gray-50 dark:bg-[#252627] rounded-xl border border-gray-200/80 dark:border-neutral-800 space-y-1.5 text-xs">
              <div className="font-semibold text-gray-800 dark:text-neutral-200">
                日历订阅链接
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={icalExportUrl}
                  className="w-full px-3 py-1.5 bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-700 rounded-lg font-mono text-[11px] select-all"
                />
                <button
                  type="button"
                  onClick={() => handleCopyLink(icalExportUrl, 'http')}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium shrink-0 flex items-center gap-1 transition cursor-pointer"
                >
                  {copiedType === 'http' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedType === 'http' ? '已复制' : '复制'}</span>
                </button>
              </div>
            </div>

            {/* 静态 .ics 文件下载 */}
            <div className="p-3 bg-gray-50 dark:bg-[#252627] rounded-xl border border-gray-200/80 dark:border-neutral-800 flex items-center justify-between text-xs">
              <div>
                <div className="font-semibold text-gray-800 dark:text-neutral-200">
                  下载静态 .ics 文件
                </div>
                <div className="text-[11px] text-gray-400">单次导入快照，不自动跟随后续更新</div>
              </div>
              <a
                href={downloadUrl}
                download="clawbot-tasks.ics"
                className="px-3 py-1.5 border border-gray-300 dark:border-neutral-700 hover:bg-gray-100 dark:hover:bg-neutral-800 text-gray-700 dark:text-neutral-200 rounded-lg font-medium flex items-center gap-1.5 transition cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>下载文件</span>
              </a>
            </div>


          </div>
        </div>
      )}

      {editingTask && (
        <TaskModal
          isOpen
          initialTask={editInitialTask(editingTask)}
          onClose={() => { setEditingTask(null); setEditError(''); }}
          onSave={(data) => { void saveCalendarTask(editingTask.id, data); }}
          onToggleComplete={() => { void handleCompleteTask(editingTask.id); }}
          onDelete={() => { void handleDeleteCalendarTask(editingTask.id); }}
        />
      )}
      {editError && <div role="alert" className="fixed bottom-5 right-5 z-[110] rounded-xl bg-rose-600 px-4 py-3 text-xs text-white shadow-lg">{editError}</div>}

      {/* 3. 日程或待办详情模态框 */}
      {selectedItem && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#1e1f20] rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-4 border border-gray-200 dark:border-neutral-800 animate-fadeIn transition-colors">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <span
                  className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold text-white uppercase tracking-wider"
                  style={{ backgroundColor: selectedItem.color }}
                >
                  {selectedItem.kind === 'task' ? `Clawbot · ${selectedItem.qName}` : '外部订阅日程'}
                </span>
                <h3 className="text-base font-bold text-gray-900 dark:text-gray-100">
                  {selectedItem.title}
                </h3>
              </div>
              <button
                onClick={() => setSelectedItem(null)}
                className="w-8 h-8 rounded-full text-gray-400 hover:bg-gray-100 dark:hover:bg-neutral-800 flex items-center justify-center text-sm font-bold transition cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="p-3 bg-gray-50 dark:bg-[#252627] rounded-xl space-y-2 text-xs">
              <div className="flex items-center gap-2 text-gray-600 dark:text-neutral-300">
                <Clock className="w-4 h-4 text-gray-400" />
                <span>
                  {formatTime(selectedItem.start)} – {formatTime(selectedItem.end)} ({selectedItem.allDay ? '全天' : '定时'})
                </span>
              </div>
              {selectedItem.kind === 'task' && (
                <>
                  <div className="text-[11px] text-gray-500 dark:text-neutral-400">
                    四象限分类: <span className="font-semibold text-gray-700 dark:text-neutral-200">{selectedItem.qName}</span>
                  </div>
                  {(Boolean(selectedItem.task.is_fixed) || Boolean(selectedItem.task.is_concurrent)) && (
                    <div className="flex gap-1.5 mt-1">
                      {Boolean(selectedItem.task.is_fixed) && (
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-indigo-100 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300">
                          📌 固定时间任务
                        </span>
                      )}
                      {Boolean(selectedItem.task.is_concurrent) && (
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300">
                          ⚡ 双线程任务
                        </span>
                      )}
                    </div>
                  )}
                  {selectedItem.task.notes && (
                    <div className="mt-1 pt-1 border-t border-gray-200/80 dark:border-neutral-700 text-gray-600 dark:text-neutral-300 text-[11px] whitespace-pre-wrap">
                      {selectedItem.task.notes}
                    </div>
                  )}
                </>
              )}
            </div>

            {selectedItem.kind === 'task' && (
              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={() => handleDeleteCalendarTask(selectedItem.task.id)}
                  className="px-3 py-1.5 text-xs text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-xl transition cursor-pointer"
                >
                  删除事项
                </button>
                <div className="flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => { setEditingTask(selectedItem.task); setSelectedItem(null); }}
                    className="px-3 py-1.5 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 text-xs font-semibold rounded-xl transition cursor-pointer"
                  >
                    编辑任务
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      setPlanning({ title: '正在重新安排任务', status: 'working' });
                      try {
                        const response = await api.post(`/tasks/${selectedItem.task.id}/reschedule`);
                        setSelectedItem(null);
                        setPlanning({ title: '任务已重新安排', status: 'success', detail: response.data.message });
                        await fetchData();
                      } catch (error) {
                        const err = error as { response?: { data?: { error?: string } } };
                        setPlanning({ title: '重新排程失败', status: 'error', detail: err.response?.data?.error || '请重试' });
                      }
                    }}
                    className="px-3 py-1.5 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 text-xs font-semibold rounded-xl transition cursor-pointer"
                  >
                    重新排程
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCompletePart(selectedItem.task.id)}
                    className="px-3.5 py-1.5 border border-blue-600 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40 text-xs font-semibold rounded-xl transition cursor-pointer"
                  >
                    完成本节
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCompleteTask(selectedItem.task.id)}
                    className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl shadow-xs transition cursor-pointer"
                  >
                    全部完成
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 4. 截止待办详情模态框 */}
      {selectedDueTask && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#1e1f20] rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-4 border border-gray-200 dark:border-neutral-800 animate-fadeIn transition-colors">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400">
                  截止待办
                </span>
                <h3 className="text-base font-bold text-gray-900 dark:text-gray-100 mt-0.5">
                  {selectedDueTask.title}
                </h3>
              </div>
              <button
                onClick={() => setSelectedDueTask(null)}
                className="w-8 h-8 rounded-full text-gray-400 hover:bg-gray-100 dark:hover:bg-neutral-800 flex items-center justify-center text-sm font-bold transition cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="p-3 bg-gray-50 dark:bg-[#252627] rounded-xl space-y-1.5 text-xs">
              <div className="flex items-center justify-between text-gray-600 dark:text-neutral-300">
                <span>截止时间:</span>
                <span className="font-mono font-semibold">
                  {selectedDueTask.deadline ? new Date(selectedDueTask.deadline).toLocaleString() : '未设置'}
                </span>
              </div>
              <div className="flex items-center justify-between text-gray-600 dark:text-neutral-300">
                <span>预估耗时:</span>
                <span className="font-mono">{selectedDueTask.duration_minutes} 分钟</span>
              </div>
              {selectedDueTask.notes && (
                <div className="pt-2 border-t border-gray-200/80 dark:border-neutral-700 text-gray-600 dark:text-neutral-300 whitespace-pre-wrap">
                  {selectedDueTask.notes}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={() => handleDeleteCalendarTask(selectedDueTask.id)}
                className="px-3 py-1.5 text-xs text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-xl transition cursor-pointer"
              >
                删除事项
              </button>
              <button
                type="button"
                onClick={() => { setEditingTask(selectedDueTask); setSelectedDueTask(null); }}
                className="px-3 py-1.5 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 text-xs font-semibold rounded-xl transition cursor-pointer"
              >
                编辑任务
              </button>
              <button
                type="button"
                onClick={() => handleCompleteTask(selectedDueTask.id)}
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl shadow-xs transition cursor-pointer"
              >
                完成事项
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
