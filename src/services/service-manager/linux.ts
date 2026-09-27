import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { RegisterOptions, ServiceDescriptor, ServiceId, ServiceManager, ServiceStatus } from './types.js';
import { DEFAULT_SERVICE_ID, getServiceDescriptor } from './types.js';
import { gracefulStopByServerJson } from './index.js';

const UNIT_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');

function checkSystemd(): void {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const xdgRuntime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  if (!fs.existsSync(path.join(xdgRuntime, 'systemd'))) {
    throw new Error('systemd user mode is not available. Service management requires systemd.');
  }
}

export class LinuxServiceManager implements ServiceManager {
  readonly serviceId: ServiceId;
  private readonly descriptor: ServiceDescriptor;
  /** Absolute path of this service's unit file under ~/.config/systemd/user. */
  private readonly unitPath: string;
  /** Unit name without the .service suffix, as systemctl takes it. */
  private readonly unitName: string;

  constructor(serviceId: ServiceId = DEFAULT_SERVICE_ID) {
    this.serviceId = serviceId;
    this.descriptor = getServiceDescriptor(serviceId);
    this.unitPath = path.join(UNIT_DIR, this.descriptor.linuxUnitName);
    this.unitName = this.descriptor.linuxUnitName.replace(/\.service$/, '');
  }

  async register(
    binaryPath: string, args: string[], logPath: string, options: RegisterOptions = {},
  ): Promise<void> {
    checkSystemd();
    const unit = [
      '[Unit]',
      `Description=${this.descriptor.description}`,
      '',
      '[Service]',
      'Type=simple',
      // The executable is quoted because it now lives under the operator's home
      // directory (<BIN_DIR>/apra-fleet), and systemd splits ExecStart on
      // whitespace -- an unquoted path containing a space would silently produce
      // a broken unit. systemd honours double quotes here. macos.ts passes a
      // ProgramArguments array and windows.ts quotes inside the wrapper .bat, so
      // only this systemd line needs it.
      `ExecStart="${binaryPath}" ${args.join(' ')}`,
      ...(options.workingDirectory ? [`WorkingDirectory=${options.workingDirectory}`] : []),
      `Restart=${this.descriptor.restartOnFailure ? 'on-failure' : 'no'}`,
      `StandardOutput=append:${logPath}`,
      `StandardError=append:${logPath}`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    fs.mkdirSync(UNIT_DIR, { recursive: true });
    fs.writeFileSync(this.unitPath, unit, 'utf8');
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', this.unitName]);
    try {
      execFileSync('loginctl', ['enable-linger', os.userInfo().username]);
    } catch (err) {
      console.warn(`apra-fleet: loginctl enable-linger failed (non-fatal): ${err}`);
    }
  }

  async unregister(): Promise<void> {
    if (this.descriptor.gracefulStopViaServerJson) {
      await gracefulStopByServerJson();
    }
    checkSystemd();
    try { execFileSync('systemctl', ['--user', 'disable', this.unitName]); } catch {}
    try { execFileSync('systemctl', ['--user', 'stop', this.unitName]); } catch {}
    try { fs.unlinkSync(this.unitPath); } catch {}
    try { execFileSync('systemctl', ['--user', 'daemon-reload']); } catch {}
  }

  async start(): Promise<void> {
    checkSystemd();
    execFileSync('systemctl', ['--user', 'start', this.unitName]);
  }

  async stop(): Promise<void> {
    checkSystemd();
    if (this.descriptor.gracefulStopViaServerJson) {
      await gracefulStopByServerJson();
      return;
    }
    // Services other than the MCP server never write server.json -- stop them
    // through systemd itself.
    execFileSync('systemctl', ['--user', 'stop', this.unitName]);
  }

  async query(): Promise<ServiceStatus> {
    checkSystemd();
    if (!fs.existsSync(this.unitPath)) {
      return { installed: false, running: false };
    }
    let running = false;
    let enabled: boolean | undefined;
    try {
      const active = execFileSync(
        'systemctl', ['--user', 'is-active', this.unitName], { encoding: 'utf8' },
      ).trim();
      running = active === 'active';
    } catch {}
    try {
      const enabledOut = execFileSync(
        'systemctl', ['--user', 'is-enabled', this.unitName], { encoding: 'utf8' },
      ).trim();
      enabled = enabledOut === 'enabled';
    } catch {}
    return { installed: true, running, enabled };
  }

  async isInstalled(): Promise<boolean> {
    return fs.existsSync(this.unitPath);
  }
}
