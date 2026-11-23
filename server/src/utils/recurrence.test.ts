import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRecurrenceRule,
  stringifyRecurrenceRule,
  isDateMatchingRecurrence,
} from './recurrence.js';

test('parseRecurrenceRule defaults to daily', () => {
  assert.deepEqual(parseRecurrenceRule(null), { type: 'daily' });
  assert.deepEqual(parseRecurrenceRule(''), { type: 'daily' });
  assert.deepEqual(parseRecurrenceRule('{"type":"daily"}'), { type: 'daily' });
});

test('parseRecurrenceRule and stringifyRecurrenceRule handles weekly days', () => {
  const json = stringifyRecurrenceRule({ type: 'weekly', daysOfWeek: [0, 1, 2] });
  assert.equal(json, '{"type":"weekly","daysOfWeek":[0,1,2]}');
  const parsed = parseRecurrenceRule(json);
  assert.equal(parsed.type, 'weekly');
  assert.deepEqual(parsed.daysOfWeek, [0, 1, 2]);
});

test('isDateMatchingRecurrence correctly checks daily and weekly matches', () => {
  // 2026-11-23 is Monday (day 1)
  const monday = new Date(2026, 10, 23);
  // 2026-11-22 is Sunday (day 0)
  const sunday = new Date(2026, 10, 22);

  // Daily always matches
  assert.equal(isDateMatchingRecurrence(monday, { type: 'daily' }), true);
  assert.equal(isDateMatchingRecurrence(sunday, { type: 'daily' }), true);

  // Weekly [0] matches Sunday, not Monday
  const sundayOnly = { type: 'weekly' as const, daysOfWeek: [0] };
  assert.equal(isDateMatchingRecurrence(sunday, sundayOnly), true);
  assert.equal(isDateMatchingRecurrence(monday, sundayOnly), false);

  // Weekly [1, 2] matches Monday (1), not Sunday (0)
  const monTue = { type: 'weekly' as const, daysOfWeek: [1, 2] };
  assert.equal(isDateMatchingRecurrence(monday, monTue), true);
  assert.equal(isDateMatchingRecurrence(sunday, monTue), false);
});
