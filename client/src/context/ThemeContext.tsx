import React, { createContext, useContext, useEffect, useState } from 'react';
import { translations, type Language } from '../i18n/translations';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ThemeColor = 'blue' | 'emerald' | 'violet';
export type DisplayDensity = 'comfortable' | 'compact';
export type { Language };
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
    if (saved === 'blue' || saved === 'emerald' || saved === 'violet') {
      return saved;
    }
    return 'blue';
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
    const langDict = (translations as Record<string, Record<string, string>>)[language] || translations.zh;
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
