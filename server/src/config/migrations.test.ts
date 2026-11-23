import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';
import { backfillLegacyData, reconcileDatabase } from './backfill.js';

describe('Schema Migrations v1-v5, Legacy Backfill & Reconciliation', () => {
  it('migrates a legacy pre-v2 SQLite schema, backfills tasks/daily/blocks idempotently, and respects once-only api_mode switch (A07)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbot-mig-'));
    const dbPath = path.join(tmpDir, 'legacy.db');
    const legacyDb = new Database(dbPath);

    try {
      // Seed pure v1 schema before refactoring
      legacyDb.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user',
          status TEXT NOT NULL DEFAULT 'approved',
          token_secret TEXT NOT NULL,
          email TEXT,
          balance REAL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE user_settings (
          user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          llm_endpoint TEXT DEFAULT 'https://api.deepseek.com/v1',
          llm_api_key TEXT DEFAULT '',
          llm_model TEXT DEFAULT 'deepseek-chat',
          api_mode TEXT DEFAULT 'official',
          clawbot_webhook_token TEXT DEFAULT '',
          work_slots TEXT DEFAULT '[{"start":"09:00","end":"18:00"}]',
          weixin_connected INTEGER DEFAULT 0,
          weixin_bot_token TEXT DEFAULT ''
        );

        CREATE TABLE calendar_subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          url TEXT NOT NULL,
          last_sync_at DATETIME
        );

        CREATE TABLE external_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subscription_id INTEGER REFERENCES calendar_subscriptions(id) ON DELETE CASCADE,
          uid TEXT,
          title TEXT NOT NULL,
          start_time DATETIME NOT NULL,
          end_time DATETIME NOT NULL
        );

        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          duration_minutes INTEGER NOT NULL,
          original_duration_minutes INTEGER DEFAULT 0,
          urgency INTEGER DEFAULT 50,
          importance INTEGER DEFAULT 50,
          deadline DATETIME,
          deadline_kind TEXT DEFAULT 'soft',
          scheduled_start DATETIME,
          scheduled_end DATETIME,
          schedule_blocks TEXT DEFAULT NULL,
          is_fixed INTEGER DEFAULT 0,
          is_concurrent INTEGER DEFAULT 0,
          time_mode TEXT DEFAULT 'deadline',
          completed_dates TEXT DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'scheduled',
          notes TEXT,
          start_reminder_sent INTEGER DEFAULT 0,
          end_reminder_sent INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE api_usage_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          model TEXT NOT NULL,
          cost_cny REAL NOT NULL DEFAULT 0,
          is_official INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE email_verification_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL,
          code TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'register',
          expires_at DATETIME NOT NULL,
          used INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE redemption_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT UNIQUE NOT NULL,
          amount REAL NOT NULL,
          status TEXT DEFAULT 'active',
          created_by INTEGER REFERENCES users(id),
          used_by_user_id INTEGER REFERENCES users(id),
          used_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      legacyDb
        .prepare("INSERT INTO users (username, password_hash, role, status, token_secret) VALUES ('u1', 'h', 'user', 'approved', 's')")
        .run();
      legacyDb
        .prepare("INSERT INTO user_settings (user_id, llm_api_key, api_mode) VALUES (1, 'sk-custom-user-key', 'official')")
        .run();

      // Legacy once task with JSON schedule_blocks
      legacyDb
        .prepare(`
          INSERT INTO tasks (user_id, title, duration_minutes, original_duration_minutes, scheduled_start, scheduled_end, schedule_blocks, status)
          VALUES (1, '历史普通任务', 90, 90, '2026-12-01T09:00:00.000Z', '2026-12-01T10:30:00.000Z', ?, 'scheduled')
        `)
        .run(
          JSON.stringify([
            { start: '2026-12-01T09:00:00.000Z', end: '2026-12-01T09:45:00.000Z', duration: 45, partIndex: 1, totalParts: 2 },
            { start: '2026-12-01T09:55:00.000Z', end: '2026-12-01T10:40:00.000Z', duration: 45, partIndex: 2, totalParts: 2 },
          ])
        );

      // Legacy daily task with completed_dates
      legacyDb
        .prepare(`
          INSERT INTO tasks (user_id, title, duration_minutes, original_duration_minutes, time_mode, is_fixed, scheduled_start, scheduled_end, completed_dates, status)
          VALUES (1, '历史每日任务', 30, 30, 'daily_fixed', 1, '2026-12-01T20:00:00.000Z', '2026-12-01T20:30:00.000Z', ?, 'scheduled')
        `)
        .run(JSON.stringify(['2026-11-29', '2026-11-30']));

      // First migration run
      runMigrations(legacyDb);

      const s1 = legacyDb.prepare('SELECT api_mode FROM user_settings WHERE user_id = 1').get() as any;
      assert.equal(s1.api_mode, 'custom'); // Migrated once from official -> custom

      // Switch explicitly back to official & re-run migrations -> MUST NOT overwrite user's choice
      legacyDb.prepare("UPDATE user_settings SET api_mode = 'official' WHERE user_id = 1").run();
      runMigrations(legacyDb);
      backfillLegacyData(legacyDb); // Also verify idempotency

      const s2 = legacyDb.prepare('SELECT api_mode FROM user_settings WHERE user_id = 1').get() as any;
      assert.equal(s2.api_mode, 'official');

      const report = reconcileDatabase(legacyDb);
      assert.equal(report.taskCount, 2);
      assert.equal(report.blockCount, 2);
      assert.ok(report.instanceCount >= 3); // 1 once instance + 2 daily completed_dates instances
      assert.equal(report.issues.length, 0);
    } finally {
      legacyDb.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reconciles a non-mutating temp copy of workspace data/clawbot.db cleanly if present', () => {
    const liveDbPath = path.resolve(process.cwd(), 'data', 'clawbot.db');
    if (!fs.existsSync(liveDbPath)) {
      return; // Skip gracefully when no workspace snapshot exists
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawbot-snap-'));
    const copyPath = path.join(tmpDir, 'snapshot.db');
    fs.copyFileSync(liveDbPath, copyPath);
    const snapDb = new Database(copyPath);

    try {
      const hasUsers = snapDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
      if (!hasUsers) {
        return; // Uninitialized / empty db placeholder
      }
      runMigrations(snapDb);
      const report = reconcileDatabase(snapDb);
      assert.equal(report.issues.length, 0);
      assert.ok(report.instanceCount >= report.taskCount || report.taskCount === 0);
    } finally {
      snapDb.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
