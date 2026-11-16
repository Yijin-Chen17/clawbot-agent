import React, { useRef, useState, useMemo } from 'react';
import type { TaskItem } from '../types/task';
import { useTheme } from '../context/ThemeContext';
import { 
  Calendar, 
  Clock, 
  MousePointerClick,
  Layers,
  X,
  ChevronRight,
} from 'lucide-react';

interface MatrixBoardProps {
  tasks: TaskItem[];
  onToggleComplete?: (id: string) => void;
  onEdit: (task: TaskItem) => void;
  onDelete?: (id: string) => void;
  onOpenCreateWithCoordinates: (importance: number, urgency: number) => void;
}

interface TaskCluster {
  id: string;
  tasks: TaskItem[];
  primaryTask: TaskItem;
  leftPercent: number;
  topPercent: number;
  alignX: 'left' | 'right' | 'center';
  alignY: 'top' | 'bottom';
  urgency: number;
  importance: number;
}

export const MatrixBoard: React.FC<MatrixBoardProps> = ({
  tasks,
  onEdit,
  onOpenCreateWithCoordinates,
}) => {
  const { t, language } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedCluster, setSelectedCluster] = useState<TaskCluster | null>(null);

  // 处理在坐标系任意空白区域点击，快速落位创建
  const handlePlaneClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // 只有点击背景本身才触发，点击已有任务卡片或重叠弹窗不触发
    if (
      (e.target as HTMLElement).closest('.task-coordinate-node') ||
      (e.target as HTMLElement).closest('.cluster-modal-container')
    ) {
      return;
    }
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const xRatio = Math.max(0, Math.min(1, clickX / rect.width));
    const yRatio = Math.max(0, Math.min(1, clickY / rect.height));

    // 坐标系映射规则：
    // X 轴：左侧紧迫度 10，右侧紧迫度 0
    const rawUrgency = 10 - xRatio * 10;
    // Y 轴：上方重要度 10，下方重要度 0
    const rawImportance = 10 - yRatio * 10;

    const urgency = Math.round(rawUrgency * 2) / 2;
    const importance = Math.round(rawImportance * 2) / 2;

    onOpenCreateWithCoordinates(importance, urgency);
  };

  // 根据任务评分计算其在坐标系平面中的百分比位置，并计算智能防溢出对齐锚定
  const calculatePosition = (task: TaskItem) => {
    const rawUrgency = typeof task.urgency === 'number' ? task.urgency : (task.isUrgent ? 8 : 2);
    const rawImportance = typeof task.importance === 'number' ? task.importance : (task.isImportant ? 8 : 2);

    const clampedUrgency = Math.max(0, Math.min(10, rawUrgency));
    const clampedImportance = Math.max(0, Math.min(10, rawImportance));

    // X 轴：左侧为 10 (紧急)，右侧为 0 (不紧急)
    // 留出 10% ~ 90% 缓冲，保证在移动端小屏上卡片完全处于边界内
    const uPct = (10 - clampedUrgency) / 10;
    const leftPercent = 10 + uPct * 80;

    // Y 轴：上方为 10 (重要)，下方为 0 (不重要)
    // 留出 10% ~ 90% 缓冲
    const iPct = (10 - clampedImportance) / 10;
    const topPercent = 10 + iPct * 80;

    // 智能动态防溢出对齐锚定：
    // 横向：若在左侧 (< 35%) 向右展开；若在右侧 (> 65%) 向左展开；居中则对称居中
    const alignX: 'left' | 'right' | 'center' =
      leftPercent < 35 ? 'left' : leftPercent > 65 ? 'right' : 'center';

    // 纵向：若靠近底部 (> 65%) 向上方展开；否则向下方展开
    const alignY: 'top' | 'bottom' = topPercent > 65 ? 'bottom' : 'top';

    return {
      leftPercent,
      topPercent,
      alignX,
      alignY,
      urgency: clampedUrgency,
      importance: clampedImportance,
    };
  };

  // 坐标聚合聚类：将坐标相同（或非常接近）的任务聚合成一组，防止完全重叠
  const clusters: TaskCluster[] = useMemo(() => {
    const activeTasks = tasks.filter((t) => !t.isCompleted);
    const groups: Map<string, TaskItem[]> = new Map();

    for (const task of activeTasks) {
      const rawUrgency = typeof task.urgency === 'number' ? task.urgency : (task.isUrgent ? 8 : 2);
      const rawImportance = typeof task.importance === 'number' ? task.importance : (task.isImportant ? 8 : 2);

      const clampedUrgency = Math.max(0, Math.min(10, rawUrgency));
      const clampedImportance = Math.max(0, Math.min(10, rawImportance));

      // 按 0.5 精度网格归拢相同坐标
      const key = `${Math.round(clampedUrgency * 2) / 2}_${Math.round(clampedImportance * 2) / 2}`;
      const list = groups.get(key) || [];
      list.push(task);
      groups.set(key, list);
    }

    const result: TaskCluster[] = [];
    groups.forEach((items, key) => {
      const primaryTask = items[0];
      const pos = calculatePosition(primaryTask);
      result.push({
        id: key,
        tasks: items,
        primaryTask,
        leftPercent: pos.leftPercent,
        topPercent: pos.topPercent,
        alignX: pos.alignX,
        alignY: pos.alignY,
        urgency: pos.urgency,
        importance: pos.importance,
      });
    });

    return result;
  }, [tasks]);

  return (
    <div
      ref={containerRef}
      onClick={handlePlaneClick}
      className="relative w-full h-full min-h-[380px] sm:min-h-[460px] rounded-2xl border border-gray-200/80 dark:border-neutral-800/80 bg-white dark:bg-[#1e1f20] shadow-xs overflow-hidden cursor-crosshair select-none transition-colors touch-manipulation"
    >
      {/* ===================== 四象限背景网格与轻量底色 (Google Todo 配色) ===================== */}
      <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 pointer-events-none">
        {/* 象限 I (左上): Do First */}
        <div className="relative border-r border-b border-dashed border-gray-200 dark:border-neutral-800/80 bg-rose-50/25 dark:bg-rose-950/10 p-2 sm:p-4 flex flex-col justify-start">
          <div className="flex items-center gap-1 sm:gap-1.5 opacity-80">
            <span className="h-1.5 w-1.5 sm:h-2 sm:w-2 rounded-full bg-rose-500" />
            <span className="text-[10px] sm:text-xs font-bold text-rose-700 dark:text-rose-300 tracking-wider">
              Do First
            </span>
          </div>
        </div>

        {/* 象限 II (右上): Schedule */}
        <div className="relative border-b border-dashed border-gray-200 dark:border-neutral-800/80 bg-blue-50/25 dark:bg-blue-950/10 p-2 sm:p-4 flex flex-col justify-start items-end">
          <div className="flex items-center gap-1 sm:gap-1.5 opacity-80">
            <span className="h-1.5 w-1.5 sm:h-2 sm:w-2 rounded-full bg-blue-500" />
            <span className="text-[10px] sm:text-xs font-bold text-blue-700 dark:text-blue-300 tracking-wider">
              Schedule
            </span>
          </div>
        </div>

        {/* 象限 III (左下): Delegate */}
        <div className="relative border-r border-dashed border-gray-200 dark:border-neutral-800/80 bg-amber-50/25 dark:bg-amber-950/10 p-2 sm:p-4 flex flex-col justify-end">
          <div className="flex items-center gap-1 sm:gap-1.5 opacity-80">
            <span className="h-1.5 w-1.5 sm:h-2 sm:w-2 rounded-full bg-amber-500" />
            <span className="text-[10px] sm:text-xs font-bold text-amber-700 dark:text-amber-300 tracking-wider">
              Delegate
            </span>
          </div>
        </div>

        {/* 象限 IV (右下): Eliminate */}
        <div className="relative bg-gray-50/30 dark:bg-neutral-900/15 p-2 sm:p-4 flex flex-col justify-end items-end">
          <div className="flex items-center gap-1 sm:gap-1.5 opacity-70">
            <span className="h-1.5 w-1.5 sm:h-2 sm:w-2 rounded-full bg-gray-400 dark:bg-neutral-500" />
            <span className="text-[10px] sm:text-xs font-bold text-gray-700 dark:text-neutral-300 tracking-wider">
              Eliminate
            </span>
          </div>
        </div>
      </div>

      {/* ===================== 十字交叉坐标轴 (Center Axes) ===================== */}
      {/* 纵轴 (Y 轴): 重要程度 (Important / Not Important) */}
      <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-300 dark:bg-neutral-700 pointer-events-none z-10 -translate-x-1/2">
        {/* 上箭头与标签 */}
        <div className="absolute top-1.5 sm:top-2 left-1/2 -translate-x-1/2 flex flex-col items-center gap-0.5">
          <div className="w-0 h-0 border-x-3.5 border-x-transparent border-b-5 sm:border-x-4 sm:border-b-6 border-b-gray-500 dark:border-b-neutral-400" />
          <span className="px-1.5 sm:px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-bold bg-white/95 dark:bg-[#1e1f20]/95 text-rose-700 dark:text-rose-300 border border-gray-200 dark:border-neutral-700 shadow-2xs whitespace-nowrap">
            {t('matrix.important')}
          </span>
        </div>

        {/* 下箭头与标签 */}
        <div className="absolute bottom-1.5 sm:bottom-2 left-1/2 -translate-x-1/2 flex flex-col items-center gap-0.5">
          <span className="px-1.5 sm:px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-bold bg-white/95 dark:bg-[#1e1f20]/95 text-gray-600 dark:text-neutral-400 border border-gray-200 dark:border-neutral-700 shadow-2xs whitespace-nowrap">
            {t('matrix.not_important')}
          </span>
          <div className="w-0 h-0 border-x-3.5 border-x-transparent border-t-5 sm:border-x-4 sm:border-t-6 border-t-gray-500 dark:border-t-neutral-400" />
        </div>
      </div>

      {/* 横轴 (X 轴): 紧迫程度 (Urgent / Not Urgent) */}
      <div className="absolute top-1/2 left-0 right-0 h-px bg-gray-300 dark:bg-neutral-700 pointer-events-none z-10 -translate-y-1/2">
        {/* 左箭头与标签 */}
        <div className="absolute left-1.5 sm:left-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 sm:gap-1">
          <div className="w-0 h-0 border-y-3.5 border-y-transparent border-r-5 sm:border-y-4 sm:border-r-6 border-r-gray-500 dark:border-r-neutral-400" />
          <span className="px-1.5 sm:px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-bold bg-white/95 dark:bg-[#1e1f20]/95 text-amber-700 dark:text-amber-300 border border-gray-200 dark:border-neutral-700 shadow-2xs whitespace-nowrap">
            {t('matrix.urgent')}
          </span>
        </div>

        {/* 右箭头与标签 */}
        <div className="absolute right-1.5 sm:right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 sm:gap-1">
          <span className="px-1.5 sm:px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-bold bg-white/95 dark:bg-[#1e1f20]/95 text-blue-700 dark:text-blue-300 border border-gray-200 dark:border-neutral-700 shadow-2xs whitespace-nowrap">
            {t('matrix.not_urgent')}
          </span>
          <div className="w-0 h-0 border-y-3.5 border-y-transparent border-l-5 sm:border-y-4 sm:border-l-6 border-l-gray-500 dark:border-l-neutral-400" />
        </div>
      </div>

      {/* 中心原点 */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none z-10 flex items-center justify-center">
        <div className="h-2 w-2 sm:h-2.5 sm:w-2.5 rounded-full bg-blue-600 dark:bg-blue-500 ring-4 ring-white dark:ring-[#1e1f20] shadow-xs" />
      </div>

      {/* ===================== 坐标系任务聚类节点 ===================== */}
      {clusters.map((cluster) => {
        const { leftPercent, topPercent, alignX, alignY, urgency, importance, primaryTask, tasks: clusterTasks } = cluster;
        const isMulti = clusterTasks.length > 1;
        const isImportant = importance >= 5;
        const isUrgent = urgency >= 5;

        const dotColor =
          isImportant && isUrgent
            ? 'bg-rose-500'
            : isImportant && !isUrgent
            ? 'bg-blue-600 dark:bg-blue-500'
            : !isImportant && isUrgent
            ? 'bg-amber-500'
            : 'bg-gray-400 dark:bg-neutral-500';

        return (
          <div
            key={cluster.id}
            style={{
              left: `${leftPercent}%`,
              top: `${topPercent}%`,
            }}
            className="task-coordinate-node absolute z-20 group cursor-pointer -translate-x-1/2 -translate-y-1/2 touch-manipulation"
            onClick={(e) => {
              e.stopPropagation();
              if (isMulti) {
                // 多项重叠：打开查看列表弹窗
                setSelectedCluster(cluster);
              } else {
                // 单个事项：直接打开编辑
                onEdit(primaryTask);
              }
            }}
          >
            {/* 坐标定位指示圆点 (含重叠数量微标) */}
            <div className="relative flex items-center justify-center">
              <div
                className={`w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full border-2 border-white dark:border-[#1e1f20] shadow-xs transition-transform duration-150 group-hover:scale-125 ${dotColor}`}
              />
              {isMulti && (
                <span className="absolute -top-2.5 -right-3 px-1 py-0.2 bg-blue-600 text-white text-[8px] font-bold rounded-full border border-white dark:border-neutral-900 shadow-2xs leading-tight">
                  {clusterTasks.length}
                </span>
              )}
            </div>

            {/* 任务微卡片 (适配移动端与重叠显示：xxx 等 N 个项目) */}
            <div
              className={`absolute z-30 transition-all duration-150 group-hover:scale-105 pointer-events-auto ${
                alignY === 'bottom' ? 'bottom-full mb-1 sm:mb-1.5' : 'top-full mt-1 sm:mt-1.5'
              } ${
                alignX === 'left'
                  ? 'left-0'
                  : alignX === 'right'
                  ? 'right-0'
                  : 'left-1/2 -translate-x-1/2'
              }`}
            >
              {/* 多项重叠时的卡片层叠视觉阴影 */}
              {isMulti && (
                <>
                  <div className="absolute inset-0 translate-x-1 translate-y-1 rounded-xl bg-gray-200/80 dark:bg-neutral-700/60 border border-gray-300/50 dark:border-neutral-600/50 -z-10" />
                  <div className="absolute inset-0 translate-x-0.5 translate-y-0.5 rounded-xl bg-gray-100/90 dark:bg-neutral-800/80 -z-5" />
                </>
              )}

              <div
                className={`rounded-xl border bg-white/95 dark:bg-[#28292a]/95 backdrop-blur-xs p-1.5 sm:p-2 text-xs shadow-xs hover:shadow-md transition-all w-max min-w-[105px] max-w-[145px] sm:min-w-[130px] sm:max-w-[210px] ${
                  isMulti
                    ? 'border-blue-400 dark:border-blue-500/60 hover:border-blue-600 dark:hover:border-blue-400 ring-1 ring-blue-500/10'
                    : 'border-gray-200/90 dark:border-neutral-700 hover:border-blue-500/60 dark:hover:border-blue-400/60'
                }`}
                title={isMulti ? `该位置有 ${clusterTasks.length} 个事项重叠，点击查看全部` : '点击查看或编辑'}
              >
                {/* 第一行：任务标题 + 重叠提示 */}
                <div className="flex items-center gap-1 min-w-0">
                  {primaryTask.isFixed && (
                    <span title="固定时间任务" className="text-[10px] shrink-0">
                      📌
                    </span>
                  )}
                  {primaryTask.isConcurrent && (
                    <span title="双线程任务" className="text-[10px] shrink-0">
                      ⚡
                    </span>
                  )}
                  <span className="truncate font-medium text-[10px] sm:text-[11px] leading-tight text-gray-900 dark:text-gray-100 flex-1">
                    {primaryTask.title}
                  </span>
                  {isMulti && (
                    <span className="shrink-0 px-1 py-0.2 bg-blue-50 dark:bg-blue-950/80 text-blue-600 dark:text-blue-400 text-[9px] sm:text-[10px] font-bold rounded-md whitespace-nowrap">
                      {language === 'zh'
                        ? `等${clusterTasks.length}项`
                        : `+${clusterTasks.length - 1}`}
                    </span>
                  )}
                </div>

                {/* 第二行：截止日期 / 耗时 / 标签 */}
                {(primaryTask.dueDate || primaryTask.estimatedMinutes || (primaryTask.tags && primaryTask.tags.length > 0)) && (
                  <div className="mt-0.5 sm:mt-1 flex items-center gap-1 sm:gap-2 text-[9px] sm:text-[10px] text-gray-500 dark:text-neutral-400 min-w-0">
                    {primaryTask.dueDate && (
                      <span
                        className={`flex items-center gap-0.5 truncate shrink-0 ${
                          primaryTask.algorithmStatusText ? 'text-blue-600 dark:text-blue-400 font-medium' : ''
                        }`}
                        title={primaryTask.algorithmStatusText ? `测算状态：${primaryTask.algorithmStatusText}` : `截止日: ${primaryTask.dueDate}`}
                      >
                        <Calendar className="h-2 w-2 sm:h-2.5 sm:w-2.5 shrink-0" />
                        <span>{primaryTask.algorithmStatusText || primaryTask.dueDate.slice(5)}</span>
                      </span>
                    )}

                    {primaryTask.estimatedMinutes ? (
                      <span className="flex items-center gap-0.5 shrink-0 font-mono">
                        <Clock className="h-2 w-2 sm:h-2.5 sm:w-2.5 shrink-0 text-gray-400 dark:text-neutral-500" />
                        <span>{primaryTask.estimatedMinutes}m</span>
                      </span>
                    ) : null}

                    {primaryTask.tags && primaryTask.tags.length > 0 && !isMulti && (
                      <span className="truncate text-gray-400 dark:text-neutral-500 text-[8px] sm:text-[9px]">
                        #{primaryTask.tags[0]}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* ===================== 空看板引导提示 ===================== */}
      {clusters.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-10 p-4">
          <div className="flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-1.5 sm:py-2 rounded-full bg-white/90 dark:bg-[#28292a]/90 border border-gray-200 dark:border-neutral-700 shadow-xs backdrop-blur-xs text-[11px] sm:text-xs text-gray-600 dark:text-neutral-300">
            <MousePointerClick className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-blue-600 dark:text-blue-400" />
            <span>{t('matrix.click_to_add')}</span>
          </div>
        </div>
      )}

      {/* ===================== 重叠任务展开浮层 / 移动端 Bottom Sheet ===================== */}
      {selectedCluster && (
        <div
          className="cluster-modal-container fixed inset-0 z-50 flex flex-col justify-end sm:justify-center sm:items-center bg-black/40 backdrop-blur-2xs animate-fadeIn"
          onClick={() => setSelectedCluster(null)}
        >
          <div
            className="w-full sm:max-w-md max-h-[75vh] bg-white dark:bg-[#1e1f20] rounded-t-3xl sm:rounded-3xl border-t sm:border border-gray-200 dark:border-neutral-800 shadow-2xl flex flex-col overflow-hidden animate-fadeIn"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 抽屉顶栏 */}
            <div className="p-4 sm:p-5 border-b border-gray-100 dark:border-neutral-800 flex items-center justify-between gap-3 shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                  <Layers className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
                    <span>
                      {language === 'zh'
                        ? `重叠事项清单 (${selectedCluster.tasks.length}项)`
                        : `Overlapping Tasks (${selectedCluster.tasks.length})`}
                    </span>
                  </h3>
                  <p className="text-[11px] text-gray-500 dark:text-neutral-400">
                    {language === 'zh'
                      ? `重要度: ${selectedCluster.importance} · 紧迫度: ${selectedCluster.urgency}`
                      : `Importance: ${selectedCluster.importance} · Urgency: ${selectedCluster.urgency}`}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setSelectedCluster(null)}
                className="p-1.5 rounded-full hover:bg-gray-100 dark:hover:bg-neutral-800 text-gray-500 dark:text-neutral-400 transition cursor-pointer"
                title={language === 'zh' ? '关闭' : 'Close'}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 任务列表滚动区 */}
            <div className="p-3 sm:p-4 overflow-y-auto divide-y divide-gray-100 dark:divide-neutral-800 space-y-1">
              {selectedCluster.tasks.map((task) => (
                <div
                  key={task.id}
                  onClick={() => {
                    setSelectedCluster(null);
                    onEdit(task);
                  }}
                  className="pt-2 pb-2 px-3 rounded-2xl hover:bg-gray-50 dark:hover:bg-neutral-800/60 transition cursor-pointer flex items-center justify-between gap-3 group"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-semibold text-xs text-gray-900 dark:text-gray-100 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                        {task.title}
                      </span>
                      {task.isFixed && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 font-medium border border-amber-200 dark:border-amber-800/40">
                          📌 固定
                        </span>
                      )}
                      {task.isConcurrent && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 font-medium border border-emerald-200 dark:border-emerald-800/40">
                          ⚡ 双线程
                        </span>
                      )}
                    </div>

                    <div className="mt-1 flex items-center gap-2.5 text-[11px] text-gray-500 dark:text-neutral-400 flex-wrap">
                      {task.dueDate && (
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3 h-3 text-gray-400 shrink-0" />
                          <span>{task.algorithmStatusText || task.dueDate}</span>
                        </span>
                      )}
                      {task.estimatedMinutes ? (
                        <span className="flex items-center gap-1 font-mono">
                          <Clock className="w-3 h-3 text-gray-400 shrink-0" />
                          <span>{task.estimatedMinutes}分钟</span>
                        </span>
                      ) : null}
                      {task.tags && task.tags.length > 0 && (
                        <span className="text-[10px] text-blue-600 dark:text-blue-400 font-mono">
                          #{task.tags.join(' #')}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="shrink-0 flex items-center gap-1 text-gray-400 group-hover:text-blue-600 transition-colors">
                    <span className="text-xs font-medium hidden sm:inline">
                      {language === 'zh' ? '查看' : 'Edit'}
                    </span>
                    <ChevronRight className="w-4 h-4" />
                  </div>
                </div>
              ))}
            </div>

            {/* 底部提示 */}
            <div className="p-3 bg-gray-50 dark:bg-neutral-800/40 border-t border-gray-100 dark:border-neutral-800 text-center text-[11px] text-gray-400 dark:text-neutral-500 shrink-0">
              {language === 'zh'
                ? '💡 点击任意事项可查看详情、修改评分或标为完成'
                : '💡 Tap any task to edit details, adjust priority or complete'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
