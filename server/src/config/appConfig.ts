import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

export interface AppConfig {
  admin_default_password: string;
  smtp: SmtpConfig;
}

const DEFAULT_CONFIG: AppConfig = {
  admin_default_password: '123456',
  smtp: {
    host: '',
    port: 465,
    secure: true,
    user: '',
    pass: '',
    from: '',
  },
};

let cachedConfig: AppConfig | null = null;

export function loadAppConfig(): AppConfig {
  const rootDir = process.cwd();
  const yamlPath = path.resolve(rootDir, 'config.yaml');
  const jsonPath = path.resolve(rootDir, 'config.json');

  let loaded: any = {};

  if (fs.existsSync(yamlPath)) {
    try {
      const content = fs.readFileSync(yamlPath, 'utf8');
      loaded = YAML.parse(content) || {};
    } catch (err: any) {
      console.warn('[Config] Failed to parse config.yaml, falling back:', err.message);
    }
  } else if (fs.existsSync(jsonPath)) {
    try {
      const content = fs.readFileSync(jsonPath, 'utf8');
      loaded = JSON.parse(content) || {};
    } catch (err: any) {
      console.warn('[Config] Failed to parse config.json, falling back:', err.message);
    }
  }

  const smtpRaw = loaded.smtp || {};

  cachedConfig = {
    admin_default_password: String(
      loaded.admin_default_password || process.env.ADMIN_DEFAULT_PASSWORD || DEFAULT_CONFIG.admin_default_password
    ),
    smtp: {
      host: String(smtpRaw.host || process.env.SMTP_HOST || ''),
      port: Number(smtpRaw.port || process.env.SMTP_PORT || 465),
      secure: smtpRaw.secure !== undefined ? Boolean(smtpRaw.secure) : true,
      user: String(smtpRaw.user || process.env.SMTP_USER || ''),
      pass: String(smtpRaw.pass || process.env.SMTP_PASS || ''),
      from: String(smtpRaw.from || process.env.SMTP_FROM || ''),
    },
  };

  return cachedConfig;
}

export function getAppConfig(): AppConfig {
  if (!cachedConfig) {
    return loadAppConfig();
  }
  return cachedConfig;
}
