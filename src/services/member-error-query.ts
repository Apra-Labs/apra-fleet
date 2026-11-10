// Read a member's tool-call errors (src/services/error-registry.ts) for the
// toolErrors field execute_prompt returns when a dispatch ends.
//
// - Local member: it shares this fleet server, so the registry is read
//   in-process under the member's uuid.
// - Remote (and relay) member: its doer called the member's own fleet server,
//   so the registry lives there. The query runs over SSH as
//   `apra-fleet call --member <uuid> query_errors` with the member install's
//   binary (the same one fleet verifies the member session with).
//
// The window is relative ("the last N seconds"), so clock differences between
// the orchestrator and the member do not matter. Any failure -- no verified
// install, an older install without query_errors, a timeout -- is reported as
// { available: false }, never as an empty list, and never throws.

import type { Agent, SSHExecResult } from '../types.js';
import type { TargetOS } from '../providers/provider.js';
import { getStrategy } from './strategy.js';
import { getMemberHomeDir } from './member-home.js';
import { getAgentOS, getAgentShell } from '../utils/agent-helpers.js';
import { escapePowerShellArgInner, escapeShellArgInner } from '../utils/shell-escape.js';
import { memberBinPath, memberCommandFor, memberJoin } from './member-fleet-install.js';
import { queryErrorEntries, type ErrorEntry } from './error-registry.js';

export type ToolErrorsReport =
  | { available: true; sinceSeconds: number; total: number; entries: ErrorEntry[] }
  | { available: false; sinceSeconds: number; detail: string };

export interface MemberErrorQueryDeps {
  exec(agent: Agent, command: string, timeoutMs: number): Promise<SSHExecResult>;
  resolveHome(agent: Agent): Promise<string | null>;
}

export function defaultMemberErrorQueryDeps(): MemberErrorQueryDeps {
  return {
    exec: (agent, command, timeoutMs) => getStrategy(agent).execCommand(command, timeoutMs),
    resolveHome: agent => getMemberHomeDir(agent),
  };
}

const UUID_RE = /^[0-9A-Za-z-]{8,64}$/;
const DETAIL_MAX = 300;

const posixQuote = (s: string) => `'${escapeShellArgInner(s)}'`;
const psQuote = (s: string) => `'${escapePowerShellArgInner(s)}'`;

/**
 * The member-side command: write the query_errors arguments to `argsPath`,
 * then `apra-fleet call --member <uuid> query_errors --args-file <argsPath>
 * --rm-args-file`. Built for the member's own shell; no shell expansion.
 * Exported for tests.
 */
export function buildQueryErrorsCommand(
  binPath: string,
  memberId: string,
  sinceSeconds: number,
  argsPath: string,
  targetOs: TargetOS,
  shell: ReturnType<typeof getAgentShell>,
): string {
  if (!UUID_RE.test(memberId)) throw new Error(`unsafe member id '${memberId}'`);
  if (!Number.isInteger(sinceSeconds) || sinceSeconds < 1) throw new Error(`invalid since_seconds ${sinceSeconds}`);
  const argsJson = JSON.stringify({ member: memberId, since_seconds: sinceSeconds });
  const callArgs = ['call', '--member', memberId, 'query_errors', '--args-file', argsPath, '--rm-args-file'];
  return memberCommandFor(targetOs, shell, {
    posix: `printf '%s' ${posixQuote(argsJson)} > ${posixQuote(argsPath)} && ${posixQuote(binPath)} ${callArgs.map(posixQuote).join(' ')}`,
    powershell:
      `Set-Content -LiteralPath ${psQuote(argsPath)} -Value ${psQuote(argsJson)} -NoNewline -Encoding ascii; ` +
      `& ${psQuote(binPath)} ${callArgs.map(psQuote).join(' ')}`,
  });
}

function clip(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > DETAIL_MAX ? `${t.slice(0, DETAIL_MAX)}...` : t;
}

function lastJsonObject(text: string): Record<string, unknown> | null {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try {
      const v = JSON.parse(lines[i]);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Parse `apra-fleet call ... query_errors` output into a report. Exported for tests. */
export function parseQueryErrorsOutput(r: SSHExecResult, sinceSeconds: number): ToolErrorsReport {
  const unavailable = (detail: string): ToolErrorsReport => ({ available: false, sinceSeconds, detail: clip(detail) });
  const parsed = lastJsonObject(`${r.stdout}\n${r.stderr}`);
  const err = parsed?.error as { code?: unknown; message?: unknown } | undefined;
  if (err && typeof err === 'object') {
    return unavailable(`query_errors on the member failed: ${String(err.code ?? 'E-REMOTE')}: ${String(err.message ?? '')}`);
  }
  if (r.code !== 0 || !parsed) {
    return unavailable(`query_errors on the member exited ${r.code}: ${r.stderr || r.stdout}`);
  }
  const content = (parsed as { content?: Array<{ text?: unknown }> }).content;
  for (const c of Array.isArray(content) ? content : []) {
    if (typeof c?.text !== 'string') continue;
    try {
      const body = JSON.parse(c.text) as { entries?: unknown; total?: unknown };
      if (Array.isArray(body.entries)) {
        return { available: true, sinceSeconds, total: typeof body.total === 'number' ? body.total : body.entries.length, entries: body.entries as ErrorEntry[] };
      }
    } catch { /* not the JSON item */ }
  }
  return unavailable(`query_errors on the member returned no entries list: ${r.stdout}`);
}

/**
 * The member's tool-call errors in the last `sinceSeconds` seconds. Never
 * throws. `timeoutMs` bounds the SSH call for a remote member.
 */
export async function queryMemberToolErrors(
  agent: Agent,
  sinceSeconds: number,
  timeoutMs: number,
  deps: MemberErrorQueryDeps = defaultMemberErrorQueryDeps(),
): Promise<ToolErrorsReport> {
  const unavailable = (detail: string): ToolErrorsReport => ({ available: false, sinceSeconds, detail: clip(detail) });
  try {
    if (agent.agentType === 'local') {
      const { entries, total } = queryErrorEntries({ member: agent.id, sinceSeconds });
      return { available: true, sinceSeconds, total, entries };
    }
    if (agent.fleetMcp?.state !== 'available') {
      return unavailable(`the member's own apra-fleet install is not verified (fleetMcp ${agent.fleetMcp?.state ?? 'never probed'}${agent.fleetMcp?.reason ? `: ${agent.fleetMcp.reason}` : ''}), so its errors cannot be read`);
    }
    const home = await deps.resolveHome(agent);
    if (!home) return unavailable('could not resolve the member home folder');
    const targetOs = getAgentOS(agent) as TargetOS;
    const shell = getAgentShell(agent);
    const binPath = memberBinPath(home, targetOs, shell);
    const argsPath = memberJoin(targetOs, shell, home, '.apra-fleet', `query-errors-args-${agent.id}.json`);
    const r = await deps.exec(agent, buildQueryErrorsCommand(binPath, agent.id, sinceSeconds, argsPath, targetOs, shell), timeoutMs);
    return parseQueryErrorsOutput(r, sinceSeconds);
  } catch (err) {
    return unavailable(`query_errors could not run: ${err instanceof Error ? err.message : String(err)}`);
  }
}
