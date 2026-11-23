import fs from 'fs';
import path from 'path';
import { db } from '../config/database.js';
import { getDataDir } from '../config/env.js';

export interface GlobalApiNode {
  endpoint: string;
  apiKey: string;
  model: string;
  enabled?: boolean;
}

export interface GlobalApiPricing {
  priceInput: number;
  priceOutput: number;
  priceCacheHit: number;
}

export interface GlobalApiFullConfig {
  api1: GlobalApiNode;
  api2: GlobalApiNode;
  pricing: GlobalApiPricing;
  configVersion: number;
  updatedAt: string;
}

function getGlobalConfigFilePath(): string {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'global_api_config.json');
}

export const GLOBAL_API_CONFIG_FILE = getGlobalConfigFilePath();

export function parseNonNegativeRate(raw: unknown, fallback: number): number {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(num) || num < 0) return fallback;
  return num;
}

/**
 * 脱敏 API Key 显示
 */
export function maskApiKey(key: string): string {
  if (!key) return '';
  const trimmed = key.trim();
  if (trimmed.length > 8) {
    return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
  }
  return '****';
}

function getDbSettingRaw(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

function getDbSetting(key: string, def: string = ''): string {
  try {
    const val = getDbSettingRaw(key);
    return val !== undefined && val !== null ? val : def;
  } catch {
    return def;
  }
}

function setDbSettingStrict(key: string, value: string): void {
  db.prepare(`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, value);
}

function saveConfigFileStrict(config: GlobalApiFullConfig): void {
  const filePath = getGlobalConfigFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), 'utf-8');
  fs.renameSync(tmpFile, filePath);
}

function persistConfigToDb(config: GlobalApiFullConfig): void {
  setDbSettingStrict('global_llm_endpoint', config.api1.endpoint);
  setDbSettingStrict('global_llm_model', config.api1.model);
  setDbSettingStrict('global_llm_api_key', config.api1.apiKey);

  setDbSettingStrict('global_llm_backup_endpoint', config.api2.endpoint);
  setDbSettingStrict('global_llm_backup_model', config.api2.model);
  setDbSettingStrict('global_llm_backup_enabled', config.api2.enabled ? 'true' : 'false');
  setDbSettingStrict('global_llm_backup_api_key', config.api2.apiKey);

  setDbSettingStrict('global_llm_price_input', String(config.pricing.priceInput));
  setDbSettingStrict('global_llm_price_output', String(config.pricing.priceOutput));
  setDbSettingStrict('global_llm_price_cache_hit', String(config.pricing.priceCacheHit));
  setDbSettingStrict('global_llm_config_version', String(config.configVersion));
  setDbSettingStrict('global_llm_updated_at', config.updatedAt);
}

/**
 * 读取全局大模型配置：以 SQLite system_settings（带版本号）为权威数据源，
 * 首次迁移时兼容导入既有 global_api_config.json（A10, A11）。
 */
export function getGlobalApiConfig(): GlobalApiFullConfig {
  const existingVersionRaw = getDbSettingRaw('global_llm_config_version');
  const filePath = getGlobalConfigFilePath();

  if (existingVersionRaw === undefined && fs.existsSync(filePath)) {
    // One-time import from legacy JSON file into authoritative SQLite store
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content) as Partial<GlobalApiFullConfig>;
      const seeded: GlobalApiFullConfig = {
        api1: {
          endpoint: parsed.api1?.endpoint || getDbSetting('global_llm_endpoint', 'https://api.deepseek.com/v1'),
          apiKey: parsed.api1?.apiKey || getDbSetting('global_llm_api_key', process.env.DEEPSEEK_API_KEY || ''),
          model: parsed.api1?.model || getDbSetting('global_llm_model', 'deepseek-chat'),
        },
        api2: {
          endpoint: parsed.api2?.endpoint || getDbSetting('global_llm_backup_endpoint', 'https://api.deepseek.com/v1'),
          apiKey: parsed.api2?.apiKey || getDbSetting('global_llm_backup_api_key', ''),
          model: parsed.api2?.model || getDbSetting('global_llm_backup_model', 'deepseek-chat'),
          enabled: parsed.api2?.enabled !== undefined ? Boolean(parsed.api2.enabled) : getDbSetting('global_llm_backup_enabled') === 'true',
        },
        pricing: {
          priceInput: parseNonNegativeRate(parsed.pricing?.priceInput, parseNonNegativeRate(getDbSettingRaw('global_llm_price_input'), 2.0)),
          priceOutput: parseNonNegativeRate(parsed.pricing?.priceOutput, parseNonNegativeRate(getDbSettingRaw('global_llm_price_output'), 8.0)),
          priceCacheHit: parseNonNegativeRate(parsed.pricing?.priceCacheHit, parseNonNegativeRate(getDbSettingRaw('global_llm_price_cache_hit'), 0.5)),
        },
        configVersion: 1,
        updatedAt: parsed.updatedAt || new Date().toISOString(),
      };
      db.transaction(() => persistConfigToDb(seeded))();
      return seeded;
    } catch (err: any) {
      console.warn('[GlobalApiConfig] Failed to import legacy config file, using DB defaults:', err.message);
    }
  }

  const configVersion = Math.max(1, parseInt(existingVersionRaw || '1', 10) || 1);
  const api1: GlobalApiNode = {
    endpoint: getDbSetting('global_llm_endpoint', 'https://api.deepseek.com/v1') || 'https://api.deepseek.com/v1',
    apiKey: getDbSetting('global_llm_api_key', process.env.DEEPSEEK_API_KEY || ''),
    model: getDbSetting('global_llm_model', 'deepseek-chat') || 'deepseek-chat',
  };

  const api2: GlobalApiNode = {
    endpoint: getDbSetting('global_llm_backup_endpoint', 'https://api.deepseek.com/v1') || 'https://api.deepseek.com/v1',
    apiKey: getDbSetting('global_llm_backup_api_key', ''),
    model: getDbSetting('global_llm_backup_model', 'deepseek-chat') || 'deepseek-chat',
    enabled: getDbSetting('global_llm_backup_enabled', 'false') === 'true',
  };

  const pricing: GlobalApiPricing = {
    priceInput: parseNonNegativeRate(getDbSettingRaw('global_llm_price_input'), 2.0),
    priceOutput: parseNonNegativeRate(getDbSettingRaw('global_llm_price_output'), 8.0),
    priceCacheHit: parseNonNegativeRate(getDbSettingRaw('global_llm_price_cache_hit'), 0.5),
  };

  const updatedAt = getDbSetting('global_llm_updated_at', new Date().toISOString());

  if (existingVersionRaw === undefined) {
    const initial: GlobalApiFullConfig = { api1, api2, pricing, configVersion: 1, updatedAt };
    db.transaction(() => persistConfigToDb(initial))();
    try {
      saveConfigFileStrict(initial);
    } catch {}
    return initial;
  }

  return { api1, api2, pricing, configVersion, updatedAt };
}

/**
 * 事务提交全局配置至权威 SQLite 存储，再刷新只读导出副本（A10, A11）。
 */
export function saveGlobalApiConfig(input: {
  api1?: Partial<GlobalApiNode>;
  api2?: Partial<GlobalApiNode>;
  pricing?: Partial<GlobalApiPricing>;
}): GlobalApiFullConfig {
  const current = getGlobalApiConfig();

  if (input.api1) {
    if (input.api1.endpoint !== undefined) {
      current.api1.endpoint = String(input.api1.endpoint).trim() || 'https://api.deepseek.com/v1';
    }
    if (input.api1.model !== undefined) {
      current.api1.model = String(input.api1.model).trim() || 'deepseek-chat';
    }
    if (
      typeof input.api1.apiKey === 'string' &&
      input.api1.apiKey.trim().length > 0 &&
      !input.api1.apiKey.includes('****')
    ) {
      current.api1.apiKey = input.api1.apiKey.trim();
    }
  }

  if (input.api2) {
    if (input.api2.endpoint !== undefined) {
      current.api2.endpoint = String(input.api2.endpoint).trim() || 'https://api.deepseek.com/v1';
    }
    if (input.api2.model !== undefined) {
      current.api2.model = String(input.api2.model).trim() || current.api1.model || 'deepseek-chat';
    }
    if (input.api2.enabled !== undefined) {
      current.api2.enabled = Boolean(input.api2.enabled);
    }
    if (
      typeof input.api2.apiKey === 'string' &&
      input.api2.apiKey.trim().length > 0 &&
      !input.api2.apiKey.includes('****')
    ) {
      current.api2.apiKey = input.api2.apiKey.trim();
    }
  }

  if (input.pricing) {
    if (input.pricing.priceInput !== undefined) {
      current.pricing.priceInput = parseNonNegativeRate(input.pricing.priceInput, current.pricing.priceInput);
    }
    if (input.pricing.priceOutput !== undefined) {
      current.pricing.priceOutput = parseNonNegativeRate(input.pricing.priceOutput, current.pricing.priceOutput);
    }
    if (input.pricing.priceCacheHit !== undefined) {
      current.pricing.priceCacheHit = parseNonNegativeRate(input.pricing.priceCacheHit, current.pricing.priceCacheHit);
    }
  }

  current.configVersion = (current.configVersion || 1) + 1;
  current.updatedAt = new Date().toISOString();

  db.transaction(() => {
    persistConfigToDb(current);
  })();

  // Refresh export mirror file strictly after commit
  saveConfigFileStrict(current);

  return current;
}
