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
  Zap,
  Calculator,
  Clock,
  Server,
  ArrowRightLeft,
} from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

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
  const { t, language } = useTheme();
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
      alert(language === 'en' ? 'Please enter a target username' : '请输入要充值的用户名');
      return;
    }
    const amt = parseFloat(rechargeAmount);
    if (isNaN(amt) || amt <= 0) {
      alert(t('admin.recharge_amount_invalid', '请输入大于 0 的有效充值金额'));
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
        msg: res.data.message || (language === 'en'
          ? `Successfully recharged ¥${amt.toFixed(2)} for user "${targetUsername.trim()}"! Current balance: ¥${Number(res.data.newBalance || 0).toFixed(4)}`
          : `成功为用户「${targetUsername.trim()}」充值 ¥${amt.toFixed(2)}！当前余额：¥${Number(res.data.newBalance || 0).toFixed(4)}`),
      });
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } }; message?: string };
      setRechargeResult({
        success: false,
        msg: error.response?.data?.error || error.message || (language === 'en' ? 'Recharge failed, please check username' : '充值失败，请检查用户名是否存在'),
      });
    } finally {
      setRecharging(false);
    }
  };

  // ================= 2. 全局官方 API 配置 (主节点 API 1 + 备用节点 API 2) =================
  // API 1 (主节点)
  const [globalEndpoint, setGlobalEndpoint] = useState('https://api.deepseek.com/v1');
  const [globalApiKey, setGlobalApiKey] = useState('');
  const [globalApiKeyMasked, setGlobalApiKeyMasked] = useState('');
  const [globalModel, setGlobalModel] = useState('deepseek-chat');
  const [globalHasKey, setGlobalHasKey] = useState(false);
  const [globalTesting, setGlobalTesting] = useState(false);
  const [globalTestResult, setGlobalTestResult] = useState<{ success: boolean; msg: string } | null>(null);

  // API 2 (备用节点)
  const [backupEnabled, setBackupEnabled] = useState(false);
  const [backupEndpoint, setBackupEndpoint] = useState('https://api.deepseek.com/v1');
  const [backupApiKey, setBackupApiKey] = useState('');
  const [backupApiKeyMasked, setBackupApiKeyMasked] = useState('');
  const [backupModel, setBackupModel] = useState('deepseek-chat');
  const [backupHasKey, setBackupHasKey] = useState(false);
  const [backupTesting, setBackupTesting] = useState(false);
  const [backupTestResult, setBackupTestResult] = useState<{ success: boolean; msg: string } | null>(null);

  // 模型计费价格
  const [globalPriceInput, setGlobalPriceInput] = useState('2.0');
  const [globalPriceOutput, setGlobalPriceOutput] = useState('8.0');
  const [globalPriceCacheHit, setGlobalPriceCacheHit] = useState('0.5');

  const [globalSaving, setGlobalSaving] = useState(false);
  const [globalSaveSuccess, setGlobalSaveSuccess] = useState(false);

  const fetchGlobalLlm = async () => {
    try {
      const res = await api.get('/admin/global-llm');
      // API 1
      const api1 = res.data.api1 || {};
      setGlobalEndpoint(api1.endpoint || res.data.endpoint || 'https://api.deepseek.com/v1');
      setGlobalModel(api1.model || res.data.model || 'deepseek-chat');
      setGlobalApiKeyMasked(api1.apiKeyMasked || res.data.apiKeyMasked || '');
      setGlobalHasKey(Boolean(api1.hasKey ?? res.data.hasKey));

      // API 2
      const api2 = res.data.api2 || {};
      setBackupEndpoint(api2.endpoint || 'https://api.deepseek.com/v1');
      setBackupModel(api2.model || api1.model || 'deepseek-chat');
      setBackupApiKeyMasked(api2.apiKeyMasked || '');
      setBackupHasKey(Boolean(api2.hasKey));
      setBackupEnabled(Boolean(api2.enabled));

      // 价格
      const pricing = res.data.pricing || {};
      if (pricing.priceInput !== undefined || res.data.priceInput !== undefined) {
        setGlobalPriceInput(String(pricing.priceInput ?? res.data.priceInput));
      }
      if (pricing.priceOutput !== undefined || res.data.priceOutput !== undefined) {
        setGlobalPriceOutput(String(pricing.priceOutput ?? res.data.priceOutput));
      }
      if (pricing.priceCacheHit !== undefined || res.data.priceCacheHit !== undefined) {
        setGlobalPriceCacheHit(String(pricing.priceCacheHit ?? res.data.priceCacheHit));
      }
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
        api1: {
          endpoint: globalEndpoint,
          apiKey: globalApiKey || undefined,
          model: globalModel,
        },
        api2: {
          endpoint: backupEndpoint,
          apiKey: backupApiKey || undefined,
          model: backupModel,
          enabled: backupEnabled,
        },
        pricing: {
          priceInput: parseFloat(globalPriceInput) || 0,
          priceOutput: parseFloat(globalPriceOutput) || 0,
          priceCacheHit: parseFloat(globalPriceCacheHit) || 0,
        },
      });
      setGlobalSaveSuccess(true);
      setGlobalApiKey('');
      setBackupApiKey('');
      fetchGlobalLlm();
      setTimeout(() => setGlobalSaveSuccess(false), 3000);
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } }; message?: string };
      alert((language === 'en' ? 'Save failed: ' : '保存失败: ') + (error.response?.data?.error || error.message));
    } finally {
      setGlobalSaving(false);
    }
  };

  const handleTestGlobalLlm = async (node: 'api1' | 'api2' = 'api1') => {
    if (node === 'api1') {
      setGlobalTesting(true);
      setGlobalTestResult(null);
      try {
        const res = await api.post('/admin/global-llm/test', {
          node: 'api1',
          endpoint: globalEndpoint,
          api_key: globalApiKey || undefined,
          model: globalModel,
        });
        setGlobalTestResult({ success: true, msg: res.data.message || (language === 'en' ? 'Primary node (API 1) connection test successful!' : '主节点 (API 1) 连通性测试成功！') });
      } catch (err: unknown) {
        const error = err as { response?: { data?: { error?: string } }; message?: string };
        setGlobalTestResult({ success: false, msg: error.response?.data?.error || error.message || (language === 'en' ? 'Test failed' : '测试失败') });
      } finally {
        setGlobalTesting(false);
      }
    } else {
      setBackupTesting(true);
      setBackupTestResult(null);
      try {
        const res = await api.post('/admin/global-llm/test', {
          node: 'api2',
          endpoint: backupEndpoint,
          api_key: backupApiKey || undefined,
          model: backupModel,
        });
        setBackupTestResult({ success: true, msg: res.data.message || (language === 'en' ? 'Backup node (API 2) connection test successful!' : '备用节点 (API 2) 连通性测试成功！') });
      } catch (err: unknown) {
        const error = err as { response?: { data?: { error?: string } }; message?: string };
        setBackupTestResult({ success: false, msg: error.response?.data?.error || error.message || (language === 'en' ? 'Test failed' : '测试失败') });
      } finally {
        setBackupTesting(false);
      }
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
      alert(language === 'en' ? 'Please enter a valid amount greater than 0' : '请输入大于 0 的有效面额');
      return;
    }
    const countNum = parseInt(String(genCount), 10);
    if (isNaN(countNum) || countNum < 1 || countNum > 50) {
      alert(language === 'en' ? 'Quantity must be between 1 and 50' : '单次生成数量支持 1 ~ 50 张');
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
      alert((language === 'en' ? 'Generation failed: ' : '生成失败: ') + (error.response?.data?.error || error.message));
    } finally {
      setGeneratingCodes(false);
    }
  };

  const handleDeleteCode = async (id: number) => {
    if (!window.confirm(t('admin.delete_code_confirm', '确定要删除该兑换码吗？删除后将不可兑换。'))) return;
    try {
      await api.delete(`/admin/redemption-codes/${id}`);
      fetchRedemptionCodes();
    } catch (err: unknown) {
      const error = err as { response?: { data?: { error?: string } } };
      alert(error.response?.data?.error || (language === 'en' ? 'Delete failed' : '删除失败'));
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
            <span>{t('admin.api_title', 'API 与额度管理中心')}</span>
          </h2>
          <p className="text-xs sm:text-sm text-gray-500 dark:text-neutral-400 mt-0.5">
            {t('admin.api_subtitle', '直接为指定用户充值、统一配置全局官方接口、批量生成卡密并监控全平台用量')}
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
            <span>{t('admin.tab_recharge', '输入用户名充值')}</span>
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
            <span>{t('admin.tab_global_api', '全局官方 API')}</span>
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
            <span>{t('admin.tab_redemption', '兑换码管理')}</span>
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
            <span>{t('admin.tab_usage', '全平台用量')}</span>
          </button>
        </div>
      </div>

      {/* ================= VIEW 1: 输入用户名充值 ================= */}
      {activeTab === 'recharge' && (
        <div className="flex-1 min-h-0 bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800 rounded-3xl p-5 sm:p-7 overflow-y-auto shadow-2xs space-y-6">
          <div className="pb-4 border-b border-gray-100 dark:border-neutral-800">
            <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <Coins className="w-5 h-5 text-emerald-500" />
              <span>{t('admin.recharge_section_title', '用户额度直接充值')}</span>
            </h3>
            <p className="text-xs sm:text-sm text-gray-500 dark:text-neutral-400 mt-1">
              {t('admin.recharge_section_desc', '在此直接输入任意注册用户名及充值金额，即可向该用户的官方接口账户划拨可用额度。')}
            </p>
          </div>

          <form onSubmit={handleDirectRecharge} className="space-y-5 text-xs max-w-xl">
            {/* 目标用户名 */}
            <div className="space-y-1.5">
              <label className="font-bold text-gray-800 dark:text-gray-200 uppercase tracking-wider block">
                {t('admin.recharge_user_label', '充值目标用户名')}
              </label>
              <input
                type="text"
                value={targetUsername}
                onChange={(e) => setTargetUsername(e.target.value)}
                placeholder={t('admin.recharge_user_placeholder', '请输入用户名，例如：admin、alice')}
                className="w-full px-3.5 py-2.5 bg-white dark:bg-[#28292a] border border-gray-300 dark:border-neutral-700 rounded-xl font-mono text-gray-900 dark:text-gray-100 text-xs outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
              <span className="text-[11px] text-gray-400 dark:text-neutral-500 block">
                {t('admin.recharge_user_tip', '不区分大小写，充值成功后立即入账到该用户账户余额')}
              </span>
            </div>

            {/* 充值金额 */}
            <div className="space-y-1.5">
              <label className="font-bold text-gray-800 dark:text-gray-200 uppercase tracking-wider block">
                {t('admin.recharge_amount', '充值金额 (元)')}
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
                <span>{recharging ? t('admin.recharging', '正在入账充值...') : t('admin.recharge_confirm_btn', '确认直接充值')}</span>
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

      {/* ================= VIEW 2: 全局官方 API 设置 (双通道故障自动切换) ================= */}
      {activeTab === 'global_api' && (
        <div className="flex-1 min-h-0 bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800 rounded-3xl p-5 sm:p-7 overflow-y-auto shadow-2xs space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-gray-100 dark:border-neutral-800">
            <div>
              <h3 className="text-lg font-bold tracking-tight text-gray-900 dark:text-gray-100 flex items-center gap-2">
                <Globe className="w-5 h-5 text-blue-500" />
                <span>{t('admin.global_api_header', '全局官方 API 设置 (双通道智能重连与故障转移)')}</span>
              </h3>
              <p className="text-xs sm:text-sm text-gray-500 dark:text-neutral-400 mt-1 leading-relaxed">
                {t('admin.global_api_desc', '配置供全平台用户共享调用的官方大模型接口。支持配置主节点与容灾备用节点，API 1 请求遇超时或异常时自动无感切换至 API 2 重试。配置独立持久化保存，重启绝不丢失。')}
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              {globalHasKey ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 dark:bg-emerald-950/70 text-emerald-700 dark:text-emerald-300">
                  <span className="w-2 h-2 rounded-full bg-emerald-500" />
                  {t('admin.api1_status_ready', 'API 1: 已就绪')}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-100 dark:bg-amber-950/70 text-amber-700 dark:text-amber-300">
                  <span className="w-2 h-2 rounded-full bg-amber-500" />
                  {t('admin.api1_status_pending', 'API 1: 待配置')}
                </span>
              )}

              {backupEnabled ? (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-100 dark:bg-blue-950/70 text-blue-700 dark:text-blue-300">
                  <span className="w-2 h-2 rounded-full bg-blue-500" />
                  {t('admin.api2_status_enabled', 'API 2: 容灾启用')}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-gray-100 dark:bg-neutral-800 text-gray-500 dark:text-neutral-400">
                  <span className="w-2 h-2 rounded-full bg-gray-400" />
                  {t('admin.api2_status_disabled', 'API 2: 未启用')}
                </span>
              )}
            </div>
          </div>

          <div className="space-y-6 text-xs max-w-3xl">
            {/* 卡片 1: API 1 (主用通道 / Primary) */}
            <div className="p-5 rounded-2xl bg-gray-50/70 dark:bg-[#252627] border border-gray-200 dark:border-neutral-700/80 space-y-4">
              <div className="flex items-center justify-between pb-2 border-b border-gray-200/60 dark:border-neutral-700/60">
                <div className="flex items-center gap-2 font-bold text-sm text-gray-900 dark:text-gray-100">
                  <Server className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  <span>{t('admin.api1_title', 'API 1 (主用通道 / Primary)')}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 font-semibold">
                    {t('admin.api1_desc', '首选用量节点')}
                  </span>
                </div>
                {globalHasKey && (
                  <span className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    {t('admin.key_configured', '已配置密钥')}
                  </span>
                )}
              </div>

              <div className="space-y-4">
                {/* Endpoint */}
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-gray-800 dark:text-gray-200 uppercase tracking-wider block">
                    {t('admin.api_endpoint', '主端点 (Base URL)')}
                  </label>
                  <input
                    type="text"
                    value={globalEndpoint}
                    onChange={(e) => setGlobalEndpoint(e.target.value)}
                    placeholder="https://api.deepseek.com/v1"
                    className="w-full px-3.5 py-2.5 bg-white dark:bg-[#1e1f20] border border-gray-300 dark:border-neutral-700 rounded-xl font-mono text-gray-800 dark:text-gray-100 outline-none transition focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  />
                  <span className="text-[11px] text-gray-400 dark:text-neutral-500 block">
                    {t('admin.api_endpoint_desc', '官方端点或兼容 OpenAI 格式的反代地址 (超时阈值: 18秒)')}
                  </span>
                </div>

                {/* API Key */}
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-gray-800 dark:text-gray-200 uppercase tracking-wider block">
                    {t('admin.api_key', '主 API 密钥 (API Key)')}
                  </label>
                  <input
                    type="password"
                    value={globalApiKey}
                    onChange={(e) => setGlobalApiKey(e.target.value)}
                    placeholder={globalApiKeyMasked ? `${language === 'en' ? 'Configured: ' : '已配置: '}${globalApiKeyMasked}` : 'sk-xxxxxxxxxxxxxxxxxxxxxxxx'}
                    className="w-full px-3.5 py-2.5 bg-white dark:bg-[#1e1f20] border border-gray-300 dark:border-neutral-700 rounded-xl font-mono text-gray-800 dark:text-gray-100 outline-none transition focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  />
                  <span className="text-[11px] text-gray-400 dark:text-neutral-500 block">
                    {t('admin.api_key_tip', '独立持久化存储于服务器端，留空则保持当前配置密钥不变')}
                  </span>
                </div>

                {/* Model */}
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-gray-800 dark:text-gray-200 uppercase tracking-wider block">
                    {t('admin.api_model', '主模型型号 (Model)')}
                  </label>
                  <input
                    type="text"
                    value={globalModel}
                    onChange={(e) => setGlobalModel(e.target.value)}
                    placeholder="deepseek-chat"
                    className="w-full px-3.5 py-2.5 bg-white dark:bg-[#1e1f20] border border-gray-300 dark:border-neutral-700 rounded-xl font-mono text-gray-800 dark:text-gray-100 outline-none transition focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                  />
                </div>

                {/* Test button & result for API 1 */}
                <div className="pt-1 flex flex-col sm:flex-row sm:items-center gap-3">
                  <button
                    type="button"
                    onClick={() => handleTestGlobalLlm('api1')}
                    disabled={globalTesting}
                    className="flex items-center gap-1.5 px-4 py-2 bg-white dark:bg-[#1e1f20] hover:bg-gray-100 dark:hover:bg-neutral-800 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 font-medium text-xs rounded-xl shadow-2xs transition disabled:opacity-50 cursor-pointer self-start"
                  >
                    {globalTesting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    <span>{globalTesting ? t('admin.testing_api1', '测试主节点中...') : t('admin.test_api1', '测试 API 1 连通性')}</span>
                  </button>

                  {globalTestResult && (
                    <div className={`flex-1 p-2.5 rounded-xl border text-xs flex items-center gap-2 animate-fadeIn ${
                      globalTestResult.success
                        ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
                        : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300'
                    }`}>
                      {globalTestResult.success ? <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> : <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />}
                      <span className="truncate">{globalTestResult.msg}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 卡片 2: API 2 (备用容灾通道 / Backup) */}
            <div className={`p-5 rounded-2xl border transition space-y-4 ${
              backupEnabled
                ? 'bg-indigo-50/40 dark:bg-indigo-950/20 border-indigo-200 dark:border-indigo-900/60'
                : 'bg-gray-50/40 dark:bg-[#222324] border-gray-200 dark:border-neutral-800'
            }`}>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-2 border-b border-gray-200/60 dark:border-neutral-700/60">
                <div className="flex items-center gap-2 font-bold text-sm text-gray-900 dark:text-gray-100 flex-wrap">
                  <ArrowRightLeft className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  <span>{t('admin.api2_title', 'API 2 (备用容灾通道 / Backup Failover)')}</span>
                  {backupHasKey && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 font-semibold">
                      {t('admin.key_configured', '已配置密钥')}
                    </span>
                  )}
                </div>

                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={backupEnabled}
                    onChange={(e) => setBackupEnabled(e.target.checked)}
                    className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                  />
                  <span className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                    {t('admin.api2_enable', '开启自动重连与故障转移')}
                  </span>
                </label>
              </div>

              <p className="text-[11px] text-gray-500 dark:text-neutral-400 leading-relaxed">
                {t('admin.api2_enable_desc', '启用后，当 API 1 响应超时 (18秒)、或返回 5xx 服务端错误 / 429 限流 / 连接中断时，系统全自动无缝切换至 API 2 备用节点重试，保障微信端服务高可用不中断。')}
              </p>

              {backupEnabled && (
                <div className="space-y-4 pt-1 animate-fadeIn">
                  {/* Backup Endpoint */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-gray-800 dark:text-gray-200 uppercase tracking-wider block">
                      {t('admin.api2_endpoint', '备用端点 (Base URL)')}
                    </label>
                    <input
                      type="text"
                      value={backupEndpoint}
                      onChange={(e) => setBackupEndpoint(e.target.value)}
                      placeholder="https://api.deepseek.com/v1"
                      className="w-full px-3.5 py-2.5 bg-white dark:bg-[#1e1f20] border border-gray-300 dark:border-neutral-700 rounded-xl font-mono text-gray-800 dark:text-gray-100 outline-none transition focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                    <span className="text-[11px] text-gray-400 dark:text-neutral-500 block">
                      {t('admin.api2_endpoint_desc', '可配置为另一个 DeepSeek 节点、SiliconFlow 硅基流动、OpenAI 或第三方聚合中转站')}
                    </span>
                  </div>

                  {/* Backup API Key */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-gray-800 dark:text-gray-200 uppercase tracking-wider block">
                      {t('admin.api2_key', '备用 API 密钥 (API Key)')}
                    </label>
                    <input
                      type="password"
                      value={backupApiKey}
                      onChange={(e) => setBackupApiKey(e.target.value)}
                      placeholder={backupApiKeyMasked ? `${language === 'en' ? 'Configured: ' : '已配置: '}${backupApiKeyMasked}` : 'sk-xxxxxxxxxxxxxxxxxxxxxxxx'}
                      className="w-full px-3.5 py-2.5 bg-white dark:bg-[#1e1f20] border border-gray-300 dark:border-neutral-700 rounded-xl font-mono text-gray-800 dark:text-gray-100 outline-none transition focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                    <span className="text-[11px] text-gray-400 dark:text-neutral-500 block">
                      {t('admin.api2_key_tip', '留空则保持当前备用节点密钥不变')}
                    </span>
                  </div>

                  {/* Backup Model */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-gray-800 dark:text-gray-200 uppercase tracking-wider block">
                      {t('admin.api2_model', '备用模型型号 (Model)')}
                    </label>
                    <input
                      type="text"
                      value={backupModel}
                      onChange={(e) => setBackupModel(e.target.value)}
                      placeholder="deepseek-chat"
                      className="w-full px-3.5 py-2.5 bg-white dark:bg-[#1e1f20] border border-gray-300 dark:border-neutral-700 rounded-xl font-mono text-gray-800 dark:text-gray-100 outline-none transition focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                  </div>

                  {/* Test button & result for API 2 */}
                  <div className="pt-1 flex flex-col sm:flex-row sm:items-center gap-3">
                    <button
                      type="button"
                      onClick={() => handleTestGlobalLlm('api2')}
                      disabled={backupTesting}
                      className="flex items-center gap-1.5 px-4 py-2 bg-white dark:bg-[#1e1f20] hover:bg-gray-100 dark:hover:bg-neutral-800 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 font-medium text-xs rounded-xl shadow-2xs transition disabled:opacity-50 cursor-pointer self-start"
                    >
                      {backupTesting ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                      <span>{backupTesting ? t('admin.testing_api2', '测试备用节点中...') : t('admin.test_api2', '测试 API 2 连通性')}</span>
                    </button>

                    {backupTestResult && (
                      <div className={`flex-1 p-2.5 rounded-xl border text-xs flex items-center gap-2 animate-fadeIn ${
                        backupTestResult.success
                          ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
                          : 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800 text-rose-800 dark:text-rose-300'
                      }`}>
                        {backupTestResult.success ? <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> : <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />}
                        <span className="truncate">{backupTestResult.msg}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 模型价格与计费体系配置 */}
            {globalModel.trim().toLowerCase().includes('deepseek') ? (
              /* DeepSeek 官方系列模型：峰谷动态计费卡片 */
              <div className="p-4 rounded-2xl bg-gradient-to-br from-blue-50/70 via-indigo-50/40 to-blue-50/20 dark:from-blue-950/30 dark:via-indigo-950/20 dark:to-blue-950/10 border border-blue-200/80 dark:border-blue-900/60 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-blue-900 dark:text-blue-200 font-bold">
                    <Zap className="w-4 h-4 text-amber-500 fill-amber-500" />
                    <span>{language === 'en' ? 'DeepSeek Official Smart Dynamic Pricing System (Active)' : 'DeepSeek 官方智能峰谷时段计费体系 (已自动启用)'}</span>
                  </div>
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/70 text-blue-700 dark:text-blue-300">
                    {language === 'en' ? 'Dynamic Time-based Rates' : '动态时段定价'}
                  </span>
                </div>
                <p className="text-[11px] text-gray-600 dark:text-neutral-400 leading-relaxed">
                  {language === 'en'
                    ? 'Detected DeepSeek model: user calls will automatically follow Beijing time peak/off-peak discount rates.'
                    : '系统检测到主模型为 DeepSeek 系列，用户调用官方接口时将全自动依据北京时间精确折算扣减账户额度，无需手动输入单价。'}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                  <div className="p-3 rounded-xl bg-white/80 dark:bg-[#1e1f20]/80 border border-blue-100 dark:border-neutral-800 space-y-1.5">
                    <div className="flex items-center justify-between font-semibold text-gray-800 dark:text-gray-200 text-[11px]">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3 text-rose-500" />
                        <span>{language === 'en' ? 'Weekday Peak Hours' : '工作日高峰时段 (峰时)'}</span>
                      </span>
                      <span className="text-[10px] text-gray-400">09:00-12:00, 14:00-18:00</span>
                    </div>
                    <div className="text-[11px] font-mono text-gray-600 dark:text-neutral-300 space-y-0.5">
                      <div>{t('admin.price_input', '输入 (未命中)')}: <span className="font-bold text-gray-900 dark:text-gray-100">¥2.00</span> / M</div>
                      <div>{t('admin.price_output', '输出 (生成)')}: <span className="font-bold text-gray-900 dark:text-gray-100">¥8.00</span> / M</div>
                      <div>{t('admin.price_cache_hit', '缓存命中')}: <span className="font-bold text-emerald-600 dark:text-emerald-400">¥0.50</span> / M</div>
                    </div>
                  </div>

                  <div className="p-3 rounded-xl bg-white/80 dark:bg-[#1e1f20]/80 border border-blue-100 dark:border-neutral-800 space-y-1.5">
                    <div className="flex items-center justify-between font-semibold text-gray-800 dark:text-gray-200 text-[11px]">
                      <span className="flex items-center gap-1">
                        <Sparkles className="w-3 h-3 text-emerald-500" />
                        <span>{language === 'en' ? 'Off-peak Discount Hours (50% Off)' : '闲时优惠时段 (谷时 5折)'}</span>
                      </span>
                      <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-bold">{language === 'en' ? 'Nights / Weekends All Day' : '夜间/早晨/周末全天'}</span>
                    </div>
                    <div className="text-[11px] font-mono text-gray-600 dark:text-neutral-300 space-y-0.5">
                      <div>{t('admin.price_input', '输入 (未命中)')}: <span className="font-bold text-gray-900 dark:text-gray-100">¥1.00</span> / M</div>
                      <div>{t('admin.price_output', '输出 (生成)')}: <span className="font-bold text-gray-900 dark:text-gray-100">¥4.00</span> / M</div>
                      <div>{t('admin.price_cache_hit', '缓存命中')}: <span className="font-bold text-emerald-600 dark:text-emerald-400">¥0.10</span> / M</div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              /* 非 DeepSeek 模型：自定义输入单价（输入、输出、缓存命中） */
              <div className="p-4 rounded-2xl bg-[#f8fafd] dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700/80 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-bold text-gray-900 dark:text-gray-100">
                    <Calculator className="w-4 h-4 text-purple-500" />
                    <span>{t('admin.price_title', '自定义模型计费单价设置（元 / 百万 Tokens）')}</span>
                  </div>
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/60 text-purple-700 dark:text-purple-300 self-start sm:self-auto">
                    {language === 'en' ? 'Billed at this rate' : '用户按此单价扣费'}
                  </span>
                </div>
                <p className="text-[11px] text-gray-500 dark:text-neutral-400">
                  {language === 'en'
                    ? 'Non-DeepSeek model: platform calls will be deducted strictly using these rates.'
                    : '当前模型非 DeepSeek 系列，系统将严格按照您在此处设定的单价折算扣除调用官方接口用户的账户额度。'}
                </p>

                {/* 快捷预设按钮组 */}
                <div className="flex items-center flex-wrap gap-1.5 pt-0.5">
                  <span className="text-[10px] text-gray-400 mr-1">{language === 'en' ? 'Presets:' : '快捷预设:'}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setGlobalPriceInput('18.0');
                      setGlobalPriceOutput('72.0');
                      setGlobalPriceCacheHit('9.0');
                    }}
                    className="px-2 py-1 text-[10px] rounded-lg bg-gray-100 dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700 text-gray-700 dark:text-neutral-300 transition cursor-pointer"
                  >
                    GPT-4o (18 / 72 / 9)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setGlobalPriceInput('1.1');
                      setGlobalPriceOutput('4.4');
                      setGlobalPriceCacheHit('0.55');
                    }}
                    className="px-2 py-1 text-[10px] rounded-lg bg-gray-100 dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700 text-gray-700 dark:text-neutral-300 transition cursor-pointer"
                  >
                    GPT-4o-mini (1.1 / 4.4 / 0.55)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setGlobalPriceInput('0.8');
                      setGlobalPriceOutput('2.0');
                      setGlobalPriceCacheHit('0.1');
                    }}
                    className="px-2 py-1 text-[10px] rounded-lg bg-gray-100 dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700 text-gray-700 dark:text-neutral-300 transition cursor-pointer"
                  >
                    Qwen-Plus (0.8 / 2.0 / 0.1)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setGlobalPriceInput('1.0');
                      setGlobalPriceOutput('1.0');
                      setGlobalPriceCacheHit('0.5');
                    }}
                    className="px-2 py-1 text-[10px] rounded-lg bg-gray-100 dark:bg-neutral-800 hover:bg-gray-200 dark:hover:bg-neutral-700 text-gray-700 dark:text-neutral-300 transition cursor-pointer"
                  >
                    GLM-4 (1.0 / 1.0 / 0.5)
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
                  {/* 输入单价 */}
                  <div className="space-y-1.5">
                    <label className="text-[11px] font-bold text-gray-700 dark:text-gray-300 block">
                      {t('admin.price_input', '输入单价 (未命中缓存)')}
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-2 text-gray-400 font-mono text-xs">¥</span>
                      <input
                        type="number"
                        step="0.0001"
                        min="0"
                        value={globalPriceInput}
                        onChange={(e) => setGlobalPriceInput(e.target.value)}
                        placeholder="2.0"
                        className="w-full pl-7 pr-3 py-2 bg-white dark:bg-[#1e1f20] border border-gray-300 dark:border-neutral-700 rounded-xl font-mono text-xs text-gray-800 dark:text-gray-100 outline-none transition focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
                      />
                    </div>
                    <span className="text-[10px] text-gray-400 block">{language === 'en' ? 'CNY / Million Tokens (Cache Miss)' : '元 / 百万 Tokens (Cache Miss)'}</span>
                  </div>

                  {/* 输出单价 */}
                  <div className="space-y-1.5">
                    <label className="text-[11px] font-bold text-gray-700 dark:text-gray-300 block">
                      {t('admin.price_output', '输出单价 (生成内容)')}
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-2 text-gray-400 font-mono text-xs">¥</span>
                      <input
                        type="number"
                        step="0.0001"
                        min="0"
                        value={globalPriceOutput}
                        onChange={(e) => setGlobalPriceOutput(e.target.value)}
                        placeholder="8.0"
                        className="w-full pl-7 pr-3 py-2 bg-white dark:bg-[#1e1f20] border border-gray-300 dark:border-neutral-700 rounded-xl font-mono text-xs text-gray-800 dark:text-gray-100 outline-none transition focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
                      />
                    </div>
                    <span className="text-[10px] text-gray-400 block">{language === 'en' ? 'CNY / Million Tokens (Completion)' : '元 / 百万 Tokens (Completion)'}</span>
                  </div>

                  {/* 缓存命中单价 */}
                  <div className="space-y-1.5">
                    <label className="text-[11px] font-bold text-gray-700 dark:text-gray-300 block">
                      {t('admin.price_cache_hit', '缓存命中单价 (Prompt Cache)')}
                    </label>
                    <div className="relative">
                      <span className="absolute left-3 top-2 text-gray-400 font-mono text-xs">¥</span>
                      <input
                        type="number"
                        step="0.0001"
                        min="0"
                        value={globalPriceCacheHit}
                        onChange={(e) => setGlobalPriceCacheHit(e.target.value)}
                        placeholder="0.5"
                        className="w-full pl-7 pr-3 py-2 bg-white dark:bg-[#1e1f20] border border-gray-300 dark:border-neutral-700 rounded-xl font-mono text-xs text-gray-800 dark:text-gray-100 outline-none transition focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500"
                      />
                    </div>
                    <span className="text-[10px] text-gray-400 block">{language === 'en' ? 'CNY / Million Tokens (Cache Hit)' : '元 / 百万 Tokens (Cache Hit)'}</span>
                  </div>
                </div>
              </div>
            )}

            {/* 底部保存配置操作区 */}
            <div className="p-4 rounded-2xl bg-gray-50/80 dark:bg-[#252627]/80 border border-gray-200/80 dark:border-neutral-700/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-0.5">
                <span className="text-xs font-bold text-gray-800 dark:text-gray-200 block">
                  {t('admin.save_config_title', '持久化配置存储与即时生效')}
                </span>
                <span className="text-[11px] text-gray-500 dark:text-neutral-400 block">
                  {t('admin.save_config_tip', '配置将独立持久化写入服务器')} <code className="font-mono text-blue-600 dark:text-blue-400">data/global_api_config.json</code> {language === 'en' ? 'and DB, safely preserved across restarts.' : '及数据库，重启服务绝不丢失。'}
                </span>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                {globalSaveSuccess && (
                  <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-semibold animate-fadeIn">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>{t('admin.saved_global_api', '配置已保存生效！')}</span>
                  </span>
                )}

                <button
                  type="button"
                  onClick={handleSaveGlobalLlm}
                  disabled={globalSaving}
                  className="flex items-center gap-1.5 px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs rounded-xl shadow-xs transition disabled:opacity-50 cursor-pointer"
                >
                  {globalSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                  <span>{globalSaving ? t('admin.saving_global_api', '保存中...') : t('admin.save_global_api', '保存全局官方配置')}</span>
                </button>
              </div>
            </div>
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
                <span>{t('admin.redeem_title', '兑换码生成与管理')}</span>
              </h3>
              <p className="text-xs sm:text-sm text-gray-500 dark:text-neutral-400 mt-0.5">
                {t('admin.redeem_desc', '支持批量生成指定限额的充值卡密，用户在个人设置中兑换即可增加账户额度')}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={fetchRedemptionCodes}
                className="p-2 text-gray-500 hover:text-gray-700 dark:text-neutral-400 dark:hover:text-neutral-200 bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800 rounded-xl transition cursor-pointer"
                title={t('common.refresh', '刷新')}
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
                <span>{t('admin.batch_generate_btn', '批量生成兑换码')}</span>
              </button>
            </div>
          </div>

          {/* 汇总统计卡片 */}
          {redemptionSummary && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 shrink-0">
              <div className="p-3.5 rounded-2xl bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">{t('admin.total_generated_count', '总生成张数')}</div>
                <div className="text-xl font-bold text-gray-900 dark:text-gray-100 mt-1 font-mono">
                  {redemptionSummary.totalCount}
                </div>
              </div>

              <div className="p-3.5 rounded-2xl bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">{t('admin.active_codes_count', '待兑换张数')}</div>
                <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400 mt-1 font-mono">
                  {redemptionSummary.activeCount}
                </div>
              </div>

              <div className="p-3.5 rounded-2xl bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">{t('admin.total_active_amount', '可用总面值')}</div>
                <div className="text-xl font-bold text-blue-600 dark:text-blue-400 mt-1 font-mono">
                  ¥{redemptionSummary.totalActiveAmount.toFixed(2)}
                </div>
              </div>

              <div className="p-3.5 rounded-2xl bg-white dark:bg-[#1e1f20] border border-gray-200 dark:border-neutral-800">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">{t('admin.total_used_amount', '已兑换总额')}</div>
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
                    <th className="px-5 py-3.5">{t('admin.th_code', '兑换码 (点击复制)')}</th>
                    <th className="px-5 py-3.5">{t('admin.th_code_amount', '面额 (¥)')}</th>
                    <th className="px-5 py-3.5">{t('admin.th_code_status', '兑换状态')}</th>
                    <th className="px-5 py-3.5">{t('admin.th_code_user', '使用用户')}</th>
                    <th className="px-5 py-3.5">{t('admin.th_code_used_at', '使用时间')}</th>
                    <th className="px-5 py-3.5">{t('admin.th_code_created', '生成时间')}</th>
                    <th className="px-5 py-3.5 text-right">{t('common.actions', '操作')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-neutral-800/80">
                  {redemptionCodes.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="text-center py-12 text-gray-400 text-xs">
                        {language === 'en' ? 'No redemption codes found. Click above to generate.' : '暂无兑换码记录，点击上方按钮立即生成'}
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
                              title={t('admin.th_code', '点击复制兑换码')}
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
                                {t('admin.code_active', '未使用')}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 dark:bg-neutral-800 text-gray-500 dark:text-neutral-400">
                                {t('admin.code_used', '已使用')}
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
                            {item.used_at ? new Date(item.used_at).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN') : '-'}
                          </td>

                          <td className="px-5 py-4 text-gray-400 dark:text-neutral-500 font-mono text-[11px]">
                            {new Date(item.created_at).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}
                          </td>

                          <td className="px-5 py-4 text-right">
                            <button
                              type="button"
                              onClick={() => handleDeleteCode(item.id)}
                              className="p-1.5 text-gray-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-full transition cursor-pointer"
                              title={t('common.delete', '删除此兑换码')}
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
                <span>{t('admin.platform_usage_title', '全平台 Token 与资费使用统计')}</span>
              </h3>
              <p className="text-xs sm:text-sm text-gray-500 dark:text-neutral-400 mt-1">
                {t('admin.platform_usage_desc', '实时聚合平台所有用户的 LLM API 请求、Tokens 消耗总量与峰谷资费走势')}
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
                  <span>{t('admin.scope_official', '官方全局 API 消耗')}</span>
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
                  <span>{t('admin.scope_all', '全平台总计 (含个人Key)')}</span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => fetchAdminUsage(usageScope)}
                className="px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/60 border border-blue-200 dark:border-blue-800 rounded-xl hover:bg-blue-100 transition flex items-center gap-1.5 shrink-0 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${adminUsageLoading ? 'animate-spin' : ''}`} />
                <span>{t('common.refresh', '刷新')}</span>
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
                  <strong>{language === 'en' ? 'Current Scope: Official Global API' : '当前统计范围：官方全局 API'}</strong> ——
                  {language === 'en' ? 'Only includes system calls deducted from global quota, excluding private keys.' : '仅统计由系统官方统筹承载并扣除平台全局额度的真实调用，已严格隔离排除用户自带的个人私有 API Key 用量。'}
                </span>
              ) : (
                <span>
                  <strong>{language === 'en' ? 'Current Scope: Platform Total (Inc. Personal Keys)' : '当前统计范围：全平台总计 (含个人私有 Key)'}</strong> ——
                  {language === 'en' ? 'Aggregating all platform LLM requests to monitor throughput and usage frequency.' : '统计平台产生的所有 LLM 请求（包括用户配置的个人私有 Key 与官方全局接口），供管理员全面监控平台的调用频次与吞吐。'}
                </span>
              )}
            </div>
          </div>

          {adminUsageData?.summary && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-4 rounded-2xl bg-[#f8fafd] dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700/60">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">
                  {usageScope === 'official'
                    ? (language === 'en' ? 'Official API Requests' : '官方接口调用次数')
                    : (language === 'en' ? 'Total Platform Requests' : '全平台总调用次数')}
                </div>
                <div className="text-2xl font-black font-mono text-gray-900 dark:text-gray-100 mt-1">
                  {adminUsageData.summary.totalRequests.toLocaleString()}
                </div>
              </div>

              <div className="p-4 rounded-2xl bg-[#f8fafd] dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700/60">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">
                  {usageScope === 'official'
                    ? (language === 'en' ? 'Official Total Tokens' : '官方总消耗 Tokens')
                    : (language === 'en' ? 'Total Platform Tokens' : '全平台总消耗 Tokens')}
                </div>
                <div className="text-2xl font-black font-mono text-blue-600 dark:text-blue-400 mt-1">
                  {adminUsageData.summary.totalTokens.toLocaleString()}
                </div>
              </div>

              <div className="p-4 rounded-2xl bg-[#f8fafd] dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700/60">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">
                  {usageScope === 'official'
                    ? (language === 'en' ? 'Official Total Cost (¥)' : '官方总消耗折算 (¥)')
                    : (language === 'en' ? 'Total Platform Cost (¥)' : '全平台总消耗折算 (¥)')}
                </div>
                <div className="text-2xl font-black font-mono text-emerald-600 dark:text-emerald-400 mt-1">
                  ¥{adminUsageData.summary.totalCostCny.toFixed(4)}
                </div>
              </div>

              <div className="p-4 rounded-2xl bg-[#f8fafd] dark:bg-[#28292a] border border-gray-200 dark:border-neutral-700/60">
                <div className="text-[11px] text-gray-500 dark:text-neutral-400 font-medium">{language === 'en' ? 'Cache Hit Rate' : '缓存命中率'}</div>
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
                ? (language === 'en' ? 'Official Global API Daily Cost Curve' : '官方全局 API 每日资费消耗价格曲线')
                : (language === 'en' ? 'Total Platform Daily Cost Curve (Inc. Personal Keys)' : '全平台每日资费消耗价格曲线 (含个人私有 Key)')}
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
                <span>{t('admin.recent_logs', '最近调用明细记录')}</span>
                <span className="text-[11px] font-normal text-gray-400">{t('admin.recent_logs_tip', '仅展示最近 15 条')}</span>
              </div>
              <div className="overflow-x-auto border border-gray-200 dark:border-neutral-800 rounded-2xl">
                <table className="w-full text-left text-xs">
                  <thead className="bg-gray-50 dark:bg-neutral-800/60 text-gray-500 dark:text-neutral-400 font-medium border-b border-gray-200 dark:border-neutral-800">
                    <tr>
                      <th className="py-2.5 px-3">{language === 'en' ? 'Time' : '时间'}</th>
                      <th className="py-2.5 px-3">{language === 'en' ? 'User' : '用户'}</th>
                      <th className="py-2.5 px-3">{language === 'en' ? 'Type' : '接口类型'}</th>
                      <th className="py-2.5 px-3">{language === 'en' ? 'Model' : '模型'}</th>
                      <th className="py-2.5 px-3">{language === 'en' ? 'Scenario' : '场景'}</th>
                      <th className="py-2.5 px-3">{language === 'en' ? 'Tokens (Total/Hit)' : 'Tokens (总/命中)'}</th>
                      <th className="py-2.5 px-3">{language === 'en' ? 'Cost' : '折算金额'}</th>
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
                              {language === 'en' ? 'Official Global' : '官方全局'}
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
                              {language === 'en' ? 'Personal Key' : '个人私有 Key'}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-[11px] text-gray-500">
                          {log.model}
                        </td>
                        <td className="py-2.5 px-3 text-[11px]">
                          {log.request_type === 'weixin_chat'
                            ? (language === 'en' ? 'WeChat Message' : '微信交互')
                            : log.request_type === 'key_test'
                            ? (language === 'en' ? 'Private Key Test' : '私有Key测试')
                            : log.request_type === 'global_key_test'
                            ? (language === 'en' ? 'Global Key Test' : '全局Key测试')
                            : log.request_type}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-[11px]">
                          <span>{log.total_tokens.toLocaleString()}</span>
                          {log.cache_hit_tokens > 0 && (
                            <span className="text-emerald-500 ml-1">
                              ({language === 'en' ? `hit ${log.cache_hit_tokens}` : `命中 ${log.cache_hit_tokens}`})
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
                <span>{t('admin.batch_gen_title', '批量生成充值兑换码')}</span>
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
                <label className="font-bold text-gray-800 dark:text-gray-200 block">{t('admin.single_amount', '单张面额 (元)')}</label>
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
                <label className="font-bold text-gray-800 dark:text-gray-200 block">{t('admin.batch_count', '生成张数 (1 ~ 50)')}</label>
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
                      {t('admin.batch_success', '成功生成')} {newlyGenerated.length} {language === 'en' ? 'codes:' : '张卡密：'}
                    </span>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(newlyGenerated.join('\n'), 'all_generated')}
                      className="text-xs text-blue-600 dark:text-blue-400 font-medium flex items-center gap-1 hover:underline cursor-pointer"
                    >
                      {copiedCode === 'all_generated' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedCode === 'all_generated' ? t('admin.copied_all', '已全部复制') : t('admin.copy_all', '一键全部复制')}</span>
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
                {newlyGenerated.length > 0 ? t('admin.done_close', '完成关闭') : t('common.cancel', '取消')}
              </button>
              <button
                type="button"
                onClick={handleGenerateCodes}
                disabled={generatingCodes}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl text-xs font-semibold shadow-xs transition cursor-pointer flex items-center justify-center gap-1.5"
              >
                {generatingCodes ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                <span>{generatingCodes ? t('admin.generating', '正在生成...') : t('admin.generate_now', '立即批量生成')}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
