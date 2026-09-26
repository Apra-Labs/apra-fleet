import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { RegisterOptions, ServiceDescriptor, ServiceId, ServiceManager, ServiceStatus } from './types.js';
import { DEFAULT_SERVICE_ID, getServiceDescriptor } from './types.js';
import { gracefulStopByServerJson } from './index.js';
import { BIN_DIR } from '../../cli/config.js';

export class WindowsServiceManager implements ServiceManager {
  readonly serviceId: ServiceId;
  private readonly descriptor: ServiceDescriptor;
  /** Wrapper .bat this service's scheduled task runs. One per service. */
  private readonly wrapperPath: string;
  private readonly taskName: string;

  constructor(serviceId: ServiceId = DEFAULT_SERVICE_ID) {
    this.serviceId = serviceId;
    this.descriptor = getServiceDescriptor(serviceId);
    this.wrapperPath = path.join(BIN_DIR, this.descriptor.windowsWrapperFileName);
    this.taskName = this.descriptor.windowsTaskName;
  }

  async register(
    binaryPath: string, args: string[], logPath: string, options: RegisterOptions = {},
  ): Promise<void> {
    fs.mkdirSync(path.dirname(this.wrapperPath), { recursive: true });
    const quotedArgs = args.map(a => `"${a}"`).join(' ');
    const lines = ['@echo off'];
    // Scheduled tasks inherit no working directory from the operator's shell;
    // `cd /d` handles a drive change as well as the directory change.
    if (options.workingDirectory) {
      lines.push(`cd /d "${options.workingDirectory}"`);
    }
    lines.push(`"${binaryPath}" ${quotedArgs} >> "${logPath}" 2>&1`);
    fs.writeFileSync(this.wrapperPath, lines.join('\r\n'), 'utf8');
    execFileSync('schtasks', [
      '/create', '/tn', this.taskName,
      '/tr', this.wrapperPath,
      '/sc', 'onlogon', '/rl', 'limited', '/f',
    ]);
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
      execFileSync('schtasks', ['/delete', '/tn', this.taskName, '/f']);
    } catch {
      // Tolerate task-not-found
    }
    try { fs.unlinkSync(this.wrapperPath); } catch {}
  }

  async start(): Promise<void> {
    // Use spawn (detached) so schtasks /run does not block the installer.
    // schtasks /run returns quickly but on some Windows versions it waits
    // for the launched process -- detaching avoids that.
    const { spawn } = await import('node:child_process');
    const child = spawn('schtasks', ['/run', '/tn', this.taskName], {
      detached: true, stdio: 'ignore',
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

  async stop(): Promise<void> {
    if (this.descriptor.gracefulStopViaServerJson) {
      await gracefulStopByServerJson((pid) => {
        try { execFileSync('taskkill', ['/F', '/PID', String(pid)]); } catch {}
      });
      return;
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
  }

  async query(): Promise<ServiceStatus> {
    try {
      const out = execFileSync(
        'schtasks', ['/query', '/tn', this.taskName, '/fo', 'csv', '/nh'],
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
      execFileSync('schtasks', ['/query', '/tn', this.taskName]);
      return true;
    } catch {
      return false;
    }
  }
}
