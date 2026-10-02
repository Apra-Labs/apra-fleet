import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { RegisterOptions, RegisterResult, ServiceDescriptor, ServiceId, ServiceManager, ServiceStatus } from './types.js';
import { DEFAULT_SERVICE_ID, SERVICE_ENV_MARKER, getServiceDescriptor } from './types.js';
import { gracefulStopByServerJson } from './index.js';
import { BIN_DIR } from '../../cli/config.js';

/** Runs schtasks synchronously; throws on a non-zero exit. Injectable for tests. */
export type SchtasksRunner = (args: string[]) => Buffer | string;

// GitHub #585: every schtasks/taskkill call pipes ALL stdio (stderr too) and
// hides its console window. Inherited stderr printed schtasks' localized
// "ERROR: The system cannot find the file specified." above apra-fleet status
// whenever no task was registered.
const QUIET = { stdio: 'pipe', windowsHide: true, timeout: 30_000 } as const;

function quietExec(cmd: string, args: string[]): Buffer {
  return execFileSync(cmd, args, QUIET);
}

const defaultSchtasksRunner: SchtasksRunner = (args) => quietExec('schtasks', args);

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
  const decoded = typeof raw === 'string' ? raw
    : raw.toString(raw[0] === 0xff && raw[1] === 0xfe ? 'utf16le' : 'utf8');
  const text = decoded.replace(/\u0000/g, '');
  const m = /<Command>([\s\S]*?)<\/Command>/i.exec(text);
  return m ? m[1].trim() : null;
}

export class WindowsServiceManager implements ServiceManager {
  readonly serviceId: ServiceId;
  private readonly descriptor: ServiceDescriptor;
  /** Wrapper .bat this service's scheduled task runs. One per service. */
  private readonly wrapperPath: string;
  private readonly taskName: string;
  private readonly runSchtasks: SchtasksRunner;
  private reusedExistingTask = false;

  constructor(
    serviceId: ServiceId = DEFAULT_SERVICE_ID,
    runSchtasks: SchtasksRunner = defaultSchtasksRunner,
    wrapperPath?: string,
  ) {
    this.serviceId = serviceId;
    this.descriptor = getServiceDescriptor(serviceId);
    this.wrapperPath = wrapperPath ?? path.join(BIN_DIR, this.descriptor.windowsWrapperFileName);
    this.taskName = this.descriptor.windowsTaskName;
    this.runSchtasks = runSchtasks;
  }

  async register(
    binaryPath: string, args: string[], logPath: string, options: RegisterOptions = {},
  ): Promise<RegisterResult> {
    this.reusedExistingTask = false;
    // The wrapper is rewritten BEFORE /create so that a reused task (below)
    // also launches the new binary.
    fs.mkdirSync(path.dirname(this.wrapperPath), { recursive: true });
    const quotedArgs = args.map(a => `"${a}"`).join(' ');
    const lines = ['@echo off'];
    // Lets the MCP server tell it runs under a service manager (GitHub #584).
    // Only the server reads it; the supervisor must not leak the marker into
    // the processes it spawns.
    if (this.descriptor.gracefulStopViaServerJson) {
      lines.push(`set ${SERVICE_ENV_MARKER}=1`);
    }
    // Scheduled tasks inherit no working directory from the operator's shell;
    // `cd /d` handles a drive change as well as the directory change.
    if (options.workingDirectory) {
      lines.push(`cd /d "${options.workingDirectory}"`);
    }
    lines.push(`"${binaryPath}" ${quotedArgs} >> "${logPath}" 2>&1`);
    fs.writeFileSync(this.wrapperPath, lines.join('\r\n'), 'utf8');
    try {
      this.runSchtasks([
        '/create', '/tn', this.taskName,
        '/tr', this.wrapperPath,
        '/sc', 'onlogon', '/rl', 'limited', '/f',
      ]);
      return 'created';
    } catch (createErr) {
      // Any /create failure (typically "Access is denied" -- localized, so not
      // matched -- when the existing task was created elevated): reuse the
      // existing task only if it already runs our wrapper.
      const createMsg = (createErr as Error).message;
      let command: string | null;
      try {
        command = taskXmlCommand(this.runSchtasks(['/query', '/tn', this.taskName, '/xml']));
      } catch {
        throw new Error(`schtasks /create failed and no existing ${this.taskName} task was found: ${createMsg}`);
      }
      if (command === null || normalizeTaskPath(command) !== normalizeTaskPath(this.wrapperPath)) {
        throw new Error(
          `schtasks /create failed and the existing ${this.taskName} task runs ${command ?? '(unknown)'}, ` +
          `not ${this.wrapperPath}: ${createMsg}`,
        );
      }
      this.reusedExistingTask = true;
      return 'reused';
    }
  }

  async unregister(): Promise<void> {
    // `schtasks /delete` only removes the scheduled task definition -- it does
    // NOT terminate a wrapper process that is already running. The task's own
    // process is the wrapper cmd.exe, and the apra-fleet child spawned by it
    // is the one actually holding the service's port, so deleting the task
    // alone leaves that child as an orphan surviving `apra-fleet uninstall`.
    //
    // Services with a server.json graceful-stop handshake (the MCP server)
    // are excluded here: callers stop those explicitly before unregistering
    // (see src/cli/uninstall.ts), and running the HTTP handshake as a side
    // effect of unregister() would be new, unrequested behavior for that
    // branch. Everything else reuses stop()'s discovery + tree-kill
    // mechanism, best-effort -- unregister() has always been tolerant of
    // "not registered" / "nothing running" and must stay that way.
    if (!this.descriptor.gracefulStopViaServerJson) {
      try {
        const pids = this.findWrapperProcessIds();
        for (const pid of pids) {
          try { execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)]); } catch {}
        }
      } catch {
        // Could not even query for live wrapper processes -- tolerate and
        // still proceed to delete the task, consistent with unregister()'s
        // existing best-effort contract (unlike stop(), which is loud here).
      }
    }
    try {
      quietExec('schtasks', ['/delete', '/tn', this.taskName, '/f']);
    } catch {
      // Tolerate task-not-found
    }
    try { fs.unlinkSync(this.wrapperPath); } catch {}
  }

  async start(): Promise<void> {
    if (this.reusedExistingTask) {
      // Reused task: run synchronously so a failure is surfaced, not swallowed.
      try {
        this.runSchtasks(['/run', '/tn', this.taskName]);
      } catch (err) {
        throw new Error(`schtasks /run /tn ${this.taskName} failed: ${(err as Error).message}`);
      }
      return;
    }
    // Use spawn (detached) so schtasks /run does not block the installer.
    // schtasks /run returns quickly but on some Windows versions it waits
    // for the launched process -- detaching avoids that.
    const { spawn } = await import('node:child_process');
    const child = spawn('schtasks', ['/run', '/tn', this.taskName], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  }

  /**
   * Process ids of this service's scheduled-task wrapper that are live now.
   *
   * register() registers the task to run the wrapper .bat, so the process the
   * Task Scheduler owns is a cmd.exe whose command line contains the wrapper
   * file name, and the apra-fleet process actually holding the service's port
   * is that cmd.exe's CHILD. Matching on the descriptor's per-service wrapper
   * file name is also what scopes this to ONE service: the MCP server's
   * wrapper is a different file name and can never match.
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
      { encoding: 'utf8' },
    );
    return String(out ?? '')
      .split(/\r?\n/)
      .map(line => Number.parseInt(line.trim(), 10))
      .filter(pid => Number.isInteger(pid) && pid > 0);
  }

  async stop(): Promise<boolean> {
    if (this.descriptor.gracefulStopViaServerJson) {
      return gracefulStopByServerJson((pid) => {
        try { quietExec('taskkill', ['/F', '/PID', String(pid)]); } catch {}
      });
    }
    // Services other than the MCP server never write server.json, so there is
    // no graceful HTTP handshake to use. `schtasks /end` ALONE is not enough:
    // the scheduled task's own process is the wrapper cmd.exe, and the
    // apra-fleet process holding the service's port is its child. Ending the
    // task can leave that child alive as an orphan still bound to the port
    // while query() reports the task as not Running -- so `apra-fleet status`
    // says stopped, `apra-fleet stop` says stopped, and the next start cannot
    // bind.
    //
    // Mechanism chosen: resolve the wrapper pid(s) via Win32_Process, then
    // `taskkill /F /T /PID <pid>` each one -- /T is what takes the wrapper's
    // whole descendant tree (the apra-fleet child) down with it. Discovery
    // deliberately runs BEFORE any /end: ending the task first destroys the
    // parent link the tree-kill needs and puts the child out of reach.
    // `schtasks /end` still runs afterwards, purely so the Task Scheduler's
    // own bookkeeping agrees that the task is finished.
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
        execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)]);
      } catch (err: any) {
        // taskkill exits 128 / "not found" when the process ended between the
        // query and the kill. The tree is gone, which is the goal -- tolerate.
        const message = String(err?.message ?? err);
        if (err?.status === 128 || /not found/i.test(message)) continue;
        failures.push(`pid ${pid}: ${message}`);
      }
    }

    // Tolerated: the task may not be registered, or may already have ended.
    try { execFileSync('schtasks', ['/end', '/tn', this.taskName]); } catch {}

    if (failures.length > 0) {
      throw new Error(
        `Failed to terminate the ${this.taskName} process tree (${failures.join('; ')}).`,
      );
    }
    return true;
  }

  /**
   * Registration + run state of THIS service's scheduled task.
   *
   * Preferred path is an `-EncodedCommand` PowerShell probe of
   * `Get-ScheduledTask`, for two reasons:
   *
   *  1. It is the only source that can tell whether the task is ENABLED.
   *     `schtasks /query` collapses "registered and armed" and "registered
   *     but disabled" into one localized Status string, so before this the
   *     Windows manager never populated `enabled` at all and every running
   *     task was reported by `apra-fleet status` as "installed (disabled)".
   *  2. The probe emits the NUMERIC ScheduledTask state enum, so the mapping
   *     is locale-independent. Comparing a Status column to the English
   *     literal 'Running' is simply wrong on a localized Windows.
   *
   * PowerShell is invoked as an explicit `-EncodedCommand` (CLAUDE.md: never
   * rely on shell-level expansion in a Windows command string), exactly as
   * findWrapperProcessIds() does; the only interpolated value is the
   * descriptor's fixed ASCII task name.
   *
   * `schtasks /query ... /fo csv /nh` remains as a FALLBACK for hosts where
   * the probe cannot run at all (no powershell, non-zero exit, unparseable
   * output). That path reports only what CSV can honestly tell and leaves
   * `enabled` UNDEFINED for a status string it does not recognize -- an
   * unknown enable state is never guessed into `enabled:false`.
   */
  async query(): Promise<ServiceStatus> {
    const probed = this.queryScheduledTaskState();
    if (probed) return probed;
    return this.queryViaSchtasksCsv();
  }

  /**
   * `Get-ScheduledTask` state probe. Returns null -- meaning "ask the CSV
   * fallback instead" -- when the probe could not be run or produced output
   * this cannot interpret. A task that genuinely does not exist is NOT null:
   * it is a definite {installed:false, running:false}.
   *
   * Numeric ScheduledTask state enum: 1=Disabled, 2=Queued, 3=Ready,
   * 4=Running (0=Unknown, which falls through to the CSV fallback).
   */
  private queryScheduledTaskState(): ServiceStatus | null {
    const needle = this.taskName.replace(/'/g, "''");
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$t = Get-ScheduledTask -TaskName '${needle}'`,
      "if ($t) { [int]$t.State } else { 'NOTFOUND' }",
    ].join('; ');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    let out: string;
    try {
      // GitHub #585: pipe all stdio and hide the window, like every other
      // status probe, so nothing prints above apra-fleet status.
      out = String(execFileSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { encoding: 'utf8', ...QUIET },
      ) ?? '');
    } catch {
      // No powershell, or it exited non-zero: the probe is unusable here.
      return null;
    }
    const value = out.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean).pop() ?? '';
    if (value === 'NOTFOUND') return { installed: false, running: false };
    switch (value) {
      case '4': return { installed: true, running: true, enabled: true };
      case '1': return { installed: true, running: false, enabled: false };
      case '2':
      case '3': return { installed: true, running: false, enabled: true };
      default: return null;
    }
  }

  /**
   * Legacy `schtasks` CSV read. Never invents an `enabled` value: it comes
   * from the task's XML definition (GitHub #585; tag names are not
   * localized) when that query returns a real task definition, else from an
   * explicit CSV status, else it is left undefined.
   */
  private queryViaSchtasksCsv(): ServiceStatus {
    let out: string;
    try {
      out = decodeSchtasks(quietExec('schtasks', ['/query', '/tn', this.taskName, '/fo', 'csv', '/nh']));
    } catch {
      return { installed: false, running: false };
    }
    // CSV line: "TaskName","Next Run Time","Status"
    const line = String(out ?? '').trim().split(/\r?\n/)[0] ?? '';
    const cols = line.split('","');
    const status = (cols[2] ?? '').replace(/"/g, '').trim();
    let xmlEnabled: boolean | null = null;
    try {
      const raw = quietExec('schtasks', ['/query', '/tn', this.taskName, '/xml']);
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
    try {
      quietExec('schtasks', ['/query', '/tn', this.taskName]);
      return true;
    } catch {
      return false;
    }
  }
}
