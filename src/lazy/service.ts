/**
 * Keep the background process alive across logins and crashes.
 *   Linux   systemd user unit
 *   macOS   launchd agent
 *   Windows logon scheduled task (plus an immediate detached start)
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lazyDir } from './config.js';

const LABEL = 'dev.lazyfleet';
const UNIT = 'lazyfleet.service';

/** node + this CLI's script, so the service runs whatever was installed. */
export function serveCommand(): { command: string; args: string[] } {
  return { command: process.execPath, args: [path.resolve(process.argv[1]), 'serve'] };
}

function unitPath(): string {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'systemd', 'user', UNIT);
}

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function logPath(): string {
  return path.join(lazyDir(), 'server.log');
}

function quoteSystemd(arg: string): string {
  return /[\s"\\]/.test(arg) ? `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : arg;
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface ServiceResult {
  /** True when it starts again on its own after a reboot or login. */
  autostart: boolean;
  /** Something the person should know, in plain words. */
  note?: string;
}

function lingerOff(): boolean {
  try {
    const user = os.userInfo().username;
    return /Linger=no/.test(execFileSync('loginctl', ['show-user', user, '-p', 'Linger'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return false;
  }
}

export function installService(): ServiceResult {
  fs.mkdirSync(lazyDir(), { recursive: true, mode: 0o700 });
  // LAZYFLEET_SERVICE=detached: no login service (containers, CI, test homes).
  if (process.env.LAZYFLEET_SERVICE === 'detached') {
    startDetached();
    return { autostart: false, note: 'Started without a login service (LAZYFLEET_SERVICE=detached); run `lazyfleet on` after a reboot.' };
  }
  try {
    return installLoginService();
  } catch {
    // No user service manager here (no systemd user session, say): still run now.
    startDetached();
    return { autostart: false, note: 'This machine has no user service manager, so lazyfleet will not start on its own after a reboot. Run `lazyfleet on` when you log in (or add it to your shell profile).' };
  }
}

function installLoginService(): ServiceResult {
  const { command, args } = serveCommand();
  if (process.platform === 'linux') {
    fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
    fs.writeFileSync(
      unitPath(),
      [
        '[Unit]',
        'Description=lazyfleet - keeps secrets out of model traffic',
        'After=network-online.target',
        '',
        '[Service]',
        `ExecStart=${[command, ...args].map(quoteSystemd).join(' ')}`,
        'Restart=always',
        'RestartSec=1',
        `StandardOutput=append:${logPath()}`,
        `StandardError=append:${logPath()}`,
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'),
    );
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    execFileSync('systemctl', ['--user', 'enable', UNIT], { stdio: 'ignore' });
    execFileSync('systemctl', ['--user', 'restart', UNIT], { stdio: 'ignore' });
    return lingerOff()
      ? { autostart: true, note: 'It starts when you log in. To keep it running while you are logged out (a server, say): loginctl enable-linger' }
      : { autostart: true };
  }

  if (process.platform === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${[command, ...args].map(a => `<string>${xml(a)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logPath())}</string>
  <key>StandardErrorPath</key><string>${xml(logPath())}</string>
</dict></plist>
`;
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    fs.writeFileSync(plistPath(), plist);
    const domain = `gui/${process.getuid?.()}`;
    try {
      execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' });
    } catch {
      // not loaded yet
    }
    execFileSync('launchctl', ['bootstrap', domain, plistPath()]);
    return { autostart: true };
  }

  if (process.platform === 'win32') {
    const tr = [command, ...args].map(a => `"${a}"`).join(' ');
    execFileSync('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', 'lazyfleet', '/TR', tr], { stdio: 'ignore' });
    startDetached();
    return { autostart: true };
  }

  startDetached();
  return { autostart: false, note: 'lazyfleet does not know how to start itself on this system; run `lazyfleet on` after a reboot.' };
}

export function uninstallService(): void {
  if (process.platform === 'linux') {
    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', UNIT], { stdio: 'ignore' });
    } catch {
      // not installed
    }
    fs.rmSync(unitPath(), { force: true });
    try {
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    } catch {
      // systemd unavailable
    }
    return;
  }
  if (process.platform === 'darwin') {
    try {
      execFileSync('launchctl', ['bootout', `gui/${process.getuid?.()}/${LABEL}`], { stdio: 'ignore' });
    } catch {
      // not loaded
    }
    fs.rmSync(plistPath(), { force: true });
    return;
  }
  if (process.platform === 'win32') {
    try {
      execFileSync('schtasks', ['/Delete', '/F', '/TN', 'lazyfleet'], { stdio: 'ignore' });
    } catch {
      // not installed
    }
  }
}

export function restartService(): void {
  try {
    if (process.env.LAZYFLEET_SERVICE === 'detached') startDetached();
    else if (process.platform === 'linux') execFileSync('systemctl', ['--user', 'restart', UNIT], { stdio: 'ignore' });
    else if (process.platform === 'darwin') execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid?.()}/${LABEL}`]);
    else startDetached();
  } catch {
    startDetached();
  }
}

function startDetached(): void {
  const { command, args } = serveCommand();
  const out = fs.openSync(logPath(), 'a');
  spawn(command, args, { detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
}
