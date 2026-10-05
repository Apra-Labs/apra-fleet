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
import { joinMemberPath, memberMcpUrl, writeMemberFile, MEMBER_MCP_SERVER_NAME, type MemberExecFn } from './member-config-io.js';

/** Work-folder-relative name of a remote member's per-dispatch config file. */
export const REMOTE_SESSION_MCP_FILE = '.fleet-session-mcp.json';

/** Recorded fleetMcp reasons that still mean the member's own server answers
 *  a ?member= session (the problem is elsewhere), so injection is safe. */
const SERVER_OK_REASONS: ReadonlySet<string> = new Set(['role-agents-hide-member-tools']);

/**
 * Whether a dispatch to `agent` gets the per-session member config.
 *  - claude only (the flag is a Claude CLI flag);
 *  - local members: always -- they share this server;
 *  - remote members: only when the member's recorded fleetMcp says its own
 *    server answered a member session. Pointing a session at a server that is
 *    not there would replace a working user-scope entry with a dead one.
 */
export function sessionMcpInjectionAvailable(agent: Agent): boolean {
  if ((agent.llmProvider ?? 'claude') !== 'claude') return false;
  if (agent.agentType === 'local') return true;
  const f = agent.fleetMcp;
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

/** The config file body: exactly one http `apra-fleet` server at the member URL. */
export function sessionMcpConfigContent(agent: Pick<Agent, 'id' | 'agentType'>): string {
  return JSON.stringify({ mcpServers: { [MEMBER_MCP_SERVER_NAME]: { type: 'http', url: memberMcpUrl(agent) } } });
}

/** Absolute member-side path of the config file (see the header for the layout). */
export function sessionMcpConfigPath(agent: Agent, resolvedWorkFolder: string): string {
  if (agent.agentType === 'local') {
    return path.join(FLEET_DIR, 'session-mcp', `${agent.id}.json`);
  }
  return joinMemberPath(resolvedWorkFolder, REMOTE_SESSION_MCP_FILE, getAgentOS(agent) === 'windows', getAgentShell(agent));
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
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const content = sessionMcpConfigContent(agent);
  try {
    if (agent.agentType === 'local') {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, 'utf-8');
      return { ok: true };
    }
    const posix = isPosixShell(getAgentOS(agent), getAgentShell(agent));
    await writeMemberFile(exec, absPath, content, posix);
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
