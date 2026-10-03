import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ServiceManager, ServiceStatus } from './types.js';
import { MACOS_PLIST_LABEL, SERVICE_ENV_MARKER } from './types.js';
import { gracefulStopByServerJson } from './index.js';
import { clearServiceStartFailures } from '../service-start-guard.js';

const PLIST_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = path.join(PLIST_DIR, `${MACOS_PLIST_LABEL}.plist`);

function getUid(): string {
  return typeof process.getuid === 'function' ? String(process.getuid()) : '501';
}

function domain(): string {
  return `gui/${getUid()}`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildPlist(binaryPath: string, args: string[], logPath: string): string {
  const argElements = [binaryPath, ...args]
    .map(a => `        <string>${xmlEscape(a)}</string>`)
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
    '    <key>EnvironmentVariables</key>',
    '    <dict>',
    `        <key>${SERVICE_ENV_MARKER}</key>`,
    '        <string>1</string>',
    '    </dict>',
    '    <key>RunAtLoad</key>',
    '    <true/>',
    '    <key>KeepAlive</key>',
    '    <dict>',
    '        <key>SuccessfulExit</key>',
    '        <false/>',
    '    </dict>',
    `    <key>StandardOutPath</key>`,
    `    <string>${xmlEscape(logPath)}</string>`,
    `    <key>StandardErrorPath</key>`,
    `    <string>${xmlEscape(logPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/**
 * Whether a launchd label is enabled in its domain, from `launchctl
 * print-disabled <domain>` output: lines like `"label" => disabled` (newer
 * macOS) or `"label" => true` (older, where true means disabled). A label not
 * listed is enabled (launchd's default). If the query fails, assume enabled --
 * the plist exists, which is the installed-and-enabled common case.
 */
export function macosLabelEnabled(label: string, printDisabled: () => string): boolean {
  let out: string;
  try { out = printDisabled(); } catch { return true; }
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`"${esc}"\\s*=>\\s*(\\w+)`).exec(out);
  if (!m) return true;
  const v = m[1].toLowerCase();
  return !(v === 'disabled' || v === 'true');
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
    // An explicit start is never skipped by the failed-start backoff.
    clearServiceStartFailures();
    execFileSync('launchctl', ['kickstart', `${domain()}/${MACOS_PLIST_LABEL}`]);
  }

  async stop(): Promise<boolean> {
    return gracefulStopByServerJson();
  }

  async query(): Promise<ServiceStatus> {
    if (!fs.existsSync(PLIST_PATH)) {
      return { installed: false, running: false };
    }
    // GitHub #585: report enabled (status showed every installed agent as
    // "installed (disabled)"), and pipe stderr so launchctl errors never print
    // above apra-fleet status.
    const enabled = macosLabelEnabled(MACOS_PLIST_LABEL, () => execFileSync(
      'launchctl', ['print-disabled', domain()], { encoding: 'utf8', stdio: 'pipe' },
    ));
    try {
      const out = execFileSync(
        'launchctl', ['print', `${domain()}/${MACOS_PLIST_LABEL}`],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      const pidMatch = out.match(/\bpid\s*=\s*(\d+)/);
      const pid = pidMatch ? parseInt(pidMatch[1], 10) : undefined;
      return { installed: true, running: !!pid && pid > 0, pid, enabled };
    } catch {
      return { installed: true, running: false, enabled };
    }
  }

  async isInstalled(): Promise<boolean> {
    return fs.existsSync(PLIST_PATH);
  }
}
