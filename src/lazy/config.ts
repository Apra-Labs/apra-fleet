import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeHelperSettings } from './mode.js';

/** Resolved at call time so tests (and LAZYFLEET_DIR) can redirect it. */
export function lazyDir(): string {
  return process.env.LAZYFLEET_DIR ?? path.join(os.homedir(), '.lazyfleet');
}

export interface LazyConfig {
  /** Port for the proxy and the settings UI (both on 127.0.0.1). */
  port: number;
  /** Where model traffic really goes. */
  upstream: string;
  detection: {
    /** `password = x`, URL passwords, "my token is x". */
    context: boolean;
    /** Long random-looking strings typed in chat. */
    entropy: boolean;
  };
  helpers: {
    /** Most parallel helpers Claude may start on its own. */
    maxParallel: number;
    /** Idle helpers are cleaned up after this many minutes. */
    idleMinutes: number;
    /** Ask before anything that costs money or runs off this machine. */
    askBeforeRemote: boolean;
  };
  /** Secret for the settings UI; never leaves this machine. */
  uiToken: string;
  /** A base URL Claude Code used before us, restored on uninstall. */
  previousBaseUrl?: string;
}

export const DEFAULT_PORT = 7777;

function defaults(): LazyConfig {
  return {
    port: DEFAULT_PORT,
    upstream: 'https://api.anthropic.com',
    detection: { context: true, entropy: true },
    helpers: { maxParallel: 3, idleMinutes: 120, askBeforeRemote: true },
    uiToken: crypto.randomBytes(24).toString('hex'),
  };
}

export function configPath(): string {
  return path.join(lazyDir(), 'config.json');
}

function ensureDir(): void {
  fs.mkdirSync(lazyDir(), { recursive: true, mode: 0o700 });
}

export function loadConfig(): LazyConfig {
  const base = defaults();
  let stored: Partial<LazyConfig> = {};
  try {
    stored = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
  } catch {
    // First run or unreadable -- fall back to defaults and write them out.
  }
  const cfg: LazyConfig = {
    ...base,
    ...stored,
    detection: { ...base.detection, ...stored.detection },
    helpers: { ...base.helpers, ...stored.helpers },
  };
  if (!stored.uiToken) saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg: LazyConfig): void {
  ensureDir();
  const p = configPath();
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(p, 0o600);
  try {
    writeHelperSettings(cfg);
  } catch {
    // The skill mirror is best-effort; the config file is the source of truth.
  }
}

/** Apply a partial update from the UI, validating every field it touches. */
export function updateConfig(patch: unknown): LazyConfig {
  const cfg = loadConfig();
  const p = (patch ?? {}) as Record<string, any>;
  if (p.detection) {
    if (typeof p.detection.context === 'boolean') cfg.detection.context = p.detection.context;
    if (typeof p.detection.entropy === 'boolean') cfg.detection.entropy = p.detection.entropy;
  }
  if (p.helpers) {
    const h = p.helpers;
    if (Number.isInteger(h.maxParallel) && h.maxParallel >= 1 && h.maxParallel <= 16) cfg.helpers.maxParallel = h.maxParallel;
    if (Number.isInteger(h.idleMinutes) && h.idleMinutes >= 5 && h.idleMinutes <= 7 * 24 * 60) cfg.helpers.idleMinutes = h.idleMinutes;
    if (typeof h.askBeforeRemote === 'boolean') cfg.helpers.askBeforeRemote = h.askBeforeRemote;
  }
  saveConfig(cfg);
  return cfg;
}
