import { describe, it, expect } from 'vitest';
import { getOsCommands, LinuxCommands, MacOSCommands, WindowsCommands, WindowsGitBashCommands } from '../src/os/index.js';

// apra-fleet-7dir.2.3: getOsCommands(os, shell) resolution and the
// gitbash-vs-powershell5 command-string split it enables.
//
// Only `os === 'windows' && shell === 'gitbash'` selects WindowsGitBashCommands
// (src/os/index.ts). Every other (os, shell) pair -- including a Windows
// member with no shell recorded, or with pwsh7/powershell5 -- must resolve
// exactly as it did before the `shell` parameter existed.

describe('getOsCommands resolution', () => {
  it('linux ignores the shell parameter entirely', () => {
    expect(getOsCommands('linux')).toBeInstanceOf(LinuxCommands);
    expect(getOsCommands('linux', undefined)).toBeInstanceOf(LinuxCommands);
    expect(getOsCommands('linux', 'gitbash')).toBeInstanceOf(LinuxCommands);
    expect(getOsCommands('linux', 'powershell5')).toBeInstanceOf(LinuxCommands);
  });

  it('macos ignores the shell parameter entirely', () => {
    expect(getOsCommands('macos')).toBeInstanceOf(MacOSCommands);
    expect(getOsCommands('macos', undefined)).toBeInstanceOf(MacOSCommands);
    expect(getOsCommands('macos', 'gitbash')).toBeInstanceOf(MacOSCommands);
    expect(getOsCommands('macos', 'powershell5')).toBeInstanceOf(MacOSCommands);
  });

  it('windows with no shell recorded (unset-shell default) resolves to WindowsCommands (PowerShell)', () => {
    const cmds = getOsCommands('windows');
    expect(cmds).toBeInstanceOf(WindowsCommands);
    expect(cmds).not.toBeInstanceOf(WindowsGitBashCommands);
  });

  it('windows + undefined shell resolves to WindowsCommands (PowerShell)', () => {
    expect(getOsCommands('windows', undefined)).toBeInstanceOf(WindowsCommands);
  });

  it('windows + powershell5 resolves to WindowsCommands', () => {
    const cmds = getOsCommands('windows', 'powershell5');
    expect(cmds).toBeInstanceOf(WindowsCommands);
    expect(cmds).not.toBeInstanceOf(WindowsGitBashCommands);
  });

  it('windows + pwsh7 resolves to WindowsCommands (only gitbash gets its own class)', () => {
    const cmds = getOsCommands('windows', 'pwsh7');
    expect(cmds).toBeInstanceOf(WindowsCommands);
    expect(cmds).not.toBeInstanceOf(WindowsGitBashCommands);
  });

  it('windows + gitbash resolves to WindowsGitBashCommands (a LinuxCommands subclass)', () => {
    const cmds = getOsCommands('windows', 'gitbash');
    expect(cmds).toBeInstanceOf(WindowsGitBashCommands);
    expect(cmds).toBeInstanceOf(LinuxCommands);
  });

  it('returns the same singleton instance across repeated calls for every combination', () => {
    expect(getOsCommands('linux')).toBe(getOsCommands('linux'));
    expect(getOsCommands('macos')).toBe(getOsCommands('macos'));
    expect(getOsCommands('windows')).toBe(getOsCommands('windows'));
    expect(getOsCommands('windows', 'powershell5')).toBe(getOsCommands('windows'));
    expect(getOsCommands('windows', 'gitbash')).toBe(getOsCommands('windows', 'gitbash'));
  });
});

// A command string emitted for the gitbash shell must never accidentally
// contain a PowerShell cmdlet or an -EncodedCommand envelope -- either would
// mean the string is being sent to a shell (bash) that cannot execute it.
const POWERSHELL_MARKERS = [
  '-EncodedCommand',
  'powershell -c',
  'Get-Item',
  'Get-Content',
  'Get-ChildItem',
  'New-Item',
  'Set-Content',
  'Test-Path',
  '$env:',
];

function assertNoPowerShellSyntax(cmd: string): void {
  for (const marker of POWERSHELL_MARKERS) {
    expect(cmd).not.toContain(marker);
  }
}

describe('WindowsGitBashCommands command-string generation (bash for a gitbash Windows member)', () => {
  const gitbash = getOsCommands('windows', 'gitbash');

  it('credentialFileWrite emits a POSIX write with an NTFS icacls follow-up, no PowerShell', () => {
    const cmd = gitbash.credentialFileWrite('secret-token', '/home/user/.fleet-cred');
    assertNoPowerShellSyntax(cmd);
    expect(cmd).toContain('printf');
    expect(cmd).toContain('mkdir -p');
    expect(cmd).toContain('icacls');
  });

  it('wrapInWorkFolder emits a POSIX cd, no PowerShell Set-Location', () => {
    const cmd = gitbash.wrapInWorkFolder('/home/user/project', 'echo hi');
    assertNoPowerShellSyntax(cmd);
    expect(cmd).not.toContain('Set-Location');
    expect(cmd).toContain('cd "');
    expect(cmd).toContain('echo hi');
  });

  it('mkdir emits POSIX mkdir -p, no New-Item', () => {
    const cmd = gitbash.mkdir('/home/user/project/newdir');
    assertNoPowerShellSyntax(cmd);
    expect(cmd).toContain('mkdir -p');
  });

  it('readTextFile emits POSIX cat, no Get-Content', () => {
    const cmd = gitbash.readTextFile('/home/user/project/file.txt');
    assertNoPowerShellSyntax(cmd);
    expect(cmd).toContain('cat "');
  });

  it('wrapPidCapture emits the bash FLEET_PID subshell wrapper, no PowerShell $pid form', () => {
    const cmd = gitbash.wrapPidCapture('echo hi');
    assertNoPowerShellSyntax(cmd);
    expect(cmd).toContain('FLEET_PID:%s');
    expect(cmd).toContain('$!');
  });
});

describe('WindowsGitBashCommands Windows-native overrides stay Windows-appropriate', () => {
  const gitbash = getOsCommands('windows', 'gitbash');

  it('killPid uses taskkill (no bash-native process tree kill exists in Git bash)', () => {
    const cmd = gitbash.killPid(4242);
    expect(cmd).toContain('taskkill');
    expect(cmd).toContain('4242');
    // Doubled slashes so MSYS does not path-mangle the switches (see class doc comment).
    expect(cmd).toContain('//F');
    expect(cmd).toContain('//T');
    expect(cmd).toContain('//PID');
  });

  it('disk queries via df -h against the bash-normalized member path (still a real Windows drive query)', () => {
    const cmd = gitbash.disk('C:\\Users\\alice\\project');
    expect(cmd).toContain('df -h');
    // toBashPath normalizes backslashes to forward slashes for MSYS.
    expect(cmd).not.toContain('\\');
  });

  it('fleetProcessCheck is the one override that legitimately reaches PowerShell (no bash-native way to read another process command line on Windows), wrapped bash-safely via -EncodedCommand', () => {
    const cmd = gitbash.fleetProcessCheck('/home/user/project');
    expect(cmd).toContain('powershell -EncodedCommand');
  });
});

describe('powershell5 golden comparison: the widened getOsCommands signature must not change existing Windows output', () => {
  // Today's behavior === getOsCommands('windows') with no shell argument at all.
  const legacy = getOsCommands('windows');
  const powershell5 = getOsCommands('windows', 'powershell5');
  const noShellRecorded = getOsCommands('windows', undefined);

  it('is the identical singleton instance for legacy, explicit powershell5, and undefined shell', () => {
    expect(powershell5).toBe(legacy);
    expect(noShellRecorded).toBe(legacy);
  });

  it('credentialFileWrite output is byte-identical', () => {
    expect(powershell5.credentialFileWrite('secret-token', 'C:\\Users\\alice\\.fleet-cred'))
      .toBe(legacy.credentialFileWrite('secret-token', 'C:\\Users\\alice\\.fleet-cred'));
  });

  it('wrapInWorkFolder output is byte-identical', () => {
    expect(powershell5.wrapInWorkFolder('C:\\Users\\alice\\project', 'echo hi'))
      .toBe(legacy.wrapInWorkFolder('C:\\Users\\alice\\project', 'echo hi'));
  });

  it('mkdir output is byte-identical', () => {
    expect(powershell5.mkdir('C:\\Users\\alice\\project\\newdir'))
      .toBe(legacy.mkdir('C:\\Users\\alice\\project\\newdir'));
  });

  it('readTextFile output is byte-identical', () => {
    expect(powershell5.readTextFile('C:\\Users\\alice\\project\\file.txt'))
      .toBe(legacy.readTextFile('C:\\Users\\alice\\project\\file.txt'));
  });

  it('killPid output is byte-identical (still native taskkill, PowerShell slash form)', () => {
    expect(powershell5.killPid(4242)).toBe(legacy.killPid(4242));
    expect(powershell5.killPid(4242)).toContain('/F');
    expect(powershell5.killPid(4242)).not.toContain('//F');
  });

  it('disk output is byte-identical (still the PowerShell DriveInfo query)', () => {
    expect(powershell5.disk('C:\\Users\\alice\\project')).toBe(legacy.disk('C:\\Users\\alice\\project'));
    expect(powershell5.disk('C:\\Users\\alice\\project')).toContain('DriveInfo');
  });

  it('wrapPidCapture output is byte-identical (still the PowerShell $pid form)', () => {
    expect(powershell5.wrapPidCapture('echo hi')).toBe(legacy.wrapPidCapture('echo hi'));
    expect(powershell5.wrapPidCapture('echo hi')).toContain('FLEET_PID:$pid');
  });
});
