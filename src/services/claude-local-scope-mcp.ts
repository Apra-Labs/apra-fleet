// Claude LOCAL-scope apra-fleet entries that shadow the user-scope one.
//
// Claude Code resolves a server name local scope first (~/.claude.json
// projects[<path>].mcpServers), before user scope (~/.claude.json
// mcpServers). install writes the access-secret header into the user-scope
// entry; a header-less local-scope entry for the same URL (a hand-run
// `claude mcp add apra-fleet` without --scope) would still win, get 401, and
// Claude Code would report "Dynamic Client Registration rejected (HTTP 404)".
// install rewrites those entries too (apra-fleet-d22x).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MEMBER_SECRET_HEADER } from './member-access-secret.js';
import { writeOwnerOnlyFileAtomic } from '../cli/config.js';

/** The claude user-scope config file: $CLAUDE_CONFIG_DIR/.claude.json when set, else ~/.claude.json. */
export function claudeUserConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

const isRecord = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * True when `url` is exactly this install's no-member /mcp endpoint
 * (`fleetUrl`; a trailing slash and the loopback spellings localhost /
 * 127.0.0.1 / [::1] are equivalent). A `?member=` URL is NOT matched:
 * compose_permissions owns those entries.
 */
export function isThisInstallMcpUrl(url: unknown, fleetUrl: string): boolean {
  if (typeof url !== 'string') return false;
  let a: URL; let b: URL;
  try { a = new URL(url); b = new URL(fleetUrl); } catch { return false; }
  const loop = (h: string) => (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' ? 'loopback' : h);
  const strip = (p: string) => p.replace(/\/+$/, '');
  return a.protocol === b.protocol && loop(a.hostname) === loop(b.hostname)
    && (a.port || '80') === (b.port || '80') && strip(a.pathname) === strip(b.pathname)
    && a.search === '' && a.hash === '';
}

/**
 * Rewrites every local-scope http entry for this install (exact `fleetUrl`)
 * whose access-secret header is missing or differs: the header is merged in,
 * every other field and header of the entry is kept. stdio entries, bearer-authenticated entries, `?member=` entries and
 * other URLs are left alone; no entry is created. Writes owner-only, and only
 * when something changed. Returns the rewritten projects[] keys. Throws when
 * the file exists but is not valid JSON.
 */
export function refreshClaudeLocalScopeEntries(configFile: string, fleetUrl: string, headers: Record<string, string>): string[] {
  if (!fs.existsSync(configFile)) return [];
  const raw = String(fs.readFileSync(configFile, 'utf-8') ?? '').trim();
  if (!raw) return [];
  let json: any;
  try { json = JSON.parse(raw); } catch {
    throw new Error(`${configFile} is not valid JSON; fix or remove it, then re-run 'apra-fleet install'`);
  }
  if (!isRecord(json) || !isRecord(json.projects)) return [];
  const want = MEMBER_SECRET_HEADER.toLowerCase();
  const rewritten: string[] = [];
  for (const [project, p] of Object.entries(json.projects)) {
    if (!isRecord(p) || !isRecord(p.mcpServers)) continue;
    for (const [name, e] of Object.entries(p.mcpServers)) {
      if (!isRecord(e) || !isThisInstallMcpUrl(e.url, fleetUrl)) continue;
      const h: Record<string, any> = isRecord(e.headers) ? e.headers : {};
      if (Object.keys(h).some(k => k.toLowerCase() === 'authorization')) continue;
      const k = Object.keys(h).find(x => x.toLowerCase() === want);
      if (k !== undefined && h[k] === headers[MEMBER_SECRET_HEADER]) continue;
      const kept = Object.fromEntries(Object.entries(h).filter(([x]) => x.toLowerCase() !== want));
      p.mcpServers[name] = { ...e, headers: { ...kept, ...headers } };
      rewritten.push(project);
    }
  }
  if (rewritten.length) writeOwnerOnlyFileAtomic(configFile, JSON.stringify(json, null, 2) + '\n');
  return rewritten;
}

/** Outcome of checkClaudeUserScopeRegistration. */
export type ClaudeRegistrationState =
  | 'ok' | 'ok-stdio' | 'missing' | 'wrong-url' | 'wrong-secret' | 'unreadable' | 'not-applicable';

export interface ClaudeRegistrationCheckOptions {
  /** Claude user config file; default claudeUserConfigPath(). */
  configFile?: string;
  /** The /mcp URL install registers (install.ts step 5: http://localhost:<DEFAULT_PORT>/mcp). */
  expectedUrl: string;
  /** The install's member access secret, or null when its file is absent (secret check skipped). */
  expectedSecret: string | null;
  /** False when install-config does not record the claude provider: nothing to check. Default true. */
  claudeRecorded?: boolean;
}

/**
 * Read-only, never-throwing health check of mcpServers.apra-fleet in the claude
 * user config. Never writes the file and never reads or creates the secret
 * itself (the caller passes it in).
 */
export function checkClaudeUserScopeRegistration(opts: ClaudeRegistrationCheckOptions): ClaudeRegistrationState {
  try {
    if (opts.claudeRecorded === false) return 'not-applicable';
    const file = opts.configFile ?? claudeUserConfigPath();
    if (!fs.existsSync(file)) return 'missing';
    const raw = String(fs.readFileSync(file, 'utf-8') ?? '').trim();
    if (!raw) return 'missing';
    let json: any;
    try { json = JSON.parse(raw); } catch { return 'unreadable'; }
    if (!isRecord(json)) return 'unreadable';
    const entry = isRecord(json.mcpServers) ? json.mcpServers['apra-fleet'] : undefined;
    if (!isRecord(entry)) return 'missing';
    if (typeof entry.command === 'string' && entry.url === undefined) return 'ok-stdio';
    if (!isThisInstallMcpUrl(entry.url, opts.expectedUrl)) return 'wrong-url';
    if (opts.expectedSecret) {
      const want = MEMBER_SECRET_HEADER.toLowerCase();
      const h = isRecord(entry.headers) ? entry.headers : {};
      const k = Object.keys(h).find(x => x.toLowerCase() === want);
      if (k === undefined || h[k] !== opts.expectedSecret) return 'wrong-secret';
    }
    return 'ok';
  } catch {
    return 'unreadable';
  }
}
