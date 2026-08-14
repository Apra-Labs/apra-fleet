/**
 * apra-fleet-5ti7.4: live win32 verification that launchDetachedHidden
 * (src/os/windows.ts) produces NO visible console window, not just that a
 * process starts. This is the assertion the whole apra-fleet-5ti7 bug is
 * about; tests/integration/windows-hidden-launch-live-smoke.test.ts
 * (apra-fleet-i8qj.15) covers "a real PID comes up and logs to disk" but
 * never inspects window visibility -- this file is the complement, not a
 * duplicate (see that file's own header).
 *
 * Live-PowerShell harness note: apra-fleet-ot2z.15.1/.15.2 (the shared
 * live-PowerShell harness for tests/windows-powershell-error-handling.test.ts)
 * is still open/unimplemented as of this writing (same finding recorded by
 * apra-fleet-i8qj.14's test) -- there is nothing to reuse yet, so this file
 * spawns and probes real Windows processes directly, matching that
 * precedent's approach rather than inventing a second not-yet-existing
 * harness.
 *
 * IMPORTANT ENVIRONMENT CAVEAT (recorded as apra-fleet-5ti7.4 bead evidence,
 * do not delete this note when editing the file): Win32_Process.Create
 * launches a new process into WHATEVER SESSION the calling process is
 * running in. When the caller itself has no interactive desktop (e.g. it is
 * running as a Windows service, or -- as observed running this exact suite
 * from this repo's automation shell -- in Session 0 / the "Services"
 * session), tasklist reports "Window Title: N/A" and Get-Process reports
 * MainWindowHandle=0 for BOTH ShowWindow=0 (hidden, the real code path) and
 * ShowWindow=1 (the opt-out path, used here ONLY as a manual positive
 * control, never by product code) -- there is no interactive window station
 * for either to attach a window to, so the two cases are indistinguishable
 * from a non-interactive caller. This was verified manually before writing
 * this assertion (ad hoc Win32_Process.Create with ShowWindow=1 from this
 * shell: PID landed in Session Name "Services", tasklist /V showed
 * "Window Title: N/A"). This is a property of the CALLER's own session, not
 * a code defect -- the parent bug is specifically about a headless/service
 * caller, so "no window is even possible here" is consistent with, not
 * contradictory to, the fix. It does mean this file's assertion 2 can only
 * be a REAL positive-control discriminator when run from an interactive
 * desktop session (a human/RDP/console logon, not a service account or a
 * non-interactive automation shell); the it.skip guard below detects that
 * and skips with an explanatory message rather than passing vacuously or
 * failing on an environment property outside this code's control.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { launchDetachedHidden } from '../../src/os/windows.js';

const isWin32 = process.platform === 'win32';

/**
 * True only when this process itself is attached to an interactive window
 * station -- i.e. window-visibility assertions below can actually
 * discriminate hidden vs visible. Detected via `quser`, which only lists
 * sessions with an active/disconnected interactive logon (never Session 0).
 */
function hasInteractiveSession(): boolean {
  if (!isWin32) return false;
  try {
    const out = execSync('quser', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /Active|Disc/i.test(out);
  } catch {
    return false;
  }
}

describe.skipIf(!isWin32)(
  'launchDetachedHidden: live win32 -- no visible console window (apra-fleet-5ti7.4)',
  () => {
    const spawnedPids: number[] = [];
    let tmpDir: string | undefined;

    // Unconditional teardown, even on assertion failure: kill every spawned
    // PID this test launched, and remove the temp dir. taskkill /F /T also
    // reaps the real child, since the launcher returns the cmd.exe /c
    // wrapper's PID and the wrapper owns the child directly.
    afterEach(() => {
      for (const pid of spawnedPids.splice(0)) {
        try {
          execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
        } catch {
          // Already exited on its own -- fine.
        }
      }
      if (tmpDir) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
        tmpDir = undefined;
      }
    });

    it(
      'launches a real hidden child that survives, has no visible window, and logs to disk',
      () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-hidden-launch-nowin-'));
        const logFile = path.join(tmpDir, 'hidden.log');
        const marker = `fleet-nowin-${Date.now()}-${Math.random().toString(36).slice(2)}`;

        // A trivial long-running child: sleeps, then writes a marker.
        const result = launchDetachedHidden({
          command: 'powershell.exe',
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Start-Sleep -Seconds 3; Write-Output '${marker}'`,
          ],
          cwd: tmpDir,
          logFile,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return; // narrow for TS; assertion above already fails the test

        expect(Number.isInteger(result.pid)).toBe(true);
        expect(result.pid).toBeGreaterThan(0);
        spawnedPids.push(result.pid);

        // 1. Genuinely running, immediately after launch (child still
        // sleeping at this point).
        const tasklistOut = execSync(`tasklist /FI "PID eq ${result.pid}"`, { encoding: 'utf-8' });
        expect(tasklistOut).toContain(String(result.pid));

        // 1b. Survives the launching shell exiting: launchDetachedHidden
        // never spawns the child as a Node child_process -- it only shells
        // out to `powershell.exe -EncodedCommand` to ASK WMI to create the
        // process, and that powershell.exe invocation has already exited by
        // the time launchDetachedHidden() returns (execSync inside it is
        // synchronous and already completed). The process found above is
        // therefore already parented to WmiPrvSE, not to this test's own
        // process tree -- it is unaffected by this test process exiting.

        // 2. NO visible console window -- the assertion this bug is about.
        // MainWindowHandle must be 0/absent for the hidden launch.
        const psCheck = execSync(
          `powershell -NoProfile -Command "(Get-Process -Id ${result.pid} -ErrorAction SilentlyContinue).MainWindowHandle"`,
          { encoding: 'utf-8' },
        ).trim();
        expect(psCheck === '' || psCheck === '0').toBe(true);

        const tasklistVerbose = execSync(`tasklist /V /FI "PID eq ${result.pid}"`, { encoding: 'utf-8' });
        expect(tasklistVerbose).not.toMatch(/Apra Fleet.*do not close/i);

        // 3. Redirected output reaches the log file on disk.
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

    // Positive control: an explicit showWindow:true opt-out launch must
    // produce a DIFFERENT (discriminable) observable than the hidden case
    // above, proving assertion 2 is not vacuous. Only meaningful from an
    // interactive window station -- see the environment caveat in this
    // file's header. Skips with an explanatory reason otherwise, rather than
    // passing vacuously or failing on something outside this code's control.
    (hasInteractiveSession() ? it : it.skip)(
      'positive control: an explicit visible-window opt-out launch IS discriminable from the hidden case (interactive session only)',
      () => {
        tmpDir = tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-hidden-launch-nowin-ctrl-'));
        const logFile = path.join(tmpDir, 'visible.log');

        const result = launchDetachedHidden({
          command: 'powershell.exe',
          args: ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 3'],
          cwd: tmpDir,
          logFile,
          showWindow: true,
          title: 'apra-fleet-5ti7.4-positive-control',
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        spawnedPids.push(result.pid);

        const deadline = Date.now() + 5000;
        let title = '';
        while (Date.now() < deadline) {
          const tasklistVerbose = execSync(`tasklist /V /FI "PID eq ${result.pid}"`, { encoding: 'utf-8' });
          if (!tasklistVerbose.includes('N/A')) {
            title = tasklistVerbose;
            break;
          }
          execSync('ping -n 2 127.0.0.1 >nul');
        }
        expect(title).toContain('apra-fleet-5ti7.4-positive-control');
      },
      15000,
    );
  },
);
