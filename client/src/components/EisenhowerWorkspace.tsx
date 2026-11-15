import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { TaskItem, QuadrantId } from '../types/task';
import { calculateQuadrant, formatLocalDate } from '../types/task';
import { calculateDynamicUrgency } from '../utils/priorityAlgorithm';
import { api } from '../api/client';
import { useTheme } from '../context/ThemeContext';
import { MatrixBoard } from './MatrixBoard';
import { TaskModal } from './TaskModal';
import { WizardModal } from './WizardModal';
import { StatsModal } from './StatsModal';
import { BackupModal } from './BackupModal';
import {
  LayoutGrid,
  Plus,
  RefreshCw,
  Search,
  Check,
  CheckSquare,
  Clock,
  Inbox,
  Flame,
  Star,
  Layers,
  Archive,
  Edit3,
  Trash2,
  Calendar as CalendarIcon,
  CheckCircle2,
  Menu,
  Languages,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

interface EisenhowerWorkspaceProps {
  currentView?: 'matrix' | 'list';
  onSwitchView?: (view: 'matrix' | 'list') => void;
  activeCategory?: string;
  setActiveCategory?: (cat: string) => void;
  onCountsUpdate?: (counts: Record<string, number>) => void;
  onOpenMobileMenu?: () => void;
  isCreateModalOpen?: boolean;
  setIsCreateModalOpen?: (open: boolean) => void;
  isWizardOpen?: boolean;
  setIsWizardOpen?: (open: boolean) => void;
  isStatsOpen?: boolean;
  setIsStatsOpen?: (open: boolean) => void;
  isBackupOpen?: boolean;
  setIsBackupOpen?: (open: boolean) => void;
}

export const EisenhowerWorkspace: React.FC<EisenhowerWorkspaceProps> = ({
  currentView: propsCurrentView = 'matrix',
  onSwitchView,
  activeCategory: propsActiveCategory,
  setActiveCategory: propsSetActiveCategory,
  onCountsUpdate,
  onOpenMobileMenu,
  isCreateModalOpen: propsIsCreateModalOpen,
  setIsCreateModalOpen: propsSetIsCreateModalOpen,
  isWizardOpen: propsIsWizardOpen,
  setIsWizardOpen: propsSetIsWizardOpen,
  isStatsOpen: propsIsStatsOpen,
  setIsStatsOpen: propsSetIsStatsOpen,
  isBackupOpen: propsIsBackupOpen,
  setIsBackupOpen: propsSetIsBackupOpen,
}) => {
  const { t, language, setLanguage } = useTheme();

  // 当前内部视图：四象限看板 (matrix) / 待办清单列表 (list)
  const [internalCurrentView, setInternalCurrentView] = useState<'matrix' | 'list'>(propsCurrentView);
  const viewMode = propsCurrentView || internalCurrentView;

  // 与父级 propsCurrentView 同步
  useEffect(() => {
    if (propsCurrentView && propsCurrentView !== internalCurrentView) {
      setInternalCurrentView(propsCurrentView);
    }
  }, [propsCurrentView, internalCurrentView]);

  const handleToggleViewMode = (v: 'matrix' | 'list') => {
    setInternalCurrentView(v);
    onSwitchView?.(v);
  };

  // 分类筛选控制
  const [internalActiveCategory, setInternalActiveCategory] = useState<string>('all');
  const currentCategory = propsActiveCategory || internalActiveCategory;

  const handleSelectCategory = (cat: string) => {
    if (propsSetActiveCategory) {
      propsSetActiveCategory(cat);
    } else {
      setInternalActiveCategory(cat);
    }
  };
  void handleSelectCategory;

  // 任务数据与加载状态
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // 模态框状态
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskItem | null>(null);
  const [clickCoords, setClickCoords] = useState<{ importance: number; urgency: number } | null>(null);
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [isStatsOpen, setIsStatsOpen] = useState(false);
  const [isBackupOpen, setIsBackupOpen] = useState(false);

  // Google Tasks 风格快速添加与已完成折叠状态
  const [quickTaskTitle, setQuickTaskTitle] = useState('');
  const [quickTaskSubmitting, setQuickTaskSubmitting] = useState(false);
  const [completedExpanded, setCompletedExpanded] = useState(false);

  // 响应父级侧边栏触发模态框
  useEffect(() => {
    if (propsIsCreateModalOpen) {
      setEditingTask(null);
      setClickCoords(null);
      setIsTaskModalOpen(true);
      propsSetIsCreateModalOpen?.(false);
    }
  }, [propsIsCreateModalOpen, propsSetIsCreateModalOpen]);

  useEffect(() => {
    if (propsIsWizardOpen) {
      setIsWizardOpen(true);
      propsSetIsWizardOpen?.(false);
    }
  }, [propsIsWizardOpen, propsSetIsWizardOpen]);

  useEffect(() => {
    if (propsIsStatsOpen) {
      setIsStatsOpen(true);
      propsSetIsStatsOpen?.(false);
    }
  }, [propsIsStatsOpen, propsSetIsStatsOpen]);

  useEffect(() => {
    if (propsIsBackupOpen) {
      setIsBackupOpen(true);
      propsSetIsBackupOpen?.(false);
    }
  }, [propsIsBackupOpen, propsSetIsBackupOpen]);

  // 转换服务端 Task 为标准 TaskItem (0~10分值模型)
  const mapServerTask = useCallback((t: any): TaskItem => {
    let importance = typeof t.importance === 'number' ? t.importance : 5;
    if (importance <= 5 && !t.importance_scaled_10) {
      importance = importance * 2;
    }
    let fallbackUrgency = typeof t.urgency === 'number' ? t.urgency : 5;
    if (fallbackUrgency <= 5 && !t.urgency_scaled_10) {
      fallbackUrgency = fallbackUrgency * 2;
    }

    const effectiveDueDate = t.deadline
      ? t.deadline.slice(0, 10)
      : formatLocalDate(new Date(t.created_at || Date.now()));

    const algo = calculateDynamicUrgency({
      dueDate: effectiveDueDate,
      estimatedMinutes: t.duration_minutes || 60,
      fallbackUrgency,
      currentTime: new Date(),
    });

    const isCompleted = t.status === 'completed';
    const todayStr = formatLocalDate(new Date());

    return {
      id: String(t.id),
      title: t.title,
      description: t.notes || '',
      importance,
      urgency: algo.urgency,
      useAutoUrgency: true,
      isImportant: importance >= 5,
      isUrgent: algo.urgency >= 5,
      quadrant: calculateQuadrant(importance, algo.urgency),
      isCompleted,
      completedDates: isCompleted ? [todayStr] : [],
      dueDate: effectiveDueDate,
      tags: Array.isArray(t.tags) ? t.tags : (t.tags ? String(t.tags).split(',').map((s: string) => s.trim()).filter(Boolean) : []),
      estimatedMinutes: t.duration_minutes || 60,
      isFixed: Boolean(t.is_fixed),
      isConcurrent: Boolean(t.is_concurrent),
      scheduledStart: t.scheduled_start,
      scheduledEnd: t.scheduled_end,
      createdAt: t.created_at || new Date().toISOString(),
      completedAt: isCompleted ? (t.updated_at || new Date().toISOString()) : null,
      algorithmStatusText: algo.statusText,
    };
  }, []);

  // 拉取任务列表
  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/tasks');
      const serverTasks = res.data.tasks || [];
      const mapped = serverTasks.map(mapServerTask);
      setTasks(mapped);
    } catch (err) {
      console.error('拉取任务列表失败:', err);
    } finally {
      setLoading(false);
    }
  }, [mapServerTask]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  // 全局键盘快捷键 N / n 新建事项
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target as HTMLElement)?.isContentEditable
      ) {
        return;
      }
      if (isTaskModalOpen || isWizardOpen || isStatsOpen || isBackupOpen) {
        return;
      }
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        setEditingTask(null);
        setClickCoords(null);
        setIsTaskModalOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isTaskModalOpen, isWizardOpen, isStatsOpen, isBackupOpen]);

  // 提取所有唯一标签
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    tasks.forEach((t) => t.tags?.forEach((tag) => tagSet.add(tag)));
    return Array.from(tagSet).sort();
  }, [tasks]);

  // 分类与四象限定义
  const filterCategories = [
    { key: 'all', label: t('nav.all_tasks'), icon: Inbox, color: 'text-blue-600 dark:text-blue-400' },
    { key: 'q1', label: t('quad.do_first'), icon: Flame, color: 'text-rose-600 dark:text-rose-400' },
    { key: 'q2', label: t('quad.schedule'), icon: Star, color: 'text-blue-600 dark:text-blue-400' },
    { key: 'q3', label: t('quad.delegate'), icon: Clock, color: 'text-amber-600 dark:text-amber-400' },
    { key: 'q4', label: t('quad.eliminate'), icon: Layers, color: 'text-gray-500 dark:text-neutral-400' },
    { key: 'completed', label: t('nav.completed_tasks'), icon: Archive, color: 'text-gray-400 dark:text-neutral-500' },
  ];

  // 计算各分类计数
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: tasks.filter((t) => !t.isCompleted).length,
      q1: tasks.filter((t) => !t.isCompleted && t.quadrant === 'q1').length,
      q2: tasks.filter((t) => !t.isCompleted && t.quadrant === 'q2').length,
      q3: tasks.filter((t) => !t.isCompleted && t.quadrant === 'q3').length,
      q4: tasks.filter((t) => !t.isCompleted && t.quadrant === 'q4').length,
      completed: tasks.filter((t) => t.isCompleted).length,
    };
    return counts;
  }, [tasks]);

  // 同步统计数据至父级侧边栏
  useEffect(() => {
    onCountsUpdate?.(categoryCounts);
  }, [categoryCounts, onCountsUpdate]);

  // 计算多维效能统计数据 (供复盘弹窗使用)
  const stats = useMemo(() => {
    const total = tasks.length;
    const completed = tasks.filter((t) => t.isCompleted).length;
    const pending = total - completed;
    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

    const breakdown: Record<
      QuadrantId,
      { total: number; completed: number; pending: number; percent: number }
    > = {
      q1: { total: 0, completed: 0, pending: 0, percent: 0 },
      q2: { total: 0, completed: 0, pending: 0, percent: 0 },
      q3: { total: 0, completed: 0, pending: 0, percent: 0 },
      q4: { total: 0, completed: 0, pending: 0, percent: 0 },
    };

    tasks.forEach((t) => {
      const q = t.quadrant;
      if (breakdown[q]) {
        breakdown[q].total += 1;
        if (t.isCompleted) {
          breakdown[q].completed += 1;
        } else {
          breakdown[q].pending += 1;
        }
      }
    });

    if (total > 0) {
      (['q1', 'q2', 'q3', 'q4'] as const).forEach((qid) => {
        breakdown[qid].percent = Math.round((breakdown[qid].total / total) * 100);
      });
    }

    return { total, completed, pending, completionRate, breakdown };
  }, [tasks]);

  // 根据分类及搜索框过滤任务列表
  const { uncompletedTasks, completedTasks, filteredTasks } = useMemo(() => {
    const matching = tasks.filter((task) => {
      if (currentCategory === 'completed') {
        if (!task.isCompleted) return false;
      } else if (currentCategory.startsWith('q')) {
        if (task.quadrant !== currentCategory) return false;
      }

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchTitle = task.title.toLowerCase().includes(q);
        const matchDesc = task.description?.toLowerCase().includes(q);
        if (!matchTitle && !matchDesc) return false;
      }
      return true;
    });

    const uncompleted = matching.filter((t) => !t.isCompleted);
    const completed = matching.filter((t) => t.isCompleted);

    return {
      uncompletedTasks: uncompleted,
      completedTasks: completed,
      filteredTasks: viewMode === 'matrix' ? uncompleted : matching,
    };
  }, [tasks, currentCategory, searchQuery, viewMode]);

  // 点击直角坐标平面任意空白处，自动落位创建
  const handleCreateWithCoords = useCallback((importance: number, urgency: number) => {
    setClickCoords({ importance, urgency });
    setEditingTask(null);
    setIsTaskModalOpen(true);
  }, []);

  // 保存任务 (新建 / 编辑)
  const handleSaveTask = async (data: {
    title: string;
    description?: string;
    importance: number;
    urgency: number;
    useAutoUrgency?: boolean;
    dueDate?: string | null;
    tags?: string[];
    estimatedMinutes?: number;
    isFixed?: boolean;
    isConcurrent?: boolean;
    scheduledStart?: string | null;
    scheduledEnd?: string | null;
  }) => {
    try {
      const payload = {
        title: data.title,
        duration_minutes: data.estimatedMinutes || 60,
        importance: data.importance,
        urgency: data.urgency,
        deadline: data.dueDate ? new Date(data.dueDate).toISOString() : null,
        scheduled_start: data.scheduledStart || null,
        scheduled_end: data.scheduledEnd || null,
        is_fixed: data.isFixed ? 1 : 0,
        is_concurrent: data.isConcurrent ? 1 : 0,
        notes: data.description || '',
        auto_schedule: !data.isFixed,
      };

      if (editingTask) {
        await api.put(`/tasks/${editingTask.id}`, payload);
      } else {
        await api.post('/tasks', payload);
      }

      await fetchTasks();
      setIsTaskModalOpen(false);
      setEditingTask(null);
      setClickCoords(null);
    } catch (err: any) {
      alert(err.response?.data?.error || '保存任务失败，请重试');
    }
  };

  // Google Tasks 风格快速回车新建任务
  const handleQuickAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickTaskTitle.trim() || quickTaskSubmitting) return;
    setQuickTaskSubmitting(true);
    try {
      let imp = 6;
      let urg = 6;
      if (currentCategory === 'q1') { imp = 8; urg = 8; }
      else if (currentCategory === 'q2') { imp = 8; urg = 3; }
      else if (currentCategory === 'q3') { imp = 3; urg = 8; }
      else if (currentCategory === 'q4') { imp = 2; urg = 2; }

      await handleSaveTask({
        title: quickTaskTitle.trim(),
        importance: imp,
        urgency: urg,
        dueDate: formatLocalDate(new Date()),
        estimatedMinutes: 30,
      });
      setQuickTaskTitle('');
    } finally {
      setQuickTaskSubmitting(false);
    }
  };

  // 智能向导创建确认
  const handleWizardConfirm = (data: {
    title: string;
    importance: number;
    urgency: number;
    dueDate: string;
    estimatedMinutes?: number;
  }) => {
    handleSaveTask({
      title: data.title,
      importance: data.importance,
      urgency: data.urgency,
      dueDate: data.dueDate,
      estimatedMinutes: data.estimatedMinutes,
    });
    setIsWizardOpen(false);
  };

  // 快捷切换任务完成状态 (Google Todo 圆形复选框)
  const handleToggleComplete = async (taskId: string) => {
    const target = tasks.find((t) => t.id === taskId);
    if (!target) return;

    const willComplete = !target.isCompleted;

    // 乐观更新 UI
    setTasks((prev) =>
      prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              isCompleted: willComplete,
              completedDates: willComplete ? [formatLocalDate(new Date())] : [],
              completedAt: willComplete ? new Date().toISOString() : null,
            }
          : t
      )
    );

    try {
      await api.post(`/tasks/${taskId}/action`, {
        action: willComplete ? 'complete' : 'reopen',
      });
    } catch (err) {
      console.error('切换完成状态失败:', err);
      fetchTasks();
    }
  };

  // 删除任务
  const handleDeleteTask = async (taskId: string) => {
    if (!window.confirm('确定要删除该待办事项吗？')) return;

    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    try {
      await api.delete(`/tasks/${taskId}`);
    } catch (err) {
      console.error('删除任务失败:', err);
      fetchTasks();
    }
  };

  // 打开编辑任务
  const handleEditTask = (task: TaskItem) => {
    setEditingTask(task);
    setClickCoords(null);
    setIsTaskModalOpen(true);
  };

  // 数据导入
  const handleImportTasks = async (importedList: TaskItem[]) => {
    for (const t of importedList) {
      try {
        await api.post('/tasks', {
          title: t.title,
          duration_minutes: t.estimatedMinutes || 60,
          importance: t.importance,
          urgency: t.urgency,
          deadline: t.dueDate ? new Date(t.dueDate).toISOString() : null,
          notes: t.description || '',
          auto_schedule: true,
        });
      } catch (_) {}
    }
    await fetchTasks();
    setIsBackupOpen(false);
  };

  // 清空所有任务
  const handleClearAll = async () => {
    if (!window.confirm('确定要清空全部事项吗？此操作无法撤销！')) return;
    for (const t of tasks) {
      try {
        await api.delete(`/tasks/${t.id}`);
      } catch (_) {}
    }
    setTasks([]);
    setIsBackupOpen(false);
  };

  return (
    <div className="w-full h-full flex flex-col overflow-hidden bg-white dark:bg-[#1e1f20]">
      {/* 顶部极简操作工具栏 (主流 AI Agent 风格无缝顶栏) */}
      <header className="h-13 px-3 sm:px-6 border-b border-gray-200/80 dark:border-neutral-800 flex items-center justify-between gap-3 shrink-0 bg-white dark:bg-[#1e1f20] transition-colors">
        {/* 左侧: 移动端侧栏汉堡菜单 + 标题与分类 */}
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          {onOpenMobileMenu && (
            <button
              type="button"
              onClick={onOpenMobileMenu}
              className="md:hidden p-1.5 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:hover:bg-neutral-800 transition cursor-pointer"
              title="打开侧边导航"
            >
              <Menu className="w-5 h-5" />
            </button>
          )}

          <div className="flex items-center gap-2 truncate">
            <span className="text-sm font-bold text-gray-900 dark:text-gray-100 truncate">
              {viewMode === 'matrix' ? t('nav.matrix') : t('nav.list')}
            </span>
            <span className="text-xs text-gray-400 dark:text-neutral-500 font-mono hidden sm:inline">
              · {filterCategories.find((c) => c.key === currentCategory)?.label || t('nav.all_tasks')} ({filteredTasks.length})
            </span>
          </div>
        </div>

        {/* 右侧: 看板/列表双模态切换 + 搜索框 + 刷新 + 添加任务 */}
        <div className="flex items-center gap-2">
          {/* 看板 / 列表快速切换胶囊 */}
          <div className="flex items-center p-0.5 rounded-full bg-gray-100 dark:bg-neutral-800 text-xs font-medium border border-gray-200/50 dark:border-neutral-700/60">
            <button
              type="button"
              onClick={() => handleToggleViewMode('matrix')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full transition-all cursor-pointer ${
                viewMode === 'matrix'
                  ? 'bg-white dark:bg-[#28292a] text-blue-600 dark:text-blue-400 font-semibold shadow-2xs'
                  : 'text-gray-600 dark:text-neutral-400 hover:text-gray-900 dark:hover:text-neutral-200'
              }`}
              title={t('general.view_matrix_desc')}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span>{t('nav.matrix')}</span>
            </button>

            <button
              type="button"
              onClick={() => handleToggleViewMode('list')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full transition-all cursor-pointer ${
                viewMode === 'list'
                  ? 'bg-white dark:bg-[#28292a] text-blue-600 dark:text-blue-400 font-semibold shadow-2xs'
                  : 'text-gray-600 dark:text-neutral-400 hover:text-gray-900 dark:hover:text-neutral-200'
              }`}
              title={t('general.view_list_desc')}
            >
              <CheckSquare className="w-3.5 h-3.5" />
              <span>{t('nav.list')}</span>
            </button>
          </div>

          {/* 搜索框 */}
          <div className="relative w-28 sm:w-44">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-neutral-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('workspace.search_placeholder')}
              className="w-full pl-7.5 pr-2.5 py-1 text-xs bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700/80 text-gray-900 dark:text-gray-100 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition"
            />
          </div>

          {/* 刷新按钮 */}
          <button
            type="button"
            onClick={() => fetchTasks()}
            className="p-1.5 rounded-full border border-gray-200/80 dark:border-neutral-700/80 bg-white dark:bg-[#1e1f20] hover:bg-gray-100 dark:hover:bg-neutral-800 text-gray-600 dark:text-neutral-300 transition cursor-pointer"
            title={t('workspace.refresh_tasks')}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-blue-600' : ''}`} />
          </button>

          {/* 快捷中英文切换 */}
          <button
            type="button"
            onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
            className="p-1.5 rounded-full border border-gray-200/80 dark:border-neutral-700/80 bg-white dark:bg-[#1e1f20] hover:bg-gray-100 dark:hover:bg-neutral-800 text-gray-600 dark:text-neutral-300 transition cursor-pointer"
            title={language === 'zh' ? 'Switch to English' : '切换为简体中文'}
          >
            <Languages className="w-3.5 h-3.5" />
          </button>

          {/* 新建任务 */}
          <button
            type="button"
            onClick={() => {
              setEditingTask(null);
              setClickCoords(null);
              setIsTaskModalOpen(true);
            }}
            className="flex items-center gap-1.5 px-3.5 py-1 bg-blue-600 hover:bg-blue-700 text-white rounded-full text-xs font-semibold shadow-xs transition cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
            <span className="hidden sm:inline">{t('workspace.add_task')}</span>
          </button>
        </div>
      </header>

      {/* 核心无缝画布 (全高贴边无外层卡片) */}
      <div className="flex-1 min-h-0 w-full overflow-hidden p-2 sm:p-3">
        {/* 1. 四象限直角坐标系看板视图 */}
        {viewMode === 'matrix' && (
          <MatrixBoard
            tasks={filteredTasks}
            onToggleComplete={handleToggleComplete}
            onEdit={handleEditTask}
            onDelete={handleDeleteTask}
            onOpenCreateWithCoordinates={handleCreateWithCoords}
          />
        )}

        {/* 2. Google Tasks 待办清单列表视图 (模仿 Google Calendar - Tasks) */}
        {viewMode === 'list' && (
          <div className="h-full overflow-y-auto px-4 py-4 sm:px-8 sm:py-6 max-w-4xl mx-auto w-full scrollbar-thin select-none">
            {/* Google Tasks 风格快速新建任务栏 */}
            <form onSubmit={handleQuickAdd} className="mb-4">
              <div className="flex items-center gap-3 px-4 py-3 bg-[#f0f4f9] dark:bg-[#282a2d] hover:bg-[#e9eef6] dark:hover:bg-[#303337] focus-within:bg-white dark:focus-within:bg-[#202124] focus-within:shadow-md focus-within:ring-2 focus-within:ring-blue-500/20 rounded-2xl border border-transparent focus-within:border-gray-200 dark:focus-within:border-neutral-700 transition-all">
                <Plus className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0 stroke-[2.5]" />
                <input
                  type="text"
                  value={quickTaskTitle}
                  onChange={(e) => setQuickTaskTitle(e.target.value)}
                  placeholder={t('workspace.quick_add_placeholder', '添加待办事项 (输入后按 Enter 保存)...')}
                  className="flex-1 bg-transparent text-sm text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-neutral-400 outline-none"
                />
                {quickTaskTitle.trim() && (
                  <button
                    type="submit"
                    disabled={quickTaskSubmitting}
                    className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-semibold shadow-xs transition cursor-pointer"
                  >
                    {t('common.save', '保存')}
                  </button>
                )}
              </div>
            </form>

            {loading ? (
              <div className="p-12 text-center text-gray-400 dark:text-neutral-500 text-xs">
                {t('common.loading')}
              </div>
            ) : (currentCategory === 'completed' ? completedTasks : uncompletedTasks).length === 0 && (currentCategory === 'completed' || completedTasks.length === 0) ? (
              <div className="p-12 text-center space-y-3">
                <div className="w-14 h-14 mx-auto rounded-full bg-blue-50 dark:bg-blue-950/50 flex items-center justify-center text-blue-600 dark:text-blue-400">
                  <CheckCircle2 className="w-8 h-8 stroke-[1.8]" />
                </div>
                <div className="text-gray-800 dark:text-neutral-200 font-semibold text-base">
                  {searchQuery ? t('workspace.no_search_results') : (currentCategory === 'completed' ? '暂无已完成事项' : '所有待办已完成')}
                </div>
                <p className="text-gray-400 dark:text-neutral-500 text-xs max-w-sm mx-auto">
                  {t('workspace.empty_hint', '享受高效整理的美好时光，或点击上方输入框快速添加新事项。')}
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                {/* 活跃待办列表 */}
                {(currentCategory === 'completed' ? completedTasks : uncompletedTasks).map((task) => {
                  const isCompleted = task.isCompleted;
                  const quad = task.quadrant;

                  const quadStyles = {
                    q1: { name: t('quad.do_first'), color: 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300 border-rose-200 dark:border-rose-800' },
                    q2: { name: t('quad.schedule'), color: 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 border-blue-200 dark:border-blue-800' },
                    q3: { name: t('quad.delegate'), color: 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border-amber-200 dark:border-amber-800' },
                    q4: { name: t('quad.eliminate'), color: 'bg-gray-50 text-gray-600 dark:bg-neutral-800/60 dark:text-neutral-400 border-gray-200 dark:border-neutral-700' },
                  }[quad];

                  return (
                    <div
                      key={task.id}
                      className="py-3 px-3.5 rounded-xl hover:bg-[#f8fafd] dark:hover:bg-[#282a2d] transition-all flex items-start gap-3.5 group border-b border-gray-100/80 dark:border-neutral-800/60 last:border-b-0"
                    >
                      {/* Google Tasks 圆形复选框 */}
                      <button
                        type="button"
                        onClick={() => handleToggleComplete(task.id)}
                        className={`w-5 h-5 mt-0.5 rounded-full border-2 shrink-0 flex items-center justify-center transition-all cursor-pointer ${
                          isCompleted
                            ? 'bg-blue-600 dark:bg-blue-500 border-blue-600 dark:border-blue-500 text-white'
                            : 'border-gray-400 dark:border-neutral-500 hover:border-blue-600 dark:hover:border-blue-400 group-hover:border-blue-500 text-transparent hover:text-blue-600'
                        }`}
                        title={isCompleted ? t('workspace.mark_uncompleted') : t('workspace.mark_completed')}
                      >
                        <Check className="w-3 h-3 stroke-[3]" />
                      </button>

                      {/* 标题与详情 */}
                      <div className="min-w-0 flex-1 cursor-pointer" onClick={() => handleEditTask(task)}>
                        <div
                          className={`text-sm font-medium leading-snug truncate ${
                            isCompleted ? 'line-through text-gray-400 dark:text-neutral-500' : 'text-gray-900 dark:text-gray-100'
                          }`}
                        >
                          {task.title}
                        </div>

                        {task.description && (
                          <div className="text-xs text-gray-500 dark:text-neutral-400 mt-1 line-clamp-2">
                            {task.description}
                          </div>
                        )}

                        {/* Google Tasks 风格 Chips */}
                        <div className="mt-2 flex items-center gap-2 flex-wrap text-xs">
                          {task.dueDate && (
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-normal border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-gray-700 dark:text-neutral-300 hover:border-blue-500 hover:text-blue-600 transition">
                              <CalendarIcon className="w-3 h-3 text-gray-500 dark:text-neutral-400" />
                              <span>{task.dueDate}</span>
                            </span>
                          )}
                          <span
                            className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium border ${quadStyles.color}`}
                          >
                            {quadStyles.name}
                          </span>
                          {task.estimatedMinutes && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] bg-gray-100 dark:bg-neutral-800 text-gray-600 dark:text-neutral-400 font-mono">
                              <Clock className="w-3 h-3" />
                              <span>{task.estimatedMinutes} {t('general.minutes')}</span>
                            </span>
                          )}
                        </div>
                      </div>

                      {/* 悬浮操作按钮 */}
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button
                          type="button"
                          onClick={() => handleEditTask(task)}
                          className="p-1.5 rounded-full text-gray-400 hover:text-blue-600 hover:bg-gray-100 dark:hover:bg-neutral-800 transition cursor-pointer"
                          title={t('common.edit')}
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteTask(task.id)}
                          className="p-1.5 rounded-full text-gray-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition cursor-pointer"
                          title={t('common.delete')}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}

                {/* Google Tasks 已完成事项折叠面板 */}
                {completedTasks.length > 0 && currentCategory !== 'completed' && (
                  <div className="mt-8 pt-4 border-t border-gray-200/80 dark:border-neutral-800">
                    <button
                      type="button"
                      onClick={() => setCompletedExpanded(!completedExpanded)}
                      className="flex items-center gap-2 text-xs font-semibold text-gray-500 dark:text-neutral-400 hover:text-gray-800 dark:hover:text-neutral-200 transition py-1 cursor-pointer select-none"
                    >
                      {completedExpanded ? (
                        <ChevronDown className="w-4 h-4 text-gray-500" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-500" />
                      )}
                      <span>{t('workspace.completed_section', '已完成')} ({completedTasks.length})</span>
                    </button>

                    {completedExpanded && (
                      <div className="mt-2 space-y-1">
                        {completedTasks.map((task) => (
                          <div
                            key={task.id}
                            className="py-2.5 px-3.5 rounded-xl hover:bg-[#f8fafd] dark:hover:bg-[#282a2d] transition-all flex items-start gap-3.5 group opacity-75 hover:opacity-100 border-b border-gray-100/60 dark:border-neutral-800/40 last:border-b-0"
                          >
                            <button
                              type="button"
                              onClick={() => handleToggleComplete(task.id)}
                              className="w-5 h-5 mt-0.5 rounded-full bg-blue-600 dark:bg-blue-500 border-2 border-blue-600 dark:border-blue-500 text-white flex items-center justify-center shrink-0 transition-all cursor-pointer"
                              title={t('workspace.mark_uncompleted')}
                            >
                              <Check className="w-3 h-3 stroke-[3]" />
                            </button>

                            <div className="min-w-0 flex-1 cursor-pointer" onClick={() => handleEditTask(task)}>
                              <div className="text-sm font-normal line-through text-gray-400 dark:text-neutral-500 leading-snug">
                                {task.title}
                              </div>
                              {task.description && (
                                <div className="text-xs text-gray-400 dark:text-neutral-500 mt-0.5 line-clamp-1">
                                  {task.description}
                                </div>
                              )}
                            </div>

                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                              <button
                                type="button"
                                onClick={() => handleDeleteTask(task.id)}
                                className="p-1 rounded-full text-gray-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition cursor-pointer"
                                title={t('common.delete')}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ===================== 全局交互模态框 ===================== */}
      <TaskModal
        isOpen={isTaskModalOpen}
        onClose={() => {
          setIsTaskModalOpen(false);
          setEditingTask(null);
          setClickCoords(null);
        }}
        onSave={handleSaveTask}
        onToggleComplete={handleToggleComplete}
        onDelete={handleDeleteTask}
        initialTask={editingTask}
        defaultImportance={clickCoords?.importance ?? 7}
        defaultUrgency={clickCoords?.urgency}
        allExistingTags={allTags}
      />

      <WizardModal
        isOpen={isWizardOpen}
        onClose={() => setIsWizardOpen(false)}
        onConfirmTask={handleWizardConfirm}
      />

      <StatsModal
        isOpen={isStatsOpen}
        onClose={() => setIsStatsOpen(false)}
        stats={stats}
      />

      <BackupModal
        isOpen={isBackupOpen}
        onClose={() => setIsBackupOpen(false)}
        tasks={tasks}
        onImport={handleImportTasks}
        onClearAll={handleClearAll}
      />
    </div>
  );
};
