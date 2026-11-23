import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const PORT = Number(process.env.PORT) || 3001;
export const JWT_SECRET = process.env.JWT_SECRET || 'clawbot-agent-jwt-super-secret-key-2026';
export const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

export function getDataDir(): string {
  return process.env.CLAWBOT_DATA_DIR
    ? path.resolve(process.env.CLAWBOT_DATA_DIR)
    : path.resolve(process.cwd(), 'data');
}

export function getDbPath(): string {
  return process.env.CLAWBOT_DB_PATH
    ? path.resolve(process.env.CLAWBOT_DB_PATH)
    : path.join(getDataDir(), 'clawbot.db');
}
