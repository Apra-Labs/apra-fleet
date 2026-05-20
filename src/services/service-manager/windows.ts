import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ServiceManager, ServiceStatus } from './types.js';
import { WINDOWS_TASK_NAME } from './types.js';
import { gracefulStopByServerJson } from './index.js';
import { BIN_DIR } from '../../cli/config.js';

const WRAPPER_PATH = path.join(BIN_DIR, 'apra-fleet-service.bat');

export class WindowsServiceManager implements ServiceManager {
  async register(binaryPath: string, args: string[], logPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(WRAPPER_PATH), { recursive: true });
    const lines = ['@echo off', `"${binaryPath}" ${args.join(' ')} >> "${logPath}" 2>&1`];
    fs.writeFileSync(WRAPPER_PATH, lines.join('\r\n'), 'utf8');
    execFileSync('schtasks', [
      '/create', '/tn', WINDOWS_TASK_NAME,
      '/tr', WRAPPER_PATH,
      '/sc', 'onlogon', '/rl', 'limited', '/f',
    ]);
  }

  async unregister(): Promise<void> {
    try {
      execFileSync('schtasks', ['/delete', '/tn', WINDOWS_TASK_NAME, '/f']);
    } catch {
      // Tolerate task-not-found
    }
    try { fs.unlinkSync(WRAPPER_PATH); } catch {}
  }

  async start(): Promise<void> {
    execFileSync('schtasks', ['/run', '/tn', WINDOWS_TASK_NAME]);
  }

  async stop(): Promise<void> {
    await gracefulStopByServerJson((pid) => {
      try { execFileSync('taskkill', ['/F', '/PID', String(pid)]); } catch {}
    });
  }

  async query(): Promise<ServiceStatus> {
    try {
      const out = execFileSync(
        'schtasks', ['/query', '/tn', WINDOWS_TASK_NAME, '/fo', 'csv', '/nh'],
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
      execFileSync('schtasks', ['/query', '/tn', WINDOWS_TASK_NAME]);
      return true;
    } catch {
      return false;
    }
  }
}
