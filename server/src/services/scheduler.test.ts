import assert from 'node:assert/strict';
import test from 'node:test';
import type { Task, UserSettings } from '../models/types.js';
import {
  formatLocalDate,
  parseWorkSlotWindows,
  runSingleDaySchedule,
  splitIntoFocusSessions,
  taskToBusyEvents,
} from './scheduler.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    user_id: 1,
    title: '测试任务',
    duration_minutes: 60,
    urgency: 80,
    importance: 80,
    score_scale: 100,
    deadline: null,
    scheduled_start: null,
    scheduled_end: null,
    status: 'pending_slot',
    start_reminder_sent: 0,
    end_reminder_sent: 0,
    created_at: '2026-11-22T00:00:00.000Z',
    updated_at: '2026-11-22T00:00:00.000Z',
    ...overrides,
  };
}

test('parseWorkSlotWindows preserves disjoint windows and midnight boundaries', () => {
  const settings = {
    work_slots: JSON.stringify([
      { start: '09:00', end: '12:00' },
      { start: '13:00', end: '18:00' },
      { start: '19:00', end: '24:00' },
      { start: '00:00', end: '02:00' },
    ]),
  } as UserSettings;

  const parsed = parseWorkSlotWindows(settings);
  assert.equal(parsed.workStartHour, 0);
  assert.equal(parsed.workEndHour, 24);
  assert.deepEqual(parsed.workWindows, [
    { startHour: 0, endHour: 2 },
    { startHour: 9, endHour: 12 },
    { startHour: 13, endHour: 18 },
    { startHour: 19, endHour: 24 },
  ]);

  const endMidnightSettings = {
    work_slots: JSON.stringify([{ start: '19:00', end: '00:00' }]),
  } as UserSettings;
  const endMidnight = parseWorkSlotWindows(endMidnightSettings);
  assert.deepEqual(endMidnight.workWindows, [{ startHour: 19, endHour: 24 }]);

  const halfPastMidnight = parseWorkSlotWindows({
    work_slots: JSON.stringify([{ start: '00:00', end: '00:30' }]),
  } as UserSettings);
  assert.deepEqual(halfPastMidnight.workWindows, [{ startHour: 0, endHour: 0.5 }]);
});

test('runSingleDaySchedule respects disjoint workWindows and avoids sleeping hours & non-work gaps', () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  const { workStartHour, workEndHour, workWindows } = parseWorkSlotWindows({
    work_slots: JSON.stringify([
      { start: '09:00', end: '12:00' },
      { start: '13:00', end: '18:00' },
      { start: '19:00', end: '24:00' },
      { start: '00:00', end: '02:00' },
    ]),
  } as UserSettings);

  // Fill daytime morning and afternoon with fixed events so task must pick 19:00-20:00 (not 02:00-09:00!)
  const morningBusyStart = new Date(tomorrow);
  morningBusyStart.setHours(9, 0, 0, 0);
  const afternoonBusyEnd = new Date(tomorrow);
  afternoonBusyEnd.setHours(18, 0, 0, 0);

  const fixedEvents = [
    {
      id: 'ext-1',
      title: '全天会议',
      start: morningBusyStart,
      end: afternoonBusyEnd,
      isAllDay: false,
    },
  ];

  const task = makeTask({ id: 10, duration_minutes: 60, importance: 90, urgency: 90 });
  const res = runSingleDaySchedule([task], fixedEvents, {
    targetDate: tomorrow,
    workStartHour,
    workEndHour,
    workWindows,
  });

  assert.equal(res.scheduledBlocks.length, 1);
  const block = res.scheduledBlocks[0];
  const startHour = block.start.getHours() + block.start.getMinutes() / 60;
  // Must NOT be placed in 02:00-09:00 sleeping hours and should prefer 19:00 evening over 00:00-02:00 late night
  assert.ok(startHour >= 19 && startHour < 24, `Expected evening >=19:00, got hour=${startHour}`);
});

test('runSingleDaySchedule prioritizes slots ending before same-day deadline and allows deadline-day scheduling', () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  const deadline = new Date(tomorrow);
  deadline.setHours(14, 30, 0, 0);

  // Busy 08:00 - 12:30, leaving 13:00-14:30 (low energy, before DDL) and 15:00-18:00 (peak energy, AFTER DDL)
  const busyStart = new Date(tomorrow);
  busyStart.setHours(8, 0, 0, 0);
  const busyEnd = new Date(tomorrow);
  busyEnd.setHours(12, 30, 0, 0);

  const task = makeTask({
    id: 11,
    duration_minutes: 60,
    importance: 85,
    urgency: 90,
    deadline: deadline.toISOString(),
  });

  const res = runSingleDaySchedule([task], [
    { id: 'busy-am', title: '上午占用', start: busyStart, end: busyEnd, isAllDay: false },
  ], {
    targetDate: tomorrow,
    workStartHour: 8,
    workEndHour: 22,
    advanceDeadlineDays: 1,
  });

  assert.equal(res.scheduledBlocks.length, 1);
  assert.ok(
    res.scheduledBlocks[0].end.getTime() <= deadline.getTime(),
    `Expected block to end at or before ${deadline.toISOString()}, got ${res.scheduledBlocks[0].end.toISOString()}`
  );
});

test('taskToBusyEvents splits schedule_blocks cleanly and projects locked daily_fixed tasks', () => {
  const day1Start = '2026-11-23T09:00:00.000Z';
  const day1End = '2026-11-23T10:00:00.000Z';
  const day2Start = '2026-11-24T15:00:00.000Z';
  const day2End = '2026-11-24T16:00:00.000Z';

  const splitTask = makeTask({
    id: 21,
    title: '分段长任务',
    scheduled_start: day1Start,
    scheduled_end: day2End,
    schedule_blocks: JSON.stringify([
      { start: day1Start, end: day1End, completed: true },
      { start: day2Start, end: day2End, completed: false },
    ]),
  });

  // Only uncompleted block (day2) should be emitted, NOT one 31-hour span from day1Start to day2End!
  const splitBusy = taskToBusyEvents(splitTask, 'task');
  assert.equal(splitBusy.length, 1);
  assert.equal(splitBusy[0].start.toISOString(), day2Start);
  assert.equal(splitBusy[0].end.toISOString(), day2End);

  const baseDate = new Date(2026, 10, 22, 10, 0, 0, 0);
  const dailyStart = new Date(2026, 10, 22, 19, 0, 0, 0);
  const dailyEnd = new Date(2026, 10, 22, 20, 0, 0, 0);
  const doneTomorrowKey = formatLocalDate(new Date(2026, 10, 23, 0, 0, 0, 0));

  const dailyFixedTask = makeTask({
    id: 22,
    title: '每日运动',
    time_mode: 'daily_fixed',
    is_fixed: 1,
    scheduled_start: dailyStart.toISOString(),
    scheduled_end: dailyEnd.toISOString(),
    completed_dates: JSON.stringify([doneTomorrowKey]),
  });

  const projected = taskToBusyEvents(dailyFixedTask, 'fixed-task', baseDate, 3);
  // Day 0 (22nd) + Day 2 (24th), skipping Day 1 (23rd) because it is in completed_dates
  assert.equal(projected.length, 2);
  assert.equal(formatLocalDate(projected[0].start), formatLocalDate(baseDate));
  assert.equal(formatLocalDate(projected[1].start), formatLocalDate(new Date(2026, 10, 24)));
});

test('parseWorkSlotWindows handles overnight slots and plain-text strings', () => {
  const overnight = parseWorkSlotWindows({
    work_slots: JSON.stringify([{ start: '20:00', end: '02:00' }]),
  } as UserSettings);
  assert.equal(overnight.workStartHour, 0);
  assert.equal(overnight.workEndHour, 24);
  assert.deepEqual(overnight.workWindows, [
    { startHour: 0, endHour: 2 },
    { startHour: 20, endHour: 24 },
  ]);

  const plainText = parseWorkSlotWindows({
    work_slots: '09:00-12:00, 14:00-18:00',
  } as UserSettings);
  assert.equal(plainText.workStartHour, 9);
  assert.equal(plainText.workEndHour, 18);
  assert.deepEqual(plainText.workWindows, [
    { startHour: 9, endHour: 12 },
    { startHour: 14, endHour: 18 },
  ]);
});

test('runSingleDaySchedule strictly clamps blocks within workWindows without fractional overshoot', () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  const { workStartHour, workEndHour, workWindows } = parseWorkSlotWindows({
    work_slots: JSON.stringify([{ start: '14:00', end: '18:00' }]),
  } as UserSettings);

  // External event ends at 16:50:20, leaving 59m40s + 10m buffer? Use bufferMinutes=0 -> 59m40s before 18:00:00.
  // Should NOT schedule a 60m block that spills to 18:00:20 past work window end 18:00:00!
  const extStart = new Date(tomorrow);
  extStart.setHours(14, 0, 0, 0);
  const extEnd = new Date(tomorrow);
  extEnd.setHours(17, 0, 20, 0);

  const task = makeTask({ id: 31, duration_minutes: 60, importance: 90, urgency: 90 });
  const res = runSingleDaySchedule([task], [
    { id: 'ext-sec', title: '带秒会议', start: extStart, end: extEnd, isAllDay: false },
  ], {
    targetDate: tomorrow,
    workStartHour,
    workEndHour,
    workWindows,
    bufferMinutes: 0,
  });

  const windowEnd = new Date(tomorrow);
  windowEnd.setHours(18, 0, 0, 0);
  for (const b of res.scheduledBlocks) {
    assert.ok(b.end.getTime() <= windowEnd.getTime(), `Block ${b.end.toISOString()} exceeded work window end ${windowEnd.toISOString()}`);
  }
});



test('focus sessions balance the task duration instead of defaulting to one hour', () => {
  assert.deepEqual(splitIntoFocusSessions(150), [75, 75]);
  assert.deepEqual(splitIntoFocusSessions(70), [70]);
  assert.equal(splitIntoFocusSessions(181).reduce((a, b) => a + b, 0), 181);
  assert.ok(splitIntoFocusSessions(181).every(minutes => minutes <= 90));
});

test('all-day events and fractional busy boundaries are never scheduled over', () => {
  const day = new Date();
  day.setDate(day.getDate() + 1);
  day.setHours(0, 0, 0, 0);
  const nextDay = new Date(day);
  nextDay.setDate(nextDay.getDate() + 1);
  const allDay = runSingleDaySchedule([makeTask()], [
    { id: 'all', title: '忙碌', start: day, end: nextDay, isAllDay: true },
  ], { targetDate: day });
  assert.equal(allDay.scheduledBlocks.length, 0);

  const busyStart = new Date(day); busyStart.setHours(9, 59, 40, 0);
  const busyEnd = new Date(day); busyEnd.setHours(22, 0, 0, 0);
  const result = runSingleDaySchedule([makeTask({ duration_minutes: 60 })], [
    { id: 'busy', title: '会议', start: busyStart, end: busyEnd, isAllDay: false },
  ], { targetDate: day, workStartHour: 9, workEndHour: 22, bufferMinutes: 0 });
  assert.ok(result.scheduledBlocks.every(block => block.end <= busyStart || block.start >= busyEnd));
});
