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
} from 'lucide-react';

export const AuthPage: React.FC = () => {
  const { login } = useAuth();
  const { isDark, setThemeMode, themeMode } = useTheme();
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // 验证码倒计时与发送状态
  const [codeSending, setCodeSending] = useState(false);
  const [countdown, setCountdown] = useState(0);

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
      setError('请先输入正确的邮箱地址');
      return;
    }

    setError(null);
    setCodeSending(true);

    try {
      const res = await api.post('/auth/send-code', { email: trimmedEmail });
      setSuccessMsg(res.data.message || '验证码已成功发送至您的邮箱，10分钟内有效！');
      setCountdown(60);
    } catch (err: unknown) {
      const errorObj = err as { response?: { data?: { error?: string } } };
      setError(errorObj.response?.data?.error || '发送验证码失败，请稍后重试');
    } finally {
      setCodeSending(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMsg(null);

    if (!username.trim() || !password) {
      setError('请填写完整的账号与密码');
      return;
    }

    if (isRegister) {
      if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        setError('请填写正确的邮箱地址');
        return;
      }

      if (!code.trim() || code.trim().length !== 6) {
        setError('请输入 6 位邮箱验证码');
        return;
      }

      if (password !== confirmPassword) {
        setError('两次输入的密码不一致');
        return;
      }
    }

    setLoading(true);

    try {
      if (isRegister) {
        const res = await api.post('/auth/register', {
          username: username.trim(),
          email: email.trim(),
          password,
          code: code.trim(),
        });
        setSuccessMsg('注册成功！正在为您自动登录系统...');
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
      setError(errorObj.response?.data?.error || '请求发生错误，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f8fafd] dark:bg-[#131314] flex flex-col items-center justify-center p-4 relative transition-colors">
      {/* Top Right Theme Toggle */}
      <div className="absolute top-5 right-5">
        <button
          type="button"
          onClick={() => setThemeMode(isDark ? 'light' : 'dark')}
          className="p-2.5 text-gray-500 dark:text-neutral-400 hover:bg-gray-200/60 dark:hover:bg-neutral-800 rounded-full transition cursor-pointer"
          title={`当前：${themeMode === 'system' ? '跟随系统' : isDark ? '深色' : '浅色'}，点击切换`}
        >
          {isDark ? <Moon className="w-5 h-5 text-blue-400" /> : <Sun className="w-5 h-5 text-amber-500" />}
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
            微信智能时间规划与动态排程管理控制台
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
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-neutral-300 mb-1.5">
              {isRegister ? '用户名 (3位以上)' : '账号 / 注册邮箱'}
            </label>
            <div className="relative">
              <UserIcon className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-neutral-500" />
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={isRegister ? '请输入用户名' : '请输入用户名或邮箱'}
                className="w-full pl-10 pr-4 py-2.5 bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700 text-gray-900 dark:text-gray-100 rounded-2xl focus:bg-white dark:focus:bg-[#232425] outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-sm font-medium transition"
                required
              />
            </div>
          </div>

          {isRegister && (
            <>
              <div>
                <label className="block text-xs font-semibold text-gray-700 dark:text-neutral-300 mb-1.5">
                  注册邮箱 (唯一绑定)
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-neutral-500" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="请输入您的电子邮箱"
                    className="w-full pl-10 pr-4 py-2.5 bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700 text-gray-900 dark:text-gray-100 rounded-2xl focus:bg-white dark:focus:bg-[#232425] outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-sm font-medium transition"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 dark:text-neutral-300 mb-1.5">
                  邮箱验证码
                </label>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <KeyRound className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-neutral-500" />
                    <input
                      type="text"
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="6 位数字验证码"
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
                      {countdown > 0 ? `${countdown}s 后重新获取` : '获取验证码'}
                    </span>
                  </button>
                </div>
              </div>
            </>
          )}

          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-neutral-300 mb-1.5">
              密码 (6位以上)
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-neutral-500" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
                className="w-full pl-10 pr-4 py-2.5 bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700 text-gray-900 dark:text-gray-100 rounded-2xl focus:bg-white dark:focus:bg-[#232425] outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-sm font-medium transition"
                required
              />
            </div>
          </div>

          {isRegister && (
            <div>
              <label className="block text-xs font-semibold text-gray-700 dark:text-neutral-300 mb-1.5">
                确认密码
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-neutral-500" />
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="请再次输入密码"
                  className="w-full pl-10 pr-4 py-2.5 bg-gray-50 dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700 text-gray-900 dark:text-gray-100 rounded-2xl focus:bg-white dark:focus:bg-[#232425] outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-sm font-medium transition"
                  required
                />
              </div>
              <p className="text-[11px] text-blue-700 dark:text-blue-400 mt-2 bg-blue-50 dark:bg-blue-950/40 p-2.5 rounded-xl border border-blue-200 dark:border-blue-900/60">
                ✨ 提示：输入邮箱验证码即可直接完成注册并登录系统，无需等待管理员人工审核。
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-2 py-3 bg-blue-600 hover:bg-blue-700 active:scale-98 text-white rounded-full font-medium text-sm shadow-sm flex items-center justify-center gap-2 transition disabled:opacity-50 cursor-pointer"
          >
            {loading ? (
              <span className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></span>
            ) : (
              <>
                <span>{isRegister ? '立即注册并进入系统' : '登 录'}</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        <div className="mt-6 pt-5 border-t border-gray-100 dark:border-neutral-800 flex items-center justify-between text-xs sm:text-sm">
          <span className="text-gray-500 dark:text-neutral-400">
            {isRegister ? '已有账号？' : '尚未拥有账号？'}
          </span>
          <button
            type="button"
            onClick={() => {
              setIsRegister(!isRegister);
              setError(null);
              setSuccessMsg(null);
            }}
            className="text-blue-600 dark:text-blue-400 hover:underline font-semibold transition cursor-pointer"
          >
            {isRegister ? '返回登录' : '注册新账号'}
          </button>
        </div>
      </div>
    </div>
  );
};
