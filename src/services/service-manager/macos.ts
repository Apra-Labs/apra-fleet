import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { RegisterOptions, ServiceDescriptor, ServiceId, ServiceManager, ServiceStatus } from './types.js';
import { DEFAULT_SERVICE_ID, getServiceDescriptor } from './types.js';
import { gracefulStopByServerJson } from './index.js';

const PLIST_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');

function getUid(): string {
  return typeof process.getuid === 'function' ? String(process.getuid()) : '501';
}

function domain(): string {
  return `gui/${getUid()}`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildPlist(
  descriptor: ServiceDescriptor,
  binaryPath: string,
  args: string[],
  logPath: string,
  options: RegisterOptions,
): string {
  const argElements = [binaryPath, ...args]
    .map(a => `        <string>${xmlEscape(a)}</string>`)
    .join('\n');
  // KeepAlive(SuccessfulExit=false) relaunches the job after a crash. Services
  // declared Restart=no (fleet supervisor) omit KeepAlive entirely so a clean
  // or unclean exit is final until the next login/RunAtLoad.
  const keepAlive = descriptor.restartOnFailure
    ? [
        '    <key>KeepAlive</key>',
        '    <dict>',
        '        <key>SuccessfulExit</key>',
        '        <false/>',
        '    </dict>',
      ]
    : [];
  const workingDirectory = options.workingDirectory
    ? [
        '    <key>WorkingDirectory</key>',
        `    <string>${xmlEscape(options.workingDirectory)}</string>`,
      ]
    : [];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '    <key>Label</key>',
    `    <string>${descriptor.macosPlistLabel}</string>`,
    '    <key>ProgramArguments</key>',
    '    <array>',
    argElements,
    '    </array>',
    '    <key>RunAtLoad</key>',
    '    <true/>',
    ...keepAlive,
    ...workingDirectory,
    `    <key>StandardOutPath</key>`,
    `    <string>${xmlEscape(logPath)}</string>`,
    `    <key>StandardErrorPath</key>`,
    `    <string>${xmlEscape(logPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export class MacOSServiceManager implements ServiceManager {
  readonly serviceId: ServiceId;
  private readonly descriptor: ServiceDescriptor;
  private readonly plistPath: string;
  /** launchd service target, e.g. "gui/501/com.apra-fleet.server". */
  private readonly label: string;

  constructor(serviceId: ServiceId = DEFAULT_SERVICE_ID) {
    this.serviceId = serviceId;
    this.descriptor = getServiceDescriptor(serviceId);
    this.label = this.descriptor.macosPlistLabel;
    this.plistPath = path.join(PLIST_DIR, `${this.label}.plist`);
  }

  private target(): string {
    return `${domain()}/${this.label}`;
  }

  async register(
    binaryPath: string, args: string[], logPath: string, options: RegisterOptions = {},
  ): Promise<void> {
    fs.mkdirSync(PLIST_DIR, { recursive: true });
    fs.writeFileSync(this.plistPath, buildPlist(this.descriptor, binaryPath, args, logPath, options), 'utf8');
    // Bootout first to make register idempotent
    try { execFileSync('launchctl', ['bootout', this.target()]); } catch {}
    execFileSync('launchctl', ['bootstrap', domain(), this.plistPath]);
  }

  async unregister(): Promise<void> {
    try { execFileSync('launchctl', ['bootout', this.target()]); } catch {}
    try { fs.unlinkSync(this.plistPath); } catch {}
  }

  async start(): Promise<void> {
    execFileSync('launchctl', ['kickstart', this.target()]);
  }

  async stop(): Promise<void> {
    if (this.descriptor.gracefulStopViaServerJson) {
      await gracefulStopByServerJson();
      return;
    }
    // Services other than the MCP server never write server.json -- take them
    // down through launchd itself. bootout also unloads the job, so a later
    // start() re-bootstraps via register(); callers that only want a pause
    // should use kickstart semantics instead.
    try { execFileSync('launchctl', ['bootout', this.target()]); } catch {}
  }

  async query(): Promise<ServiceStatus> {
    if (!fs.existsSync(this.plistPath)) {
      return { installed: false, running: false };
    }
    try {
      const out = execFileSync(
        'launchctl', ['print', this.target()],
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
    return fs.existsSync(this.plistPath);
  }
}
