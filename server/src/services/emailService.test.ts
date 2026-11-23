import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildVerificationEmailContent,
  clearVerifyFailures,
  isValidEmail,
  recordVerifyFailure,
} from './emailService.js';

test('isValidEmail validates basic email formats', () => {
  assert.equal(isValidEmail('user@example.com'), true);
  assert.equal(isValidEmail('invalid-email'), false);
  assert.equal(isValidEmail('user@'), false);
});

test('buildVerificationEmailContent differentiates register and reset_password templates', () => {
  const regZh = buildVerificationEmailContent('register', 'zh');
  assert.match(regZh.subject, /邮箱注册验证码/);
  assert.match(regZh.bodyDesc, /正在注册/);

  const resetZh = buildVerificationEmailContent('reset_password', 'zh');
  assert.match(resetZh.subject, /重置密码验证码/);
  assert.match(resetZh.bodyDesc, /重置.*登录密码/);

  const resetEn = buildVerificationEmailContent('reset_password', 'en');
  assert.match(resetEn.subject, /Password Reset Verification Code/);
  assert.match(resetEn.bodyDesc, /reset your/i);
});

test('recordVerifyFailure locks out after 5 failed attempts and resets on clearVerifyFailures', () => {
  const key = 'reset_password:test-lockout@example.com';
  const t0 = 1_700_000_000_000;
  clearVerifyFailures(key);

  assert.equal(recordVerifyFailure(key, t0), false);
  assert.equal(recordVerifyFailure(key, t0 + 1000), false);
  assert.equal(recordVerifyFailure(key, t0 + 2000), false);
  assert.equal(recordVerifyFailure(key, t0 + 3000), false);
  assert.equal(recordVerifyFailure(key, t0 + 4000), true);

  clearVerifyFailures(key);
  assert.equal(recordVerifyFailure(key, t0 + 5000), false);
});
