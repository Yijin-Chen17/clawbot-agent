import type Database from 'better-sqlite3';
import { backfillLegacyData } from './backfill.js';

interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

function getColumnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map(r => r.name));
}

function ensureColumn(db: Database.Database, table: string, col: string, definition: string): void {
  const cols = getColumnNames(db, table);
  if (!cols.has(col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${definition};`);
  }
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'legacy_custom_api_mode_once',
    up: (db) => {
      // Run legacy api_mode migration strictly once rather than on every server boot (A07)
      db.exec(`
        UPDATE user_settings
        SET api_mode = 'custom'
        WHERE (llm_api_key IS NOT NULL AND TRIM(llm_api_key) != '')
          AND (api_mode IS NULL OR api_mode = 'official')
          AND user_id NOT IN (SELECT id FROM users WHERE balance > 0)
          AND user_id NOT IN (SELECT used_by_user_id FROM redemption_codes WHERE used_by_user_id IS NOT NULL);
      `);
    },
  },
  {
    version: 2,
    name: 'extend_existing_tables_for_v2_domain',
    up: (db) => {
      ensureColumn(db, 'users', 'session_version', 'INTEGER NOT NULL DEFAULT 1');

      ensureColumn(db, 'user_settings', 'timezone', "TEXT NOT NULL DEFAULT 'Asia/Shanghai'");
      ensureColumn(db, 'user_settings', 'weixin_status', "TEXT NOT NULL DEFAULT 'disconnected'");
      db.exec(`
        UPDATE user_settings
        SET weixin_status = CASE
          WHEN weixin_connected = 1 AND TRIM(COALESCE(weixin_bot_token, '')) != '' THEN 'connected'
          ELSE 'disconnected'
        END
        WHERE weixin_status IS NULL OR weixin_status = 'disconnected';
      `);

      ensureColumn(db, 'tasks', 'tags', "TEXT DEFAULT '[]'");
      ensureColumn(db, 'tasks', 'recurrence_rule', 'TEXT DEFAULT NULL');
      ensureColumn(db, 'tasks', 'version', 'INTEGER NOT NULL DEFAULT 1');
      ensureColumn(db, 'tasks', 'active_template', 'INTEGER NOT NULL DEFAULT 1');
      ensureColumn(db, 'tasks', 'source_fingerprint', 'TEXT DEFAULT NULL');

      ensureColumn(db, 'calendar_subscriptions', 'current_generation', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn(db, 'calendar_subscriptions', 'last_attempt_at', 'DATETIME DEFAULT NULL');
      ensureColumn(db, 'calendar_subscriptions', 'last_success_at', 'DATETIME DEFAULT NULL');

      ensureColumn(db, 'external_events', 'generation', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn(db, 'external_events', 'recurrence_id', 'TEXT DEFAULT NULL');
      ensureColumn(db, 'external_events', 'status', "TEXT NOT NULL DEFAULT 'CONFIRMED'");
      ensureColumn(db, 'external_events', 'transparency', "TEXT NOT NULL DEFAULT 'OPAQUE'");
      ensureColumn(db, 'external_events', 'occurrence_start', 'DATETIME DEFAULT NULL');

      ensureColumn(db, 'api_usage_logs', 'request_id', 'TEXT DEFAULT NULL');
      ensureColumn(db, 'api_usage_logs', 'user_hidden', 'INTEGER NOT NULL DEFAULT 0');

      ensureColumn(db, 'email_verification_codes', 'delivery_status', "TEXT NOT NULL DEFAULT 'sent'");
      ensureColumn(db, 'email_verification_codes', 'error_message', 'TEXT DEFAULT NULL');
    },
  },
  {
    version: 3,
    name: 'create_v2_core_tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_instances (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          business_date TEXT NOT NULL,
          instance_type TEXT NOT NULL DEFAULT 'once',
          status TEXT NOT NULL DEFAULT 'pending',
          estimated_minutes INTEGER NOT NULL DEFAULT 60,
          completed_minutes INTEGER NOT NULL DEFAULT 0,
          plan_status TEXT NOT NULL DEFAULT 'pending',
          allocated_minutes INTEGER NOT NULL DEFAULT 0,
          unallocated_minutes INTEGER NOT NULL DEFAULT 0,
          plan_reason TEXT DEFAULT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          started_at DATETIME DEFAULT NULL,
          completed_at DATETIME DEFAULT NULL,
          cancelled_at DATETIME DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(task_id, business_date)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_instances_once
          ON task_instances(task_id) WHERE instance_type = 'once';
        CREATE INDEX IF NOT EXISTS idx_task_instances_user_date
          ON task_instances(user_id, business_date, status);

        CREATE TABLE IF NOT EXISTS progress_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          command_id TEXT NOT NULL,
          instance_id INTEGER NOT NULL REFERENCES task_instances(id) ON DELETE CASCADE,
          block_id TEXT DEFAULT NULL,
          action TEXT NOT NULL,
          delta_minutes INTEGER NOT NULL DEFAULT 0,
          target_remaining_minutes INTEGER DEFAULT NULL,
          reason TEXT DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, command_id)
        );
        CREATE INDEX IF NOT EXISTS idx_progress_events_instance
          ON progress_events(instance_id, created_at);

        CREATE TABLE IF NOT EXISTS schedule_plans (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          trigger_source TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'committed',
          summary TEXT DEFAULT NULL,
          calendar_generation_snapshot TEXT DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, version)
        );

        CREATE TABLE IF NOT EXISTS schedule_blocks (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          plan_version INTEGER NOT NULL,
          instance_id INTEGER NOT NULL REFERENCES task_instances(id) ON DELETE CASCADE,
          task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          start_time DATETIME NOT NULL,
          end_time DATETIME NOT NULL,
          duration_minutes INTEGER NOT NULL,
          part_index INTEGER NOT NULL DEFAULT 1,
          total_parts INTEGER NOT NULL DEFAULT 1,
          is_fixed INTEGER NOT NULL DEFAULT 0,
          is_committed INTEGER NOT NULL DEFAULT 0,
          is_concurrent INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'planned',
          replaced_from_block_id TEXT DEFAULT NULL,
          energy_zone TEXT DEFAULT NULL,
          strategy_label TEXT DEFAULT NULL,
          break_after_minutes INTEGER DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_schedule_blocks_user_range
          ON schedule_blocks(user_id, status, start_time, end_time);
        CREATE INDEX IF NOT EXISTS idx_schedule_blocks_instance
          ON schedule_blocks(instance_id, status);

        CREATE TABLE IF NOT EXISTS schedule_proposals (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          base_plan_version INTEGER NOT NULL,
          reason_type TEXT NOT NULL,
          reason_text TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          expires_at DATETIME NOT NULL,
          resolved_at DATETIME DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_schedule_proposals_user_status
          ON schedule_proposals(user_id, status, expires_at);

        CREATE TABLE IF NOT EXISTS replan_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          reason TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          target_plan_version INTEGER DEFAULT NULL,
          error_message TEXT DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_replan_requests_user_status
          ON replan_requests(user_id, status);

        CREATE TABLE IF NOT EXISTS command_inbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          channel TEXT NOT NULL,
          channel_account_id TEXT NOT NULL DEFAULT '',
          sender_id TEXT NOT NULL DEFAULT '',
          external_msg_id TEXT NOT NULL,
          idempotency_key TEXT DEFAULT NULL,
          payload_hash TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'received',
          response_json TEXT DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, channel, external_msg_id)
        );
        CREATE INDEX IF NOT EXISTS idx_command_inbox_idem
          ON command_inbox(user_id, channel, idempotency_key);

        CREATE TABLE IF NOT EXISTS conversation_drafts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          channel TEXT NOT NULL,
          thread_key TEXT NOT NULL,
          intent TEXT NOT NULL,
          draft_json TEXT NOT NULL,
          missing_fields_json TEXT DEFAULT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          expires_at DATETIME NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, channel, thread_key)
        );

        CREATE TABLE IF NOT EXISTS notification_outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          instance_id INTEGER NOT NULL REFERENCES task_instances(id) ON DELETE CASCADE,
          block_id TEXT NOT NULL,
          plan_version INTEGER NOT NULL,
          reminder_type TEXT NOT NULL,
          channel TEXT NOT NULL DEFAULT 'auto',
          scheduled_fire_at DATETIME NOT NULL,
          expires_at DATETIME NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          idempotency_key TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_retry_at DATETIME DEFAULT NULL,
          provider_msg_id TEXT DEFAULT NULL,
          last_error TEXT DEFAULT NULL,
          lease_owner TEXT DEFAULT NULL,
          lease_until DATETIME DEFAULT NULL,
          payload_json TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(block_id, plan_version, reminder_type)
        );
        CREATE INDEX IF NOT EXISTS idx_notification_outbox_due
          ON notification_outbox(status, scheduled_fire_at, next_retry_at);

        CREATE TABLE IF NOT EXISTS calendar_ignored_instances (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subscription_id INTEGER NOT NULL REFERENCES calendar_subscriptions(id) ON DELETE CASCADE,
          event_uid TEXT NOT NULL,
          occurrence_start DATETIME NOT NULL,
          title TEXT DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, subscription_id, event_uid, occurrence_start)
        );

        CREATE TABLE IF NOT EXISTS llm_reservations (
          request_id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          purpose TEXT NOT NULL,
          model TEXT NOT NULL,
          reserved_cny REAL NOT NULL,
          actual_cny REAL DEFAULT NULL,
          status TEXT NOT NULL DEFAULT 'reserved',
          rate_snapshot_json TEXT NOT NULL,
          error_message TEXT DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          settled_at DATETIME DEFAULT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_llm_reservations_user
          ON llm_reservations(user_id, status);

        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          actor_user_id INTEGER DEFAULT NULL,
          target_user_id INTEGER DEFAULT NULL,
          action TEXT NOT NULL,
          detail_json TEXT DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS migration_reconcile_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT DEFAULT NULL,
          detail_json TEXT DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },
  {
    version: 4,
    name: 'redemption_codes_on_delete_set_null',
    up: (db) => {
      // Rebuild redemption_codes with ON DELETE SET NULL so user deletion preserves financial audit without FK failure (A09)
      db.exec(`
        CREATE TABLE redemption_codes_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT UNIQUE NOT NULL,
          amount REAL NOT NULL,
          status TEXT DEFAULT 'active',
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          used_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          used_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO redemption_codes_new (id, code, amount, status, created_by, used_by_user_id, used_at, created_at)
        SELECT id, code, amount, status, created_by, used_by_user_id, used_at, created_at FROM redemption_codes;
        DROP TABLE redemption_codes;
        ALTER TABLE redemption_codes_new RENAME TO redemption_codes;
      `);
    },
  },
  {
    version: 5,
    name: 'backfill_legacy_tasks_and_plans',
    up: (db) => {
      backfillLegacyData(db);
    },
  },
  {
    version: 6,
    name: 'add_query_indexes',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_user_status
          ON tasks(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_external_events_user_range
          ON external_events(user_id, start_time, end_time);
        CREATE INDEX IF NOT EXISTS idx_calendar_subscriptions_user
          ON calendar_subscriptions(user_id);
        CREATE INDEX IF NOT EXISTS idx_api_usage_logs_user_created
          ON api_usage_logs(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_email_codes_email_type
          ON email_verification_codes(email, type, created_at);
      `);
    },
  },
  {
    version: 7,
    name: 'external_event_policies_and_ai_reminders',
    up: (db) => {
      ensureColumn(db, 'external_events', 'course_group_key', 'TEXT DEFAULT NULL');
      ensureColumn(db, 'external_events', 'course_group_label', 'TEXT DEFAULT NULL');

      db.exec(`
        CREATE TABLE IF NOT EXISTS external_event_group_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subscription_id INTEGER NOT NULL DEFAULT 0,
          group_key TEXT NOT NULL,
          group_label TEXT NOT NULL,
          allow_scheduling INTEGER NOT NULL DEFAULT 0,
          ai_reminder_enabled INTEGER NOT NULL DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, subscription_id, group_key)
        );
        CREATE INDEX IF NOT EXISTS idx_ext_group_rules_user
          ON external_event_group_rules(user_id, subscription_id);

        CREATE TABLE IF NOT EXISTS external_event_overrides (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subscription_id INTEGER NOT NULL DEFAULT 0,
          event_uid TEXT NOT NULL,
          occurrence_start DATETIME NOT NULL,
          group_key TEXT DEFAULT NULL,
          title TEXT DEFAULT NULL,
          allow_scheduling INTEGER DEFAULT NULL,
          ai_reminder_enabled INTEGER DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, subscription_id, event_uid, occurrence_start)
        );
        CREATE INDEX IF NOT EXISTS idx_ext_overrides_user
          ON external_event_overrides(user_id, subscription_id);

        CREATE TABLE IF NOT EXISTS external_notification_outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          subscription_id INTEGER NOT NULL DEFAULT 0,
          event_uid TEXT NOT NULL,
          occurrence_start DATETIME NOT NULL,
          title TEXT NOT NULL,
          start_time DATETIME NOT NULL,
          end_time DATETIME NOT NULL,
          is_all_day INTEGER NOT NULL DEFAULT 0,
          allow_scheduling INTEGER NOT NULL DEFAULT 0,
          scheduled_fire_at DATETIME NOT NULL,
          expires_at DATETIME NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          idempotency_key TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_retry_at DATETIME DEFAULT NULL,
          provider_msg_id TEXT DEFAULT NULL,
          last_error TEXT DEFAULT NULL,
          lease_owner TEXT DEFAULT NULL,
          lease_until DATETIME DEFAULT NULL,
          payload_json TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, subscription_id, event_uid, occurrence_start, scheduled_fire_at)
        );
        CREATE INDEX IF NOT EXISTS idx_ext_notif_outbox_due
          ON external_notification_outbox(status, scheduled_fire_at, next_retry_at);
      `);
    },
  },
  {
    version: 8,
    name: 'weixin_reply_outbox',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS weixin_reply_outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          inbox_id INTEGER DEFAULT NULL,
          channel TEXT NOT NULL DEFAULT 'weixin_ilink',
          to_user_id TEXT NOT NULL,
          context_token TEXT DEFAULT NULL,
          text_content TEXT NOT NULL,
          image_kind TEXT DEFAULT NULL,
          image_base64 TEXT DEFAULT NULL,
          text_sent INTEGER NOT NULL DEFAULT 0,
          image_sent INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_retry_at DATETIME DEFAULT NULL,
          lease_owner TEXT DEFAULT NULL,
          lease_until DATETIME DEFAULT NULL,
          provider_msg_id TEXT DEFAULT NULL,
          last_error TEXT DEFAULT NULL,
          expires_at DATETIME NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_weixin_reply_outbox_due
          ON weixin_reply_outbox(status, next_retry_at, expires_at);
        CREATE INDEX IF NOT EXISTS idx_command_inbox_wx_pending
          ON command_inbox(user_id, channel, status, updated_at);
      `);
    },
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map(r => r.version));

  const insertMig = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');

  for (const mig of MIGRATIONS) {
    if (applied.has(mig.version)) continue;
    const fkBefore = db.pragma('foreign_keys', { simple: true });
    if (mig.version === 4) {
      db.pragma('foreign_keys = OFF');
    }
    try {
      db.transaction(() => {
        mig.up(db);
        insertMig.run(mig.version, mig.name);
      })();
    } finally {
      if (mig.version === 4) {
        db.pragma(`foreign_keys = ${fkBefore ? 'ON' : 'OFF'}`);
      }
    }
  }
}
