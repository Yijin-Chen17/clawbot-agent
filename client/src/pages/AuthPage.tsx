import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import {
  Lock,
  User as UserIcon,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  Sun,
  Moon,
  CheckSquare,
  Mail,
  KeyRound,
  RefreshCw,
  Languages,
  XCircle,
} from 'lucide-react';

type AuthMode = 'login' | 'register' | 'reset';

export const AuthPage: React.FC = () => {
  const { login } = useAuth();
  const { isDark, setThemeMode, themeMode, language, setLanguage } = useTheme();
  const [mode, setMode] = useState<AuthMode>('login');
  const isRegister = mode === 'register';
  const isReset = mode === 'reset';
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const switchMode = (nextMode: AuthMode, keepSuccess: boolean = false) => {
    setMode(nextMode);
    setError(null);
    if (!keepSuccess) setSuccessMsg(null);
    setCode('');
    setPassword('');
    setConfirmPassword('');
    setCountdown(0);
    setUsernameStatus({ status: 'idle', message: '' });
  };

  // 用户名实时查重状态
  const [usernameStatus, setUsernameStatus] = useState<{
    status: 'idle' | 'checking' | 'available' | 'taken' | 'too_short';
    message: string;
  }>({ status: 'idle', message: '' });

  // 验证码倒计时与发送状态
  const [codeSending, setCodeSending] = useState(false);
  const [countdown, setCountdown] = useState(0);

  // 实时检查用户名查重 (带 300ms 防抖)
  useEffect(() => {
    if (!isRegister) {
      setUsernameStatus({ status: 'idle', message: '' });
      return;
    }

    const trimmed = username.trim();
    if (!trimmed) {
      setUsernameStatus({ status: 'idle', message: '' });
      return;
    }

    if (trimmed.length < 3) {
      setUsernameStatus({
        status: 'too_short',
        message: language === 'zh' ? '用户名至少需要 3 位字符' : 'Username must be at least 3 characters',
      });
      return;
    }

    setUsernameStatus((prev) => ({ ...prev, status: 'checking' }));

    const timer = setTimeout(async () => {
      try {
        const res = await api.get('/auth/check-username', {
          params: { username: trimmed },
        });

        if (res.data.available) {
          setUsernameStatus({
            status: 'available',
            message: language === 'zh' ? '该用户名可用' : 'Username is available',
          });
        } else {
          setUsernameStatus({
            status: 'taken',
            message:
              res.data.message ||
              (language === 'zh' ? '该用户名已被占用，请更换其他用户名' : 'Username is already taken, please choose another'),
          });
        }
      } catch (err) {
        console.error('检查用户名重复失败:', err);
        setUsernameStatus({ status: 'idle', message: '' });
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [username, isRegister, language]);

  useEffect(() => {
    let timer: any = null;
    if (countdown > 0) {
      timer = setInterval(() => {
        setCountdown((prev) => (prev > 0 ? prev - 1 : 0));
      }, 1000);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [countdown]);

  const handleSendCode = async () => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError(language === 'zh' ? '请先输入正确的邮箱地址' : 'Please enter a valid email address');
      return;
    }

    setError(null);
    setCodeSending(true);

    try {
      const endpoint = isReset ? '/auth/send-reset-code' : '/auth/send-code';
      const res = await api.post(endpoint, {
        email: trimmedEmail,
        lang: language,
      });
      setSuccessMsg(
        res.data.message ||
          (language === 'zh'
            ? '验证码已成功发送至您的邮箱，10分钟内有效！'
            : 'Verification code sent to your email, valid for 10 minutes!')
      );
      setCountdown(60);
    } catch (err: unknown) {
      const errorObj = err as { response?: { data?: { error?: string } } };
      setError(
        errorObj.response?.data?.error ||
          (language === 'zh' ? '发送验证码失败，请稍后重试' : 'Failed to send code, please try again')
      );
    } finally {
      setCodeSending(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    if (isReset) {
      if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        setError(language === 'zh' ? '请填写正确的绑定邮箱地址' : 'Please enter a valid email address');
        return;
      }
      if (!code.trim() || code.trim().length !== 6) {
        setError(language === 'zh' ? '请输入 6 位邮箱验证码' : 'Please enter the 6-digit email code');
        return;
      }
      if (password.length < 6) {
        setError(language === 'zh' ? '新密码长度至少需要 6 位' : 'New password must be at least 6 characters');
        return;
      }
      if (password !== confirmPassword) {
        setError(language === 'zh' ? '两次输入的密码不一致' : 'Passwords do not match');
        return;
      }
    } else if (!username.trim() || !password) {
      setError(language === 'zh' ? '请填写完整的账号与密码' : 'Please fill in both account and password');
      return;
    }

    if (isRegister) {
      if (username.trim().length < 3) {
        setError(language === 'zh' ? '用户名至少需要 3 位字符' : 'Username must be at least 3 characters');
        return;
      }

      if (usernameStatus.status === 'taken') {
        setError(language === 'zh' ? '该用户名已被占用，请更换其他用户名' : 'Username is already taken, please choose another');
        return;
      }

      if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        setError(language === 'zh' ? '请填写正确的邮箱地址' : 'Please enter a valid email address');
        return;
      }

      if (!code.trim() || code.trim().length !== 6) {
        setError(language === 'zh' ? '请输入 6 位邮箱验证码' : 'Please enter the 6-digit email code');
        return;
      }

      if (password.length < 6) {
        setError(language === 'zh' ? '密码长度至少需要 6 位' : 'Password must be at least 6 characters');
        return;
      }

      if (password !== confirmPassword) {
        setError(language === 'zh' ? '两次输入的密码不一致' : 'Passwords do not match');
        return;
      }
    }

    setLoading(true);

    try {
      if (isReset) {
        const trimmedEmail = email.trim().toLowerCase();
        const res = await api.post('/auth/reset-password', {
          email: trimmedEmail,
          code: code.trim(),
          newPassword: password,
          lang: language,
        });
        setUsername(trimmedEmail);
        setSuccessMsg(
          res.data.message ||
            (language === 'zh'
              ? '密码重置成功，请使用新密码登录！'
              : 'Password reset successful! Please sign in with your new password.')
        );
        switchMode('login', true);
      } else if (isRegister) {
        const res = await api.post('/auth/register', {
          username: username.trim(),
          email: email.trim(),
          password,
          code: code.trim(),
        });
        setSuccessMsg(
          language === 'zh' ? '注册成功！正在为您自动登录系统...' : 'Registration successful! Logging you in...'
        );
        if (res.data.token && res.data.user) {
          setTimeout(() => {
            login(res.data.token, res.data.user);
          }, 600);
        }
      } else {
        const res = await api.post('/auth/login', {
          username: username.trim(),
          password,
        });
        login(res.data.token, res.data.user);
      }
    } catch (err: unknown) {
      const errorObj = err as { response?: { data?: { error?: string } } };
      setError(
        errorObj.response?.data?.error ||
          (language === 'zh' ? '请求发生错误，请稍后重试' : 'An error occurred, please try again')
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f8fafd] dark:bg-[#131314] flex flex-col items-center justify-center p-4 relative transition-colors">
      {/* 顶部右上角工具栏: 中英文切换 + 明暗主题切换 */}
      <div className="absolute top-5 right-5 flex items-center gap-2 z-10">
        <button
          type="button"
          onClick={() => setLanguage(language === 'zh' ? 'en' : 'zh')}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-gray-700 dark:text-neutral-200 bg-white/90 dark:bg-neutral-800/90 hover:bg-gray-100 dark:hover:bg-neutral-700 rounded-full border border-gray-200/80 dark:border-neutral-700/80 backdrop-blur transition cursor-pointer shadow-2xs"
          title={language === 'zh' ? 'Switch to English' : '切换为中文'}
        >
          <Languages className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
          <span>{language === 'zh' ? 'English' : '简体中文'}</span>
        </button>

        <button
          type="button"
          onClick={() => setThemeMode(isDark ? 'light' : 'dark')}
          className="p-2 text-gray-500 dark:text-neutral-400 hover:bg-gray-200/60 dark:hover:bg-neutral-800 rounded-full transition cursor-pointer"
          title={`当前：${themeMode === 'system' ? (language === 'zh' ? '跟随系统' : 'System') : isDark ? (language === 'zh' ? '深色' : 'Dark') : (language === 'zh' ? '浅色' : 'Light')}，点击切换`}
        >
          {isDark ? <Moon className="w-4.5 h-4.5 text-blue-400" /> : <Sun className="w-4.5 h-4.5 text-amber-500" />}
        </button>
      </div>

      {/* Google M3 Surface Card */}
      <div className="max-w-md w-full bg-white dark:bg-[#1e1f20] rounded-3xl shadow-sm border border-gray-200/80 dark:border-neutral-800/80 p-8 sm:p-10 transition-colors">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-600 dark:bg-blue-500 text-white mb-4 shadow-sm shadow-blue-500/30">
            <CheckSquare className="w-7 h-7 stroke-[2.5]" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100 font-sans">
            Clawbot Tasks
          </h1>
          <p className="text-gray-500 dark:text-neutral-400 text-xs sm:text-sm mt-1">
            {language === 'zh'
              ? '微信智能时间规划与动态排程管理控制台'
              : 'WeChat Intelligent Task Planning & Dynamic Scheduling Console'}
          </p>
        </div>

        {error && (
          <div className="mb-5 p-3.5 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 rounded-2xl flex items-start gap-2.5 text-rose-700 dark:text-rose-300 text-xs sm:text-sm animate-fadeIn">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {successMsg && (
          <div className="mb-5 p-3.5 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/60 rounded-2xl flex items-start gap-2.5 text-emerald-700 dark:text-emerald-300 text-xs sm:text-sm animate-fadeIn">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{successMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {!isReset && (
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-neutral-300 mb-1.5">
              {isRegister
                ? language === 'zh'
                  ? '用户名 (3位以上)'
                : 'Username (min 3 chars)'
                : language === 'zh'
                ? '账号 / 注册邮箱'
                : 'Username / Email'}
            </label>

            <div className="relative">
              <UserIcon className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-neutral-500" />
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={
                  isRegister
                    ? language === 'zh'
                      ? '请输入用户名'
                      : 'Choose your username'
                    : language === 'zh'
                    ? '请输入用户名或邮箱'
                    : 'Enter username or email'
                }
                className={`w-full pl-10 pr-9 py-2.5 bg-gray-50 dark:bg-[#28292a] border text-gray-900 dark:text-gray-100 rounded-2xl focus:bg-white dark:focus:bg-[#232425] outline-none text-sm font-medium transition ${
                  isRegister && usernameStatus.status === 'taken'
                    ? 'border-rose-500 dark:border-rose-500 focus:ring-2 focus:ring-rose-500/20'
                    : isRegister && usernameStatus.status === 'available'
                    ? 'border-emerald-500 dark:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20'
                    : 'border-gray-200 dark:border-neutral-700 focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500'
                }`}
                required
              />

              {/* 右侧指示图标 */}
              {isRegister && usernameStatus.status === 'available' && (
                <CheckCircle2 className="w-4 h-4 text-emerald-500 absolute right-3.5 top-1/2 -translate-y-1/2" />
              )}
              {isRegister && usernameStatus.status === 'taken' && (
                <XCircle className="w-4 h-4 text-rose-500 absolute right-3.5 top-1/2 -translate-y-1/2" />
              )}
            </div>

            {/* 预留固定高度提示区域，避免显示查重状态时改变布局高度 (防止 CLS 抖动) */}
            {isRegister && (
              <div className="h-5 mt-1.5 flex items-center text-xs overflow-hidden">
                {usernameStatus.status === 'checking' && (
                  <p className="text-gray-400 dark:text-neutral-500 flex items-center gap-1.5 animate-fadeIn">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-500 shrink-0" />
                    <span>{language === 'zh' ? '正在检查用户名...' : 'Checking availability...'}</span>
                  </p>
                )}
                {usernameStatus.status === 'taken' && (
                  <p className="text-rose-600 dark:text-rose-400 flex items-center gap-1.5 font-medium animate-fadeIn">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>{usernameStatus.message}</span>
                  </p>
                )}
                {usernameStatus.status === 'available' && (
                  <p className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5 font-medium animate-fadeIn">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    <span>{usernameStatus.message}</span>
                  </p>
                )}
                {usernameStatus.status === 'too_short' && (
                  <p className="text-amber-600 dark:text-amber-400 flex items-center gap-1.5 animate-fadeIn">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>{usernameStatus.message}</span>
                  </p>
                )}
              </div>
            )}
          </div>
          )}

          {(isRegister || isReset) && (
            <>
              <div>
                <label className="block text-xs font-semibold text-gray-700 dark:text-neutral-300 mb-1.5">
                  {isReset
                    ? language === 'zh'
                      ? '账号绑定邮箱'
                      : 'Registered Email'
                    : language === 'zh'
                    ? '注册邮箱 (唯一绑定)'
                    : 'Registered Email (Unique)'}
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-neutral-500" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={language === 'zh' ? '请输入您的电子邮箱' : 'Enter your email'}
                    className="w-full pl-10 pr-4 py-2.5 bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700 text-gray-900 dark:text-gray-100 rounded-2xl focus:bg-white dark:focus:bg-[#232425] outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-sm font-medium transition"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 dark:text-neutral-300 mb-1.5">
                  {language === 'zh' ? '邮箱验证码' : 'Email Verification Code'}
                </label>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <KeyRound className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-neutral-500" />
                    <input
                      type="text"
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                      placeholder={language === 'zh' ? '6 位数字验证码' : '6-digit code'}
                      className="w-full pl-10 pr-4 py-2.5 bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700 text-gray-900 dark:text-gray-100 rounded-2xl focus:bg-white dark:focus:bg-[#232425] outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-sm font-mono font-medium transition"
                      required
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleSendCode}
                    disabled={codeSending || countdown > 0 || !email.trim()}
                    className="px-4 py-2.5 bg-blue-50 dark:bg-blue-950/60 hover:bg-blue-100 dark:hover:bg-blue-900/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 text-xs font-semibold rounded-2xl transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap shrink-0 flex items-center gap-1.5 shadow-2xs"
                  >
                    {codeSending && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                    <span>
                      {countdown > 0
                        ? language === 'zh'
                          ? `${countdown}s 后重新获取`
                          : `Resend in ${countdown}s`
                        : language === 'zh'
                        ? '获取验证码'
                        : 'Get Code'}
                    </span>
                  </button>
                </div>
              </div>
            </>
          )}

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold text-gray-700 dark:text-neutral-300">
                {isReset
                  ? language === 'zh'
                    ? '新密码 (6位以上)'
                    : 'New Password (min 6 chars)'
                  : language === 'zh'
                  ? '密码 (6位以上)'
                  : 'Password (min 6 chars)'}
              </label>
              {mode === 'login' && (
                <button
                  type="button"
                  onClick={() => switchMode('reset')}
                  className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
                >
                  {language === 'zh' ? '忘记密码？' : 'Forgot password?'}
                </button>
              )}
            </div>
            <div className="relative">
              <Lock className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-neutral-500" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  isReset
                    ? language === 'zh'
                      ? '请输入新密码'
                      : 'Enter new password'
                    : language === 'zh'
                    ? '请输入密码'
                    : 'Enter password'
                }
                className="w-full pl-10 pr-4 py-2.5 bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700 text-gray-900 dark:text-gray-100 rounded-2xl focus:bg-white dark:focus:bg-[#232425] outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-sm font-medium transition"
                required
              />
            </div>
          </div>

          {(isRegister || isReset) && (
            <div>
              <label className="block text-xs font-semibold text-gray-700 dark:text-neutral-300 mb-1.5">
                {isReset
                  ? language === 'zh'
                    ? '确认新密码'
                    : 'Confirm New Password'
                  : language === 'zh'
                  ? '确认密码'
                  : 'Confirm Password'}
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-neutral-500" />
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder={language === 'zh' ? '请再次输入密码' : 'Confirm your password'}
                  className="w-full pl-10 pr-4 py-2.5 bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700 text-gray-900 dark:text-gray-100 rounded-2xl focus:bg-white dark:focus:bg-[#232425] outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-sm font-medium transition"
                  required
                />
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={loading || (isRegister && usernameStatus.status === 'taken')}
            className="w-full mt-2 py-3 bg-blue-600 hover:bg-blue-700 active:scale-98 text-white rounded-full font-medium text-sm shadow-sm flex items-center justify-center gap-2 transition disabled:opacity-50 cursor-pointer"
          >
            {loading ? (
              <span className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></span>
            ) : (
              <>
                <span>
                  {isReset
                    ? language === 'zh'
                      ? '确认重置密码'
                      : 'Reset Password'
                    : isRegister
                    ? language === 'zh'
                      ? '立即注册并进入系统'
                      : 'Register & Enter Workspace'
                    : language === 'zh'
                    ? '登 录'
                    : 'Sign In'}
                </span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        <div className="mt-6 pt-5 border-t border-gray-100 dark:border-neutral-800 flex items-center justify-between text-xs sm:text-sm">
          <span className="text-gray-500 dark:text-neutral-400">
            {isReset
              ? language === 'zh'
                ? '想起密码了？'
                : 'Remembered your password?'
              : isRegister
              ? language === 'zh'
                ? '已有账号？'
                : 'Already have an account?'
              : language === 'zh'
              ? '尚未拥有账号？'
              : "Don't have an account?"}
          </span>
          <button
            type="button"
            onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
            className="text-blue-600 dark:text-blue-400 hover:underline font-semibold transition cursor-pointer"
          >
            {mode !== 'login'
              ? language === 'zh'
                ? '返回登录'
                : 'Back to Sign In'
              : language === 'zh'
              ? '注册新账号'
              : 'Create Account'}
          </button>
        </div>
      </div>
    </div>
  );
};
