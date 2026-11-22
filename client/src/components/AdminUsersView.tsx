import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { CostCurveChart } from './CostCurveChart';
import {
  ShieldCheck,
  Trash2,
  Clock,
  Check,
  AlertCircle,
  Ban,
  Mail,
  UserCheck,
  Coins,
  Globe,
  Sparkles,
  Ticket,
  BarChart3,
  Users,
  Copy,
  RefreshCw,
  Plus,
  CheckCircle2,
} from 'lucide-react';

interface ManagedUser {
  id: number;
  username: string;
  email?: string;
  role: 'user' | 'admin';
  status: 'pending' | 'approved' | 'rejected' | 'banned';
  balance?: number;
  task_count: number;
  subscription_count: number;
  created_at: string;
}

interface RedemptionCodeItem {
  id: number;
  code: string;
  amount: number;
  status: 'active' | 'used' | 'disabled';
  created_by?: number;
  used_by_user_id?: number | null;
  used_by_username?: string | null;
  used_at?: string | null;
  created_at: string;
}

interface RedemptionSummary {
  totalCount: number;
  activeCount: number;
  usedCount: number;
  totalActiveAmount: number;
  totalUsedAmount: number;
}

export const AdminUsersView: React.FC<{ onRefreshCount?: () => void }> = ({ onRefreshCount }) => {
  const { user: currentUser } = useAuth();

  // Active Tab: 'users' | 'global_llm' | 'redemption' | 'usage_stats'
  const [adminTab, setAdminTab] = useState<'users' | 'global_llm' | 'redemption' | 'usage_stats'>('users');

  // ================= 1. 用户与额度管理状态 =================
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'approved' | 'banned' | 'pending'>('all');

  // 直接充值弹窗状态
  const [rechargeUser, setRechargeUser] = useState<ManagedUser | null>(null);
  const [rechargeAmount, setRechargeAmount] = useState<string>('1.00');
  const [recharging, setRecharging] = useState<boolean>(false);
  const [rechargeMsg, setRechargeMsg] = useState<{ success: boolean; text: string } | null>(null);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await api.get('/admin/users');
      setUsers(res.data.users);
      if (onRefreshCount) onRefreshCount();
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleBan = async (id: number, username: string) => {
    if (!window.confirm(`确定要封禁用户「${username}」吗？封禁后该用户将无法登录系统。`)) return;
    try {
      const res = await api.put(`/admin/users/${id}/ban`);
      alert(res.data.message);
      fetchUsers();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      alert(error.response?.data?.error || '封禁操作失败');
    }
  };

  const handleUnban = async (id: number, username: string) => {
    if (!window.confirm(`确定要解封用户「${username}」吗？`)) return;
    try {
      const res = await api.put(`/admin/users/${id}/unban`);
      alert(res.data.message);
      fetchUsers();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      alert(error.response?.data?.error || '解封操作失败');
    }
  };

  const handleApprove = async (id: number) => {
    try {
      const res = await api.put(`/admin/users/${id}/approve`);
      alert(res.data.message);
      fetchUsers();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      alert(error.response?.data?.error || '操作失败');
    }
  };

  const handleToggleRole = async (id: number, currentRole: string) => {
    const newRole = currentRole === 'admin' ? 'user' : 'admin';
    if (!window.confirm(`确定将该用户的角色切换为「${newRole}」吗？`)) return;
    try {
      const res = await api.put(`/admin/users/${id}/role`, { role: newRole });
      alert(res.data.message);
      fetchUsers();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      alert(error.response?.data?.error || '修改角色失败');
    }
  };

  const handleDelete = async (id: number, username: string) => {
    if (!window.confirm(`确定要彻底删除用户「${username}」吗？其所有待办日程、配置数据将被彻底清空且不可恢复！`)) return;
    try {
      await api.delete(`/admin/users/${id}`);
      alert('用户已成功删除');
      fetchUsers();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      alert(error.response?.data?.error || '删除失败');
    }
  };

  const handleConfirmRecharge = async () => {
    if (!rechargeUser) return;
    const amountNum = parseFloat(rechargeAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      alert('请输入大于 0 的有效充值金额');
      return;
    }

    setRecharging(true);
    setRechargeMsg(null);
    try {
      const res = await api.post(`/admin/users/${rechargeUser.id}/recharge`, { amount: amountNum });
      setRechargeMsg({ success: true, text: res.data.message || '充值成功！' });
      fetchUsers();
      setTimeout(() => {
        setRechargeUser(null);
        setRechargeMsg(null);
        setRechargeAmount('1.00');
      }, 1500);
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } }; message?: string };
      setRechargeMsg({ success: false, text: error.response?.data?.error || error.message || '充值失败' });
    } finally {
      setRecharging(false);
    }
  };

  // ================= 2. 全局官方 API 配置状态 =================
  const [globalEndpoint, setGlobalEndpoint] = useState('https://api.deepseek.com/v1');
  const [globalApiKey, setGlobalApiKey] = useState('');
  const [globalApiKeyMasked, setGlobalApiKeyMasked] = useState('');
  const [globalModel, setGlobalModel] = useState('deepseek-chat');
  const [globalHasKey, setGlobalHasKey] = useState(false);
  const [globalTesting, setGlobalTesting] = useState(false);
  const [globalTestResult, setGlobalTestResult] = useState<{ success: boolean; msg: string } | null>(null);
  const [globalSaving, setGlobalSaving] = useState(false);
  const [globalSaveSuccess, setGlobalSaveSuccess] = useState(false);

  const fetchGlobalLlm = async () => {
    try {
      const res = await api.get('/admin/global-llm');
      setGlobalEndpoint(res.data.endpoint || 'https://api.deepseek.com/v1');
      setGlobalModel(res.data.model || 'deepseek-chat');
      setGlobalApiKeyMasked(res.data.apiKeyMasked || '');
      setGlobalHasKey(Boolean(res.data.hasKey));
    } catch (err) {
      console.error('获取全局 API 配置失败:', err);
    }
  };

  useEffect(() => {
    if (adminTab === 'global_llm') {
      fetchGlobalLlm();
    }
  }, [adminTab]);

  const handleSaveGlobalLlm = async () => {
    setGlobalSaving(true);
    try {
      await api.put('/admin/global-llm', {
        endpoint: globalEndpoint,
        api_key: globalApiKey || undefined,
        model: globalModel,
      });
      setGlobalSaveSuccess(true);
      setGlobalApiKey('');
      fetchGlobalLlm();
      setTimeout(() => setGlobalSaveSuccess(false), 2500);
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } }; message?: string };
      alert('保存失败: ' + (error.response?.data?.error || error.message));
    } finally {
      setGlobalSaving(false);
    }
  };

  const handleTestGlobalLlm = async () => {
    setGlobalTesting(true);
    setGlobalTestResult(null);
    try {
      const res = await api.post('/admin/global-llm/test', {
        endpoint: globalEndpoint,
        api_key: globalApiKey || undefined,
        model: globalModel,
      });
      setGlobalTestResult({ success: true, msg: res.data.message || '连通性测试成功！' });
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } }; message?: string };
      setGlobalTestResult({ success: false, msg: error.response?.data?.error || error.message || '测试失败' });
    } finally {
      setGlobalTesting(false);
    }
  };

  // ================= 3. 兑换码管理状态 =================
  const [redemptionCodes, setRedemptionCodes] = useState<RedemptionCodeItem[]>([]);
  const [redemptionSummary, setRedemptionSummary] = useState<RedemptionSummary | null>(null);
  const [redemptionLoading, setRedemptionLoading] = useState(false);

  // 生成兑换码弹窗
  const [showGenModal, setShowGenModal] = useState(false);
  const [genAmount, setGenAmount] = useState('1.00');
  const [genCount, setGenCount] = useState(1);
  const [generatingCodes, setGeneratingCodes] = useState(false);
  const [newlyGenerated, setNewlyGenerated] = useState<string[]>([]);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const fetchRedemptionCodes = async () => {
    setRedemptionLoading(true);
    try {
      const res = await api.get('/admin/redemption-codes');
      setRedemptionCodes(res.data.codes || []);
      setRedemptionSummary(res.data.summary || null);
    } catch (err) {
      console.error('获取兑换码列表失败:', err);
    } finally {
      setRedemptionLoading(false);
    }
  };

  useEffect(() => {
    if (adminTab === 'redemption') {
      fetchRedemptionCodes();
    }
  }, [adminTab]);

  const handleGenerateCodes = async () => {
    const amountNum = parseFloat(genAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      alert('请输入大于 0 的有效面额');
      return;
    }
    const countNum = parseInt(String(genCount), 10);
    if (isNaN(countNum) || countNum < 1 || countNum > 50) {
      alert('单次生成数量支持 1 ~ 50 张');
      return;
    }

    setGeneratingCodes(true);
    try {
      const res = await api.post('/admin/redemption-codes/generate', {
        amount: amountNum,
        count: countNum,
      });
      setNewlyGenerated(res.data.codes || []);
      fetchRedemptionCodes();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } }; message?: string };
      alert('生成失败: ' + (error.response?.data?.error || error.message));
    } finally {
      setGeneratingCodes(false);
    }
  };

  const handleDeleteCode = async (id: number) => {
    if (!window.confirm('确定要删除该兑换码吗？删除后将不可兑换。')) return;
    try {
      await api.delete(`/admin/redemption-codes/${id}`);
      fetchRedemptionCodes();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      alert(error.response?.data?.error || '删除失败');
    }
  };

  const copyToClipboard = (text: string, identifier?: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCode(identifier || text);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  // ================= 4. 全平台用量监控状态 =================
  const [adminUsageLoading, setAdminUsageLoading] = useState(false);
  const [adminUsageData, setAdminUsageData] = useState<{
    summary: {
      totalRequests: number;
      totalTokens: number;
      promptTokens: number;
      cacheHitTokens: number;
      cacheMissTokens: number;
      completionTokens: number;
      totalCostCny: number;
      inputCostCny: number;
      outputCostCny: number;
      savedCostCny: number;
      cacheHitRate: number;
    };
    dailyHistory: {
      '1d': Array<{ label: string; date: string; cost_cny: number; tokens: number; requests: number }>;
      '7d': Array<{ label: string; date: string; cost_cny: number; tokens: number; requests: number }>;
      '30d': Array<{ label: string; date: string; cost_cny: number; tokens: number; requests: number }>;
    };
  } | null>(null);

  const fetchAdminUsage = async () => {
    setAdminUsageLoading(true);
    try {
      const res = await api.get('/admin/usage-stats');
      setAdminUsageData(res.data);
    } catch (err) {
      console.error('获取全平台用量失败:', err);
    } finally {
      setAdminUsageLoading(false);
    }
  };

  useEffect(() => {
    if (adminTab === 'usage_stats') {
      fetchAdminUsage();
    }
  }, [adminTab]);

  const filteredUsers = users.filter((u) => {
    if (filter === 'all') return true;
    return u.status === filter;
  });

  const bannedCount = users.filter((u) => u.status === 'banned').length;
  const approvedCount = users.filter((u) => u.status === 'approved').length;
  const pendingCount = users.filter((u) => u.status === 'pending').length;

  return (
    <div className="w-full max-w-5xl mx-auto flex-1 min-h-0 flex flex-col space-y-4 overflow-hidden">
      {/* 顶部主选项卡切换 */}
      <div className="shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-200 dark:border-neutral-800 pb-3">
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-none">
          <button
            type="button"
            onClick={() => setAdminTab('users')}
            className={`px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition cursor-pointer ${
              adminTab === 'users'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'bg-white dark:bg-[#1e1f20] text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 border border-gray-200 dark:border-neutral-700/80'
            }`}
          >
            <Users className="w-4 h-4" />
            <span>用户与额度管理</span>
            {pendingCount > 0 && (
              <span className="bg-amber-400 text-amber-950 text-[10px] px-1.5 py-0.2 rounded-full font-bold">
                {pendingCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setAdminTab('global_llm')}
            className={`px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition cursor-pointer ${
              adminTab === 'global_llm'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'bg-white dark:bg-[#1e1f20] text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 border border-gray-200 dark:border-neutral-700/80'
            }`}
          >
            <Globe className="w-4 h-4" />
            <span>全局官方 API 设置</span>
            {globalHasKey && <span className="w-2 h-2 rounded-full bg-emerald-400" />}
          </button>

          <button
            type="button"
            onClick={() => setAdminTab('redemption')}
            className={`px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition cursor-pointer ${
              adminTab === 'redemption'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'bg-white dark:bg-[#1e1f20] text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 border border-gray-200 dark:border-neutral-700/80'
            }`}
          >
            <Ticket className="w-4 h-4" />
            <span>兑换码管理</span>
            {redemptionSummary && redemptionSummary.activeCount > 0 && (
              <span className="bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 text-[10px] px-1.5 py-0.2 rounded-full font-bold">
                {redemptionSummary.activeCount} 可用
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setAdminTab('usage_stats')}
            className={`px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition cursor-pointer ${
              adminTab === 'usage_stats'
                ? 'bg-blue-600 text-white shadow-sm'
                : 'bg-white dark:bg-[#1e1f20] text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 border border-gray-200 dark:border-neutral-700/80'
            }`}
          >
            <BarChart3 className="w-4 h-4" />
            <span>全平台用量监控</span>
          </button>
        </div>
      </div>

      {/* ================= TAB 1: 用户与额度管理 ================= */}
      {adminTab === 'users' && (
        <div className="flex-1 min-h-0 flex flex-col space-y-4">
          <div className="shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <span>用户账号与额度管理</span>
                {bannedCount > 0 && (
                  <span className="bg-rose-500 text-white text-xs px-2.5 py-0.5 rounded-full font-semibold">
                    {bannedCount} 已封禁
                  </span>
                )}
              </h2>
              <p className="text-xs sm:text-sm text-gray-500 dark:text-neutral-400 mt-0.5">
                管理注册用户状态、查看/直接充值用户账户余额，支持快捷封禁、解封或彻底删除用户数据
              </p>
            </div>

            {/* Filter Pills */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 scrollbar-none">
              {[
                { key: 'all', label: `全部 (${users.length})` },
                { key: 'approved', label: `正常 (${approvedCount})` },
                { key: 'banned', label: `已封禁 (${bannedCount})` },
                ...(pendingCount > 0 ? [{ key: 'pending', label: `待审核 (${pendingCount})` }] : []),
              ].map((item) => (
                <button
                  key={item.key}
                  onClick={() => setFilter(item.key as any)}
                  className={`px-3.5 py-1.5 rounded-full text-xs font-medium shrink-0 transition cursor-pointer ${
                    filter === item.key
                      ? 'bg-blue-600 text-white dark:bg-blue-500 shadow-xs'
                      : 'bg-white dark:bg-[#1e1f20] text-gray-600 dark:text-neutral-400 hover:bg-gray-100 dark:hover:bg-neutral-800 border border-gray-200 dark:border-neutral-700/80'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {/* Table Container */}
          <div className="flex-1 min-h-0 bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800 rounded-3xl overflow-hidden flex flex-col shadow-2xs">
            <div className="hidden sm:block flex-1 min-h-0 overflow-y-auto">
              <table className="w-full text-left text-xs sm:text-sm">
                <thead className="bg-[#f8fafd] dark:bg-[#28292a] text-gray-500 dark:text-neutral-400 font-semibold sticky top-0 border-b border-gray-200 dark:border-neutral-800 z-10">
                  <tr>
                    <th className="px-5 py-3.5">账号 / 注册邮箱</th>
                    <th className="px-5 py-3.5">账户余额 (¥)</th>
                    <th className="px-5 py-3.5">角色权限</th>
                    <th className="px-5 py-3.5">账号状态</th>
                    <th className="px-5 py-3.5">任务 / 订阅</th>
                    <th className="px-5 py-3.5">注册时间</th>
                    <th className="px-5 py-3.5 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-neutral-800/80">
                  {filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-center py-12 text-gray-400 text-xs">
                        暂无符合条件的用户
                      </td>
                    </tr>
                  ) : (
                    filteredUsers.map((u) => {
                      const isSelf = u.id === currentUser?.id;
                      const isRootAdmin = u.role === 'admin' && u.username === 'admin';
                      const balance = Number(u.balance || 0);

                      return (
                        <tr
                          key={u.id}
                          className="hover:bg-gray-50/50 dark:hover:bg-neutral-800/40 transition"
                        >
                          <td className="px-5 py-4">
                            <div className="flex flex-col">
                              <div className="font-semibold text-gray-900 dark:text-gray-100 flex items-center gap-1.5">
                                <span>{u.username}</span>
                                {isSelf && (
                                  <span className="text-[10px] bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 px-1.5 py-0.2 rounded-full border border-blue-200 dark:border-blue-800">
                                    当前账号
                                  </span>
                                )}
                              </div>
                              {u.email ? (
                                <span className="text-[11px] text-gray-500 dark:text-neutral-400 font-mono flex items-center gap-1 mt-0.5">
                                  <Mail className="w-3 h-3 text-gray-400" />
                                  {u.email}
                                </span>
                              ) : (
                                <span className="text-[11px] text-gray-400 dark:text-neutral-500 font-mono mt-0.5">
                                  UID: #{u.id}
                                </span>
                              )}
                            </div>
                          </td>

                          {/* 余额与直接充值 */}
                          <td className="px-5 py-4">
                            <div className="flex items-center gap-2">
                              <span className={`font-mono font-bold text-xs ${
                                balance > 0
                                  ? 'text-blue-600 dark:text-blue-400'
                                  : 'text-gray-400 dark:text-neutral-500'
                              }`}>
                                ¥{balance.toFixed(4)}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  setRechargeUser(u);
                                  setRechargeAmount('1.00');
                                  setRechargeMsg(null);
                                }}
                                className="px-2 py-0.5 text-[11px] font-medium bg-emerald-50 dark:bg-emerald-950/50 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 rounded-md transition cursor-pointer flex items-center gap-1"
                                title="直接充值指定金额到该账户额度"
                              >
                                <Coins className="w-3 h-3 text-emerald-500" />
                                <span>充值</span>
                              </button>
                            </div>
                          </td>

                          <td className="px-5 py-4">
                            <button
                              onClick={() => handleToggleRole(u.id, u.role)}
                              disabled={isSelf || isRootAdmin}
                              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium transition ${
                                u.role === 'admin'
                                  ? 'bg-purple-50 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800'
                                  : 'bg-gray-100 dark:bg-neutral-800 text-gray-600 dark:text-neutral-300'
                              } ${isSelf || isRootAdmin ? 'cursor-default opacity-80' : 'cursor-pointer hover:opacity-80'}`}
                              title={isSelf ? '不能修改自身角色' : '点击切换角色权限'}
                            >
                              <ShieldCheck className="w-3 h-3" />
                              {u.role === 'admin' ? '系统管理员' : '普通用户'}
                            </button>
                          </td>

                          <td className="px-5 py-4">
                            {u.status === 'approved' && (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                                <Check className="w-3 h-3" />
                                正常
                              </span>
                            )}
                            {u.status === 'banned' && (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800">
                                <Ban className="w-3 h-3" />
                                已封禁
                              </span>
                            )}
                            {u.status === 'pending' && (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
                                <Clock className="w-3 h-3" />
                                待审核
                              </span>
                            )}
                            {u.status === 'rejected' && (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 dark:bg-neutral-800 text-gray-600 dark:text-neutral-400">
                                <AlertCircle className="w-3 h-3" />
                                已拒绝
                              </span>
                            )}
                          </td>

                          <td className="px-5 py-4 text-gray-600 dark:text-neutral-400">
                            <span>{u.task_count} 条待办</span>
                            <span className="text-gray-300 dark:text-neutral-600 mx-1.5">/</span>
                            <span>{u.subscription_count} 订阅</span>
                          </td>

                          <td className="px-5 py-4 text-gray-400 dark:text-neutral-500 font-mono text-[11px]">
                            {new Date(u.created_at).toLocaleDateString('zh-CN')}
                          </td>

                          <td className="px-5 py-4 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              {u.status === 'pending' && (
                                <button
                                  onClick={() => handleApprove(u.id)}
                                  className="px-3.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-medium rounded-full shadow-xs transition cursor-pointer"
                                >
                                  放行
                                </button>
                              )}

                              {u.status === 'banned' && !isSelf && (
                                <button
                                  onClick={() => handleUnban(u.id, u.username)}
                                  className="px-3 py-1 bg-emerald-50 dark:bg-emerald-950/60 hover:bg-emerald-100 text-emerald-700 dark:text-emerald-300 font-medium rounded-full border border-emerald-200 dark:border-emerald-800 transition cursor-pointer flex items-center gap-1"
                                >
                                  <UserCheck className="w-3 h-3" />
                                  解封
                                </button>
                              )}

                              {u.status === 'approved' && !isSelf && !isRootAdmin && (
                                <button
                                  onClick={() => handleBan(u.id, u.username)}
                                  className="px-3 py-1 bg-rose-50 dark:bg-rose-950/60 hover:bg-rose-100 text-rose-700 dark:text-rose-300 font-medium rounded-full border border-rose-200 dark:border-rose-800 transition cursor-pointer flex items-center gap-1"
                                >
                                  <Ban className="w-3 h-3" />
                                  封禁
                                </button>
                              )}

                              {!isSelf && !isRootAdmin && (
                                <button
                                  onClick={() => handleDelete(u.id, u.username)}
                                  className="p-1.5 text-gray-400 dark:text-neutral-500 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-full transition cursor-pointer"
                                  title="彻底删除用户"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Mobile Cards View */}
            <div className="sm:hidden divide-y divide-gray-100 dark:divide-neutral-800 overflow-y-auto">
              {filteredUsers.length === 0 ? (
                <div className="p-8 text-center text-gray-400 text-xs">暂无用户</div>
              ) : (
                filteredUsers.map((u) => {
                  const isSelf = u.id === currentUser?.id;
                  const isRootAdmin = u.role === 'admin' && u.username === 'admin';
                  const balance = Number(u.balance || 0);

                  return (
                    <div key={u.id} className="p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-semibold text-gray-900 dark:text-gray-100 text-sm flex items-center gap-1.5">
                            <span>{u.username}</span>
                            {isSelf && (
                              <span className="text-[10px] bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400 px-1.5 py-0.2 rounded-full">
                                自己
                              </span>
                            )}
                          </div>
                          {u.email && (
                            <span className="text-[11px] text-gray-500 dark:text-neutral-400 font-mono block">
                              {u.email}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-xs text-blue-600 dark:text-blue-400">
                            ¥{balance.toFixed(2)}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              setRechargeUser(u);
                              setRechargeAmount('1.00');
                              setRechargeMsg(null);
                            }}
                            className="px-2 py-0.5 text-[11px] bg-emerald-50 dark:bg-emerald-950 text-emerald-600 rounded-md border border-emerald-200"
                          >
                            充值
                          </button>
                        </div>
                      </div>

                      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-neutral-400">
                        <span>{u.role === 'admin' ? '系统管理员' : '普通用户'}</span>
                        <span>{u.task_count} 任务 · {u.subscription_count} 订阅</span>
                      </div>

                      <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100 dark:border-neutral-800/80">
                        {u.status === 'banned' && !isSelf && (
                          <button
                            onClick={() => handleUnban(u.id, u.username)}
                            className="px-3 py-1 bg-emerald-600 text-white rounded-full text-xs font-medium"
                          >
                            解封
                          </button>
                        )}
                        {u.status === 'approved' && !isSelf && !isRootAdmin && (
                          <button
                            onClick={() => handleBan(u.id, u.username)}
                            className="px-3 py-1 bg-rose-50 dark:bg-rose-950/50 text-rose-600 rounded-full text-xs font-medium border border-rose-200"
                          >
                            封禁
                          </button>
                        )}
                        {!isSelf && !isRootAdmin && (
                          <button
                            onClick={() => handleDelete(u.id, u.username)}
                            className="p-1.5 text-gray-400 hover:text-rose-600 rounded-full"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* ================= TAB 2: 全局官方 API 设置 ================= */}
      {adminTab === 'global_llm' && (
        <div className="flex-1 min-h-0 bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800 rounded-3xl p-5 sm:p-7 overflow-y-auto shadow-2xs space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-gray-100 dark:border-neutral-800">
            <div>
              <h2 className="text-xl font-bold tracking-tight text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <Globe className="w-5 h-5 text-blue-500" />
                <span>全局官方 API 设置</span>
              </h2>
              <p className="text-xs sm:text-sm text-gray-500 dark:text-neutral-400 mt-1 leading-relaxed">
                配置供全平台所有用户共享调用的官方大模型接口。用户选用官方接口模式时，将统一由本配置提供智能解析支撑，并按实际 Token 折算扣除该用户账户额度。
              </p>
            </div>

            {globalHasKey ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300 shrink-0">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                已配置官方密钥
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-100 dark:bg-amber-950/70 text-amber-700 dark:text-amber-300 shrink-0">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                未配置官方密钥
              </span>
            )}
          </div>

          <div className="space-y-5 text-xs max-w-2xl">
            {/* Endpoint */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-gray-800 dark:text-gray-200 uppercase tracking-wider block">
                全局端点 (Base URL)
              </label>
              <input
                type="text"
                value={globalEndpoint}
                onChange={(e) => setGlobalEndpoint(e.target.value)}
                placeholder="https://api.deepseek.com/v1"
                className="w-full px-3.5 py-2.5 bg-white dark:bg-[#28292a] border border-gray-300 dark:border-neutral-700 rounded-xl font-mono text-gray-800 dark:text-gray-100 outline-none transition focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
              <span className="text-[11px] text-gray-400 dark:text-neutral-500 block">
                默认推荐 DeepSeek 官方端点或兼容 OpenAI 格式的反代接口
              </span>
            </div>

            {/* API Key */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-gray-800 dark:text-gray-200 uppercase tracking-wider block">
                全局 API 密钥 (API Key)
              </label>
              <input
                type="password"
                value={globalApiKey}
                onChange={(e) => setGlobalApiKey(e.target.value)}
                placeholder={globalApiKeyMasked ? `已配置: ${globalApiKeyMasked} (留空则保持不变)` : 'sk-xxxxxxxxxxxxxxxxxxxxxxxx'}
                className="w-full px-3.5 py-2.5 bg-white dark:bg-[#28292a] border border-gray-300 dark:border-neutral-700 rounded-xl font-mono text-gray-800 dark:text-gray-100 outline-none transition focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
              <span className="text-[11px] text-gray-400 dark:text-neutral-500 block">
                安全存储于 system_settings 数据库中，留空则保持当前配置不变
              </span>
            </div>

            {/* Model */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold text-gray-800 dark:text-gray-200 uppercase tracking-wider block">
                模型型号 (Model)
              </label>
              <input
                type="text"
                value={globalModel}
                onChange={(e) => setGlobalModel(e.target.value)}
                placeholder="deepseek-chat"
                className="w-full px-3.5 py-2.5 bg-white dark:bg-[#28292a] border border-gray-300 dark:border-neutral-700 rounded-xl font-mono text-gray-800 dark:text-gray-100 outline-none transition focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
              <span className="text-[11px] text-gray-400 dark:text-neutral-500 block">
                推荐 deepseek-chat 或兼容 OpenAI 标准的语言模型
              </span>
            </div>

            {/* Buttons */}
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleTestGlobalLlm}
                disabled={globalTesting}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-50 dark:bg-blue-950/60 hover:bg-blue-100 dark:hover:bg-blue-900/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 font-medium text-xs rounded-xl shadow-2xs transition disabled:opacity-50 cursor-pointer"
              >
                {globalTesting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                <span>{globalTesting ? '测试连通性中...' : '测试全局连通性'}</span>
              </button>

              <button
                type="button"
                onClick={handleSaveGlobalLlm}
                disabled={globalSaving}
                className="flex items-center gap-1.5 px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs rounded-xl shadow-2xs transition disabled:opacity-50 cursor-pointer"
              >
                {globalSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                <span>{globalSaving ? '保存中...' : '保存全局配置'}</span>
              </button>

              {globalSaveSuccess && (
                <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-semibold animate-fadeIn">
                  <CheckCircle2 className="w-4 h-4" />
                  <span>配置已更新生效！</span>
                </span>
              )}
            </div>

            {globalTestResult && (
              <div className={`p-3.5 rounded-xl border text-xs flex items-center gap-2 animate-fadeIn ${
                globalTestResult.success
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
                  : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300'
              }`}>
                {globalTestResult.success ? <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> : <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />}
                <span>{globalTestResult.msg}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ================= TAB 3: 兑换码管理 ================= */}
      {adminTab === 'redemption' && (
        <div className="flex-1 min-h-0 flex flex-col space-y-4">
          {/* 汇总统计面板与生成按钮 */}
          <div className="shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <span>兑换码生成与管理</span>
              </h2>
              <p className="text-xs sm:text-sm text-gray-500 dark:text-neutral-400 mt-0.5">
                支持生成指定限额的充值兑换卡密，用户可在其个人设置界面输入兑换码直接增加账户可用额度
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={fetchRedemptionCodes}
                className="p-2 text-gray-500 hover:text-gray-700 dark:text-neutral-400 dark:hover:text-neutral-200 bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800 rounded-xl transition cursor-pointer"
                title="刷新列表"
              >
                <RefreshCw className={`w-4 h-4 ${redemptionLoading ? 'animate-spin' : ''}`} />
              </button>

              <button
                type="button"
                onClick={() => {
                  setNewlyGenerated([]);
                  setShowGenModal(true);
                }}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs rounded-xl shadow-2xs transition cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>批量生成兑换码</span>
              </button>
            </div>
          </div>

          {/* 汇总统计卡片 */}
          {redemptionSummary && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 shrink-0">
              <div className="p-3.5 rounded-2xl bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">总生成张数</div>
                <div className="text-xl font-bold text-gray-900 dark:text-gray-100 mt-1 font-mono">
                  {redemptionSummary.totalCount}
                </div>
              </div>

              <div className="p-3.5 rounded-2xl bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">待兑换张数</div>
                <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400 mt-1 font-mono">
                  {redemptionSummary.activeCount}
                </div>
              </div>

              <div className="p-3.5 rounded-2xl bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">可用总面值</div>
                <div className="text-xl font-bold text-blue-600 dark:text-blue-400 mt-1 font-mono">
                  ¥{redemptionSummary.totalActiveAmount.toFixed(2)}
                </div>
              </div>

              <div className="p-3.5 rounded-2xl bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">已兑换总额</div>
                <div className="text-xl font-bold text-gray-600 dark:text-neutral-300 mt-1 font-mono">
                  ¥{redemptionSummary.totalUsedAmount.toFixed(2)}
                </div>
              </div>
            </div>
          )}

          {/* 兑换码表格 */}
          <div className="flex-1 min-h-0 bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800 rounded-3xl overflow-hidden flex flex-col shadow-2xs">
            <div className="flex-1 min-h-0 overflow-y-auto">
              <table className="w-full text-left text-xs sm:text-sm">
                <thead className="bg-[#f8fafd] dark:bg-[#28292a] text-gray-500 dark:text-neutral-400 font-semibold sticky top-0 border-b border-gray-200 dark:border-neutral-800 z-10">
                  <tr>
                    <th className="px-5 py-3.5">兑换码 (点击复制)</th>
                    <th className="px-5 py-3.5">面额 (¥)</th>
                    <th className="px-5 py-3.5">兑换状态</th>
                    <th className="px-5 py-3.5">使用用户</th>
                    <th className="px-5 py-3.5">使用时间</th>
                    <th className="px-5 py-3.5">生成时间</th>
                    <th className="px-5 py-3.5 text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-neutral-800/80">
                  {redemptionCodes.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-center py-12 text-gray-400 text-xs">
                        暂无兑换码记录，点击上方按钮立即生成
                      </td>
                    </tr>
                  ) : (
                    redemptionCodes.map((item) => {
                      const isCopied = copiedCode === item.code;
                      return (
                        <tr key={item.id} className="hover:bg-gray-50/50 dark:hover:bg-neutral-800/40 transition">
                          <td className="px-5 py-4">
                            <button
                              type="button"
                              onClick={() => copyToClipboard(item.code, item.code)}
                              className="font-mono font-bold text-gray-800 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 flex items-center gap-1.5 cursor-pointer text-xs"
                              title="点击复制兑换码"
                            >
                              <span>{item.code}</span>
                              {isCopied ? (
                                <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                              ) : (
                                <Copy className="w-3.5 h-3.5 text-gray-400 shrink-0 opacity-70 group-hover:opacity-100" />
                              )}
                            </button>
                          </td>

                          <td className="px-5 py-4 font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                            ¥{item.amount.toFixed(2)}
                          </td>

                          <td className="px-5 py-4">
                            {item.status === 'active' ? (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                                未使用
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 dark:bg-neutral-800 text-gray-500 dark:text-neutral-400">
                                已使用
                              </span>
                            )}
                          </td>

                          <td className="px-5 py-4 text-gray-700 dark:text-neutral-300">
                            {item.used_by_username ? (
                              <span className="font-semibold text-xs">
                                {item.used_by_username} (UID: #{item.used_by_user_id})
                              </span>
                            ) : (
                              <span className="text-gray-400 dark:text-neutral-600">-</span>
                            )}
                          </td>

                          <td className="px-5 py-4 text-gray-400 dark:text-neutral-500 font-mono text-[11px]">
                            {item.used_at ? new Date(item.used_at).toLocaleString('zh-CN') : '-'}
                          </td>

                          <td className="px-5 py-4 text-gray-400 dark:text-neutral-500 font-mono text-[11px]">
                            {new Date(item.created_at).toLocaleString('zh-CN')}
                          </td>

                          <td className="px-5 py-4 text-right">
                            <button
                              type="button"
                              onClick={() => handleDeleteCode(item.id)}
                              className="p-1.5 text-gray-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-full transition cursor-pointer"
                              title="删除此兑换码"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ================= TAB 4: 全平台用量监控 ================= */}
      {adminTab === 'usage_stats' && (
        <div className="flex-1 min-h-0 bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800 rounded-3xl p-5 sm:p-7 overflow-y-auto shadow-2xs space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-gray-100 dark:border-neutral-800">
            <div>
              <h2 className="text-xl font-bold tracking-tight text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-blue-500" />
                <span>全平台 Token 与资费使用统计</span>
              </h2>
              <p className="text-xs sm:text-sm text-gray-500 dark:text-neutral-400 mt-1">
                实时聚合平台所有用户的 LLM API 请求、Tokens 消耗总量与峰谷资费走势
              </p>
            </div>

            <button
              type="button"
              onClick={fetchAdminUsage}
              className="px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800 rounded-xl hover:bg-blue-100 transition flex items-center gap-1.5 shrink-0 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${adminUsageLoading ? 'animate-spin' : ''}`} />
              <span>刷新统计</span>
            </button>
          </div>

          {adminUsageData?.summary && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-4 rounded-2xl bg-[#f8fafd] dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700/60">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">全平台总调用次数</div>
                <div className="text-2xl font-black font-mono text-gray-900 dark:text-gray-100 mt-1">
                  {adminUsageData.summary.totalRequests.toLocaleString()}
                </div>
              </div>

              <div className="p-4 rounded-2xl bg-[#f8fafd] dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700/60">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">全平台总消耗 Tokens</div>
                <div className="text-2xl font-black font-mono text-blue-600 dark:text-blue-400 mt-1">
                  {adminUsageData.summary.totalTokens.toLocaleString()}
                </div>
              </div>

              <div className="p-4 rounded-2xl bg-[#f8fafd] dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700/60">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">全平台总消耗折算 (¥)</div>
                <div className="text-2xl font-black font-mono text-emerald-600 dark:text-emerald-400 mt-1">
                  ¥{adminUsageData.summary.totalCostCny.toFixed(4)}
                </div>
              </div>

              <div className="p-4 rounded-2xl bg-[#f8fafd] dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700/60">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">全平台缓存命中率</div>
                <div className="text-2xl font-black font-mono text-amber-600 dark:text-amber-400 mt-1">
                  {adminUsageData.summary.cacheHitRate.toFixed(1)}%
                </div>
              </div>
            </div>
          )}

          {/* 走势图表 */}
          <div className="pt-2">
            <div className="font-semibold text-xs text-gray-800 dark:text-gray-200 mb-3">全平台每日资费消耗价格曲线</div>
            <CostCurveChart
              data={adminUsageData?.dailyHistory}
              loading={adminUsageLoading}
            />
          </div>
        </div>
      )}

      {/* ================= 充值弹窗 MODAL ================= */}
      {rechargeUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fadeIn">
          <div className="w-full max-w-sm bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800 rounded-3xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-neutral-800">
              <h3 className="text-base font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <Coins className="w-5 h-5 text-emerald-500" />
                <span>直接充值账户额度</span>
              </h3>
              <button
                type="button"
                onClick={() => setRechargeUser(null)}
                className="text-gray-400 hover:text-gray-600 text-lg leading-none cursor-pointer"
              >
                &times;
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3 rounded-xl bg-gray-50 dark:bg-[#28292a] flex items-center justify-between">
                <span className="text-gray-500 dark:text-neutral-400">充值目标用户</span>
                <span className="font-bold text-gray-900 dark:text-gray-100">{rechargeUser.username} (UID: #{rechargeUser.id})</span>
              </div>

              <div className="p-3 rounded-xl bg-gray-50 dark:bg-[#28292a] flex items-center justify-between">
                <span className="text-gray-500 dark:text-neutral-400">当前余额</span>
                <span className="font-mono font-bold text-blue-600 dark:text-blue-400">¥{(rechargeUser.balance || 0).toFixed(4)} 元</span>
              </div>

              <div className="space-y-1.5 pt-1">
                <label className="font-bold text-gray-800 dark:text-gray-200 block">充值金额 (元)</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-2.5 text-gray-400 text-sm font-bold">¥</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={rechargeAmount}
                    onChange={(e) => setRechargeAmount(e.target.value)}
                    className="w-full pl-8 pr-3.5 py-2.5 bg-white dark:bg-[#28292a] border border-gray-300 dark:border-neutral-700 rounded-xl font-mono text-sm font-bold text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                    placeholder="1.00"
                  />
                </div>

                {/* 快捷金额标签 */}
                <div className="flex gap-2 pt-1">
                  {['1.00', '5.00', '10.00', '50.00'].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setRechargeAmount(preset)}
                      className={`flex-1 py-1 rounded-lg border text-xs font-mono font-semibold transition cursor-pointer ${
                        rechargeAmount === preset
                          ? 'bg-emerald-50 dark:bg-emerald-950 border-emerald-500 text-emerald-700 dark:text-emerald-300'
                          : 'bg-white dark:bg-[#28292a] border-gray-200 dark:border-neutral-700 text-gray-600 dark:text-neutral-400 hover:border-gray-300'
                      }`}
                    >
                      +{preset}
                    </button>
                  ))}
                </div>
              </div>

              {rechargeMsg && (
                <div className={`p-2.5 rounded-xl border text-xs flex items-center gap-2 ${
                  rechargeMsg.success
                    ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 text-emerald-800 dark:text-emerald-300'
                    : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 text-rose-800 dark:text-rose-300'
                }`}>
                  {rechargeMsg.success ? <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> : <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />}
                  <span>{rechargeMsg.text}</span>
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setRechargeUser(null)}
                className="flex-1 py-2 bg-gray-100 dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700 text-gray-700 dark:text-neutral-300 rounded-xl text-xs font-medium transition cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleConfirmRecharge}
                disabled={recharging}
                className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl text-xs font-semibold shadow-xs transition cursor-pointer flex items-center justify-center gap-1.5"
              >
                {recharging ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Coins className="w-3.5 h-3.5" />}
                <span>{recharging ? '充值中...' : '确认直接充值'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= 批量生成兑换码 MODAL ================= */}
      {showGenModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-fadeIn">
          <div className="w-full max-w-md bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800 rounded-3xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-gray-100 dark:border-neutral-800">
              <h3 className="text-base font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <Ticket className="w-5 h-5 text-blue-500" />
                <span>批量生成充值兑换码</span>
              </h3>
              <button
                type="button"
                onClick={() => setShowGenModal(false)}
                className="text-gray-400 hover:text-gray-600 text-lg leading-none cursor-pointer"
              >
                &times;
              </button>
            </div>

            <div className="space-y-3.5 text-xs">
              <div className="space-y-1.5">
                <label className="font-bold text-gray-800 dark:text-gray-200 block">单张面额 (元)</label>
                <div className="relative">
                  <span className="absolute left-3.5 top-2.5 text-gray-400 text-sm font-bold">¥</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    value={genAmount}
                    onChange={(e) => setGenAmount(e.target.value)}
                    className="w-full pl-8 pr-3.5 py-2.5 bg-white dark:bg-[#28292a] border border-gray-300 dark:border-neutral-700 rounded-xl font-mono text-sm font-bold text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    placeholder="1.00"
                  />
                </div>
                <div className="flex gap-2 pt-1">
                  {['1.00', '2.00', '5.00', '10.00'].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setGenAmount(preset)}
                      className={`flex-1 py-1 rounded-lg border text-xs font-mono font-semibold transition cursor-pointer ${
                        genAmount === preset
                          ? 'bg-blue-50 dark:bg-blue-950 border-blue-500 text-blue-700 dark:text-blue-300'
                          : 'bg-white dark:bg-[#28292a] border-gray-200 dark:border-neutral-700 text-gray-600 dark:text-neutral-400'
                      }`}
                    >
                      ¥{preset}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="font-bold text-gray-800 dark:text-gray-200 block">生成张数 (1 ~ 50)</label>
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={genCount}
                  onChange={(e) => setGenCount(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-full px-3.5 py-2.5 bg-white dark:bg-[#28292a] border border-gray-300 dark:border-neutral-700 rounded-xl font-mono text-sm font-bold text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                />
              </div>

              {newlyGenerated.length > 0 && (
                <div className="space-y-2 pt-2 border-t border-gray-100 dark:border-neutral-800">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                      成功生成 {newlyGenerated.length} 张卡密：
                    </span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(newlyGenerated.join('\n'), 'all_generated')}
                      className="text-xs text-blue-600 dark:text-blue-400 font-medium flex items-center gap-1 hover:underline cursor-pointer"
                    >
                      {copiedCode === 'all_generated' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedCode === 'all_generated' ? '已全部复制' : '一键全部复制'}</span>
                    </button>
                  </div>
                  <div className="max-h-40 overflow-y-auto p-2.5 rounded-xl bg-gray-50 dark:bg-[#28292a] font-mono text-xs text-gray-800 dark:text-gray-200 space-y-1 border border-gray-200 dark:border-neutral-700">
                    {newlyGenerated.map((code) => (
                      <div key={code} className="flex items-center justify-between py-0.5">
                        <span>{code}</span>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(code, code)}
                          className="text-gray-400 hover:text-blue-600 cursor-pointer"
                        >
                          {copiedCode === code ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowGenModal(false)}
                className="flex-1 py-2 bg-gray-100 dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700 text-gray-700 dark:text-neutral-300 rounded-xl text-xs font-medium transition cursor-pointer"
              >
                {newlyGenerated.length > 0 ? '完成关闭' : '取消'}
              </button>
              <button
                type="button"
                onClick={handleGenerateCodes}
                disabled={generatingCodes}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl text-xs font-semibold shadow-xs transition cursor-pointer flex items-center justify-center gap-1.5"
              >
                {generatingCodes ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                <span>{generatingCodes ? '正在生成...' : '立即批量生成'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
