import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { getAppConfig } from './appConfig.js';
import { getDataDir, getDbPath } from './env.js';
import { runMigrations } from './migrations.js';
import { getGlobalApiConfig } from '../services/globalApiConfig.js';

function openDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (dbPath !== ':memory:' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const instance = new Database(dbPath);
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  instance.pragma('busy_timeout = 5000');
  instance.pragma('synchronous = NORMAL');
  return instance;
}

const initialDataDir = getDataDir();
if (!fs.existsSync(initialDataDir)) {
  fs.mkdirSync(initialDataDir, { recursive: true });
}

export let db: Database.Database = openDatabase(getDbPath());

/**
 * Switch database instance for isolated automated testing.
 */
export function useTestDatabase(dbPath: string = ':memory:'): Database.Database {
  try {
    db.close();
  } catch {}
  db = openDatabase(dbPath);
  initDatabase();
  return db;
}

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'pending',
      token_secret TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      llm_endpoint TEXT DEFAULT 'https://api.deepseek.com/v1',
      llm_api_key TEXT DEFAULT '',
      llm_model TEXT DEFAULT 'deepseek-chat',
      clawbot_webhook_token TEXT DEFAULT '',
      clawbot_outbound_url TEXT DEFAULT '',
      clawbot_outbound_key TEXT DEFAULT '',
      clawbot_to_wxid TEXT DEFAULT '',
      work_slots TEXT DEFAULT '[{"start":"09:00","end":"12:00"},{"start":"13:00","end":"18:00"},{"start":"19:00","end":"24:00"},{"start":"00:00","end":"02:00"}]',
      task_buffer_minutes INTEGER DEFAULT 10,
      reminder_before_start_minutes INTEGER DEFAULT 5,
      reminder_before_end_minutes INTEGER DEFAULT 5,
      calendar_sync_interval_minutes INTEGER DEFAULT 60,
      weixin_connected INTEGER DEFAULT 0,
      weixin_bot_token TEXT DEFAULT '',
      weixin_bot_id TEXT DEFAULT '',
      weixin_user_id TEXT DEFAULT '',
      weixin_base_url TEXT DEFAULT 'https://ilinkai.weixin.qq.com',
      weixin_sync_buf TEXT DEFAULT '',
      weixin_nickname TEXT DEFAULT '',
      weixin_context_token TEXT DEFAULT '',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS calendar_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      last_sync_at DATETIME,
      sync_status TEXT DEFAULT 'ok',
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS external_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subscription_id INTEGER REFERENCES calendar_subscriptions(id) ON DELETE CASCADE,
      uid TEXT,
      title TEXT NOT NULL,
      start_time DATETIME NOT NULL,
      end_time DATETIME NOT NULL,
      is_all_day INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      urgency INTEGER DEFAULT 50,
      importance INTEGER DEFAULT 50,
      deadline DATETIME,
      scheduled_start DATETIME,
      scheduled_end DATETIME,
      status TEXT NOT NULL DEFAULT 'scheduled',
      notes TEXT,
      start_reminder_sent INTEGER DEFAULT 0,
      end_reminder_sent INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS conversation_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      current_intent TEXT,
      pending_task_json TEXT,
      missing_fields TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS api_usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
      cache_miss_tokens INTEGER NOT NULL DEFAULT 0,
      is_peak INTEGER NOT NULL DEFAULT 0,
      cost_cny REAL NOT NULL DEFAULT 0,
      input_cost_cny REAL NOT NULL DEFAULT 0,
      output_cost_cny REAL NOT NULL DEFAULT 0,
      request_type TEXT DEFAULT 'weixin_chat',
      is_official INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS email_verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'register',
      expires_at DATETIME NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS redemption_codes (
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

  const subscriptionColumns = (db.prepare('PRAGMA table_info(calendar_subscriptions)').all() as { name: string }[]).map(c => c.name);
  if (!subscriptionColumns.includes('color')) db.exec('ALTER TABLE calendar_subscriptions ADD COLUMN color TEXT DEFAULT NULL');

  // Migrate user_settings columns if missing
  const columns = (db.prepare('PRAGMA table_info(user_settings)').all() as any[]).map(c => c.name);
  const addCol = (name: string, type: string, def: string) => {
    if (!columns.includes(name)) {
      db.exec(`ALTER TABLE user_settings ADD COLUMN ${name} ${type} DEFAULT ${def};`);
    }
  };
  addCol('calendar_color', 'TEXT', 'NULL');
  addCol('api_mode', 'TEXT', "'official'");
  addCol('weixin_connected', 'INTEGER', '0');
  addCol('weixin_bot_token', 'TEXT', "''");
  addCol('weixin_bot_id', 'TEXT', "''");
  addCol('weixin_user_id', 'TEXT', "''");
  addCol('weixin_base_url', 'TEXT', "'https://ilinkai.weixin.qq.com'");
  addCol('weixin_sync_buf', 'TEXT', "''");
  addCol('weixin_nickname', 'TEXT', "''");
  addCol('weixin_context_token', 'TEXT', "''");
  addCol('advance_deadline_days', 'INTEGER', '1');
  addCol('weixin_activated', 'INTEGER', '0');
  addCol('weixin_last_active_at', 'DATETIME', 'NULL');

  // Migrate api_usage_logs columns if missing (is_official)
  const usageCols = (db.prepare('PRAGMA table_info(api_usage_logs)').all() as any[]).map(c => c.name);
  if (!usageCols.includes('is_official')) {
    db.exec("ALTER TABLE api_usage_logs ADD COLUMN is_official INTEGER DEFAULT 0;");
  }

  // Migrate users table columns if missing (nickname, avatar_url, email)
  const userCols = (db.prepare('PRAGMA table_info(users)').all() as any[]).map(c => c.name);
  if (!userCols.includes('nickname')) {
    db.exec("ALTER TABLE users ADD COLUMN nickname TEXT DEFAULT '';");
  }
  if (!userCols.includes('avatar_url')) {
    db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT '';");
  }
  if (!userCols.includes('email')) {
    db.exec("ALTER TABLE users ADD COLUMN email TEXT DEFAULT NULL;");
  }
  if (!userCols.includes('balance')) {
    db.exec("ALTER TABLE users ADD COLUMN balance REAL DEFAULT 0.0;");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL AND email != '';");

  // Initialize default system settings for global LLM if not present
  const existingGlobalEndpoint = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('global_llm_endpoint');
  if (!existingGlobalEndpoint) {
    db.prepare('INSERT INTO system_settings (key, value) VALUES (?, ?)').run('global_llm_endpoint', 'https://api.deepseek.com/v1');
  }
  const existingGlobalModel = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('global_llm_model');
  if (!existingGlobalModel) {
    db.prepare('INSERT INTO system_settings (key, value) VALUES (?, ?)').run('global_llm_model', 'deepseek-chat');
  }
  const existingGlobalKey = db.prepare('SELECT value FROM system_settings WHERE key = ?').get('global_llm_api_key');
  if (!existingGlobalKey && process.env.DEEPSEEK_API_KEY) {
    db.prepare('INSERT INTO system_settings (key, value) VALUES (?, ?)').run('global_llm_api_key', process.env.DEEPSEEK_API_KEY);
  }
  const initPriceSetting = (k: string, val: string) => {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(k);
    if (!row) {
      db.prepare('INSERT INTO system_settings (key, value) VALUES (?, ?)').run(k, val);
    }
  };
  initPriceSetting('global_llm_price_input', '2.0');
  initPriceSetting('global_llm_price_output', '8.0');
  initPriceSetting('global_llm_price_cache_hit', '0.5');

  // Migrate tasks table columns if missing
  const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as any[]).map(c => c.name);
  if (!taskCols.includes('deadline_kind')) db.exec("ALTER TABLE tasks ADD COLUMN deadline_kind TEXT DEFAULT 'soft';");
  if (!taskCols.includes('session_plan')) db.exec('ALTER TABLE tasks ADD COLUMN session_plan TEXT DEFAULT NULL;');
  if (!taskCols.includes('schedule_blocks')) {
    db.exec('ALTER TABLE tasks ADD COLUMN schedule_blocks TEXT DEFAULT NULL;');
  }
  if (!taskCols.includes('is_fixed')) {
    db.exec('ALTER TABLE tasks ADD COLUMN is_fixed INTEGER DEFAULT 0;');
  }
  if (!taskCols.includes('is_concurrent')) {
    db.exec('ALTER TABLE tasks ADD COLUMN is_concurrent INTEGER DEFAULT 0;');
  }
  if (!taskCols.includes('original_duration_minutes')) {
    db.exec('ALTER TABLE tasks ADD COLUMN original_duration_minutes INTEGER DEFAULT 0;');
  }
  if (!taskCols.includes('importance_tier')) {
    db.exec('ALTER TABLE tasks ADD COLUMN importance_tier TEXT DEFAULT NULL;');
  }
  if (!taskCols.includes('impact_signals')) {
    db.exec("ALTER TABLE tasks ADD COLUMN impact_signals TEXT DEFAULT '[]';");
  }
  if (!taskCols.includes('time_mode')) {
    db.exec("ALTER TABLE tasks ADD COLUMN time_mode TEXT DEFAULT 'deadline';");
  }
  if (!taskCols.includes('urgency_pace')) {
    db.exec("ALTER TABLE tasks ADD COLUMN urgency_pace TEXT DEFAULT 'soon';");
  }
  if (!taskCols.includes('importance_manual_override')) {
    db.exec('ALTER TABLE tasks ADD COLUMN importance_manual_override INTEGER DEFAULT NULL;');
  }
  if (!taskCols.includes('completed_dates')) {
    db.exec("ALTER TABLE tasks ADD COLUMN completed_dates TEXT DEFAULT '[]';");
  }
  if (!taskCols.includes('recurrence_rule')) {
    db.exec("ALTER TABLE tasks ADD COLUMN recurrence_rule TEXT DEFAULT NULL;");
  }
  if (!taskCols.includes('score_scale')) {
    db.exec('ALTER TABLE tasks ADD COLUMN score_scale INTEGER DEFAULT 100;');
    db.exec(`
      UPDATE tasks
      SET
        importance = CASE
          WHEN importance > 10 THEN MIN(100, MAX(0, ROUND(importance)))
          WHEN importance <= 5 AND urgency <= 5 THEN MIN(100, MAX(0, ROUND(importance * 20)))
          ELSE MIN(100, MAX(0, ROUND(importance * 10)))
        END,
        urgency = CASE
          WHEN urgency > 10 THEN MIN(100, MAX(0, ROUND(urgency)))
          WHEN importance <= 5 AND urgency <= 5 THEN MIN(100, MAX(0, ROUND(urgency * 20)))
          ELSE MIN(100, MAX(0, ROUND(urgency * 10)))
        END,
        score_scale = 100;
    `);
  }

  // Run versioned v2 schema migrations and legacy backfill
  runMigrations(db);

  // 初始化独立持久化配置文件并同步数据
  try {
    getGlobalApiConfig();
  } catch (err: any) {
    console.warn('[DB] Failed to init global API config:', err.message);
  }

  // Seed initial admin if database has no users
  const config = getAppConfig();
  const defaultAdminPassword = config.admin_default_password || process.env.ADMIN_DEFAULT_PASSWORD || '123456';
  const userCount = db.prepare('SELECT count(*) as count FROM users').get() as { count: number };
  if (userCount.count === 0) {
    const salt = bcrypt.genSaltSync(10);
    const hash = bcrypt.hashSync(defaultAdminPassword, salt);
    const secret = crypto.randomBytes(24).toString('hex');
    const webhookToken = crypto.randomBytes(16).toString('hex');

    const result = db.prepare(`
      INSERT INTO users (username, email, password_hash, role, status, token_secret)
      VALUES (?, 'admin@clawbot.local', ?, 'admin', 'approved', ?)
    `).run('admin', hash, secret);

    const adminId = result.lastInsertRowid;
    db.prepare(`
      INSERT INTO user_settings (user_id, clawbot_webhook_token)
      VALUES (?, ?)
    `).run(adminId, webhookToken);

    console.log('🌟 [DB] Initial superadmin account initialized (username: admin)');
  }
}
