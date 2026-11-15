import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import {
  LayoutGrid,
  CalendarDays,
  CheckSquare,
  Inbox,
  Flame,
  Star,
  Clock,
  Layers,
  Archive,
  ChevronDown,
  ChevronRight,
  Settings,
  Users,
  Terminal,
  Plus,
  X,
} from 'lucide-react';

export interface SidebarProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  activeCategory: string;
  setActiveCategory: (cat: string) => void;
  categoryCounts: Record<string, number>;
  onNewTask: () => void;
  onOpenWizard?: () => void;
  onOpenStats?: () => void;
  onOpenBackup?: () => void;
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
  pendingUsersCount = 0,
  mobileOpen,
  setMobileOpen,
}) => {
  const { user } = useAuth();
  const { t } = useTheme();

  // 待办清单子分类折叠/展开状态
  const [tasksExpanded, setTasksExpanded] = useState(true);

  // 判断是否当前选中待办清单 (只有当前选中待办清单时，分类才显示选中)
  const isListActive = activeTab === 'list' || activeTab === 'todos';

  // 待办清单分类导航 (全部待办 + 四象限 + 已完成)
  const filterCategories = [
    { key: 'all', label: t('nav.all_tasks', '全部待办'), icon: Inbox, color: 'text-blue-600 dark:text-blue-400' },
    { key: 'q1', label: 'Do First', icon: Flame, color: 'text-rose-500' },
    { key: 'q2', label: 'Schedule', icon: Star, color: 'text-blue-500' },
    { key: 'q3', label: 'Delegate', icon: Clock, color: 'text-amber-500' },
    { key: 'q4', label: 'Eliminate', icon: Layers, color: 'text-gray-400 dark:text-neutral-500' },
    { key: 'completed', label: t('nav.completed', '已完成事项'), icon: Archive, color: 'text-gray-400 dark:text-neutral-500' },
  ];

  const handleSelectView = (viewId: string) => {
    setActiveTab(viewId);
    setMobileOpen(false);
  };

  const handleSelectCategory = (catKey: string) => {
    setActiveCategory(catKey);
    // 点击待办分类，自动激活待办清单视图
    if (!isListActive) {
      setActiveTab('list');
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
                {t('nav.brand_sub', '智能时间规划 Agent')}
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

        {/* 核心行动按钮 */}
        <button
          type="button"
          onClick={handleCreateTask}
          className="w-full flex items-center justify-center gap-2 py-2 px-3.5 rounded-xl bg-blue-600 hover:bg-blue-700 active:scale-98 text-white text-xs font-semibold shadow-xs hover:shadow transition cursor-pointer"
        >
          <Plus className="w-4 h-4 stroke-[2.5]" />
          <span>{t('nav.new_task', '新建待办')}</span>
          <kbd className="hidden sm:inline-block ml-auto px-1.5 py-0.2 rounded text-[10px] bg-blue-700 text-blue-100 font-mono">
            N
          </kbd>
        </button>
      </div>

      {/* 中部可滚动导航区域 */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-3 py-2 space-y-3 scrollbar-thin">
        {/* 1. 视图导航：第一项四象限表格，第二项日历日程，第三项待办清单 */}
        <div className="space-y-1">
          {/* 第一项：四象限表格 */}
          <button
            type="button"
            onClick={() => handleSelectView('matrix')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer ${
              activeTab === 'matrix'
                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 font-semibold shadow-2xs'
                : 'text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800/60'
            }`}
          >
            <LayoutGrid className={`w-4 h-4 shrink-0 ${activeTab === 'matrix' ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-neutral-400'}`} />
            <span className="truncate flex-1 text-left">{t('nav.matrix', '四象限表格')}</span>
          </button>

          {/* 第二项：日历日程 */}
          <button
            type="button"
            onClick={() => handleSelectView('calendar')}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer ${
              activeTab === 'calendar'
                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 font-semibold shadow-2xs'
                : 'text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800/60'
            }`}
          >
            <CalendarDays className={`w-4 h-4 shrink-0 ${activeTab === 'calendar' ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-neutral-400'}`} />
            <span className="truncate flex-1 text-left">{t('nav.calendar', '日历日程')}</span>
          </button>

          {/* 第三项：待办清单 (支持展开/折叠分类) */}
          <div className="space-y-1 pt-0.5">
            <div
              className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer group select-none ${
                isListActive
                  ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 font-semibold shadow-2xs'
                  : 'text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800/60'
              }`}
              onClick={() => {
                if (!isListActive) {
                  handleSelectView('list');
                  setTasksExpanded(true);
                } else {
                  setTasksExpanded((prev) => !prev);
                }
              }}
            >
              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                <CheckSquare className={`w-4 h-4 shrink-0 ${isListActive ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-neutral-400'}`} />
                <span className="truncate">{t('nav.list', '待办清单')}</span>
              </div>

              {/* 展开/折叠箭头指示 */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setTasksExpanded((prev) => !prev);
                }}
                className="p-0.5 text-gray-400 hover:text-gray-600 dark:text-neutral-500 dark:hover:text-neutral-300 rounded transition cursor-pointer"
                title={tasksExpanded ? '折叠分类' : '展开分类'}
              >
                {tasksExpanded ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
              </button>
            </div>

            {/* 待办清单展开分类 (模仿 agent project workspace 的左侧树缩进与指示线) */}
            {tasksExpanded && (
              <div className="ml-3.5 pl-2.5 border-l border-gray-200/90 dark:border-neutral-800 space-y-0.5 py-0.5">
                {filterCategories.map((item) => {
                  const Icon = item.icon;
                  // 关键规则：如果没有选中代办清单，分类就不显示选中
                  const isCatActive = isListActive && activeCategory === item.key;
                  const count = categoryCounts[item.key] ?? 0;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => handleSelectCategory(item.key)}
                      className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                        isCatActive
                          ? 'bg-blue-100/70 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-semibold shadow-2xs'
                          : 'text-gray-600 dark:text-neutral-400 hover:bg-gray-100/80 dark:hover:bg-neutral-800/50 hover:text-gray-900 dark:hover:text-neutral-200'
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <Icon className={`w-3.5 h-3.5 shrink-0 ${item.color}`} />
                        <span className="truncate">{item.label}</span>
                      </div>
                      <span
                        className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono shrink-0 ${
                          isCatActive
                            ? 'bg-blue-600 text-white font-bold'
                            : 'bg-gray-100 dark:bg-neutral-800 text-gray-400 dark:text-neutral-500'
                        }`}
                      >
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* 2. 管理员专属运维视图 (若为管理员) */}
        {user?.role === 'admin' && (
          <div className="space-y-1 pt-1 border-t border-gray-100 dark:border-neutral-800/80">
            <div className="px-2 py-1 text-[10px] font-semibold tracking-wider uppercase text-gray-400 dark:text-neutral-500">
              {t('nav.admin', '系统运维')}
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
                <span>{t('nav.users', '用户审核')}</span>
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
              <span>{t('nav.debugger', '系统调试')}</span>
            </button>
          </div>
        )}
      </div>

      {/* 底部固定区域：仅显示【左：头像+昵称 右：设置符号】 */}
      <div className="p-2.5 border-t border-gray-200/80 dark:border-neutral-800 shrink-0">
        <button
          type="button"
          onClick={() => handleSelectView('settings')}
          className={`w-full flex items-center justify-between p-2 rounded-xl transition cursor-pointer group ${
            activeTab === 'settings'
              ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 font-semibold shadow-2xs'
              : 'text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800/60'
          }`}
          title="账号与系统设置"
        >
          {/* 左：头像 + 昵称 */}
          <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2 text-left">
            {user?.avatar_url ? (
              <img
                src={user.avatar_url}
                alt="头像"
                className="w-7 h-7 rounded-full object-cover shrink-0 ring-1 ring-gray-200 dark:ring-neutral-700 shadow-2xs"
              />
            ) : (
              <div className="w-7 h-7 rounded-full bg-blue-600 dark:bg-blue-500 text-white font-bold flex items-center justify-center text-xs shrink-0 shadow-2xs">
                {(user?.nickname || user?.username || 'U').slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1 truncate">
              <div className="text-xs font-semibold text-gray-800 dark:text-gray-200 truncate leading-tight flex items-center gap-1.5">
                <span className="truncate">{user?.nickname || user?.username}</span>
                {user?.role === 'admin' && (
                  <span className="px-1 py-0.2 rounded text-[9px] bg-blue-100 dark:bg-blue-950 text-blue-600 dark:text-blue-400 font-mono shrink-0">
                    Admin
                  </span>
                )}
              </div>
              <div className="text-[10px] text-gray-400 dark:text-neutral-500 truncate mt-0.5">
                @{user?.username}
              </div>
            </div>
          </div>

          {/* 右：设置符号 */}
          <div className="p-1.5 text-gray-400 group-hover:text-gray-700 dark:text-neutral-400 dark:group-hover:text-neutral-200 rounded-lg transition shrink-0">
            <Settings className={`w-4 h-4 ${activeTab === 'settings' ? 'text-blue-600 dark:text-blue-400' : ''}`} />
          </div>
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* 桌面端常驻左侧边栏 (无右侧分界线，无缝融合) */}
      <aside className="hidden md:flex w-64 shrink-0 h-full bg-[#f8fafd] dark:bg-[#18191a] overflow-hidden select-none">
        {sidebarContent}
      </aside>

      {/* 移动端侧边抽屉 */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-xs transition-opacity"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative w-64 max-w-[80vw] h-full bg-[#f8fafd] dark:bg-[#18191a] shadow-2xl z-10 overflow-hidden select-none">
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  );
};
