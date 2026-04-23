import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { pidWrapUnix } from '../../src/os/linux.js';
import { pidWrapWindows } from '../../src/os/windows.js';

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
    expect(pidWrapWindows('claude --version')).toContain('FLEET_PID:');
  });

  it('uses $PID (current PowerShell session PID)', () => {
    expect(pidWrapWindows('claude --version')).toContain('$PID');
  });

  it('emits PID before inner command in text order', () => {
    const inner = 'Set-Location "C:\\path"; claude -p file';
    const wrapped = pidWrapWindows(inner);
    const pidIdx = wrapped.indexOf('FLEET_PID:');
    const cmdIdx = wrapped.indexOf(inner);
    expect(pidIdx).toBeGreaterThanOrEqual(0);
    expect(cmdIdx).toBeGreaterThanOrEqual(0);
    expect(pidIdx).toBeLessThan(cmdIdx);
  });

  it('includes the inner command verbatim', () => {
    const inner = 'Set-Location "C:\\Users\\dev\\project"; claude -p file.md --output-format json';
    expect(pidWrapWindows(inner)).toContain(inner);
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

// ─── pidWrapWindows execution tests (Windows only) ───────────────────────────

const winTest = process.platform !== 'win32' ? it.skip : it;

describe('pidWrapWindows execution', () => {
  winTest('emits FLEET_PID as first stdout line before command output', () => {
    const cmd = pidWrapWindows('Start-Sleep -Milliseconds 50; Write-Output "hello"');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], {
      encoding: 'utf8',
      timeout: 10000,
    });
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    expect(lines[0]).toMatch(/^FLEET_PID:\d+$/);
    expect(lines[1]).toBe('hello');
  });

  winTest('emitted PID is the current process ID (positive integer)', () => {
    const cmd = pidWrapWindows('Write-Output "done"');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], {
      encoding: 'utf8',
      timeout: 10000,
    });
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    expect(lines[0]).toMatch(/^FLEET_PID:\d+$/);
    const pid = parseInt(lines[0].split(':')[1], 10);
    expect(pid).toBeGreaterThan(0);
  });
});
