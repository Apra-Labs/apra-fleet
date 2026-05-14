import path from 'node:path';
import os from 'node:os';
import type { BlindfoldConfig, Logger } from './types.js';

class ConsoleLogger implements Logger {
  constructor(private prefix: string) {}
  info(tag: string, msg: string): void { process.stderr.write(`[${this.prefix}] ${tag}: ${msg}\n`); }
  warn(tag: string, msg: string): void { process.stderr.write(`[${this.prefix}] ${tag}: ${msg}\n`); }
  error(tag: string, msg: string): void { process.stderr.write(`[${this.prefix}] ${tag}: ${msg}\n`); }
}

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.blindfold', 'data');

let _config: BlindfoldConfig | null = null;

export function initBlindfold(overrides: Partial<BlindfoldConfig> = {}): BlindfoldConfig {
  _config = {
    dataDir: overrides.dataDir ?? process.env.BLINDFOLD_DATA_DIR ?? DEFAULT_DATA_DIR,
    productName: overrides.productName ?? 'blindfold',
    logger: overrides.logger ?? new ConsoleLogger(overrides.productName ?? 'blindfold'),
    oobTimeoutMs: overrides.oobTimeoutMs,
    pipeName: overrides.pipeName,
  };
  return _config;
}

export function getConfig(): BlindfoldConfig {
  if (!_config) return initBlindfold();
  return _config;
}

export function getDataDir(): string {
  return getConfig().dataDir;
}

export function getLogger(): Logger {
  return getConfig().logger;
}

export function resetConfig(): void {
  _config = null;
}
