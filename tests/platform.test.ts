import { describe, it, expect } from 'vitest';
import {
  detectOS,
  getShellCommand,
  getCpuLoadCommand,
  getMemoryCommand,
  getDiskCommand,
  getProcessCheckCommand,
  getClaudeCheckCommand,
  getScpCheckCommand,
  getMkdirCommand,
  getSetEnvCommand,
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

  it('generates process check commands', () => {
    expect(getProcessCheckCommand('linux')).toContain('pgrep');
    expect(getProcessCheckCommand('macos')).toContain('pgrep');
    expect(getProcessCheckCommand('windows')).toContain('tasklist');
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
});
