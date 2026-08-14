/**
 * Windows-only smoke test for apra-fleet-i8qj.15: executes the REAL built
 * `launchDetachedHidden` command (src/os/windows.ts) against a trivial child
 * process, instead of stubbing the executor the way
 * tests/windows-hidden-launch-helper.test.ts does.
 *
 * tests/windows-hidden-launch-helper.test.ts passed 13/13 while
 * launchDetachedHidden failed on every real Windows invocation, because all
 * of its assertions inspect the emitted string through a stubbed executor.
 * This is the seam that would have caught the ProcessStartupInformation
 * "Type mismatch" regression: it runs the real
 * `powershell -EncodedCommand ...` -> WMI `Win32_Process.Create` pipeline,
 * asserts a live PID and the expected log contents, then kills the child.
 *
 * Skipped on non-Windows (Linux CI): the mechanism under test (WMI
 * Win32_Process.Create / Win32_ProcessStartup) only exists on Windows.
 * Complements, and does not replace, the live-verification task
 * apra-fleet-5ti7.4.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { launchDetachedHidden } from '../../src/os/windows.js';

describe.skipIf(process.platform !== 'win32')(
  'launchDetachedHidden: live smoke test against a real Windows child process (apra-fleet-i8qj.15)',
  () => {
    let tmpDir: string | undefined;
    let spawnedPid: number | undefined;

    afterEach(() => {
      if (spawnedPid) {
        try {
          execSync(`taskkill /F /T /PID ${spawnedPid}`, { stdio: 'ignore' });
        } catch {
          // Already exited on its own -- fine.
        }
        spawnedPid = undefined;
      }
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = undefined;
      }
    });

    it(
      'launches a real hidden child, returns a live PID, and the child writes the expected log output',
      () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-hidden-launch-smoke-'));
        const logFile = path.join(tmpDir, 'smoke.log');
        const marker = `fleet-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        // powershell.exe -Command takes the whole script as ONE quoted arg,
        // so it survives buildDetachedHiddenLaunchCommand's per-token
        // cmd-quoting without relying on shell metacharacters (&&, &) that
        // would otherwise need extra escaping through the nested cmd.exe /c
        // wrapper.
        const result = launchDetachedHidden({
          command: 'powershell.exe',
          args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Sleep -Seconds 2; Write-Output '${marker}'`],
          cwd: tmpDir,
          logFile,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return; // narrow for TS; the assertion above already fails the test

        expect(Number.isInteger(result.pid)).toBe(true);
        expect(result.pid).toBeGreaterThan(0);
        spawnedPid = result.pid;

        // The returned PID must be a real, live process right after launch
        // (the child sleeps 2s before writing, so it's still alive here).
        const tasklistOut = execSync(`tasklist /FI "PID eq ${result.pid}"`, { encoding: 'utf-8' });
        expect(tasklistOut).toContain(String(result.pid));

        // Bounded poll (not a sleep loop) for the child to finish writing.
        const deadline = Date.now() + 15000;
        let content = '';
        while (Date.now() < deadline) {
          if (fs.existsSync(logFile)) {
            content = fs.readFileSync(logFile, 'utf-8');
            if (content.includes(marker)) break;
          }
          execSync('ping -n 2 127.0.0.1 >nul'); // ~1s pause, no JS timers/sleep loop
        }

        expect(content).toContain(marker);
      },
      25000,
    );
  },
);
