import React, { createContext, useContext, useEffect, useState } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ThemeColor = 'blue' | 'emerald' | 'violet' | 'amber' | 'rose' | 'neutral';
export type DisplayDensity = 'comfortable' | 'compact';
export type Language = 'zh' | 'en';
export type DefaultView = 'matrix' | 'list' | 'calendar';

interface ThemeContextType {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  isDark: boolean;
  themeColor: ThemeColor;
  setThemeColor: (color: ThemeColor) => void;
  displayDensity: DisplayDensity;
  setDisplayDensity: (density: DisplayDensity) => void;
  language: Language;
  setLanguage: (lang: Language) => void;
  defaultView: DefaultView;
  setDefaultView: (view: DefaultView) => void;
  defaultTaskDuration: number;
  setDefaultTaskDuration: (mins: number) => void;
  soundEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
  t: (key: string, fallback?: string) => string;
}

const dictionary: Record<Language, Record<string, string>> = {
  zh: {
    'nav.matrix': '四象限看板',
    'nav.list': '待办清单',
    'nav.calendar': '日历日程',
    'nav.settings': '设置与对接',
    'nav.new_task': '新建待办',
    'nav.views': '视图导航',
    'nav.quadrants': '四象限分类',
    'nav.tools': '效率辅助',
    'nav.admin': '系统运维',
    'nav.wizard': '智能决策向导',
    'nav.stats': '精力复盘分析',
    'nav.backup': '数据备份导入',
    'nav.users': '用户审核',
    'nav.debugger': '系统调试',
    'nav.all_tasks': '全部待办',
    'nav.completed': '已完成事项',
    'nav.brand_sub': '智能时间规划 Agent',
    'nav.account_settings': '设置与偏好',

    'set.title': '设置与偏好',
    'set.account': '个人账户管理',
    'set.general': '通用偏好设置',
    'set.appearance': '外观主题定制',
    'set.weixin': '微信 Clawbot 对接',
    'set.scheduler': '日程规划算法偏好',
    'set.notification': '提醒通知与前置周期',
    'set.llm': '大模型 DeepSeek',
    'set.calendar': '外部日历订阅源',
    'set.save': '保存更改',
    'set.saving': '保存中...',
    'set.saved': '配置已成功保存！',
    'set.next': '下一步',
    'set.lang': '界面语言 (Language)',
    'set.default_view': '默认打开视图 (Default View)',
    'set.default_duration': '默认待办耗时 (Default Duration)',
    'set.sound': '完成任务音效提示',
    'set.sound_desc': '在四象限或待办列表中标记完成事项时，播放轻量触感音效',
    'set.shortcuts': '全局快捷键速查',
    'set.color_mode': '色彩模式 (Color Mode)',
    'set.light': '浅色模式',
    'set.dark': '深色模式',
    'set.system': '跟随系统',
    'set.accent': '品牌主强调色 (Accent Color)',
    'set.density': '排版紧凑度 (Display Density)',
    'set.comfortable': '舒适模式 (Comfortable)',
    'set.compact': '紧凑模式 (Compact)',
    'set.logout': '退出当前账号',
  },
  en: {
    'nav.matrix': 'Matrix Board',
    'nav.list': 'Todo List',
    'nav.calendar': 'Calendar',
    'nav.settings': 'Settings & Integration',
    'nav.new_task': 'New Task',
    'nav.views': 'Navigation',
    'nav.quadrants': 'Quadrants',
    'nav.tools': 'Tools',
    'nav.admin': 'Admin',
    'nav.wizard': 'Decision Wizard',
    'nav.stats': 'Energy Review',
    'nav.backup': 'Backup & Import',
    'nav.users': 'User Approvals',
    'nav.debugger': 'System Debugger',
    'nav.all_tasks': 'All Tasks',
    'nav.completed': 'Completed Tasks',
    'nav.brand_sub': 'AI Time Planning Agent',
    'nav.account_settings': 'Settings & Preferences',

    'set.title': 'Settings & Preferences',
    'set.account': 'Account Management',
    'set.general': 'General Preferences',
    'set.appearance': 'Appearance & Theme',
    'set.weixin': 'WeChat Integration',
    'set.scheduler': 'Scheduler Algorithm',
    'set.notification': 'Notifications & Reminders',
    'set.llm': 'DeepSeek LLM',
    'set.calendar': 'External Calendar Feeds',
    'set.save': 'Save Changes',
    'set.saving': 'Saving...',
    'set.saved': 'Settings saved successfully!',
    'set.next': 'Next Step',
    'set.lang': 'Interface Language',
    'set.default_view': 'Default Start View',
    'set.default_duration': 'Default Task Duration',
    'set.sound': 'Task Completion Sound',
    'set.sound_desc': 'Play an audio cue when a task is checked or marked done',
    'set.shortcuts': 'Keyboard Shortcuts',
    'set.color_mode': 'Color Mode',
    'set.light': 'Light Mode',
    'set.dark': 'Dark Mode',
    'set.system': 'System Sync',
    'set.accent': 'Theme Accent Color',
    'set.density': 'Display Density',
    'set.comfortable': 'Comfortable Mode',
    'set.compact': 'Compact Mode',
    'set.logout': 'Log Out',
  },
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('clawbot_theme');
    if (saved === 'light' || saved === 'dark' || saved === 'system') {
      return saved;
    }
    return 'system';
  });

  const [themeColor, setThemeColorState] = useState<ThemeColor>(() => {
    const saved = localStorage.getItem('clawbot_theme_color');
    return (saved as ThemeColor) || 'blue';
  });

  const [displayDensity, setDisplayDensityState] = useState<DisplayDensity>(() => {
    const saved = localStorage.getItem('clawbot_density');
    return (saved as DisplayDensity) || 'comfortable';
  });

  const [language, setLanguageState] = useState<Language>(() => {
    const saved = localStorage.getItem('clawbot_lang');
    return (saved as Language) || 'zh';
  });

  const [defaultView, setDefaultViewState] = useState<DefaultView>(() => {
    const saved = localStorage.getItem('clawbot_default_view');
    return (saved as DefaultView) || 'matrix';
  });

  const [defaultTaskDuration, setDefaultTaskDurationState] = useState<number>(() => {
    const saved = localStorage.getItem('clawbot_default_duration');
    return saved ? parseInt(saved, 10) : 60;
  });

  const [soundEnabled, setSoundEnabledState] = useState<boolean>(() => {
    const saved = localStorage.getItem('clawbot_sound');
    return saved === null ? true : saved === 'true';
  });

  const [systemIsDark, setSystemIsDark] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  });

  // Listen for system theme changes
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      setSystemIsDark(e.matches);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const isDark = themeMode === 'dark' || (themeMode === 'system' && systemIsDark);

  // Apply dark mode, density, theme color, and language to DOM root
  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add('dark');
      root.style.colorScheme = 'dark';
    } else {
      root.classList.remove('dark');
      root.style.colorScheme = 'light';
    }

    if (displayDensity === 'compact') {
      root.classList.add('density-compact');
    } else {
      root.classList.remove('density-compact');
    }

    root.setAttribute('data-theme-color', themeColor);
    root.setAttribute('lang', language === 'en' ? 'en' : 'zh-CN');
  }, [isDark, displayDensity, themeColor, language]);

  const setThemeMode = (mode: ThemeMode) => {
    setThemeModeState(mode);
    localStorage.setItem('clawbot_theme', mode);
  };

  const setThemeColor = (color: ThemeColor) => {
    setThemeColorState(color);
    localStorage.setItem('clawbot_theme_color', color);
  };

  const setDisplayDensity = (density: DisplayDensity) => {
    setDisplayDensityState(density);
    localStorage.setItem('clawbot_density', density);
  };

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    localStorage.setItem('clawbot_lang', lang);
  };

  const setDefaultView = (view: DefaultView) => {
    setDefaultViewState(view);
    localStorage.setItem('clawbot_default_view', view);
  };

  const setDefaultTaskDuration = (mins: number) => {
    setDefaultTaskDurationState(mins);
    localStorage.setItem('clawbot_default_duration', String(mins));
  };

  const setSoundEnabled = (enabled: boolean) => {
    setSoundEnabledState(enabled);
    localStorage.setItem('clawbot_sound', String(enabled));
  };

  const t = (key: string, fallback?: string): string => {
    const langDict = dictionary[language] || dictionary.zh;
    return langDict[key] || fallback || key;
  };

  return (
    <ThemeContext.Provider
      value={{
        themeMode,
        setThemeMode,
        isDark,
        themeColor,
        setThemeColor,
        displayDensity,
        setDisplayDensity,
        language,
        setLanguage,
        defaultView,
        setDefaultView,
        defaultTaskDuration,
        setDefaultTaskDuration,
        soundEnabled,
        setSoundEnabled,
        t,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};
