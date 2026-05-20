import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ServiceManager, ServiceStatus } from './types.js';
import { LINUX_UNIT_NAME } from './types.js';
import { gracefulStopByServerJson } from './index.js';

const UNIT_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');
const UNIT_PATH = path.join(UNIT_DIR, LINUX_UNIT_NAME);
const SERVICE_NAME = LINUX_UNIT_NAME.replace(/\.service$/, '');

function checkSystemd(): void {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const xdgRuntime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${uid}`;
  if (!fs.existsSync(path.join(xdgRuntime, 'systemd'))) {
    throw new Error('systemd user mode is not available. Service management requires systemd.');
  }
}

export class LinuxServiceManager implements ServiceManager {
  async register(binaryPath: string, args: string[], logPath: string): Promise<void> {
    checkSystemd();
    const unit = [
      '[Unit]',
      'Description=Apra Fleet MCP Server',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${binaryPath} ${args.join(' ')}`,
      'Restart=on-failure',
      `StandardOutput=append:${logPath}`,
      `StandardError=append:${logPath}`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    fs.mkdirSync(UNIT_DIR, { recursive: true });
    fs.writeFileSync(UNIT_PATH, unit, 'utf8');
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', SERVICE_NAME]);
    try {
      execFileSync('loginctl', ['enable-linger', os.userInfo().username]);
    } catch (err) {
      console.warn(`apra-fleet: loginctl enable-linger failed (non-fatal): ${err}`);
    }
  }

  async unregister(): Promise<void> {
    checkSystemd();
    await gracefulStopByServerJson();
    try { execFileSync('systemctl', ['--user', 'disable', SERVICE_NAME]); } catch {}
    try { execFileSync('systemctl', ['--user', 'stop', SERVICE_NAME]); } catch {}
    try { fs.unlinkSync(UNIT_PATH); } catch {}
    try { execFileSync('systemctl', ['--user', 'daemon-reload']); } catch {}
  }

  async start(): Promise<void> {
    checkSystemd();
    execFileSync('systemctl', ['--user', 'start', SERVICE_NAME]);
  }

  async stop(): Promise<void> {
    checkSystemd();
    await gracefulStopByServerJson();
  }

  async query(): Promise<ServiceStatus> {
    checkSystemd();
    if (!fs.existsSync(UNIT_PATH)) {
      return { installed: false, running: false };
    }
    let running = false;
    let enabled: boolean | undefined;
    try {
      const active = execFileSync(
        'systemctl', ['--user', 'is-active', SERVICE_NAME], { encoding: 'utf8' },
      ).trim();
      running = active === 'active';
    } catch {}
    try {
      const enabledOut = execFileSync(
        'systemctl', ['--user', 'is-enabled', SERVICE_NAME], { encoding: 'utf8' },
      ).trim();
      enabled = enabledOut === 'enabled';
    } catch {}
    return { installed: true, running, enabled };
  }

  async isInstalled(): Promise<boolean> {
    return fs.existsSync(UNIT_PATH);
  }
}
