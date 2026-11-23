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
import { incrementSessionVersion, recordAuditLog } from '../services/accountService.js';
import { deleteUserAccountWithCleanup } from './authController.js';

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

  if (target.status !== 'pending' && target.status !== 'rejected') {
    res.status(400).json({ error: `当前账号状态为「${target.status}」，仅待审核或已拒绝账号可执行审核放行` });
    return;
  }

  db.prepare(`
    UPDATE users
    SET status = 'approved', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);

  recordAuditLog(req.user?.id ?? null, target.id, 'approve_user', { fromStatus: target.status });
  addDebugLog('Auth', 'info', `管理员审核放行了用户「${target.username}」`);
  res.json({ message: `用户「${target.username}」已成功审核放行！` });
}

export function rejectUser(req: AuthenticatedRequest, res: Response): void {
  const { id } = req.params;
  const target = db.prepare('SELECT id, username, role, status FROM users WHERE id = ?').get(id) as any;
  if (!target) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  if (target.id === req.user?.id) {
    res.status(400).json({ error: '不能拒绝自己的账号' });
    return;
  }
  if (target.status !== 'pending') {
    res.status(400).json({ error: `仅待审核账号可执行拒绝操作（当前状态：${target.status}）` });
    return;
  }

  db.prepare(`
    UPDATE users
    SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);

  recordAuditLog(req.user?.id ?? null, target.id, 'reject_user', { fromStatus: target.status });
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

  recordAuditLog(req.user?.id ?? null, Number(id), 'set_user_role', { role });
  res.json({ message: '用户角色已更新' });
}

export function banUser(req: AuthenticatedRequest, res: Response): void {
  const { id } = req.params;
  const target = db.prepare('SELECT id, username, role, status FROM users WHERE id = ?').get(id) as any;
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

  db.transaction(() => {
    db.prepare(`
      UPDATE users
      SET status = 'banned', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
    incrementSessionVersion(target.id);
    db.prepare(`
      UPDATE notification_outbox
      SET status = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND status IN ('pending', 'failed')
    `).run(target.id);
    recordAuditLog(req.user?.id ?? null, target.id, 'ban_user', { fromStatus: target.status });
  })();

  weixinTransitManager.stopWorker(target.id);
  addDebugLog('Auth', 'warn', `管理员封禁了用户「${target.username}」`);
  res.json({ message: `用户「${target.username}」已被封禁！` });
}

export function unbanUser(req: AuthenticatedRequest, res: Response): void {
  const { id } = req.params;
  const target = db.prepare('SELECT id, username, status FROM users WHERE id = ?').get(id) as any;
  if (!target) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  if (target.status !== 'banned') {
    res.status(400).json({ error: `仅已封禁账号可解封（当前状态：${target.status}）` });
    return;
  }

  db.prepare(`
    UPDATE users
    SET status = 'approved', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);

  recordAuditLog(req.user?.id ?? null, target.id, 'unban_user', { fromStatus: target.status });
  addDebugLog('Auth', 'info', `管理员解封了用户「${target.username}」`);
  res.json({ message: `用户「${target.username}」已解除封禁！` });
}

export function deleteUser(req: AuthenticatedRequest, res: Response): void {
  const targetId = Number(req.params.id);
  if (targetId === req.user?.id) {
    res.status(400).json({ error: '不能删除自己的账号' });
    return;
  }

  const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(targetId) as any;
  if (!target) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }
  if (target?.role === 'admin' && target?.username === 'admin') {
    res.status(400).json({ error: '不能删除系统超级管理员账号' });
    return;
  }

  deleteUserAccountWithCleanup(targetId, req.user?.id ?? null);
  res.json({ message: '用户及关联数据已清理并删除' });
}

export function getDebugLogs(req: AuthenticatedRequest, res: Response): void {
  const limit = Math.min(500, Number(req.query.limit) || 200);
  const level = String(req.query.level || 'all');
  const module = String(req.query.module || 'all');

  const logs = getRecentLogs(limit, level, module);
  res.json({ logs });
}

export function clearDebugLogs(req: AuthenticatedRequest, res: Response): void {
  clearLogs();
  res.json({ message: '日志已清空' });
}

/**
 * 模拟来信（A08）：
 * - 默认 dryRun = true（隔离预演，不写入用户任务、不改激活态、不扣用户额度）
 * - 仅当显式传入 realExecution: true 时执行真实写入，并记录管理员操作审计日志
 */
export async function debugSimulateInbound(req: AuthenticatedRequest, res: Response): Promise<void> {
  const { userId, content, realExecution = false } = req.body || {};
  if (!userId || !content || !String(content).trim()) {
    res.status(400).json({ error: '缺少 userId 或 content' });
    return;
  }

  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId) as any;
  if (!user) {
    res.status(404).json({ error: '用户不存在' });
    return;
  }

  const isDryRun = !Boolean(realExecution);
  const startTime = Date.now();
  addDebugLog(
    'Weixin',
    'info',
    `[调试器模拟:${isDryRun ? '演练隔离' : '真实执行'}] 用户 #${userId} (${user.username}) 消息: "${content}"`
  );

  if (!isDryRun) {
    recordAuditLog(req.user?.id ?? null, Number(userId), 'admin_simulate_inbound_real', {
      content: String(content).trim(),
    });
  }

  try {
    const result = await processWeChatMessage(
      Number(userId),
      String(content).trim(),
      `debug_sim_user_${userId}`,
      { dryRun: isDryRun, skipImages: isDryRun }
    );
    const elapsedMs = Date.now() - startTime;

    res.json({
      success: true,
      dryRun: isDryRun,
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
      dryRun: isDryRun,
      error: err.message,
      stack: err.stack,
    });
  }
}

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

export function getWorkersStatus(req: AuthenticatedRequest, res: Response): void {
  const workers = weixinTransitManager.getWorkerStatusList();
  res.json({ workers });
}

export function restartUserWorker(req: AuthenticatedRequest, res: Response): void {
  const { userId } = req.params;
  weixinTransitManager.startWorker(Number(userId));
  res.json({ message: `已重新启动用户 #${userId} 的微信轮询管道` });
}

export function resetUserSyncBuf(req: AuthenticatedRequest, res: Response): void {
  const { userId } = req.params;
  weixinTransitManager.resetSyncBuf(Number(userId));
  res.json({ message: `已重置用户 #${userId} 的 sync_buf 并重启 Worker` });
}

export function getGlobalLlmSettings(req: AuthenticatedRequest, res: Response): void {
  const config = getGlobalApiConfig();
  const api1Masked = maskApiKey(config.api1.apiKey);
  const api2Masked = maskApiKey(config.api2.apiKey);

  res.json({
    configVersion: config.configVersion,
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
    endpoint: config.api1.endpoint,
    model: config.api1.model,
    apiKeyMasked: api1Masked,
    hasKey: Boolean(config.api1.apiKey && config.api1.apiKey.length > 3),
    priceInput: config.pricing.priceInput,
    priceOutput: config.pricing.priceOutput,
    priceCacheHit: config.pricing.priceCacheHit,
  });
}

export function updateGlobalLlmSettings(req: AuthenticatedRequest, res: Response): void {
  const body = req.body;

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

  try {
    const updated = saveGlobalApiConfig({
      api1: api1Update,
      api2: api2Update,
      pricing: pricingUpdate,
    });

    addDebugLog(
      'System',
      'info',
      `管理员更新了全局 API 配置 v${updated.configVersion} (主节点 Model: ${updated.api1.model}, 备用节点: ${updated.api2.enabled ? '已启用' : '未启用'})`
    );

    res.json({
      success: true,
      message: `全局 API 配置已持久化保存 (版本 v${updated.configVersion})！`,
      config: updated,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: `保存全局配置失败: ${err.message}` });
  }
}

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

export function rechargeUserBalance(req: AuthenticatedRequest, res: Response): void {
  const { id } = req.params;
  const { amount, username } = req.body;

  const numAmount = Number(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    res.status(400).json({ error: '充值金额必须为大于 0 的有效数值' });
    return;
  }

  const txResult = db.transaction(() => {
    let target: any = null;
    if (username && typeof username === 'string' && username.trim()) {
      target = db.prepare('SELECT id, username, COALESCE(balance, 0) as balance FROM users WHERE username = ? COLLATE NOCASE').get(username.trim());
    } else if (id && id !== 'by-username') {
      target = db.prepare('SELECT id, username, COALESCE(balance, 0) as balance FROM users WHERE id = ?').get(id);
    } else {
      return { error: { status: 400, message: '缺少充值目标用户信息（UID 或 用户名）' } };
    }

    if (!target) {
      return { error: { status: 404, message: '用户不存在' } };
    }

    db.prepare(`
      UPDATE users
      SET balance = ROUND(COALESCE(balance, 0) + ?, 4), updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(numAmount, target.id);

    const after = db.prepare('SELECT balance FROM users WHERE id = ?').get(target.id) as { balance: number };
    recordAuditLog(req.user?.id ?? null, target.id, 'admin_recharge', { amount: numAmount, newBalance: after.balance });
    return { target, newBalance: Number(after.balance) };
  })();

  if ('error' in txResult && txResult.error) {
    res.status(txResult.error.status).json({ error: txResult.error.message });
    return;
  }

  addDebugLog('Auth', 'info', `管理员为用户「${txResult.target.username}」(ID: ${txResult.target.id}) 充值 ¥${numAmount.toFixed(2)}，当前余额: ¥${txResult.newBalance!.toFixed(2)}`);
  res.json({
    success: true,
    user: { id: txResult.target.id, username: txResult.target.username },
    newBalance: txResult.newBalance,
    message: `已成功为用户「${txResult.target.username}」充值 ¥${numAmount.toFixed(2)} 元！当前余额：¥${txResult.newBalance!.toFixed(2)} 元`,
  });
}

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

  db.transaction(() => {
    for (let i = 0; i < numCount; i++) {
      const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const part3 = crypto.randomBytes(2).toString('hex').toUpperCase();
      const code = `CLAW-${part1}-${part2}-${part3}`;
      insertStmt.run(code, numAmount, createdBy);
      generatedCodes.push(code);
    }
  })();

  addDebugLog('System', 'info', `管理员生成了 ${numCount} 个面额为 ¥${numAmount.toFixed(2)} 的兑换码`);
  res.json({
    success: true,
    count: numCount,
    amount: numAmount,
    codes: generatedCodes,
    message: `成功生成 ${numCount} 个面额为 ¥${numAmount.toFixed(2)} 的兑换码！`,
  });
}

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
 * 废弃/删除兑换码（A06：已使用的兑换码不可物理删除，保留不可变财务核对记录）
 */
export function deleteRedemptionCode(req: AuthenticatedRequest, res: Response): void {
  const { id } = req.params;
  const row = db.prepare('SELECT id, status FROM redemption_codes WHERE id = ?').get(id) as
    | { id: number; status: string }
    | undefined;
  if (!row) {
    res.status(404).json({ error: '兑换码不存在' });
    return;
  }
  if (row.status === 'used') {
    res.status(400).json({ error: '已使用的兑换码涉及财务流水审计，不可删除' });
    return;
  }

  db.prepare('DELETE FROM redemption_codes WHERE id = ?').run(id);
  res.json({ success: true, message: '未使用的兑换码已删除' });
}

export function getAdminUsageStats(req: AuthenticatedRequest, res: Response): void {
  const scope = (req.query.scope as string) === 'all' ? 'all' : 'official';
  const stats = getGlobalUsageStats(undefined, scope);
  res.json({
    success: true,
    ...stats,
  });
}
