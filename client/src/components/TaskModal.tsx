import React, { useState, useEffect } from 'react';
import type { TaskItem } from '../types/task';
import { calculateQuadrant, formatLocalDate } from '../types/task';
import { QUADRANTS_CONFIG } from '../constants/quadrants';
import {
  calculateDynamicImportance,
  calculateDynamicUrgency,
  clampScore100,
  IMPACT_SIGNAL_WEIGHTS,
  IMPORTANCE_TIERS_CONFIG,
  inferTierFromScore,
  type ImpactSignal,
  type ImportanceTier,
  type TimeMode,
  type UrgencyPace,
} from '../utils/priorityAlgorithm';
import {
  X,
  Calendar,
  Clock,
  Tag as TagIcon,
  Check,
  Trash2,
  Cpu,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  Repeat,
  Infinity as InfinityIcon,
} from 'lucide-react';

export interface TaskModalSavePayload {
  title: string;
  description?: string;
  importance: number;
  urgency: number;
  importanceTier: ImportanceTier;
  impactSignals: ImpactSignal[];
  timeMode: TimeMode;
  urgencyPace: UrgencyPace;
  importanceManualOverride: number | null;
  useAutoUrgency?: boolean;
  dueDate?: string | null;
  tags?: string[];
  estimatedMinutes?: number;
  isFixed?: boolean;
  isConcurrent?: boolean;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
}

interface TaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: TaskModalSavePayload) => void;
  onToggleComplete?: (id: string) => void;
  onDelete?: (id: string) => void;
  initialTask?: TaskItem | null;
  defaultImportance?: number;
  defaultUrgency?: number;
  allExistingTags?: string[];
  dailyBusyMinutesAhead?: number;
}

const TIER_ORDER: Array<{ key: ImportanceTier; icon: string }> = [
  { key: 'vital', icon: '⭐' },
  { key: 'support', icon: '💼' },
  { key: 'minor', icon: '📎' },
];

const IMPACT_KEYS = Object.keys(IMPACT_SIGNAL_WEIGHTS) as ImpactSignal[];

export const TaskModal: React.FC<TaskModalProps> = ({
  isOpen,
  onClose,
  onSave,
  onToggleComplete,
  onDelete,
  initialTask,
  defaultImportance = 60,
  defaultUrgency,
  allExistingTags = [],
  dailyBusyMinutesAhead = 0,
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [importanceTier, setImportanceTier] = useState<ImportanceTier>('support');
  const [impactSignals, setImpactSignals] = useState<ImpactSignal[]>([]);
  const [overrideExpanded, setOverrideExpanded] = useState(false);
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [manualImportance, setManualImportance] = useState<number>(60);

  const [timeMode, setTimeMode] = useState<TimeMode>('deadline');
  const [dueDate, setDueDate] = useState(() => formatLocalDate(new Date()));
  const [dueTime, setDueTime] = useState<string>(''); // 可选具体截止时刻
  const [urgencyPace, setUrgencyPace] = useState<UrgencyPace>('soon');

  const [estimatedMinutes, setEstimatedMinutes] = useState<number | ''>('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [isFixed, setIsFixed] = useState(false);
  const [isConcurrent, setIsConcurrent] = useState(false);
  const [fixedStartTime, setFixedStartTime] = useState('09:00');
  const [fixedEndTime, setFixedEndTime] = useState('10:00');

  // 初始化填充数据（注意：手动微调覆盖面板默认始终折叠）
  useEffect(() => {
    const todayStr = formatLocalDate(new Date());
    setOverrideExpanded(false);

    if (initialTask) {
      setTitle(initialTask.title);
      setDescription(initialTask.description || '');
      setImportanceTier(
        initialTask.importanceTier || inferTierFromScore(initialTask.importance ?? 58)
      );
      setImpactSignals(initialTask.impactSignals || []);

      const hasOverride =
        initialTask.importanceManualOverride !== undefined &&
        initialTask.importanceManualOverride !== null;
      setOverrideEnabled(hasOverride);
      setManualImportance(
        hasOverride ? clampScore100(initialTask.importanceManualOverride!) : clampScore100(initialTask.importance)
      );

      setTimeMode(initialTask.timeMode || (initialTask.dueDate ? 'deadline' : 'flexible'));
      setUrgencyPace(initialTask.urgencyPace || 'soon');

      if (initialTask.dueDate) {
        if (initialTask.dueDate.includes('T')) {
          setDueDate(initialTask.dueDate.slice(0, 10));
          const timePart = initialTask.dueDate.slice(11, 16);
          setDueTime(timePart && timePart !== '23:59' ? timePart : '');
        } else {
          setDueDate(initialTask.dueDate);
          setDueTime('');
        }
      } else {
        setDueDate(todayStr);
        setDueTime('');
      }

      setEstimatedMinutes(initialTask.estimatedMinutes || '');
      setTags(initialTask.tags || []);
      setIsFixed(Boolean(initialTask.isFixed));
      setIsConcurrent(Boolean(initialTask.isConcurrent));
      if (initialTask.scheduledStart) {
        const d = new Date(initialTask.scheduledStart);
        if (!Number.isNaN(d.getTime())) {
          setFixedStartTime(
            `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
          );
        }
      }
      if (initialTask.scheduledEnd) {
        const d = new Date(initialTask.scheduledEnd);
        if (!Number.isNaN(d.getTime())) {
          setFixedEndTime(
            `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
          );
        }
      }
    } else {
      setTitle('');
      setDescription('');
      const initialTier = inferTierFromScore(defaultImportance);
      setImportanceTier(initialTier);
      setImpactSignals([]);
      setOverrideEnabled(false);
      setManualImportance(clampScore100(defaultImportance));

      setTimeMode('deadline');
      setUrgencyPace('soon');
      setDueTime('');
      setIsFixed(false);
      setIsConcurrent(false);
      setFixedStartTime('09:00');
      setFixedEndTime('10:00');

      let initialDueDate = todayStr;
      if (typeof defaultUrgency === 'number') {
        if (defaultUrgency < 25) {
          setTimeMode('flexible');
          setUrgencyPace('later');
        } else {
          const target = new Date();
          if (defaultUrgency >= 80) target.setDate(target.getDate() + 0);
          else if (defaultUrgency >= 60) target.setDate(target.getDate() + 1);
          else if (defaultUrgency >= 45) target.setDate(target.getDate() + 3);
          else if (defaultUrgency >= 30) target.setDate(target.getDate() + 7);
          else target.setDate(target.getDate() + 14);
          initialDueDate = formatLocalDate(target);
        }
      }
      setDueDate(initialDueDate);
      setEstimatedMinutes('');
      setTags([]);
    }
  }, [initialTask, defaultImportance, defaultUrgency, isOpen]);

  const effectiveEstimatedMinutes =
    typeof estimatedMinutes === 'number' && estimatedMinutes > 0 ? estimatedMinutes : 30;

  // 1. 全自动计算重要度（仅在用户主动启用手动微调覆盖时使用覆盖分值）
  const importanceResult = calculateDynamicImportance({
    tier: importanceTier,
    estimatedMinutes: effectiveEstimatedMinutes,
    impactSignals,
    isFixed,
    manualOverride: overrideEnabled ? manualImportance : null,
  });
  const importance = importanceResult.importance;

  // 2. 结合日期/时间模式 + 耗时 + 日程负荷 + 重要度联动计算紧迫度
  const effectiveDueDateStr =
    timeMode === 'deadline'
      ? dueTime
        ? `${dueDate || formatLocalDate(new Date())}T${dueTime}:00`
        : dueDate || formatLocalDate(new Date())
      : null;

  const todayDateStr = formatLocalDate(new Date());
  const previewScheduledStart =
    isFixed && (timeMode === 'daily_fixed' || effectiveDueDateStr)
      ? `${timeMode === 'daily_fixed' ? todayDateStr : dueDate || todayDateStr}T${fixedStartTime}:00`
      : initialTask?.scheduledStart || null;
  const previewScheduledEnd =
    isFixed && (timeMode === 'daily_fixed' || effectiveDueDateStr)
      ? `${timeMode === 'daily_fixed' ? todayDateStr : dueDate || todayDateStr}T${fixedEndTime}:00`
      : initialTask?.scheduledEnd || null;

  const isCompletedToday =
    timeMode === 'daily_fixed' &&
    Array.isArray(initialTask?.completedDates) &&
    initialTask!.completedDates!.includes(todayDateStr);

  const urgencyResult = calculateDynamicUrgency({
    timeMode,
    dueDate: effectiveDueDateStr,
    estimatedMinutes: effectiveEstimatedMinutes,
    importance,
    urgencyPace,
    scheduledStart: previewScheduledStart,
    scheduledEnd: previewScheduledEnd,
    isCompletedToday,
    dailyBusyMinutesAhead: dailyBusyMinutesAhead,
  });
  const urgency = urgencyResult.urgency;

  if (!isOpen) return null;

  const computedQuadrantId = calculateQuadrant(importance, urgency);
  const computedQuadrantMeta = QUADRANTS_CONFIG[computedQuadrantId];

  const handleQuickDateOffset = (daysOffset: number) => {
    const target = new Date();
    target.setDate(target.getDate() + daysOffset);
    setDueDate(formatLocalDate(target));
  };

  const toggleSignal = (sig: ImpactSignal) => {
    setImpactSignals((prev) =>
      prev.includes(sig) ? prev.filter((item) => item !== sig) : [...prev, sig]
    );
  };

  const handleAddTag = () => {
    const val = tagInput.trim();
    if (val && !tags.includes(val)) {
      setTags([...tags, val]);
      setTagInput('');
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setTags(tags.filter((t) => t !== tagToRemove));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (timeMode === 'deadline' && !dueDate) return;

    let scheduledStart: string | null = null;
    let scheduledEnd: string | null = null;
    if (isFixed) {
      const anchorDate = timeMode === 'daily_fixed' ? todayDateStr : dueDate || todayDateStr;
      scheduledStart = `${anchorDate}T${fixedStartTime}:00`;
      scheduledEnd = `${anchorDate}T${fixedEndTime}:00`;
    }

    onSave({
      title: title.trim(),
      description: description.trim() || undefined,
      importance,
      urgency,
      importanceTier,
      impactSignals,
      timeMode,
      urgencyPace,
      importanceManualOverride: overrideEnabled ? clampScore100(manualImportance) : null,
      useAutoUrgency: true,
      dueDate: effectiveDueDateStr,
      tags,
      estimatedMinutes: typeof estimatedMinutes === 'number' ? estimatedMinutes : undefined,
      isFixed,
      isConcurrent,
      scheduledStart,
      scheduledEnd,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
      <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800 shadow-2xl overflow-hidden transition-all animate-in fade-in zoom-in-95 duration-150">
        {/* 顶部标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-neutral-800">
          <div className="flex items-center gap-2.5">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              {initialTask ? '编辑待办' : '新建待办'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300 transition cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* 表单内容 */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[82vh] overflow-y-auto">
          {/* 任务名称 */}
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-neutral-300 mb-1.5">
              事项标题 <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="输入事项名称..."
              className="w-full rounded-xl border border-gray-200 bg-gray-50/50 px-3.5 py-2 text-xs text-gray-900 focus:bg-white dark:focus:bg-[#28292a] focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none dark:border-neutral-700 dark:bg-[#28292a] dark:text-gray-100 placeholder:text-gray-400 transition"
            />
          </div>

          {/* 1. 重要度自动算分板块（三阶定级 + 影响因子 + 折叠手动覆盖） */}
          <div className="p-3.5 rounded-xl bg-gray-50/70 dark:bg-neutral-800/30 border border-gray-200/70 dark:border-neutral-800 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-800 dark:text-neutral-200">
                重要度定级（自动算分）
              </span>
              <span className="px-2 py-0.5 rounded-full text-[11px] font-bold font-mono bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 border border-blue-200/80 dark:border-blue-800/60">
                {importance} / 100
              </span>
            </div>

            {/* 三阶认知定级按钮 */}
            <div className="grid grid-cols-3 gap-2">
              {TIER_ORDER.map(({ key, icon }) => {
                const cfg = IMPORTANCE_TIERS_CONFIG[key];
                const active = importanceTier === key;
                const activeCls =
                  key === 'vital'
                    ? 'border-rose-400 bg-rose-50/80 text-rose-800 dark:bg-rose-950/40 dark:border-rose-700 dark:text-rose-200 ring-1 ring-rose-400/40'
                    : key === 'support'
                    ? 'border-blue-400 bg-blue-50/80 text-blue-800 dark:bg-blue-950/40 dark:border-blue-700 dark:text-blue-200 ring-1 ring-blue-400/40'
                    : 'border-gray-400 bg-gray-100 text-gray-800 dark:bg-neutral-800 dark:border-neutral-600 dark:text-neutral-200 ring-1 ring-gray-400/30';

                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setImportanceTier(key)}
                    className={`flex flex-col items-center justify-center gap-0.5 py-2 px-2 rounded-xl border text-center transition cursor-pointer ${
                      active
                        ? activeCls
                        : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300 dark:border-neutral-700 dark:bg-[#28292a] dark:text-neutral-300'
                    }`}
                    title={cfg.description}
                  >
                    <span className="text-sm leading-none">{icon}</span>
                    <span className="text-[11px] font-bold mt-0.5">{cfg.label}</span>
                    <span className="text-[10px] opacity-70 font-mono">基准 {cfg.base}</span>
                  </button>
                );
              })}
            </div>

            {/* 影响因子自动加权芯片 */}
            <div className="space-y-1.5">
              <span className="text-[11px] text-gray-500 dark:text-neutral-400 block">
                附加价值信号（可选，用于细化重要度）：
              </span>
              <div className="flex flex-wrap gap-1.5">
                {IMPACT_KEYS.map((sigKey) => {
                  const meta = IMPACT_SIGNAL_WEIGHTS[sigKey];
                  const selected = impactSignals.includes(sigKey);
                  return (
                    <button
                      key={sigKey}
                      type="button"
                      onClick={() => toggleSignal(sigKey)}
                      className={`text-[10.5px] px-2.5 py-1 rounded-lg border transition cursor-pointer ${
                        selected
                          ? 'bg-blue-600 text-white border-blue-600 font-medium shadow-2xs'
                          : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300 dark:bg-[#28292a] dark:text-neutral-300 dark:border-neutral-700'
                      }`}
                    >
                      {selected ? '✓ ' : '+ '}
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 算法拆解说明 */}
            <div className="flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-neutral-400">
              <Cpu className="h-3.5 w-3.5 text-blue-500 shrink-0" />
              <span className="truncate" title={importanceResult.breakdownText}>
                {importanceResult.breakdownText}
              </span>
            </div>

            {/* 默认折叠的手动微调覆盖入口 */}
            <div className="pt-1.5 border-t border-gray-200/60 dark:border-neutral-700/60">
              <button
                type="button"
                onClick={() => setOverrideExpanded((v) => !v)}
                className="flex items-center gap-1.5 text-[11px] font-medium text-gray-500 hover:text-gray-800 dark:text-neutral-400 dark:hover:text-neutral-200 transition cursor-pointer"
              >
                {overrideExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                <SlidersHorizontal className="h-3 w-3" />
                <span>
                  手动微调覆盖{overrideEnabled ? `（已启用: ${manualImportance}）` : '（高级）'}
                </span>
              </button>

              {overrideExpanded && (
                <div className="mt-2.5 p-2.5 rounded-lg bg-white dark:bg-[#232425] border border-gray-200 dark:border-neutral-700 space-y-2">
                  <label className="flex items-center justify-between text-[11px] cursor-pointer select-none">
                    <span className="font-medium text-gray-700 dark:text-neutral-300">
                      启用手动覆盖重要度分值
                    </span>
                    <input
                      type="checkbox"
                      checked={overrideEnabled}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setOverrideEnabled(checked);
                        if (checked) {
                          setManualImportance(importanceResult.autoImportance);
                        }
                      }}
                      className="rounded text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                    />
                  </label>
                  <div className="flex items-center gap-2.5">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      disabled={!overrideEnabled}
                      value={overrideEnabled ? manualImportance : importanceResult.autoImportance}
                      onChange={(e) => setManualImportance(Number(e.target.value))}
                      className="flex-1 accent-blue-600 cursor-pointer disabled:opacity-40"
                    />
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={1}
                      disabled={!overrideEnabled}
                      value={overrideEnabled ? manualImportance : importanceResult.autoImportance}
                      onChange={(e) => setManualImportance(clampScore100(Number(e.target.value)))}
                      className="w-16 rounded-lg border border-gray-200 dark:border-neutral-700 bg-gray-50 dark:bg-[#28292a] px-2 py-1 text-xs text-center font-mono disabled:opacity-40"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 2. 时间属性与紧迫度三模式（截止日期 / 每日固定 / 弹性待排） */}
          <div className="p-3.5 rounded-xl bg-gray-50/70 dark:bg-neutral-800/30 border border-gray-200/70 dark:border-neutral-800 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-800 dark:text-neutral-200">
                时间排期模式与紧迫度
              </span>
              <span className="px-2 py-0.5 rounded-full text-[11px] font-bold font-mono bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200/80 dark:border-amber-800/60">
                紧迫度 {urgency} / 100
              </span>
            </div>

            {/* 三种时间模式切换 */}
            <div className="grid grid-cols-3 gap-1.5 p-1 rounded-xl bg-gray-200/60 dark:bg-neutral-800">
              <button
                type="button"
                onClick={() => setTimeMode('deadline')}
                className={`flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-[11px] font-medium transition cursor-pointer ${
                  timeMode === 'deadline'
                    ? 'bg-white dark:bg-[#28292a] text-blue-600 dark:text-blue-400 font-semibold shadow-2xs'
                    : 'text-gray-600 dark:text-neutral-400 hover:text-gray-900'
                }`}
              >
                <Calendar className="h-3 w-3" />
                <span>截止日期</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setTimeMode('daily_fixed');
                }}
                className={`flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-[11px] font-medium transition cursor-pointer ${
                  timeMode === 'daily_fixed'
                    ? 'bg-white dark:bg-[#28292a] text-blue-600 dark:text-blue-400 font-semibold shadow-2xs'
                    : 'text-gray-600 dark:text-neutral-400 hover:text-gray-900'
                }`}
              >
                <Repeat className="h-3 w-3" />
                <span>每日固定</span>
              </button>
              <button
                type="button"
                onClick={() => setTimeMode('flexible')}
                className={`flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-[11px] font-medium transition cursor-pointer ${
                  timeMode === 'flexible'
                    ? 'bg-white dark:bg-[#28292a] text-blue-600 dark:text-blue-400 font-semibold shadow-2xs'
                    : 'text-gray-600 dark:text-neutral-400 hover:text-gray-900'
                }`}
              >
                <InfinityIcon className="h-3 w-3" />
                <span>弹性待排</span>
              </button>
            </div>

            {/* 模式 A：截止日期 + 大致日期快捷选择 + 预计耗时 */}
            {timeMode === 'deadline' && (
              <div className="space-y-2.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[11px] text-gray-400 mr-0.5">大致日期：</span>
                  {[
                    { label: '今天', days: 0 },
                    { label: '明天', days: 1 },
                    { label: '3天后', days: 3 },
                    { label: '1周后', days: 7 },
                    { label: '2周后', days: 14 },
                    { label: '1月内', days: 30 },
                  ].map((preset) => {
                    const target = new Date();
                    target.setDate(target.getDate() + preset.days);
                    const presetStr = formatLocalDate(target);
                    const isSelected = dueDate === presetStr;
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => handleQuickDateOffset(preset.days)}
                        className={`text-[11px] px-2 py-0.5 rounded-lg border transition-colors cursor-pointer ${
                          isSelected
                            ? 'bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-800 font-medium'
                            : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300 dark:bg-[#28292a] dark:text-neutral-400 dark:border-neutral-700'
                        }`}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-[10.5px] font-medium text-gray-600 dark:text-neutral-400 mb-1">
                      截止日期 <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="date"
                      required
                      value={dueDate}
                      onChange={(e) => setDueDate(e.target.value)}
                      className="w-full rounded-xl border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-900 focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-[#28292a] dark:text-gray-100"
                    />
                  </div>
                  <div>
                    <label className="block text-[10.5px] font-medium text-gray-600 dark:text-neutral-400 mb-1">
                      截止时刻（可选）
                    </label>
                    <input
                      type="time"
                      value={dueTime}
                      onChange={(e) => setDueTime(e.target.value)}
                      className="w-full rounded-xl border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-900 focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-[#28292a] dark:text-gray-100"
                    />
                  </div>
                  <div>
                    <label className="block text-[10.5px] font-medium text-gray-600 dark:text-neutral-400 mb-1 flex items-center gap-1">
                      <Clock className="h-3 w-3 text-gray-400" />
                      <span>耗时(分)</span>
                    </label>
                    <input
                      type="number"
                      min="5"
                      step="5"
                      value={estimatedMinutes}
                      onChange={(e) => setEstimatedMinutes(e.target.value ? Number(e.target.value) : '')}
                      placeholder="30"
                      className="w-full rounded-xl border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-900 focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-[#28292a] dark:text-gray-100"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* 模式 B：每日固定/重复任务 */}
            {timeMode === 'daily_fixed' && (
              <div className="space-y-2.5">
                <p className="text-[11px] text-gray-600 dark:text-neutral-400 leading-relaxed">
                  每日固定任务将结合<strong>今日日程排程区间</strong>与<strong>当天剩余空闲负荷</strong>自动测算紧迫度；当日打卡完成后自动回落，次日恢复待办。
                </p>
                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-[10.5px] font-medium text-gray-600 dark:text-neutral-400 mb-1 flex items-center gap-1">
                      <Clock className="h-3 w-3 text-gray-400" />
                      <span>每日耗时 (分钟)</span>
                    </label>
                    <input
                      type="number"
                      min="5"
                      step="5"
                      value={estimatedMinutes}
                      onChange={(e) => setEstimatedMinutes(e.target.value ? Number(e.target.value) : '')}
                      placeholder="30"
                      className="w-full rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-900 focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-[#28292a] dark:text-gray-100"
                    />
                  </div>
                  <div className="flex items-end pb-1">
                    <span className="text-[10.5px] text-gray-500 dark:text-neutral-400">
                      今日已知日程占用约 {Math.round((dailyBusyMinutesAhead / 60) * 10) / 10}h
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* 模式 C：弹性无截止日任务 */}
            {timeMode === 'flexible' && (
              <div className="space-y-2.5">
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { key: 'urgent', label: '🔥 尽快推进' },
                      { key: 'soon', label: '⏱️ 近日规划' },
                      { key: 'later', label: '☕ 远期备忘' },
                    ] as Array<{ key: UrgencyPace; label: string }>
                  ).map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => setUrgencyPace(p.key)}
                      className={`py-1.5 px-2 rounded-xl border text-[11px] font-medium transition cursor-pointer ${
                        urgencyPace === p.key
                          ? 'bg-blue-50 text-blue-700 border-blue-300 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-700 font-semibold'
                          : 'bg-white text-gray-600 border-gray-200 dark:bg-[#28292a] dark:text-neutral-400 dark:border-neutral-700'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <div>
                  <label className="block text-[10.5px] font-medium text-gray-600 dark:text-neutral-400 mb-1 flex items-center gap-1">
                    <Clock className="h-3 w-3 text-gray-400" />
                    <span>预计耗时 (分钟)</span>
                  </label>
                  <input
                    type="number"
                    min="5"
                    step="5"
                    value={estimatedMinutes}
                    onChange={(e) => setEstimatedMinutes(e.target.value ? Number(e.target.value) : '')}
                    placeholder="30"
                    className="w-full rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-900 focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-[#28292a] dark:text-gray-100"
                  />
                </div>
              </div>
            )}

            {/* 象限归类状态与紧迫度测算文案 */}
            <div className="flex items-center justify-between pt-2 border-t border-gray-200/50 dark:border-neutral-800 text-xs">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${computedQuadrantMeta.themeColor.accentDot}`} />
                <span className="font-medium text-gray-800 dark:text-neutral-200">
                  {computedQuadrantMeta.name}
                </span>
              </div>
              <span className="text-[11px] text-gray-500 dark:text-neutral-400">
                {urgencyResult.statusText}
              </span>
            </div>
          </div>

          {/* 高级排程设置 (固定任务 / 双线程重叠) */}
          <div className="p-3.5 rounded-xl bg-gray-50/70 dark:bg-neutral-800/30 border border-gray-200/70 dark:border-neutral-800 space-y-2.5 text-xs">
            <span className="font-semibold text-gray-700 dark:text-neutral-300 block text-[11px] uppercase tracking-wider">
              高级排程模式
            </span>

            {/* 固定任务 */}
            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isFixed}
                  onChange={(e) => setIsFixed(e.target.checked)}
                  className="rounded text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                />
                <span className="font-medium text-gray-800 dark:text-neutral-200">
                  📌 固定时间段执行（锁定区间，不参与自动重排）
                </span>
              </label>

              {isFixed && (
                <div className="pl-5.5 grid grid-cols-2 gap-2.5 pt-1">
                  <div>
                    <span className="text-[10px] text-gray-500 dark:text-neutral-400 block mb-1">开始时间</span>
                    <input
                      type="time"
                      value={fixedStartTime}
                      onChange={(e) => setFixedStartTime(e.target.value)}
                      className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-900 focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-[#232425] dark:text-gray-100"
                    />
                  </div>
                  <div>
                    <span className="text-[10px] text-gray-500 dark:text-neutral-400 block mb-1">结束时间</span>
                    <input
                      type="time"
                      value={fixedEndTime}
                      onChange={(e) => setFixedEndTime(e.target.value)}
                      className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-900 focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-[#232425] dark:text-gray-100"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* 双线程任务 */}
            <div className="pt-1 border-t border-gray-200/50 dark:border-neutral-800">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isConcurrent}
                  onChange={(e) => setIsConcurrent(e.target.checked)}
                  className="rounded text-blue-600 focus:ring-blue-500 w-3.5 h-3.5"
                />
                <span className="font-medium text-gray-800 dark:text-neutral-200">
                  ⚡ 双线程任务 (允许与其他任务或外部日程时间重叠并行)
                </span>
              </label>
            </div>
          </div>

          {/* 备注描述 */}
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-neutral-300 mb-1.5">
              备注描述 (可选)
            </label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="添加备注细节..."
              className="w-full rounded-xl border border-gray-200 bg-gray-50/50 p-2.5 text-xs text-gray-900 focus:bg-white dark:focus:bg-[#28292a] focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-[#28292a] dark:text-gray-100 placeholder:text-gray-400 transition"
            />
          </div>

          {/* 标签管理 */}
          <div>
            <label className="block text-xs font-medium text-gray-700 dark:text-neutral-300 mb-1.5 flex items-center gap-1.5">
              <TagIcon className="h-3.5 w-3.5 text-gray-400" />
              <span>标签</span>
            </label>
            <div className="flex gap-2 mb-1.5">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddTag();
                  }
                }}
                placeholder="输入标签并回车..."
                className="flex-1 rounded-xl border border-gray-200 bg-gray-50/50 px-3 py-1.5 text-xs text-gray-900 focus:bg-white dark:focus:bg-[#28292a] focus:border-blue-500 focus:outline-none dark:border-neutral-700 dark:bg-[#28292a] dark:text-gray-100 transition"
              />
              <button
                type="button"
                onClick={handleAddTag}
                className="px-3 py-1.5 rounded-xl border border-gray-200 text-xs text-gray-600 hover:bg-gray-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800 transition cursor-pointer"
              >
                添加
              </button>
            </div>

            {allExistingTags.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1.5">
                {allExistingTags.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      if (!tags.includes(t)) setTags([...tags, t]);
                    }}
                    className="text-[11px] px-2 py-0.5 rounded-md bg-gray-100 hover:bg-gray-200 text-gray-600 dark:bg-neutral-800 dark:hover:bg-neutral-700 dark:text-neutral-300 transition cursor-pointer"
                  >
                    +{t}
                  </button>
                ))}
              </div>
            )}

            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-0.5 text-[11px] text-gray-700 dark:bg-neutral-800 dark:text-neutral-300"
                  >
                    #{tag}
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(tag)}
                      className="text-gray-400 hover:text-gray-600 dark:hover:text-neutral-100"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* 底部操作按钮 */}
          <div className="flex items-center justify-between gap-2.5 pt-3 border-t border-gray-100 dark:border-neutral-800">
            <div>
              {initialTask && (
                <div className="flex items-center gap-2">
                  {onToggleComplete && (
                    <button
                      type="button"
                      onClick={() => {
                        onToggleComplete(initialTask.id);
                        onClose();
                      }}
                      className={`px-3 py-1.5 rounded-xl text-xs font-medium flex items-center gap-1.5 transition cursor-pointer ${
                        initialTask.isCompleted
                          ? 'bg-gray-100 hover:bg-gray-200 text-gray-700 dark:bg-neutral-800 dark:text-neutral-300'
                          : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800'
                      }`}
                    >
                      <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                      <span>{initialTask.isCompleted ? '标记为未完成' : '完成任务'}</span>
                    </button>
                  )}
                  {onDelete && (
                    <button
                      type="button"
                      onClick={() => {
                        onDelete(initialTask.id);
                        onClose();
                      }}
                      className="p-1.5 rounded-xl text-gray-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition cursor-pointer"
                      title="删除此任务"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-1.5 rounded-xl text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800 transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                type="submit"
                className="px-5 py-1.5 rounded-xl text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 shadow-xs transition-all cursor-pointer"
              >
                {initialTask ? '保存' : '创建'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
