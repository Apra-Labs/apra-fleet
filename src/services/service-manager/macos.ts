import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ServiceManager, ServiceStatus } from './types.js';
import { MACOS_PLIST_LABEL } from './types.js';
import { gracefulStopByServerJson } from './index.js';

const PLIST_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = path.join(PLIST_DIR, `${MACOS_PLIST_LABEL}.plist`);

function getUid(): string {
  return typeof process.getuid === 'function' ? String(process.getuid()) : '501';
}

function domain(): string {
  return `gui/${getUid()}`;
}

function buildPlist(binaryPath: string, args: string[], logPath: string): string {
  const argElements = [binaryPath, ...args]
    .map(a => `        <string>${a}</string>`)
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '    <key>Label</key>',
    `    <string>${MACOS_PLIST_LABEL}</string>`,
    '    <key>ProgramArguments</key>',
    '    <array>',
    argElements,
    '    </array>',
    '    <key>RunAtLoad</key>',
    '    <true/>',
    '    <key>KeepAlive</key>',
    '    <dict>',
    '        <key>SuccessfulExit</key>',
    '        <false/>',
    '    </dict>',
    `    <key>StandardOutPath</key>`,
    `    <string>${logPath}</string>`,
    `    <key>StandardErrorPath</key>`,
    `    <string>${logPath}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export class MacOSServiceManager implements ServiceManager {
  async register(binaryPath: string, args: string[], logPath: string): Promise<void> {
    fs.mkdirSync(PLIST_DIR, { recursive: true });
    fs.writeFileSync(PLIST_PATH, buildPlist(binaryPath, args, logPath), 'utf8');
    // Bootout first to make register idempotent
    try { execFileSync('launchctl', ['bootout', `${domain()}/${MACOS_PLIST_LABEL}`]); } catch {}
    execFileSync('launchctl', ['bootstrap', domain(), PLIST_PATH]);
  }

  async unregister(): Promise<void> {
    try { execFileSync('launchctl', ['bootout', `${domain()}/${MACOS_PLIST_LABEL}`]); } catch {}
    try { fs.unlinkSync(PLIST_PATH); } catch {}
  }

  async start(): Promise<void> {
    execFileSync('launchctl', ['kickstart', `${domain()}/${MACOS_PLIST_LABEL}`]);
  }

  async stop(): Promise<void> {
    await gracefulStopByServerJson();
  }

  async query(): Promise<ServiceStatus> {
    if (!fs.existsSync(PLIST_PATH)) {
      return { installed: false, running: false };
    }
    try {
      const out = execFileSync(
        'launchctl', ['print', `${domain()}/${MACOS_PLIST_LABEL}`],
        { encoding: 'utf8' },
      );
      const pidMatch = out.match(/\bpid\s*=\s*(\d+)/);
      const pid = pidMatch ? parseInt(pidMatch[1], 10) : undefined;
      return { installed: true, running: !!pid && pid > 0, pid };
    } catch {
      return { installed: true, running: false };
    }
  }

  async isInstalled(): Promise<boolean> {
    return fs.existsSync(PLIST_PATH);
  }
}
