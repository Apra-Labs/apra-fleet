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

  async stop(): Promise<void> {
    if (this.descriptor.gracefulStopViaServerJson) {
      await gracefulStopByServerJson((pid) => {
        try { execFileSync('taskkill', ['/F', '/PID', String(pid)]); } catch {}
      });
      return;
    }
    // Services other than the MCP server never write server.json -- end the
    // scheduled task itself, which terminates the wrapper and its child.
    try { execFileSync('schtasks', ['/end', '/tn', this.taskName]); } catch {}
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
