import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RegisterResult, ServiceManager, ServiceStatus } from './types.js';
import { WINDOWS_TASK_NAME, SERVICE_ENV_MARKER } from './types.js';
import { gracefulStopByServerJson } from './index.js';
import { clearServiceStartFailures } from '../service-start-guard.js';
import { readStoppedMarker } from '../stopped-marker.js';
import { SERVICE_NOTICE_PATH, writeServiceNotice, clearServiceNotice } from '../service-notice.js';
import { BIN_DIR } from '../../cli/config.js';

const WRAPPER_PATH = path.join(BIN_DIR, 'apra-fleet-service.bat');

/** HKCU Run key used ONLY as the last-resort fallback (logon autostart, no restart). */
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
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
  /** Resolves DOMAIN\user when USERDOMAIN/USERNAME are missing (default: whoami). */
  whoami?: () => string;
  /** Launch a command detached and hidden (default: child_process.spawn + unref). */
  spawnDetached?: (cmd: string, args: string[], verbatim?: boolean) => void;
  /** Whether Windows Script Host can run the hidden launcher (default: run a probe script). */
  probeWsh?: (env: Record<string, string | undefined>, dir: string) => boolean;
  /** Whether `apra-fleet stop` left the stopped-by-user marker (default: read it). */
  stoppedByUser?: () => boolean;
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
 * DOMAIN\user of the current account, resolved in JS (never by shell
 * expansion). A standard user may only register a logon trigger scoped to
 * THEIR OWN account -- an unscoped LogonTrigger means "any user" and needs
 * elevation (verified in a Windows Sandbox spike, Win10 19041).
 */
export function resolveTaskUserId(
  env: Record<string, string | undefined> = process.env,
  whoami: () => string = () => decodeSchtasks(quietExec('whoami', [])),
): string {
  const user = env.USERNAME?.trim();
  const domain = env.USERDOMAIN?.trim();
  if (user && domain) return `${domain}\\${user}`;
  try {
    const out = whoami().trim();
    if (/^[^\\\s]+\\[^\\]+$/.test(out)) return out;
  } catch { /* fall through */ }
  let name = user;
  if (!name) { try { name = os.userInfo().username; } catch { /* below */ } }
  let dom = domain;
  if (!dom) { try { dom = os.hostname(); } catch { /* below */ } }
  return `${dom || '.'}\\${name || 'unknown'}`;
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
export function buildWrapperBat(binaryPath: string, args: string[], logPath: string): string {
  const logDir = path.win32.dirname(logPath);
  const quotedArgs = args.map(a => `"${a}"`).join(' ');
  return [
    '@echo off',
    // The file is UTF-8; cmd reads each following line in the active code
    // page, so switch to UTF-8 first -- otherwise a non-ASCII profile path
    // (C:\Users\Jos<e-acute>) is garbled and the server never starts.
    'chcp 65001>nul',
    `set ${SERVICE_ENV_MARKER}=1`,
    `if not exist "${logDir}\\" mkdir "${logDir}"`,
    `"${binaryPath}" ${quotedArgs} >> "${logPath}" 2>&1`,
  ].join('\r\n');
}

/** The hidden launcher script that sits next to the wrapper. */
export function launcherPathFor(wrapperPath: string): string {
  // A Windows-style wrapper path (drive letter, UNC or backslashes) keeps win32
  // semantics; a POSIX absolute path must stay POSIX or path.win32 turns it
  // into a cwd-relative '\\tmp\\...' string.
  const flavor = /^[A-Za-z]:|^\\\\|\\/.test(wrapperPath) ? path.win32 : path.posix;
  return flavor.join(flavor.dirname(wrapperPath), 'apra-fleet-service.js');
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
export function legacyTaskFix(problems: LegacyTaskProblem[]): string {
  if (!problems.includes('elevated')) {
    return ['To upgrade it, run from a normal prompt:', '    apra-fleet install --force'].join('\n');
  }
  return [
    'To upgrade it, run once from an elevated prompt (Run as administrator):',
    `    schtasks /delete /tn ${WINDOWS_TASK_NAME} /f`,
    'then, from a normal prompt (do not run the install itself elevated):',
    '    apra-fleet install --force',
  ].join('\n');
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
  repeatMinutes: number;
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
    '    <Description>Apra Fleet MCP server (per-user). Managed by apra-fleet install/start/stop/uninstall.</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${user}</UserId>`,
    '    </LogonTrigger>',
    '    <TimeTrigger>',
    '      <Repetition>',
    `        <Interval>PT${p.repeatMinutes}M</Interval>`,
    '        <StopAtDurationEnd>false</StopAtDurationEnd>',
    '      </Repetition>',
    `      <StartBoundary>${xmlEscape(p.startBoundary)}</StartBoundary>`,
    '      <Enabled>true</Enabled>',
    '    </TimeTrigger>',
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

export class WindowsServiceManager implements ServiceManager {
  private reusedExistingTask = false;
  private readonly runReg: RegRunner;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => Date;
  private readonly whoami?: () => string;
  private readonly spawnDetached: (cmd: string, args: string[], verbatim?: boolean) => void;
  private readonly probeWsh: (env: Record<string, string | undefined>, dir: string) => boolean;
  private readonly stoppedByUser: () => boolean;
  private readonly interactive: () => boolean;
  private readonly noticePath: string;

  constructor(
    private readonly runSchtasks: SchtasksRunner = defaultSchtasksRunner,
    private readonly wrapperPath: string = WRAPPER_PATH,
    opts: WindowsServiceOptions = {},
  ) {
    this.runReg = opts.runReg ?? defaultRegRunner;
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? (() => new Date());
    this.whoami = opts.whoami;
    this.spawnDetached = opts.spawnDetached ?? defaultSpawnDetached;
    this.probeWsh = opts.probeWsh ?? defaultProbeWsh;
    this.stoppedByUser = opts.stoppedByUser ?? (() => readStoppedMarker() !== null);
    this.interactive = opts.interactive ?? (() => !!process.stdout.isTTY);
    this.noticePath = opts.noticePath ?? SERVICE_NOTICE_PATH;
  }

  async register(binaryPath: string, args: string[], logPath: string): Promise<RegisterResult> {
    this.reusedExistingTask = false;
    // The wrapper is rewritten BEFORE /create so that a reused task (below)
    // also launches the new binary.
    fs.mkdirSync(path.dirname(this.wrapperPath), { recursive: true });
    // The wrapper's >> redirect fails (exit 1, nothing logged) when the log
    // dir is missing; create it now -- the wrapper also re-creates it.
    try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch { /* the wrapper retries */ }
    fs.writeFileSync(this.wrapperPath, buildWrapperBat(binaryPath, args, logPath), 'utf8');
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
        '    Windows Script Host is unavailable, so the server cannot be launched hidden: it will run in a ' +
        'visible console window. Do not close that window (closing it stops the server).',
      );
    };
    const runValue = hidden ? `"${wscriptPath(this.env)}" ${launcherArguments(launcherPath)}` : `"${this.wrapperPath}"`;

    const xmlPath = path.join(path.dirname(this.wrapperPath), 'apra-fleet-task.xml');
    const xml = buildTaskXml({
      command: hidden ? wscriptPath(this.env) : this.wrapperPath,
      arguments: hidden ? launcherArguments(launcherPath) : undefined,
      userId: resolveTaskUserId(this.env, this.whoami),
      startBoundary: localStartBoundary(this.now()),
      repeatMinutes: repeatMinutesFrom(this.env),
    });
    /** Registers the task from the XML; null on success, else the error message. */
    const tryCreate = (): string | null => {
      try {
        fs.writeFileSync(xmlPath, encodeTaskXml(xml));
        this.runSchtasks(['/create', '/tn', WINDOWS_TASK_NAME, '/xml', xmlPath, '/f']);
        return null;
      } catch (createErr) {
        return (createErr as Error).message;
      } finally {
        try { fs.unlinkSync(xmlPath); } catch { /* best-effort */ }
      }
    };
    const created = (): RegisterResult => {
      // A task now covers logon autostart: drop a Run-key fallback left by an
      // earlier install so the server is not launched twice at logon.
      this.deleteRunKey();
      clearServiceNotice(this.noticePath);
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
      existing = this.runSchtasks(['/query', '/tn', WINDOWS_TASK_NAME, '/xml']);
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
      writeServiceNotice(guidance, this.noticePath, new Date(), this.interactive());
      appendServiceLog(logPath, guidance);
    };
    // A split task runs "C:\Users\John" and never starts the server: reusing
    // it would leave no autostart. Report it and fall through to the HKCU Run
    // entry below until the user replaces the task.
    const splitTask = taskFound && runsSplit;
    if (splitTask) {
      const problems = legacyTaskProblems(existing, { launcherPath, launcherExpected: hidden, wrapperPath: this.wrapperPath });
      if (!problems.includes('split-path')) problems.push('split-path');
      reportLegacy(problems);
    } else if (taskFound && (runsWrapper || runsLauncher)) {
      const problems = legacyTaskProblems(existing, { launcherPath, launcherExpected: hidden, wrapperPath: this.wrapperPath });
      if (problems.length > 0) {
        reportLegacy(problems);
      } else {
        clearServiceNotice(this.noticePath);
      }
      this.reusedExistingTask = true;
      // A reused launcher task needs the launcher (written above); a reused
      // .bat task runs visibly whatever the probe said.
      if (runsWrapper && !hidden) visibleFallback();
      return 'reused';
    }
    if (taskFound && !splitTask) {
      throw new Error(
        `schtasks /create failed and the existing ${WINDOWS_TASK_NAME} task runs ${command ?? '(unknown)'}, ` +
        `not ${this.wrapperPath}: ${createMsg}`,
      );
    }

    // Last resort: a per-user HKCU Run entry. Logon autostart only -- nothing
    // revives a server that dies mid-session. Say WHY the task was refused:
    // without it the fallback is undiagnosable.
    console.warn(`    schtasks /create failed: ${schtasksErrorReason(createMsg)}`);
    if (!hidden) visibleFallback();
    if (!splitTask) clearServiceNotice(this.noticePath);
    try {
      this.runReg(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', runValue, '/f']);
    } catch (regErr) {
      throw new Error(
        `schtasks /create failed and ${splitTask ? `the existing ${WINDOWS_TASK_NAME} task cannot start the server`
          : `no existing ${WINDOWS_TASK_NAME} task was found`}: ${createMsg}; ` +
        `the HKCU Run fallback also failed: ${(regErr as Error).message}`,
      );
    }
    return 'run-key';
  }

  /** Problems of the installed task when it is a legacy one (empty: current or unreadable). */
  private installedLegacyProblems(): LegacyTaskProblem[] {
    try {
      const raw = this.runSchtasks(['/query', '/tn', WINDOWS_TASK_NAME, '/xml']);
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
    try {
      this.runSchtasks(['/delete', '/tn', WINDOWS_TASK_NAME, '/f']);
    } catch {
      // Tolerate task-not-found
    }
    this.deleteRunKey();
    clearServiceNotice(this.noticePath);
    try { fs.unlinkSync(this.wrapperPath); } catch {}
    try { fs.unlinkSync(launcherPathFor(this.wrapperPath)); } catch {}
  }

  async start(): Promise<void> {
    // An explicit start is never skipped by the failed-start backoff.
    clearServiceStartFailures();
    const task = this.taskExists();
    // A 0.4.3 task split at a space never starts the server: install then
    // added the Run entry, which start must use instead of the task. (A task
    // this install just reused is never a split one.)
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
      throw new Error(`no ${WINDOWS_TASK_NAME} task or HKCU Run entry is registered -- run apra-fleet install`);
    }
    // A user stop disabled the task (so its revive trigger cannot undo the
    // stop); starting re-enables it. A disabled task also refuses /run.
    // Best-effort: a reused (elevated) task may refuse /change, and /run
    // below then surfaces the real failure.
    try { this.runSchtasks(['/change', '/tn', WINDOWS_TASK_NAME, '/enable']); } catch { /* see above */ }
    if (this.reusedExistingTask) {
      // Reused task: run synchronously so a failure is surfaced, not swallowed.
      try {
        this.runSchtasks(['/run', '/tn', WINDOWS_TASK_NAME]);
      } catch (err) {
        throw new Error(`schtasks /run /tn ${WINDOWS_TASK_NAME} failed: ${(err as Error).message}`);
      }
      return;
    }
    // Detached so schtasks /run does not block the installer (on some Windows
    // versions it waits for the launched process).
    this.spawnDetached('schtasks', ['/run', '/tn', WINDOWS_TASK_NAME]);
  }

  async stop(): Promise<boolean> {
    // Disable FIRST: the task's repeating trigger would otherwise relaunch the
    // server within one interval, undoing a deliberate stop. start/install
    // re-enable it.
    if (this.taskExists()) {
      try {
        this.runSchtasks(['/change', '/tn', WINDOWS_TASK_NAME, '/disable']);
      } catch (err) {
        console.warn(`Could not disable the ${WINDOWS_TASK_NAME} task (${(err as Error).message.trim()}).`);
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

  async query(): Promise<ServiceStatus> {
    let out: string;
    try {
      out = decodeSchtasks(this.runSchtasks(['/query', '/tn', WINDOWS_TASK_NAME, '/fo', 'csv', '/nh']));
    } catch {
      if (this.runKeyExists()) {
        return {
          installed: true, running: false, enabled: true,
          detail: 'logon autostart via HKCU Run -- no automatic restart; re-run apra-fleet install to retry the task',
        };
      }
      return { installed: false, running: false };
    }
    // CSV line: "TaskName","Next Run Time","Status"
    const line = out.trim().split(/\r?\n/)[0] ?? '';
    const cols = line.split('","');
    const status = (cols[2] ?? '').replace(/"/g, '').trim();
    // GitHub #585: report enabled, so status no longer shows every installed
    // task as "installed (disabled)". If the XML query itself fails the task
    // still exists (the CSV query just answered), so default to enabled.
    let enabled = true;
    let legacy: LegacyTaskProblem[] = [];
    try {
      const raw = this.runSchtasks(['/query', '/tn', WINDOWS_TASK_NAME, '/xml']);
      enabled = taskXmlEnabled(raw);
      legacy = this.legacyProblemsOf(raw);
    } catch { /* keep defaults */ }
    const result: ServiceStatus = { installed: true, running: status === 'Running', enabled };
    const details: string[] = [];
    if (!enabled) {
      details.push(this.stoppedByUser()
        ? "stopped by user -- 'apra-fleet start' re-enables it"
        : "task disabled outside apra-fleet -- 'apra-fleet start' re-enables it");
    }
    if (legacy.length > 0) {
      details.push(legacyTaskDetail(legacy));
      result.notice = legacyTaskFix(legacy);
    }
    if (details.length > 0) result.detail = details.join('; ');
    return result;
  }

  async isInstalled(): Promise<boolean> {
    return this.taskExists() || this.runKeyExists();
  }

  private taskExists(): boolean {
    try {
      this.runSchtasks(['/query', '/tn', WINDOWS_TASK_NAME]);
      return true;
    } catch {
      return false;
    }
  }

  private runKeyExists(): boolean {
    try {
      this.runReg(['query', RUN_KEY, '/v', RUN_VALUE]);
      return true;
    } catch {
      return false;
    }
  }

  private deleteRunKey(): void {
    try { this.runReg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']); } catch { /* absent */ }
  }
}
