import React, { useState, useEffect, useRef, useMemo } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { QRCodeSVG } from 'qrcode.react';
import {
  User,
  Sliders,
  Palette,
  Bot,
  Brain,
  Calendar,
  Clock,
  Copy,
  Check,
  RefreshCw,
  Save,
  CheckCircle2,
  AlertCircle,
  QrCode,
  Send,
  LogOut,
  Trash2,
  Bell,
  ChevronRight,
  Sparkles,
  Menu,
  Lock,
  Upload,
  Sun,
  Moon,
  Monitor,
  Eye,
  EyeOff,
  Volume2,
  VolumeX,
  Languages,
  Keyboard,
  KeyRound,
} from 'lucide-react';

interface WorkSlot {
  start: string;
  end: string;
}

interface VisualSlot {
  startMin: number;
  endMin: number;
  label: string;
}

interface CalendarSub {
  id: number;
  name: string;
  url: string;
  last_sync_at: string | null;
  sync_status: 'ok' | 'error';
  error_message: string | null;
  event_count: number;
}

function parseWorkSlotsString(input: string): {
  slots: WorkSlot[];
  visualSlots: VisualSlot[];
  totalMinutes: number;
  error: string | null;
} {
  const trimmed = input.trim();
  if (!trimmed) {
    return { slots: [], visualSlots: [], totalMinutes: 0, error: '请输入工作时间段' };
  }

  // Support English comma, Chinese comma, semicolons, and newlines
  const parts = trimmed.split(/[,，;\n\r]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) {
    return { slots: [], visualSlots: [], totalMinutes: 0, error: '请输入工作时间段' };
  }

  const slots: WorkSlot[] = [];
  const rawVisual: VisualSlot[] = [];

  for (const part of parts) {
    const match = part.match(/^(\d{1,2}):(\d{2})\s*[-~至到]\s*(\d{1,2}):(\d{2})$/);
    if (!match) {
      return {
        slots: [],
        visualSlots: [],
        totalMinutes: 0,
        error: `时段 "${part}" 格式不正确，请使用形如 00:00-02:00, 13:00-18:00 的格式`,
      };
    }

    const sh = parseInt(match[1], 10);
    const sm = parseInt(match[2], 10);
    const eh = parseInt(match[3], 10);
    const em = parseInt(match[4], 10);

    if (sh < 0 || sh > 24 || sm < 0 || sm > 59) {
      return { slots: [], visualSlots: [], totalMinutes: 0, error: `时段 "${part}" 开始时间无效` };
    }
    if (eh < 0 || eh > 24 || em < 0 || em > 59) {
      return { slots: [], visualSlots: [], totalMinutes: 0, error: `时段 "${part}" 结束时间无效` };
    }

    const startFormatted = `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`;
    const endFormatted = `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
    slots.push({ start: startFormatted, end: endFormatted });

    const sMin = sh * 60 + sm;
    const eMin = eh * 60 + em;

    if (eMin <= sMin) {
      // Overnight slot, e.g. 23:00 to 02:00
      rawVisual.push({
        startMin: sMin,
        endMin: 1440,
        label: `${startFormatted}-24:00`,
      });
      if (eMin > 0) {
        rawVisual.push({
          startMin: 0,
          endMin: eMin,
          label: `00:00-${endFormatted}`,
        });
      }
    } else {
      rawVisual.push({
        startMin: sMin,
        endMin: Math.min(1440, eMin),
        label: `${startFormatted}-${endFormatted}`,
      });
    }
  }

  // Merge overlapping segments for the progress bar display and total hours calculation
  const sorted = [...rawVisual].sort((a, b) => a.startMin - b.startMin);
  const merged: VisualSlot[] = [];
  for (const cur of sorted) {
    if (merged.length === 0) {
      merged.push({ ...cur });
    } else {
      const prev = merged[merged.length - 1];
      if (cur.startMin <= prev.endMin) {
        if (cur.endMin > prev.endMin) {
          prev.endMin = cur.endMin;
          const h1 = Math.floor(prev.startMin / 60);
          const m1 = prev.startMin % 60;
          const h2 = Math.floor(prev.endMin / 60);
          const m2 = prev.endMin % 60;
          prev.label = `${String(h1).padStart(2, '0')}:${String(m1).padStart(2, '0')}-${String(h2).padStart(2, '0')}:${String(m2).padStart(2, '0')}`;
        }
      } else {
        merged.push({ ...cur });
      }
    }
  }

  const totalMinutes = merged.reduce((sum, s) => sum + (s.endMin - s.startMin), 0);

  return {
    slots,
    visualSlots: merged,
    totalMinutes,
    error: null,
  };
}

export type SectionType =
  | 'account'
  | 'general'
  | 'appearance'
  | 'weixin'
  | 'scheduler'
  | 'notification'
  | 'llm'
  | 'calendar';

interface SettingsViewProps {
  onOpenMobileMenu?: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ onOpenMobileMenu }) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionType>('account');

  const { user, updateUser, logout } = useAuth();
  const {
    themeMode,
    setThemeMode,
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
  } = useTheme();

  // 个人账户管理状态
  const [nickname, setNickname] = useState(user?.nickname || '');
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSuccess, setProfileSuccess] = useState<string | null>(null);

  // 修改密码状态
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // 监听并同步 user.nickname
  useEffect(() => {
    if (user?.nickname !== undefined) {
      setNickname(user.nickname || '');
    }
  }, [user?.nickname]);

  // Weixin Clawbot Integration State
  const [wxConnected, setWxConnected] = useState(false);
  const [wxUserId, setWxUserId] = useState('');
  const [wxNickname, setWxNickname] = useState('');
  const [, setQrCode] = useState('');
  const [qrCodeImgContent, setQrCodeImgContent] = useState('');
  const [qrStatus, setQrStatus] = useState<'idle' | 'loading' | 'wait' | 'scaned' | 'confirmed' | 'expired'>('idle');
  const [qrStatusMsg, setQrStatusMsg] = useState('');
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // LLM fields
  const [llmEndpoint, setLlmEndpoint] = useState('https://api.deepseek.com/v1');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmModel, setLlmModel] = useState('deepseek-chat');

  // Preferences: Manual Work Slots
  const [workSlotsText, setWorkSlotsText] = useState('00:00-02:00, 13:00-18:00');
  const parsedSlotsInfo = useMemo(() => {
    return parseWorkSlotsString(workSlotsText);
  }, [workSlotsText]);

  const [taskBuffer, setTaskBuffer] = useState<number>(15);
  const [remindStart, setRemindStart] = useState<number>(10);
  const [remindEnd, setRemindEnd] = useState<number>(5);
  const [calSyncInterval, setCalSyncInterval] = useState<number>(30);

  // Calendar feeds
  const [subs, setSubs] = useState<CalendarSub[]>([]);
  const [newSubName, setNewSubName] = useState('');
  const [newSubUrl, setNewSubUrl] = useState('');
  const [addingSub, setAddingSub] = useState(false);

  // iCal export urls
  const [icalExportUrl, setIcalExportUrl] = useState('');
  const [copiedIcal, setCopiedIcal] = useState(false);

  const userId = user?.id ? String(user.id) : 'default';

  // Visited sections for "日程规划/提醒通知点开过"
  const [visitedSections, setVisitedSections] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(`clawbot_visited_${userId}`);
      return saved ? new Set(JSON.parse(saved)) : new Set(['account', 'weixin']);
    } catch {
      return new Set(['account', 'weixin']);
    }
  });

  // Track activeSection visit
  useEffect(() => {
    setVisitedSections((prev) => {
      if (prev.has(activeSection)) return prev;
      const next = new Set(prev).add(activeSection);
      try {
        localStorage.setItem(`clawbot_visited_${userId}`, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  }, [activeSection, userId]);

  // LLM testing state
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<{ success: boolean; msg: string } | null>(null);
  const [llmApiKeyValid, setLlmApiKeyValid] = useState<boolean>(() => {
    return localStorage.getItem(`clawbot_llm_valid_${userId}`) === 'true';
  });

  const handleTestLlmKey = async () => {
    if (!llmApiKey.trim()) {
      alert('请先输入 DeepSeek API Key');
      return;
    }
    setLlmTesting(true);
    setLlmTestResult(null);
    try {
      const res = await api.post('/settings/test-llm', {
        llm_endpoint: llmEndpoint,
        llm_api_key: llmApiKey,
        llm_model: llmModel,
      });
      setLlmTestResult({ success: true, msg: res.data.message || 'API Key 验证有效！' });
      setLlmApiKeyValid(true);
      localStorage.setItem(`clawbot_llm_valid_${userId}`, 'true');
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } }; message?: string };
      const msg = error.response?.data?.error || error.message || '验证失败，请检查 API Key';
      setLlmTestResult({ success: false, msg });
      setLlmApiKeyValid(false);
      localStorage.removeItem(`clawbot_llm_valid_${userId}`);
    } finally {
      setLlmTesting(false);
    }
  };

  // 头像上传处理 (限制 2MB，并即时更新全局上下文)
  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const MAX_SIZE = 2 * 1024 * 1024; // 2MB
    if (file.size > MAX_SIZE) {
      setAvatarError('头像图片文件不能超过 2MB，请选择更小的图片');
      return;
    }

    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      setAvatarError('仅支持 JPG, PNG, WEBP, GIF 格式图片');
      return;
    }

    setAvatarError(null);
    setAvatarUploading(true);

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const base64Data = reader.result as string;
        const res = await api.post('/auth/avatar', { avatarData: base64Data });
        const newUrl = res.data.avatar_url;
        updateUser({ avatar_url: newUrl });
        setProfileSuccess('头像上传更新成功！');
        setTimeout(() => setProfileSuccess(null), 3000);
      } catch (err: any) {
        setAvatarError(err.response?.data?.error || '头像上传失败');
      } finally {
        setAvatarUploading(false);
      }
    };
    reader.onerror = () => {
      setAvatarError('读取文件失败');
      setAvatarUploading(false);
    };
    reader.readAsDataURL(file);
  };

  // 昵称保存处理
  const handleSaveNickname = async () => {
    setSavingProfile(true);
    setProfileSuccess(null);
    try {
      const res = await api.put('/auth/profile', { nickname });
      updateUser({ nickname: res.data.user.nickname });
      setProfileSuccess('昵称保存修改成功！');
      setTimeout(() => setProfileSuccess(null), 3000);
    } catch (err: any) {
      alert(err.response?.data?.error || '修改昵称失败');
    } finally {
      setSavingProfile(false);
    }
  };

  // 密码修改处理 (服务器仅保留不可逆哈希)
  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!oldPassword || !newPassword) {
      setPasswordError('请输入原密码与新密码');
      return;
    }
    if (newPassword.length < 6) {
      setPasswordError('新密码长度不能少于 6 位');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('两次输入的新密码不一致');
      return;
    }

    setChangingPassword(true);
    setPasswordError(null);
    setPasswordSuccess(null);

    try {
      const res = await api.put('/auth/password', { oldPassword, newPassword });
      setPasswordSuccess(res.data.message || '密码修改成功！新密码哈希已安全更新。');
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => setPasswordSuccess(null), 4000);
    } catch (err: any) {
      setPasswordError(err.response?.data?.error || '修改密码失败，请核验原密码');
    } finally {
      setChangingPassword(false);
    }
  };

  const sectionOrder: readonly SectionType[] = [
    'account',
    'general',
    'appearance',
    'weixin',
    'scheduler',
    'notification',
    'llm',
    'calendar',
  ];

  const handleNextStep = () => {
    const currentIndex = sectionOrder.indexOf(activeSection);
    if (currentIndex < sectionOrder.length - 1) {
      setActiveSection(sectionOrder[currentIndex + 1]);
    } else {
      setActiveSection(sectionOrder[0]);
    }
  };

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  const fetchSettings = async () => {
    try {
      setLoading(true);
      const res = await api.get('/settings');
      const { settings, urls } = res.data;
      if (settings) {
        setLlmEndpoint(settings.llm_endpoint || 'https://api.deepseek.com/v1');
        setLlmApiKey(settings.llm_api_key || '');
        setLlmModel(settings.llm_model || 'deepseek-chat');

        // Weixin status
        setWxConnected(Boolean(settings.weixin_connected));
        setWxUserId(settings.weixin_user_id || '');
        setWxNickname(settings.weixin_nickname || '');

        if (settings.work_slots) {
          try {
            const parsed = JSON.parse(settings.work_slots);
            if (Array.isArray(parsed) && parsed.length > 0) {
              setWorkSlotsText(parsed.map((s: WorkSlot) => `${s.start}-${s.end}`).join(', '));
            } else if (typeof settings.work_slots === 'string' && settings.work_slots.trim()) {
              setWorkSlotsText(settings.work_slots);
            }
          } catch {
            setWorkSlotsText(settings.work_slots);
          }
        }
        setTaskBuffer(settings.task_buffer_minutes ?? 15);
        setRemindStart(settings.reminder_before_start_minutes ?? 10);
        setRemindEnd(settings.reminder_before_end_minutes ?? 5);
        setCalSyncInterval(settings.calendar_sync_interval_minutes ?? 30);
      }

      if (urls?.icalSubscriptionUrl) {
        setIcalExportUrl(urls.icalSubscriptionUrl);
      }

      if (!settings?.weixin_connected) {
        fetchQrCode();
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchSubs = async () => {
    try {
      const res = await api.get('/calendar/subscriptions');
      setSubs(res.data.subscriptions || []);
    } catch (err) {
      console.error('Failed to load subscriptions:', err);
    }
  };

  useEffect(() => {
    fetchSettings();
    fetchSubs();
  }, []);

  // Fetch WeChat QR Code & start polling
  const fetchQrCode = async () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    try {
      setQrStatus('loading');
      setQrStatusMsg('正在向微信服务器申请登录二维码...');
      const res = await api.get('/weixin/qrcode');
      const { qrcode, qrcodeUrl, qrcode_img_content } = res.data;
      setQrCode(qrcode);
      setQrCodeImgContent(qrcodeUrl || qrcode_img_content);
      setQrStatus('wait');
      setQrStatusMsg('请打开手机微信【扫一扫】屏幕二维码');

      pollTimerRef.current = setInterval(() => {
        checkQrStatus(qrcode);
      }, 2500);
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } }; message?: string };
      setQrStatus('idle');
      setQrStatusMsg('获取二维码失败: ' + (error.response?.data?.error || error.message || '网络错误'));
    }
  };

  const checkQrStatus = async (code: string) => {
    try {
      const res = await api.get(`/weixin/status?qrcode=${encodeURIComponent(code)}`);
      const data = res.data;

      if (data.status === 'scaned') {
        setQrStatus('scaned');
        setQrStatusMsg('已扫码！请在手机微信上点击【允许】以完成配对...');
      } else if (data.status === 'confirmed') {
        setQrStatus('confirmed');
        setQrStatusMsg('配对成功！已连接微信助手');
        setWxConnected(true);
        setWxUserId(data.weixinUserId || data.user_id || '');
        setWxNickname(data.nickname || '');

        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      } else if (data.status === 'expired') {
        setQrStatus('expired');
        setQrStatusMsg('二维码已过期，请点击重新获取');
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      }
    } catch {
      // Ignore transient polling network errors
    }
  };

  const handleUnbindWeixin = async () => {
    if (!confirm('确定要解除当前微信配对吗？解除后机器人将停止微信通知。')) return;
    try {
      await api.post('/weixin/unbind');
      setWxConnected(false);
      setWxUserId('');
      setWxNickname('');
      fetchQrCode();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } }; message?: string };
      alert('解绑失败: ' + (error.response?.data?.error || error.message));
    }
  };

  const handleSendTestMessage = async () => {
    try {
      setTestSending(true);
      setTestResult(null);
      const res = await api.post('/weixin/test-message');
      setTestResult(res.data.message || '测试消息已成功推送！');
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } }; message?: string };
      setTestResult('发送失败: ' + (error.response?.data?.error || error.message));
    } finally {
      setTestSending(false);
    }
  };

  const handleSavePreferences = async (e: React.FormEvent) => {
    e.preventDefault();
    if (parsedSlotsInfo.error) {
      alert('工作时间段格式有误：' + parsedSlotsInfo.error);
      return;
    }

    setSaving(true);
    setSaveSuccess(false);

    try {
      await api.put('/settings', {
        llm_endpoint: llmEndpoint,
        llm_api_key: llmApiKey,
        llm_model: llmModel,
        work_slots: parsedSlotsInfo.slots,
        task_buffer_minutes: Number(taskBuffer),
        reminder_before_start_minutes: Number(remindStart),
        reminder_before_end_minutes: Number(remindEnd),
        calendar_sync_interval_minutes: Number(calSyncInterval),
      });

      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } }; message?: string };
      alert('保存失败：' + (error.response?.data?.error || error.message || '未知错误'));
    } finally {
      setSaving(false);
    }
  };

  const handleAddSubscription = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSubName.trim() || !newSubUrl.trim()) return;

    setAddingSub(true);
    try {
      await api.post('/calendar/subscriptions', {
        name: newSubName.trim(),
        url: newSubUrl.trim(),
      });
      setNewSubName('');
      setNewSubUrl('');
      fetchSubs();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } }; message?: string };
      alert('添加失败：' + (error.response?.data?.error || error.message));
    } finally {
      setAddingSub(false);
    }
  };

  const handleDeleteSubscription = async (id: number) => {
    if (!confirm('确定要删除此外部日历吗？相关的事件缓存也将被移除。')) return;
    try {
      await api.delete(`/calendar/subscriptions/${id}`);
      fetchSubs();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } }; message?: string };
      alert('删除失败：' + (error.response?.data?.error || error.message));
    }
  };

  const handleSyncNow = async (id: number) => {
    try {
      await api.post(`/calendar/subscriptions/${id}/sync`);
      fetchSubs();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } }; message?: string };
      alert('同步失败：' + (error.response?.data?.error || error.message));
    }
  };

  const copyIcal = () => {
    navigator.clipboard.writeText(icalExportUrl);
    setCopiedIcal(true);
    setTimeout(() => setCopiedIcal(false), 2000);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[360px]">
        <div className="flex items-center gap-3 text-gray-500 dark:text-neutral-400 font-medium text-sm">
          <RefreshCw className="w-5 h-5 animate-spin text-blue-600 dark:text-blue-400" />
          <span>正在读取设置...</span>
        </div>
      </div>
    );
  }

  const isAccountDone = Boolean(user?.nickname || user?.avatar_url);
  const isWeixinDone = Boolean(wxConnected);
  const isSchedulerDone = visitedSections.has('scheduler');
  const isNotificationDone = visitedSections.has('notification');
  const isLlmDone = Boolean(llmApiKeyValid);
  const isCalendarDone = subs.length > 0;

  const navMenuItems = [
    {
      id: 'account' as const,
      label: '个人账户管理',
      desc: '头像、昵称、密码修改与退出',
      icon: User,
      isDone: isAccountDone,
    },
    {
      id: 'general' as const,
      label: '通用偏好设置',
      desc: '语言、默认视图与任务时长',
      icon: Sliders,
      isDone: true,
    },
    {
      id: 'appearance' as const,
      label: '外观主题定制',
      desc: '深浅模式、主题配色与风格',
      icon: Palette,
      isDone: true,
    },
    {
      id: 'weixin' as const,
      label: '微信 Clawbot 对接',
      desc: '扫码配对与微信消息通知',
      icon: Bot,
      isDone: isWeixinDone,
    },
    {
      id: 'scheduler' as const,
      label: '日程规划算法偏好',
      desc: '作息时段与 24h 可视化',
      icon: Clock,
      isDone: isSchedulerDone,
    },
    {
      id: 'notification' as const,
      label: '提醒通知与前置周期',
      desc: '任务开始/结束提前提醒',
      icon: Bell,
      isDone: isNotificationDone,
    },
    {
      id: 'llm' as const,
      label: '大模型 DeepSeek',
      desc: '语义抽取与任务解析 API',
      icon: Brain,
      isDone: isLlmDone,
    },
    {
      id: 'calendar' as const,
      label: '外部日历订阅源',
      desc: '双向防冲突与 iCal 导出',
      icon: Calendar,
      isDone: isCalendarDone,
    },
  ];

  const renderCardHeader = (
    icon: React.ReactNode,
    title: string,
    subtitle: string,
    statusBadge?: React.ReactNode,
    hideGlobalSave?: boolean
  ) => (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-gray-100 dark:border-neutral-800">
      <div className="flex items-center gap-3">
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
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0">
          {icon}
        </div>
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">{title}</h2>
            {statusBadge}
          </div>
          <p className="text-xs text-gray-500 dark:text-neutral-400 mt-0.5">{subtitle}</p>
        </div>
      </div>

      <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
        {!hideGlobalSave && (
          <button
            type="button"
            onClick={handleSavePreferences}
            disabled={saving}
            className="flex items-center gap-1.5 px-3.5 py-1.5 bg-gray-50 dark:bg-[#28292a] hover:bg-gray-100 dark:hover:bg-neutral-800 text-gray-700 dark:text-neutral-200 border border-gray-200 dark:border-neutral-700 font-medium text-xs rounded-full shadow-2xs transition disabled:opacity-50 cursor-pointer"
          >
            {saving ? <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-600" /> : <Save className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />}
            <span>{saving ? '保存中...' : '保存更改'}</span>
          </button>
        )}

        <button
          type="button"
          onClick={handleNextStep}
          className="flex items-center gap-1 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 active:scale-95 text-white font-semibold text-xs rounded-full shadow-xs transition cursor-pointer"
        >
          <span>{activeSection === 'calendar' ? '回到第一步' : '下一步'}</span>
          <ChevronRight className="w-3.5 h-3.5 stroke-[2.5]" />
        </button>
      </div>
    </div>
  );

  return (
    <div className="w-full flex-1 min-h-0 flex flex-col space-y-2.5 overflow-hidden">
      {saveSuccess && (
        <div className="shrink-0 flex items-center gap-2 px-3.5 py-2 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/80 text-emerald-800 dark:text-emerald-300 rounded-xl text-xs font-medium animate-fadeIn">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          <span>配置已成功保存！算法排程与微信提醒设置已即时生效。</span>
        </div>
      )}

      {/* Mobile Horizontal Tabs Rail */}
      <div className="lg:hidden shrink-0 flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
        {navMenuItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeSection === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveSection(item.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold shrink-0 transition cursor-pointer ${
                isActive
                  ? 'bg-blue-600 text-white shadow-xs'
                  : 'bg-white dark:bg-[#1e1f20] text-gray-600 dark:text-neutral-300 border border-gray-200/80 dark:border-neutral-700/80'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{item.label.split(' ')[0]}</span>
              <span className={`w-2 h-2 rounded-full ${item.isDone ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            </button>
          );
        })}
      </div>

      {/* Main Left-Right Split Layout */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-4 items-stretch overflow-hidden">
        {/* Left Column: Vertical Nav List */}
        <aside className="hidden lg:flex flex-col w-72 xl:w-80 shrink-0 bg-white dark:bg-[#1e1f20] rounded-2xl border border-gray-200/80 dark:border-neutral-800/80 p-3 shadow-xs space-y-1.5 overflow-y-auto scrollbar-thin">
          <div className="text-[11px] font-semibold tracking-wider uppercase text-gray-400 dark:text-neutral-500 px-3 py-1.5 flex items-center justify-between">
            <span>配置目录</span>
            <span className="font-mono text-[10px] text-gray-500 dark:text-neutral-400">
              {navMenuItems.filter((i) => i.isDone).length}/{navMenuItems.length} 已配置
            </span>
          </div>
          {navMenuItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                className={`w-full flex items-start gap-3 p-3 rounded-xl text-left transition cursor-pointer group ${
                  isActive
                    ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-semibold shadow-2xs border-l-4 border-blue-600'
                    : 'text-gray-700 dark:text-neutral-300 hover:bg-gray-100/80 dark:hover:bg-neutral-800/60'
                }`}
              >
                <div
                  className={`p-2 rounded-lg shrink-0 mt-0.5 transition ${
                    isActive
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 dark:bg-neutral-800 text-gray-500 dark:text-neutral-400 group-hover:text-blue-600'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-bold truncate">{item.label}</span>
                    {item.isDone ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 border border-emerald-300/70 dark:border-emerald-800 shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        已完成
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 dark:bg-amber-950/80 text-amber-700 dark:text-amber-300 border border-amber-300/70 dark:border-amber-800 shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                        未完成
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-gray-400 dark:text-neutral-500 truncate mt-0.5 font-normal">
                    {item.desc}
                  </p>
                </div>
              </button>
            );
          })}
        </aside>

        {/* Right Column: Selected Config Panel */}
        <section className="flex-1 min-w-0 bg-white dark:bg-[#1e1f20] rounded-2xl border border-gray-200/80 dark:border-neutral-800/80 p-5 sm:p-7 shadow-xs overflow-y-auto transition-colors scrollbar-thin">
          {/* ===================== A. 个人账户管理 (Account) ===================== */}
          {activeSection === 'account' && (
            <div className="space-y-6 animate-fadeIn">
              {renderCardHeader(
                <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center">
                  <User className="w-5 h-5" />
                </div>,
                '个人账户管理',
                '管理您的头像、对外展示昵称与安全登录密码（登录账号唯一不可修改）',
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-mono font-medium bg-gray-100 dark:bg-neutral-800 text-gray-700 dark:text-neutral-300">
                  @{user?.username}
                </span>,
                true
              )}

              {profileSuccess && (
                <div className="flex items-center gap-2 p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/80 text-emerald-800 dark:text-emerald-300 rounded-xl text-xs font-medium animate-fadeIn">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span>{profileSuccess}</span>
                </div>
              )}

              {avatarError && (
                <div className="flex items-center gap-2 p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-300 rounded-xl text-xs font-medium animate-fadeIn">
                  <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
                  <span>{avatarError}</span>
                </div>
              )}

              {/* 1. 头像上传 */}
              <div className="p-5 rounded-2xl bg-gray-50/70 dark:bg-[#28292a]/70 border border-gray-200/80 dark:border-neutral-700/80 space-y-4">
                <div className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-wider">
                  个人头像
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center gap-5">
                  <div className="relative group shrink-0">
                    {user?.avatar_url ? (
                      <img
                        src={user.avatar_url}
                        alt="用户头像"
                        className="w-20 h-20 rounded-full object-cover ring-2 ring-blue-500/30 dark:ring-blue-400/30 shadow-md"
                      />
                    ) : (
                      <div className="w-20 h-20 rounded-full bg-blue-600 dark:bg-blue-500 text-white font-bold flex items-center justify-center text-2xl shadow-md">
                        {(user?.nickname || user?.username || 'U').slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    {avatarUploading && (
                      <div className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center text-white">
                        <RefreshCw className="w-6 h-6 animate-spin" />
                      </div>
                    )}
                  </div>

                  <div className="space-y-2 flex-1">
                    <input
                      type="file"
                      ref={fileInputRef}
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      onChange={handleAvatarChange}
                      className="hidden"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={avatarUploading}
                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 active:scale-98 text-white text-xs font-semibold rounded-xl shadow-xs transition disabled:opacity-50 cursor-pointer"
                      >
                        {avatarUploading ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Upload className="w-3.5 h-3.5" />
                        )}
                        <span>{avatarUploading ? '上传中...' : '上传新头像'}</span>
                      </button>
                    </div>
                    <p className="text-[11px] text-gray-500 dark:text-neutral-400 leading-relaxed">
                      支持 JPG, PNG, WEBP, GIF 格式。文件大小严格限制在 <strong>2MB</strong> 以内。上传后全站即时同步生效。
                    </p>
                  </div>
                </div>
              </div>

              {/* 2. 账号与昵称设置 */}
              <div className="p-5 rounded-2xl bg-gray-50/70 dark:bg-[#28292a]/70 border border-gray-200/80 dark:border-neutral-700/80 space-y-4">
                <div className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-wider">
                  账号与昵称
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* 登录账号（只读） */}
                  <div>
                    <label className="block text-xs font-medium text-gray-700 dark:text-neutral-300 mb-1.5">
                      登录账号 (Username)
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        value={user?.username || ''}
                        disabled
                        className="w-full pl-3 pr-8 py-2 text-xs bg-gray-200/60 dark:bg-neutral-800/80 border border-gray-300/80 dark:border-neutral-700 text-gray-500 dark:text-neutral-400 rounded-xl cursor-not-allowed font-mono select-none"
                      />
                      <Lock className="w-3.5 h-3.5 text-gray-400 dark:text-neutral-500 absolute right-3 top-1/2 -translate-y-1/2" />
                    </div>
                    <span className="text-[10px] text-gray-400 dark:text-neutral-500 mt-1 block">
                      系统唯一底层识别账号，注册后严格不可修改。
                    </span>
                  </div>

                  {/* 对外展示昵称 */}
                  <div>
                    <label className="block text-xs font-medium text-gray-700 dark:text-neutral-300 mb-1.5">
                      展示昵称 (Nickname)
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={nickname}
                        onChange={(e) => setNickname(e.target.value)}
                        placeholder="请输入对外展示的昵称"
                        maxLength={30}
                        className="flex-1 px-3 py-2 text-xs bg-white dark:bg-[#1e1f20] border border-gray-300 dark:border-neutral-700 text-gray-900 dark:text-gray-100 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition"
                      />
                      <button
                        type="button"
                        onClick={handleSaveNickname}
                        disabled={savingProfile || nickname === user?.nickname}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 active:scale-98 text-white text-xs font-semibold rounded-xl shadow-xs transition disabled:opacity-50 cursor-pointer shrink-0"
                      >
                        {savingProfile ? '保存中...' : '保存昵称'}
                      </button>
                    </div>
                    <span className="text-[10px] text-gray-400 dark:text-neutral-500 mt-1 block">
                      用于左侧边栏、看板与日历顶部展示，可随时修改。
                    </span>
                  </div>
                </div>
              </div>

              {/* 3. 修改密码 (服务器只保存不可逆哈希) */}
              <div className="p-5 rounded-2xl bg-gray-50/70 dark:bg-[#28292a]/70 border border-gray-200/80 dark:border-neutral-700/80 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-wider flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                    <span>修改登录密码</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="text-[11px] text-gray-500 dark:text-neutral-400 hover:text-blue-600 dark:hover:text-blue-400 flex items-center gap-1 cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    <span>{showPassword ? '隐藏明文' : '显示明文'}</span>
                  </button>
                </div>

                {passwordSuccess && (
                  <div className="flex items-center gap-2 p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/80 text-emerald-800 dark:text-emerald-300 rounded-xl text-xs font-medium animate-fadeIn">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span>{passwordSuccess}</span>
                  </div>
                )}

                {passwordError && (
                  <div className="flex items-center gap-2 p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-300 rounded-xl text-xs font-medium animate-fadeIn">
                    <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0" />
                    <span>{passwordError}</span>
                  </div>
                )}

                <form onSubmit={handleChangePassword} className="space-y-3.5">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-700 dark:text-neutral-300 mb-1">
                        原密码
                      </label>
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={oldPassword}
                        onChange={(e) => setOldPassword(e.target.value)}
                        placeholder="输入当前使用的密码"
                        className="w-full px-3 py-2 text-xs bg-white dark:bg-[#1e1f20] border border-gray-300 dark:border-neutral-700 text-gray-900 dark:text-gray-100 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-gray-700 dark:text-neutral-300 mb-1">
                        新密码 (不少于 6 位)
                      </label>
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="至少 6 位字符"
                        minLength={6}
                        className="w-full px-3 py-2 text-xs bg-white dark:bg-[#1e1f20] border border-gray-300 dark:border-neutral-700 text-gray-900 dark:text-gray-100 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-gray-700 dark:text-neutral-300 mb-1">
                        确认新密码
                      </label>
                      <input
                        type={showPassword ? 'text' : 'password'}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="再次输入新密码"
                        minLength={6}
                        className="w-full px-3 py-2 text-xs bg-white dark:bg-[#1e1f20] border border-gray-300 dark:border-neutral-700 text-gray-900 dark:text-gray-100 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition"
                      />
                    </div>
                  </div>

                  <div className="flex justify-end pt-1">
                    <button
                      type="submit"
                      disabled={changingPassword || !oldPassword || !newPassword}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 active:scale-98 text-white text-xs font-semibold rounded-xl shadow-xs transition disabled:opacity-50 cursor-pointer"
                    >
                      {changingPassword ? '正在更新哈希...' : '确认更新密码'}
                    </button>
                  </div>
                </form>
              </div>

              {/* 4. 退出登录 */}
              <div className="p-5 rounded-2xl bg-rose-50/40 dark:bg-rose-950/20 border border-rose-200/70 dark:border-rose-900/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h4 className="text-xs font-bold text-rose-800 dark:text-rose-300">
                    退出当前账号
                  </h4>
                  <p className="text-[11px] text-gray-500 dark:text-neutral-400 mt-0.5">
                    退出后将清除本设备的登录会话凭据，下次使用需重新输入账号与密码。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={logout}
                  className="flex items-center gap-1.5 px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-semibold shadow-xs transition cursor-pointer shrink-0 self-start sm:self-center"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>退出账号登录</span>
                </button>
              </div>
            </div>
          )}

          {/* ===================== B. 通用偏好设置 (General) ===================== */}
          {activeSection === 'general' && (
            <div className="space-y-6 animate-fadeIn">
              {renderCardHeader(
                <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
                  <Sliders className="w-5 h-5" />
                </div>,
                '通用偏好设置',
                '配置界面交互语言、默认初始视图、默认任务时长与声音特效',
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 dark:bg-indigo-950/70 text-indigo-700 dark:text-indigo-300">
                  即时生效
                </span>,
                true
              )}

              {/* 1. 界面语言 */}
              <div className="p-5 rounded-2xl bg-gray-50/70 dark:bg-[#28292a]/70 border border-gray-200/80 dark:border-neutral-700/80 space-y-3">
                <div className="flex items-center gap-1.5 text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-wider">
                  <Languages className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  <span>界面语言 (Language)</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  {[
                    { id: 'zh' as const, label: '简体中文 (Simplified Chinese)', note: '默认界面语言' },
                    { id: 'en' as const, label: 'English (英文模式)', note: 'Standard English' },
                  ].map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setLanguage(item.id)}
                      className={`flex items-center justify-between p-3.5 rounded-xl border text-left transition cursor-pointer ${
                        language === item.id
                          ? 'border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/40 text-indigo-900 dark:text-indigo-200 shadow-2xs'
                          : 'border-gray-200 dark:border-neutral-700 bg-white dark:bg-[#1e1f20] hover:bg-gray-100/60 dark:hover:bg-neutral-800'
                      }`}
                    >
                      <div>
                        <div className="text-xs font-semibold">{item.label}</div>
                        <div className="text-[10px] text-gray-400 dark:text-neutral-500 mt-0.5">
                          {item.note}
                        </div>
                      </div>
                      {language === item.id && <Check className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />}
                    </button>
                  ))}
                </div>
              </div>

              {/* 2. 默认起始视图 */}
              <div className="p-5 rounded-2xl bg-gray-50/70 dark:bg-[#28292a]/70 border border-gray-200/80 dark:border-neutral-700/80 space-y-3">
                <div className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-wider">
                  默认打开视图 (Default View)
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                  {[
                    { id: 'matrix' as const, name: '四象限看板', desc: '直角坐标矩阵，直观轻重缓急' },
                    { id: 'list' as const, name: '待办清单', desc: 'Google Todo 式极简清单' },
                    { id: 'calendar' as const, name: '日历日程', desc: '一周时间块排程全览' },
                  ].map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setDefaultView(v.id)}
                      className={`p-3.5 rounded-xl border text-left transition cursor-pointer ${
                        defaultView === v.id
                          ? 'border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/40 text-indigo-900 dark:text-indigo-200 shadow-2xs'
                          : 'border-gray-200 dark:border-neutral-700 bg-white dark:bg-[#1e1f20] hover:bg-gray-100/60 dark:hover:bg-neutral-800'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold">{v.name}</span>
                        {defaultView === v.id && <Check className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />}
                      </div>
                      <p className="text-[10px] text-gray-400 dark:text-neutral-500 mt-1">{v.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              {/* 3. 默认新建任务耗时 */}
              <div className="p-5 rounded-2xl bg-gray-50/70 dark:bg-[#28292a]/70 border border-gray-200/80 dark:border-neutral-700/80 space-y-3">
                <div className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-wider">
                  默认待办耗时 (Default Duration)
                </div>
                <p className="text-[11px] text-gray-500 dark:text-neutral-400">
                  新建事项或从微信提取任务未指定时长时，算法自动分配的初始时间块大小：
                </p>
                <div className="flex flex-wrap gap-2.5 pt-1">
                  {[30, 45, 60, 90].map((mins) => (
                    <button
                      key={mins}
                      type="button"
                      onClick={() => setDefaultTaskDuration(mins)}
                      className={`px-4 py-2 rounded-xl text-xs font-semibold transition cursor-pointer ${
                        defaultTaskDuration === mins
                          ? 'bg-indigo-600 text-white shadow-xs'
                          : 'bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-700 text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800'
                      }`}
                    >
                      {mins} 分钟 {mins === 60 ? '(推荐)' : ''}
                    </button>
                  ))}
                </div>
              </div>

              {/* 4. 声音与音效反馈 */}
              <div className="p-5 rounded-2xl bg-gray-50/70 dark:bg-[#28292a]/70 border border-gray-200/80 dark:border-neutral-700/80 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-gray-200/70 dark:bg-neutral-800 flex items-center justify-center text-gray-600 dark:text-neutral-300 shrink-0">
                    {soundEnabled ? <Volume2 className="w-4 h-4 text-indigo-600" /> : <VolumeX className="w-4 h-4" />}
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                      完成任务音效提示
                    </div>
                    <div className="text-[10px] text-gray-400 dark:text-neutral-500 mt-0.5">
                      在四象限或待办列表中标记完成事项时，播放轻量愉悦的触感音效
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSoundEnabled(!soundEnabled)}
                  className={`w-11 h-6 rounded-full p-1 transition cursor-pointer shrink-0 ${
                    soundEnabled ? 'bg-indigo-600' : 'bg-gray-300 dark:bg-neutral-700'
                  }`}
                >
                  <div
                    className={`w-4 h-4 rounded-full bg-white transition-transform ${
                      soundEnabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* 5. 键盘快捷键速查 */}
              <div className="p-5 rounded-2xl bg-gray-50/70 dark:bg-[#28292a]/70 border border-gray-200/80 dark:border-neutral-700/80 space-y-3">
                <div className="flex items-center gap-1.5 text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-wider">
                  <Keyboard className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  <span>全局快捷键速查</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                  <div className="p-3 rounded-xl bg-white dark:bg-[#1e1f20] border border-gray-200/80 dark:border-neutral-700 flex items-center justify-between">
                    <span className="text-xs text-gray-700 dark:text-neutral-300">新建待办事项</span>
                    <kbd className="px-2 py-0.5 rounded bg-gray-100 dark:bg-neutral-800 text-[10px] font-mono border border-gray-200 dark:border-neutral-700">
                      N
                    </kbd>
                  </div>
                  <div className="p-3 rounded-xl bg-white dark:bg-[#1e1f20] border border-gray-200/80 dark:border-neutral-700 flex items-center justify-between">
                    <span className="text-xs text-gray-700 dark:text-neutral-300">关闭弹窗 / 取消</span>
                    <kbd className="px-2 py-0.5 rounded bg-gray-100 dark:bg-neutral-800 text-[10px] font-mono border border-gray-200 dark:border-neutral-700">
                      Esc
                    </kbd>
                  </div>
                  <div className="p-3 rounded-xl bg-white dark:bg-[#1e1f20] border border-gray-200/80 dark:border-neutral-700 flex items-center justify-between">
                    <span className="text-xs text-gray-700 dark:text-neutral-300">提交表单 / 确定</span>
                    <kbd className="px-2 py-0.5 rounded bg-gray-100 dark:bg-neutral-800 text-[10px] font-mono border border-gray-200 dark:border-neutral-700">
                      Enter
                    </kbd>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ===================== C. 外观主题定制 (Appearance) ===================== */}
          {activeSection === 'appearance' && (
            <div className="space-y-6 animate-fadeIn">
              {renderCardHeader(
                <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-950/60 text-purple-600 dark:text-purple-400 flex items-center justify-center">
                  <Palette className="w-5 h-5" />
                </div>,
                '外观主题定制',
                '深浅主题色彩模式、系统品牌主色调与界面排版风格',
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-100 dark:bg-purple-950/70 text-purple-700 dark:text-purple-300">
                  即时预览
                </span>,
                true
              )}

              {/* 1. 亮暗模式切换 */}
              <div className="p-5 rounded-2xl bg-gray-50/70 dark:bg-[#28292a]/70 border border-gray-200/80 dark:border-neutral-700/80 space-y-3">
                <div className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-wider">
                  色彩模式 (Color Mode)
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                  {[
                    { id: 'light' as const, label: '浅色模式', icon: Sun, desc: '明朗清爽象牙白' },
                    { id: 'dark' as const, label: '深色模式', icon: Moon, desc: '沉浸护眼暗夜黑' },
                    { id: 'system' as const, label: '跟随系统', icon: Monitor, desc: '自动匹配操作系统' },
                  ].map((item) => {
                    const Icon = item.icon;
                    const isSelected = themeMode === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setThemeMode(item.id)}
                        className={`p-4 rounded-xl border text-left transition cursor-pointer flex flex-col justify-between ${
                          isSelected
                            ? 'border-purple-500 bg-purple-50/60 dark:bg-purple-950/40 text-purple-900 dark:text-purple-200 shadow-2xs'
                            : 'border-gray-200 dark:border-neutral-700 bg-white dark:bg-[#1e1f20] hover:bg-gray-100/60 dark:hover:bg-neutral-800'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <Icon className={`w-5 h-5 ${isSelected ? 'text-purple-600 dark:text-purple-400' : 'text-gray-400'}`} />
                          {isSelected && <Check className="w-4 h-4 text-purple-600 dark:text-purple-400" />}
                        </div>
                        <div>
                          <div className="text-xs font-semibold">{item.label}</div>
                          <div className="text-[10px] text-gray-400 dark:text-neutral-500 mt-0.5">{item.desc}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 2. 主题强调配色 */}
              <div className="p-5 rounded-2xl bg-gray-50/70 dark:bg-[#28292a]/70 border border-gray-200/80 dark:border-neutral-700/80 space-y-3">
                <div className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-wider">
                  品牌主强调色 (Accent Color)
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-1">
                  {[
                    { id: 'blue' as const, name: '经典科技蓝', hex: '#2563eb', colorClass: 'bg-blue-600' },
                    { id: 'emerald' as const, name: '自然生机绿', hex: '#059669', colorClass: 'bg-emerald-600' },
                    { id: 'violet' as const, name: '优雅紫罗兰', hex: '#7c3aed', colorClass: 'bg-purple-600' },
                    { id: 'amber' as const, name: '阳光活力橙', hex: '#d97706', colorClass: 'bg-amber-600' },
                    { id: 'rose' as const, name: '热烈玫瑰红', hex: '#e11d48', colorClass: 'bg-rose-600' },
                    { id: 'neutral' as const, name: '极简中性灰', hex: '#374151', colorClass: 'bg-neutral-700' },
                  ].map((c) => {
                    const isSelected = themeColor === c.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setThemeColor(c.id)}
                        className={`flex items-center gap-3 p-3 rounded-xl border text-left transition cursor-pointer ${
                          isSelected
                            ? 'border-purple-500 bg-purple-50/50 dark:bg-purple-950/30 shadow-2xs'
                            : 'border-gray-200 dark:border-neutral-700 bg-white dark:bg-[#1e1f20] hover:bg-gray-100/60 dark:hover:bg-neutral-800'
                        }`}
                      >
                        <span className={`w-4 h-4 rounded-full ${c.colorClass} shrink-0 ring-2 ring-white dark:ring-neutral-800 shadow-2xs`} />
                        <span className="text-xs font-semibold flex-1 truncate text-gray-800 dark:text-gray-200">
                          {c.name}
                        </span>
                        {isSelected && <Check className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 3. 界面排版紧凑度风格 */}
              <div className="p-5 rounded-2xl bg-gray-50/70 dark:bg-[#28292a]/70 border border-gray-200/80 dark:border-neutral-700/80 space-y-3">
                <div className="text-xs font-bold text-gray-900 dark:text-gray-100 uppercase tracking-wider">
                  排版紧凑度 (Display Density)
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  {[
                    {
                      id: 'comfortable' as const,
                      title: '舒适模式 (Comfortable)',
                      desc: '间距舒朗，视觉开阔，适合高分辨率桌面端与日常浏览',
                    },
                    {
                      id: 'compact' as const,
                      title: '紧凑模式 (Compact)',
                      desc: '间距紧密，信息密集，可在单屏内呈现更多任务与日程项',
                    },
                  ].map((d) => {
                    const isSelected = displayDensity === d.id;
                    return (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => setDisplayDensity(d.id)}
                        className={`p-3.5 rounded-xl border text-left transition cursor-pointer ${
                          isSelected
                            ? 'border-purple-500 bg-purple-50/60 dark:bg-purple-950/40 text-purple-900 dark:text-purple-200 shadow-2xs'
                            : 'border-gray-200 dark:border-neutral-700 bg-white dark:bg-[#1e1f20] hover:bg-gray-100/60 dark:hover:bg-neutral-800'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold">{d.title}</span>
                          {isSelected && <Check className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />}
                        </div>
                        <p className="text-[10px] text-gray-400 dark:text-neutral-500 mt-1">{d.desc}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* 1. WeChat Pairing Section */}
          {activeSection === 'weixin' && (
            <div className="space-y-5 animate-fadeIn">
              {renderCardHeader(
                <div className="w-10 h-10 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
                  <Bot className="w-5 h-5" />
                </div>,
                '微信 Clawbot 对接',
                '扫码绑定个人微信，日程提醒、排程进度与长图预览将直接下发到手机微信',
                wxConnected ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    已连接
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 dark:bg-amber-950/70 text-amber-700 dark:text-amber-300">
                    等待扫码配对
                  </span>
                )
              )}

              {wxConnected ? (
                <div className="bg-gray-50 dark:bg-[#28292a] border border-gray-200/80 dark:border-neutral-700/80 rounded-2xl p-5 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex items-center gap-3.5">
                      <div className="w-12 h-12 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold text-base shadow-xs">
                        {wxNickname ? wxNickname.slice(0, 1).toUpperCase() : 'W'}
                      </div>
                      <div>
                        <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-sm">
                          {wxNickname ? `已绑定微信：${wxNickname}` : '已绑定微信账号'}
                        </h3>
                        <p className="text-xs font-mono text-gray-500 dark:text-neutral-400 mt-0.5 truncate max-w-sm">
                          通讯 ID: {wxUserId || '已加密保护'}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={handleSendTestMessage}
                        disabled={testSending}
                        className="flex items-center gap-1.5 px-4 py-2 bg-white dark:bg-[#1e1f20] hover:bg-gray-100 dark:hover:bg-neutral-800 text-gray-700 dark:text-neutral-200 border border-gray-200 dark:border-neutral-700 font-medium text-xs rounded-full shadow-2xs transition disabled:opacity-50 cursor-pointer"
                      >
                        {testSending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />}
                        <span>{testSending ? '发送中...' : '测试微信通知'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleUnbindWeixin}
                        className="flex items-center gap-1.5 px-4 py-2 bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/40 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900 font-medium text-xs rounded-full transition cursor-pointer"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        <span>解绑账号</span>
                      </button>
                    </div>
                  </div>

                  {testResult && (
                    <div className="text-xs p-3 bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-700 rounded-xl text-gray-700 dark:text-neutral-200 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                      <span>{testResult}</span>
                    </div>
                  )}

                  <div className="text-xs text-gray-600 dark:text-neutral-400 bg-white/80 dark:bg-[#1e1f20]/60 p-4 rounded-xl border border-gray-200/50 dark:border-neutral-700/50 leading-relaxed space-y-2">
                    <div className="font-semibold text-gray-800 dark:text-neutral-200 flex items-center gap-1.5">
                      <span>💡 微信机器人使用指南与指令：</span>
                    </div>
                    <ul className="list-disc list-inside space-y-1 text-xs pl-1">
                      <li>
                        <strong className="text-gray-800 dark:text-gray-200">安排日程：</strong>发送如“帮我安排明天下午写报告两小时，加急5分，周三前交”，AI 自动提取关键要素并插入空闲时段。
                      </li>
                      <li>
                        <strong className="text-gray-800 dark:text-gray-200">查看日历：</strong>发送“查看日历”，Clawbot 将即时生成当天日历日程图片发送至微信。
                      </li>
                      <li>
                        <strong className="text-gray-800 dark:text-gray-200">查看任务：</strong>发送“查看任务”，Clawbot 将生成四象限 Todo List 视觉卡片发送至微信。
                      </li>
                      <li>
                        <strong className="text-gray-800 dark:text-gray-200">任务结项：</strong>在任务结束前收到询问时，回复“已完成”即可快速更新状态。
                      </li>
                    </ul>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col md:flex-row items-center gap-6 bg-gray-50/70 dark:bg-[#28292a]/50 border border-gray-200/80 dark:border-neutral-700/80 rounded-2xl p-6">
                  {/* QR Container */}
                  <div className="flex flex-col items-center shrink-0">
                    <div className="w-48 h-48 bg-white p-3 rounded-2xl border-2 border-dashed border-gray-300 shadow-2xs flex items-center justify-center relative overflow-hidden">
                      {qrStatus === 'loading' && (
                        <div className="flex flex-col items-center gap-2 text-gray-400 text-xs">
                          <RefreshCw className="w-6 h-6 animate-spin text-blue-600" />
                          <span>正在获取登录二维码...</span>
                        </div>
                      )}

                      {(qrStatus === 'wait' || qrStatus === 'scaned') && (
                        <div className="relative">
                          {qrCodeImgContent ? (
                            <QRCodeSVG
                              value={qrCodeImgContent}
                              size={168}
                              level="M"
                              includeMargin={false}
                            />
                          ) : (
                            <div className="text-xs text-gray-400">二维码加载中...</div>
                          )}

                          {qrStatus === 'scaned' && (
                            <div className="absolute inset-0 bg-white/95 flex flex-col items-center justify-center text-center p-2 rounded-xl">
                              <CheckCircle2 className="w-8 h-8 text-emerald-600 animate-bounce mb-1" />
                              <span className="text-sm font-bold text-gray-900">扫码成功</span>
                              <span className="text-xs text-gray-500">请在手机微信上点击【确认】</span>
                            </div>
                          )}
                        </div>
                      )}

                      {qrStatus === 'expired' && (
                        <div className="flex flex-col items-center gap-2 text-center p-3">
                          <AlertCircle className="w-8 h-8 text-amber-500" />
                          <span className="text-xs text-gray-600 font-semibold">二维码已过期</span>
                          <button
                            onClick={fetchQrCode}
                            className="text-xs text-blue-600 hover:underline font-bold"
                          >
                            点击重新生成
                          </button>
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={fetchQrCode}
                      className="mt-3 flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>刷新二维码</span>
                    </button>
                  </div>

                  {/* Steps */}
                  <div className="space-y-3 text-xs flex-1">
                    <div>
                      <div className="flex items-center gap-2 font-bold text-sm text-gray-900 dark:text-gray-100 mb-1">
                        <QrCode className="w-4 h-4 text-emerald-600" />
                        <span>微信扫码免密配对流程</span>
                      </div>
                      <p className="text-xs text-gray-500 dark:text-neutral-400 leading-relaxed">
                        手机微信扫一扫即可配对微信 Clawbot，实现日程双向联动：
                      </p>
                    </div>

                    <ol className="space-y-1.5 text-xs text-gray-600 dark:text-neutral-300 list-decimal list-inside leading-relaxed pl-1">
                      <li>手机打开微信，点击右上角【+】号选择【扫一扫】；</li>
                      <li>扫描左侧二维码，在手机上确认【允许】；</li>
                      <li>配对完成后系统将自动开启微信消息监听与主动任务提醒服务。</li>
                    </ol>

                    <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-100 dark:border-emerald-900/60 rounded-xl text-emerald-800 dark:text-emerald-300 text-xs flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                      <span>当前状态：{qrStatusMsg}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 2. Scheduler Work Slots & Visual Timeline */}
          {activeSection === 'scheduler' && (
            <div className="space-y-5 animate-fadeIn">
              {renderCardHeader(
                <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 flex items-center justify-center">
                  <Clock className="w-5 h-5" />
                </div>,
                '日程规划算法偏好',
                '配置工作作息时段、24小时可用工时分布与任务缓冲间隔',
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  已完成
                </span>
              )}

              {/* Manual Work Slots Input */}
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-bold text-gray-800 dark:text-gray-200 flex items-center gap-1.5 mb-1.5">
                    <span>自定义工作时段 (手动输入)</span>
                  </label>
                  <input
                    type="text"
                    value={workSlotsText}
                    onChange={(e) => setWorkSlotsText(e.target.value)}
                    placeholder="00:00-02:00, 13:00-18:00"
                    className={`w-full px-3.5 py-2.5 bg-gray-50 dark:bg-[#28292a] border rounded-xl font-mono text-xs text-gray-800 dark:text-gray-100 focus:bg-white dark:focus:bg-[#232425] outline-none transition ${
                      parsedSlotsInfo.error
                        ? 'border-rose-300 dark:border-rose-700 focus:ring-2 focus:ring-rose-400/20'
                        : 'border-gray-200 dark:border-neutral-700/80 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500'
                    }`}
                  />
                  {parsedSlotsInfo.error ? (
                    <p className="text-xs text-rose-600 dark:text-rose-400 font-medium mt-1.5 flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      <span>{parsedSlotsInfo.error}</span>
                    </p>
                  ) : (
                    <p className="text-xs text-gray-400 dark:text-neutral-500 mt-1.5">
                      格式形如 <span className="font-mono text-gray-600 dark:text-neutral-300 font-semibold">00:00-02:00, 13:00-18:00</span>。日程将只安排在亮色时段中，支持跨夜与多时段。
                    </p>
                  )}
                </div>

                {/* 24-Hour Timeline Visual Progress Bar */}
                <div className="p-4 bg-gray-50/90 dark:bg-[#28292a]/60 rounded-2xl border border-gray-200/80 dark:border-neutral-700/80 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 text-xs">
                    <div className="flex items-center gap-3">
                      <span className="font-bold text-gray-800 dark:text-gray-200">24h 规划分布</span>
                      <div className="flex items-center gap-3 text-xs">
                        <span className="flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded-xs bg-blue-600 dark:bg-blue-500 inline-block shadow-2xs" />
                          <span className="font-semibold text-blue-700 dark:text-blue-300">亮色: 可安排</span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="w-2.5 h-2.5 rounded-xs bg-gray-300 dark:bg-neutral-700 border border-gray-400/40 inline-block" />
                          <span className="text-gray-500 dark:text-neutral-400">灰色: 休息</span>
                        </span>
                      </div>
                    </div>

                    {!parsedSlotsInfo.error && (
                      <div className="text-xs text-gray-500 dark:text-neutral-400 font-medium">
                        今日工时：<span className="font-bold text-blue-600 dark:text-blue-400">{(parsedSlotsInfo.totalMinutes / 60).toFixed(1)}h</span> / 24h
                      </div>
                    )}
                  </div>

                  {/* Visual Bar */}
                  <div className="relative w-full h-8 bg-gray-200 dark:bg-neutral-800 rounded-xl overflow-hidden shadow-inner flex items-center select-none border border-gray-300/80 dark:border-neutral-700">
                    {parsedSlotsInfo.visualSlots.map((slot, idx) => {
                      const leftPct = (slot.startMin / 1440) * 100;
                      const widthPct = ((slot.endMin - slot.startMin) / 1440) * 100;
                      const durationHours = ((slot.endMin - slot.startMin) / 60).toFixed(1);

                      return (
                        <div
                          key={idx}
                          style={{
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                          }}
                          title={`可安排时段：${slot.label} (共 ${durationHours} 小时)`}
                          className="absolute top-0 bottom-0 bg-blue-600 dark:bg-blue-500 hover:bg-blue-700 dark:hover:bg-blue-400 transition-colors flex items-center justify-center cursor-pointer shadow-xs"
                        >
                          {widthPct >= 6 && (
                            <span className="text-[10px] text-white font-mono font-bold truncate px-1 text-center select-none drop-shadow-2xs">
                              {slot.label}
                            </span>
                          )}
                        </div>
                      );
                    })}

                    {/* Grid Lines at 3h intervals */}
                    {[3, 6, 9, 12, 15, 18, 21].map((hour) => (
                      <div
                        key={hour}
                        style={{ left: `${(hour / 24) * 100}%` }}
                        className="absolute top-0 bottom-0 w-px bg-gray-400/40 dark:bg-neutral-600/50 pointer-events-none"
                      />
                    ))}
                  </div>

                  {/* Hour Scale */}
                  <div className="relative w-full h-4 overflow-hidden">
                    {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((hour) => (
                      <span
                        key={hour}
                        style={{ left: `${(hour / 24) * 100}%` }}
                        className={`absolute text-[10px] font-mono text-gray-400 dark:text-neutral-500 -translate-x-1/2 ${
                          hour === 0 ? 'translate-x-0' : hour === 24 ? '-translate-x-full' : ''
                        }`}
                      >
                        {String(hour).padStart(2, '0')}:00
                      </span>
                    ))}
                  </div>
                </div>

                {/* Buffer Setting */}
                <div className="pt-2">
                  <label className="block font-semibold text-gray-700 dark:text-neutral-300 mb-1 text-xs">
                    任务缓冲间隔 (分钟)
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="120"
                    value={taskBuffer}
                    onChange={(e) => setTaskBuffer(Number(e.target.value))}
                    className="w-full sm:w-60 px-3.5 py-2 bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700 rounded-xl font-mono text-gray-800 dark:text-gray-100 text-xs"
                  />
                  <p className="text-xs text-gray-400 dark:text-neutral-500 mt-1">
                    两个任务之间自动预留的切换与休息间隔（建议 10-15 分钟）
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* 3. Notification & Reminder Cycles */}
          {activeSection === 'notification' && (
            <div className="space-y-5 animate-fadeIn">
              {renderCardHeader(
                <div className="w-10 h-10 rounded-xl bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 flex items-center justify-center">
                  <Bell className="w-5 h-5" />
                </div>,
                '提醒通知与前置周期',
                '设置任务开始前与结束前主动推送微信通知的提前量与防重复策略',
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  已完成
                </span>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 text-xs">
                {/* Start reminder */}
                <div className="p-4 bg-gray-50/80 dark:bg-[#28292a]/50 rounded-2xl border border-gray-200/80 dark:border-neutral-700/80 space-y-3">
                  <div>
                    <label className="block font-bold text-gray-800 dark:text-gray-200 mb-1">
                      开始前微信提醒 (分钟)
                    </label>
                    <p className="text-xs text-gray-500 dark:text-neutral-400 mb-2">
                      在任务即将开始前通过微信通知您准备开始
                    </p>
                    <input
                      type="number"
                      min="1"
                      max="60"
                      value={remindStart}
                      onChange={(e) => setRemindStart(Number(e.target.value))}
                      className="w-full px-3.5 py-2 bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-700 rounded-xl font-mono text-gray-800 dark:text-gray-100 text-xs"
                    />
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {[5, 10, 15, 30].map((mins) => (
                      <button
                        key={mins}
                        type="button"
                        onClick={() => setRemindStart(mins)}
                        className={`px-3 py-1 rounded-lg text-xs font-mono font-medium transition cursor-pointer ${
                          remindStart === mins
                            ? 'bg-blue-600 text-white'
                            : 'bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-700 text-gray-600 dark:text-neutral-300'
                        }`}
                      >
                        {mins} 分钟
                      </button>
                    ))}
                  </div>
                </div>

                {/* End reminder */}
                <div className="p-4 bg-gray-50/80 dark:bg-[#28292a]/50 rounded-2xl border border-gray-200/80 dark:border-neutral-700/80 space-y-3">
                  <div>
                    <label className="block font-bold text-gray-800 dark:text-gray-200 mb-1">
                      结束前微信确认 (分钟)
                    </label>
                    <p className="text-xs text-gray-500 dark:text-neutral-400 mb-2">
                      在任务到期前询问完成情况，可回复“已完成”结项
                    </p>
                    <input
                      type="number"
                      min="1"
                      max="60"
                      value={remindEnd}
                      onChange={(e) => setRemindEnd(Number(e.target.value))}
                      className="w-full px-3.5 py-2 bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-700 rounded-xl font-mono text-gray-800 dark:text-gray-100 text-xs"
                    />
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {[3, 5, 10, 15].map((mins) => (
                      <button
                        key={mins}
                        type="button"
                        onClick={() => setRemindEnd(mins)}
                        className={`px-3 py-1 rounded-lg text-xs font-mono font-medium transition cursor-pointer ${
                          remindEnd === mins
                            ? 'bg-blue-600 text-white'
                            : 'bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-700 text-gray-600 dark:text-neutral-300'
                        }`}
                      >
                        {mins} 分钟
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Notification Mechanism Card */}
              <div className="p-4 bg-blue-50/60 dark:bg-blue-950/30 border border-blue-200/60 dark:border-blue-900/40 rounded-2xl space-y-2 text-xs">
                <div className="font-bold text-blue-900 dark:text-blue-200 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
                  <span>微信智能提醒策略机制已就绪：</span>
                </div>
                <p className="text-blue-800/80 dark:text-blue-300/80 leading-relaxed">
                  系统每 30 秒执行一次精准日程核验。当任务到达设定的前置时间窗口时，将<strong className="text-blue-950 dark:text-blue-100">仅发送一次</strong>微信通知并原子记录状态，避免任何重复刷屏打扰。
                </p>
              </div>
            </div>
          )}

          {/* 4. LLM Config Section */}
          {activeSection === 'llm' && (
            <div className="space-y-5 animate-fadeIn">
              {renderCardHeader(
                <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 flex items-center justify-center">
                  <Brain className="w-5 h-5" />
                </div>,
                '大语言模型配置 (LLM)',
                '从微信用户消息中抽取任务名称、预计耗时、加急度、重要度与截止时间 (DDL)',
                isLlmDone ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    验证有效 (已完成)
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 dark:bg-amber-950/70 text-amber-700 dark:text-amber-300">
                    待测试验证 (未完成)
                  </span>
                )
              )}

              <div className="space-y-4 text-xs max-w-xl">
                <div>
                  <label className="block font-semibold text-gray-700 dark:text-neutral-300 mb-1.5">
                    API 端点 (Base URL)
                  </label>
                  <input
                    type="text"
                    value={llmEndpoint}
                    onChange={(e) => setLlmEndpoint(e.target.value)}
                    placeholder="https://api.deepseek.com/v1"
                    className="w-full px-3.5 py-2.5 bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700 rounded-xl font-mono text-gray-800 dark:text-gray-100 outline-none transition focus:bg-white dark:focus:bg-[#232425] focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  />
                  <span className="text-[11px] text-gray-400 dark:text-neutral-500 mt-1 block">默认预设为 DeepSeek 官方端点</span>
                </div>

                <div>
                  <label className="block font-semibold text-gray-700 dark:text-neutral-300 mb-1.5">
                    API 密钥 (API Key)
                  </label>
                  <input
                    type="password"
                    value={llmApiKey}
                    onChange={(e) => {
                      setLlmApiKey(e.target.value);
                      if (llmApiKeyValid) {
                        setLlmApiKeyValid(false);
                        localStorage.removeItem(`clawbot_llm_valid_${userId}`);
                      }
                    }}
                    placeholder="sk-..."
                    className="w-full px-3.5 py-2.5 bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700 rounded-xl font-mono text-gray-800 dark:text-gray-100 outline-none transition focus:bg-white dark:focus:bg-[#232425] focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  />
                  <span className="text-[11px] text-gray-400 dark:text-neutral-500 mt-1 block">安全存储在服务器 SQLite 数据库中并按用户完全隔离</span>
                </div>

                <div>
                  <label className="block font-semibold text-gray-700 dark:text-neutral-300 mb-1.5">
                    模型型号 (Model)
                  </label>
                  <input
                    type="text"
                    value={llmModel}
                    onChange={(e) => setLlmModel(e.target.value)}
                    placeholder="deepseek-chat"
                    className="w-full px-3.5 py-2.5 bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700 rounded-xl font-mono text-gray-800 dark:text-gray-100 outline-none transition focus:bg-white dark:focus:bg-[#232425] focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  />
                  <span className="text-[11px] text-gray-400 dark:text-neutral-500 mt-1 block">推荐 deepseek-chat 或兼容 OpenAI 的模型名称</span>
                </div>

                <div className="flex items-center gap-2.5 pt-2">
                  <button
                    type="button"
                    onClick={handleTestLlmKey}
                    disabled={llmTesting || !llmApiKey.trim()}
                    className="flex items-center gap-1.5 px-4 py-2 bg-blue-50 dark:bg-blue-950/60 hover:bg-blue-100 dark:hover:bg-blue-900/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 font-medium text-xs rounded-xl shadow-2xs transition disabled:opacity-50 cursor-pointer"
                  >
                    {llmTesting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    <span>{llmTesting ? '正在验证 API Key...' : '测试 API Key 有效性'}</span>
                  </button>

                  {isLlmDone && (
                    <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-semibold">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>验证有效 (已完成)</span>
                    </span>
                  )}
                </div>

                {llmTestResult && (
                  <div className={`p-3 rounded-xl border text-xs flex items-center gap-2 animate-fadeIn ${
                    llmTestResult.success
                      ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
                      : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300'
                  }`}>
                    {llmTestResult.success ? <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> : <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />}
                    <span>{llmTestResult.msg}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 5. External Calendar Subscriptions & Export */}
          {activeSection === 'calendar' && (
            <div className="space-y-5 animate-fadeIn">
              {renderCardHeader(
                <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-950/60 text-purple-600 dark:text-purple-400 flex items-center justify-center">
                  <Calendar className="w-5 h-5" />
                </div>,
                '外部日历与订阅同步',
                '导入外部日历自动避开日程冲突 · 导出专属 TODO 订阅链接至手机日历',
                isCalendarDone ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    已配置 ({subs.length}个源)
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 dark:bg-amber-950/70 text-amber-700 dark:text-amber-300">
                    未添加日历源
                  </span>
                )
              )}

              {/* Export TODO link */}
              <div className="p-4 bg-gray-50 dark:bg-[#28292a] rounded-2xl border border-gray-200/80 dark:border-neutral-700/80 space-y-2 text-xs">
                <label className="block font-bold text-gray-800 dark:text-neutral-200 text-xs">
                  TODO 专属日历订阅 (导出至 iPhone / Mac / Google Calendar)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={icalExportUrl}
                    className="w-full px-3.5 py-2 bg-white dark:bg-[#232425] border border-gray-200 dark:border-neutral-700 rounded-xl font-mono text-xs text-gray-700 dark:text-neutral-300 select-all"
                  />
                  <button
                    type="button"
                    onClick={copyIcal}
                    className="px-4 py-2 bg-gray-200 dark:bg-neutral-700 hover:bg-gray-300 dark:hover:bg-neutral-600 text-gray-800 dark:text-neutral-200 text-xs font-medium rounded-xl shrink-0 flex items-center gap-1.5 transition cursor-pointer"
                  >
                    {copiedIcal ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedIcal ? '已复制' : '复制'}</span>
                  </button>
                </div>
              </div>

              {/* Add external sub */}
              <form onSubmit={handleAddSubscription} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 text-xs">
                <input
                  type="text"
                  value={newSubName}
                  onChange={(e) => setNewSubName(e.target.value)}
                  placeholder="日历名称 (如: 日常会议)"
                  className="w-full sm:w-48 px-3.5 py-2 bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700 rounded-xl text-gray-800 dark:text-gray-100 outline-none"
                  required
                />
                <input
                  type="text"
                  value={newSubUrl}
                  onChange={(e) => setNewSubUrl(e.target.value)}
                  placeholder="订阅链接 (webcal://... 或 https://...ics)"
                  className="w-full px-3.5 py-2 bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700 rounded-xl font-mono text-gray-800 dark:text-gray-100 outline-none"
                  required
                />
                <button
                  type="submit"
                  disabled={addingSub}
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl shrink-0 transition disabled:opacity-50 cursor-pointer"
                >
                  {addingSub ? '添加中...' : '添加日历'}
                </button>
              </form>

              {/* Subscriptions list */}
              <div className="space-y-2.5 text-xs">
                <div className="font-semibold text-gray-700 dark:text-neutral-300">已订阅日历源列表：</div>
                {subs.length === 0 ? (
                  <div className="p-6 text-center text-gray-400 dark:text-neutral-500 bg-gray-50 dark:bg-[#28292a]/50 rounded-2xl border border-dashed border-gray-200 dark:border-neutral-800 text-xs">
                    暂未导入外部日历。填入 Apple / Google 日历订阅链接即可自动规避已有日程。
                  </div>
                ) : (
                  subs.map((sub) => (
                    <div
                      key={sub.id}
                      className="flex items-center justify-between p-3.5 bg-gray-50 dark:bg-[#28292a] border border-gray-200/80 dark:border-neutral-700/80 rounded-xl"
                    >
                      <div className="space-y-1 max-w-xs sm:max-w-md truncate">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-gray-900 dark:text-gray-100 text-xs">{sub.name}</span>
                          <span
                            className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                              sub.sync_status === 'ok'
                                ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300'
                                : 'bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300'
                            }`}
                          >
                            {sub.sync_status === 'ok' ? `正常 (${sub.event_count}条)` : '异常'}
                          </span>
                        </div>
                        <div className="font-mono text-[10px] text-gray-400 dark:text-neutral-500 truncate">
                          {sub.url}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleSyncNow(sub.id)}
                          className="p-2 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded-full transition cursor-pointer"
                          title="立即同步"
                        >
                          <RefreshCw className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteSubscription(sub.id)}
                          className="p-2 text-rose-500 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/50 rounded-full transition cursor-pointer"
                          title="删除"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
