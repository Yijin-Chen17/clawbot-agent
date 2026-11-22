import { Response } from 'express';
import crypto from 'crypto';
import OpenAI from 'openai';
import { db } from '../config/database.js';
import { AuthenticatedRequest } from '../middleware/auth.js';
import { getRecentLogs, clearLogs, addDebugLog } from '../services/debugLogger.js';
import {
  processWeChatMessage,
  sendWeixinTextMessage,
  weixinTransitManager,
} from '../services/weixinGateway.js';
import { UserSettings } from '../models/types.js';
import { getGlobalUsageStats, recordApiUsage } from '../services/llmPricing.js';
import { getGlobalApiConfig, saveGlobalApiConfig, maskApiKey } from '../services/globalApiConfig.js';

export function listUsers(req: AuthenticatedRequest, res: Response): void {
  const users = db.prepare(`
    SELECT
      u.id,
      u.username,
      u.email,
      u.role,
      u.status,
      COALESCE(u.balance, 0) as balance,
      u.created_at,
      u.updated_at,
      (SELECT count(*) FROM tasks WHERE user_id = u.id) as task_count,
      (SELECT count(*) FROM calendar_subscriptions WHERE user_id = u.id) as subscription_count
    FROM users u
    ORDER BY u.created_at DESC
  `).all();

  res.json({ users });
}

export function approveUser(req: AuthenticatedRequest, res: Response): void {
  const { id } = req.params;

  const target = db.prepare('SELECT id, username, status FROM users WHERE id = ?').get(id) as any;
  if (!target) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }

  db.prepare(`
    UPDATE users
    SET status = 'approved', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);

  addDebugLog('Auth', 'info', `管理员审核放行了用户「${target.username}」`);
  res.json({ message: `用户「${target.username}」已成功审核放行！` });
}

export function rejectUser(req: AuthenticatedRequest, res: Response): void {
  const { id } = req.params;

  const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id) as any;
  if (!target) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }

  if (target.id === req.user?.id) {
    res.status(400).json({ error: '不能拒绝自己的账号' });
    return;
  }

  db.prepare(`
    UPDATE users
    SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);

  addDebugLog('Auth', 'warn', `管理员拒绝了用户「${target.username}」的权限`);
  res.json({ message: `已拒绝用户「${target.username}」的访问权限。` });
}

export function setUserRole(req: AuthenticatedRequest, res: Response): void {
  const { id } = req.params;
  const { role } = req.body;

  if (role !== 'admin' && role !== 'user') {
    res.status(400).json({ error: '无效角色' });
    return;
  }

  if (Number(id) === req.user?.id && role !== 'admin') {
    res.status(400).json({ error: '不能取消自己的管理员身份' });
    return;
  }

  db.prepare(`
    UPDATE users
    SET role = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(role, id);

  res.json({ message: '用户角色已更新' });
}

export function banUser(req: AuthenticatedRequest, res: Response): void {
  const { id } = req.params;

  const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id) as any;
  if (!target) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }

  if (target.id === req.user?.id) {
    res.status(400).json({ error: '不能封禁自己的账号' });
    return;
  }

  if (target.role === 'admin' && target.username === 'admin') {
    res.status(400).json({ error: '不能封禁系统超级管理员' });
    return;
  }

  db.prepare(`
    UPDATE users
    SET status = 'banned', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);

  addDebugLog('Auth', 'warn', `管理员封禁了用户「${target.username}」`);
  res.json({ message: `用户「${target.username}」已被封禁！` });
}

export function unbanUser(req: AuthenticatedRequest, res: Response): void {
  const { id } = req.params;

  const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id) as any;
  if (!target) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }

  db.prepare(`
    UPDATE users
    SET status = 'approved', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);

  addDebugLog('Auth', 'info', `管理员解封了用户「${target.username}」`);
  res.json({ message: `用户「${target.username}」已解除封禁！` });
}

export function deleteUser(req: AuthenticatedRequest, res: Response): void {
  const { id } = req.params;

  if (Number(id) === req.user?.id) {
    res.status(400).json({ error: '不能删除自己的账号' });
    return;
  }

  const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id) as any;
  if (target?.role === 'admin' && target?.username === 'admin') {
    res.status(400).json({ error: '不能删除系统超级管理员账号' });
    return;
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ message: '用户已删除' });
}

// ================= Debugger Endpoints =================

/**
 * 1. Get recent system debug logs
 */
export function getDebugLogs(req: AuthenticatedRequest, res: Response): void {
  const limit = Math.min(500, Number(req.query.limit) || 200);
  const level = String(req.query.level || 'all');
  const module = String(req.query.module || 'all');

  const logs = getRecentLogs(limit, level, module);
  res.json({ logs });
}

/**
 * 2. Clear debug logs
 */
export function clearDebugLogs(req: AuthenticatedRequest, res: Response): void {
  clearLogs();
  res.json({ message: '日志已清空' });
}

/**
 * 3. Simulate inbound WeChat message for a given user
 */
export async function debugSimulateInbound(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { userId, content } = req.body;
  if (!userId || !content || !String(content).trim()) {
    res.status(400).json({ error: '缺少 userId 或 content' });
    return;
  }

  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId) as any;
  if (!user) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }

  const startTime = Date.now();
  addDebugLog('Weixin', 'info', `[调试器模拟] 模拟用户 #${userId} (${user.username}) 发送消息: "${content}"`);

  try {
    const result = await processWeChatMessage(Number(userId), String(content).trim(), `debug_sim_user_${userId}`);
    const elapsedMs = Date.now() - startTime;

    addDebugLog('Weixin', 'success', `[调试器模拟] 模拟消息处理完成，耗时 ${elapsedMs}ms`, {
      replyPreview: result.replyText.slice(0, 80),
    });

    res.json({
      success: true,
      user: { id: user.id, username: user.username },
      inputContent: content,
      replyText: result.replyText,
      diagnostics: result.diagnostics,
      imagePreviewBase64: result.imageBuffer
        ? `data:image/png;base64,${result.imageBuffer.toString('base64')}`
        : undefined,
      elapsedMs,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
      stack: err.stack,
    });
  }
}

/**
 * 4. Test outbound message sending to real WeChat user
 */
export async function debugTestSendWeChat(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { userId, message } = req.body;
  if (!userId || !message) {
    res.status(400).json({ error: '缺少 userId 或 message' });
    return;
  }

  const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as UserSettings | undefined;
  if (!settings || !settings.weixin_connected || !settings.weixin_bot_token || !settings.weixin_user_id) {
    res.status(400).json({ error: '该用户尚未成功连接微信，无法下发真实微信消息' });
    return;
  }

  const baseUrl = settings.weixin_base_url || 'https://ilinkai.weixin.qq.com';
  const result = await sendWeixinTextMessage(
    baseUrl,
    settings.weixin_bot_token,
    settings.weixin_bot_id || '',
    settings.weixin_user_id,
    String(message),
    settings.weixin_context_token
  );

  res.json({
    success: result.success,
    result,
    toUserId: settings.weixin_user_id,
    botId: settings.weixin_bot_id,
    hasContextToken: Boolean(settings.weixin_context_token),
  });
}

/**
 * 5. Get status of all WeChat transit workers
 */
export function getWorkersStatus(req: AuthenticatedRequest, res: Response): void {
  const workers = weixinTransitManager.getWorkerStatusList();
  res.json({ workers });
}

/**
 * 6. Restart a worker for a user
 */
export function restartUserWorker(req: AuthenticatedRequest, res: Response): void {
  const { userId } = req.params;
  weixinTransitManager.startWorker(Number(userId));
  res.json({ message: `已重新启动用户 #${userId} 的微信轮询管道` });
}

/**
 * 7. Reset sync_buf for a user
 */
export function resetUserSyncBuf(req: AuthenticatedRequest, res: Response): void {
  const { userId } = req.params;
  weixinTransitManager.resetSyncBuf(Number(userId));
  res.json({ message: `已重置用户 #${userId} 的 sync_buf 并重启 Worker` });
}

// ================= Global LLM API & Quota Settings =================

/**
 * 获取全局大模型 API 设置（包含 API 1 主节点与 API 2 备用节点）
 */
export function getGlobalLlmSettings(req: AuthenticatedRequest, res: Response): void {
  const config = getGlobalApiConfig();

  const api1Masked = maskApiKey(config.api1.apiKey);
  const api2Masked = maskApiKey(config.api2.apiKey);

  res.json({
    // 结构化节点数据
    api1: {
      endpoint: config.api1.endpoint,
      model: config.api1.model,
      apiKeyMasked: api1Masked,
      hasKey: Boolean(config.api1.apiKey && config.api1.apiKey.length > 3),
    },
    api2: {
      endpoint: config.api2.endpoint,
      model: config.api2.model,
      apiKeyMasked: api2Masked,
      hasKey: Boolean(config.api2.apiKey && config.api2.apiKey.length > 3),
      enabled: Boolean(config.api2.enabled),
    },
    pricing: config.pricing,
    updatedAt: config.updatedAt,

    // 扁平结构兼容旧前端调用
    endpoint: config.api1.endpoint,
    model: config.api1.model,
    apiKeyMasked: api1Masked,
    hasKey: Boolean(config.api1.apiKey && config.api1.apiKey.length > 3),
    priceInput: config.pricing.priceInput,
    priceOutput: config.pricing.priceOutput,
    priceCacheHit: config.pricing.priceCacheHit,
  });
}

/**
 * 更新全局大模型 API 设置（双写至独立持久化配置文件与数据库，防止重启丢配置）
 */
export function updateGlobalLlmSettings(req: AuthenticatedRequest, res: Response): void {
  const body = req.body;

  // 兼顾结构化传参与扁平旧传参
  const api1Update = body.api1 || {
    endpoint: body.endpoint,
    model: body.model,
    apiKey: body.api_key,
  };

  const api2Update = body.api2 || {
    endpoint: body.backup_endpoint,
    model: body.backup_model,
    apiKey: body.backup_api_key,
    enabled: body.backup_enabled,
  };

  const pricingUpdate = body.pricing || {
    priceInput: body.price_input,
    priceOutput: body.price_output,
    priceCacheHit: body.price_cache_hit,
  };

  const updated = saveGlobalApiConfig({
    api1: api1Update,
    api2: api2Update,
    pricing: pricingUpdate,
  });

  addDebugLog(
    'System',
    'info',
    `管理员更新了全局 API 配置 (主节点 Model: ${updated.api1.model}, 备用节点: ${updated.api2.enabled ? '已启用' : '未启用'})`
  );

  res.json({
    success: true,
    message: '全局 API 配置及主备节点设置已成功持久化保存！',
    config: updated,
  });
}

/**
 * 测试全局大模型 API 连通性（支持独立测试 API 1 或 API 2）
 */
export async function testGlobalLlmSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { node = 'api1', endpoint, api_key, model } = req.body;
  const config = getGlobalApiConfig();
  const targetNode = node === 'api2' ? config.api2 : config.api1;

  let finalKey = api_key;
  if (!finalKey || typeof finalKey !== 'string' || finalKey.includes('****')) {
    finalKey = targetNode.apiKey || (node === 'api1' ? process.env.DEEPSEEK_API_KEY || '' : '');
  }

  if (!finalKey || !finalKey.trim()) {
    res.status(400).json({
      success: false,
      error: `未输入或未配置 ${node === 'api2' ? '备用节点 (API 2)' : '主节点 (API 1)'} 的 API Key`,
    });
    return;
  }

  const finalEndpoint = String(endpoint || targetNode.endpoint || 'https://api.deepseek.com/v1').trim();
  const finalModel = String(model || targetNode.model || 'deepseek-chat').trim();
  const nodeLabel = node === 'api2' ? '备用节点 (API 2)' : '主用节点 (API 1)';

  const startTime = Date.now();
  try {
    const client = new OpenAI({
      baseURL: finalEndpoint,
      apiKey: finalKey.trim(),
      timeout: 15000,
    });

    const testRes = await client.chat.completions.create({
      model: finalModel,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
    });

    const latency = Date.now() - startTime;
    const tokens = testRes.usage?.total_tokens || 0;

    if (testRes.usage && req.user?.id) {
      recordApiUsage(req.user.id, finalModel, testRes.usage, 'global_key_test', true);
    }

    res.json({
      success: true,
      message: `${nodeLabel} 验证成功！响应耗时 ${latency}ms，单次测试消耗 ${tokens} Tokens。`,
      latency,
      tokens,
    });
  } catch (err: any) {
    const errorMsg =
      err.response?.data?.error?.message ||
      err.message ||
      `${nodeLabel} 连接失败，请检查端点 URL、API Key 或模型名称是否正确`;
    res.status(400).json({
      success: false,
      error: `[${nodeLabel} 失败] ${errorMsg}`,
    });
  }
}

/**
 * 直接充值指定用户账户额度（支持通过 UID 或用户名充值）
 */
export function rechargeUserBalance(req: AuthenticatedRequest, res: Response): void {
  const { id } = req.params;
  const { amount, username } = req.body;

  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    res.status(400).json({ error: '充值金额必须为大于 0 的有效数值' });
    return;
  }

  let target: any = null;
  if (username && typeof username === 'string' && username.trim()) {
    target = db.prepare('SELECT id, username, COALESCE(balance, 0) as balance FROM users WHERE username = ? COLLATE NOCASE').get(username.trim());
    if (!target) {
      res.status(404).json({ error: `用户「${username}」不存在` });
      return;
    }
  } else if (id && id !== 'by-username') {
    target = db.prepare('SELECT id, username, COALESCE(balance, 0) as balance FROM users WHERE id = ?').get(id);
    if (!target) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }
  } else {
    res.status(400).json({ error: '缺少充值目标用户信息（UID 或 用户名）' });
    return;
  }

  const newBalance = Number((target.balance + numAmount).toFixed(4));
  db.prepare(`
    UPDATE users
    SET balance = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newBalance, target.id);

  addDebugLog('Auth', 'info', `管理员为用户「${target.username}」(ID: ${target.id}) 充值 ¥${numAmount.toFixed(2)}，当前余额: ¥${newBalance.toFixed(2)}`);
  res.json({
    success: true,
    user: { id: target.id, username: target.username },
    newBalance,
    message: `已成功为用户「${target.username}」充值 ¥${numAmount.toFixed(2)} 元！当前余额：¥${newBalance.toFixed(2)} 元`,
  });
}

/**
 * 批量生成兑换码
 */
export function generateRedemptionCodes(req: AuthenticatedRequest, res: Response): void {
  const { amount, count } = req.body;

  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    res.status(400).json({ error: '兑换码面额必须为大于 0 的有效数值' });
    return;
  }

  const numCount = Math.min(50, Math.max(1, Number(count) || 1));
  const createdBy = req.user!.id;
  const generatedCodes: string[] = [];

  const insertStmt = db.prepare(`
    INSERT INTO redemption_codes (code, amount, status, created_by)
    VALUES (?, ?, 'active', ?)
  `);

  const runTransaction = db.transaction(() => {
    for (let i = 0; i < numCount; i++) {
      // 生成格式如 CLAW-8F3A-BC12-9D4E 的随机唯一兑换码
      const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const part3 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const code = `CLAW-${part1}-${part2}-${part3}`;

      insertStmt.run(code, numAmount, createdBy);
      generatedCodes.push(code);
    }
  });

  runTransaction();

  addDebugLog('System', 'info', `管理员生成了 ${numCount} 个面额为 ¥${numAmount.toFixed(2)} 的兑换码`);
  res.json({
    success: true,
    count: numCount,
    amount: numAmount,
    codes: generatedCodes,
    message: `成功生成 ${numCount} 个面额为 ¥${numAmount.toFixed(2)} 的兑换码！`,
  });
}

/**
 * 查询兑换码列表与汇总数据
 */
export function listRedemptionCodes(req: AuthenticatedRequest, res: Response): void {
  const codes = db.prepare(`
    SELECT 
      rc.id,
      rc.code,
      rc.amount,
      rc.status,
      rc.created_by,
      rc.used_by_user_id,
      u.username as used_by_username,
      rc.used_at,
      rc.created_at
    FROM redemption_codes rc
    LEFT JOIN users u ON rc.used_by_user_id = u.id
    ORDER BY rc.created_at DESC
  `).all();

  const summary = db.prepare(`
    SELECT
      COUNT(*) as total_count,
      COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) as active_count,
      COALESCE(SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END), 0) as used_count,
      COALESCE(SUM(CASE WHEN status = 'active' THEN amount ELSE 0 END), 0) as total_active_amount,
      COALESCE(SUM(CASE WHEN status = 'used' THEN amount ELSE 0 END), 0) as total_used_amount
    FROM redemption_codes
  `).get() as any;

  res.json({
    codes,
    summary: {
      totalCount: summary?.total_count || 0,
      activeCount: summary?.active_count || 0,
      usedCount: summary?.used_count || 0,
      totalActiveAmount: Number((summary?.total_active_amount || 0).toFixed(2)),
      totalUsedAmount: Number((summary?.total_used_amount || 0).toFixed(2)),
    },
  });
}

/**
 * 删除或废弃兑换码
 */
export function deleteRedemptionCode(req: AuthenticatedRequest, res: Response): void {
  const { id } = req.params;
  db.prepare('DELETE FROM redemption_codes WHERE id = ?').run(id);
  res.json({ success: true, message: '兑换码已删除' });
}

/**
 * 获取全平台 Token 与资费使用统计
 */
export function getAdminUsageStats(req: AuthenticatedRequest, res: Response): void {
  const scope = (req.query.scope as string) === 'all' ? 'all' : 'official';
  const stats = getGlobalUsageStats('deepseek-chat', scope);
  res.json({
    success: true,
    ...stats,
  });
}
