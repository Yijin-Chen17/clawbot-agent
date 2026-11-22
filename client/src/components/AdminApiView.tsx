import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { CostCurveChart } from './CostCurveChart';
import {
  Coins,
  Globe,
  Sparkles,
  Ticket,
  BarChart3,
  Copy,
  RefreshCw,
  Plus,
  Check,
  AlertCircle,
  Trash2,
  CheckCircle2,
  UserCheck,
  ShieldCheck,
  Layers,
  Info,
} from 'lucide-react';

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

export const AdminApiView: React.FC = () => {
  // Tab: 'overview_recharge' | 'global_api' | 'redemption' | 'usage'
  const [activeTab, setActiveTab] = useState<'recharge' | 'global_api' | 'redemption' | 'usage'>('recharge');

  // ================= 1. 直接输入用户名充值 =================
  const [targetUsername, setTargetUsername] = useState('');
  const [rechargeAmount, setRechargeAmount] = useState('1.00');
  const [recharging, setRecharging] = useState(false);
  const [rechargeResult, setRechargeResult] = useState<{ success: boolean; msg: string } | null>(null);

  const handleDirectRecharge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetUsername.trim()) {
      alert('请输入要充值的用户名');
      return;
    }
    const amt = parseFloat(rechargeAmount);
    if (isNaN(amt) || amt <= 0) {
      alert('请输入大于 0 的有效充值金额');
      return;
    }

    setRecharging(true);
    setRechargeResult(null);
    try {
      const res = await api.post('/admin/users/recharge', {
        username: targetUsername.trim(),
        amount: amt,
      });
      setRechargeResult({
        success: true,
        msg: res.data.message || `成功为用户「${targetUsername.trim()}」充值 ¥${amt.toFixed(2)}！当前余额：¥${Number(res.data.newBalance || 0).toFixed(4)}`,
      });
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } }; message?: string };
      setRechargeResult({
        success: false,
        msg: error.response?.data?.error || error.message || '充值失败，请检查用户名是否存在',
      });
    } finally {
      setRecharging(false);
    }
  };

  // ================= 2. 全局官方 API 配置 =================
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
    fetchGlobalLlm();
  }, []);

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

  // ================= 3. 兑换码管理 =================
  const [redemptionCodes, setRedemptionCodes] = useState<RedemptionCodeItem[]>([]);
  const [redemptionSummary, setRedemptionSummary] = useState<RedemptionSummary | null>(null);
  const [redemptionLoading, setRedemptionLoading] = useState(false);

  // 批量生成兑换码弹窗
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
    if (activeTab === 'redemption') {
      fetchRedemptionCodes();
    }
  }, [activeTab]);

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

  // ================= 4. 全平台用量监控 =================
  const [adminUsageLoading, setAdminUsageLoading] = useState(false);
  const [usageScope, setUsageScope] = useState<'official' | 'all'>('official');
  const [adminUsageData, setAdminUsageData] = useState<{
    scope?: 'official' | 'all';
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
    recentLogs?: Array<{
      id: number;
      user_id?: number;
      username?: string;
      model: string;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      cache_hit_tokens: number;
      cache_miss_tokens: number;
      is_peak: number;
      cost_cny: number;
      input_cost_cny: number;
      output_cost_cny: number;
      request_type: string;
      is_official?: number;
      created_at: string;
    }>;
  } | null>(null);

  const fetchAdminUsage = async (scope: 'official' | 'all' = usageScope) => {
    setAdminUsageLoading(true);
    try {
      const res = await api.get(`/admin/usage-stats?scope=${scope}`);
      setAdminUsageData(res.data);
    } catch (err) {
      console.error('获取全平台用量失败:', err);
    } finally {
      setAdminUsageLoading(false);
    }
  };

  const handleScopeChange = (newScope: 'official' | 'all') => {
    setUsageScope(newScope);
    fetchAdminUsage(newScope);
  };

  useEffect(() => {
    if (activeTab === 'usage') {
      fetchAdminUsage(usageScope);
    }
  }, [activeTab]);

  return (
    <div className="w-full max-w-5xl mx-auto flex-1 min-h-0 flex flex-col space-y-4 overflow-hidden">
      {/* 顶部主切换栏 */}
      <div className="shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-200 dark:border-neutral-800 pb-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <Coins className="w-6 h-6 text-blue-500" />
            <span>API 与额度管理中心</span>
          </h2>
          <p className="text-xs sm:text-sm text-gray-500 dark:text-neutral-400 mt-0.5">
            直接为指定用户充值、统一配置全局官方接口、批量生成卡密并监控全平台用量
          </p>
        </div>

        {/* 子视图切换胶囊 */}
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
          <button
            type="button"
            onClick={() => setActiveTab('recharge')}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
              activeTab === 'recharge'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'bg-white dark:bg-[#1e1f20] text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 border border-gray-200 dark:border-neutral-700/80'
            }`}
          >
            <UserCheck className="w-3.5 h-3.5" />
            <span>输入用户名充值</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('global_api')}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
              activeTab === 'global_api'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'bg-white dark:bg-[#1e1f20] text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 border border-gray-200 dark:border-neutral-700/80'
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>全局官方 API</span>
            {globalHasKey && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('redemption')}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
              activeTab === 'redemption'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'bg-white dark:bg-[#1e1f20] text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 border border-gray-200 dark:border-neutral-700/80'
            }`}
          >
            <Ticket className="w-3.5 h-3.5" />
            <span>兑换码管理</span>
            {redemptionSummary && redemptionSummary.activeCount > 0 && (
              <span className="bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 text-[10px] px-1.5 py-0.2 rounded-full font-bold">
                {redemptionSummary.activeCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('usage')}
            className={`px-3.5 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
              activeTab === 'usage'
                ? 'bg-blue-600 text-white shadow-xs'
                : 'bg-white dark:bg-[#1e1f20] text-gray-700 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 border border-gray-200 dark:border-neutral-700/80'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            <span>全平台用量</span>
          </button>
        </div>
      </div>

      {/* ================= VIEW 1: 输入用户名充值 ================= */}
      {activeTab === 'recharge' && (
        <div className="flex-1 min-h-0 bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800 rounded-3xl p-5 sm:p-7 overflow-y-auto shadow-2xs space-y-6">
          <div className="pb-4 border-b border-gray-100 dark:border-neutral-800">
            <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <Coins className="w-5 h-5 text-emerald-500" />
              <span>用户额度直接充值</span>
            </h3>
            <p className="text-xs sm:text-sm text-gray-500 dark:text-neutral-400 mt-1">
              在此直接输入任意注册用户名及充值金额，即可向该用户的官方接口账户划拨可用额度。
            </p>
          </div>

          <form onSubmit={handleDirectRecharge} className="space-y-5 text-xs max-w-xl">
            {/* 目标用户名 */}
            <div className="space-y-1.5">
              <label className="font-bold text-gray-800 dark:text-gray-200 uppercase tracking-wider block">
                充值目标用户名
              </label>
              <input
                type="text"
                value={targetUsername}
                onChange={(e) => setTargetUsername(e.target.value)}
                placeholder="请输入用户名，例如：admin、alice"
                className="w-full px-3.5 py-2.5 bg-white dark:bg-[#28292a] border border-gray-300 dark:border-neutral-700 rounded-xl font-mono text-gray-900 dark:text-gray-100 text-xs outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
              <span className="text-[11px] text-gray-400 dark:text-neutral-500 block">
                不区分大小写，充值成功后立即入账到该用户账户余额
              </span>
            </div>

            {/* 充值金额 */}
            <div className="space-y-1.5">
              <label className="font-bold text-gray-800 dark:text-gray-200 uppercase tracking-wider block">
                充值金额 (元)
              </label>
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
                {['1.00', '5.00', '10.00', '50.00', '100.00'].map((preset) => (
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

            {/* 提交按钮 */}
            <div className="pt-2">
              <button
                type="submit"
                disabled={recharging || !targetUsername.trim()}
                className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl text-xs font-semibold shadow-xs transition cursor-pointer flex items-center gap-2"
              >
                {recharging ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Coins className="w-4 h-4" />}
                <span>{recharging ? '正在入账充值...' : '确认直接充值'}</span>
              </button>
            </div>

            {/* 结果提示 */}
            {rechargeResult && (
              <div className={`p-3.5 rounded-xl border text-xs flex items-center gap-2 animate-fadeIn ${
                rechargeResult.success
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 text-emerald-800 dark:text-emerald-300'
                  : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 text-rose-800 dark:text-rose-300'
              }`}>
                {rechargeResult.success ? <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> : <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />}
                <span>{rechargeResult.msg}</span>
              </div>
            )}
          </form>
        </div>
      )}

      {/* ================= VIEW 2: 全局官方 API 设置 ================= */}
      {activeTab === 'global_api' && (
        <div className="flex-1 min-h-0 bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800 rounded-3xl p-5 sm:p-7 overflow-y-auto shadow-2xs space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-gray-100 dark:border-neutral-800">
            <div>
              <h3 className="text-lg font-bold tracking-tight text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <Globe className="w-5 h-5 text-blue-500" />
                <span>全局官方 API 设置</span>
              </h3>
              <p className="text-xs sm:text-sm text-gray-500 dark:text-neutral-400 mt-1 leading-relaxed">
                配置供全平台用户共享调用的官方大模型接口。选用官方接口的用户将统一由本配置提供算力支撑，并按实际 Token 折算扣除该用户账户额度。
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
                默认推荐官方端点或兼容 OpenAI 格式的标准 API 反代服务
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
                安全加密存储于 system_settings 数据库中，留空则保持当前配置不变
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
                推荐 deepseek-chat 或兼容 OpenAI 标准的语言模型型号
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

      {/* ================= VIEW 3: 兑换码管理 ================= */}
      {activeTab === 'redemption' && (
        <div className="flex-1 min-h-0 flex flex-col space-y-4">
          <div className="shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-bold tracking-tight text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <Ticket className="w-5 h-5 text-blue-500" />
                <span>兑换码生成与管理</span>
              </h3>
              <p className="text-xs sm:text-sm text-gray-500 dark:text-neutral-400 mt-0.5">
                支持批量生成指定限额的充值卡密，用户在个人设置中兑换即可增加账户额度
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

          {/* 表格 */}
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

      {/* ================= VIEW 4: 全平台用量监控 ================= */}
      {activeTab === 'usage' && (
        <div className="flex-1 min-h-0 bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800 rounded-3xl p-5 sm:p-7 overflow-y-auto shadow-2xs space-y-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-4 border-b border-gray-100 dark:border-neutral-800">
            <div>
              <h3 className="text-lg font-bold tracking-tight text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-blue-500" />
                <span>全平台 Token 与资费使用统计</span>
              </h3>
              <p className="text-xs sm:text-sm text-gray-500 dark:text-neutral-400 mt-1">
                实时聚合平台所有用户的 LLM API 请求、Tokens 消耗总量与峰谷资费走势
              </p>
            </div>

            <div className="flex items-center flex-wrap gap-2">
              {/* 统计范围切换按钮组 */}
              <div className="inline-flex p-1 bg-gray-100 dark:bg-neutral-800/80 rounded-2xl border border-gray-200/60 dark:border-neutral-700/60 text-xs">
                <button
                  type="button"
                  onClick={() => handleScopeChange('official')}
                  className={`px-3 py-1.5 rounded-xl font-medium transition flex items-center gap-1.5 cursor-pointer ${
                    usageScope === 'official'
                      ? 'bg-blue-600 text-white shadow-xs'
                      : 'text-gray-600 dark:text-neutral-400 hover:text-gray-900 dark:hover:text-gray-200'
                  }`}
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>官方全局 API 消耗</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleScopeChange('all')}
                  className={`px-3 py-1.5 rounded-xl font-medium transition flex items-center gap-1.5 cursor-pointer ${
                    usageScope === 'all'
                      ? 'bg-purple-600 text-white shadow-xs'
                      : 'text-gray-600 dark:text-neutral-400 hover:text-gray-900 dark:hover:text-gray-200'
                  }`}
                >
                  <Layers className="w-3.5 h-3.5" />
                  <span>全平台总计 (含个人Key)</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => fetchAdminUsage(usageScope)}
                className="px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800 rounded-xl hover:bg-blue-100 transition flex items-center gap-1.5 shrink-0 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${adminUsageLoading ? 'animate-spin' : ''}`} />
                <span>刷新</span>
              </button>
            </div>
          </div>

          {/* 统计范围说明横幅 */}
          <div
            className={`p-3.5 rounded-2xl border text-xs flex items-start gap-2.5 ${
              usageScope === 'official'
                ? 'bg-blue-50/70 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900/50 text-blue-800 dark:text-blue-300'
                : 'bg-purple-50/70 dark:bg-purple-950/30 border-purple-200 dark:border-purple-900/50 text-purple-800 dark:text-purple-300'
            }`}
          >
            <Info className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              {usageScope === 'official' ? (
                <span>
                  <strong>当前统计范围：官方全局 API</strong> ——
                  仅统计由系统官方统筹承载并扣除平台全局额度的真实调用，已严格隔离排除用户自带的个人私有 API Key 用量。
                </span>
              ) : (
                <span>
                  <strong>当前统计范围：全平台总计 (含个人私有 Key)</strong> ——
                  统计平台产生的所有 LLM 请求（包括用户配置的个人私有 Key 与官方全局接口），供管理员全面监控平台的调用频次与吞吐。
                </span>
              )}
            </div>
          </div>

          {adminUsageData?.summary && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-4 rounded-2xl bg-[#f8fafd] dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700/60">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">
                  {usageScope === 'official' ? '官方接口调用次数' : '全平台总调用次数'}
                </div>
                <div className="text-2xl font-black font-mono text-gray-900 dark:text-gray-100 mt-1">
                  {adminUsageData.summary.totalRequests.toLocaleString()}
                </div>
              </div>

              <div className="p-4 rounded-2xl bg-[#f8fafd] dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700/60">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">
                  {usageScope === 'official' ? '官方总消耗 Tokens' : '全平台总消耗 Tokens'}
                </div>
                <div className="text-2xl font-black font-mono text-blue-600 dark:text-blue-400 mt-1">
                  {adminUsageData.summary.totalTokens.toLocaleString()}
                </div>
              </div>

              <div className="p-4 rounded-2xl bg-[#f8fafd] dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700/60">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">
                  {usageScope === 'official' ? '官方总消耗折算 (¥)' : '全平台总消耗折算 (¥)'}
                </div>
                <div className="text-2xl font-black font-mono text-emerald-600 dark:text-emerald-400 mt-1">
                  ¥{adminUsageData.summary.totalCostCny.toFixed(4)}
                </div>
              </div>

              <div className="p-4 rounded-2xl bg-[#f8fafd] dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700/60">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">缓存命中率</div>
                <div className="text-2xl font-black font-mono text-amber-600 dark:text-amber-400 mt-1">
                  {adminUsageData.summary.cacheHitRate.toFixed(1)}%
                </div>
              </div>
            </div>
          )}

          {/* 走势图表 */}
          <div className="pt-2">
            <div className="font-semibold text-xs text-gray-800 dark:text-gray-200 mb-3">
              {usageScope === 'official'
                ? '官方全局 API 每日资费消耗价格曲线'
                : '全平台每日资费消耗价格曲线 (含个人私有 Key)'}
            </div>
            <CostCurveChart
              data={adminUsageData?.dailyHistory}
              loading={adminUsageLoading}
            />
          </div>

          {/* 最近调用明细记录 */}
          {adminUsageData?.recentLogs && adminUsageData.recentLogs.length > 0 && (
            <div className="pt-4 border-t border-gray-100 dark:border-neutral-800">
              <div className="font-semibold text-xs text-gray-800 dark:text-gray-200 mb-3 flex items-center justify-between">
                <span>最近调用明细记录</span>
                <span className="text-[11px] font-normal text-gray-400">仅展示最近 15 条</span>
              </div>
              <div className="overflow-x-auto border border-gray-200 dark:border-neutral-800 rounded-2xl">
                <table className="w-full text-left text-xs">
                  <thead className="bg-gray-50 dark:bg-neutral-800/60 text-gray-500 dark:text-neutral-400 font-medium border-b border-gray-200 dark:border-neutral-800">
                    <tr>
                      <th className="py-2.5 px-3">时间</th>
                      <th className="py-2.5 px-3">用户</th>
                      <th className="py-2.5 px-3">接口类型</th>
                      <th className="py-2.5 px-3">模型</th>
                      <th className="py-2.5 px-3">场景</th>
                      <th className="py-2.5 px-3">Tokens (总/命中)</th>
                      <th className="py-2.5 px-3">折算金额</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-neutral-800/60 text-gray-700 dark:text-gray-300">
                    {adminUsageData.recentLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-gray-50/50 dark:hover:bg-neutral-800/40">
                        <td className="py-2.5 px-3 font-mono text-[11px] text-gray-500">
                          {log.created_at}
                        </td>
                        <td className="py-2.5 px-3 font-medium">
                          {log.username || `UID: ${log.user_id}`}
                        </td>
                        <td className="py-2.5 px-3">
                          {log.is_official === 1 ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300">
                              官方全局
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
                              个人私有 Key
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-[11px] text-gray-500">
                          {log.model}
                        </td>
                        <td className="py-2.5 px-3 text-[11px]">
                          {log.request_type === 'weixin_chat'
                            ? '微信交互'
                            : log.request_type === 'key_test'
                            ? '私有Key测试'
                            : log.request_type === 'global_key_test'
                            ? '全局Key测试'
                            : log.request_type}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-[11px]">
                          <span>{log.total_tokens.toLocaleString()}</span>
                          {log.cache_hit_tokens > 0 && (
                            <span className="text-emerald-500 ml-1">
                              (命中 {log.cache_hit_tokens})
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">
                          ¥{log.cost_cny.toFixed(6)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
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
