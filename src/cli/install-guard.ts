/**
 * Scoped running-server pre-check for `apra-fleet install` (apra-fleet-1aw).
 *
 * The install guard used to refuse whenever ANY process named `apra-fleet`
 * existed on the machine (isApraFleetRunning(), OS-global by design). That
 * makes a fully isolated install -- separate HOME, APRA_FLEET_DATA_DIR and
 * install prefix, the shape ci.yml's "Pack + install into a clean temp
 * prefix" step uses -- unreplayable on any box that already runs a fleet
 * server.
 *
 * This module answers the narrower question the guard actually cares about:
 * is the running server relevant to THIS install? It is relevant when either
 *
 *   (a) a live instance is recorded for the data dir this install targets
 *       (server.json + isPidAlive, the same machinery as
 *       services/singleton.ts checkRunningInstance(), minus the HTTP health
 *       probe and its server.json unlink -- a wedged-but-alive server must
 *       still fire the guard, and the guard path must not stall 2s), or
 *   (b) the running server's executable lives under the install prefix being
 *       written -- overwriting a binary that is currently open is exactly the
 *       ETXTBSY failure the guard exists to prevent.
 *
 * Anything else is an unrelated server: the install proceeds and just prints
 * an informational note. When a running process's executable path cannot be
 * determined at all (restricted /proc, PowerShell unavailable, ...) we
 * deliberately classify it as NOT relevant and say so in the note, rather
 * than falling back to the old global refusal -- a silent fallback to
 * "refuse" would reinstate the original bug precisely in the constrained
 * environments this fix exists for.
 *
 * isApraFleetRunning() itself stays OS-global (the guard's cheap first filter
 * and uninstall.ts use it). Stopping, however, is scoped: install --force
 * signals only the pids relevantServerPids() returns, by pid, never by process
 * name -- a name-based kill also matches the installer itself when it is named
 * apra-fleet (the member upgrade path, or an installed binary running install)
 * and every unrelated apra-fleet server of the same user (apra-fleet-b4g.72).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { isPidAlive, isApraFleetProcess } from '../utils/process-utils.js';

export interface RunningApraFleetProcess {
  pid: number;
  /** Absolute path of the running executable, or null when it could not be resolved. */
  exePath: string | null;
}

export interface RunningServerScope {
  /** True when the running server must block/force-stop this install. */
  relevant: boolean;
  reason: 'data-dir' | 'install-prefix' | null;
  /** Human-readable one-liner describing what was found. */
  detail: string;
}

/** Data dir this process would use -- mirrors services/singleton.ts getFleetDir(). */
export function getInstallDataDir(): string {
  return process.env.APRA_FLEET_DATA_DIR ?? path.join(os.homedir(), '.apra-fleet', 'data');
}

function runCapture(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', windowsHide: true }) as unknown as string;
  } catch {
    return null;
  }
}

/**
 * PID of a live server recorded in the data dir this install targets, or null.
 * Read-only: unlike checkRunningInstance() this never deletes server.json.
 */
export function liveInstancePidForDataDir(): number | null {
  try {
    const raw = fs.readFileSync(path.join(getInstallDataDir(), 'server.json'), 'utf8');
    const info = JSON.parse(raw.toString()) as { pid?: number };
    if (!info || typeof info.pid !== 'number') return null;
    return isPidAlive(info.pid) ? info.pid : null;
  } catch {
    return null;
  }
}

/** Running apra-fleet processes (excluding this one) with their executable paths. */
export function getRunningApraFleetProcesses(): RunningApraFleetProcess[] {
  const currentPid = process.pid;

  if (process.platform === 'win32') {
    const out = runCapture('tasklist /FI "IMAGENAME eq apra-fleet.exe" /NH /FO CSV') ?? '';
    const pids: number[] = [];
    for (const line of out.split('\n')) {
      const match = line.match(/"apra-fleet\.exe","(\d+)"/);
      if (match && Number(match[1]) !== currentPid) pids.push(Number(match[1]));
    }
    if (pids.length === 0) return [];

    // Get-Process (no nested quoting, unlike a CIM -Filter) yields "<pid>|<path>".
    const paths = new Map<number, string>();
    const psOut = runCapture(
      'powershell -NoProfile -Command "Get-Process apra-fleet | ForEach-Object { $_.Id.ToString() + \'|\' + $_.Path }"',
    ) ?? '';
    for (const line of psOut.split('\n')) {
      const [pidText, ...rest] = line.trim().split('|');
      const pid = Number(pidText);
      const exePath = rest.join('|').trim();
      if (Number.isFinite(pid) && pid > 0 && exePath) paths.set(pid, exePath);
    }
    return pids.map(pid => ({ pid, exePath: paths.get(pid) ?? null }));
  }

  const out = runCapture('pgrep -x apra-fleet') ?? '';
  const pids = out
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
    .map(Number)
    .filter(pid => Number.isFinite(pid) && pid > 0 && pid !== currentPid);

  return pids.map(pid => {
    // macOS `ps -o comm=` prints the full executable path; Linux needs /proc.
    const cmd = process.platform === 'darwin'
      ? `ps -p ${pid} -o comm=`
      : `readlink -f /proc/${pid}/exe`;
    const resolved = (runCapture(cmd) ?? '').trim();
    return { pid, exePath: resolved === '' ? null : resolved };
  });
}

/** True when `exePath` is the install prefix dir itself or a file underneath it. */
export function isUnderInstallPrefix(exePath: string | null, prefixDir: string): boolean {
  if (!exePath || !prefixDir) return false;
  let target = path.resolve(exePath);
  let prefix = path.resolve(prefixDir);
  if (process.platform === 'win32') {
    target = target.toLowerCase();
    prefix = prefix.toLowerCase();
  }
  if (target === prefix) return true;
  return target.startsWith(prefix.endsWith(path.sep) ? prefix : prefix + path.sep);
}

function describeProcesses(procs: RunningApraFleetProcess[]): string {
  if (procs.length === 0) return 'a running apra-fleet process (pid unknown)';
  return procs
    .map(p => `pid ${p.pid} (${p.exePath ?? 'executable path could not be determined'})`)
    .join(', ');
}

/**
 * Decide whether the running apra-fleet server(s) are relevant to an install
 * that writes its binary into `installPrefixDir`.
 */
export function classifyRunningServer(installPrefixDir: string): RunningServerScope {
  const livePid = liveInstancePidForDataDir();
  if (livePid !== null) {
    return {
      relevant: true,
      reason: 'data-dir',
      detail: `pid ${livePid} is recorded live in the data dir this install targets (${getInstallDataDir()})`,
    };
  }

  const procs = getRunningApraFleetProcesses();
  const inPrefix = procs.find(p => isUnderInstallPrefix(p.exePath, installPrefixDir));
  if (inPrefix) {
    return {
      relevant: true,
      reason: 'install-prefix',
      detail: `pid ${inPrefix.pid} runs from ${inPrefix.exePath}, inside the install prefix being written (${installPrefixDir})`,
    };
  }

  return { relevant: false, reason: null, detail: describeProcesses(procs) };
}

function inPrefixPids(procs: RunningApraFleetProcess[], installPrefixDir: string): number[] {
  return procs
    .filter(p => p.pid !== process.pid && isUnderInstallPrefix(p.exePath, installPrefixDir))
    .map(p => p.pid);
}

/**
 * The pids install --force may stop for an install into `installPrefixDir`,
 * re-derived on every call so a poll also sees a server a supervisor relaunched
 * under a NEW pid (it re-records itself in server.json and runs from the prefix):
 *
 *   - the live pid recorded in the targeted data dir, when it is still an
 *     apra-fleet process (pids are reused: a stale server.json pid that now
 *     belongs to something else is never returned), and
 *   - every apra-fleet process whose executable lives under the install prefix.
 *
 * This process is never included -- the installer may itself be named
 * apra-fleet. Unrelated apra-fleet servers (other data dir, other prefix,
 * unresolvable executable) are never included either.
 */
export function relevantServerPids(installPrefixDir: string): number[] {
  const procs = getRunningApraFleetProcesses();
  const pids = new Set<number>(inPrefixPids(procs, installPrefixDir));
  const livePid = liveInstancePidForDataDir();
  if (livePid !== null && livePid !== process.pid) {
    const namedApraFleet = procs.some(p => p.pid === livePid);
    if (namedApraFleet || isApraFleetProcess(livePid) === true) pids.add(livePid);
  }
  return [...pids].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Member-install ownership marker (apra-fleet-b4g.69.4)
//
// `install --member --force` is what fleet runs on a REMOTE member to upgrade
// it. --force stops the running server first, which is right for the member
// server a previous member install left behind but wrong for a human's own
// full-install server on a shared box. A member install therefore records a
// marker in the data dir it targets; a later `--member --force` stops a running
// server only when that marker is present. Without it the server was not
// started by a member install, and stopping it needs an explicit override.
// A non-member (full) install clears the marker, so it never inherits ownership.
// ---------------------------------------------------------------------------

/** Name of the explicit override that lets a member install stop a full-install server. */
export const FORCE_STOP_FULL_INSTALL_FLAG = '--force-stop-full-install';

/** Machine-readable code printed on the refusal (the fleet-side install maps it to a typed status). */
export const FULL_INSTALL_RUNNING_CODE = 'E-FULL-INSTALL-RUNNING';

export function memberInstallMarkerPath(): string {
  return path.join(getInstallDataDir(), 'member-install.json');
}

export function hasMemberInstallMarker(): boolean {
  try {
    return fs.existsSync(memberInstallMarkerPath());
  } catch {
    return false;
  }
}

/** Writes the marker. `port` is the port this member install's server listens
 *  on (the server reads it back at launch, see resolveServerPort, and the
 *  orchestrator reads it to build the member's MCP URL). */
export function writeMemberInstallMarker(version: string, port?: number): void {
  try {
    fs.mkdirSync(getInstallDataDir(), { recursive: true });
    const marker = { version, installedAt: new Date().toISOString(), ...(port !== undefined ? { port } : {}) };
    fs.writeFileSync(memberInstallMarkerPath(), JSON.stringify(marker) + '\n');
  } catch {
    // Best effort: a missing marker only makes the next forced member install refuse loudly.
  }
}

export function clearMemberInstallMarker(): void {
  try { fs.rmSync(memberInstallMarkerPath(), { force: true }); } catch { /* best effort */ }
}

/**
 * Whether a `--member --force` install may stop the relevant running server.
 * Allowed when the server is a member install's own (marker present) or the
 * caller passed the explicit override; not applicable to a non-member install.
 */
export function memberForceMayStop(opts: { memberMode: boolean; overridden: boolean }): boolean {
  if (!opts.memberMode) return true;
  return opts.overridden || hasMemberInstallMarker();
}

/** The refusal text: names the running server and the override. */
export function fullInstallRefusalText(serverDetail: string): string {
  return `
Error: ${FULL_INSTALL_RUNNING_CODE}: a running apra-fleet server was not started by a member install, so a member install will not stop it.
  Running server: ${serverDetail}

  This looks like a full install (for example a person's own server on a shared machine).
  To stop it anyway and install the member server over it, re-run with:
    apra-fleet install --member --force ${FORCE_STOP_FULL_INSTALL_FLAG}
`;
}
