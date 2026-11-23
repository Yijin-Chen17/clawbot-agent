import React, { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { AuthPage } from './pages/AuthPage';
import { Sidebar } from './components/Sidebar';
import { EisenhowerWorkspace } from './components/EisenhowerWorkspace';
import { CalendarView } from './components/CalendarView';
import { SettingsView } from './components/SettingsView';
import { AdminUsersView } from './components/AdminUsersView';
import { AdminApiView } from './components/AdminApiView';
import { SystemDebugger } from './components/SystemDebugger';
import { api } from './api/client';

const DashboardContent: React.FC = () => {
  const { user, loading } = useAuth();
  // 当前活动视图：四象限看板 (matrix) / 待办清单 (list) / 日历日程 (calendar) / 设置 (settings) / 审核 (admin) / 调试 (debug)
  const [activeTab, setActiveTab] = useState<string>('matrix');
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({});
  const [pendingCount, setPendingCount] = useState(0);

  // 模态框全局触发状态 (由侧边栏触发)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [isStatsOpen, setIsStatsOpen] = useState(false);
  const [isBackupOpen, setIsBackupOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

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

  const fetchPendingCount = async () => {
    if (user?.role === 'admin') {
      try {
        const res = await api.get('/admin/users');
        const count = res.data.users.filter((u: any) => u.status === 'pending').length;
        setPendingCount(count);
      } catch {}
    }
  };

  useEffect(() => {
    fetchPendingCount();
  }, [user]);

  if (loading) {
    return (
      <div className="min-h-screen bg-white dark:bg-[#1e1f20] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="animate-spin rounded-full h-8 w-8 border-3 border-blue-600 dark:border-blue-400 border-t-transparent"></div>
          <span className="text-gray-500 dark:text-neutral-400 text-xs font-medium">Clawbot Tasks 加载中...</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return <AuthPage />;
  }

  return (
    <div className="h-screen w-full overflow-hidden flex bg-white dark:bg-[#1e1f20] text-gray-900 dark:text-gray-100 transition-colors">
      {/* 主流 AI Agent 风格左侧边栏 */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
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
            onSwitchView={(v) => setActiveTab(v)}
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
          <CalendarView
            onOpenMobileMenu={() => setMobileSidebarOpen(true)}
            isActive={activeTab === 'calendar'}
          />
        </div>
        {activeTab === 'settings' && (
          <div className="w-full h-full flex flex-col overflow-hidden p-3 sm:p-5">
            <SettingsView onOpenMobileMenu={() => setMobileSidebarOpen(true)} />
          </div>
        )}
        {activeTab === 'admin' && user.role === 'admin' && (
          <div className="w-full h-full flex flex-col overflow-hidden p-3 sm:p-5">
            <AdminUsersView onRefreshCount={fetchPendingCount} />
          </div>
        )}
        {activeTab === 'api' && user.role === 'admin' && (
          <div className="w-full h-full flex flex-col overflow-hidden p-3 sm:p-5">
            <AdminApiView />
          </div>
        )}
        {activeTab === 'debug' && user.role === 'admin' && (
          <div className="w-full h-full flex flex-col overflow-hidden p-3 sm:p-5">
            <SystemDebugger />
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
