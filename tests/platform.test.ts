import { describe, it, expect } from 'vitest';
import {
  detectOS,
  getShellCommand,
  getCpuLoadCommand,
  getMemoryCommand,
  getDiskCommand,
  getFleetProcessCheckCommand,
  getClaudeCheckCommand,
  getScpCheckCommand,
  getMkdirCommand,
  getSetEnvCommand,
  getUnsetEnvCommand,
} from '../src/utils/platform.js';

describe('detectOS', () => {
  it('detects Linux from uname', () => {
    expect(detectOS('Linux', '')).toBe('linux');
  });

  it('detects macOS from uname', () => {
    expect(detectOS('Darwin', '')).toBe('macos');
  });

  it('detects Windows from ver output', () => {
    expect(detectOS('', 'Microsoft Windows [Version 10.0.19045]')).toBe('windows');
  });

  it('defaults to linux for unknown output', () => {
    expect(detectOS('SomeUnknownOS', '')).toBe('linux');
  });

  it('prioritizes Windows detection from ver over uname', () => {
    expect(detectOS('Linux', 'Microsoft Windows')).toBe('windows');
  });
});

describe('getShellCommand', () => {
  it('wraps command in cmd /c for windows', () => {
    expect(getShellCommand('windows', 'echo hi')).toBe('cmd /c "echo hi"');
  });

  it('passes command through for linux', () => {
    expect(getShellCommand('linux', 'echo hi')).toBe('echo hi');
  });

  it('passes command through for macos', () => {
    expect(getShellCommand('macos', 'echo hi')).toBe('echo hi');
  });
});

describe('platform command generators', () => {
  it('generates CPU load commands for each OS', () => {
    expect(getCpuLoadCommand('linux')).toBe('uptime');
    expect(getCpuLoadCommand('macos')).toContain('vm.loadavg');
    expect(getCpuLoadCommand('windows')).toContain('wmic');
  });

  it('generates memory commands for each OS', () => {
    expect(getMemoryCommand('linux')).toBe('free -m');
    expect(getMemoryCommand('macos')).toContain('vm_stat');
    expect(getMemoryCommand('windows')).toContain('wmic');
  });

  it('generates disk commands with correct folder', () => {
    expect(getDiskCommand('linux', '/home/user')).toContain('/home/user');
    expect(getDiskCommand('macos', '/opt/app')).toContain('/opt/app');
    expect(getDiskCommand('windows', 'C:\\work')).toContain("caption='C:'");
  });

  it('generates fleet-aware process check commands for Unix', () => {
    const cmd = getFleetProcessCheckCommand('linux', '/home/user/project');
    expect(cmd).toContain('pgrep');
    expect(cmd).toContain('/home/user/project');
    expect(cmd).toContain('fleet-busy');
    expect(cmd).toContain('other-busy');
    expect(cmd).toContain('idle');

    // macOS same logic
    const macCmd = getFleetProcessCheckCommand('macos', '/opt/app');
    expect(macCmd).toContain('pgrep');
    expect(macCmd).toContain('/opt/app');
  });

  it('generates fleet-aware process check commands for Windows', () => {
    const cmd = getFleetProcessCheckCommand('windows', 'C:\\Users\\dev\\project');
    expect(cmd).toContain('wmic process');
    expect(cmd).toContain('fleet-busy');
    expect(cmd).toContain('other-busy');
    expect(cmd).toContain('idle');
  });

  it('includes session ID in fleet process check when provided', () => {
    const cmd = getFleetProcessCheckCommand('linux', '/home/user/project', 'sess-abc-123');
    expect(cmd).toContain('sess-abc-123');
    expect(cmd).toContain('/home/user/project');

    const winCmd = getFleetProcessCheckCommand('windows', 'C:\\work', 'sess-xyz');
    expect(winCmd).toContain('sess-xyz');
  });

  it('works without session ID in fleet process check', () => {
    const cmd = getFleetProcessCheckCommand('linux', '/srv/app');
    expect(cmd).toContain('/srv/app');
    expect(cmd).not.toContain('undefined');
  });

  it('generates claude check commands', () => {
    expect(getClaudeCheckCommand('linux')).toContain('which');
    expect(getClaudeCheckCommand('macos')).toContain('which');
    expect(getClaudeCheckCommand('windows')).toContain('where');
  });

  it('generates scp check commands', () => {
    expect(getScpCheckCommand('linux')).toContain('which');
    expect(getScpCheckCommand('windows')).toContain('where');
  });

  it('generates mkdir commands', () => {
    expect(getMkdirCommand('linux', '/tmp/test')).toBe('mkdir -p "/tmp/test"');
    expect(getMkdirCommand('windows', 'C:\\test')).toContain('mkdir');
  });

  it('escapes folder paths with injection attempts in disk command', () => {
    const malicious = '/home/user/$(whoami)/project';
    const cmd = getDiskCommand('linux', malicious);
    // $ should be escaped to \$ inside double quotes
    expect(cmd).toContain('\\$(whoami)');

    // Windows: getDiskCommand only uses first char as drive letter, so injection in path is neutralized
    const winCmd = getDiskCommand('windows', 'C:\\Users\\project');
    expect(winCmd).toContain("caption='C:'");
  });

  it('escapes folder paths with injection attempts in mkdir command', () => {
    const malicious = '/tmp/$(rm -rf /)';
    const cmd = getMkdirCommand('linux', malicious);
    // $ is escaped to \$ preventing command substitution
    expect(cmd).toContain('\\$(rm');

    const winMalicious = 'C:\\test"&whoami&"';
    const winCmd = getMkdirCommand('windows', winMalicious);
    // Double quotes are doubled, & is escaped with ^
    expect(winCmd).toContain('""');
    expect(winCmd).toContain('^&');
  });

  it('escapes folder paths with injection attempts in fleet process check', () => {
    const malicious = '/home/user/$(whoami)';
    const cmd = getFleetProcessCheckCommand('linux', malicious);
    // grep metacharacters in folder should be escaped
    expect(cmd).toContain('\\$');
    expect(cmd).toContain('\\(');

    const winMalicious = 'C:\\Users\\dev"&whoami&"project';
    const winCmd = getFleetProcessCheckCommand('windows', winMalicious);
    expect(winCmd).toContain('""');
    expect(winCmd).toContain('^&');
  });

  it('rejects invalid session IDs in fleet process check', () => {
    expect(() => getFleetProcessCheckCommand('linux', '/home/user', 'sess;whoami')).toThrow('Invalid session ID');
    expect(() => getFleetProcessCheckCommand('windows', 'C:\\work', 'sess$(cmd)')).toThrow('Invalid session ID');
  });

  it('generates setenv commands for each OS', () => {
    const linuxCmds = getSetEnvCommand('linux', 'MY_VAR', 'value');
    expect(linuxCmds.length).toBe(3);
    expect(linuxCmds[0]).toContain('.bashrc');
    expect(linuxCmds[1]).toContain('.profile');

    const macosCmds = getSetEnvCommand('macos', 'MY_VAR', 'value');
    expect(macosCmds.length).toBe(4);
    expect(macosCmds.some(c => c.includes('.zshrc'))).toBe(true);

    const winCmds = getSetEnvCommand('windows', 'MY_VAR', 'value');
    expect(winCmds.length).toBe(1);
    expect(winCmds[0]).toContain('setx');
  });

  it('escapes values with injection attempts in setenv commands', () => {
    const malicious = '"; rm -rf / #';
    const linuxCmds = getSetEnvCommand('linux', 'MY_VAR', malicious);
    // The " is escaped to \" preventing quote-breaking
    for (const cmd of linuxCmds) {
      expect(cmd).toContain('\\"');
    }

    const winCmds = getSetEnvCommand('windows', 'MY_VAR', '"&whoami&"');
    // Double quotes are doubled, & is caret-escaped
    expect(winCmds[0]).toContain('""');
    expect(winCmds[0]).toContain('^&');
  });

  it('generates unsetenv commands for each OS', () => {
    const linuxCmds = getUnsetEnvCommand('linux', 'MY_VAR');
    expect(linuxCmds.length).toBe(3);
    expect(linuxCmds[0]).toContain('sed');
    expect(linuxCmds[0]).toContain('.bashrc');
    expect(linuxCmds[1]).toContain('.profile');
    expect(linuxCmds[2]).toContain('unset MY_VAR');

    const macosCmds = getUnsetEnvCommand('macos', 'MY_VAR');
    expect(macosCmds.length).toBe(4);
    expect(macosCmds.some(c => c.includes('.zshrc'))).toBe(true);
    expect(macosCmds.some(c => c.includes('.bashrc'))).toBe(true);
    expect(macosCmds.some(c => c.includes('.profile'))).toBe(true);
    expect(macosCmds[3]).toContain('unset MY_VAR');

    const winCmds = getUnsetEnvCommand('windows', 'MY_VAR');
    expect(winCmds.length).toBe(1);
    expect(winCmds[0]).toContain('reg delete');
    expect(winCmds[0]).toContain('MY_VAR');
  });
});
