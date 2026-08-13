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

  async start(): Promise<void> {
    // Use spawn (detached) so schtasks /run does not block the installer.
    // schtasks /run returns quickly but on some Windows versions it waits
    // for the launched process -- detaching avoids that.
    const { spawn } = await import('node:child_process');
    const child = spawn('schtasks', ['/run', '/tn', WINDOWS_TASK_NAME], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
  }

  async stop(): Promise<void> {
    await gracefulStopByServerJson((pid) => {
      try { execFileSync('taskkill', ['/F', '/PID', String(pid)]); } catch {}
    });
  }

  async query(): Promise<ServiceStatus> {
    try {
      const out = execFileSync(
        'schtasks', ['/query', '/tn', WINDOWS_TASK_NAME, '/fo', 'csv', '/nh'],
        { encoding: 'utf8' },
      );
      // CSV line: "TaskName","Next Run Time","Status"
      const line = out.trim().split(/\r?\n/)[0] ?? '';
      const cols = line.split('","');
      const status = (cols[2] ?? '').replace(/"/g, '').trim();
      return { installed: true, running: status === 'Running' };
    } catch {
      return { installed: false, running: false };
    }
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
