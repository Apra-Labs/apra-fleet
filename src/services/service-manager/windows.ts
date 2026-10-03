import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RegisterResult, ServiceManager, ServiceStatus } from './types.js';
import { WINDOWS_TASK_NAME, SERVICE_ENV_MARKER } from './types.js';
import { gracefulStopByServerJson } from './index.js';
import { clearServiceStartFailures } from '../service-start-guard.js';
import { readStoppedMarker } from '../stopped-marker.js';
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
  return path.win32.join(path.win32.dirname(wrapperPath), 'apra-fleet-service.js');
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
  }

  async register(binaryPath: string, args: string[], logPath: string): Promise<RegisterResult> {
    this.reusedExistingTask = false;
    // The wrapper is rewritten BEFORE /create so that a reused task (below)
    // also launches the new binary.
    fs.mkdirSync(path.dirname(this.wrapperPath), { recursive: true });
    // The wrapper's >> redirect fails (exit 1, nothing logged) when the log
    // dir is missing; create it now -- the wrapper also re-creates it.
    try { fs.mkdirSync(path.win32.dirname(logPath), { recursive: true }); } catch { /* the wrapper retries */ }
    fs.writeFileSync(this.wrapperPath, buildWrapperBat(binaryPath, args, logPath), 'utf8');
    const launcherPath = launcherPathFor(this.wrapperPath);
    fs.writeFileSync(launcherPath, buildLauncherJs(this.wrapperPath), 'utf8');
    // S4: Windows Script Host can be disabled by policy; then the hidden
    // launcher never runs. Fall back to running the .bat directly (a visible
    // console window) and say so.
    const hidden = this.probeWsh(this.env, path.dirname(this.wrapperPath));
    if (!hidden) {
      console.warn(
        '    Windows Script Host is unavailable, so the server cannot be launched hidden: it will run in a ' +
        'visible console window. Do not close that window (closing it stops the server).',
      );
    }
    const runValue = hidden ? `"${wscriptPath(this.env)}" ${launcherArguments(launcherPath)}` : `"${this.wrapperPath}"`;

    const xmlPath = path.join(path.dirname(this.wrapperPath), 'apra-fleet-task.xml');
    const xml = buildTaskXml({
      command: hidden ? wscriptPath(this.env) : this.wrapperPath,
      arguments: hidden ? launcherArguments(launcherPath) : undefined,
      userId: resolveTaskUserId(this.env, this.whoami),
      startBoundary: localStartBoundary(this.now()),
      repeatMinutes: repeatMinutesFrom(this.env),
    });
    let createMsg: string;
    try {
      fs.writeFileSync(xmlPath, encodeTaskXml(xml));
      this.runSchtasks(['/create', '/tn', WINDOWS_TASK_NAME, '/xml', xmlPath, '/f']);
      // A task now covers logon autostart: drop a Run-key fallback left by an
      // earlier install so the server is not launched twice at logon.
      this.deleteRunKey();
      return 'created';
    } catch (createErr) {
      createMsg = (createErr as Error).message;
    } finally {
      try { fs.unlinkSync(xmlPath); } catch { /* best-effort */ }
    }

    // /create failed (typically "Access is denied" -- localized, so not
    // matched -- when the existing task was created elevated): reuse the
    // existing task only if it already runs our wrapper.
    let command: string | null = null;
    let taskArgs: string | null = null;
    let taskFound = false;
    try {
      const existing = this.runSchtasks(['/query', '/tn', WINDOWS_TASK_NAME, '/xml']);
      command = taskXmlCommand(existing);
      taskArgs = taskXmlArguments(existing);
      taskFound = true;
    } catch { /* no task */ }
    // Ours: the wrapper itself (tasks from earlier installs) or wscript
    // running our hidden launcher.
    const runsOurs = command !== null && (
      normalizeTaskPath(command) === normalizeTaskPath(this.wrapperPath)
      || (/wscript\.exe"?$/i.test(command.trim()) && taskArgs !== null
        && normalizeTaskPath(taskArgs).includes(normalizeTaskPath(launcherPath)))
    );
    if (taskFound && runsOurs) {
      this.reusedExistingTask = true;
      return 'reused';
    }
    if (taskFound) {
      throw new Error(
        `schtasks /create failed and the existing ${WINDOWS_TASK_NAME} task runs ${command ?? '(unknown)'}, ` +
        `not ${this.wrapperPath}: ${createMsg}`,
      );
    }

    // Last resort: a per-user HKCU Run entry. Logon autostart only -- nothing
    // revives a server that dies mid-session.
    try {
      this.runReg(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', runValue, '/f']);
    } catch (regErr) {
      throw new Error(
        `schtasks /create failed and no existing ${WINDOWS_TASK_NAME} task was found: ${createMsg}; ` +
        `the HKCU Run fallback also failed: ${(regErr as Error).message}`,
      );
    }
    return 'run-key';
  }

  async unregister(): Promise<void> {
    try {
      this.runSchtasks(['/delete', '/tn', WINDOWS_TASK_NAME, '/f']);
    } catch {
      // Tolerate task-not-found
    }
    this.deleteRunKey();
    try { fs.unlinkSync(this.wrapperPath); } catch {}
    try { fs.unlinkSync(launcherPathFor(this.wrapperPath)); } catch {}
  }

  async start(): Promise<void> {
    // An explicit start is never skipped by the failed-start backoff.
    clearServiceStartFailures();
    if (!this.taskExists()) {
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
        console.warn(
          `Could not disable the ${WINDOWS_TASK_NAME} task (${(err as Error).message.trim()}); ` +
          'its triggers may start the server again.',
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
    try { enabled = taskXmlEnabled(this.runSchtasks(['/query', '/tn', WINDOWS_TASK_NAME, '/xml'])); } catch { /* keep default */ }
    const result: ServiceStatus = { installed: true, running: status === 'Running', enabled };
    if (!enabled) {
      result.detail = this.stoppedByUser()
        ? "stopped by user -- 'apra-fleet start' re-enables it"
        : "task disabled outside apra-fleet -- 'apra-fleet start' re-enables it";
    }
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
