import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ServiceManager, ServiceStatus } from './types.js';
import { WINDOWS_TASK_NAME } from './types.js';
import { gracefulStopByServerJson } from './index.js';
import { BIN_DIR, DATA_DIR } from '../../cli/config.js';

const WRAPPER_PATH = path.join(BIN_DIR, 'apra-fleet-service.bat');

/**
 * How the ApraFleet scheduled task is registered.
 *
 * - 'system-onstart': '/ru SYSTEM /sc onstart /rl highest'. Requires elevation
 *   at registration time. Launchable by 'schtasks /run' with ZERO interactive
 *   logon sessions, and started automatically at boot (this is STRONGER than
 *   the onlogon trigger for reboot survival: the server comes back after a
 *   reboot with nobody logged in at all).
 * - 'onlogon-interactive': the historical '/sc onlogon /rl limited'
 *   registration with no '/ru', which schtasks stores with an interactive-only
 *   logon type. Survives reboot only once a user logs on, and cannot be fired
 *   by 'schtasks /run' while no interactive session exists (apra-fleet-i8qj).
 *   This is the degraded fallback used when SYSTEM registration is refused.
 */
export type ServiceRegistrationMode = 'system-onstart' | 'onlogon-interactive';

const MODE_RECORD_PATH = path.join(DATA_DIR, 'service-registration.json');

/**
 * Env vars pinned into the wrapper .bat so a SYSTEM-run server still resolves
 * the REGISTERING user's home (~/.apra-fleet, ~/.claude, ~/.ssh) instead of
 * C:\Windows\System32\config\systemprofile. Node's os.homedir() reads
 * USERPROFILE on Windows, and src/paths.ts FLEET_DIR / src/cli/config.ts
 * derive everything from it, so pinning these keeps state, the credential key
 * (~/.apra-fleet/data/salt) and provider CLI auth pointing at the same files
 * the interactive install wrote. Same session-var set as src/os/windows.ts.
 */
const PINNED_ENV_VARS = [
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
  'APPDATA', 'LOCALAPPDATA',
];

/** 'set "VAR=value"' lines for the wrapper .bat, skipping unsafe/absent values. */
function pinnedEnvLines(env: NodeJS.ProcessEnv = process.env): string[] {
  const lines: string[] = [];
  for (const name of PINNED_ENV_VARS) {
    const value = env[name];
    // Reject anything that could break out of the quoted 'set' or be re-expanded.
    if (!value || /["\r\n%]/.test(value)) continue;
    lines.push(`set "${name}=${value}"`);
  }
  return lines;
}

/** Persist which registration mode register() landed in (best effort, never throws). */
function writeRegistrationMode(mode: ServiceRegistrationMode): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      MODE_RECORD_PATH,
      JSON.stringify({ taskName: WINDOWS_TASK_NAME, mode, registeredAt: new Date().toISOString() }, null, 2),
    );
  } catch {
    // Non-fatal: the mode is still re-derivable from 'schtasks /query /v'.
  }
}

/** Remove the mode record so it cannot outlive the task itself. */
function clearRegistrationMode(): void {
  try { fs.unlinkSync(MODE_RECORD_PATH); } catch {}
}

/**
 * The registration mode of the currently installed task, for start()/query()
 * (apra-fleet-i8qj.3) and the CLI (apra-fleet-i8qj.4) to reason about.
 * Falls back to 'onlogon-interactive' when no record exists -- installs made
 * before this record was introduced are exactly that mode.
 */
export function readServiceRegistrationMode(): ServiceRegistrationMode {
  try {
    const parsed = JSON.parse(fs.readFileSync(MODE_RECORD_PATH, 'utf8')) as { mode?: string };
    if (parsed.mode === 'system-onstart' || parsed.mode === 'onlogon-interactive') return parsed.mode;
  } catch {
    // Absent/corrupt record -> assume the historical mode.
  }
  return 'onlogon-interactive';
}

/**
 * Re-derive the mode from the live task definition ('schtasks /query /v'),
 * used when neither /create attempt landed but a task is already registered.
 * Returns undefined when the task cannot be queried at all.
 */
export function deriveRegistrationModeFromQuery(): ServiceRegistrationMode | undefined {
  let out: string;
  try {
    out = execFileSync(
      'schtasks', ['/query', '/tn', WINDOWS_TASK_NAME, '/fo', 'list', '/v'],
      { encoding: 'utf8' },
    );
  } catch {
    return undefined;
  }
  const runAs = /^\s*Run As User:\s*(.+)$/im.exec(out)?.[1]?.trim() ?? '';
  if (/^(NT AUTHORITY\\)?SYSTEM$/i.test(runAs)) return 'system-onstart';
  return 'onlogon-interactive';
}

export interface InteractiveSessionResult {
  hasInteractive: boolean;
  raw: string;
}

/**
 * Thrown by start() when the ApraFleet scheduled task did not fire and the
 * machine has zero interactive logon sessions -- the documented
 * onlogon-interactive-mode failure mode (apra-fleet-i8qj). Distinguishable
 * from other start() failures (task missing, access denied) via `name` or
 * the stable `code` field, so src/cli/start.ts (apra-fleet-i8qj.4) can branch
 * on it without parsing message text.
 */
export class NoInteractiveSessionError extends Error {
  readonly code = 'NO_INTERACTIVE_SESSION' as const;

  constructor(message: string) {
    super(message);
    this.name = 'NoInteractiveSessionError';
    Object.setPrototypeOf(this, NoInteractiveSessionError.prototype);
  }
}

/** Type guard for NoInteractiveSessionError, robust across require/import boundaries. */
export function isNoInteractiveSessionError(err: unknown): err is NoInteractiveSessionError {
  return err instanceof NoInteractiveSessionError
    || (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'NO_INTERACTIVE_SESSION');
}

/** Parsed subset of 'schtasks /query /fo list /v' output that start()/query() need. */
interface TaskQueryInfo {
  installed: boolean;
  status?: string;
  lastRunTime?: string;
  lastResult?: string;
}

/** Splits 'Key:     Value' verbose schtasks output lines into a lookup map. */
function parseSchtasksVerbose(out: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const rawLine of out.split(/\r?\n/)) {
    const idx = rawLine.indexOf(':');
    if (idx === -1) continue;
    const key = rawLine.slice(0, idx).trim();
    const value = rawLine.slice(idx + 1).trim();
    if (!key) continue;
    map[key] = value;
  }
  return map;
}

/**
 * Queries the ApraFleet task's verbose state via 'schtasks /query /fo list /v'
 * (unlike the terse '/fo csv /nh' form, this exposes Last Run Time / Last
 * Result, which start() needs to confirm a run actually fired and query()
 * needs to derive 'registeredButNeverFired').
 */
function queryTaskInfo(): TaskQueryInfo {
  try {
    const out = execFileSync(
      'schtasks', ['/query', '/tn', WINDOWS_TASK_NAME, '/fo', 'list', '/v'],
      { encoding: 'utf8' },
    );
    const map = parseSchtasksVerbose(out);
    return {
      installed: true,
      status: map['Status'],
      lastRunTime: map['Last Run Time'],
      lastResult: map['Last Result'],
    };
  } catch {
    return { installed: false };
  }
}

/** 'Last Run Time' as reported by schtasks when the task has never fired. */
const NEVER_FIRED_SENTINEL = 'N/A';

/** Injectable command runner seam: takes (cmd, args), returns combined stdout+stderr text. */
export type SessionQueryRunner = (cmd: string, args: string[]) => string;

function runCaptureOutput(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' });
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer };
    const stdout = e.stdout ? e.stdout.toString() : '';
    const stderr = e.stderr ? e.stderr.toString() : '';
    return stdout + stderr;
  }
}

/** Default runner used in production: shells out to 'query user' / 'query session'. */
export const defaultSessionQueryRunner: SessionQueryRunner = (cmd, args) => runCaptureOutput(cmd, args);

/**
 * Reports whether the current Windows machine has an interactive logon session,
 * by parsing 'query user' output (falling back to 'query session' if the first
 * command produced no output at all, e.g. it is absent on this Windows edition).
 *
 * Both commands exit non-zero and print "No User exists for *" when there are
 * zero sessions -- that is treated as hasInteractive=false, not as an error.
 * Never throws: any failure of the underlying command runner also resolves to
 * hasInteractive=false with whatever raw text (possibly empty) was captured.
 */
export function hasInteractiveSession(
  runner: SessionQueryRunner = defaultSessionQueryRunner,
): InteractiveSessionResult {
  let raw = '';
  try {
    raw = runner('query', ['user']);
    if (!raw.trim()) {
      raw = runner('query', ['session']);
    }
  } catch {
    raw = '';
  }

  if (!raw.trim() || /No User exists for/i.test(raw)) {
    return { hasInteractive: false, raw };
  }

  const dataLines = raw
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .filter(line => !/^\s*>?\s*(USERNAME|SESSIONNAME)\b/i.test(line));

  const hasInteractive = dataLines.some(line => /\bActive\b/i.test(line));
  return { hasInteractive, raw };
}

export class WindowsServiceManager implements ServiceManager {
  /**
   * Register the ApraFleet scheduled task, preferring a headless-capable
   * SYSTEM/onstart registration and degrading to the historical
   * onlogon/interactive one when SYSTEM registration is refused (no elevation).
   * Never returns success while the machine has no registered task at all.
   */
  async register(binaryPath: string, args: string[], logPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(WRAPPER_PATH), { recursive: true });
    const quotedArgs = args.map(a => `"${a}"`).join(' ');
    const lines = [
      '@echo off',
      ...pinnedEnvLines(),
      `"${binaryPath}" ${quotedArgs} >> "${logPath}" 2>&1`,
    ];
    fs.writeFileSync(WRAPPER_PATH, lines.join('\r\n'), 'utf8');

    const attempts: Array<{ mode: ServiceRegistrationMode; args: string[] }> = [
      {
        mode: 'system-onstart',
        args: [
          '/create', '/tn', WINDOWS_TASK_NAME,
          '/tr', WRAPPER_PATH,
          '/sc', 'onstart', '/ru', 'SYSTEM', '/rl', 'highest', '/f',
        ],
      },
      {
        mode: 'onlogon-interactive',
        args: [
          '/create', '/tn', WINDOWS_TASK_NAME,
          '/tr', WRAPPER_PATH,
          '/sc', 'onlogon', '/rl', 'limited', '/f',
        ],
      },
    ];

    const failures: string[] = [];
    for (const attempt of attempts) {
      try {
        execFileSync('schtasks', attempt.args);
      } catch (err) {
        failures.push(`${attempt.mode}: ${(err as Error).message}`);
        continue;
      }
      writeRegistrationMode(attempt.mode);
      if (attempt.mode === 'system-onstart') {
        console.warn(
          'apra-fleet: registered scheduled task ApraFleet as SYSTEM with an onstart trigger ' +
          '(runs headless, starts at boot).',
        );
      } else {
        console.warn(
          'apra-fleet: could not register the ApraFleet task as SYSTEM (elevation required); ' +
          'fell back to the onlogon interactive-only registration. It cannot be launched by ' +
          "'schtasks /run' while no interactive logon session exists, and it only restarts " +
          'after reboot once a user logs on. Re-run this from an elevated shell for headless operation.',
        );
      }
      return;
    }

    // Both /create attempts failed. A pre-existing task (e.g. a SYSTEM-owned
    // one being re-registered unelevated) still leaves the machine usable --
    // record its actual mode and say so -- but no task at all is a hard error.
    const existingMode = deriveRegistrationModeFromQuery();
    if (existingMode) {
      writeRegistrationMode(existingMode);
      console.warn(
        `apra-fleet: could not (re-)create the ApraFleet scheduled task (${failures.join('; ')}). ` +
        `Keeping the existing registration, which runs in '${existingMode}' mode.`,
      );
      return;
    }
    throw new Error(
      `apra-fleet: failed to register the ApraFleet scheduled task and none exists. ${failures.join('; ')}`,
    );
  }

  async unregister(): Promise<void> {
    try {
      execFileSync('schtasks', ['/delete', '/tn', WINDOWS_TASK_NAME, '/f']);
    } catch {
      // Tolerate task-not-found
    }
    try { fs.unlinkSync(WRAPPER_PATH); } catch {}
    clearRegistrationMode();
  }

  /**
   * Runs 'schtasks /run' and confirms the task actually fired before
   * resolving. Never returns success on a silent no-op: a task stuck in
   * 'onlogon-interactive' mode with zero logon sessions accepts /run without
   * error but never launches (apra-fleet-i8qj), so success is only reported
   * once Last Run Time has advanced past its pre-run value.
   */
  async start(): Promise<void> {
    const before = queryTaskInfo();

    let runError: Error | undefined;
    try {
      execFileSync('schtasks', ['/run', '/tn', WINDOWS_TASK_NAME], { encoding: 'utf8' });
    } catch (err) {
      runError = err as Error;
    }

    if (runError) {
      // schtasks /run itself failed (task missing, access denied, ...) --
      // these are distinct, identifiable failures and must not be
      // mislabelled as the interactive-session case even if the machine
      // also happens to have zero interactive sessions.
      throw new Error(`apra-fleet: failed to start the ApraFleet scheduled task: ${runError.message}`);
    }

    const after = queryTaskInfo();
    const fired = !!after.lastRunTime
      && after.lastRunTime !== NEVER_FIRED_SENTINEL
      && after.lastRunTime !== before.lastRunTime;
    if (fired) return;

    // 'schtasks /run' reported success but the task never actually fired --
    // this is the silent failure mode. Fail fast (no server-liveness wait)
    // and distinguish the interactive-session cause from anything else.
    const session = hasInteractiveSession();
    if (!session.hasInteractive) {
      throw new NoInteractiveSessionError(
        "apra-fleet: the ApraFleet scheduled task did not start because there is no interactive " +
        "logon session on this machine. The task is registered in interactive-only ('onlogon') " +
        "logon mode, which 'schtasks /run' cannot launch headlessly. Sign in interactively " +
        '(console or RDP) once, or re-run apra-fleet install from an elevated shell so the task ' +
        'can be registered in headless SYSTEM/onstart mode instead.',
      );
    }

    throw new Error(
      `apra-fleet: the ApraFleet scheduled task did not start (status: '${after.status ?? 'unknown'}', ` +
      "Last Run Time unchanged after 'schtasks /run').",
    );
  }

  async stop(): Promise<void> {
    await gracefulStopByServerJson((pid) => {
      try { execFileSync('taskkill', ['/F', '/PID', String(pid)]); } catch {}
    });
  }

  async query(): Promise<ServiceStatus> {
    const info = queryTaskInfo();
    if (!info.installed) return { installed: false, running: false };

    const registeredButNeverFired = !info.lastRunTime || info.lastRunTime === NEVER_FIRED_SENTINEL;
    return {
      installed: true,
      running: info.status === 'Running',
      lastRunTime: info.lastRunTime,
      lastResult: info.lastResult,
      // Only set when true so callers relying on the pre-existing
      // { installed, running } shape (toEqual-style comparisons) are unaffected.
      registeredButNeverFired: registeredButNeverFired || undefined,
    };
  }

  async isInstalled(): Promise<boolean> {
    try {
      execFileSync('schtasks', ['/query', '/tn', WINDOWS_TASK_NAME]);
      return true;
    } catch {
      return false;
    }
  }
}
