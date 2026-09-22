import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * apra-fleet-qe83.3: proves both scripts/run-all-tests.mjs and
 * packages/apra-fleet-se/scripts/run-tests.mjs are bounded by a wall-clock
 * timeout, so a suite whose child never exits (a real vitest run that hung
 * on Windows, per the recorded bug) can no longer hold `npm test` open
 * forever.
 *
 * apra-fleet-qe83.3.1 introduced this file pinning the PRE-fix behaviour
 * (neither script had any timeout of its own, so the TEST's own harness
 * deadline had to notice the hang and kill the whole child tree itself).
 * apra-fleet-qe83.3.2 wired the actual bound into both scripts, so these
 * cases now assert the runner kills its own stub within
 * APRA_TEST_TIMEOUT_MS, with no harness-level intervention required.
 *
 * Uses a deterministic, fast stub suite (a bare keep-alive script) instead
 * of the real multi-minute suites, injected via APRA_TEST_SUITES_JSON /
 * APRA_TEST_TIMEOUT_MS, so the whole test completes in well under 10s.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';

/** Kills the whole descendant tree rooted at `pid`, best-effort. */
function killTree(pid: number): void {
  if (!pid) return;
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone, or never got its own process group -- fall back to a
      // direct kill of just the pid we have.
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}

/**
 * Counts live processes whose command line contains `marker` -- used to
 * prove a killed stub process (and any of its own children) does not
 * survive the test, per this task's "leaves no stray node process (tasklist
 * or ps check in afterEach)" acceptance criterion. Best-effort: any failure
 * to query the process table is treated as "0 found" rather than failing
 * the test on an environment where the query tool itself is unavailable.
 */
function countMarkerProcesses(marker: string): number {
  try {
    if (isWindows) {
      // -ne $PID excludes THIS powershell query's own process -- its
      // command line necessarily contains `marker` too (it is the -Command
      // argument doing the matching), which would otherwise always count
      // itself as one live match and the post-kill assertion could never
      // observe 0.
      const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.ProcessId -ne $PID } | Measure-Object | Select-Object -ExpandProperty Count`;
      const result = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
      const n = Number((result.stdout ?? '').trim());
      return Number.isFinite(n) ? n : 0;
    }
    const result = spawnSync('sh', ['-c', `ps -eo pid,args | grep -F '${marker}' | grep -v grep | wc -l`], { encoding: 'utf8' });
    const n = Number((result.stdout ?? '').trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Force-kills every live process whose command line contains `marker`,
 * best-effort. Needed by the qe83.4 forced-exit reproduction below: once
 * run-all-tests.mjs force-exits itself (the very thing under test), the
 * grandchild stub process it could not reap is orphaned under a pid this
 * test never had -- killing the wrapper's own (already-exited) pid does
 * nothing for it, so cleanup must find it by marker instead.
 */
function killMarkerProcesses(marker: string): void {
  try {
    if (isWindows) {
      const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      spawnSync('powershell', ['-NoProfile', '-Command', script]);
    } else {
      spawnSync('sh', ['-c', `ps -eo pid,args | grep -F '${marker}' | grep -v grep | awk '{print $1}' | xargs -r kill -9`]);
    }
  } catch {
    // Best-effort only.
  }
}

/** Unique-per-test-run marker embedded in the stub command line so the
 *  process-table check above never confuses this test's own stub process
 *  with an unrelated node process already running on the machine. */
function makeMarker(): string {
  return `APRA_QE83_3_STUB_${process.pid}_${Date.now()}`;
}

describe('run-all-tests.mjs wall-clock bound (apra-fleet-qe83.3)', () => {
  const spawnedPids: number[] = [];
  let hangScriptDir: string;
  let hangScriptFile: string;

  afterEach(() => {
    // Best-effort cleanup in case an assertion threw before the test's own
    // kill ran -- must never leave a stub process behind for a later test.
    for (const pid of spawnedPids.splice(0)) killTree(pid);
    if (hangScriptDir) fs.rmSync(hangScriptDir, { recursive: true, force: true });
  });

  it('a stub suite that never exits is killed by run-all-tests.mjs itself within its configured timeout, with no leftover process', async () => {
    const marker = makeMarker();
    // A fixture FILE, not an inline `-e` string: run-all-tests.mjs always
    // spawns with shell:true (required for npm.cmd on Windows), and
    // shell:true joins the args array into a single command line with plain
    // spaces -- an inline arrow-function/parens script breaks apart under
    // that naive join. A bare file path has no such problem on any shell.
    hangScriptDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qe83-3-hang-'));
    hangScriptFile = path.join(hangScriptDir, `hang-forever-${marker}.mjs`);
    fs.writeFileSync(hangScriptFile, 'setInterval(function () {}, 1000);\n');

    // 'node' (bare command, resolved via PATH), not process.execPath: the
    // suite's cmd/args are joined into a single command-line string by
    // run-all-tests.mjs's own shell:true spawn, with no quoting of embedded
    // spaces -- process.execPath contains one on a stock Windows install
    // (e.g. "C:\Program Files\nodejs\node.exe"), which breaks apart under
    // that naive join exactly like the parenthesized inline script did.
    const suites = JSON.stringify([
      { name: 'hang-forever', cmd: 'node', args: [hangScriptFile] },
    ]);

    const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'run-all-tests.mjs')], {
      cwd: repoRoot,
      env: { ...process.env, APRA_TEST_SUITES_JSON: suites, APRA_TEST_TIMEOUT_MS: '1500' },
    });
    if (child.pid) spawnedPids.push(child.pid);

    let exitCode: number | null = null;
    const exitPromise = new Promise<void>(resolve => {
      child.on('exit', (code) => { exitCode = code; resolve(); });
    });

    // The stub really is alive shortly after spawn -- otherwise a "killed
    // within timeout" result would be indistinguishable from "never
    // actually ran".
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(countMarkerProcesses(marker)).toBeGreaterThan(0);

    // Race the runner's own exit against a generous outer deadline (well
    // past APRA_TEST_TIMEOUT_MS=1500, to leave headroom for process-table
    // scans/taskkill) -- this must resolve via the runner exiting on its
    // own, not the outer deadline, or the fix regressed.
    const timedOut = await Promise.race([
      exitPromise.then(() => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(true), 6_000)),
    ]);

    if (timedOut) {
      // Safety net only -- must never be needed once the fix holds.
      if (child.pid) killTree(child.pid);
    }

    expect(timedOut).toBe(false); // run-all-tests.mjs must have exited on its own
    expect(exitCode).not.toBe(0); // the timed-out suite counts as a failure
    // No harness-level kill was needed (the branch above did not run) --
    // the runner's own taskkill/process-group cleanup must have already
    // reaped the stub.
    expect(countMarkerProcesses(marker)).toBe(0);
  }, 9_000);

  it('the suite list falls back to the real default suites when APRA_TEST_SUITES_JSON is unset (source inspection)', () => {
    // A behavioural spawn of the real default suites would take minutes;
    // instead assert the source directly reads the env var as an override
    // with the two real suites remaining the fallback, which is the
    // documented, cheap way this project's own tests already ratchet such
    // "does script X still call script Y" invariants.
    const src = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-all-tests.mjs'), 'utf8');
    expect(src).toContain('APRA_TEST_SUITES_JSON');
    expect(src).toContain("'vitest'");
    expect(src).toContain('apra-fleet-se');
  });
});

/**
 * apra-fleet-qe83.3: the sibling runner in the apra-fleet-se workspace has
 * the exact same shape of bug -- packages/apra-fleet-se/scripts/run-tests.mjs
 * spawns `node --test ...` and (pre apra-fleet-qe83.3.2) had no timeout of
 * its own. It already supports pointing at an arbitrary test file via its
 * existing extraArgs passthrough (no reproduction-specific script change
 * needed), so this drives it at a tiny fixture test that never resolves.
 */
describe('apra-fleet-se scripts/run-tests.mjs wall-clock bound (apra-fleet-qe83.3)', () => {
  const sePkgRoot = path.join(repoRoot, 'packages', 'apra-fleet-se');
  let fixtureDir: string;
  let fixtureFile: string;
  const spawnedPids: number[] = [];

  const setupFixture = () => {
    fixtureDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qe83-3-hang-'));
    fixtureFile = path.join(fixtureDir, 'hang-forever.test.mjs');
    // A bare `new Promise(() => {})` is NOT enough to reproduce a hang here:
    // node:test's own runner notices the event loop has gone idle with
    // nothing else keeping it alive and cancels the test itself ("Promise
    // resolution is still pending but the event loop has already
    // resolved"). A keep-alive timer alongside the never-resolving promise
    // is what actually reproduces the real bug shape (a suite whose child
    // process never exits).
    fs.writeFileSync(
      fixtureFile,
      "import test from 'node:test';\n" +
      "test('never resolves', () => {\n" +
      "  setInterval(() => {}, 1000);\n" +
      "  return new Promise(() => {});\n" +
      "});\n"
    );
  };

  const cleanupFixture = () => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  };

  afterEach(() => {
    for (const pid of spawnedPids.splice(0)) killTree(pid);
    if (fixtureDir) cleanupFixture();
  });

  it('a hanging test file is killed by run-tests.mjs itself within its configured timeout', async () => {
    setupFixture();

    const child = spawn(process.execPath, [
      path.join(sePkgRoot, 'scripts', 'run-tests.mjs'),
      'mock',
      fixtureFile,
    ], {
      cwd: sePkgRoot,
      env: { ...process.env, APRA_TEST_TIMEOUT_MS: '1500' },
    });
    if (child.pid) spawnedPids.push(child.pid);

    let exitCode: number | null = null;
    const exitPromise = new Promise<void>(resolve => {
      child.on('exit', (code) => { exitCode = code; resolve(); });
    });

    const timedOut = await Promise.race([
      exitPromise.then(() => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(true), 6_000)),
    ]);

    if (timedOut) {
      // Safety net only -- must never be needed once the fix holds.
      if (child.pid) killTree(child.pid);
    }

    expect(timedOut).toBe(false); // run-tests.mjs must have exited on its own
    expect(exitCode).not.toBe(0); // the timed-out run counts as a failure
  }, 9_000);
});

/**
 * apra-fleet-qe83.4: killTree (and now the belt-and-braces child.kill()
 * alongside it) is best-effort -- if taskkill is unavailable/denied, or the
 * POSIX group kill fails for both -pid and pid, no 'exit' event ever fires
 * and the runner's own timeout promise never settles, hanging forever (the
 * exact failure the bound exists to remove). Both runners expose a test-only
 * APRA_TEST_SIMULATE_KILL_FAILURE=1 escape hatch that turns killTree()/
 * child.kill() into no-ops, letting this reproduce that failure mode
 * deterministically (SIGKILL itself cannot be ignored on POSIX, so a real
 * unkillable process is not obtainable) and prove the secondary force-exit
 * timer still makes the runner exit on its own.
 */
describe('run-all-tests.mjs forces its own exit when the kill path fails (apra-fleet-qe83.4)', () => {
  const spawnedPids: number[] = [];
  const markers: string[] = [];
  let hangScriptDir: string;
  let hangScriptFile: string;

  afterEach(() => {
    for (const pid of spawnedPids.splice(0)) killTree(pid);
    // The simulated-kill-failure scenario deliberately leaves the grandchild
    // stub alive and orphaned (see killMarkerProcesses' doc comment) -- pid
    // cleanup above cannot reach it, so sweep by marker too.
    for (const marker of markers.splice(0)) killMarkerProcesses(marker);
    if (hangScriptDir) fs.rmSync(hangScriptDir, { recursive: true, force: true });
  });

  it('exits on its own via the forced-exit branch when killTree/child.kill are stubbed into no-ops', async () => {
    const marker = makeMarker();
    markers.push(marker);
    hangScriptDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qe83-4-hang-'));
    hangScriptFile = path.join(hangScriptDir, `hang-forever-${marker}.mjs`);
    fs.writeFileSync(hangScriptFile, 'setInterval(function () {}, 1000);\n');

    const suites = JSON.stringify([
      { name: 'hang-forever', cmd: 'node', args: [hangScriptFile] },
    ]);

    const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'run-all-tests.mjs')], {
      cwd: repoRoot,
      env: {
        ...process.env,
        APRA_TEST_SUITES_JSON: suites,
        APRA_TEST_TIMEOUT_MS: '1000',
        APRA_TEST_SIMULATE_KILL_FAILURE: '1',
        APRA_TEST_FORCE_EXIT_GRACE_MS: '1000',
      },
    });
    if (child.pid) spawnedPids.push(child.pid);

    let exitCode: number | null = null;
    const exitPromise = new Promise<void>(resolve => {
      child.on('exit', (code) => { exitCode = code; resolve(); });
    });

    // Runner's own timeout (1000ms) + forced-exit grace (1000ms) should fire
    // well inside this outer deadline. If the forced-exit branch regressed,
    // this races the outer deadline instead and the test fails loudly rather
    // than hanging (vitest's own test timeout below is the final backstop).
    const timedOut = await Promise.race([
      exitPromise.then(() => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(true), 6_000)),
    ]);

    // The stub process is never actually killed here (that is the whole
    // point of the simulated failure) -- confirm it really is still alive
    // (proving the forced exit above happened despite the kill failing, not
    // because the kill secretly succeeded), then sweep it up by marker so it
    // does not leak past this test.
    const stillAliveAfterForcedExit = countMarkerProcesses(marker) > 0;
    killMarkerProcesses(marker);

    expect(timedOut).toBe(false); // run-all-tests.mjs must force-exit on its own
    expect(exitCode).toBe(1); // the forced-exit branch calls process.exit(1)
    expect(stillAliveAfterForcedExit).toBe(true); // kill really did fail; forced exit is what saved us
    expect(countMarkerProcesses(marker)).toBe(0); // cleanup swept the orphaned stub
  }, 9_000);
});
