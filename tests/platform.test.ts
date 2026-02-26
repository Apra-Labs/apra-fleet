import { describe, it, expect } from 'vitest';
import {
  detectOS,
  getShellCommand,
  getCpuLoadCommand,
  getMemoryCommand,
  getDiskCommand,
  getFleetProcessCheckCommand,
  getMkdirCommand,
  getSetEnvCommand,
  getUnsetEnvCommand,
} from '../src/utils/platform.js';

describe('detectOS', () => {
  it('detects OS from uname and ver output', () => {
    expect(detectOS('Linux', '')).toBe('linux');
    expect(detectOS('Darwin', '')).toBe('macos');
    expect(detectOS('', 'Microsoft Windows [Version 10.0.19045]')).toBe('windows');
  });

  it('defaults to linux for unknown output', () => {
    expect(detectOS('SomeUnknownOS', '')).toBe('linux');
  });

  it('prioritizes Windows detection from ver over uname', () => {
    expect(detectOS('Linux', 'Microsoft Windows')).toBe('windows');
  });

  it('detects Windows from Git Bash / MSYS2 / Cygwin uname output', () => {
    expect(detectOS('MINGW64_NT-10.0-19045', '')).toBe('windows');
    expect(detectOS('MSYS_NT-10.0', '')).toBe('windows');
    expect(detectOS('CYGWIN_NT-10.0', '')).toBe('windows');
  });

  it('detects Windows from PowerShell $env:OS output', () => {
    expect(detectOS('', 'Windows_NT')).toBe('windows');
  });
});

describe('getShellCommand', () => {
  it('wraps command for each OS appropriately', () => {
    expect(getShellCommand('windows', 'echo hi')).toBe('cmd /c "echo hi"');
    expect(getShellCommand('linux', 'echo hi')).toBe('echo hi');
    expect(getShellCommand('macos', 'echo hi')).toBe('echo hi');
  });
});

describe('platform command generators', () => {
  it('generates OS-specific resource commands', () => {
    expect(getCpuLoadCommand('linux')).toBe('uptime');
    expect(getCpuLoadCommand('macos')).toContain('vm.loadavg');
    expect(getCpuLoadCommand('windows')).toContain('dwMemoryLoad');
    expect(getMemoryCommand('linux')).toBe('free -m');
    expect(getMemoryCommand('macos')).toContain('vm_stat');
    expect(getMemoryCommand('windows')).toContain('ullTotalPhys');
  });

  it('generates disk commands with folder interpolation', () => {
    expect(getDiskCommand('linux', '/home/user')).toContain('/home/user');
    expect(getDiskCommand('macos', '/opt/app')).toContain('/opt/app');
    expect(getDiskCommand('windows', 'C:\\work')).toContain("DriveInfo");
  });

  it('generates fleet-aware process check commands for Unix', () => {
    const cmd = getFleetProcessCheckCommand('linux', '/home/user/project');
    expect(cmd).toContain('pgrep');
    expect(cmd).toContain('fleet-busy');
    expect(cmd).toContain('other-busy');
    expect(cmd).toContain('idle');
  });

  it('generates fleet-aware process check commands for Windows', () => {
    const cmd = getFleetProcessCheckCommand('windows', 'C:\\Users\\dev\\project');
    expect(cmd).toContain('Get-Process claude');
    expect(cmd).toContain('fleet-busy');
    expect(cmd).toContain('other-busy');
    expect(cmd).toContain('idle');
  });

  it('includes session ID in fleet process check when provided', () => {
    const cmd = getFleetProcessCheckCommand('linux', '/home/user/project', 'sess-abc-123');
    expect(cmd).toContain('sess-abc-123');
    expect(cmd).toContain('/home/user/project');
  });

  it('handles missing session ID without stringifying undefined', () => {
    const cmd = getFleetProcessCheckCommand('linux', '/srv/app');
    expect(cmd).not.toContain('undefined');
  });

  it('generates mkdir commands', () => {
    expect(getMkdirCommand('linux', '/tmp/test')).toBe('mkdir -p "/tmp/test"');
    expect(getMkdirCommand('windows', 'C:\\test')).toContain('mkdir');
  });

  it('generates setenv commands for each OS', () => {
    const linuxCmds = getSetEnvCommand('linux', 'MY_VAR', 'value');
    expect(linuxCmds.length).toBe(3);
    expect(linuxCmds[0]).toContain('.bashrc');

    const macosCmds = getSetEnvCommand('macos', 'MY_VAR', 'value');
    expect(macosCmds.length).toBe(4);
    expect(macosCmds.some(c => c.includes('.zshrc'))).toBe(true);

    const winCmds = getSetEnvCommand('windows', 'MY_VAR', 'value');
    expect(winCmds.length).toBe(1);
    expect(winCmds[0]).toContain('setx');
  });

  it('generates unsetenv commands for each OS', () => {
    const linuxCmds = getUnsetEnvCommand('linux', 'MY_VAR');
    expect(linuxCmds.length).toBe(3);
    expect(linuxCmds[0]).toContain('sed');
    expect(linuxCmds[2]).toContain('unset MY_VAR');

    const macosCmds = getUnsetEnvCommand('macos', 'MY_VAR');
    expect(macosCmds.length).toBe(4);
    expect(macosCmds[3]).toContain('unset MY_VAR');

    const winCmds = getUnsetEnvCommand('windows', 'MY_VAR');
    expect(winCmds[0]).toContain('reg delete');
  });
});

describe('injection prevention in platform commands', () => {
  it('escapes folder injection in disk command', () => {
    const cmd = getDiskCommand('linux', '/home/user/$(whoami)/project');
    expect(cmd).toContain('\\$(whoami)');
  });

  it('escapes folder injection in mkdir command', () => {
    const cmd = getMkdirCommand('linux', '/tmp/$(rm -rf /)');
    expect(cmd).toContain('\\$(rm');

    const winCmd = getMkdirCommand('windows', 'C:\\test"&whoami&"');
    expect(winCmd).toContain('""');
    expect(winCmd).toContain('^&');
  });

  it('escapes folder injection in fleet process check', () => {
    const cmd = getFleetProcessCheckCommand('linux', '/home/user/$(whoami)');
    expect(cmd).toContain('\\$');
    expect(cmd).toContain('\\(');

    const winCmd = getFleetProcessCheckCommand('windows', 'C:\\Users\\dev"&whoami&"project');
    expect(winCmd).toContain('""');
    expect(winCmd).toContain('^&');
  });

  it('rejects invalid session IDs in fleet process check', () => {
    expect(() => getFleetProcessCheckCommand('linux', '/home/user', 'sess;whoami')).toThrow('Invalid session ID');
    expect(() => getFleetProcessCheckCommand('windows', 'C:\\work', 'sess$(cmd)')).toThrow('Invalid session ID');
  });

  it('escapes injection in setenv values', () => {
    const linuxCmds = getSetEnvCommand('linux', 'MY_VAR', '"; rm -rf / #');
    for (const cmd of linuxCmds) {
      expect(cmd).toContain('\\"');
    }

    const winCmds = getSetEnvCommand('windows', 'MY_VAR', '"&whoami&"');
    expect(winCmds[0]).toContain('""');
    expect(winCmds[0]).toContain('^&');
  });
});
