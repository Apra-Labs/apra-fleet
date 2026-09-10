import type { AgentStrategy } from './strategy.js';
import type { OsCommands, MemberShell } from '../os/os-commands.js';
import type { LogScope } from '../utils/log-helpers.js';
import type { RemoteOS } from '../utils/platform.js';
import { wrapPowerShellEncoded } from '../os/windows.js';
import { isPosixShell } from '../utils/agent-helpers.js';

/**
 * Lease-of-life recovery for a false-alarm "exit 0 / empty output" dispatch
 * (apra-fleet-6z8.1, Part A+C of apra-fleet-6z8).
 *
 * Root cause recap: ssh2 only reports a genuine remote exit status via a
 * separate 'exit' event. When the channel's 'close' fires without it,
 * src/services/ssh.ts substitutes code 0, fabricating "command succeeded,
 * nothing to say" out of "the channel died, remote process state unknown."
 * The backgrounded CLI survives that teardown (no SIGHUP for background jobs),
 * so declaring empty_response there orphans a still-running turn AND invites
 * the caller to redispatch a duplicate concurrent one.
 *
 * The fix treats the channel close as a HINT, not a verdict: cross-check it
 * against a PID-liveness probe issued over a FRESH short exec, independent of
 * the (dead) original channel.
 */

/** Default cadence for the liveness poll -- deliberately the stall detector's own
 *  poll interval (STALL_POLL_INTERVAL_MS, default 30s) so recovery and stall
 *  detection sample the same signal on the same beat (the "Part C unification"). */
const DEFAULT_POLL_INTERVAL_MS = 30_000;
/** Generous ceiling used when the dispatch declared no max_total_s. */
const DEFAULT_MAX_WAIT_MS = 30 * 60_000;
/** Short timeout for the auxiliary probes -- these are one-shot `kill -0` / `cat`
 *  round trips, not the dispatch itself. */
const PROBE_TIMEOUT_MS = 15_000;

export type OrphanRecoveryStatus =
  /** The durable output file carried a real result -- `stdout` is populated. */
  | 'recovered'
  /** The pid is confirmed dead (or there was nothing to check) -- caller keeps
   *  its pre-existing empty_response behavior, unchanged. */
  | 'dead'
  /** Process exited but the durable file was missing/empty -- a REAL empty
   *  response, same terminal handling as 'dead'. */
  | 'empty'
  /** Still alive when the wait cap was hit; the pid has been killed. Must be
   *  surfaced as its own terminal reason, never as empty_response. */
  | 'timeout'
  /** Recovery does not apply (no captured pid, no durable file path, or a
   *  platform without the durable-tee companion change). */
  | 'unsupported';

export interface OrphanRecoveryResult {
  status: OrphanRecoveryStatus;
  stdout?: string;
  /** How long the recovery path waited on the live pid, in ms. */
  waitedMs?: number;
}

export interface OrphanRecoveryOptions {
  strategy: AgentStrategy;
  cmds: OsCommands;
  /** PID captured from the FLEET_PID marker via onPidCaptured. */
  pid?: number;
  /** Remote path the dispatch teed its stdout to. */
  durablePath?: string;
  /** True for members whose remote OS has no durable-tee companion support. */
  unsupported?: boolean;
  /** Remote member's OS, for building an OS-appropriate probe command. Defaults to 'linux'. */
  os?: RemoteOS;
  /** Remote member's registered shell (only meaningful for Windows). A
   *  gitbash member gets POSIX probe commands instead of PowerShell ones. */
  shell?: MemberShell;
  /** Upper bound on the wait; defaults to the remaining max_total_s, else a ceiling. */
  maxWaitMs?: number;
  pollIntervalMs?: number;
  scope?: Pick<LogScope, 'info'>;
  /** Injectable sleep so tests do not depend on wall-clock or fake timers. */
  sleep?: (ms: number) => Promise<void>;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Probe remote PID liveness over a FRESH short exec -- deliberately NOT the
 * channel that just resolved, which is exactly the thing whose verdict is in
 * doubt. Conservative on ambiguity, like isPidAlive(): only an explicit DEAD
 * marker counts as dead; a failed/garbled probe is reported as alive so the
 * caller waits rather than declaring a false failure.
 */
export async function isRemoteProcessAlive(
  strategy: AgentStrategy,
  pid: number,
  os: RemoteOS = 'linux',
  shell?: MemberShell,
): Promise<boolean> {
  try {
    // Windows has no `kill -0`; mirror the Get-Process idiom monitor-task.ts
    // already uses for the same pid-alive check. A gitbash member gets the
    // POSIX form instead -- it has a real `kill` (apra-fleet-7dir.2.4).
    const cmd = isPosixShell(os, shell)
      ? `kill -0 ${pid} 2>/dev/null && echo ALIVE || echo DEAD`
      : wrapPowerShellEncoded(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { echo ALIVE } else { echo DEAD }`);
    const res = await strategy.execCommand(cmd, PROBE_TIMEOUT_MS);
    const out = (res.stdout || '').trim();
    if (/\bDEAD\b/.test(out)) return false;
    if (/\bALIVE\b/.test(out)) return true;
    return false;
  } catch {
    // Probe itself failed (transport hiccup) -- do not fabricate a verdict in
    // either direction; treat as dead so the caller falls back to today's
    // behavior instead of waiting on an unverifiable pid.
    return false;
  }
}

/** Read the durable per-invocation output file back over a fresh exec. */
export async function readDurableOutput(
  strategy: AgentStrategy,
  durablePath: string,
  os: RemoteOS = 'linux',
  shell?: MemberShell,
): Promise<string | null> {
  try {
    // Windows has no `cat`; mirror the Get-Content idiom monitor-task.ts
    // already uses for reading a possibly-missing remote file. A gitbash
    // member gets the POSIX form instead (apra-fleet-7dir.2.4).
    const cmd = isPosixShell(os, shell)
      ? `cat "${durablePath}" 2>/dev/null`
      : wrapPowerShellEncoded(`if (Test-Path "${durablePath}") { Get-Content -Path "${durablePath}" -Raw } else { echo '' }`);
    const res = await strategy.execCommand(cmd, PROBE_TIMEOUT_MS);
    const out = res.stdout ?? '';
    return out.trim() === '' ? null : out;
  } catch {
    return null;
  }
}

/**
 * Lease-of-life gate. Returns 'dead' whenever the pre-existing empty_response
 * behavior should apply verbatim, so the caller's fallback path is unchanged.
 */
export async function recoverOrphanedDispatch(opts: OrphanRecoveryOptions): Promise<OrphanRecoveryResult> {
  const { strategy, cmds, pid, durablePath, unsupported, scope, os = 'linux', shell } = opts;
  if (unsupported || pid === undefined || !durablePath) return { status: 'unsupported' };

  const pollIntervalMs = opts.pollIntervalMs
    ?? envInt('ORPHAN_RECOVERY_POLL_MS', envInt('STALL_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS));
  const maxWaitMs = opts.maxWaitMs ?? envInt('ORPHAN_RECOVERY_MAX_WAIT_MS', DEFAULT_MAX_WAIT_MS);
  const sleep = opts.sleep ?? defaultSleep;

  if (!(await isRemoteProcessAlive(strategy, pid, os, shell))) {
    // Confirmed dead: today's behavior, unchanged.
    return { status: 'dead', waitedMs: 0 };
  }

  scope?.info(`[orphan-recovery] channel reported exit=0/empty but pid=${pid} is still ALIVE -- treating the close as a hint, not a verdict (waiting up to ${Math.round(maxWaitMs / 1000)}s)`);

  const start = Date.now();
  let waitedMs = 0;
  for (;;) {
    if (waitedMs >= maxWaitMs) {
      scope?.info(`[orphan-recovery] pid=${pid} still alive after ${Math.round(waitedMs / 1000)}s -- killing it and returning orphan_recovery_timeout`);
      try {
        await strategy.execCommand(cmds.killPid(pid), PROBE_TIMEOUT_MS);
      } catch { /* best effort -- the terminal reason stands either way */ }
      return { status: 'timeout', waitedMs };
    }
    const remaining = maxWaitMs - waitedMs;
    await sleep(Math.min(pollIntervalMs, remaining));
    waitedMs = Math.max(Date.now() - start, waitedMs + Math.min(pollIntervalMs, remaining));
    if (!(await isRemoteProcessAlive(strategy, pid, os, shell))) break;
  }

  const stdout = await readDurableOutput(strategy, durablePath, os, shell);
  if (stdout === null) {
    scope?.info(`[orphan-recovery] pid=${pid} exited but ${durablePath} is missing/empty -- a genuine empty response`);
    return { status: 'empty', waitedMs };
  }
  scope?.info(`[orphan-recovery] recovered ${stdout.length} bytes of durable output for pid=${pid} after ${Math.round(waitedMs / 1000)}s`);
  return { status: 'recovered', stdout, waitedMs };
}
