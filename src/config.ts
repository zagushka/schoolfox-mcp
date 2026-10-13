import { resolve } from 'node:path';

export interface Config {
  token?: string;
  email?: string;
  password?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxDownloadBytes: number;
  downloadDir: string;
}
function bounded(raw: string | undefined, fallback: number, low: number, high: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < low || value > high) throw new Error(`${name} must be an integer from ${low} to ${high}`);
  return value;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const email = env.SCHOOLFOX_EMAIL?.trim() || undefined;
  const password = env.SCHOOLFOX_PASSWORD || undefined;
  const token = env.SCHOOLFOX_TOKEN?.trim() || undefined;
  if (Boolean(email) !== Boolean(password)) throw new Error('Set both SCHOOLFOX_EMAIL and SCHOOLFOX_PASSWORD');
  if (token && email) throw new Error('Use either SCHOOLFOX_TOKEN or login credentials');
  const downloadDir = resolve(env.SCHOOLFOX_DOWNLOAD_DIR || './downloads');
  return {
    token, email, password, downloadDir,
    timeoutMs: bounded(env.SCHOOLFOX_TIMEOUT_MS, 10000, 1000, 60000, 'SCHOOLFOX_TIMEOUT_MS'),
    maxResponseBytes: bounded(env.SCHOOLFOX_MAX_RESPONSE_BYTES, 1048576, 1024, 10485760, 'SCHOOLFOX_MAX_RESPONSE_BYTES'),
    maxDownloadBytes: bounded(env.SCHOOLFOX_MAX_DOWNLOAD_BYTES, 10485760, 1024, 104857600, 'SCHOOLFOX_MAX_DOWNLOAD_BYTES')
  };
}
