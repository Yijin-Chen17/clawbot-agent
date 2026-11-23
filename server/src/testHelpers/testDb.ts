import fs from 'fs';
import os from 'os';
import path from 'path';
import { db, useTestDatabase } from '../config/database.js';
import { setLlmExecutorForTest } from '../services/llm.js';
import { setEmailSenderForTest } from '../services/emailService.js';
import { setCalendarFetcherForTest } from '../services/calendarSync.js';
import { setOutboundSenderForTest } from '../services/clawbot.js';
import { zonedWallClockToUtc } from '../utils/timezone.js';

export function wallClockIso(dateKey: string, hh: number, mm: number, tz: string = 'Asia/Shanghai'): string {
  return zonedWallClockToUtc(dateKey, hh, mm, 0, 0, tz).toISOString();
}

export function setupIsolatedTestEnv(): { tempDir: string; cleanup: () => void } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbot-test-'));
  process.env.CLAWBOT_DATA_DIR = tempDir;
  process.env.JWT_SECRET = 'test-jwt-secret-key';
  useTestDatabase(':memory:');

  return {
    tempDir,
    cleanup: () => {
      setLlmExecutorForTest(null);
      setEmailSenderForTest(null);
      setCalendarFetcherForTest(null);
      setOutboundSenderForTest(null);
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

export function seedTestUser(opts?: {
  username?: string;
  email?: string;
  role?: 'admin' | 'user';
  status?: 'pending' | 'approved' | 'rejected' | 'banned';
  timezone?: string;
  apiMode?: 'official' | 'custom';
  balance?: number;
  workSlotsJson?: string;
}): { userId: number; username: string } {
  const username = opts?.username || `user_${Math.random().toString(36).slice(2, 8)}`;
  const email = opts?.email || `${username}@example.com`;
  const role = opts?.role || 'user';
  const status = opts?.status || 'approved';
  const timezone = opts?.timezone || 'Asia/Shanghai';
  const apiMode = opts?.apiMode || 'custom';
  const balance = opts?.balance ?? 100;

  const info = db
    .prepare(
      `INSERT INTO users (
        username, password_hash, role, status, token_secret, email,
        balance, session_version
      ) VALUES (?, 'hashed', ?, ?, 'secret-token', ?, ?, 1)`
    )
    .run(username, role, status, email, balance);

  const userId = Number(info.lastInsertRowid);
  const defaultWorkSlots =
    opts?.workSlotsJson ||
    JSON.stringify([
      { start: '09:00', end: '12:00' },
      { start: '13:00', end: '18:00' },
      { start: '19:00', end: '22:00' },
    ]);

  db.prepare(
    `INSERT INTO user_settings (
      user_id, api_mode, llm_endpoint, llm_api_key, llm_model,
      clawbot_webhook_token, clawbot_outbound_url, clawbot_outbound_key, clawbot_to_wxid,
      work_slots, task_buffer_minutes, reminder_before_start_minutes, reminder_before_end_minutes,
      timezone, advance_deadline_days
    ) VALUES (?, ?, 'https://mock.llm/v1', 'mock-key', 'mock-model', ?, ?, ?, ?, ?, 10, 5, 5, ?, 2)`
  ).run(
    userId,
    apiMode,
    `wh_${username}`,
    'https://outbound.example/push',
    'outbound-secret',
    'wxid_test_1',
    defaultWorkSlots,
    timezone
  );

  return { userId, username };
}

export function createMockResponse(): {
  res: any;
  getStatus: () => number;
  getBody: () => any;
} {
  let statusCode = 200;
  let body: any = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      body = data;
      return res;
    },
    send(data: any) {
      body = data;
      return res;
    },
    setHeader() {
      return res;
    },
  };
  return {
    res,
    getStatus: () => statusCode,
    getBody: () => body,
  };
}
