import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { RegisterResult, ServiceManager, ServiceStatus } from './types.js';
import { WINDOWS_TASK_NAME } from './types.js';
import { gracefulStopByServerJson } from './index.js';
import { BIN_DIR } from '../../cli/config.js';

const WRAPPER_PATH = path.join(BIN_DIR, 'apra-fleet-service.bat');

/** Runs schtasks synchronously; throws on a non-zero exit. Injectable for tests. */
export type SchtasksRunner = (args: string[]) => Buffer | string;

const defaultSchtasksRunner: SchtasksRunner = (args) =>
  execFileSync('schtasks', args, { timeout: 30_000, windowsHide: true });

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
  private reusedExistingTask = false;

  constructor(
    private readonly runSchtasks: SchtasksRunner = defaultSchtasksRunner,
    private readonly wrapperPath: string = WRAPPER_PATH,
  ) {}

  async register(binaryPath: string, args: string[], logPath: string): Promise<RegisterResult> {
    this.reusedExistingTask = false;
    // The wrapper is rewritten BEFORE /create so that a reused task (below)
    // also launches the new binary.
    fs.mkdirSync(path.dirname(this.wrapperPath), { recursive: true });
    const quotedArgs = args.map(a => `"${a}"`).join(' ');
    const lines = ['@echo off', `"${binaryPath}" ${quotedArgs} >> "${logPath}" 2>&1`];
    fs.writeFileSync(this.wrapperPath, lines.join('\r\n'), 'utf8');
    try {
      this.runSchtasks([
        '/create', '/tn', WINDOWS_TASK_NAME,
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
        command = taskXmlCommand(this.runSchtasks(['/query', '/tn', WINDOWS_TASK_NAME, '/xml']));
      } catch {
        throw new Error(`schtasks /create failed and no existing ${WINDOWS_TASK_NAME} task was found: ${createMsg}`);
      }
      if (command === null || normalizeTaskPath(command) !== normalizeTaskPath(this.wrapperPath)) {
        throw new Error(
          `schtasks /create failed and the existing ${WINDOWS_TASK_NAME} task runs ${command ?? '(unknown)'}, ` +
          `not ${this.wrapperPath}: ${createMsg}`,
        );
      }
      this.reusedExistingTask = true;
      return 'reused';
    }
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
    if (this.reusedExistingTask) {
      // Reused task: run synchronously so a failure is surfaced, not swallowed.
      try {
        this.runSchtasks(['/run', '/tn', WINDOWS_TASK_NAME]);
      } catch (err) {
        throw new Error(`schtasks /run /tn ${WINDOWS_TASK_NAME} failed: ${(err as Error).message}`);
      }
      return;
    }
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
