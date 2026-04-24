import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { pidWrapUnix } from '../../src/os/linux.js';
import { pidWrapWindows } from '../../src/os/windows.js';
import { LinuxCommands } from '../../src/os/linux.js';
import { WindowsCommands } from '../../src/os/windows.js';

// ─── pidWrapUnix (string structure) ──────────────────────────────────────────

describe('pidWrapUnix string structure', () => {
  it('contains FLEET_PID: marker', () => {
    expect(pidWrapUnix('echo hello')).toContain('FLEET_PID:');
  });

  it('uses a captured variable for the PID', () => {
    expect(pidWrapUnix('echo hello')).toContain('_fleet_pid');
  });

  it('backgrounds the inner command in a subshell', () => {
    expect(pidWrapUnix('echo hello')).toMatch(/\{[^}]+\}\s*&/);
  });

  it('waits for the background process', () => {
    expect(pidWrapUnix('echo hello')).toContain('wait ');
  });

  it('propagates exit code with exit $?', () => {
    expect(pidWrapUnix('echo hello')).toContain('exit $?');
  });

  it('emits PID before wait in command order', () => {
    const wrapped = pidWrapUnix('echo hello');
    const pidIdx = wrapped.indexOf('FLEET_PID:');
    const waitIdx = wrapped.indexOf('wait ');
    expect(pidIdx).toBeGreaterThanOrEqual(0);
    expect(waitIdx).toBeGreaterThanOrEqual(0);
    expect(pidIdx).toBeLessThan(waitIdx);
  });

  it('includes the inner command verbatim', () => {
    const inner = 'cd "/some/path" && export PATH="$HOME/.local/bin:$PATH" && claude -p file';
    expect(pidWrapUnix(inner)).toContain(inner);
  });
});

// ─── pidWrapWindows (string structure) ───────────────────────────────────────

describe('pidWrapWindows string structure', () => {
  it('contains FLEET_PID: marker', () => {
    expect(pidWrapWindows('', 'claude', '--version')).toContain('FLEET_PID:');
  });

  it('uses $_fleet_proc.Id (Claude CLI child PID, not PowerShell $PID)', () => {
    const out = pidWrapWindows('', 'claude', '--version');
    expect(out).toContain('$_fleet_proc.Id');
    expect(out).not.toContain('FLEET_PID:$PID');
  });

  it('uses Start-Process -PassThru -NoNewWindow', () => {
    const out = pidWrapWindows('', 'claude', '--version');
    expect(out).toContain('Start-Process');
    expect(out).toContain('-PassThru');
    expect(out).toContain('-NoNewWindow');
  });

  it('includes WaitForExit and exit code propagation', () => {
    const out = pidWrapWindows('', 'claude', '--version');
    expect(out).toContain('WaitForExit');
    expect(out).toContain('exit $_fleet_proc.ExitCode');
  });

  it('includes the filePath and argList in the output', () => {
    const out = pidWrapWindows('Set-Location "C:\\work"; ', 'claude', '-p "task" --output-format json');
    expect(out).toContain('claude');
    expect(out).toContain('-p "task" --output-format json');
    expect(out).toContain('Set-Location "C:\\work"');
  });

  it('places setup commands before Start-Process', () => {
    const setup = 'Set-Location "C:\\path"; ';
    const out = pidWrapWindows(setup, 'claude', '--version');
    const setupIdx = out.indexOf('Set-Location');
    const startIdx = out.indexOf('Start-Process');
    expect(setupIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(setupIdx).toBeLessThan(startIdx);
  });
});

// ─── pidWrapUnix execution tests (Unix only) ─────────────────────────────────

const unixTest = process.platform === 'win32' ? it.skip : it;

describe('pidWrapUnix execution', () => {
  unixTest('emits FLEET_PID as first stdout line before command output', () => {
    // sleep 0.05 ensures the inner command's output comes after the PID line
    const cmd = pidWrapUnix('sleep 0.05 && printf "hello\\n"');
    const result = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: 5000 });
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines[0]).toMatch(/^FLEET_PID:\d+$/);
    expect(lines[1]).toBe('hello');
  });

  unixTest('emitted PID is a positive integer', () => {
    const cmd = pidWrapUnix('sleep 0.05');
    const result = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: 5000 });
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines[0]).toMatch(/^FLEET_PID:\d+$/);
    const pid = parseInt(lines[0].split(':')[1], 10);
    expect(pid).toBeGreaterThan(0);
  });

  unixTest('propagates exit code 0 from successful inner command', () => {
    const cmd = pidWrapUnix('true');
    const result = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(0);
  });

  unixTest('propagates non-zero exit code from inner command', () => {
    const cmd = pidWrapUnix('bash -c "exit 7"');
    const result = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(7);
  });
});

// ─── killPid string tests ─────────────────────────────────────────────────────

describe('LinuxCommands.killPid', () => {
  const cmds = new LinuxCommands();

  it('returns kill -9 command with the given PID', () => {
    expect(cmds.killPid(1234)).toBe('kill -9 1234');
  });

  it('works for PID 1', () => {
    expect(cmds.killPid(1)).toBe('kill -9 1');
  });
});

describe('WindowsCommands.killPid', () => {
  const cmds = new WindowsCommands();

  it('returns taskkill command with force and tree flags', () => {
    expect(cmds.killPid(5678)).toBe('taskkill /F /T /PID 5678');
  });

  it('includes /T to terminate child processes', () => {
    expect(cmds.killPid(100)).toContain('/T');
  });
});

// ─── pidWrapWindows execution tests (Windows only) ───────────────────────────

const winTest = process.platform !== 'win32' ? it.skip : it;

describe('pidWrapWindows execution', () => {
  winTest('emits a FLEET_PID line with the child process ID', () => {
    // Use powershell.exe as the child executable for testing
    const cmd = pidWrapWindows('', 'powershell.exe', '-NoProfile -Command Write-Output done');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], {
      encoding: 'utf8',
      timeout: 10000,
    });
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    const pidLine = lines.find(l => /^FLEET_PID:\d+$/.test(l));
    expect(pidLine).toBeDefined();
  });

  winTest('emitted PID is a positive integer (the child PID, not PS PID)', () => {
    const cmd = pidWrapWindows('', 'powershell.exe', '-NoProfile -Command Write-Output done');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], {
      encoding: 'utf8',
      timeout: 10000,
    });
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    const pidLine = lines.find(l => /^FLEET_PID:\d+$/.test(l));
    expect(pidLine).toBeDefined();
    const pid = parseInt(pidLine!.split(':')[1], 10);
    expect(pid).toBeGreaterThan(0);
  });
});
