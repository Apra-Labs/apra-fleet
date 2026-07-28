/**
 * Regression test for apra-fleet-kwx: a timed-out LocalStrategy.execCommand
 * must kill the WHOLE process tree, not just the immediate shell wrapper.
 *
 * Real incident (2026-07-02/03, apra-fleet-reorg): an execute_prompt call
 * that hit its inactivity timeout was reported to the caller as failed, but
 * the underlying provider-CLI process kept running and corrupted .git
 * mid-rebase. Root cause: `child.kill('SIGKILL')` only signals the
 * immediate spawned process (the shell wrapper) -- a grandchild process
 * (the actual CLI, or anything it launches) survives and keeps mutating the
 * working directory.
 *
 * This test spawns a command whose OUTER process (the one Node spawns
 * directly, matching the shell wrapper in LocalStrategy) starts a real
 * child process and blocks on it synchronously via WaitForExit() -- the
 * same shape as a provider CLI shelling out to `git` and waiting on it. No
 * stdout is ever produced, so the inactivity timer fires while the outer
 * process is still alive and blocked. It proves the child stops being
 * alive shortly after the timeout fires, i.e. the whole tree was killed,
 * not just the wrapper.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getStrategy } from '../src/services/strategy.js';
import { makeTestLocalAgent } from './test-helpers.js';

describe.skipIf(process.platform !== 'win32')('LocalStrategy: process-tree kill on timeout (apra-fleet-kwx)', () => {
  let tmpDir: string;
  let heartbeatPath: string;

  let heartbeatScriptPath: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `fleet-test-kwx-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    heartbeatPath = path.join(tmpDir, 'heartbeat.txt');
    heartbeatScriptPath = path.join(tmpDir, 'heartbeat.ps1');
    fs.writeFileSync(
      heartbeatScriptPath,
      `while ($true) { Add-Content -Path '${heartbeatPath.replace(/'/g, "''")}' -Value ([DateTime]::UtcNow.Ticks); Start-Sleep -Milliseconds 100 }`,
      'utf-8',
    );
  });

  afterEach(async () => {
    // The killed process's file handle can take a beat to release on
    // Windows -- retry rather than flake on EBUSY.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 10000);

  it('kills a detached grandchild process after the inactivity timeout fires, not just the shell wrapper', async () => {
    const member = makeTestLocalAgent({ workFolder: tmpDir });
    const strategy = getStrategy(member);

    // Outer process: launches a real child via [Process]::Start (a true
    // CreateProcess child, unlike the Start-Process cmdlet which can go
    // through ShellExecute and re-parent under a shell host) running the
    // never-ending heartbeat script, then blocks on it synchronously --
    // the same shape as a provider CLI shelling out to `git` and waiting.
    // No stdout is ever produced, so the inactivity timer is what tears
    // everything down while the outer process is still alive.
    const cmd = [
      `$psi = New-Object System.Diagnostics.ProcessStartInfo`,
      `$psi.FileName = 'powershell.exe'`,
      `$psi.Arguments = '-NoProfile -File "${heartbeatScriptPath.replace(/'/g, "''")}"'`,
      `$psi.UseShellExecute = $false`,
      `$psi.CreateNoWindow = $true`,
      `$p = [System.Diagnostics.Process]::Start($psi)`,
      `$p.WaitForExit()`,
    ].join('; ');

    const start = Date.now();
    await expect(strategy.execCommand(cmd, 800)).rejects.toThrow(/timed out/);
    // Sanity: the inactivity timeout (not the 30s Start-Sleep) is what ended this.
    expect(Date.now() - start).toBeLessThan(5000);

    // Let any in-flight heartbeat write land and the kill fully propagate,
    // then snapshot the file across two later, well-separated windows --
    // if the grandchild were still alive, it would keep growing every 100ms.
    await new Promise(r => setTimeout(r, 1000));
    const sizeAfterKill = fs.existsSync(heartbeatPath) ? fs.statSync(heartbeatPath).size : 0;
    await new Promise(r => setTimeout(r, 800));
    const sizeLater = fs.existsSync(heartbeatPath) ? fs.statSync(heartbeatPath).size : 0;

    expect(sizeLater).toBe(sizeAfterKill);
  }, 15000);
});
