import React, { useRef, useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useTheme, type ThemeMode } from '../context/ThemeContext';
import {
  LayoutGrid,
  CheckSquare,
  CalendarDays,
  Inbox,
  Flame,
  Star,
  Clock,
  Layers,
  Archive,
  Sparkles,
  PieChart,
  ArrowUpDown,
  Settings,
  Users,
  Terminal,
  Sun,
  Moon,
  Monitor,
  LogOut,
  Plus,
  X,
  Check,
} from 'lucide-react';

export interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  activeCategory: string;
  setActiveCategory: (cat: string) => void;
  categoryCounts: Record<string, number>;
  onNewTask: () => void;
  onOpenWizard: () => void;
  onOpenStats: () => void;
  onOpenBackup: () => void;
  pendingUsersCount?: number;
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  activeCategory,
  setActiveCategory,
  categoryCounts,
  onNewTask,
  onOpenWizard,
  onOpenStats,
  onOpenBackup,
  pendingUsersCount = 0,
  mobileOpen,
  setMobileOpen,
}) => {
  const { user, logout } = useAuth();
  const { themeMode, setThemeMode, isDark } = useTheme();
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭主题下拉框
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (themeMenuRef.current && !themeMenuRef.current.contains(e.target as Node)) {
        setThemeMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const themeOptions: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
    { mode: 'system', label: '跟随系统', icon: Monitor },
    { mode: 'light', label: '浅色模式', icon: Sun },
    { mode: 'dark', label: '深色模式', icon: Moon },
  ];

  // 主视图导航
  const mainViews = [
    { id: 'matrix', label: '四象限看板', icon: LayoutGrid },
    { id: 'list', label: '待办清单', icon: CheckSquare },
    { id: 'calendar', label: '日历日程', icon: CalendarDays },
  ];

  // 四象限分类导航
  const filterCategories = [
    { key: 'all', label: '全部待办', icon: Inbox, color: 'text-blue-600 dark:text-blue-400' },
    { key: 'q1', label: 'Do First', icon: Flame, color: 'text-rose-500' },
    { key: 'q2', label: 'Schedule', icon: Star, color: 'text-blue-500' },
    { key: 'q3', label: 'Delegate', icon: Clock, color: 'text-amber-500' },
    { key: 'q4', label: 'Eliminate', icon: Layers, color: 'text-gray-400 dark:text-neutral-500' },
    { key: 'completed', label: '已完成事项', icon: Archive, color: 'text-gray-400 dark:text-neutral-500' },
  ];

  const handleSelectView = (viewId: string) => {
    setActiveTab(viewId);
    setMobileOpen(false);
  };

  const handleSelectCategory = (catKey: string) => {
    setActiveCategory(catKey);
    // 若当前不在待办/看板视图，切换回四象限看板
    if (activeTab !== 'matrix' && activeTab !== 'list') {
      setActiveTab('matrix');
    }
    setMobileOpen(false);
  };

  const handleCreateTask = () => {
    onNewTask();
    if (activeTab !== 'matrix' && activeTab !== 'list') {
      setActiveTab('matrix');
    }
    setMobileOpen(false);
  };

  const sidebarContent = (
    <div className="w-full h-full flex flex-col justify-between select-none overflow-hidden">
      {/* 顶部区域：Brand 标识 + 新建按钮 */}
      <div className="p-4 pb-2 shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-blue-600 dark:bg-blue-500 flex items-center justify-center text-white shadow-xs">
              <CheckSquare className="w-4.5 h-4.5 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-1.5 leading-none">
                <span className="font-bold text-sm tracking-tight text-gray-900 dark:text-gray-100">
                  Clawbot
                </span>
                <span className="font-semibold text-xs text-blue-600 dark:text-blue-400">
                  Tasks
                </span>
              </div>
              <span className="text-[10px] text-gray-400 dark:text-neutral-500 mt-0.5 block">
                智能时间规划 Agent
              </span>
            </div>
          </div>

          {/* 移动端关闭按钮 */}
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="md:hidden p-1 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-neutral-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 核心行动按钮 (模仿主流 AI Agent 的 New Task 按钮) */}
        <button
          type="button"
          onClick={handleCreateTask}
          className="w-full flex items-center justify-center gap-2 py-2 px-3.5 rounded-xl bg-blue-600 hover:bg-blue-700 active:scale-98 text-white text-xs font-semibold shadow-xs hover:shadow transition cursor-pointer"
        >
          <Plus className="w-4 h-4 stroke-[2.5]" />
          <span>新建待办</span>
          <kbd className="hidden sm:inline-block ml-auto px-1.5 py-0.2 rounded text-[10px] bg-blue-700 text-blue-100 font-mono">
            N
          </kbd>
        </button>
      </div>

      {/* 中部可滚动导航区域 */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-3 py-2 space-y-4 scrollbar-thin">
        {/* 1. 主视图 */}
        <div className="space-y-1">
          <div className="px-2 py-1 text-[10px] font-semibold tracking-wider uppercase text-gray-400 dark:text-neutral-500">
            视图导航
          </div>
          {mainViews.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSelectView(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer ${
                  isActive
                    ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 font-semibold shadow-2xs'
                    : 'text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800/60'
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-neutral-400'}`} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>

        {/* 2. 四象限与分类筛选 (当处于看板或清单时深度联动) */}
        <div className="space-y-1">
          <div className="px-2 py-1 text-[10px] font-semibold tracking-wider uppercase text-gray-400 dark:text-neutral-500 flex items-center justify-between">
            <span>四象限分类</span>
          </div>
          {filterCategories.map((item) => {
            const Icon = item.icon;
            const isCatActive = (activeTab === 'matrix' || activeTab === 'list') && activeCategory === item.key;
            const count = categoryCounts[item.key] ?? 0;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => handleSelectCategory(item.key)}
                className={`w-full flex items-center justify-between px-3 py-1.5 rounded-xl text-xs font-medium transition cursor-pointer ${
                  isCatActive
                    ? 'bg-gray-200/70 dark:bg-neutral-800 text-gray-900 dark:text-gray-100 font-semibold'
                    : 'text-gray-600 dark:text-neutral-400 hover:bg-gray-100/70 dark:hover:bg-neutral-800/40 hover:text-gray-900 dark:hover:text-neutral-200'
                }`}
              >
                <div className="flex items-center gap-2.5 truncate">
                  <Icon className={`w-3.5 h-3.5 shrink-0 ${item.color}`} />
                  <span className="truncate">{item.label}</span>
                </div>
                <span
                  className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono shrink-0 ${
                    isCatActive
                      ? 'bg-blue-600 text-white font-bold'
                      : 'bg-gray-100 dark:bg-neutral-800 text-gray-500 dark:text-neutral-400'
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* 3. 辅助效率工具 */}
        <div className="space-y-1">
          <div className="px-2 py-1 text-[10px] font-semibold tracking-wider uppercase text-gray-400 dark:text-neutral-500">
            效率辅助
          </div>
          <button
            type="button"
            onClick={() => {
              onOpenWizard();
              setMobileOpen(false);
            }}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-xl text-xs font-medium text-gray-600 dark:text-neutral-400 hover:bg-gray-100/70 dark:hover:bg-neutral-800/50 hover:text-gray-900 dark:hover:text-neutral-200 transition text-left cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
            <span>智能决策向导</span>
          </button>
          <button
            type="button"
            onClick={() => {
              onOpenStats();
              setMobileOpen(false);
            }}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-xl text-xs font-medium text-gray-600 dark:text-neutral-400 hover:bg-gray-100/70 dark:hover:bg-neutral-800/50 hover:text-gray-900 dark:hover:text-neutral-200 transition text-left cursor-pointer"
          >
            <PieChart className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>精力复盘分析</span>
          </button>
          <button
            type="button"
            onClick={() => {
              onOpenBackup();
              setMobileOpen(false);
            }}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-xl text-xs font-medium text-gray-600 dark:text-neutral-400 hover:bg-gray-100/70 dark:hover:bg-neutral-800/50 hover:text-gray-900 dark:hover:text-neutral-200 transition text-left cursor-pointer"
          >
            <ArrowUpDown className="w-3.5 h-3.5 text-gray-500 dark:text-neutral-400 shrink-0" />
            <span>数据备份导入</span>
          </button>
        </div>

        {/* 4. 管理员专属视图 */}
        {user?.role === 'admin' && (
          <div className="space-y-1">
            <div className="px-2 py-1 text-[10px] font-semibold tracking-wider uppercase text-gray-400 dark:text-neutral-500">
              系统运维
            </div>
            <button
              type="button"
              onClick={() => handleSelectView('admin')}
              className={`w-full flex items-center justify-between px-3 py-1.5 rounded-xl text-xs font-medium transition cursor-pointer ${
                activeTab === 'admin'
                  ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 font-semibold'
                  : 'text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800/60'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Users className="w-3.5 h-3.5" />
                <span>用户审核</span>
              </div>
              {pendingUsersCount > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-rose-500 text-white animate-pulse">
                  {pendingUsersCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => handleSelectView('debug')}
              className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-xl text-xs font-medium transition cursor-pointer ${
                activeTab === 'debug'
                  ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 font-semibold'
                  : 'text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800/60'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>系统调试</span>
            </button>
          </div>
        )}
      </div>

      {/* 底部固定区域：设置与账户合并 (一体化账号卡片) */}
      <div className="p-2.5 border-t border-gray-200/80 dark:border-neutral-800 shrink-0">
        <div
          onClick={() => handleSelectView('settings')}
          className={`flex items-center justify-between p-2 rounded-xl transition cursor-pointer ${
            activeTab === 'settings'
              ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 font-semibold shadow-2xs'
              : 'text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800/60'
          }`}
          title="点击进入设置与偏好"
        >
          {/* 左侧：用户头像与名称、设置状态提示 */}
          <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-1">
            <div className="w-7 h-7 rounded-full bg-blue-600 dark:bg-blue-500 text-white font-bold flex items-center justify-center text-xs shrink-0 shadow-2xs">
              {user?.username?.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1 truncate text-left">
              <div className="text-xs font-semibold text-gray-800 dark:text-gray-200 truncate leading-tight flex items-center gap-1.5">
                <span className="truncate">{user?.username}</span>
                {user?.role === 'admin' && (
                  <span className="px-1 py-0.2 rounded text-[9px] bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400 font-mono shrink-0">
                    Admin
                  </span>
                )}
              </div>
              <div className="text-[10px] text-gray-400 dark:text-neutral-500 truncate flex items-center gap-1 mt-0.5">
                <Settings className={`w-2.5 h-2.5 shrink-0 ${activeTab === 'settings' ? 'text-blue-600 dark:text-blue-400' : ''}`} />
                <span>设置与偏好</span>
              </div>
            </div>
          </div>

          {/* 右侧：外观模式切换与退出登录按钮 (防止冒泡进入设置) */}
          <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
            <div className="relative" ref={themeMenuRef}>
              <button
                type="button"
                onClick={() => setThemeMenuOpen(!themeMenuOpen)}
                title={`当前外观：${themeMode === 'system' ? '跟随系统' : themeMode === 'light' ? '浅色' : '深色'}`}
                className="p-1.5 text-gray-400 hover:text-gray-700 dark:text-neutral-400 dark:hover:text-neutral-200 hover:bg-gray-200/60 dark:hover:bg-neutral-700/60 rounded-lg transition cursor-pointer"
              >
                {isDark ? <Moon className="w-3.5 h-3.5 text-blue-400" /> : <Sun className="w-3.5 h-3.5 text-amber-500" />}
              </button>

              {themeMenuOpen && (
                <div className="absolute right-0 bottom-full mb-2 w-32 bg-white dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700/80 rounded-xl shadow-lg p-1 z-50 text-xs">
                  {themeOptions.map((opt) => {
                    const Icon = opt.icon;
                    const isSelected = themeMode === opt.mode;
                    return (
                      <button
                        key={opt.mode}
                        type="button"
                        onClick={() => {
                          setThemeMode(opt.mode);
                          setThemeMenuOpen(false);
                        }}
                        className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-left transition cursor-pointer ${
                          isSelected
                            ? 'bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 font-medium'
                            : 'text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <Icon className="w-3.5 h-3.5" />
                          <span>{opt.label}</span>
                        </div>
                        {isSelected && <Check className="w-3 h-3" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={logout}
              title="退出登录"
              className="p-1.5 text-gray-400 hover:text-rose-600 dark:text-neutral-500 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* 桌面端常驻左侧边栏 */}
      <aside className="hidden md:flex w-64 shrink-0 h-full bg-[#f9fafb] dark:bg-[#18191a] border-r border-gray-200/80 dark:border-neutral-800 overflow-hidden">
        {sidebarContent}
      </aside>

      {/* 移动端侧边抽屉 */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-xs transition-opacity"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative w-64 max-w-[80vw] h-full bg-[#f9fafb] dark:bg-[#18191a] border-r border-gray-200 dark:border-neutral-800 shadow-2xl z-10 overflow-hidden">
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  );
};
