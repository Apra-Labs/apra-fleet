import { describe, it, expect } from 'vitest';
import {
  getOsCommands,
  LinuxCommands,
  MacOSCommands,
  WindowsCommands,
  WindowsGitBashCommands,
} from '../src/os/index.js';

describe('getOsCommands shell selection (apra-fleet-7dir.2.1)', () => {
  it('returns the gitbash implementation for windows + gitbash', () => {
    expect(getOsCommands('windows', 'gitbash')).toBeInstanceOf(WindowsGitBashCommands);
  });

  it('returns WindowsCommands for windows with no shell recorded', () => {
    expect(getOsCommands('windows')).toBeInstanceOf(WindowsCommands);
    expect(getOsCommands('windows')).not.toBeInstanceOf(WindowsGitBashCommands);
  });

  it('returns WindowsCommands for windows + powershell5 and windows + pwsh7', () => {
    for (const shell of ['powershell5', 'pwsh7'] as const) {
      expect(getOsCommands('windows', shell)).toBeInstanceOf(WindowsCommands);
      expect(getOsCommands('windows', shell)).not.toBeInstanceOf(WindowsGitBashCommands);
    }
  });

  it('leaves linux and macos unchanged, with or without a shell argument', () => {
    expect(getOsCommands('linux')).toBeInstanceOf(LinuxCommands);
    expect(getOsCommands('macos')).toBeInstanceOf(MacOSCommands);
    expect(getOsCommands('linux', 'gitbash')).toBe(getOsCommands('linux'));
    expect(getOsCommands('macos', 'gitbash')).toBe(getOsCommands('macos'));
  });

  it('keeps instances singleton per resolved implementation', () => {
    expect(getOsCommands('windows', 'gitbash')).toBe(getOsCommands('windows', 'gitbash'));
    expect(getOsCommands('windows')).toBe(getOsCommands('windows'));
  });
});

describe('WindowsGitBashCommands emits bash, not PowerShell', () => {
  const gb = new WindowsGitBashCommands();
  const linux = new LinuxCommands();

  it('overrides no method with a body identical to LinuxCommands', () => {
    const overridden = Object.getOwnPropertyNames(WindowsGitBashCommands.prototype)
      .filter(n => n !== 'constructor' && typeof (gb as never as Record<string, unknown>)[n] === 'function');
    expect(overridden.length).toBeGreaterThan(0);
    for (const name of overridden) {
      const own = (WindowsGitBashCommands.prototype as never as Record<string, () => unknown>)[name];
      const base = (LinuxCommands.prototype as never as Record<string, () => unknown>)[name];
      if (!base) continue;
      expect(own.toString(), `${name} duplicates the LinuxCommands body`).not.toBe(base.toString());
    }
  });

  it('emits no PowerShell cmdlet syntax outside the encoded-command hop', () => {
    const commands = [
      gb.cpuLoad(),
      gb.memory(),
      gb.disk('C:\\Users\\dev\\work'),
      gb.credentialFileWrite('secret', '~/.config/creds.json'),
      gb.gitCredentialHelperWrite('github.com', 'user', 'tok'),
      gb.gitCredentialHelperRemove('github.com'),
      ...gb.deploySSHPublicKey('ssh-ed25519 AAAA test'),
      gb.killPid(1234),
      gb.gpuProcessCheck(),
      gb.gpuUtilization(),
    ];
    for (const cmd of commands) {
      expect(cmd).not.toMatch(/Get-|Set-|New-Item|Remove-Item|Write-Output|Test-Path|\$env:/);
    }
    // fleetProcessCheck is the one documented exception: a single bash-safe
    // `powershell -EncodedCommand <base64>` invocation with no PS syntax.
    expect(gb.fleetProcessCheck('C:\\work', undefined, 'claude')).toMatch(/^powershell -EncodedCommand [A-Za-z0-9+/=]+$/);
  });

  it('normalizes Windows backslash paths for bash consumers', () => {
    expect(gb.disk('C:\\Users\\dev')).toBe('df -h "C:/Users/dev"');
    expect(gb.disk('C:\\Users\\dev')).not.toBe(linux.disk('C:\\Users\\dev'));
  });

  it('inherits the POSIX prompt/filesystem surface from LinuxCommands', () => {
    expect(gb.mkdir('/c/work')).toBe(linux.mkdir('/c/work'));
    expect(gb.wrapPidCapture('echo hi')).toBe(linux.wrapPidCapture('echo hi'));
  });
});
