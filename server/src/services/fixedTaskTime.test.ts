import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFixedTaskTime } from './fixedTaskTime.js';

test('fixed execution time plus duration needs no deadline', () => {
  const plan = resolveFixedTaskTime({ is_fixed: true, fixed_start: '2026-11-23T19:00:00+08:00', duration_minutes: 60 });
  assert.equal(plan.fixed, true);
  assert.equal(plan.end, '2026-11-23T12:00:00.000Z');
  assert.equal(plan.duration, 60);
});

test('fixed time survives a follow-up providing duration', () => {
  const plan = resolveFixedTaskTime({ duration_minutes: 60 }, { is_fixed: true, fixed_start: '2026-11-23T19:00:00+08:00' });
  assert.equal(plan.end, '2026-11-23T12:00:00.000Z');
});

test('a deadline alone does not turn into a fixed appointment', () => {
  assert.equal(resolveFixedTaskTime({ deadline: '2026-11-23T19:00:00+08:00', duration_minutes: 60 }).fixed, false);
});
