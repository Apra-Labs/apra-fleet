import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ServiceManager, ServiceStatus } from './types.js';
import { WINDOWS_TASK_NAME } from './types.js';
import { gracefulStopByServerJson } from './index.js';
import { BIN_DIR } from '../../cli/config.js';

const WRAPPER_PATH = path.join(BIN_DIR, 'apra-fleet-service.bat');

export interface InteractiveSessionResult {
  hasInteractive: boolean;
  raw: string;
}

/** Injectable command runner seam: takes (cmd, args), returns combined stdout+stderr text. */
export type SessionQueryRunner = (cmd: string, args: string[]) => string;

function runCaptureOutput(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' });
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer };
    const stdout = e.stdout ? e.stdout.toString() : '';
    const stderr = e.stderr ? e.stderr.toString() : '';
    return stdout + stderr;
  }
}

/** Default runner used in production: shells out to 'query user' / 'query session'. */
export const defaultSessionQueryRunner: SessionQueryRunner = (cmd, args) => runCaptureOutput(cmd, args);

/**
 * Reports whether the current Windows machine has an interactive logon session,
 * by parsing 'query user' output (falling back to 'query session' if the first
 * command produced no output at all, e.g. it is absent on this Windows edition).
 *
 * Both commands exit non-zero and print "No User exists for *" when there are
 * zero sessions -- that is treated as hasInteractive=false, not as an error.
 * Never throws: any failure of the underlying command runner also resolves to
 * hasInteractive=false with whatever raw text (possibly empty) was captured.
 */
export function hasInteractiveSession(
  runner: SessionQueryRunner = defaultSessionQueryRunner,
): InteractiveSessionResult {
  let raw = '';
  try {
    raw = runner('query', ['user']);
    if (!raw.trim()) {
      raw = runner('query', ['session']);
    }
  } catch {
    raw = '';
  }

  if (!raw.trim() || /No User exists for/i.test(raw)) {
    return { hasInteractive: false, raw };
  }

  const dataLines = raw
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0)
    .filter(line => !/^\s*>?\s*(USERNAME|SESSIONNAME)\b/i.test(line));

  const hasInteractive = dataLines.some(line => /\bActive\b/i.test(line));
  return { hasInteractive, raw };
}

export class WindowsServiceManager implements ServiceManager {
  async register(binaryPath: string, args: string[], logPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(WRAPPER_PATH), { recursive: true });
    const quotedArgs = args.map(a => `"${a}"`).join(' ');
    const lines = ['@echo off', `"${binaryPath}" ${quotedArgs} >> "${logPath}" 2>&1`];
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
    // Use spawn (detached) so schtasks /run does not block the installer.
    // schtasks /run returns quickly but on some Windows versions it waits
    // for the launched process -- detaching avoids that.
    const { spawn } = await import('node:child_process');
    const child = spawn('schtasks', ['/run', '/tn', WINDOWS_TASK_NAME], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
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
