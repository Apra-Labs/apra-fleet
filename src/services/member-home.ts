/**
 * apra-fleet issue #390 -- the MEMBER's home directory, not the hub's.
 *
 * Every provider's `resolveSessionLogPath` / `resolveSessionLogDir` builds a
 * path under a home directory that must exist ON THE MEMBER'S MACHINE. Before
 * this module, no caller ever supplied one, so the providers fell back to
 * `os.homedir()` -- the HUB process's home. For any remote member that is the
 * wrong user (hub `alice` vs member `bella`), and the resulting path can never
 * exist on the member:
 *
 *   - Claude: the stall poller reads a path that is never created, so
 *     `lastTimestamp` is always null, which the detector treats as "log not
 *     written yet -- do not count a stall cycle". Stall detection silently goes
 *     inert for that member.
 *   - AGY / OpenCode: those dispatches are provisional and rely on directory
 *     mtime polling. A wrong directory yields no signal at all, and the
 *     provisional baseline-timeout check then KILLS a healthy dispatch after
 *     the stall threshold -- a live false-positive.
 *
 * This module resolves the member's real home directory once per member and
 * caches it in memory (a home directory does not move for the lifetime of a
 * registration; the cache can be cleared explicitly if a member is re-registered).
 * Local members never probe -- they run as this process's own OS user, so
 * `os.homedir()` is already exactly right and their behavior is unchanged.
 */
import os from 'node:os';
import type { Agent } from '../types.js';
import type { TargetOS } from '../providers/provider.js';
import { getStrategy } from './strategy.js';
import { getAgentOS } from '../utils/agent-helpers.js';
import { logWarn } from '../utils/log-helpers.js';
import { getProvider } from '../providers/index.js';
import { wrapPowerShellEncoded } from '../os/windows.js';

/** memberId -> resolved home directory. Successful probes only. */
const homeDirCache = new Map<string, string>();
/** memberId -> in-flight probe, so N concurrent pollers cause ONE remote exec. */
const inFlightProbes = new Map<string, Promise<string | null>>();

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Probe command choice (judgment call, issue #390):
 *  - Windows: `%USERPROFILE%` is the canonical Windows home and is what the
 *    codebase already uses member-side for exactly this purpose -- see
 *    ClaudeProvider.ensureWorkspaceTrusted (`$env:USERPROFILE\.claude.json`) and
 *    AgyProvider's SCRIPTS_WIN. Delivered via `wrapPowerShellEncoded` (same as
 *    every other Windows-targeting PowerShell invocation in this codebase) --
 *    a raw inline `powershell -c "..."` string is NOT safe here: if the
 *    member's default exec shell is itself PowerShell, that outer shell
 *    expands `$env:USERPROFILE` inside the double quotes before the inner
 *    `powershell -c` ever sees it, leaving an unquoted path literal that is a
 *    syntax error (same defect class as apra-fleet-ot2z). Base64-encoding
 *    sidesteps re-tokenization by whatever shell sits in between.
 *  - POSIX: `printf '%s'` rather than `echo` -- no trailing newline, no shell
 *    builtin escape-interpretation differences between sh/bash/dash.
 */
function probeCommandFor(targetOs: TargetOS): string {
  return targetOs === 'windows'
    ? wrapPowerShellEncoded('[Console]::Out.Write($env:USERPROFILE)')
    : 'printf \'%s\' "$HOME"';
}

/** Absolute POSIX path, Windows drive path, or UNC share. Anything else is
 *  shell noise (banner text, an error message), not a home directory. */
function looksAbsolute(candidate: string, targetOs: TargetOS): boolean {
  if (targetOs === 'windows') return /^([A-Za-z]:[\\/]|\\\\)/.test(candidate);
  return candidate.startsWith('/');
}

async function probeHomeDir(agent: Agent): Promise<string | null> {
  const targetOs = getAgentOS(agent) as TargetOS;
  try {
    const result = await getStrategy(agent).execCommand(probeCommandFor(targetOs), PROBE_TIMEOUT_MS);
    if (result.code !== 0) {
      logWarn('member_home_probe', `home dir probe failed for ${agent.friendlyName}: code=${result.code} stderr=${result.stderr.trim()}`);
      return null;
    }
    // Take the LAST non-empty line: a login shell / PowerShell banner is
    // emitted BEFORE the command's own output, never after it.
    const candidate = result.stdout
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .pop();
    if (!candidate || !looksAbsolute(candidate, targetOs)) {
      logWarn('member_home_probe', `home dir probe for ${agent.friendlyName} returned a non-path value; ignoring`);
      return null;
    }
    homeDirCache.set(agent.id, candidate);
    return candidate;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn('member_home_probe', `home dir probe errored for ${agent.friendlyName}: ${msg}`);
    return null;
  }
}

/**
 * LAST-RESORT fallback only: the default home directory implied by the member's
 * known login username. `agent.username` is the account fleet actually connects
 * as, so its home is normally the standard per-OS location.
 *
 * This is a CONVENTION, not ground truth -- a member can have a relocated home,
 * a domain-suffixed Windows profile (C:\Users\bella.CORP), an admin-created
 * /export/home, and so on. It is therefore NEVER preferred over a probe result,
 * and a path built from it is never by itself treated as trustworthy evidence
 * that a dispatch has stalled (see pollDirectoryActivity: a guessed directory
 * only counts as a real signal once it actually yields one).
 */
export function homeDirFromUsername(username: string | undefined, targetOs: TargetOS): string | null {
  if (!username) return null;
  if (targetOs === 'windows') return `C:\\Users\\${username}`;
  if (targetOs === 'macos') return username === 'root' ? '/var/root' : `/Users/${username}`;
  return username === 'root' ? '/root' : `/home/${username}`;
}

/** Where a resolved home directory came from. Only 'probe' and 'local' are
 *  authoritative; 'username-fallback' is a guess. */
export type HomeDirSource = 'local' | 'probe' | 'username-fallback' | 'unknown';

export interface MemberPathContext {
  homeDir: string | null;
  targetOs: TargetOS | undefined;
  source: HomeDirSource;
}

/**
 * The member's own home directory, PROBED (authoritative).
 *  - local members: `os.homedir()`, immediately, with NO remote probe (they are
 *    this process's own OS user -- unchanged behavior).
 *  - remote/relay members: cached probe result, or `null` when the probe fails.
 *    Never throws; `null` means "unknown", and callers must degrade to "no
 *    signal" rather than substituting the hub's home directory.
 */
export async function getMemberHomeDir(agent: Agent): Promise<string | null> {
  if (agent.agentType === 'local') return os.homedir();

  const cached = homeDirCache.get(agent.id);
  if (cached) return cached;

  const existing = inFlightProbes.get(agent.id);
  if (existing) return existing;

  // Failures are deliberately NOT cached: a member that was briefly unreachable
  // must be able to recover on the next poll without a server restart.
  const probe = probeHomeDir(agent).finally(() => inFlightProbes.delete(agent.id));
  inFlightProbes.set(agent.id, probe);
  return probe;
}

/**
 * Everything a provider needs to build a member-side path correctly: the
 * member's home directory AND the path-join convention of the member's OS.
 *
 * `targetOs` is deliberately `undefined` for local members so their paths keep
 * using this process's host `path.join` -- byte-identical to the pre-#390
 * behavior, which is already correct for them.
 */
export async function getMemberPathContext(agent: Agent): Promise<MemberPathContext> {
  if (agent.agentType === 'local') {
    return { homeDir: os.homedir(), targetOs: undefined, source: 'local' };
  }
  const targetOs = getAgentOS(agent) as TargetOS;
  const probed = await getMemberHomeDir(agent);
  if (probed) return { homeDir: probed, targetOs, source: 'probe' };

  // LAST RESORT (see homeDirFromUsername): the probe failed, so fall back to the
  // username's conventional home rather than giving up entirely. `source` marks
  // it as a guess so the stall detector will not treat a barren guessed
  // directory as proof of a stall.
  const guess = homeDirFromUsername(agent.username, targetOs);
  return guess
    ? { homeDir: guess, targetOs, source: 'username-fallback' }
    : { homeDir: null, targetOs, source: 'unknown' };
}

/**
 * SYNCHRONOUS path context -- never issues a member-side command.
 *
 * Used on the execute_prompt dispatch path, which must not pay a remote round
 * trip (nor reorder the commands a dispatch sends) just to name a log file.
 * Resolution order:
 *   1. local member        -> os.homedir()
 *   2. cached probe result -> ground truth from an earlier stall poll
 *   3. username fallback   -> LAST RESORT (see homeDirFromUsername). Harmless
 *      here: if the guess is wrong the resolved transcript path simply never
 *      exists, which the stall detector already treats as "no timestamp yet"
 *      and NEVER as a stall. If the guess is right, the dispatch gets precise
 *      per-session transcript tracking from its very first turn.
 *   4. null -> no path is built at all (never, ever the hub's home).
 */
export function getCachedMemberPathContext(agent: Agent): MemberPathContext {
  if (agent.agentType === 'local') {
    return { homeDir: os.homedir(), targetOs: undefined, source: 'local' };
  }
  const targetOs = getAgentOS(agent) as TargetOS;
  const cached = homeDirCache.get(agent.id);
  if (cached) return { homeDir: cached, targetOs, source: 'probe' };
  const guess = homeDirFromUsername(agent.username, targetOs);
  return guess
    ? { homeDir: guess, targetOs, source: 'username-fallback' }
    : { homeDir: null, targetOs, source: 'unknown' };
}

/** Throwaway home dir used only to ask "does this provider build a member-side
 *  log path at all?" -- never used to build a path that is actually read. */
const HOME_CAPABILITY_SENTINEL = '/__fleet_capability_probe__';

/**
 * SF-18: warm the home-dir cache for every remote member that needs one.
 *
 * Before this, `getMemberPathContext` (the only probing resolver) had exactly
 * ONE caller: `pollDirectoryActivity`, which runs solely for provisional
 * dispatches with a null logFilePath -- i.e. AGY/OpenCode fresh turns. Claude
 * sessions are caller-minted, so their stall entries always carry a
 * logFilePath and never reach it. Their cache therefore stayed empty forever,
 * and the synchronous dispatch-path resolver (`getCachedMemberPathContext`,
 * used by execute_prompt to name the transcript file) permanently fell back to
 * the username-convention GUESS. On a member with a relocated or
 * domain-suffixed home that guess is wrong, the named transcript never exists,
 * and stall detection for that member silently goes inert.
 *
 * Called at server startup, which is the one place that covers members
 * registered in an EARLIER process (the cache is per-process). register_member
 * fires its own probe for newly added members so their very first dispatch is
 * already warm.
 *
 * Deliberately fire-and-forget and deliberately NOT on the dispatch path: an
 * awaited probe there inserts a remote round trip ahead of the dispatch's own
 * commands, reordering the exact sequence #390 was careful to preserve. Every
 * failure mode is silent -- the username guess remains the fallback, exactly as
 * before.
 */
export function warmMemberHomeDirs(agents: Agent[]): void {
  for (const agent of agents) {
    // Local members never probe (os.homedir() is already exactly right).
    if (agent.agentType === 'local') continue;
    if (homeDirCache.has(agent.id)) continue;
    // Providers with no member-side log path at all (codex/copilot/none) have
    // no use for a home dir -- spending a remote exec on them is pure waste.
    const targetOs = getAgentOS(agent) as TargetOS;
    let hasLogDir: boolean;
    try {
      hasLogDir = getProvider(agent.llmProvider ?? 'claude')
        .resolveSessionLogDir(agent.workFolder, HOME_CAPABILITY_SENTINEL, targetOs) !== null;
    } catch {
      continue;
    }
    if (!hasLogDir) continue;
    void getMemberHomeDir(agent).catch(() => { /* best effort -- the guess remains */ });
  }
}

/** Drop cached home dirs (a specific member, or all). Used when a member is
 *  re-registered/removed, and by tests. */
export function clearMemberHomeDirCache(memberId?: string): void {
  if (memberId === undefined) {
    homeDirCache.clear();
    inFlightProbes.clear();
    return;
  }
  homeDirCache.delete(memberId);
  inFlightProbes.delete(memberId);
}

/** Seed the cache directly (tests, or a caller that already knows the value). */
export function primeMemberHomeDir(memberId: string, homeDir: string): void {
  homeDirCache.set(memberId, homeDir);
}
