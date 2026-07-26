import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
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
  it('includes the filePath and argList in the output', () => {
    const out = pidWrapWindows('Set-Location "C:\\work"; ', 'claude', '-p "task" --output-format json');
    expect(out).toContain('claude');
    expect(out).toContain('-p "task" --output-format json');
    expect(out).toContain('Set-Location "C:\\work"');
  });

  it('places setup commands before ProcessStartInfo', () => {
    const setup = 'Set-Location "C:\\path"; ';
    const out = pidWrapWindows(setup, 'claude', '--version');
    const setupIdx = out.indexOf('Set-Location');
    const startIdx = out.indexOf('ProcessStartInfo');
    expect(setupIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(setupIdx).toBeLessThan(startIdx);
  });
});

// ─── pidWrapUnix execution tests (Unix only) ─────────────────────────────────

describe('pidWrapUnix execution', () => {
  it.skipIf(process.platform === 'win32')('emits FLEET_PID as first stdout line before command output', () => {
    // sleep 0.05 ensures the inner command's output comes after the PID line
    const cmd = pidWrapUnix('sleep 0.05 && printf "hello\\n"');
    const result = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: 5000 });
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines[0]).toMatch(/^FLEET_PID:\d+$/);
    expect(lines[1]).toBe('hello');
  });

  it.skipIf(process.platform === 'win32')('emitted PID is a positive integer', () => {
    const cmd = pidWrapUnix('sleep 0.05');
    const result = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: 5000 });
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines[0]).toMatch(/^FLEET_PID:\d+$/);
    const pid = parseInt(lines[0].split(':')[1], 10);
    expect(pid).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === 'win32')('propagates exit code 0 from successful inner command', () => {
    const cmd = pidWrapUnix('true');
    const result = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('propagates non-zero exit code from inner command', () => {
    const cmd = pidWrapUnix('bash -c "exit 7"');
    const result = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(7);
  });
});

// ─── killPid string tests ─────────────────────────────────────────────────────

describe('LinuxCommands.killPid', () => {
  const cmds = new LinuxCommands();

  it('kills the given PID', () => {
    // The recursive tree-killer indirects through "$1" rather than
    // interpolating the literal pid into the `kill -9` call; the literal
    // pid instead appears at the top-level `_fleet_kill_tree <pid>` call site.
    const out = cmds.killPid(1234);
    expect(out).toContain('_fleet_kill_tree 1234');
    expect(out).toContain('kill -9 "$1"');
  });

  it('works for PID 1', () => {
    const out = cmds.killPid(1);
    expect(out).toContain('_fleet_kill_tree 1');
    expect(out).toContain('kill -9 "$1"');
  });

  it('recurses into descendants via pgrep -P before killing the pid', () => {
    const out = cmds.killPid(1234);
    expect(out).toContain('pgrep -P "$1"');
    const treeIdx = out.indexOf('_fleet_kill_tree "$_fleet_child"');
    const killIdx = out.lastIndexOf('kill -9 "$1"');
    expect(treeIdx).toBeGreaterThanOrEqual(0);
    expect(killIdx).toBeGreaterThan(treeIdx);
  });

  it('is best-effort -- never throws even if the tree is already gone', () => {
    const out = cmds.killPid(1234);
    expect(out).toContain('2>/dev/null');
    expect(out.trim().endsWith('; true')).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('terminates a backgrounded descendant, not just the top-level pid', async () => {
    // Mirror the real scenario this fix targets: a CLI invocation whose
    // shell keeps running (via pidWrapUnix's own `{ cmd; } & ... wait`
    // shape) while `cmd` itself backgrounds a further child (e.g. a doer's
    // fixed-port dev/test server started with `&`) and does NOT exit --
    // `sleep 30 & wait` forces a real subshell (no single-simple-command
    // exec optimization), so the captured FLEET_PID is the parent of a real
    // `sleep` grandchild.
    const wrapped = pidWrapUnix('sleep 30 & wait');
    const proc = spawn('bash', ['-c', wrapped], { stdio: ['ignore', 'pipe', 'ignore'] });

    try {
      const pid: number = await new Promise((resolve, reject) => {
        let buf = '';
        const onData = (chunk: Buffer) => {
          buf += chunk.toString();
          const m = /^FLEET_PID:(\d+)/m.exec(buf);
          if (m) {
            proc.stdout?.off('data', onData);
            resolve(parseInt(m[1], 10));
          }
        };
        proc.stdout?.on('data', onData);
        proc.on('error', reject);
        setTimeout(() => reject(new Error('timed out waiting for FLEET_PID')), 5000);
      });
      expect(pid).toBeGreaterThan(0);

      // Poll until the `sleep` grandchild actually shows up under `pid`.
      let grandchildPid = 0;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !grandchildPid) {
        const pgrep = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
        const found = parseInt((pgrep.stdout || '').trim().split('\n')[0], 10);
        if (found > 0) grandchildPid = found;
      }
      expect(grandchildPid).toBeGreaterThan(0);

      spawnSync('bash', ['-c', cmds.killPid(pid)], { encoding: 'utf8', timeout: 2000 });

      // Both the subshell (`pid`) and the backgrounded `sleep` grandchild
      // must be gone -- proving the tree-kill recursed past the immediate
      // pid instead of leaving the backgrounded descendant orphaned to
      // keep holding whatever port/resource it opened.
      const pidAlive = spawnSync('kill', ['-0', String(pid)]).status === 0;
      const grandchildAlive = spawnSync('kill', ['-0', String(grandchildPid)]).status === 0;
      expect(pidAlive).toBe(false);
      expect(grandchildAlive).toBe(false);
    } finally {
      // Best-effort cleanup in case an assertion threw before the kill.
      try { process.kill(proc.pid!, 'SIGKILL'); } catch { /* already gone */ }
    }
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
