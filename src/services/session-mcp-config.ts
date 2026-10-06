// Per-session apra-fleet MCP config for Claude role dispatches.
//
// Every Claude session execute_prompt starts for a member is given the
// member-scoped apra-fleet server (http://localhost:<port>/mcp?member=<uuid>,
// see memberMcpUrl) through the CLI's `--mcp-config <file>` flag. The entry is
// named `apra-fleet`, so it overrides a user-scope `apra-fleet` entry for THAT
// session only, while every other configured server (deepwiki, ...) stays
// available. `--strict-mcp-config` is deliberately NOT used for that reason.
//
// The per-folder entry compose_permissions writes for remote members is the
// fallback for a dispatch where injection is unavailable (fewer tools, never
// zero). Local members need no per-folder entry at all.
//
// File location (resolved in JavaScript, never by the member's shell):
//  - local members: <FLEET_DIR>/session-mcp/<uuid>.json -- one file per
//    member, outside the work folder, overwritten on every dispatch (no
//    accumulation, and the human's own sessions in that folder are untouched);
//  - remote members: <workFolder>/.fleet-session-mcp.json, written next to the
//    prompt file and removed with it when the dispatch ends. The name is not
//    `.mcp.json`, so no Claude session picks it up on its own.

import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from '../types.js';
import { FLEET_DIR } from '../paths.js';
import { getAgentOS, getAgentShell, isPosixShell } from '../utils/agent-helpers.js';
import { ensureGitExcluded, joinMemberPath, memberMcpUrl, writeMemberFile, MEMBER_MCP_SERVER_NAME, type MemberExecFn } from './member-config-io.js';

/** Work-folder-relative name of a remote member's per-dispatch config file. */
export const REMOTE_SESSION_MCP_FILE = '.fleet-session-mcp.json';

/** Recorded fleetMcp reasons that still mean the member's own server answers
 *  a ?member= session (the problem is elsewhere), so injection is safe. */
const SERVER_OK_REASONS: ReadonlySet<string> = new Set(['role-agents-hide-member-tools']);

/**
 * Whether a dispatch to `agent` gets the per-session member config.
 *  - claude only (the flag is a Claude CLI flag);
 *  - local members: always -- they share this server -- except while the
 *    recorded fleetMcp says this server refused the member session;
 *  - remote members: only when the member's recorded fleetMcp says its own
 *    server answered a member session. Pointing a session at a server that is
 *    not there would replace a working user-scope entry with a dead one.
 */
export function sessionMcpInjectionAvailable(agent: Agent): boolean {
  if ((agent.llmProvider ?? 'claude') !== 'claude') return false;
  const f = agent.fleetMcp;
  // Local: this server -- unless it last refused this member's session.
  if (agent.agentType === 'local') return !(f?.state === 'unavailable' && f.reason === 'member-session-failed');
  if (!f) return false;
  if (f.state === 'available') return f.unverified !== true;
  return !!f.reason && SERVER_OK_REASONS.has(f.reason);
}

/**
 * Whether compose_permissions should write the per-folder apra-fleet entry.
 * Not for a local claude member: every dispatch to it gets the member config
 * per session, so a folder entry would only change the human's own sessions
 * in that clone. Remote members keep it as the fallback for a dispatch where
 * injection is unavailable.
 */
export function perFolderMcpEntryNeeded(agent: Agent): boolean {
  return !(agent.agentType === 'local' && (agent.llmProvider ?? 'claude') === 'claude');
}

/**
 * The config file body: exactly one http `apra-fleet` server at the member URL.
 *
 * `alwaysLoad: true` (Claude Code MCP server option) keeps every tool of that
 * server in the session's prompt instead of deferring it behind the
 * tool-search tool, so a role session can call kb_* / code_* from its first
 * turn without a discovery round-trip. Emitted only when the caller has
 * established that the member's CLI accepts it (see resolveSessionMcpAlwaysLoad).
 */
export function sessionMcpConfigContent(
  agent: Pick<Agent, 'id' | 'agentType' | 'memberMcpPort'>,
  opts: { alwaysLoad?: boolean } = {},
): string {
  const entry: Record<string, unknown> = { type: 'http', url: memberMcpUrl(agent) };
  if (opts.alwaysLoad) entry.alwaysLoad = true;
  return JSON.stringify({ mcpServers: { [MEMBER_MCP_SERVER_NAME]: entry } });
}

/** First `X.Y.Z` in a CLI's version output (e.g. "2.1.291 (Claude Code)"). */
export function parseCliVersion(output: string): string | undefined {
  return /(\d+)\.(\d+)\.(\d+)/.exec(output)?.[0];
}

/** Numeric dotted-version comparison: true when `version` >= `min`. */
export function cliVersionAtLeast(version: string, min: string): boolean {
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

/** How long a probed member CLI version is reused before it is probed again
 *  (a CLI update on the member is picked up within this window). */
export const CLI_VERSION_CACHE_TTL_MS = 10 * 60 * 1000;
const cliVersionCache = new Map<string, { version: string; at: number }>();

/** Test hook: forget every cached member CLI version. */
export function resetCliVersionCache(): void {
  cliVersionCache.clear();
}

/**
 * Decides whether this dispatch's session config may carry `alwaysLoad`.
 * The provider names the minimum CLI version that supports it
 * (ProviderAdapter.mcpAlwaysLoadMinVersion); the member's CLI version is
 * probed with `versionCmd` and cached per member. Never throws. When the
 * mechanism cannot be applied the config is written WITHOUT the key (an
 * unknown key could invalidate the entry on an older CLI, leaving the session
 * with no apra-fleet server at all) and `warning` names the cause, so the
 * dispatcher can log it -- the tools then stay deferred for that session.
 */
export async function resolveSessionMcpAlwaysLoad(
  agent: Pick<Agent, 'id'>,
  minVersion: string | undefined,
  versionCmd: string,
  exec: MemberExecFn,
  now: () => number = Date.now,
): Promise<{ alwaysLoad: boolean; warning?: string }> {
  if (!minVersion) {
    return { alwaysLoad: false, warning: 'the provider has no MCP always-load option; kb/code tools may stay deferred behind tool search' };
  }
  let version: string | undefined;
  const cached = cliVersionCache.get(agent.id);
  if (cached && now() - cached.at < CLI_VERSION_CACHE_TTL_MS) {
    version = cached.version;
  } else {
    try {
      const r = await exec(versionCmd, 30_000);
      if (typeof r.code !== 'number' || r.code === 0) version = parseCliVersion(`${r.stdout}\n${r.stderr}`);
    } catch { /* reported below */ }
    if (version) cliVersionCache.set(agent.id, { version, at: now() });
  }
  if (!version) {
    return { alwaysLoad: false, warning: `member CLI version could not be determined, so the MCP always-load option was not applied (needs >= ${minVersion}); kb/code tools may stay deferred behind tool search` };
  }
  if (!cliVersionAtLeast(version, minVersion)) {
    return { alwaysLoad: false, warning: `member CLI ${version} is older than ${minVersion}, so the MCP always-load option was not applied; kb/code tools stay deferred behind tool search (update the member CLI)` };
  }
  return { alwaysLoad: true };
}

/** Absolute member-side path of the config file (see the header for the layout). */
export function sessionMcpConfigPath(agent: Agent, resolvedWorkFolder: string): string {
  if (agent.agentType === 'local') {
    return path.join(FLEET_DIR, 'session-mcp', `${agent.id}.json`);
  }
  return joinMemberPath(resolvedWorkFolder, REMOTE_SESSION_MCP_FILE, getAgentOS(agent) === 'windows', getAgentShell(agent));
}

/** remove_member: deletes a local member's reused config file (no-op when absent).
 *  A remote member's file is per dispatch and already removed with its prompt file. */
export function removeLocalSessionMcpConfig(agent: Pick<Agent, 'id' | 'agentType'>): void {
  if (agent.agentType !== 'local') return;
  try { fs.unlinkSync(path.join(FLEET_DIR, 'session-mcp', `${agent.id}.json`)); } catch { /* absent */ }
}

/** True when the file lives in the work folder and must be removed after the dispatch. */
export function sessionMcpConfigIsPerDispatch(agent: Agent): boolean {
  return agent.agentType !== 'local';
}

/**
 * Writes the config file. Local: through fs. Remote: through the member's
 * shell with the shared member file writer (quoted resolved path, read back).
 * Never throws: a failure returns its detail so the caller falls back to a
 * dispatch without the flag.
 */
export async function writeSessionMcpConfig(
  agent: Agent,
  absPath: string,
  exec: MemberExecFn,
  opts: { alwaysLoad?: boolean } = {},
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const content = sessionMcpConfigContent(agent, opts);
  try {
    if (agent.agentType === 'local') {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, 'utf-8');
      return { ok: true };
    }
    const posix = isPosixShell(getAgentOS(agent), getAgentShell(agent));
    await writeMemberFile(exec, absPath, content, posix);
    // Keep the file out of `git status` (and a role's `git add -A`) even when
    // compose never ran for this clone. Best effort: a non-repo or a failed
    // exclude never blocks the dispatch.
    try {
      await ensureGitExcluded(exec, agent.workFolder, [REMOTE_SESSION_MCP_FILE], getAgentOS(agent) === 'windows', getAgentShell(agent));
    } catch { /* best effort */ }
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
