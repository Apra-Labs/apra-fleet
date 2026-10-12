// Claude MCP registrations that shadow the user-scope apra-fleet entry.
//
// Claude Code resolves a server name local scope first (~/.claude.json
// projects[<path>].mcpServers), then project scope (<repo>/.mcp.json), then
// user scope (~/.claude.json mcpServers). install writes the access-secret
// header into the user-scope entry, but an older local- or project-scope
// entry for the same URL wins and stays header-less: the server answers 401,
// and Claude Code reports it as "Dynamic Client Registration rejected
// (HTTP 404)" (it falls back to OAuth discovery, which this server does not
// serve). 0.4.3's install doc told users to run `claude mcp add apra-fleet`
// without --scope, i.e. local scope (apra-fleet-d22x).
//
// install rewrites the local-scope entries (an owner-only user file) and only
// REPORTS a project .mcp.json entry -- that file is usually tracked, so the
// secret must never be written into it. `apra-fleet status` reports both.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MEMBER_SECRET_HEADER } from './member-access-secret.js';
import { writeOwnerOnlyFile } from '../cli/config.js';

/** The claude user-scope config file: $CLAUDE_CONFIG_DIR/.claude.json when set, else ~/.claude.json. */
export function claudeUserConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

const isRecord = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * True when `url` is exactly this install's no-member /mcp endpoint
 * (`fleetUrl`, e.g. http://localhost:7523/mcp; a trailing slash and the
 * loopback spellings localhost / 127.0.0.1 / [::1] are equivalent). A
 * `?member=` URL is NOT matched: compose_permissions owns those entries.
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

/** The access-secret header value an entry carries (key matched case-insensitively), or undefined. */
function secretHeaderOf(entry: Record<string, any>): unknown {
  const h = isRecord(entry.headers) ? entry.headers : {};
  const k = Object.keys(h).find(x => x.toLowerCase() === MEMBER_SECRET_HEADER.toLowerCase());
  return k === undefined ? undefined : h[k];
}

function hasBearer(entry: Record<string, any>): boolean {
  const h = isRecord(entry.headers) ? entry.headers : {};
  return Object.keys(h).some(x => x.toLowerCase() === 'authorization');
}

/** An http entry for this install whose access secret is missing (or, when `secret` is given, not it). */
function lacksSecret(entry: unknown, fleetUrl: string, secret: string | null): boolean {
  if (!isRecord(entry) || !isThisInstallMcpUrl(entry.url, fleetUrl) || hasBearer(entry)) return false;
  const v = secretHeaderOf(entry);
  if (v === undefined || v === '') return true;
  return secret !== null && typeof v === 'string' && !v.includes('${') && v !== secret;
}

export interface ShadowingEntry {
  scope: 'local' | 'project';
  /** The config file holding the entry. */
  file: string;
  /** The entry's server name. */
  name: string;
  /** local scope: the projects[] key the entry sits under. */
  project?: string;
}

function readJson(file: string): { ok: true; json: any } | { ok: false } {
  try {
    if (!fs.existsSync(file)) return { ok: false };
    const raw = String(fs.readFileSync(file, 'utf-8') ?? '').trim();
    if (!raw) return { ok: false };
    return { ok: true, json: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/** Local-scope (projects[*].mcpServers) entries for this install lacking the secret. */
export function findLocalScopeShadowing(configFile: string, fleetUrl: string, secret: string | null): ShadowingEntry[] {
  const r = readJson(configFile);
  if (!r.ok || !isRecord(r.json) || !isRecord(r.json.projects)) return [];
  const out: ShadowingEntry[] = [];
  for (const [project, p] of Object.entries(r.json.projects)) {
    if (!isRecord(p) || !isRecord(p.mcpServers)) continue;
    for (const [name, e] of Object.entries(p.mcpServers)) {
      if (lacksSecret(e, fleetUrl, secret)) out.push({ scope: 'local', file: configFile, name, project });
    }
  }
  return out;
}

/**
 * Rewrites every local-scope http entry for this install (exact `fleetUrl`)
 * that lacks the current secret with the same shape install writes for user
 * scope ({ type: 'http', url, headers }), keeping any other headers. stdio
 * entries, `?member=` entries and other URLs are left alone; no entry is
 * created. Writes owner-only, and only when something changed. Returns the
 * rewritten entries. Throws when the file exists but is not valid JSON.
 */
export function refreshClaudeLocalScopeEntries(configFile: string, fleetUrl: string, headers: Record<string, string>): ShadowingEntry[] {
  if (!fs.existsSync(configFile)) return [];
  const raw = String(fs.readFileSync(configFile, 'utf-8') ?? '').trim();
  if (!raw) return [];
  let json: any;
  try { json = JSON.parse(raw); } catch {
    throw new Error(`${configFile} is not valid JSON; fix or remove it, then re-run 'apra-fleet install'`);
  }
  if (!isRecord(json) || !isRecord(json.projects)) return [];
  const secret = headers[MEMBER_SECRET_HEADER] ?? null;
  const rewritten: ShadowingEntry[] = [];
  for (const [project, p] of Object.entries(json.projects)) {
    if (!isRecord(p) || !isRecord(p.mcpServers)) continue;
    for (const [name, e] of Object.entries(p.mcpServers)) {
      if (!lacksSecret(e, fleetUrl, secret)) continue;
      const entry = e as Record<string, any>;
      const kept = Object.fromEntries(Object.entries(isRecord(entry.headers) ? entry.headers : {})
        .filter(([k]) => k.toLowerCase() !== MEMBER_SECRET_HEADER.toLowerCase()));
      p.mcpServers[name] = { type: 'http', url: entry.url, headers: { ...kept, ...headers } };
      rewritten.push({ scope: 'local', file: configFile, name, project });
    }
  }
  if (rewritten.length) writeOwnerOnlyFile(configFile, JSON.stringify(json, null, 2) + '\n');
  return rewritten;
}

/** cwd and, when different, the enclosing git repository root (found by walking up for .git). */
function projectDirs(cwd: string): string[] {
  const dirs = [path.resolve(cwd)];
  let d = dirs[0];
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) { if (d !== dirs[0]) dirs.push(d); break; }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return dirs;
}

/**
 * Project-scope .mcp.json entries (cwd and its repo root) for this install
 * without any access-secret header. Read-only: the file is usually tracked,
 * so the secret is never written into it.
 */
export function findProjectMcpJsonShadowing(cwd: string, fleetUrl: string): ShadowingEntry[] {
  const out: ShadowingEntry[] = [];
  for (const dir of projectDirs(cwd)) {
    const file = path.join(dir, '.mcp.json');
    const r = readJson(file);
    if (!r.ok || !isRecord(r.json) || !isRecord(r.json.mcpServers)) continue;
    for (const [name, e] of Object.entries(r.json.mcpServers)) {
      if (lacksSecret(e, fleetUrl, null)) out.push({ scope: 'project', file, name });
    }
  }
  return out;
}

/** Every shadowing entry Claude would resolve before the user-scope registration. */
export function findShadowingMcpEntries(opts: { configFile: string; cwd: string; fleetUrl: string; secret: string | null }): ShadowingEntry[] {
  return [
    ...findLocalScopeShadowing(opts.configFile, opts.fleetUrl, opts.secret),
    ...findProjectMcpJsonShadowing(opts.cwd, opts.fleetUrl),
  ];
}

/** One `[!]` line naming the entry, why it breaks, and the exact fix. */
export function describeShadowingEntry(e: ShadowingEntry): string {
  if (e.scope === 'project') {
    return `[!] ${e.file}: MCP server '${e.name}' points at this apra-fleet server without the access secret, `
      + `so it shadows the user-scope registration and the server refuses it (Claude Code shows "Dynamic Client Registration rejected (HTTP 404)"). `
      + `Fix: remove the '${e.name}' entry from that file -- the user-scope registration already serves it. Do not put the secret in a tracked file.`;
  }
  return `[!] ${e.file}: local-scope MCP server '${e.name}' for project ${e.project} points at this apra-fleet server without the current access secret, `
    + `so it shadows the user-scope registration. Fix: re-run 'apra-fleet install' (it rewrites it), or remove it with `
    + `'claude mcp remove ${e.name} --scope local' from that project.`;
}
