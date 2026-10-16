import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { RegisterOptions, RegisterResult, ServiceDescriptor, ServiceId, ServiceManager, ServiceStatus } from './types.js';
import { DEFAULT_SERVICE_ID, WINDOWS_TASK_NAME, SERVICE_ENV_MARKER, getServiceDescriptor } from './types.js';
import { gracefulStopByServerJson } from './index.js';
import { clearServiceStartFailures } from '../service-start-guard.js';
import { readStoppedMarker } from '../stopped-marker.js';
import { SERVICE_NOTICE_PATH, writeServiceNotice, clearServiceNotice } from '../service-notice.js';
import { BIN_DIR } from '../../cli/config.js';
import { selfInvocationLines } from '../../cli/install-guard.js';
import { currentWindowsUser } from '../../utils/owner-only-fs.js';

/** HKCU Run key used ONLY as the last-resort fallback (logon autostart, no restart). */
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
/** The MCP server's Run value name; every service uses its own task name as its value. */
export const RUN_VALUE = WINDOWS_TASK_NAME;

/** Default repeat interval of the task's revive trigger. */
export const DEFAULT_REPEAT_MINUTES = 5;
/**
 * Test-only override of the revive-trigger interval in minutes (1..1440), so a
 * manual non-admin verification does not have to wait 5 minutes per cycle.
 * Read once at register() time; not a supported user setting.
 */
export const REPEAT_MINUTES_ENV = 'APRA_FLEET_TASK_REPEAT_MINUTES';

/** Runs schtasks synchronously; throws on a non-zero exit. Injectable for tests. */
export type SchtasksRunner = (args: string[]) => Buffer | string;
/** Runs reg.exe synchronously; throws on a non-zero exit. Injectable for tests. */
export type RegRunner = (args: string[]) => Buffer | string;

export interface WindowsServiceOptions {
  runReg?: RegRunner;
  env?: Record<string, string | undefined>;
  /** Clock for the time trigger's StartBoundary. */
  now?: () => Date;
  /** Resolves DOMAIN\user from the process token (default: whoami). */
  whoami?: () => string;
  /** Launch a command detached and hidden (default: child_process.spawn + unref). */
  spawnDetached?: (cmd: string, args: string[], verbatim?: boolean) => void;
  /** Whether Windows Script Host can run the hidden launcher (default: run a probe script). */
  probeWsh?: (env: Record<string, string | undefined>, dir: string) => boolean;
  /** Whether `apra-fleet stop` left the stopped-by-user marker (default: read it). */
  stoppedByUser?: () => boolean;
  /**
   * Numeric Get-ScheduledTask state of a task ('1'..'4'), 'NOTFOUND', or null
   * when the probe cannot answer (the schtasks CSV/XML read then decides).
   * Default: an -EncodedCommand PowerShell probe when schtasks itself is the
   * real runner. With an injected schtasks runner, that runner is the single
   * authority for task state, so the default probe is off.
   */
  probeTaskState?: (taskName: string) => string | null;
  /** Whether install output reaches a console (default: stdout is a TTY; apra-fleet update runs install detached). */
  interactive?: () => boolean;
  /** Pending-notice file for guidance a detached install could not show (default: SERVICE_NOTICE_PATH). */
  noticePath?: string;
}

// GitHub #585: every schtasks/taskkill/reg call pipes ALL stdio (stderr too)
// and hides its console window. Inherited stderr printed schtasks' localized
// "ERROR: The system cannot find the file specified." above apra-fleet status
// whenever no task was registered.
const QUIET = { stdio: 'pipe', windowsHide: true, timeout: 30_000 } as const;

function quietExec(cmd: string, args: string[]): Buffer {
  return execFileSync(cmd, args, QUIET);
}

const defaultSchtasksRunner: SchtasksRunner = (args) => quietExec('schtasks', args);
const defaultRegRunner: RegRunner = (args) => quietExec('reg', args);

/**
 * The schtasks error text of a failed run, without execFileSync's
 * "Command failed: <command line>" prefix, on one line.
 */
export function schtasksErrorReason(msg: string): string {
  const lines = msg.split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^Command failed:/i.test(l));
  return lines.join(' ') || msg.trim() || '(no error text)';
}

/** Append a timestamped install message to the service log (best-effort). */
function appendServiceLog(logPath: string, text: string): void {
  try {
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] apra-fleet install: ${text.replace(/\n/g, '\r\n')}\r\n`);
  } catch { /* best-effort */ }
}

function indent(text: string, by = '    '): string {
  return text.split('\n').map(l => by + l).join('\n');
}

function defaultSpawnDetached(cmd: string, args: string[], verbatim = false): void {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: verbatim });
  child.unref();
}

/** Decode schtasks output (UTF-16 with BOM, or a single-byte codepage). */
function decodeSchtasks(raw: Buffer | string): string {
  const text = typeof raw === 'string' ? raw
    : raw.toString(raw[0] === 0xff && raw[1] === 0xfe ? 'utf16le' : 'utf8');
  return text.replace(/\u0000/g, '');
}

/**
 * Whether a task's XML definition is enabled. Task Scheduler's
 * <Settings><Enabled> defaults to true when absent; XML tag names are not
 * localized (unlike the CSV/LIST status text).
 */
export function taskXmlEnabled(raw: Buffer | string): boolean {
  const settings = /<Settings>([\s\S]*?)<\/Settings>/i.exec(decodeSchtasks(raw));
  if (!settings) return true;
  const m = /<Enabled>\s*(true|false)\s*<\/Enabled>/i.exec(settings[1]);
  return m ? m[1].toLowerCase() === 'true' : true;
}

function normalizeTaskPath(p: string): string {
  return p.replace(/"/g, '').replace(/\//g, '\\').trim().toLowerCase();
}

/**
 * The <Command> of an existing task's XML definition, or null. schtasks may
 * emit UTF-16, so NUL chars are stripped before parsing; XML tag names are
 * not localized, unlike schtasks' human-readable output.
 */
export function taskXmlCommand(raw: Buffer | string): string | null {
  const m = /<Command>([\s\S]*?)<\/Command>/i.exec(decodeSchtasks(raw));
  return m ? xmlUnescape(m[1].trim()) : null;
}

/** Escape a value for an XML text node (every interpolated value goes through this). */
export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * DOMAIN\user of the current account, read from the process token (whoami),
 * never from env USERDOMAIN (WORKGROUP under Win32-OpenSSH on a workgroup
 * machine) and never by shell expansion. A standard user may only register a
 * logon trigger scoped to THEIR OWN account -- an unscoped LogonTrigger means
 * "any user" and needs elevation (verified in a Windows Sandbox spike, Win10 19041).
 */
export function resolveTaskUserId(
  whoami: () => string = () => decodeSchtasks(quietExec('whoami', [])),
): string {
  return currentWindowsUser(whoami);
}

/** Local wall-clock time as Task Scheduler's StartBoundary (no zone = local). */
export function localStartBoundary(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

export function repeatMinutesFrom(env: Record<string, string | undefined>): number {
  const n = parseInt(env[REPEAT_MINUTES_ENV] ?? '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 1440 ? n : DEFAULT_REPEAT_MINUTES;
}

/**
 * The service wrapper (.bat): sets the service-launch marker, makes sure the
 * log dir exists (a deleted data dir must not make every revive fail the
 * `>>` redirect before the server even starts), then runs the server with
 * output appended to the log. Its exit code is the server's.
 */
export function buildWrapperBat(
  binaryPath: string, args: string[], logPath: string,
  opts: { serviceMarker?: boolean; workingDirectory?: string } = {},
): string {
  const logDir = path.win32.dirname(logPath);
  const quotedArgs = args.map(a => `"${a}"`).join(' ');
  return [
    '@echo off',
    // The file is UTF-8; cmd reads each following line in the active code
    // page, so switch to UTF-8 first -- otherwise a non-ASCII profile path
    // (C:\Users\Jos<e-acute>) is garbled and the server never starts.
    'chcp 65001>nul',
    // Lets the MCP server tell it runs under a service manager (GitHub #584).
    // Only the server reads it; the supervisor must not leak the marker into
    // the processes it spawns (serviceMarker: false).
    ...(opts.serviceMarker === false ? [] : [`set ${SERVICE_ENV_MARKER}=1`]),
    `if not exist "${logDir}\\" mkdir "${logDir}"`,
    // Scheduled tasks inherit no working directory from the operator's shell;
    // `cd /d` handles a drive change as well as the directory change.
    ...(opts.workingDirectory ? [`cd /d "${opts.workingDirectory}"`] : []),
    `"${binaryPath}" ${quotedArgs} >> "${logPath}" 2>&1`,
  ].join('\r\n');
}

/**
 * The hidden launcher script that sits next to the wrapper: the wrapper's base
 * name with a .js extension (apra-fleet-service.bat -> apra-fleet-service.js),
 * so every registered service has its own launcher.
 */
export function launcherPathFor(wrapperPath: string): string {
  // Swap only the extension: path.win32.join would rewrite every '/' of a host
  // (POSIX) path to '\\', yielding a single backslash-named file in the cwd.
  return `${wrapperPath.replace(/\.bat$/i, '')}.js`;
}

/**
 * JScript launcher run by wscript.exe: starts the wrapper with window style 0
 * (no console on the user's desktop -- an InteractiveToken task running the
 * .bat directly opens a visible cmd window on every start/revive, and closing
 * it kills the server), waits for it, and returns its exit code so Task
 * Scheduler's Last Result stays meaningful. The path is embedded as a JSON
 * string literal (valid JScript: backslashes and quotes escaped).
 */
export function buildLauncherJs(wrapperPath: string): string {
  return [
    '// apra-fleet service launcher (generated by apra-fleet install): runs the',
    '// service wrapper hidden and returns its exit code to Task Scheduler.',
    "var shell = new ActiveXObject('WScript.Shell');",
    `var wrapper = ${asciiJsString(wrapperPath)};`,
    "WScript.Quit(shell.Run('\"' + wrapper + '\"', 0, true));",
    '',
  ].join('\r\n');
}

/**
 * A JScript string literal that is pure ASCII: JSON escaping plus \uXXXX for
 * every non-ASCII char. WSH decodes a .js file in the ANSI code page, so a
 * UTF-8 path (C:\Users\Jos<e-acute>) made the launcher silently exit 0
 * without running the wrapper; an ASCII file reads identically in every code
 * page (chosen over UTF-16LE+BOM: no encoding dependency at all).
 */
export function asciiJsString(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/**
 * Whether Windows Script Host runs here (it can be disabled by policy): runs a
 * one-line probe script that must exit 42. Any other outcome -> no WSH.
 */
export function defaultProbeWsh(env: Record<string, string | undefined>, dir: string): boolean {
  const probe = path.join(dir, 'apra-fleet-wsh-probe.js');
  try {
    fs.writeFileSync(probe, 'WScript.Quit(42);\r\n');
    execFileSync(wscriptPath(env), ['//B', '//Nologo', '//E:JScript', probe], { stdio: 'pipe', windowsHide: true, timeout: 15_000 });
    return false;
  } catch (err) {
    return (err as { status?: number }).status === 42;
  } finally {
    try { fs.unlinkSync(probe); } catch { /* best-effort */ }
  }
}

/** wscript.exe, resolved in JS from SystemRoot (no shell expansion). */
export function wscriptPath(env: Record<string, string | undefined> = process.env): string {
  return path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'wscript.exe');
}

/** wscript arguments for the launcher: batch mode, no logo, forced JScript engine. */
export function launcherArguments(launcherPath: string): string {
  return `//B //Nologo //E:JScript "${launcherPath}"`;
}

/** The <Arguments> of an existing task's XML definition, or null. */
export function taskXmlArguments(raw: Buffer | string): string | null {
  const m = /<Arguments>([\s\S]*?)<\/Arguments>/i.exec(decodeSchtasks(raw));
  return m ? xmlUnescape(m[1].trim()) : null;
}

/** Whether a task action is wscript.exe running `launcherPath` (our hidden launcher). */
function runsOurLauncher(command: string | null, args: string | null, launcherPath: string): boolean {
  return command !== null && /wscript\.exe"?$/i.test(command.trim()) && args !== null
    && normalizeTaskPath(args).includes(normalizeTaskPath(launcherPath));
}

/**
 * What a legacy ApraFleet task (registered by apra-fleet 0.4.3 or earlier
 * with `schtasks /sc onlogon`) lacks compared with the current definition:
 *  - 'no-revive': no trigger with a repeating <Repetition><Interval> (nothing
 *    revives a killed or crashed server);
 *  - 'visible-console': the action is not wscript.exe + our hidden launcher
 *    (the .bat runs in a visible console). Only reported when the launcher is
 *    expected -- with Windows Script Host disabled the current task runs the
 *    .bat directly too;
 *  - 'split-path': the wrapper path was split at a space into <Command> +
 *    <Arguments> (0.4.3 passed it to /tr unquoted, e.g. a "C:\Users\John
 *    Smith" profile), so the task runs "C:\Users\John" and never starts the
 *    server. Needs opts.wrapperPath;
 *  - 'elevated': a LogonTrigger without <UserId> ("any user" logon), which only
 *    an elevated shell can register -- so a normal shell can neither replace
 *    nor disable it.
 * Empty for the current definition, and for XML without a <Triggers> section
 * (unreadable: never classed legacy). XML tag names are not localized.
 */
export type LegacyTaskProblem = 'no-revive' | 'visible-console' | 'split-path' | 'elevated';

/** Whether the action is `wrapperPath` split at a space into Command + Arguments. */
export function runsSplitWrapper(command: string | null, args: string | null, wrapperPath: string): boolean {
  if (command === null || args === null || !args.trim()) return false;
  return normalizeTaskPath(`${command} ${args}`) === normalizeTaskPath(wrapperPath)
    && normalizeTaskPath(command) !== normalizeTaskPath(wrapperPath);
}

export function legacyTaskProblems(
  raw: Buffer | string,
  opts: { launcherPath: string; launcherExpected: boolean; wrapperPath?: string },
): LegacyTaskProblem[] {
  const xml = decodeSchtasks(raw);
  const problems: LegacyTaskProblem[] = [];
  // No <Triggers> section (truncated/unreadable output): no claim, so a
  // parse problem never produces upgrade guidance.
  const triggersMatch = /<Triggers>([\s\S]*?)<\/Triggers>/i.exec(xml);
  if (!triggersMatch) return problems;
  const triggers = triggersMatch[1];
  const repeating = [...triggers.matchAll(/<(TimeTrigger|CalendarTrigger)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .some(m => /<Repetition>[\s\S]*?<Interval>\s*P[^<]*<\/Interval>/i.test(m[2]));
  if (!repeating) problems.push('no-revive');
  const command = taskXmlCommand(xml);
  const args = taskXmlArguments(xml);
  const split = !!opts.wrapperPath && runsSplitWrapper(command, args, opts.wrapperPath);
  // A split task never starts the server, so it has no console to speak of.
  if (!split && opts.launcherExpected && !runsOurLauncher(command, args, opts.launcherPath)) {
    problems.push('visible-console');
  }
  if (split) problems.push('split-path');
  const logonTriggers = [...triggers.matchAll(/<LogonTrigger\b[^>]*>([\s\S]*?)<\/LogonTrigger>|<LogonTrigger\b[^>]*\/>/gi)];
  if (logonTriggers.some(m => !/<UserId>\s*\S[\s\S]*?<\/UserId>/i.test(m[1] ?? ''))) problems.push('elevated');
  return problems;
}

const LEGACY_PROBLEM_TEXT: Record<LegacyTaskProblem, string> = {
  'no-revive': 'no automatic revive after a crash',
  'visible-console': 'the server runs in a visible console window',
  'split-path': 'the task command is split at a space in the install path, so the server does not start',
  'elevated': "'apra-fleet stop' cannot disable the task",
};

/** Short form for apra-fleet status: "legacy task (upgrade needed: ...)". */
export function legacyTaskDetail(problems: LegacyTaskProblem[]): string {
  return `legacy task (upgrade needed: ${problems.map(p => LEGACY_PROBLEM_TEXT[p]).join('; ')})`;
}

/**
 * The exact manual fix, shared by install, status and stop. The elevated
 * delete is only needed for an elevated-owned task ('elevated'); a user-owned
 * old-form task is replaced by a plain re-install. apra-fleet never runs
 * anything elevated itself and never needs an elevated install. --force: the
 * server the old task started is normally still running, and install refuses
 * to replace a running server without it.
 */
export function legacyTaskFix(problems: LegacyTaskProblem[], execPath: string = process.execPath): string {
  const install = upgradeCommandLines(execPath).map(l => `    ${l}`);
  if (!problems.includes('elevated')) {
    return ['To upgrade it, run from a normal prompt:', ...install].join('\n');
  }
  return [
    'To upgrade it, run once from an elevated prompt (Run as administrator):',
    `    schtasks /delete /tn ${WINDOWS_TASK_NAME} /f`,
    'then, from a normal prompt (do not run the install itself elevated):',
    ...install,
  ].join('\n');
}

/**
 * `install --force` as a command that works where this runs. A standalone
 * install does not put apra-fleet on PATH: the running installer names its
 * own path (like the running-server refusal); the installed binary (status,
 * stop) points at the downloaded installer; node (npm global/dev) has
 * apra-fleet on PATH.
 */
export function upgradeCommandLines(execPath: string): string[] {
  const base = path.win32.basename(execPath).toLowerCase();
  if (base === 'node.exe' || base === 'node') return ['apra-fleet install --force'];
  if (path.win32.resolve(execPath).toLowerCase() === path.win32.resolve(BIN_DIR, 'apra-fleet.exe').toLowerCase()) {
    return ['<the apra-fleet installer .exe you downloaded> install --force'];
  }
  return selfInvocationLines({ platform: 'win32', execPath, sea: true, args: ['install', '--force'] });
}

/** Full actionable guidance: what is missing and the exact fix. */
export function legacyTaskGuidance(problems: LegacyTaskProblem[]): string {
  const intro = problems.includes('elevated')
    ? [`The ${WINDOWS_TASK_NAME} scheduled task was registered by an older apra-fleet from an elevated prompt,`,
      'so it cannot be replaced from a normal shell and is still in use. Missing:']
    : [`The ${WINDOWS_TASK_NAME} scheduled task was registered by an older apra-fleet and is still in use. Missing:`];
  return [
    ...intro,
    ...problems.map(p => `  - ${LEGACY_PROBLEM_TEXT[p]}`),
    legacyTaskFix(problems),
  ].join('\n');
}

export interface TaskXmlParams {
  command: string;
  /** Exec <Arguments>, XML-escaped like every other value. */
  arguments?: string;
  userId: string;
  startBoundary: string;
  /**
   * Revive-trigger interval. null omits the TimeTrigger entirely: a service
   * declared restartOnFailure=false (the fleet supervisor) starts at logon
   * only, and an exit is final until the next logon or explicit start.
   */
  repeatMinutes: number | null;
  /** RegistrationInfo description (default: the MCP server's). */
  description?: string;
}

/**
 * The ApraFleet task definition (GitHub #585 recovery). User-level only:
 *  - LogonTrigger scoped to the current user (the only form a standard user
 *    may register);
 *  - a TimeTrigger repeating every N minutes, indefinitely, which revives a
 *    server that was killed or crashed. Task Scheduler's RestartOnFailure is
 *    deliberately NOT used: it never fires for a non-zero exit or a killed
 *    process (only for launch failures);
 *  - MultipleInstancesPolicy IgnoreNew makes the trigger a no-op while the
 *    server runs; ExecutionTimeLimit PT0S = no time limit;
 *  - InteractiveToken + LeastPrivilege: runs as the logged-on user, never
 *    elevated, never as a system account.
 */
export function buildTaskXml(p: TaskXmlParams): string {
  const user = xmlEscape(p.userId);
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${xmlEscape(p.description ?? 'Apra Fleet MCP server (per-user). Managed by apra-fleet install/start/stop/uninstall.')}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${user}</UserId>`,
    '    </LogonTrigger>',
    ...(p.repeatMinutes === null ? [] : [
      '    <TimeTrigger>',
      '      <Repetition>',
      `        <Interval>PT${p.repeatMinutes}M</Interval>`,
      '        <StopAtDurationEnd>false</StopAtDurationEnd>',
      '      </Repetition>',
      `      <StartBoundary>${xmlEscape(p.startBoundary)}</StartBoundary>`,
      '      <Enabled>true</Enabled>',
      '    </TimeTrigger>',
    ]),
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${user}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xmlEscape(p.command)}</Command>`,
    ...(p.arguments ? [`      <Arguments>${xmlEscape(p.arguments)}</Arguments>`] : []),
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/** UTF-16LE with BOM -- what schtasks /xml expects for a UTF-16 declaration. */
export function encodeTaskXml(xml: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

/** Decode a probe's numeric ScheduledTask state into a status, or null to fall back. */
function statusFromProbedState(value: string | null): ServiceStatus | null {
  // Numeric ScheduledTask state enum: 1=Disabled, 2=Queued, 3=Ready,
  // 4=Running (0=Unknown, which falls through to the CSV fallback).
  switch (value) {
    case 'NOTFOUND': return { installed: false, running: false };
    case '4': return { installed: true, running: true, enabled: true };
    case '1': return { installed: true, running: false, enabled: false };
    case '2':
    case '3': return { installed: true, running: false, enabled: true };
    default: return null;
  }
}

/**
 * Default `Get-ScheduledTask` state probe. PowerShell is invoked as an
 * explicit `-EncodedCommand` (CLAUDE.md: never rely on shell-level expansion
 * in a Windows command string); the only interpolated value is the
 * descriptor's fixed ASCII task name. null when the probe cannot run.
 */
export function defaultProbeTaskState(taskName: string): string | null {
  const needle = taskName.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$t = Get-ScheduledTask -TaskName '${needle}'`,
    "if ($t) { [int]$t.State } else { 'NOTFOUND' }",
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    // GitHub #585: pipe all stdio and hide the window, like every other
    // status probe, so nothing prints above apra-fleet status.
    const out = String(execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', ...QUIET },
    ) ?? '');
    return out.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop() ?? null;
  } catch {
    // No powershell, or it exited non-zero: the probe is unusable here.
    return null;
  }
}

/**
 * One OS service (the MCP server or the fleet supervisor) as a per-user
 * scheduled task. Every service gets main's user-level model (GitHub #585):
 * a user-scoped XML task (a standard user cannot register /sc onlogon), the
 * hidden JScript launcher, the existing-task reuse and the HKCU Run last
 * resort. Only a service declared restartOnFailure (the MCP server) gets the
 * repeating revive trigger, and only the MCP server's stop disables its task
 * and honours the stopped-by-user marker / start backoff -- the supervisor is
 * Restart=no and is stopped by a wrapper tree-kill (see stop()).
 */
export class WindowsServiceManager implements ServiceManager {
  readonly serviceId: ServiceId;
  private readonly descriptor: ServiceDescriptor;
  private readonly taskName: string;
  /** Wrapper .bat this service's scheduled task runs. One per service. */
  private readonly wrapperPath: string;
  private readonly runSchtasks: SchtasksRunner;
  private reusedExistingTask = false;
  private readonly runReg: RegRunner;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => Date;
  private readonly whoami?: () => string;
  private readonly spawnDetached: (cmd: string, args: string[], verbatim?: boolean) => void;
  private readonly probeWsh: (env: Record<string, string | undefined>, dir: string) => boolean;
  private readonly stoppedByUser: () => boolean;
  private readonly probeTaskState: (taskName: string) => string | null;
  private readonly interactive: () => boolean;
  private readonly noticePath: string;

  constructor(
    serviceId: ServiceId = DEFAULT_SERVICE_ID,
    runSchtasks: SchtasksRunner = defaultSchtasksRunner,
    wrapperPath?: string,
    opts: WindowsServiceOptions = {},
  ) {
    this.serviceId = serviceId;
    this.descriptor = getServiceDescriptor(serviceId);
    this.taskName = this.descriptor.windowsTaskName;
    this.wrapperPath = wrapperPath ?? path.join(BIN_DIR, this.descriptor.windowsWrapperFileName);
    this.runSchtasks = runSchtasks;
    this.runReg = opts.runReg ?? defaultRegRunner;
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? (() => new Date());
    this.whoami = opts.whoami;
    this.spawnDetached = opts.spawnDetached ?? defaultSpawnDetached;
    this.probeWsh = opts.probeWsh ?? defaultProbeWsh;
    this.stoppedByUser = opts.stoppedByUser ?? (() => readStoppedMarker() !== null);
    this.probeTaskState = opts.probeTaskState
      ?? (runSchtasks === defaultSchtasksRunner ? defaultProbeTaskState : () => null);
    this.interactive = opts.interactive ?? (() => !!process.stdout.isTTY);
    this.noticePath = opts.noticePath ?? SERVICE_NOTICE_PATH;
  }

  /** Only the MCP server has the server.json handshake, stop marker and start backoff. */
  private get isMcpServer(): boolean {
    return this.descriptor.gracefulStopViaServerJson;
  }

  /** HKCU Run value name of this service (the MCP server's is RUN_VALUE). */
  private get runValue(): string {
    return this.taskName;
  }

  async register(
    binaryPath: string, args: string[], logPath: string, options: RegisterOptions = {},
  ): Promise<RegisterResult> {
    this.reusedExistingTask = false;
    // The wrapper is rewritten BEFORE /create so that a reused task (below)
    // also launches the new binary.
    fs.mkdirSync(path.dirname(this.wrapperPath), { recursive: true });
    // The wrapper's >> redirect fails (exit 1, nothing logged) when the log
    // dir is missing; create it now -- the wrapper also re-creates it.
    // Host path module (identical on win32): path.win32.dirname on a POSIX
    // host turns 'C:\\log.txt' into a backslash-named dir in the cwd.
    try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch { /* the wrapper retries */ }
    fs.writeFileSync(this.wrapperPath, buildWrapperBat(binaryPath, args, logPath, {
      serviceMarker: this.isMcpServer,
      workingDirectory: options.workingDirectory,
    }), 'utf8');
    const launcherPath = launcherPathFor(this.wrapperPath);
    fs.writeFileSync(launcherPath, buildLauncherJs(this.wrapperPath), 'utf8');
    // S4: Windows Script Host can be disabled by policy; then the hidden
    // launcher never runs. Fall back to running the .bat directly (a visible
    // console window) and say so.
    const hidden = this.probeWsh(this.env, path.dirname(this.wrapperPath));
    // Applied only once we know what will launch the server: a task/Run entry
    // registered for the .bat must leave no launcher behind (start() in
    // Run-entry mode prefers it), but a reused task that already runs wscript +
    // our launcher keeps it -- the probe can give a false negative (timeout
    // under slow AV, failed probe-file write).
    const visibleFallback = (): void => {
      try { fs.unlinkSync(launcherPath); } catch { /* absent */ }
      console.warn(
        `    Windows Script Host is unavailable, so the ${this.descriptor.description} cannot be launched hidden: it will run in a ` +
        'visible console window. Do not close that window (closing it stops the server).',
      );
    };
    const runValue = hidden ? `"${wscriptPath(this.env)}" ${launcherArguments(launcherPath)}` : `"${this.wrapperPath}"`;

    const wrapperBase = path.basename(this.wrapperPath).replace(/(-service)?\.bat$/i, '');
    const xmlPath = path.join(path.dirname(this.wrapperPath), `${wrapperBase}-task.xml`);
    const xml = buildTaskXml({
      command: hidden ? wscriptPath(this.env) : this.wrapperPath,
      arguments: hidden ? launcherArguments(launcherPath) : undefined,
      userId: resolveTaskUserId(this.whoami),
      startBoundary: localStartBoundary(this.now()),
      repeatMinutes: this.descriptor.restartOnFailure ? repeatMinutesFrom(this.env) : null,
      description: this.isMcpServer
        ? undefined
        : `${this.descriptor.description} (per-user). Managed by apra-fleet install/start/stop/uninstall.`,
    });
    /** Registers the task from the XML; null on success, else the error message. */
    const tryCreate = (): string | null => {
      try {
        fs.writeFileSync(xmlPath, encodeTaskXml(xml));
        this.runSchtasks(['/create', '/tn', this.taskName, '/xml', xmlPath, '/f']);
        return null;
      } catch (createErr) {
        return (createErr as Error).message;
      } finally {
        try { fs.unlinkSync(xmlPath); } catch { /* best-effort */ }
      }
    };
    const created = (): RegisterResult => {
      // A task now covers logon autostart: drop a Run-key fallback left by an
      // earlier install so the service is not launched twice at logon.
      this.deleteRunKey();
      this.clearOwnNotice();
      if (!hidden) visibleFallback();
      return 'created';
    };
    const createMsg = tryCreate();
    if (createMsg === null) return created();

    // /create failed (typically "Access is denied" -- localized, so not
    // matched -- when the existing task was created elevated): reuse the
    // existing task only if it already runs our wrapper.
    let command: string | null = null;
    let taskArgs: string | null = null;
    let existing: Buffer | string = '';
    let taskFound = false;
    try {
      existing = this.runSchtasks(['/query', '/tn', this.taskName, '/xml']);
      command = taskXmlCommand(existing);
      taskArgs = taskXmlArguments(existing);
      taskFound = true;
    } catch { /* no task */ }
    // Ours: the wrapper itself (tasks from earlier installs), the wrapper split
    // at a space by 0.4.3's unquoted /tr (broken, so legacy), or wscript
    // running our hidden launcher.
    const runsWrapper = command !== null && normalizeTaskPath(command) === normalizeTaskPath(this.wrapperPath);
    const runsSplit = runsSplitWrapper(command, taskArgs, this.wrapperPath);
    const runsLauncher = runsOurLauncher(command, taskArgs, launcherPath);
    /** Prints the manual fix for a legacy task /create could not replace, and persists it. */
    const reportLegacy = (problems: LegacyTaskProblem[]): void => {
      // /create was just refused, so this task cannot be disabled either.
      // apra-fleet never elevates: the user gets the exact manual fix.
      if (!problems.includes('elevated')) problems.push('elevated');
      const guidance = legacyTaskGuidance(problems);
      console.warn(indent(guidance));
      // A detached install (apra-fleet update) has no console: persist it
      // for the next service verb (already shown when this one is
      // interactive), and leave it in the service log.
      if (this.isMcpServer) writeServiceNotice(guidance, this.noticePath, new Date(), this.interactive());
      appendServiceLog(logPath, guidance);
    };
    // A split task runs "C:\Users\John" and never starts the server: reusing
    // it would leave no autostart. Report it and fall through to the HKCU Run
    // entry below until the user replaces the task.
    // Legacy forms (split, old-style triggers) exist only for the MCP server
    // task; every other service's task is judged by its own descriptor, so
    // e.g. a supervisor task without a revive trigger is never "legacy".
    const splitTask = this.isMcpServer && taskFound && runsSplit;
    if (splitTask) {
      const problems = legacyTaskProblems(existing, { launcherPath, launcherExpected: hidden, wrapperPath: this.wrapperPath });
      if (!problems.includes('split-path')) problems.push('split-path');
      reportLegacy(problems);
    } else if (taskFound && (runsWrapper || runsLauncher)) {
      const problems = this.isMcpServer
        ? legacyTaskProblems(existing, { launcherPath, launcherExpected: hidden, wrapperPath: this.wrapperPath })
        : [];
      if (problems.length > 0) {
        reportLegacy(problems);
      } else {
        this.clearOwnNotice();
      }
      this.reusedExistingTask = true;
      // A reused launcher task needs the launcher (written above); a reused
      // .bat task runs visibly whatever the probe said.
      if (runsWrapper && !hidden) visibleFallback();
      return 'reused';
    }
    if (taskFound && !splitTask) {
      throw new Error(
        `schtasks /create failed and the existing ${this.taskName} task runs ${command ?? '(unknown)'}, ` +
        `not ${this.wrapperPath}: ${createMsg}`,
      );
    }

    // Last resort: a per-user HKCU Run entry. Logon autostart only -- nothing
    // revives a service that dies mid-session. Say WHY the task was refused:
    // without it the fallback is undiagnosable.
    console.warn(`    schtasks /create failed: ${schtasksErrorReason(createMsg)}`);
    if (!hidden) visibleFallback();
    if (!splitTask) this.clearOwnNotice();
    try {
      this.runReg(['add', RUN_KEY, '/v', this.runValue, '/t', 'REG_SZ', '/d', runValue, '/f']);
    } catch (regErr) {
      throw new Error(
        `schtasks /create failed and ${splitTask ? `the existing ${this.taskName} task cannot start the service`
          : `no existing ${this.taskName} task was found`}: ${createMsg}; ` +
        `the HKCU Run fallback also failed: ${(regErr as Error).message}`,
      );
    }
    return 'run-key';
  }

  /**
   * Clears the pending service notice -- only for the MCP server, whose legacy
   * task guidance is the only thing written there, so registering or removing
   * another service never erases it.
   */
  private clearOwnNotice(): void {
    if (this.isMcpServer) clearServiceNotice(this.noticePath);
  }

  /** Problems of the installed task when it is a legacy one (empty: current or unreadable). */
  private installedLegacyProblems(): LegacyTaskProblem[] {
    // Only the MCP server task predates this release (0.4.3 registered no
    // other service), so no other service has a legacy form to detect.
    if (!this.isMcpServer) return [];
    try {
      const raw = this.runSchtasks(['/query', '/tn', this.taskName, '/xml']);
      return this.legacyProblemsOf(raw);
    } catch {
      return [];
    }
  }

  private legacyProblemsOf(raw: Buffer | string): LegacyTaskProblem[] {
    const launcherPath = launcherPathFor(this.wrapperPath);
    // Only OUR task (wrapper, split wrapper, or wscript + our launcher) gets
    // upgrade advice: a foreign task named ApraFleet must not be told to
    // delete itself.
    const command = taskXmlCommand(raw);
    const args = taskXmlArguments(raw);
    const ours = (command !== null && normalizeTaskPath(command) === normalizeTaskPath(this.wrapperPath))
      || runsSplitWrapper(command, args, this.wrapperPath)
      || runsOurLauncher(command, args, launcherPath);
    if (!ours) return [];
    // install keeps the launcher only when the task should use it (WSH works).
    let launcherExpected = false;
    try { launcherExpected = fs.existsSync(launcherPath); } catch { /* treat as absent */ }
    return legacyTaskProblems(raw, { launcherPath, launcherExpected, wrapperPath: this.wrapperPath });
  }

  async unregister(): Promise<void> {
    // `schtasks /delete` only removes the scheduled task definition -- it does
    // NOT terminate a wrapper process that is already running. The task's own
    // process is the launcher/wrapper, and the child it spawns is the one
    // actually holding the service's port, so deleting the task alone leaves
    // that child as an orphan surviving `apra-fleet uninstall`.
    //
    // Services with a server.json graceful-stop handshake (the MCP server)
    // are excluded here: callers stop those explicitly before unregistering
    // (see src/cli/uninstall.ts). Everything else reuses stop()'s discovery +
    // tree-kill mechanism, best-effort -- unregister() has always been
    // tolerant of "not registered" / "nothing running" and must stay that way.
    if (!this.isMcpServer) {
      try {
        const pids = this.findWrapperProcessIds();
        for (const pid of pids) {
          try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], QUIET); } catch {}
        }
      } catch {
        // Could not even query for live wrapper processes -- tolerate and
        // still proceed to delete the task (unlike stop(), which is loud here).
      }
    }
    try {
      this.runSchtasks(['/delete', '/tn', this.taskName, '/f']);
    } catch {
      // Tolerate task-not-found
    }
    this.deleteRunKey();
    this.clearOwnNotice();
    try { fs.unlinkSync(this.wrapperPath); } catch {}
    try { fs.unlinkSync(launcherPathFor(this.wrapperPath)); } catch {}
  }

  async start(): Promise<void> {
    // An explicit start is never skipped by the MCP server's failed-start
    // backoff (the backoff state belongs to the MCP server only).
    if (this.isMcpServer) clearServiceStartFailures();
    const task = this.taskExists();
    // A 0.4.3 task split at a space never starts the server: install then
    // added the Run entry, which start must use instead of the task. (A task
    // this install just reused is never a split one; only the MCP server can
    // have such a legacy task -- installedLegacyProblems() is empty otherwise.)
    if (!task || (!this.reusedExistingTask && this.runKeyExists()
      && this.installedLegacyProblems().includes('split-path'))) {
      if (this.runKeyExists()) {
        // HKCU Run fallback: no task to run -- launch the way the Run entry
        // does: the hidden launcher, or (no launcher) cmd with the wrapper
        // quoted verbatim so a path with & or spaces stays one argument.
        const launcher = launcherPathFor(this.wrapperPath);
        if (fs.existsSync(launcher)) {
          this.spawnDetached(wscriptPath(this.env), ['//B', '//Nologo', '//E:JScript', launcher]);
        } else {
          this.spawnDetached('cmd.exe', ['/d', '/s', '/c', `""${this.wrapperPath}""`], true);
        }
        return;
      }
      throw new Error(`no ${this.taskName} task or HKCU Run entry is registered -- run apra-fleet install`);
    }
    // A user stop disabled the task (so its revive trigger cannot undo the
    // stop); starting re-enables it. A disabled task also refuses /run.
    // Best-effort: a reused (elevated) task may refuse /change, and /run
    // below then surfaces the real failure.
    try { this.runSchtasks(['/change', '/tn', this.taskName, '/enable']); } catch { /* see above */ }
    if (this.reusedExistingTask) {
      // Reused task: run synchronously so a failure is surfaced, not swallowed.
      try {
        this.runSchtasks(['/run', '/tn', this.taskName]);
      } catch (err) {
        throw new Error(`schtasks /run /tn ${this.taskName} failed: ${(err as Error).message}`);
      }
      return;
    }
    // Detached so schtasks /run does not block the installer (on some Windows
    // versions it waits for the launched process).
    this.spawnDetached('schtasks', ['/run', '/tn', this.taskName]);
  }

  /**
   * Process ids of this service's wrapper that are live now.
   *
   * The task runs the hidden launcher (or the wrapper .bat directly), which
   * runs the wrapper in a cmd.exe whose command line contains the wrapper
   * file name; the process actually holding the service's port is that
   * cmd.exe's CHILD. Matching on the descriptor's per-service wrapper file
   * name is also what scopes this to ONE service: the MCP server's wrapper is
   * a different file name and can never match.
   *
   * PowerShell is invoked as an explicit `-EncodedCommand` rather than a raw
   * one-liner (CLAUDE.md: never rely on shell-level expansion on Windows), so
   * no path or argument is ever handed to a shell to re-parse. The only
   * interpolated value is the descriptor's fixed ASCII wrapper file name, and
   * it is single-quote escaped anyway.
   *
   * Throws if the query itself cannot be run -- see stop() for why that is
   * deliberately not swallowed. An empty result (nothing running) is not an
   * error.
   */
  private findWrapperProcessIds(): number[] {
    const needle = this.descriptor.windowsWrapperFileName.replace(/'/g, "''");
    const script = [
      'Get-CimInstance Win32_Process',
      `Where-Object { $_.CommandLine -like '*${needle}*' }`,
      'ForEach-Object { $_.ProcessId }',
    ].join(' | ');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { encoding: 'utf8', ...QUIET },
    );
    return String(out ?? '')
      .split(/\r?\n/)
      .map(line => Number.parseInt(line.trim(), 10))
      .filter(pid => Number.isInteger(pid) && pid > 0);
  }

  async stop(): Promise<boolean> {
    if (this.isMcpServer) {
      // Disable FIRST: the task's repeating trigger would otherwise relaunch
      // the server within one interval, undoing a deliberate stop.
      // start/install re-enable it.
      if (this.taskExists()) {
        try {
          this.runSchtasks(['/change', '/tn', this.taskName, '/disable']);
        } catch (err) {
          console.warn(`Could not disable the ${this.taskName} task (${(err as Error).message.trim()}).`);
          const problems = this.installedLegacyProblems();
          if (problems.length > 0) {
            // Disabling was just refused, whatever the XML says.
            if (!problems.includes('elevated')) problems.push('elevated');
            console.warn(legacyTaskGuidance(problems));
          }
          // The stopped-by-user marker (written by apra-fleet stop) makes every
          // service launch exit without starting the server.
          console.warn(
            "A stop made with 'apra-fleet stop' still holds: until 'apra-fleet start', every launch of the task " +
            'exits without starting the server.',
          );
        }
      }
      return gracefulStopByServerJson((pid) => {
        try { quietExec('taskkill', ['/F', '/PID', String(pid)]); } catch {}
      });
    }
    // Services other than the MCP server never write server.json, so there is
    // no graceful HTTP handshake to use. `schtasks /end` ALONE is not enough:
    // the scheduled task's own process is the launcher/wrapper, and the
    // process holding the service's port is its child. Ending the task can
    // leave that child alive as an orphan still bound to the port while
    // query() reports the task as not Running.
    //
    // Mechanism: resolve the wrapper pid(s) via Win32_Process, then
    // `taskkill /F /T /PID <pid>` each one -- /T takes the wrapper's whole
    // descendant tree down with it. Discovery runs BEFORE any /end: ending the
    // task first destroys the parent link the tree-kill needs. `schtasks /end`
    // still runs afterwards so Task Scheduler's bookkeeping agrees.
    let pids: number[];
    try {
      pids = this.findWrapperProcessIds();
    } catch (err: any) {
      // Not being able to tell whether the tree survived is a failure, not a
      // success: callers (src/cli/stop.ts) print "stopped" whenever stop()
      // resolves, so swallowing this would report a false success.
      throw new Error(
        `Could not determine whether the ${this.taskName} process tree is still running `
        + `(${err?.message ?? err}).`,
      );
    }

    const failures: string[] = [];
    for (const pid of pids) {
      try {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], QUIET);
      } catch (err: any) {
        // taskkill exits 128 / "not found" when the process ended between the
        // query and the kill. The tree is gone, which is the goal -- tolerate.
        const message = String(err?.message ?? err);
        if (err?.status === 128 || /not found/i.test(message)) continue;
        failures.push(`pid ${pid}: ${message}`);
      }
    }

    // Tolerated: the task may not be registered, or may already have ended.
    try { execFileSync('schtasks', ['/end', '/tn', this.taskName], QUIET); } catch {}

    if (failures.length > 0) {
      throw new Error(
        `Failed to terminate the ${this.taskName} process tree (${failures.join('; ')}).`,
      );
    }
    return true;
  }

  /**
   * Registration + run state of THIS service.
   *
   * Preferred source is the `Get-ScheduledTask` probe (numeric, locale-
   * independent state enum, and the only source that answers "enabled"
   * directly); the `schtasks` CSV + XML read is the fallback where the probe
   * cannot answer. No task but an HKCU Run entry -> installed with logon
   * autostart only. A disabled task carries a `detail` saying why (stopped by
   * the user, or disabled outside apra-fleet) and how to re-enable it.
   */
  async query(): Promise<ServiceStatus> {
    const status = statusFromProbedState(this.probeTaskState(this.taskName)) ?? this.queryViaSchtasksCsv();
    if (!status.installed) {
      if (this.runKeyExists()) {
        return {
          installed: true, running: false, enabled: true,
          detail: 'logon autostart via HKCU Run -- no automatic restart; re-run apra-fleet install to retry the task',
        };
      }
      return status;
    }
    const details: string[] = [];
    if (status.enabled === false) {
      details.push(this.isMcpServer && this.stoppedByUser()
        ? "stopped by user -- 'apra-fleet start' re-enables it"
        : "task disabled outside apra-fleet -- 'apra-fleet start' re-enables it");
    }
    // A legacy (0.4.3-era) task: only the MCP server can have one, so this is
    // empty for every other service (installedLegacyProblems() gates it).
    const legacy = this.installedLegacyProblems();
    if (legacy.length > 0) {
      details.push(legacyTaskDetail(legacy));
      status.notice = legacyTaskFix(legacy);
    }
    if (details.length > 0) status.detail = details.join('; ');
    return status;
  }

  /**
   * `schtasks` CSV read. Never invents an `enabled` value: it comes from the
   * task's XML definition (GitHub #585; tag names are not localized) when
   * that query returns a real task definition, else from an explicit CSV
   * status, else it is left undefined.
   */
  private queryViaSchtasksCsv(): ServiceStatus {
    let out: string;
    try {
      out = decodeSchtasks(this.runSchtasks(['/query', '/tn', this.taskName, '/fo', 'csv', '/nh']));
    } catch {
      return { installed: false, running: false };
    }
    // CSV line: "TaskName","Next Run Time","Status"
    const line = String(out ?? '').trim().split(/\r?\n/)[0] ?? '';
    const cols = line.split('","');
    const status = (cols[2] ?? '').replace(/"/g, '').trim();
    let xmlEnabled: boolean | null = null;
    try {
      const raw = this.runSchtasks(['/query', '/tn', this.taskName, '/xml']);
      if (/<Task[\s>]/i.test(decodeSchtasks(raw))) xmlEnabled = taskXmlEnabled(raw);
    } catch { /* XML unavailable: fall through to the CSV status */ }
    if (xmlEnabled !== null) {
      return { installed: true, running: status === 'Running', enabled: xmlEnabled };
    }
    if (status === 'Disabled') return { installed: true, running: false, enabled: false };
    if (status === 'Running') return { installed: true, running: true, enabled: true };
    // Localized or otherwise unrecognized: registered, not observably
    // running, enable state unknown. Deliberately no `enabled` key.
    return { installed: true, running: false };
  }

  async isInstalled(): Promise<boolean> {
    return this.taskExists() || this.runKeyExists();
  }

  private taskExists(): boolean {
    try {
      this.runSchtasks(['/query', '/tn', this.taskName]);
      return true;
    } catch {
      return false;
    }
  }

  private runKeyExists(): boolean {
    try {
      this.runReg(['query', RUN_KEY, '/v', this.runValue]);
      return true;
    } catch {
      return false;
    }
  }

  private deleteRunKey(): void {
    try { this.runReg(['delete', RUN_KEY, '/v', this.runValue, '/f']); } catch { /* absent */ }
  }
}
