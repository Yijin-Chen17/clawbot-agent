import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../config/database.js';
import { setupIsolatedTestEnv, seedTestUser, createMockResponse } from '../testHelpers/testDb.js';
import { getGlobalApiConfig, saveGlobalApiConfig } from './globalApiConfig.js';
import { invokeLlmWithFailover, setLlmExecutorForTest } from './llm.js';
import {
  clearUserUsageLogs,
  getGlobalUsageStats,
  getUserUsageStats,
} from './llmPricing.js';
import { redeemCode } from '../controllers/settingsController.js';
import { debugSimulateInbound } from '../controllers/adminController.js';
import { deleteUserAccountWithCleanup } from '../controllers/authController.js';
import { sendEmailVerificationCode, setEmailSenderForTest, verifyEmailCode } from './emailService.js';

describe('Parallel Track: Failover, Zero Pricing, Billing Ledger, Redemption, Dry-Run Sim, Email & Cleanup', () => {
  let cleanup: () => void;
  let adminId: number;
  let officialUserId: number;

  beforeEach(() => {
    const env = setupIsolatedTestEnv();
    cleanup = env.cleanup;
    adminId = seedTestUser({ username: 'super_tester', role: 'admin', apiMode: 'official', balance: 10 }).userId;
    officialUserId = seedTestUser({ username: 'official_u', apiMode: 'official', balance: 1.0 }).userId;
  });

  afterEach(() => {
    cleanup();
  });

  it('persists global config in SQLite with monotonic version, preserves zero pricing, and fails over primary -> backup (A07, A10, A11)', async () => {
    const vBefore = getGlobalApiConfig().configVersion;
    const saved = saveGlobalApiConfig({
      api1: { endpoint: 'https://primary.llm/v1', apiKey: 'sk-primary-1234', model: 'model-a' },
      api2: { endpoint: 'https://backup.llm/v1', apiKey: 'sk-backup-5678', model: 'model-b', enabled: true },
      pricing: { priceCacheHit: 0, priceInput: 0, priceOutput: 0 },
    });
    assert.equal(saved.configVersion, vBefore + 1);
    assert.equal(saved.pricing.priceInput, 0);
    assert.equal(saved.pricing.priceOutput, 0);
    assert.equal(saved.pricing.priceCacheHit, 0);

    // Reload from SQLite
    const reloaded = getGlobalApiConfig();
    assert.equal(reloaded.api1.model, 'model-a');
    assert.equal(reloaded.api2.enabled, true);
    assert.equal(reloaded.pricing.priceInput, 0);

    const calledEndpoints: string[] = [];
    setLlmExecutorForTest(async ({ endpoint }) => {
      calledEndpoints.push(endpoint);
      if (endpoint.includes('primary')) {
        throw new Error('503 primary down');
      }
      return {
        content: '{"ok":true}',
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
      };
    });

    const out = await invokeLlmWithFailover({
      userId: officialUserId,
      purpose: 'test_failover',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(out.usedBackup, true);
    assert.equal(out.model, 'model-b');
    assert.equal(out.costCny, 0); // Zero-price preserved!
    assert.deepEqual(calledEndpoints, ['https://primary.llm/v1', 'https://backup.llm/v1']);

    const u = db.prepare('SELECT balance FROM users WHERE id = ?').get(officialUserId) as any;
    assert.equal(u.balance, 1.0); // Reservation released with 0 cost
  });

  it('settles reservation accurately, refunds unused reserve, and blocks calls when balance is insufficient (A05)', async () => {
    saveGlobalApiConfig({
      api1: { endpoint: 'https://primary.llm/v1', apiKey: 'sk-primary-1234', model: 'deepseek-chat' },
      pricing: { priceCacheHit: 0.5, priceInput: 2.0, priceOutput: 8.0 },
    });

    // Zero balance rejected cleanly before calling model
    db.prepare('UPDATE users SET balance = 0 WHERE id = ?').run(officialUserId);
    await assert.rejects(
      () =>
        invokeLlmWithFailover({
          userId: officialUserId,
          purpose: 'test_insufficient',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      /额度已用尽|余额不足|额度不足/
    );

    // Give user 1.00 CNY, run call with known token usage -> deducts exact cost
    db.prepare('UPDATE users SET balance = 1.0 WHERE id = ?').run(officialUserId);
    setLlmExecutorForTest(async () => ({
      content: 'ok',
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, prompt_cache_hit_tokens: 0 },
    }));

    const res = await invokeLlmWithFailover({
      userId: officialUserId,
      purpose: 'test_billing',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.ok(res.costCny > 0);
    const afterBal = (db.prepare('SELECT balance FROM users WHERE id = ?').get(officialUserId) as any).balance;
    assert.ok(afterBal < 1.0 && afterBal > 0.9);
  });

  it('redeems code once atomically, soft-clears personal usage without erasing global billing totals, and cleans up deleted user safely (A06, A09)', () => {
    db.prepare(`
      INSERT INTO redemption_codes (code, amount, status, created_by)
      VALUES ('TEST-CODE-88', 25.5, 'active', ?)
    `).run(adminId);

    // Log usage for this user
    db.prepare(`
      INSERT INTO api_usage_logs (user_id, model, prompt_tokens, completion_tokens, total_tokens, cost_cny, is_official)
      VALUES (?, 'deepseek-chat', 100, 50, 150, 1.25, 1)
    `).run(officialUserId);

    // Claim redemption code twice
    const req1: any = { user: { id: officialUserId }, body: { code: 'TEST-CODE-88' } };
    const m1 = createMockResponse();
    redeemCode(req1, m1.res);
    assert.equal(m1.getStatus(), 200);

    const req2: any = { user: { id: officialUserId }, body: { code: 'TEST-CODE-88' } };
    const m2 = createMockResponse();
    redeemCode(req2, m2.res);
    assert.equal(m2.getStatus(), 400);

    // Soft clear personal usage logs
    assert.equal(clearUserUsageLogs(officialUserId), true);
    const personal = getUserUsageStats(officialUserId);
    assert.equal(personal.summary.totalCostCny, 0);

    const globalStats = getGlobalUsageStats();
    assert.ok(globalStats.summary.totalCostCny >= 1.25);

    // Delete user -> succeeds with foreign_keys=ON and preserves redemption_codes record with used_by_user_id=NULL
    deleteUserAccountWithCleanup(officialUserId, adminId);
    const deletedUser = db.prepare('SELECT id FROM users WHERE id = ?').get(officialUserId);
    assert.equal(deletedUser, undefined);

    const codeRow = db.prepare("SELECT status, used_by_user_id FROM redemption_codes WHERE code = 'TEST-CODE-88'").get() as any;
    assert.equal(codeRow.status, 'used');
    assert.equal(codeRow.used_by_user_id, null);
  });

  it('keeps debugSimulateInbound isolated in dry-run mode without persisting tasks or activation (A08)', async () => {
    saveGlobalApiConfig({
      api1: { endpoint: 'https://primary.llm/v1', apiKey: 'sk-primary-1234', model: 'deepseek-chat' },
    });
    setLlmExecutorForTest(async () => ({
      content: JSON.stringify({
        intent: 'create_task',
        title: '沙盒仿真任务',
        duration_minutes: 30,
        time_mode: 'flexible',
      }),
    }));

    const simReq: any = {
      user: { id: adminId },
      body: { userId: officialUserId, content: '帮我创建一个30分钟的仿真任务' },
    };
    const simMock = createMockResponse();
    await debugSimulateInbound(simReq, simMock.res);

    assert.equal(simMock.getStatus(), 200);
    assert.equal(simMock.getBody().dryRun, true);
    assert.equal((db.prepare('SELECT COUNT(*) as c FROM tasks WHERE user_id = ?').get(officialUserId) as any).c, 0);
    const s = db.prepare('SELECT weixin_activated FROM user_settings WHERE user_id = ?').get(officialUserId) as any;
    assert.equal(s.weixin_activated, 0);
  });

  it('gates email verification codes on SMTP success and skips cooldown after transport failure (A03)', async () => {
    const targetEmail = 'newuser@example.com';

    // 1. Simulate SMTP failure
    setEmailSenderForTest(async () => {
      throw new Error('SMTP connection timeout');
    });

    await assert.rejects(() => sendEmailVerificationCode(targetEmail, 'register'), /SMTP connection timeout|发送.*失败|timeout/i);

    const failedRow = db
      .prepare('SELECT code, delivery_status FROM email_verification_codes WHERE email = ? ORDER BY id DESC LIMIT 1')
      .get(targetEmail) as any;
    assert.equal(failedRow.delivery_status, 'send_failed');
    assert.equal(verifyEmailCode(targetEmail, failedRow.code, 'register'), false);

    // 2. Immediate retry succeeds (not blocked by 60s cooldown because previous failed)
    let sentCode = '';
    setEmailSenderForTest(async (opts) => {
      const m = String(opts.html).match(/\b(\d{6})\b/);
      sentCode = m ? m[1] : '';
    });

    const ok = await sendEmailVerificationCode(targetEmail, 'register');
    assert.equal(ok.success, true);
    assert.equal(sentCode.length, 6);
    assert.equal(verifyEmailCode(targetEmail, sentCode, 'register'), true);
  });
});
