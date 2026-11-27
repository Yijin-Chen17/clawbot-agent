import React, { useState, useEffect, useCallback } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider, useTheme } from './context/ThemeContext';
import { Sidebar } from './components/Sidebar';
import { EisenhowerWorkspace } from './components/EisenhowerWorkspace';
import { LazyBoundary, lazyNamed } from './utils/lazyNamed';
import { api } from './api/client';

const AuthPage = lazyNamed(() => import('./pages/AuthPage'), 'AuthPage');
const CalendarView = lazyNamed(() => import('./components/CalendarView'), 'CalendarView');
const SettingsView = lazyNamed(() => import('./components/SettingsView'), 'SettingsView');
const AdminUsersView = lazyNamed(() => import('./components/AdminUsersView'), 'AdminUsersView');
const AdminApiView = lazyNamed(() => import('./components/AdminApiView'), 'AdminApiView');
const SystemDebugger = lazyNamed(() => import('./components/SystemDebugger'), 'SystemDebugger');

const DashboardContent: React.FC = () => {
  const { user, loading } = useAuth();
  const { t } = useTheme();
  // 当前活动视图：四象限看板 (matrix) / 待办清单 (list) / 日历日程 (calendar) / 设置 (settings) / 审核 (admin) / 调试 (debug)
  const [activeTab, setActiveTab] = useState<string>('calendar');
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({});
  const [pendingCount, setPendingCount] = useState(0);

  // 模态框全局触发状态 (由侧边栏触发)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [isStatsOpen, setIsStatsOpen] = useState(false);
  const [isBackupOpen, setIsBackupOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [hasVisitedCalendar, setHasVisitedCalendar] = useState(true);

  const handleTabChange = useCallback((tab: string) => {
    if (tab === 'calendar') {
      setHasVisitedCalendar(true);
    }
    setActiveTab(tab);
  }, []);

  // 新用户首次登录默认进设置页完成微信/外部对接，后续默认进入四象限看板
  useEffect(() => {
    if (user?.id) {
      const onboardedKey = `clawbot_user_onboarded_${user.id}`;
      const hasOnboarded = localStorage.getItem(onboardedKey);
      if (!hasOnboarded) {
        localStorage.setItem(onboardedKey, 'true');
        setActiveTab('settings');
      }
    }
  }, [user?.id]);

  const userRole = user?.role;
  const userId = user?.id;

  const fetchPendingCount = useCallback(async () => {
    if (userRole === 'admin') {
      try {
        const res = await api.get('/admin/users');
        const count = res.data.users.filter((u: any) => u.status === 'pending').length;
        setPendingCount(count);
      } catch {}
    }
  }, [userRole]);

  useEffect(() => {
    if (userId && userRole === 'admin') {
      fetchPendingCount();
    } else {
      setPendingCount(0);
    }
  }, [userId, userRole, fetchPendingCount]);

  if (loading) {
    return (
      <div className="min-h-screen bg-white dark:bg-[#1e1f20] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-8 w-8 border-3 border-blue-600 dark:border-blue-400 border-t-transparent"></div>
          <span className="text-gray-500 dark:text-neutral-400 text-xs font-medium">Clawbot Tasks {t('common.loading', '加载中...')}</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <LazyBoundary>
        <AuthPage />
      </LazyBoundary>
    );
  }

  return (
    <div className="h-[100dvh] w-full overflow-hidden flex bg-white dark:bg-[#1e1f20] text-gray-900 dark:text-gray-100 transition-colors">
      {/* 主流 AI Agent 风格左侧边栏 */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={handleTabChange}
        activeCategory={activeCategory}
        setActiveCategory={setActiveCategory}
        categoryCounts={categoryCounts}
        onNewTask={() => {
          setIsCreateModalOpen(true);
          if (activeTab !== 'matrix' && activeTab !== 'list') {
            setActiveTab('matrix');
          }
        }}
        onOpenWizard={() => {
          setIsWizardOpen(true);
          if (activeTab !== 'matrix' && activeTab !== 'list') {
            setActiveTab('matrix');
          }
        }}
        onOpenStats={() => {
          setIsStatsOpen(true);
          if (activeTab !== 'matrix' && activeTab !== 'list') {
            setActiveTab('matrix');
          }
        }}
        onOpenBackup={() => {
          setIsBackupOpen(true);
          if (activeTab !== 'matrix' && activeTab !== 'list') {
            setActiveTab('matrix');
          }
        }}
        pendingUsersCount={pendingCount}
        mobileOpen={mobileSidebarOpen}
        setMobileOpen={setMobileSidebarOpen}
      />

      {/* 右侧主工作区 (无外层卡片与外边距，纯净贴边满高) */}
      <main className="flex-1 h-full min-w-0 overflow-hidden flex flex-col bg-white dark:bg-[#1e1f20]">
        <div className={`w-full h-full flex flex-col overflow-hidden ${activeTab === 'matrix' || activeTab === 'list' || activeTab === 'todos' ? '' : 'hidden'}`}>
          <EisenhowerWorkspace
            currentView={activeTab === 'list' ? 'list' : 'matrix'}
            onSwitchView={(v) => handleTabChange(v)}
            activeCategory={activeCategory}
            setActiveCategory={setActiveCategory}
            onCountsUpdate={setCategoryCounts}
            onOpenMobileMenu={() => setMobileSidebarOpen(true)}
            isCreateModalOpen={isCreateModalOpen}
            setIsCreateModalOpen={setIsCreateModalOpen}
            isWizardOpen={isWizardOpen}
            setIsWizardOpen={setIsWizardOpen}
            isStatsOpen={isStatsOpen}
            setIsStatsOpen={setIsStatsOpen}
            isBackupOpen={isBackupOpen}
            setIsBackupOpen={setIsBackupOpen}
          />
        </div>
        <div className={`w-full h-full flex flex-col overflow-hidden ${activeTab === 'calendar' ? '' : 'hidden'}`}>
          {hasVisitedCalendar && (
            <LazyBoundary>
              <CalendarView
                onOpenMobileMenu={() => setMobileSidebarOpen(true)}
                isActive={activeTab === 'calendar'}
              />
            </LazyBoundary>
          )}
        </div>
        {activeTab === 'settings' && (
          <div className="w-full h-full flex flex-col overflow-hidden p-3 sm:p-5">
            <LazyBoundary>
              <SettingsView onOpenMobileMenu={() => setMobileSidebarOpen(true)} />
            </LazyBoundary>
          </div>
        )}
        {activeTab === 'admin' && user.role === 'admin' && (
          <div className="w-full h-full flex flex-col overflow-hidden p-3 sm:p-5">
            <button type="button" onClick={() => setMobileSidebarOpen(true)} aria-label={t('nav.open_sidebar', '打开侧边导航')} className="md:hidden self-start mb-2 rounded-lg px-3 py-2 text-sm text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800">☰ {t('nav.menu', '菜单')}</button>
            <LazyBoundary>
              <AdminUsersView onRefreshCount={fetchPendingCount} />
            </LazyBoundary>
          </div>
        )}
        {activeTab === 'api' && user.role === 'admin' && (
          <div className="w-full h-full flex flex-col overflow-hidden p-3 sm:p-5">
            <button type="button" onClick={() => setMobileSidebarOpen(true)} aria-label={t('nav.open_sidebar', '打开侧边导航')} className="md:hidden self-start mb-2 rounded-lg px-3 py-2 text-sm text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800">☰ {t('nav.menu', '菜单')}</button>
            <LazyBoundary>
              <AdminApiView />
            </LazyBoundary>
          </div>
        )}
        {activeTab === 'debug' && user.role === 'admin' && (
          <div className="w-full h-full flex flex-col overflow-hidden p-3 sm:p-5">
            <button type="button" onClick={() => setMobileSidebarOpen(true)} aria-label={t('nav.open_sidebar', '打开侧边导航')} className="md:hidden self-start mb-2 rounded-lg px-3 py-2 text-sm text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800">☰ {t('nav.menu', '菜单')}</button>
            <LazyBoundary>
              <SystemDebugger />
            </LazyBoundary>
          </div>
        )}
      </main>
    </div>
  );
};

export const App: React.FC = () => {
  return (
    <ThemeProvider>
      <AuthProvider>
        <DashboardContent />
      </AuthProvider>
    </ThemeProvider>
  );
};

export default App;
