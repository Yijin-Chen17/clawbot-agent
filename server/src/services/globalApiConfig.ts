import fs from 'fs';
import path from 'path';
import { db } from '../config/database.js';

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
  updatedAt: string;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const GLOBAL_API_CONFIG_FILE = path.join(DATA_DIR, 'global_api_config.json');

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

/**
 * 从 SQLite 辅助读取一条 system_settings
 */
function getDbSetting(key: string, def: string = ''): string {
  try {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value || def;
  } catch {
    return def;
  }
}

/**
 * 写入 SQLite system_settings
 */
function setDbSetting(key: string, value: string): void {
  try {
    db.prepare(`
      INSERT INTO system_settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(key, value);
  } catch (err: any) {
    console.error(`[GlobalApiConfig] Failed to sync ${key} to system_settings:`, err.message);
  }
}

/**
 * 读取当前全局大模型配置（带独立持久化文件兜底保护）
 */
export function getGlobalApiConfig(): GlobalApiFullConfig {
  // 1. 如果独立持久化 JSON 文件存在，优先从文件加载
  if (fs.existsSync(GLOBAL_API_CONFIG_FILE)) {
    try {
      const content = fs.readFileSync(GLOBAL_API_CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(content) as GlobalApiFullConfig;

      // 结构健康检查与默认值补全
      const api1: GlobalApiNode = {
        endpoint: parsed.api1?.endpoint || getDbSetting('global_llm_endpoint', 'https://api.deepseek.com/v1'),
        apiKey: parsed.api1?.apiKey || getDbSetting('global_llm_api_key', process.env.DEEPSEEK_API_KEY || ''),
        model: parsed.api1?.model || getDbSetting('global_llm_model', 'deepseek-chat'),
      };

      const api2: GlobalApiNode = {
        endpoint: parsed.api2?.endpoint || getDbSetting('global_llm_backup_endpoint', 'https://api.deepseek.com/v1'),
        apiKey: parsed.api2?.apiKey || getDbSetting('global_llm_backup_api_key', ''),
        model: parsed.api2?.model || getDbSetting('global_llm_backup_model', 'deepseek-chat'),
        enabled: parsed.api2?.enabled !== undefined ? Boolean(parsed.api2.enabled) : getDbSetting('global_llm_backup_enabled') === 'true',
      };

      const pricing: GlobalApiPricing = {
        priceInput: parsed.pricing?.priceInput ?? (parseFloat(getDbSetting('global_llm_price_input', '2.0')) || 2.0),
        priceOutput: parsed.pricing?.priceOutput ?? (parseFloat(getDbSetting('global_llm_price_output', '8.0')) || 8.0),
        priceCacheHit: parsed.pricing?.priceCacheHit ?? (parseFloat(getDbSetting('global_llm_price_cache_hit', '0.5')) || 0.5),
      };

      return {
        api1,
        api2,
        pricing,
        updatedAt: parsed.updatedAt || new Date().toISOString(),
      };
    } catch (err: any) {
      console.warn('[GlobalApiConfig] Failed to parse config file, falling back to database:', err.message);
    }
  }

  // 2. 文件不存在或损坏时，从 SQLite system_settings 初始化并生成独立文件
  const api1: GlobalApiNode = {
    endpoint: getDbSetting('global_llm_endpoint', 'https://api.deepseek.com/v1'),
    apiKey: getDbSetting('global_llm_api_key', process.env.DEEPSEEK_API_KEY || ''),
    model: getDbSetting('global_llm_model', 'deepseek-chat'),
  };

  const api2: GlobalApiNode = {
    endpoint: getDbSetting('global_llm_backup_endpoint', 'https://api.deepseek.com/v1'),
    apiKey: getDbSetting('global_llm_backup_api_key', ''),
    model: getDbSetting('global_llm_backup_model', 'deepseek-chat'),
    enabled: getDbSetting('global_llm_backup_enabled', 'false') === 'true',
  };

  const pricing: GlobalApiPricing = {
    priceInput: parseFloat(getDbSetting('global_llm_price_input', '2.0')) || 2.0,
    priceOutput: parseFloat(getDbSetting('global_llm_price_output', '8.0')) || 8.0,
    priceCacheHit: parseFloat(getDbSetting('global_llm_price_cache_hit', '0.5')) || 0.5,
  };

  const initialConfig: GlobalApiFullConfig = {
    api1,
    api2,
    pricing,
    updatedAt: new Date().toISOString(),
  };

  // 写入独立持久化文件
  saveConfigFile(initialConfig);

  return initialConfig;
}

/**
 * 原子写入独立持久化配置文件
 */
function saveConfigFile(config: GlobalApiFullConfig): void {
  try {
    const tmpFile = `${GLOBAL_API_CONFIG_FILE}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(tmpFile, GLOBAL_API_CONFIG_FILE);
  } catch (err: any) {
    console.error('[GlobalApiConfig] Failed to save config file atomically:', err.message);
    try {
      fs.writeFileSync(GLOBAL_API_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    } catch (fallbackErr: any) {
      console.error('[GlobalApiConfig] Fallback write failed:', fallbackErr.message);
    }
  }
}

/**
 * 更新全局配置并同时写入独立持久化文件与 SQLite
 */
export function saveGlobalApiConfig(input: {
  api1?: Partial<GlobalApiNode>;
  api2?: Partial<GlobalApiNode>;
  pricing?: Partial<GlobalApiPricing>;
}): GlobalApiFullConfig {
  const current = getGlobalApiConfig();

  // 更新 API 1
  if (input.api1) {
    if (input.api1.endpoint !== undefined) {
      current.api1.endpoint = String(input.api1.endpoint).trim() || 'https://api.deepseek.com/v1';
    }
    if (input.api1.model !== undefined) {
      current.api1.model = String(input.api1.model).trim() || 'deepseek-chat';
    }
    // 密钥保护：仅当传入有效密钥且不含脱敏字符 **** 时才更新；留空或含 **** 则严格保留现有密钥
    if (
      typeof input.api1.apiKey === 'string' &&
      input.api1.apiKey.trim().length > 0 &&
      !input.api1.apiKey.includes('****')
    ) {
      current.api1.apiKey = input.api1.apiKey.trim();
    }
  }

  // 更新 API 2 (备用节点)
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

  // 更新计费价格
  if (input.pricing) {
    if (input.pricing.priceInput !== undefined) {
      current.pricing.priceInput = Math.max(0, parseFloat(String(input.pricing.priceInput)) || 0);
    }
    if (input.pricing.priceOutput !== undefined) {
      current.pricing.priceOutput = Math.max(0, parseFloat(String(input.pricing.priceOutput)) || 0);
    }
    if (input.pricing.priceCacheHit !== undefined) {
      current.pricing.priceCacheHit = Math.max(0, parseFloat(String(input.pricing.priceCacheHit)) || 0);
    }
  }

  current.updatedAt = new Date().toISOString();

  // 1. 保存到服务器独立持久化文件 (避免重启与更新丢配置)
  saveConfigFile(current);

  // 2. 双写同步至 SQLite system_settings 供旧查询兼容
  setDbSetting('global_llm_endpoint', current.api1.endpoint);
  setDbSetting('global_llm_model', current.api1.model);
  if (current.api1.apiKey) {
    setDbSetting('global_llm_api_key', current.api1.apiKey);
  }

  setDbSetting('global_llm_backup_endpoint', current.api2.endpoint);
  setDbSetting('global_llm_backup_model', current.api2.model);
  setDbSetting('global_llm_backup_enabled', current.api2.enabled ? 'true' : 'false');
  if (current.api2.apiKey) {
    setDbSetting('global_llm_backup_api_key', current.api2.apiKey);
  }

  setDbSetting('global_llm_price_input', current.pricing.priceInput.toString());
  setDbSetting('global_llm_price_output', current.pricing.priceOutput.toString());
  setDbSetting('global_llm_price_cache_hit', current.pricing.priceCacheHit.toString());

  return current;
}
