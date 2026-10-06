/**
 * Uninstall-side cleanup of the fleet-sprint supervisor OS service.
 *
 * This line never registers a supervisor service itself, but one can be left
 * on a machine by a v0.5 install (src/services/supervisor-service.ts there,
 * SERVICE_DESCRIPTORS['fleet-supervisor']) or by an operator following the
 * fleet-supervisor SKILL.md "Auto-start on login/boot" recipe. Uninstall
 * deletes the installed workflows/fleet-sprint tree that such a unit runs, so
 * a unit left behind keeps a dead (or still-running, now orphaned) supervisor
 * registered across reboots.
 *
 * Known registration names (mirroring the v0.5 descriptor so a later merge
 * does not produce two competing removal paths):
 *   - Linux:   systemd --user units fleet-supervisor.service (v0.5) and
 *              apra-fleet-supervisor.service (SKILL.md recipe)
 *   - macOS:   launchd label com.apra-fleet.supervisor
 *   - Windows: scheduled task ApraFleetSupervisor, plus the wrapper
 *              BIN_DIR/apra-fleet-supervisor-service.bat and its .js launcher
 *
 * A known name alone is NOT proof of ownership: the SKILL.md recipe uses the
 * same macOS/Windows names but points at a dev checkout. A registration is
 * removed ONLY when its target references the installed tree:
 *   - the v0.5 shape  BIN_DIR/apra-fleet supervisor (Windows: via the wrapper
 *     or launcher in BIN_DIR), or
 *   - the older shape FLEET_BASE/workflows/fleet-sprint/bin/serve.mjs.
 * Anything else (including a target that cannot be read) is kept and reported.
 *
 * The supervisor writes no server.json, so the MCP server's graceful
 * HTTP-shutdown stop path cannot stop it; it is stopped through the platform
 * manager directly. Every command is an argv array -- no shell interpolation.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { BIN_DIR, WORKFLOWS_DIR } from '../cli/config.js';

export const SUPERVISOR_LINUX_UNIT_NAMES = ['fleet-supervisor.service', 'apra-fleet-supervisor.service'] as const;
export const SUPERVISOR_MACOS_LABEL = 'com.apra-fleet.supervisor';
export const SUPERVISOR_WINDOWS_TASK_NAME = 'ApraFleetSupervisor';
export const SUPERVISOR_WINDOWS_WRAPPER_FILE = 'apra-fleet-supervisor-service.bat';

const QUIET = { stdio: 'pipe', windowsHide: true, timeout: 30_000 } as const;

export type SupervisorPlatform = 'linux' | 'darwin' | 'win32';

export interface SupervisorRegistration {
  platform: SupervisorPlatform;
  /** Unit / launchd label / scheduled task name. */
  name: string;
  /** The unit file or plist path (absent for a Windows scheduled task). */
  definitionPath?: string;
  /** The command the registration runs, or null when it could not be read. */
  target: string | null;
  /** True only when target references the installed tree (see module doc). */
  installedByFleet: boolean;
}

function linuxUnitDir(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user');
}

function macosPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SUPERVISOR_MACOS_LABEL}.plist`);
}

function windowsWrapperPath(): string {
  return path.join(BIN_DIR, SUPERVISOR_WINDOWS_WRAPPER_FILE);
}

function windowsLauncherPath(): string {
  return windowsWrapperPath().replace(/\.bat$/i, '') + '.js';
}

function macosUid(): string {
  return typeof process.getuid === 'function' ? String(process.getuid()) : '501';
}

function normalizeForMatch(s: string, platform: SupervisorPlatform): string {
  let out = s.replace(/["']/g, '');
  if (platform === 'win32') out = out.replace(/\//g, '\\').toLowerCase();
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether a registration target references the INSTALLED apra-fleet tree. */
export function targetIsInstalledTree(target: string | null, platform: SupervisorPlatform): boolean {
  if (!target) return false;
  const t = normalizeForMatch(target, platform);
  const norm = (p: string) => normalizeForMatch(p, platform);
  const serveMjs = norm(path.join(WORKFLOWS_DIR, 'fleet-sprint', 'bin', 'serve.mjs'));
  if (t.includes(serveMjs)) return true;
  const binary = escapeRegExp(norm(path.join(BIN_DIR, 'apra-fleet')));
  if (new RegExp(`${binary}(\\.exe)?\\s+supervisor(\\s|$)`, platform === 'win32' ? 'i' : '').test(t)) return true;
  if (platform === 'win32') {
    if (t.includes(norm(windowsWrapperPath())) || t.includes(norm(windowsLauncherPath()))) return true;
  }
  return false;
}

/** ExecStart of a systemd unit, with systemd's exec prefixes stripped. */
export function parseUnitExecStart(unitText: string): string | null {
  const m = /^\s*ExecStart\s*=\s*(.+)$/m.exec(unitText);
  if (!m) return null;
  const v = m[1].trim().replace(/^[-@+!:]+/, '').trim();
  return v || null;
}

function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** The ProgramArguments of a launchd plist joined with spaces, or null. */
export function parsePlistProgramArguments(plistText: string): string | null {
  const m = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/i.exec(plistText);
  if (!m) return null;
  const args = [...m[1].matchAll(/<string>([\s\S]*?)<\/string>/gi)].map(x => xmlUnescape(x[1].trim()));
  return args.length > 0 ? args.join(' ') : null;
}

function decodeSchtasks(raw: Buffer | string): string {
  const text = typeof raw === 'string' ? raw
    : raw.toString(raw[0] === 0xff && raw[1] === 0xfe ? 'utf16le' : 'utf8');
  return text.replace(/\u0000/g, '');
}

/** The Exec action (Command + Arguments) of a task XML definition, or null. */
export function parseTaskXmlAction(xml: string): string | null {
  const cmd = /<Command>([\s\S]*?)<\/Command>/i.exec(xml);
  if (!cmd) return null;
  const args = /<Arguments>([\s\S]*?)<\/Arguments>/i.exec(xml);
  return [xmlUnescape(cmd[1].trim()), args ? xmlUnescape(args[1].trim()) : ''].join(' ').trim() || null;
}

function readTextOrNull(p: string): string | null {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return typeof raw === 'string' ? raw : String(raw ?? '');
  } catch {
    return null;
  }
}

function currentPlatform(): SupervisorPlatform | null {
  const p = process.platform;
  return p === 'linux' || p === 'darwin' || p === 'win32' ? p : null;
}

/**
 * Every known-name supervisor registration present on this OS. Read-only:
 * file reads, and on Windows one `schtasks /Query /XML` (no mutating command).
 */
export function findSupervisorRegistrations(): SupervisorRegistration[] {
  const platform = currentPlatform();
  const found: SupervisorRegistration[] = [];
  if (platform === 'linux') {
    for (const name of SUPERVISOR_LINUX_UNIT_NAMES) {
      const unitPath = path.join(linuxUnitDir(), name);
      if (!fs.existsSync(unitPath)) continue;
      const text = readTextOrNull(unitPath);
      const target = text === null ? null : parseUnitExecStart(text);
      found.push({ platform, name, definitionPath: unitPath, target, installedByFleet: targetIsInstalledTree(target, platform) });
    }
  } else if (platform === 'darwin') {
    const plistPath = macosPlistPath();
    if (fs.existsSync(plistPath)) {
      const text = readTextOrNull(plistPath);
      const target = text === null ? null : parsePlistProgramArguments(text);
      found.push({
        platform, name: SUPERVISOR_MACOS_LABEL, definitionPath: plistPath, target,
        installedByFleet: targetIsInstalledTree(target, platform),
      });
    }
  } else if (platform === 'win32') {
    let xml: string | null = null;
    try {
      const raw = execFileSync('schtasks', ['/Query', '/TN', SUPERVISOR_WINDOWS_TASK_NAME, '/XML'], QUIET);
      xml = raw == null ? null : decodeSchtasks(raw as Buffer | string);
    } catch {
      xml = null; // task not registered
    }
    if (xml !== null && /<Task[\s>]/i.test(xml)) {
      const target = parseTaskXmlAction(xml);
      found.push({
        platform, name: SUPERVISOR_WINDOWS_TASK_NAME, target,
        installedByFleet: targetIsInstalledTree(target, platform),
      });
    }
  }
  return found;
}

function errText(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const stderr = e?.stderr ? String(e.stderr).trim() : '';
  return (stderr || e?.message || String(err)).trim();
}

/** Removes `p` if present; pushes a failure when the unlink itself fails. */
function unlinkIfPresent(p: string, failures: string[]): void {
  if (!fs.existsSync(p)) return;
  try {
    fs.unlinkSync(p);
  } catch (err) {
    failures.push(`could not delete ${p}: ${errText(err)}`);
  }
}

function removeLinux(reg: SupervisorRegistration, failures: string[]): void {
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', reg.name], QUIET);
  } catch (err) {
    failures.push(`systemctl --user disable --now ${reg.name} failed: ${errText(err)}`);
  }
  if (reg.definitionPath) unlinkIfPresent(reg.definitionPath, failures);
  try {
    execFileSync('systemctl', ['--user', 'daemon-reload'], QUIET);
  } catch (err) {
    failures.push(`systemctl --user daemon-reload failed: ${errText(err)}`);
  }
}

function removeMacos(reg: SupervisorRegistration, failures: string[]): void {
  try {
    execFileSync('launchctl', ['bootout', `gui/${macosUid()}/${reg.name}`], QUIET);
  } catch (err) {
    // A plist that exists but is not loaded is fine: there is nothing to stop.
    const status = (err as { status?: number }).status;
    const text = errText(err);
    if (!(status === 3 || status === 113 || /no such process|could not find/i.test(text))) {
      failures.push(`launchctl bootout gui/${macosUid()}/${reg.name} failed: ${text}`);
    }
  }
  if (reg.definitionPath) unlinkIfPresent(reg.definitionPath, failures);
}

/**
 * PIDs whose command line references this user's supervisor wrapper, its
 * launcher, or the installed serve.mjs. Every needle is a FULL path under this
 * user's BIN_DIR / WORKFLOWS_DIR, never a bare filename: Win32_Process lists
 * every user's processes to an elevated caller, and a bare-name match would
 * tree-kill another user's supervisor.
 */
function findWindowsSupervisorPids(): number[] {
  const needles = [
    windowsWrapperPath(),
    windowsLauncherPath(),
    path.join(WORKFLOWS_DIR, 'fleet-sprint', 'bin', 'serve.mjs'),
  ].map(n => n.toLowerCase().replace(/'/g, "''"));
  const cond = needles.map(n => `$_.CommandLine.ToLower().Contains('${n}')`).join(' -or ');
  const script = [
    'Get-CimInstance Win32_Process',
    `Where-Object { $_.CommandLine -and (${cond}) }`,
    'ForEach-Object { $_.ProcessId }',
  ].join(' | ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', ...QUIET,
  });
  return String(out ?? '')
    .split(/\r?\n/)
    .map(line => Number.parseInt(line.trim(), 10))
    .filter(pid => Number.isInteger(pid) && pid > 0);
}

function removeWindows(reg: SupervisorRegistration, failures: string[]): void {
  // Discover and tree-kill BEFORE deleting the task: deleting the task does not
  // stop a running wrapper, and its child (the process holding the port) would
  // survive as an orphan.
  let pids: number[] = [];
  try {
    pids = findWindowsSupervisorPids();
  } catch (err) {
    failures.push(`could not determine whether the ${reg.name} process tree is running: ${errText(err)}`);
  }
  for (const pid of pids) {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], QUIET);
    } catch (err) {
      const status = (err as { status?: number }).status;
      const text = errText(err);
      if (status === 128 || /not found/i.test(text)) continue; // already gone
      failures.push(`taskkill /F /T /PID ${pid} failed: ${text}`);
    }
  }
  try {
    execFileSync('schtasks', ['/Delete', '/TN', reg.name, '/F'], QUIET);
  } catch (err) {
    failures.push(`schtasks /Delete /TN ${reg.name} /F failed: ${errText(err)}`);
  }
  unlinkIfPresent(windowsWrapperPath(), failures);
  unlinkIfPresent(windowsLauncherPath(), failures);
}

/**
 * Stop, disable and remove one registration. Throws an Error naming every
 * step that failed (after attempting all of them).
 */
export function removeSupervisorRegistration(reg: SupervisorRegistration): void {
  const failures: string[] = [];
  if (reg.platform === 'linux') removeLinux(reg, failures);
  else if (reg.platform === 'darwin') removeMacos(reg, failures);
  else removeWindows(reg, failures);
  if (failures.length > 0) throw new Error(failures.join('; '));
}

export interface SupervisorCleanupResult {
  /** Registrations removed (or, under dry-run, that would be removed). */
  removed: SupervisorRegistration[];
  /** Known-name registrations left in place because they are not ours. */
  kept: SupervisorRegistration[];
  /** Registrations whose removal failed, with the error text. */
  failed: { reg: SupervisorRegistration; error: string }[];
}

/**
 * Find and remove every installed-tree supervisor registration on this OS,
 * printing one line per registration. Under dryRun prints the same plan and
 * runs no mutating command.
 */
export function cleanupSupervisorService(dryRun: boolean): SupervisorCleanupResult {
  const result: SupervisorCleanupResult = { removed: [], kept: [], failed: [] };
  const regs = findSupervisorRegistrations();
  if (regs.length === 0) return result;
  const ours = regs.filter(r => r.installedByFleet);
  result.kept = regs.filter(r => !r.installedByFleet);
  if (ours.length === 0) return result;

  console.log('Cleaning up fleet-supervisor service...');
  for (const reg of ours) {
    console.log(`  - Removing fleet-supervisor service registration: ${reg.name}`);
    if (dryRun) {
      result.removed.push(reg);
      continue;
    }
    try {
      removeSupervisorRegistration(reg);
      result.removed.push(reg);
    } catch (err) {
      const error = (err as Error).message;
      console.error(`  [FAIL] Could not remove fleet-supervisor service registration ${reg.name}: ${error}`);
      result.failed.push({ reg, error });
    }
  }
  return result;
}
