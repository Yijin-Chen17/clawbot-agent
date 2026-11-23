import { copyText } from '../utils/clipboard';
import { TaskModal, type TaskModalSavePayload } from './TaskModal';
import type { TaskItem as EditableTask } from '../types/task';
import { inferTierFromScore, type ImpactSignal, type TimeMode, type UrgencyPace } from '../utils/priorityAlgorithm';
import { PlanningProgress, type PlanningState } from './PlanningProgress';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { normalizeScoreTo100 } from '../utils/priorityAlgorithm';
import { CalendarColorPicker } from './CalendarColorPicker';
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
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
  Sun,
  Moon,
  Monitor,
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
  color?: string | null;
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
      blockId?: string;
      partIndex?: number;
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


interface CalendarViewProps {
  onOpenMobileMenu?: () => void;
  onNewTask?: () => void;
  isActive?: boolean;
}

export const CalendarView: React.FC<CalendarViewProps> = ({ onOpenMobileMenu, isActive = true }) => {
  const { user } = useAuth();
  const { isDark, t, language, themeMode, setThemeMode } = useTheme();

  const cycleTheme = () => {
    if (themeMode === 'light') {
      setThemeMode('dark');
    } else if (themeMode === 'dark') {
      setThemeMode('system');
    } else {
      setThemeMode('light');
    }
  };
  const [viewMode, setViewMode] = useState<'week' | 'month'>('week');
  const [overflowDayKey, setOverflowDayKey] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const selectDate = (date: Date) => {
    setSelectedDate(date);
    setWeekStart(startOfWeek(date));
  };
  const [events, setEvents] = useState<CalendarEventItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [subscriptions, setSubscriptions] = useState<CalendarSubscription[]>([]);
  const [loading, setLoading] = useState(true);

  // Left sidebar collapse toggle (Google Calendar main drawer toggle)
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [taskCalendarColor, setTaskCalendarColor] = useState<string | null>(null);

  // Mini calendar collapse toggle
  const [miniCalendarCollapsed, setMiniCalendarCollapsed] = useState(false);

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
      isCompleted: task.status === 'completed' || (task.time_mode === 'daily_fixed' && (() => { try { return JSON.parse(task.completed_dates || '[]').includes(localDateKey(new Date())); } catch { return false; } })()),
      tags: (() => { try { const raw = (task as any).tags; if (Array.isArray(raw)) return raw; const p = JSON.parse(raw || '[]'); return Array.isArray(p) ? p : []; } catch { return []; } })(),
      createdAt: task.created_at || new Date().toISOString(),
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
        tags: data.tags || [],
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
  const webcalUrl = icalExportUrl.replace(/^https?:\/\//i, 'webcal://');
  const downloadUrl = serverExportUrls?.download || (effectiveToken ? `${window.location.origin}/api/calendar/export/${effectiveToken}.ics` : '');

  // Live timer for red current time line
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  // Keep the selected date visible, including weeks that span two months.
  useEffect(() => {
    setMiniMonthDate(new Date(selectedDate));
  }, [selectedDate]);

  const handleCopyLink = async (linkToCopy: string, type: string) => {
    const ok = await copyText(linkToCopy);
    if (ok) {
      setCopiedType(type);
      setTimeout(() => setCopiedType(null), 2000);
    } else {
      alert(`请手动复制：\n${linkToCopy}`);
    }
  };

  const activeMonthYear = selectedDate.getFullYear();
  const activeMonthIndex = selectedDate.getMonth();

  const monthGrid = useMemo(() => {
    const firstDayOfMonth = new Date(activeMonthYear, activeMonthIndex, 1);
    const dayOfWeek = firstDayOfMonth.getDay();
    const startOffset = (dayOfWeek + 6) % 7; // Monday = 0, Sunday = 6
    const daysInMonth = new Date(activeMonthYear, activeMonthIndex + 1, 0).getDate();
    const gridStart = new Date(activeMonthYear, activeMonthIndex, 1 - startOffset);
    gridStart.setHours(0, 0, 0, 0);

    return Array.from({ length: 42 }, (_, idx) => {
      const date = addDays(gridStart, idx);
      const isCurrentMonth =
        date.getFullYear() === activeMonthYear &&
        date.getMonth() === activeMonthIndex &&
        date.getDate() <= daysInMonth;
      return {
        date,
        isCurrentMonth,
        key: localDateKey(date),
      };
    });
  }, [activeMonthYear, activeMonthIndex]);

  const fetchData = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const rangeStart =
        viewMode === 'month'
          ? monthGrid[0].date.toISOString()
          : addDays(weekStart, -7).toISOString();
      const rangeEnd =
        viewMode === 'month'
          ? addDays(monthGrid[41].date, 1).toISOString()
          : addDays(weekStart, 14).toISOString();
      const [eventsRes, tasksRes] = await Promise.all([
        api.get('/calendar/events', { params: { start: rangeStart, end: rangeEnd } }),
        api.get('/tasks'),
      ]);
      setEvents(eventsRes.data.events || []);
      setSubscriptions(eventsRes.data.subscriptions || []);
      setTaskCalendarColor(eventsRes.data.taskColor || null);
      setTasks(tasksRes.data.tasks || []);
      if (eventsRes.data.exportUrls) {
        setServerExportUrls(eventsRes.data.exportUrls);
      }
    } catch (err) {
      console.error('Failed to load calendar data:', err);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [weekStart, viewMode, activeMonthYear, activeMonthIndex]);

  // When tab becomes active, silently re-fetch to keep synced with tasks modified in other tabs
  const hasLoadedOnceRef = useRef(false);
  useEffect(() => {
    if (isActive) {
      if (hasLoadedOnceRef.current) {
        fetchData(true);
      } else {
        hasLoadedOnceRef.current = true;
      }
    }
  }, [isActive]);

  // Auto-scroll to morning hours (08:00) on mount / week change / activation
  useEffect(() => {
    if (isActive && scrollRef.current) {
      const now = new Date();
      const targetHour = Math.max(7, now.getHours() - 1);
      scrollRef.current.scrollTop = targetHour * HOUR_HEIGHT;
    }
  }, [isActive, weekStart]);

  // Bind to the current week's columns, which are replaced when the week changes.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !isActive) return;
    const columns = Array.from(container.querySelectorAll<HTMLElement>('[data-calendar-timeline]'));
    if (!columns.length) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let offset = 0;
    let touch: { id: number; x: number; y: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const render = (value: number, animate: boolean) => {
      columns.forEach(column => {
        column.style.transition = animate && !reducedMotion.matches
          ? 'transform 350ms cubic-bezier(.22, 1.2, .36, 1)' : 'none';
        column.style.transform = `translateY(${value}px)`;
      });
    };
    const reset = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (!offset) return;
      offset = 0;
      render(0, true);
    };
    const pull = (delta: number) => {
      if (!delta || reducedMotion.matches) return false;
      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
      const top = container.scrollTop <= 0.5;
      const bottom = container.scrollTop >= maxScroll - 0.5;
      // Consume the reverse gesture to release the stretch before scrolling inward.
      if (offset && Math.sign(delta) === Math.sign(offset)) {
        offset = Math.sign(offset) * Math.max(0, Math.abs(offset) - Math.abs(delta) * 0.45);
        render(offset, false);
        return true;
      }
      if (!((top && delta < 0) || (bottom && delta > 0))) return false;
      offset = Math.max(-36, Math.min(36, offset - delta * 0.22 * (1 - Math.abs(offset) / 45)));
      render(offset, false);
      return true;
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? container.clientHeight : 1);
      if (pull(delta)) {
        event.preventDefault();
        if (timer) clearTimeout(timer);
        timer = setTimeout(reset, 100);
      } else if (offset) reset();
    };
    const start = (event: TouchEvent) => {
      if (event.touches.length !== 1) { touch = null; reset(); return; }
      const point = event.touches[0];
      touch = { id: point.identifier, x: point.clientX, y: point.clientY };
      if (timer) clearTimeout(timer);
    };
    const move = (event: TouchEvent) => {
      if (!touch || event.touches.length !== 1) { touch = null; reset(); return; }
      const point = Array.from(event.touches).find(item => item.identifier === touch!.id);
      if (!point) return;
      const dx = touch.x - point.clientX;
      const dy = touch.y - point.clientY;
      touch.x = point.clientX;
      touch.y = point.clientY;
      if (Math.abs(dy) > Math.abs(dx) && pull(dy) && event.cancelable) event.preventDefault();
      else if (offset && Math.abs(dx) > Math.abs(dy)) reset();
    };
    const end = (event: TouchEvent) => {
      if (touch && Array.from(event.changedTouches).some(point => point.identifier === touch!.id)) {
        touch = null;
        reset();
      }
    };
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
  }, [isActive, weekStart]);

  // Map subscriptions to colors
  const subColorMap = useMemo(() => {
    const map = new Map<number, string>();
    subscriptions.forEach((s, idx) => {
      map.set(s.id, s.color || CALENDAR_PALETTE[idx % CALENDAR_PALETTE.length]);
    });
    return map;
  }, [subscriptions]);

  const todayKey = localDateKey(new Date());
  const weekStartKey = localDateKey(weekStart);

  const buildDayEntry = useCallback((date: Date) => {
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

      let blocks: { id?: string; start: string; end: string; partIndex?: number; totalParts?: number; completed?: boolean }[] = [];

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
            blockId: block.id,
            partIndex: block.partIndex || bIdx + 1,
            title: `${titlePrefix}${t.title}${partSuffix}`,
            start: range.start,
            end: range.end,
            allDay: false,
            color: taskCalendarColor || (blockDone ? '#10B981' : quad.color),
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
  }, [events, tasks, subColorMap, taskCalendarColor]);

  // 7 Days Data (Monday through Sunday)
  const dayData = useMemo(() => {
    return Array.from({ length: 7 }, (_, index) => buildDayEntry(addDays(weekStart, index)));
  }, [weekStart, buildDayEntry]);

  // 42 Days Data for Month View
  const monthDayData = useMemo(() => {
    if (viewMode !== 'month') return [];
    return monthGrid.map((cell) => ({
      ...buildDayEntry(cell.date),
      isCurrentMonth: cell.isCurrentMonth,
    }));
  }, [viewMode, monthGrid, buildDayEntry]);

  const overflowDayData = useMemo(() => {
    if (!overflowDayKey) return null;
    return monthDayData.find((d) => d.key === overflowDayKey) || null;
  }, [overflowDayKey, monthDayData]);

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

  const updateColor = async (id: number | 'tasks', color: string | null) => {
    try {
      await api.put(`/calendar/colors/${id}`, { color });
      if (id === 'tasks') setTaskCalendarColor(color);
      else setSubscriptions(current => current.map(sub => sub.id === id ? { ...sub, color } : sub));
    } catch {
      alert('保存日历颜色失败，请重试');
    }
  };

  // Handlers for subscriptions & replanning
  const handleAddSubscription = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSubName.trim() || !newSubUrl.trim()) return;
    setSubmittingSub(true);
    try {
      const response = await api.post('/calendar/subscriptions', {
        name: newSubName.trim(),
        url: newSubUrl.trim(),
      });
      setNewSubName('');
      setNewSubUrl('');
      await fetchData();
      if (response.data.message?.includes('初次同步失败')) alert(response.data.message);
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

  const handleCompletePart = async (taskId: number, blockId?: string, partIndex?: number) => {
    try {
      const res = await api.post(`/tasks/${taskId}/complete-part`, {
        ...(blockId ? { block_id: blockId } : {}),
        ...(partIndex ? { part_index: partIndex } : {}),
      });
      alert(res.data.message);
      setSelectedItem(null);
      setSelectedDueTask(null);
      fetchData();
    } catch (err: any) {
      alert(err.response?.data?.error || '操作失败');
    }
  };

  const handleCompleteTask = async (taskId: number, reopen = false) => {
    try {
      await api.post(`/tasks/${taskId}/action`, { action: reopen ? 'reopen' : 'complete' });
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
      <header className="min-h-14 px-2 sm:px-5 py-2 border-b border-gray-200/80 dark:border-[#444746] flex flex-wrap items-center justify-between gap-1 sm:gap-3 shrink-0 bg-white dark:bg-[#1e1f20] transition-colors">
        {/* 左侧：菜单切换 + 今天按钮 + 翻周箭头 + 月份年份 */}
        <div className="flex items-center gap-1 sm:gap-3 min-w-0">
          {onOpenMobileMenu && (
            <button
              type="button"
              onClick={onOpenMobileMenu}
              className="md:hidden p-2 rounded-full text-gray-600 dark:text-[#c4c7c5] hover:bg-gray-100 dark:hover:bg-[#282a2c] transition cursor-pointer"
              title="打开侧边菜单"
            >
              <Menu className="w-5 h-5" />
            </button>
          )}

          {/* 桌面端切换左抽屉 */}
          <button
            type="button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="hidden md:flex p-2 rounded-full text-gray-600 dark:text-[#c4c7c5] hover:bg-gray-100 dark:hover:bg-[#282a2c] transition cursor-pointer"
            title={sidebarOpen ? '收起左侧面板' : '展开左侧面板'}
          >
            {sidebarOpen ? <PanelLeftClose className="w-5 h-5" /> : <PanelLeft className="w-5 h-5" />}
          </button>

          {/* Google 经典圆角药丸 Today 按钮 */}
          <button
            type="button"
            onClick={() => selectDate(new Date())}
            className="px-4 py-1.5 rounded-full border border-gray-300 dark:border-[#444746] hover:bg-gray-100 dark:hover:bg-[#282a2c] text-xs font-medium text-gray-700 dark:text-[#e3e3e3] transition cursor-pointer"
          >
            {t('common.today', '今天')}
          </button>

          {/* 上一周期 / 下一周期 翻页按钮 */}
          <div className="flex items-center">
            <button
              type="button"
              onClick={() =>
                viewMode === 'month'
                  ? selectDate(new Date(activeMonthYear, activeMonthIndex - 1, 1))
                  : selectDate(addDays(selectedDate, -7))
              }
              aria-label={viewMode === 'month' ? 'Previous month' : 'Previous week'}
              className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-[#282a2c] text-gray-600 dark:text-[#c4c7c5] transition cursor-pointer"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={() =>
                viewMode === 'month'
                  ? selectDate(new Date(activeMonthYear, activeMonthIndex + 1, 1))
                  : selectDate(addDays(selectedDate, 7))
              }
              aria-label={viewMode === 'month' ? 'Next month' : 'Next week'}
              className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-[#282a2c] text-gray-600 dark:text-[#c4c7c5] transition cursor-pointer"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>

          {/* 月份年份标题 (如: November 2026 / 2026年11月) */}
          <h2 className="text-sm sm:text-xl font-normal text-gray-800 dark:text-gray-100 tracking-tight ml-1 sm:ml-2 whitespace-nowrap">
            {viewMode === 'month'
              ? language.startsWith('zh')
                ? `${activeMonthYear}年${activeMonthIndex + 1}月`
                : selectedDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
              : formatMonthHeading(weekStart, language)}
          </h2>
        </div>

        {/* 右侧：视图切换(周/月)、重排、日历管理、导出与刷新 */}
        <div className="flex items-center gap-2">
          <div
            className="inline-flex items-center rounded-full border border-gray-300 dark:border-[#444746] p-0.5 bg-gray-50/70 dark:bg-[#282a2c]"
            role="group"
            aria-label="日历视图切换"
          >
            <button
              type="button"
              onClick={() => setViewMode('week')}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                viewMode === 'week'
                  ? 'bg-white dark:bg-[#1e1f20] text-blue-600 dark:text-[#a8c7fa] shadow-2xs'
                  : 'text-gray-600 dark:text-[#c4c7c5] hover:text-gray-900 dark:hover:text-gray-100'
              }`}
            >
              {language.startsWith('zh') ? '周' : 'Week'}
            </button>
            <button
              type="button"
              onClick={() => setViewMode('month')}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer ${
                viewMode === 'month'
                  ? 'bg-white dark:bg-[#1e1f20] text-blue-600 dark:text-[#a8c7fa] shadow-2xs'
                  : 'text-gray-600 dark:text-[#c4c7c5] hover:text-gray-900 dark:hover:text-gray-100'
              }`}
            >
              {language.startsWith('zh') ? '月' : 'Month'}
            </button>
          </div>
          <button
            onClick={handleSyncAndReplanAll}
            disabled={replanLoading}
            title={t('calendar.replan')}
            className="flex items-center gap-1.5 px-2 sm:px-3.5 py-1.5 bg-blue-50 dark:bg-blue-950/60 hover:bg-blue-100 dark:hover:bg-blue-900/60 text-blue-700 dark:text-[#a8c7fa] border border-blue-200/90 dark:border-blue-800 rounded-full text-xs font-medium transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${replanLoading ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">{replanLoading ? '正在重排' : '重排全部'}</span>
          </button>

          <button
            onClick={() => setShowExportModal(true)}
            title={t('calendar.export_btn')}
            className="p-2 sm:px-3 sm:py-1.5 rounded-full border border-gray-300 dark:border-[#444746] hover:bg-gray-100 dark:hover:bg-[#282a2c] text-gray-700 dark:text-[#e3e3e3] text-xs font-medium transition-colors cursor-pointer flex items-center gap-1"
          >
            <Share2 className="w-4 h-4 text-gray-600 dark:text-[#c4c7c5]" />
            <span className="hidden sm:inline">{t('calendar.export_btn')}</span>
          </button>

          <button
            onClick={() => setShowCalendarsModal(true)}
            className="p-2 sm:px-3 sm:py-1.5 rounded-full border border-gray-300 dark:border-[#444746] hover:bg-gray-100 dark:hover:bg-[#282a2c] text-gray-700 dark:text-[#e3e3e3] text-xs font-medium transition-colors cursor-pointer flex items-center gap-1.5"
            title={t('calendar.manage_btn')}
          >
            <CalendarIcon className="w-4 h-4 text-blue-600 dark:text-[#a8c7fa]" />
            <span className="hidden sm:inline">{t('calendar.manage_btn')}</span>
            {subscriptions.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-[#a8c7fa] font-mono">
                {subscriptions.length}
              </span>
            )}
          </button>

          <button
            onClick={() => fetchData()}
            className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-[#282a2c] text-gray-600 dark:text-[#c4c7c5] transition-colors cursor-pointer"
            title={t('calendar.refresh_btn')}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>

          {/* 主题模式切换 (亮色 / 暗色 / 系统) */}
          <button
            type="button"
            onClick={cycleTheme}
            className="p-2 rounded-full hover:bg-gray-100 dark:hover:bg-[#282a2c] text-gray-600 dark:text-[#c4c7c5] transition-colors cursor-pointer"
            title={
              themeMode === 'light'
                ? '当前：亮色模式 (点击切换为暗色)'
                : themeMode === 'dark'
                ? '当前：暗色模式 (点击切换为跟随系统)'
                : '当前：跟随系统 (点击切换为亮色)'
            }
          >
            {themeMode === 'light' && <Sun className="w-4 h-4 text-amber-500" />}
            {themeMode === 'dark' && <Moon className="w-4 h-4 text-blue-400" />}
            {themeMode === 'system' && <Monitor className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* 2. 主体区：左侧 Google Calendar 抽屉 + 右侧周视图网格 */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* 左侧抽屉 (Google Calendar Left Sidebar: 迷你月历 + 待办清单) */}
        <div
          className={`hidden md:block shrink-0 overflow-hidden transition-all duration-300 ease-in-out motion-reduce:transition-none ${
            sidebarOpen ? 'w-64 xl:w-72 opacity-100' : 'w-0 opacity-0 pointer-events-none'
          }`}
          style={{
            transition: 'width 300ms cubic-bezier(0.4, 0, 0.2, 1), opacity 300ms cubic-bezier(0.4, 0, 0.2, 1)',
          }}
          aria-hidden={!sidebarOpen}
          inert={!sidebarOpen}
        >
          <aside
            className={`w-64 xl:w-72 h-full overflow-y-auto overflow-x-hidden p-4 space-y-5 scrollbar-thin flex flex-col bg-white dark:bg-[#1e1f20] border-r border-gray-200/80 dark:border-[#444746] transition-transform duration-300 ease-in-out ${
              sidebarOpen ? 'translate-x-0' : '-translate-x-full'
            }`}
            style={{
              transition: 'transform 300ms cubic-bezier(0.4, 0, 0.2, 1)',
            }}
          >
            {/* Google Calendar 经典迷你月历组件 (支持带动画平滑折叠) */}
            <div className="bg-transparent select-none">
              <div className="flex items-center justify-between mb-2 px-1">
                <button
                  type="button"
                  onClick={() => setMiniCalendarCollapsed((prev) => !prev)}
                  className="flex items-center gap-1.5 text-xs font-semibold text-gray-800 dark:text-gray-200 hover:text-blue-600 dark:hover:text-blue-400 transition cursor-pointer select-none group"
                  title={miniCalendarCollapsed ? '展开迷你月历' : '折叠迷你月历'}
                >
                  <span>
                    {miniMonthDate.getFullYear()}年 {miniMonthDate.getMonth() + 1}月
                  </span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 text-gray-400 group-hover:text-blue-500 transition-transform duration-300 ease-in-out ${
                      miniCalendarCollapsed ? '-rotate-90' : 'rotate-0'
                    }`}
                  />
                </button>
                <div
                  className={`flex items-center gap-1 transition-opacity duration-200 ${
                    miniCalendarCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setMiniMonthDate(new Date(miniMonthDate.getFullYear(), miniMonthDate.getMonth() - 1, 1))}
                    className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-[#282a2c] text-gray-500 cursor-pointer"
                    title="上个月"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setMiniMonthDate(new Date(miniMonthDate.getFullYear(), miniMonthDate.getMonth() + 1, 1))}
                    className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-[#282a2c] text-gray-500 cursor-pointer"
                    title="下个月"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* 星期缩写行 + 日期网格 (带丝滑折叠动画) */}
              <div
                className="grid transition-all duration-300 ease-in-out"
                style={{
                  gridTemplateRows: miniCalendarCollapsed ? '0fr' : '1fr',
                  opacity: miniCalendarCollapsed ? 0 : 1,
                  transition: 'grid-template-rows 300ms cubic-bezier(0.4, 0, 0.2, 1), opacity 300ms cubic-bezier(0.4, 0, 0.2, 1)',
                }}
              >
                <div className="overflow-hidden">
                  {/* 星期缩写行 (周一至周日) */}
                  <div className="grid grid-cols-7 text-center text-[10px] font-medium text-gray-400 dark:text-[#8e918f] mb-1">
                    <span>一</span>
                    <span>二</span>
                    <span>三</span>
                    <span>四</span>
                    <span>五</span>
                    <span>六</span>
                    <span>日</span>
                  </div>

                  {/* 日期网格 */}
                  <div className="grid grid-cols-7 gap-y-0.5 text-center text-xs pb-1">
                    {miniCalendarGrid.map((item, idx) => {
                      const isToday = item.key === todayKey;
                      const isSelected = item.key === localDateKey(selectedDate);

                      return (
                        <button
                          key={`mini-${idx}-${item.key}`}
                          type="button"
                          onClick={() => selectDate(item.date)}
                          aria-pressed={isSelected}
                          aria-current={isToday ? 'date' : undefined}
                          className={`h-7 w-7 mx-auto rounded-full flex items-center justify-center text-[11px] transition cursor-pointer ${
                            isToday
                              ? `bg-blue-700 dark:bg-blue-700 text-white font-bold ${isSelected ? 'ring-2 ring-blue-300 dark:ring-blue-300 ring-offset-2 dark:ring-offset-[#1e1f20]' : ''}`
                              : isSelected
                              ? 'bg-blue-100 dark:bg-[#304468] text-blue-700 dark:text-[#a8c7fa] font-semibold'
                              : item.isCurrentMonth
                              ? 'text-gray-700 dark:text-[#e3e3e3] hover:bg-gray-100 dark:hover:bg-[#282a2c]'
                              : 'text-gray-300 dark:text-neutral-600'
                          }`}
                        >
                          {item.date.getDate()}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* 我的日历列表 (Google Calendar 经典抽屉列表，支持多色调色盘选择修改) */}
            <div className="space-y-2 pt-2 border-t border-gray-100 dark:border-[#444746]">
              <div className="flex items-center justify-between text-xs font-semibold text-gray-800 dark:text-gray-200">
                <span>我的日历</span>
                <span className="text-[10px] text-gray-400 font-normal">
                  {subscriptions.length + 1} 个源
                </span>
              </div>
              <div className="space-y-1 text-xs">
                {/* Clawbot 主待办 */}
                <div className="flex items-center justify-between h-8 px-2 rounded-lg hover:bg-gray-50 dark:hover:bg-[#282a2c] transition-colors">
                  <div className="flex items-center gap-2.5 truncate min-w-0">
                    <CalendarColorPicker
                      color={taskCalendarColor || '#3b82f6'}
                      name="Clawbot 待办日程"
                      onChange={(c) => void updateColor('tasks', c)}
                      onReset={() => void updateColor('tasks', null)}
                    />
                    <span className="text-gray-700 dark:text-[#c4c7c5] truncate font-medium select-none">
                      Clawbot 待办日程
                    </span>
                  </div>
                </div>
                {/* 订阅外部日历 */}
                {subscriptions.map((sub, idx) => {
                  const color = sub.color || CALENDAR_PALETTE[idx % CALENDAR_PALETTE.length];
                  return (
                    <div
                      key={sub.id}
                      className="flex items-center justify-between h-8 px-2 rounded-lg hover:bg-gray-50 dark:hover:bg-[#282a2c] transition-colors"
                    >
                      <div className="flex items-center gap-2.5 truncate min-w-0">
                        <CalendarColorPicker
                          color={color}
                          name={sub.name}
                          onChange={(c) => void updateColor(sub.id, c)}
                          onReset={() => void updateColor(sub.id, null)}
                        />
                        <span className="text-gray-700 dark:text-[#c4c7c5] truncate select-none">{sub.name}</span>
                      </div>
                      <span className="text-[10px] text-gray-400 font-mono shrink-0 ml-1">
                        {sub.event_count}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 截止待办提醒 (Due Tasks) */}
            <div className="space-y-2 pt-2 border-t border-gray-100 dark:border-[#444746] flex-1">
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
                        className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-[#282a2c] transition cursor-pointer flex items-center justify-between text-xs"
                      >
                        <span className="truncate text-gray-700 dark:text-[#c4c7c5]">{t.title}</span>
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
        </div>

        {/* 右侧核心：Google Calendar Week / Month 视图 */}
        {viewMode === 'month' ? (
          <div className="relative flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-white dark:bg-[#1e1f20]">
            {/* 月视图星期表头 (周一 ~ 周日) */}
            <div className="grid grid-cols-7 border-b border-gray-200/80 dark:border-[#444746] bg-white dark:bg-[#1e1f20] shrink-0">
              {weekDayLabels.map((label) => (
                <div
                  key={`month-head-${label}`}
                  className="py-2 text-center text-[11px] font-medium uppercase tracking-wider text-gray-500 dark:text-[#c4c7c5] border-l first:border-l-0 border-gray-200/80 dark:border-[#444746]"
                >
                  {label}
                </div>
              ))}
            </div>

            {/* 7x6 月历网格 */}
            <div className="flex-1 min-h-0 grid grid-cols-7 grid-rows-6 overflow-y-auto scrollbar-thin">
              {monthDayData.map((d) => {
                const isToday = d.key === todayKey;
                const isSelected = d.key === localDateKey(selectedDate);
                const sortedTimed = [...d.timed]
                  .map((p) => p.item)
                  .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
                const combinedItems: TimedSegment[] = [...d.allDay, ...sortedTimed];
                const maxVisible = 3;
                const visibleItems = combinedItems.slice(0, maxVisible);
                const extraCount = combinedItems.length - visibleItems.length;

                return (
                  <div
                    key={`month-cell-${d.key}`}
                    className={`min-h-[96px] border-l border-b border-gray-200/80 dark:border-[#2b2d2f] first:border-l-0 [&:nth-child(7n+1)]:border-l-0 p-1 sm:p-1.5 flex flex-col gap-1 transition-colors ${
                      d.isCurrentMonth
                        ? 'bg-white dark:bg-[#1e1f20]'
                        : 'bg-gray-50/60 dark:bg-[#191a1b]'
                    }`}
                  >
                    {/* 日期角标与截止角标 */}
                    <div className="flex items-center justify-between gap-1 px-0.5">
                      <button
                        type="button"
                        onClick={() => {
                          selectDate(d.date);
                          setViewMode('week');
                        }}
                        title="切换到该周视图"
                        className={`h-6 min-w-6 px-1.5 rounded-full flex items-center justify-center text-xs transition cursor-pointer ${
                          isToday
                            ? 'bg-blue-600 text-white font-bold shadow-2xs'
                            : isSelected
                            ? 'bg-blue-100 dark:bg-[#304468] text-blue-700 dark:text-[#a8c7fa] font-semibold'
                            : d.isCurrentMonth
                            ? 'text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-[#282a2c] font-medium'
                            : 'text-gray-400 dark:text-neutral-500 hover:bg-gray-100 dark:hover:bg-[#282a2c]'
                        }`}
                      >
                        {d.date.getDate() === 1
                          ? `${d.date.getMonth() + 1}月1日`
                          : d.date.getDate()}
                      </button>

                      {d.due.length > 0 && (
                        <span
                          className="text-[10px] px-1.5 py-0.2 rounded-full bg-rose-50 dark:bg-rose-950/50 text-rose-600 dark:text-rose-300 font-medium"
                          title={`当天截止待办 ${d.due.length} 项`}
                        >
                          截止 {d.due.length}
                        </span>
                      )}
                    </div>

                    {/* 当天全天日程 & 排程待办列表 */}
                    <div className="flex flex-col gap-0.5 min-w-0 flex-1 overflow-hidden">
                      {visibleItems.map((seg) => (
                        <button
                          key={`m-${d.key}-${seg.id}`}
                          type="button"
                          onClick={() => openCalendarItem(seg)}
                          title={
                            seg.allDay
                              ? `${seg.title} (全天)`
                              : `${seg.title} (${formatTime(seg.start)} - ${formatTime(seg.end)})`
                          }
                          className="w-full text-left px-1.5 py-0.5 rounded-[4px] text-[11px] leading-tight truncate flex items-center gap-1 transition cursor-pointer hover:brightness-95"
                          style={
                            seg.allDay
                              ? { backgroundColor: seg.color, color: '#ffffff' }
                              : {
                                  borderLeft: `3px solid ${seg.color}`,
                                  backgroundColor: isDark
                                    ? `color-mix(in srgb, ${seg.color} 28%, #202124)`
                                    : `color-mix(in srgb, ${seg.color} 15%, #ffffff)`,
                                  color: isDark ? '#f3f4f6' : '#1f2937',
                                }
                          }
                        >
                          {!seg.allDay && (
                            <span className="text-[10px] font-mono opacity-75 shrink-0">
                              {formatTime(seg.start)}
                            </span>
                          )}
                          <span className="truncate font-medium">{seg.title}</span>
                        </button>
                      ))}

                      {extraCount > 0 && (
                        <button
                          type="button"
                          onClick={() => setOverflowDayKey(d.key)}
                          className="text-left px-1.5 py-0.5 rounded text-[10px] font-medium text-blue-600 dark:text-[#a8c7fa] hover:bg-blue-50 dark:hover:bg-blue-950/40 transition cursor-pointer"
                        >
                          +{extraCount} 更多
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
        <div className="relative flex-1 min-w-0 min-h-0 overflow-hidden">
        <div
          ref={scrollRef}
          className="h-full bg-white dark:bg-[#1e1f20] overflow-y-auto overflow-x-auto overscroll-contain relative transition-colors scrollbar-thin"
        >
          <div
            className="grid min-w-[560px] sm:min-w-[780px] pb-8 bg-white dark:bg-[#1e1f20]"
            style={{
              gridTemplateColumns: '56px repeat(7, minmax(0, 1fr))',
            }}
          >
            {/* ================= Row 1: Sticky Day Headers ================= */}
            {/* 时区单元格 (左上角) */}
            <div className="sticky top-0 z-30 h-18 bg-white dark:bg-[#1e1f20] border-b border-gray-200/80 dark:border-[#444746] flex items-end justify-end pr-2 pb-1 text-[11px] font-mono text-gray-400 dark:text-[#8e918f] select-none">
              GMT+8
            </div>

            {/* 7 个日期列表头 (Google Calendar 经典星期 + 圆圈日期) */}
            {dayData.map((d) => {
              const isToday = d.key === todayKey;
              const dayOfWeek = (d.date.getDay() + 6) % 7; // 0 is Mon, 6 is Sun
              return (
                <div
                  key={`head-${d.key}`}
                  className="sticky top-0 z-30 h-18 flex flex-col items-center justify-center border-l border-b border-gray-200/80 dark:border-[#444746] bg-white dark:bg-[#1e1f20] select-none py-1"
                >
                  {/* 星期简写 (SUN / 周日) */}
                  <span
                    className={`text-[11px] uppercase tracking-wider font-medium leading-none ${
                      isToday
                        ? 'text-blue-600 dark:text-[#a8c7fa] font-bold'
                        : 'text-gray-500 dark:text-[#c4c7c5]'
                    }`}
                  >
                    {weekDayLabels[dayOfWeek]}
                  </span>

                  {/* Google 经典圆圈日期号 */}
                  <button
                    type="button"
                    onClick={() => selectDate(d.date)}
                    className={`w-10 h-10 mt-1 rounded-full flex items-center justify-center text-xl transition cursor-pointer ${
                      isToday
                        ? 'bg-blue-600 text-white font-medium shadow-xs'
                        : 'text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-[#282a2c] font-normal'
                    }`}
                  >
                    {d.date.getDate()}
                  </button>
                </div>
              );
            })}

            {/* ================= Row 2: Sticky All-Day Row ================= */}
            <div className="calendar-allday-fade sticky top-18 z-20 min-h-[32px] bg-white dark:bg-[#1e1f20] border-b border-gray-200/80 dark:border-[#444746] flex items-center justify-end px-2 text-[10px] text-gray-400 dark:text-[#8e918f] font-medium">
              {t('calendar.all_day', '全天')}
            </div>

            {dayData.map((d) => (
              <div
                key={`allday-${d.key}`}
                className="calendar-allday-fade sticky top-18 z-20 min-h-[32px] bg-white dark:bg-[#1e1f20] border-l border-b border-gray-200/80 dark:border-[#444746] p-1 flex flex-col gap-1"
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
                  className="absolute right-2 text-[10px] sm:text-[11px] text-gray-400 dark:text-[#8e918f] font-normal -translate-y-1/2 pr-1"
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
                  className="relative border-l border-gray-200/80 dark:border-[#2b2d2f] bg-white dark:bg-[#1e1f20]"
                  style={{ height: GRID_HEIGHT }}
                >
                  {/* 水平整点网格细线 */}
                  {Array.from({ length: CALENDAR_HOURS }, (_, i) => (
                    <div
                      key={`line-${i}`}
                      className="absolute left-0 right-0 border-b border-gray-100 dark:border-[#2b2d2f] pointer-events-none"
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
                            ? `color-mix(in srgb, ${seg.color} 35%, #1e1f20)`
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
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-8 bg-gradient-to-t from-white/95 to-transparent dark:from-[#1e1f20]/95 dark:to-transparent backdrop-blur-[3px]"
          style={{ maskImage: 'linear-gradient(to top, black, transparent)', WebkitMaskImage: 'linear-gradient(to top, black, transparent)' }}
        />
        </div>
        )}
      </div>

      {/* ===================== 对话框与模态框 ===================== */}
      {/* 1. 日历订阅与同步管理模态框 */}
      {showCalendarsModal && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#1e1f20] rounded-3xl max-w-lg w-full p-6 shadow-2xl space-y-4 border border-gray-200 dark:border-[#444746] animate-fadeIn transition-colors">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-[#444746]">
              <h3 className="text-base font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <CalendarIcon className="w-5 h-5 text-blue-600 dark:text-[#a8c7fa]" />
                <span>日历订阅与同步源</span>
              </h3>
              <button
                onClick={() => setShowCalendarsModal(false)}
                className="w-8 h-8 rounded-full text-gray-400 hover:bg-gray-100 dark:hover:bg-[#282a2c] flex items-center justify-center text-sm font-bold transition cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Clawbot 导出地址 */}
            <div className="p-3 bg-gray-50 dark:bg-[#28292a] rounded-xl border border-gray-200/80 dark:border-[#444746]/80 space-y-1.5 text-xs">
              <label className="block font-semibold text-gray-700 dark:text-[#c4c7c5] text-[11px]">
                Clawbot 专属待办日历 (导出到 Apple / Google / Outlook)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={icalExportUrl}
                  className="w-full px-3 py-1.5 bg-white dark:bg-[#282a2c] border border-gray-200 dark:border-[#444746] rounded-lg font-mono text-[11px] text-gray-700 dark:text-[#c4c7c5] select-all"
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
                  className="px-3 py-2 bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-[#444746] rounded-xl outline-none"
                  required
                />
                <input
                  type="text"
                  inputMode="url"
                  value={newSubUrl}
                  onChange={(e) => setNewSubUrl(e.target.value)}
                  placeholder="webcal:// 或 https:// 订阅链接"
                  className="px-3 py-2 bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-[#444746] rounded-xl outline-none"
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
            <div className="space-y-2 pt-2 border-t border-gray-100 dark:border-[#444746]">
              <span className="font-bold text-gray-800 dark:text-gray-200 text-xs">已订阅日历</span>
              {subscriptions.length === 0 ? (
                <div className="text-gray-400 text-xs py-3 text-center">暂无外部订阅源</div>
              ) : (
                <div className="space-y-2 max-h-48 overflow-y-auto pr-1 scrollbar-thin">
                  {subscriptions.map((s, idx) => {
                    const color = s.color || CALENDAR_PALETTE[idx % CALENDAR_PALETTE.length];
                    return (
                      <div
                        key={s.id}
                        className="flex items-center justify-between p-2.5 bg-gray-50 dark:bg-[#282a2c] rounded-xl border border-gray-200/80 dark:border-[#444746] text-xs"
                      >
                        <div className="flex items-center gap-2.5 truncate flex-1 min-w-0">
                          <CalendarColorPicker
                            color={color}
                            name={s.name}
                            onChange={(c) => void updateColor(s.id, c)}
                            onReset={() => void updateColor(s.id, null)}
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
          <div className="bg-white dark:bg-[#1e1f20] rounded-3xl max-w-lg w-full p-6 shadow-2xl space-y-4 border border-gray-200 dark:border-[#444746] animate-fadeIn transition-colors">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-[#444746]">
              <h3 className="text-base font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <Share2 className="w-5 h-5 text-blue-600 dark:text-[#a8c7fa]" />
                <span>导出 Clawbot 待办日历</span>
              </h3>
              <button
                onClick={() => setShowExportModal(false)}
                className="w-8 h-8 rounded-full text-gray-400 hover:bg-gray-100 dark:hover:bg-[#282a2c] flex items-center justify-center text-sm font-bold transition cursor-pointer"
              >
                ✕
              </button>
            </div>


            {/* HTTPS 日历订阅链接 */}
            <div className="p-3 bg-gray-50 dark:bg-[#282a2c] rounded-xl border border-gray-200/80 dark:border-[#444746] space-y-1.5 text-xs">
              <div className="font-semibold text-gray-800 dark:text-[#e3e3e3]">
                日历订阅链接
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={icalExportUrl}
                  className="w-full px-3 py-1.5 bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-[#444746] rounded-lg font-mono text-[11px] select-all"
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

            <div className="p-3 bg-gray-50 dark:bg-[#282a2c] rounded-xl border border-gray-200/80 dark:border-[#444746] space-y-1.5 text-xs">
              <div className="font-semibold text-gray-800 dark:text-[#e3e3e3]">Webcal 订阅链接</div>
              <div className="flex items-center gap-2">
                <input type="text" readOnly value={webcalUrl} aria-label="Webcal 订阅链接" className="w-full px-3 py-1.5 bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-[#444746] rounded-lg font-mono text-[11px] select-all" />
                <button type="button" onClick={() => handleCopyLink(webcalUrl, 'webcal')} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-medium shrink-0 flex items-center gap-1 transition cursor-pointer">
                  {copiedType === 'webcal' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedType === 'webcal' ? '已复制' : '复制'}</span>
                </button>
              </div>
              {webcalUrl && <a href={webcalUrl} className="inline-block text-blue-600 dark:text-[#a8c7fa] hover:underline">在日历应用中订阅</a>}
            </div>

            {/* 静态 .ics 文件下载 */}
            <div className="p-3 bg-gray-50 dark:bg-[#282a2c] rounded-xl border border-gray-200/80 dark:border-[#444746] flex items-center justify-between text-xs">
              <div>
                <div className="font-semibold text-gray-800 dark:text-[#e3e3e3]">
                  下载静态 .ics 文件
                </div>
                <div className="text-[11px] text-gray-400">单次导入快照，不自动跟随后续更新</div>
              </div>
              <a
                href={downloadUrl}
                download="clawbot-tasks.ics"
                className="px-3 py-1.5 border border-gray-300 dark:border-[#444746] hover:bg-gray-100 dark:hover:bg-[#282a2c] text-gray-700 dark:text-[#e3e3e3] rounded-lg font-medium flex items-center gap-1.5 transition cursor-pointer"
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
          onToggleComplete={() => { void handleCompleteTask(editingTask.id, editInitialTask(editingTask).isCompleted); }}
          onDelete={() => { void handleDeleteCalendarTask(editingTask.id); }}
        />
      )}
      {editError && <div role="alert" className="fixed bottom-5 right-5 z-[110] rounded-xl bg-rose-600 px-4 py-3 text-xs text-white shadow-lg">{editError}</div>}

      {/* 3. 日程或待办详情模态框 */}
      {selectedItem && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#1e1f20] rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-4 border border-gray-200 dark:border-[#444746] animate-fadeIn transition-colors">
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
                className="w-8 h-8 rounded-full text-gray-400 hover:bg-gray-100 dark:hover:bg-[#282a2c] flex items-center justify-center text-sm font-bold transition cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="p-3 bg-gray-50 dark:bg-[#282a2c] rounded-xl space-y-2 text-xs">
              <div className="flex items-center gap-2 text-gray-600 dark:text-[#c4c7c5]">
                <Clock className="w-4 h-4 text-gray-400" />
                <span>
                  {formatTime(selectedItem.start)} – {formatTime(selectedItem.end)} ({selectedItem.allDay ? '全天' : '定时'})
                </span>
              </div>
              {selectedItem.kind === 'task' && (
                <>
                  <div className="text-[11px] text-gray-500 dark:text-[#c4c7c5]">
                    四象限分类: <span className="font-semibold text-gray-700 dark:text-[#e3e3e3]">{selectedItem.qName}</span>
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
                    <div className="mt-1 pt-1 border-t border-gray-200/80 dark:border-[#444746] text-gray-600 dark:text-[#c4c7c5] text-[11px] whitespace-pre-wrap">
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
                    className="px-3 py-1.5 text-blue-600 dark:text-[#a8c7fa] hover:bg-blue-50 dark:hover:bg-blue-950/40 text-xs font-semibold rounded-xl transition cursor-pointer"
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
                    className="px-3 py-1.5 text-blue-600 dark:text-[#a8c7fa] hover:bg-blue-50 dark:hover:bg-blue-950/40 text-xs font-semibold rounded-xl transition cursor-pointer"
                  >
                    重新排程
                  </button>
                  {selectedItem.qName !== '已完成' && <button
                    type="button"
                    onClick={() => handleCompletePart(selectedItem.task.id, selectedItem.blockId, selectedItem.partIndex)}
                    className="px-3.5 py-1.5 border border-blue-600 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40 text-xs font-semibold rounded-xl transition cursor-pointer"
                  >
                    完成本节
                  </button>}
                  <button
                    type="button"
                    onClick={() => handleCompleteTask(selectedItem.task.id, selectedItem.qName === '已完成')}
                    className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl shadow-xs transition cursor-pointer"
                  >
                    {selectedItem.qName === '已完成' ? '标记为未完成' : '全部完成'}
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
          <div className="bg-white dark:bg-[#1e1f20] rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-4 border border-gray-200 dark:border-[#444746] animate-fadeIn transition-colors">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-blue-600 dark:text-[#a8c7fa]">
                  截止待办
                </span>
                <h3 className="text-base font-bold text-gray-900 dark:text-gray-100 mt-0.5">
                  {selectedDueTask.title}
                </h3>
              </div>
              <button
                onClick={() => setSelectedDueTask(null)}
                className="w-8 h-8 rounded-full text-gray-400 hover:bg-gray-100 dark:hover:bg-[#282a2c] flex items-center justify-center text-sm font-bold transition cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="p-3 bg-gray-50 dark:bg-[#282a2c] rounded-xl space-y-1.5 text-xs">
              <div className="flex items-center justify-between text-gray-600 dark:text-[#c4c7c5]">
                <span>截止时间:</span>
                <span className="font-mono font-semibold">
                  {selectedDueTask.deadline ? new Date(selectedDueTask.deadline).toLocaleString() : '未设置'}
                </span>
              </div>
              <div className="flex items-center justify-between text-gray-600 dark:text-[#c4c7c5]">
                <span>预估耗时:</span>
                <span className="font-mono">{selectedDueTask.duration_minutes} 分钟</span>
              </div>
              {selectedDueTask.notes && (
                <div className="pt-2 border-t border-gray-200/80 dark:border-[#444746] text-gray-600 dark:text-[#c4c7c5] whitespace-pre-wrap">
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
                className="px-3 py-1.5 text-blue-600 dark:text-[#a8c7fa] hover:bg-blue-50 dark:hover:bg-blue-950/40 text-xs font-semibold rounded-xl transition cursor-pointer"
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
      {/* 5. 月视图某日全部事项弹窗 */}
      {overflowDayData && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#1e1f20] rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-4 border border-gray-200 dark:border-[#444746] animate-fadeIn transition-colors">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-[#444746]">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-blue-600 dark:text-[#a8c7fa]">
                  当日全部安排
                </span>
                <h3 className="text-base font-bold text-gray-900 dark:text-gray-100 mt-0.5">
                  {overflowDayData.date.getFullYear()}年{overflowDayData.date.getMonth() + 1}月{overflowDayData.date.getDate()}日
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setOverflowDayKey(null)}
                className="w-8 h-8 rounded-full text-gray-400 hover:bg-gray-100 dark:hover:bg-[#282a2c] flex items-center justify-center text-sm font-bold transition cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1 scrollbar-thin">
              {[...overflowDayData.allDay, ...[...overflowDayData.timed].map((p) => p.item).sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())].map((seg) => (
                <button
                  key={`ov-${overflowDayData.key}-${seg.id}`}
                  type="button"
                  onClick={() => {
                    setOverflowDayKey(null);
                    openCalendarItem(seg);
                  }}
                  className="w-full text-left px-3 py-2 rounded-xl text-xs flex items-center justify-between gap-2 transition cursor-pointer hover:brightness-95"
                  style={
                    seg.allDay
                      ? { backgroundColor: seg.color, color: '#ffffff' }
                      : {
                          borderLeft: `4px solid ${seg.color}`,
                          backgroundColor: isDark
                            ? `color-mix(in srgb, ${seg.color} 28%, #202124)`
                            : `color-mix(in srgb, ${seg.color} 15%, #ffffff)`,
                          color: isDark ? '#f3f4f6' : '#1f2937',
                        }
                  }
                >
                  <span className="font-medium truncate">{seg.title}</span>
                  <span className="text-[10px] font-mono opacity-80 shrink-0">
                    {seg.allDay ? '全天' : `${formatTime(seg.start)}–${formatTime(seg.end)}`}
                  </span>
                </button>
              ))}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-gray-100 dark:border-[#444746]">
              <button
                type="button"
                onClick={() => {
                  const target = overflowDayData.date;
                  setOverflowDayKey(null);
                  selectDate(target);
                  setViewMode('week');
                }}
                className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl shadow-xs transition cursor-pointer"
              >
                切换至周视图查看时间轴
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
