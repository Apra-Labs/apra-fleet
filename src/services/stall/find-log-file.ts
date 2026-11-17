import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '../../types.js';
import { getAgent } from '../registry.js';
import { getStrategy } from '../strategy.js';
import { getAgentOS, getAgentShell, isPosixShell } from '../../utils/agent-helpers.js';
import { logLine, logWarn } from '../../utils/log-helpers.js';
import { wrapStallPowerShell, psQuote } from './read-log-tail.js';

const RETRY_INTERVAL_MS = 10_000;
const MAX_ATTEMPTS = 4; // initial + 3 retries = 30s total

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function toFindNewermt(t0: number): string {
  return new Date(t0).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * apra-fleet-uob4: a PowerShell expression for the UTC instant t0, compared
 * against LastWriteTimeUtc. The old Z-less ISO string was parsed as LOCAL
 * time and compared with local LastWriteTime, skewing the cutoff by the
 * host's UTC offset.
 */
function toPsUtcDateTime(t0: number): string {
  return `[DateTimeOffset]::Parse('${new Date(t0).toISOString().slice(0, 19)}Z', [Globalization.CultureInfo]::InvariantCulture).UtcDateTime`;
}

// --- Local helpers ---

function findLocalMtimeCandidates(dir: string, t0: number): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
      .map(e => join(dir, e.name))
      .filter(f => {
        try { return statSync(f).mtimeMs > t0; }
        catch { return false; }
      });
  } catch {
    return [];
  }
}

function hasLocalInvToken(filePath: string, inv: string): boolean {
  try {
    return readFileSync(filePath, 'utf8').includes(`[${inv}]`);
  } catch {
    return false;
  }
}

function pickLocalCandidate(candidates: string[], inv: string): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const match = candidates.find(c => hasLocalInvToken(c, inv));
  if (match) {
    logLine('find_log_file_tiebreaker', JSON.stringify({ inv, chosen: match, total: candidates.length }));
    return match;
  }
  return candidates[0];
}

async function tryFindLocal(
  t0: number,
  inv: string,
  logDir: string,
  sessionId: string | null,
  provider: string
): Promise<string | null> {
  // Case B Claude: direct path lookup
  if (provider === 'claude' && sessionId) {
    const directPath = join(logDir, `${sessionId}.jsonl`);
    try {
      const stat = statSync(directPath);
      return stat.mtimeMs > t0 ? directPath : null;
    } catch {
      return null;
    }
  }

  // Case A (fresh session) or Case B (a non-Claude provider without a direct
  // session-id path lookup): mtime scan
  const candidates = findLocalMtimeCandidates(logDir, t0);
  return pickLocalCandidate(candidates, inv);
}

// --- Remote helpers ---

async function execLines(agent: Agent, cmd: string, timeoutMs: number): Promise<string[]> {
  try {
    const strategy = getStrategy(agent);
    const result = await strategy.execCommand(cmd, timeoutMs);
    if (result.code !== 0 && result.code !== 1) return [];
    return result.stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  } catch {
    return [];
  }
}

async function findRemoteMtimeCandidates(agent: Agent, dir: string, t0: number): Promise<string[]> {
  const os = getAgentOS(agent);
  const shell = getAgentShell(agent);
  const cmd = isPosixShell(os, shell)
    ? `find "${dir}" -maxdepth 1 -name "*.jsonl" -newermt "${toFindNewermt(t0)}" 2>/dev/null`
    : wrapStallPowerShell(`Get-ChildItem -Path '${psQuote(dir)}' -Filter '*.jsonl' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -gt ${toPsUtcDateTime(t0)} } | ForEach-Object { $_.FullName }`);

  const lines = await execLines(agent, cmd, 10_000);
  return lines.filter(l => l.endsWith('.jsonl'));
}

async function checkRemoteInvToken(agent: Agent, candidates: string[], inv: string): Promise<string | null> {
  const os = getAgentOS(agent);
  const shell = getAgentShell(agent);
  const cmd = isPosixShell(os, shell)
    ? `grep -l "\\[${inv}\\]" ${candidates.map(c => `"${c}"`).join(' ')} 2>/dev/null`
    : wrapStallPowerShell(`Select-String -Pattern '\\[${psQuote(inv)}\\]' -Path @(${candidates.map(c => `'${psQuote(c)}'`).join(',')}) -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique`);

  const lines = await execLines(agent, cmd, 5_000);
  return lines.length > 0 ? lines[0] : null;
}

async function pickRemoteCandidate(
  agent: Agent,
  candidates: string[],
  inv: string,
  memberId: string
): Promise<string | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const match = await checkRemoteInvToken(agent, candidates, inv);
  if (match) {
    logLine('find_log_file_tiebreaker', JSON.stringify({ memberId, inv, chosen: match, total: candidates.length }));
    return match;
  }
  return candidates[0];
}

async function tryFindRemote(
  memberId: string,
  agent: Agent,
  t0: number,
  inv: string,
  logDir: string,
  sessionId: string | null,
  provider: string
): Promise<string | null> {
  // Case B Claude: direct file existence + mtime check
  if (provider === 'claude' && sessionId) {
    const os = getAgentOS(agent);
    const shell = getAgentShell(agent);
    const posix = isPosixShell(os, shell);
    const sep = posix ? '/' : '\\';
    const directPath = `${logDir}${sep}${sessionId}.jsonl`;
    const cmd = posix
      ? `find "${directPath}" -newermt "${toFindNewermt(t0)}" 2>/dev/null`
      : wrapStallPowerShell(`Get-Item -Path '${psQuote(directPath)}' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTimeUtc -gt ${toPsUtcDateTime(t0)} } | ForEach-Object { $_.FullName }`);
    const lines = await execLines(agent, cmd, 5_000);
    return lines.length > 0 ? lines[0] : null;
  }

  // Case A (fresh session) or Case B (a non-Claude provider without a direct
  // session-id path lookup): mtime scan
  const candidates = await findRemoteMtimeCandidates(agent, logDir, t0);
  return pickRemoteCandidate(agent, candidates, inv, memberId);
}

// --- Public API ---

export async function findLogFile(
  memberId: string,
  t0: number,
  inv: string,
  logDir: string
): Promise<string | null> {
  const agent = getAgent(memberId);
  if (!agent) {
    logWarn('find_log_file', `Agent ${memberId} not found`);
    return null;
  }

  const sessionId = agent.sessionId ?? null;
  const provider = agent.llmProvider ?? 'claude';
  const isLocal = agent.agentType === 'local';

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_INTERVAL_MS);
    }

    const result = isLocal
      ? await tryFindLocal(t0, inv, logDir, sessionId, provider)
      : await tryFindRemote(memberId, agent, t0, inv, logDir, sessionId, provider);

    if (result !== null) {
      logLine('find_log_file', JSON.stringify({ event: 'find_log_file_found', memberId, result, attempt }));
      return result;
    }
  }

  logLine('stall_log_not_found', JSON.stringify({ event: 'stall_log_not_found', memberId, logDir, inv }));
  return null;
}
