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

  const setupFixture = (marker: string) => {
    fixtureDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qe83-3-hang-'));
    // The marker is embedded in the FIXTURE FILE NAME (not just an env var,
    // which node's own `node --test` per-file worker subprocess does not
    // echo back into its command line) -- node --test's default per-file
    // process isolation spawns a separate node process per test file with
    // that file's path as a literal argv entry, so this is what actually
    // makes the WORKER (not just the top `node --test` invocation) visible
    // to the process-table marker search below.
    fixtureFile = path.join(fixtureDir, `hang-forever-${marker}.test.mjs`);
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

  it('a hanging test file is killed by run-tests.mjs itself within its configured timeout, with no leftover worker process', async () => {
    const marker = `APRA_QE83_3_SE_STUB_${process.pid}_${Date.now()}`;
    setupFixture(marker);

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

    // The hanging worker really is alive shortly after spawn -- otherwise a
    // "killed within timeout" result would be indistinguishable from "never
    // actually ran". node --test's per-file process isolation means this is
    // proving the WORKER survives, not just the top run-tests.mjs process.
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(countMarkerProcesses(marker)).toBeGreaterThan(0);

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
    // The half that actually needs proving: no marker-matching process
    // outlives run-tests.mjs's own exit. A manual Win32_Process trace
    // confirmed the marker (embedded in the fixture file name) matches
    // THREE distinct pids pre-kill on this Windows box: run-tests.mjs
    // itself, its `node --test` child, and that child's own per-file worker
    // grandchild (three spawn levels) -- so this is a genuine multi-process
    // tree, not a single process matching its own argv.
    //
    // This assertion deliberately does NOT claim which kill path reaped
    // that tree -- a separate manual run with BOTH killTree() and
    // child.kill() turned into no-ops (the same APRA_TEST_SIMULATE_KILL_
    // FAILURE=1 hatch apra-fleet-qe83.4 below exercises) still left zero
    // marker matches after run-tests.mjs force-exited itself, so this
    // specific assertion is empirically non-discriminating on Windows: it
    // cannot tell "the explicit kill code reaped the tree" apart from "the
    // tree was reaped some other way when the owning process went away".
    // It is NOT safe to generalize that a non-detached descendant always
    // survives its owner's exit either -- apra-fleet-qe83.4's own case
    // below (`stillAliveAfterForcedExit` asserted `true`) is a stub spawned
    // straight from run-all-tests.mjs's shell:true (so cmd.exe sits
    // between it and the parent) that DOES survive the identical
    // simulated-failure force-exit, so the two cases behave differently for
    // reasons this test does not isolate. What this assertion does prove is
    // the acceptance-criteria-relevant outcome for THIS shape (run-tests.mjs
    // spawning node --test directly, no intervening shell): no leftover
    // process after a normal (non-simulated) timeout-triggered kill.
    expect(countMarkerProcesses(marker)).toBe(0);
  }, 9_000);
});

/**
 * apra-fleet-qe83.3.2 rework (reviewer round 2): `npm test --workspace=...`
 * as run by scripts/run-all-tests.mjs nests TWO detached POSIX spawns --
 * this outer runner's own child (the shell/npm process), then INSIDE that,
 * run-tests.mjs's own `node --test` child, spawned with its own
 * detached:true so run-tests.mjs's own killTree(-pid) can reach a
 * grandchild tree. That makes the innermost `node --test` process the
 * leader of a group disjoint from the outer runner's group, so the outer
 * runner's bare SIGKILL-the-group timeout path (pre-rework) reaped the
 * shell/npm/run-tests.mjs processes but orphaned the real hanging test
 * worker still holding this process's inherited stdio open -- reintroducing
 * the recorded 45-minute pipe-hold bug on POSIX. Windows has no such nested
 * group (nothing detaches there; taskkill /T walks the intact PPID tree), so
 * this is POSIX-only, exercised by driving run-all-tests.mjs at the REAL
 * run-tests.mjs script (not a stub) to reproduce the exact nesting shape.
 */
describe.skipIf(isWindows)('run-all-tests.mjs reaps a nested detached grandchild on POSIX (apra-fleet-qe83.3.2 rework)', () => {
  const sePkgRoot = path.join(repoRoot, 'packages', 'apra-fleet-se');
  const spawnedPids: number[] = [];
  let fixtureDir: string;
  let fixtureFile: string;

  afterEach(() => {
    for (const pid of spawnedPids.splice(0)) killTree(pid);
    if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('the se runner traps the outer SIGTERM and reaps its own detached node --test worker before the outer runner escalates to SIGKILL', async () => {
    const marker = `APRA_QE83_3_2_NESTED_${process.pid}_${Date.now()}`;
    fixtureDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qe83-3-2-nested-'));
    fixtureFile = path.join(fixtureDir, `hang-forever-${marker}.test.mjs`);
    fs.writeFileSync(
      fixtureFile,
      "import test from 'node:test';\n" +
      "test('never resolves', () => {\n" +
      "  setInterval(() => {}, 1000);\n" +
      "  return new Promise(() => {});\n" +
      "});\n"
    );

    // Give the NESTED run-tests.mjs invocation a much longer timeout
    // (10s) than the OUTER run-all-tests.mjs (1.5s) via an inline `env`
    // prefix -- this proves the outer runner's own SIGTERM cascade is what
    // reaps the grandchild, not the inner runner's own (much later) bound
    // firing first. `env` + a POSIX-only describe block avoids needing a
    // cross-platform env-injection mechanism through run-all-tests.mjs's
    // shell:true suite spawn.
    const runTestsPath = path.join(sePkgRoot, 'scripts', 'run-tests.mjs');
    const suites = JSON.stringify([
      {
        name: 'apra-fleet-se-nested',
        cmd: 'env',
        args: ['APRA_TEST_TIMEOUT_MS=10000', 'node', runTestsPath, 'mock', fixtureFile],
      },
    ]);

    const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'run-all-tests.mjs')], {
      cwd: repoRoot,
      env: {
        ...process.env,
        APRA_TEST_SUITES_JSON: suites,
        APRA_TEST_TIMEOUT_MS: '1500',
        APRA_TEST_SOFT_KILL_GRACE_MS: '1200',
      },
    });
    if (child.pid) spawnedPids.push(child.pid);

    let exited = false;
    const exitPromise = new Promise<void>(resolve => {
      child.on('exit', () => { exited = true; resolve(); });
    });

    // The nested worker really is alive shortly after spawn.
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(countMarkerProcesses(marker)).toBeGreaterThan(0);

    // Budget: outer timeout (1500) + soft-kill grace (1200) + kill latency,
    // well inside this outer race deadline and well BEFORE the inner
    // runner's own 10s bound could ever fire on its own.
    const timedOut = await Promise.race([
      exitPromise.then(() => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(true), 6_000)),
    ]);

    if (timedOut && child.pid) killTree(child.pid);
    // Capture the survivor count BEFORE the cleanup sweep below -- sweeping
    // first and then asserting on the post-sweep count would make this
    // assertion vacuous (it could never fail, fixed tree or not).
    const survivorsAfterRunnerExit = countMarkerProcesses(marker);
    killMarkerProcesses(marker); // best-effort cleanup, now that the proof above is captured

    expect(timedOut).toBe(false); // run-all-tests.mjs must have exited on its own
    expect(exited).toBe(true);
    // The half that actually needs proving: the DISJOINT nested process
    // group (the real node --test worker, two spawn levels deep) was
    // reaped too, not just the outer shell/npm/run-tests.mjs group.
    expect(survivorsAfterRunnerExit).toBe(0);
  }, 9_000);
});

/**
 * apra-fleet-qe83.3.2 rework (reviewer round 3): a SIGTERM delivered to
 * run-all-tests.mjs ITSELF (e.g. a supervisor's stall-kill of a hung `npm
 * test`, as opposed to the runner's own internal per-suite timeout exercised
 * above) used to leave a `terminating`-unaware suite loop free to launch the
 * NEXT suite once the group SIGTERM reaped the CURRENT suite well inside
 * SOFT_KILL_GRACE_MS -- the deferred hard-kill timer then fired against the
 * now-stale pid of the suite that already exited, never touching the suite
 * that had since started, orphaning its whole tree still holding this
 * process's inherited stdio open. POSIX-only: the Windows branch of
 * handleTerminatingSignal calls process.exit() synchronously before the
 * suite loop's `await` can ever resume, so it has no such window.
 */
describe.skipIf(isWindows)('run-all-tests.mjs does not launch the next suite after an outer SIGTERM (apra-fleet-qe83.3.2 rework)', () => {
  const spawnedPids: number[] = [];
  let hangScriptDir: string;

  afterEach(() => {
    for (const pid of spawnedPids.splice(0)) killTree(pid);
    if (hangScriptDir) fs.rmSync(hangScriptDir, { recursive: true, force: true });
  });

  it('a SIGTERM sent to the runner while suite 1 is running kills suite 1 and never starts suite 2', async () => {
    const marker1 = `APRA_QE83_3_2_SIGTERM_S1_${process.pid}_${Date.now()}`;
    const marker2 = `APRA_QE83_3_2_SIGTERM_S2_${process.pid}_${Date.now()}`;
    hangScriptDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qe83-3-2-sigterm-'));
    const file1 = path.join(hangScriptDir, `hang-forever-${marker1}.mjs`);
    const file2 = path.join(hangScriptDir, `hang-forever-${marker2}.mjs`);
    fs.writeFileSync(file1, 'setInterval(function () {}, 1000);\n');
    fs.writeFileSync(file2, 'setInterval(function () {}, 1000);\n');

    // A generous per-suite timeout (30s) so the runner's OWN timeout path
    // never fires during this test -- only the externally-delivered SIGTERM
    // below should end suite 1, which is the exact path the bug was in.
    const suites = JSON.stringify([
      { name: 'suite-1', cmd: 'node', args: [file1] },
      { name: 'suite-2', cmd: 'node', args: [file2] },
    ]);

    const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'run-all-tests.mjs')], {
      cwd: repoRoot,
      env: {
        ...process.env,
        APRA_TEST_SUITES_JSON: suites,
        APRA_TEST_TIMEOUT_MS: '30000',
        APRA_TEST_SOFT_KILL_GRACE_MS: '1200',
      },
    });
    if (child.pid) spawnedPids.push(child.pid);

    let exitCode: number | null = null;
    const exitPromise = new Promise<void>(resolve => {
      child.on('exit', (code) => { exitCode = code; resolve(); });
    });

    // Suite 1 really is alive before the signal is sent.
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(countMarkerProcesses(marker1)).toBeGreaterThan(0);

    child.kill('SIGTERM');

    const timedOut = await Promise.race([
      exitPromise.then(() => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(true), 6_000)),
    ]);

    // A short extra wait past the runner's own exit: if the pre-fix bug
    // regressed, suite 2 would be launched by the suite loop BEFORE the
    // deferred hard-kill timer fires, so it could still be starting up right
    // around when the runner process itself exits.
    await new Promise(resolve => setTimeout(resolve, 500));

    const survivorsSuite1 = countMarkerProcesses(marker1);
    const survivorsSuite2 = countMarkerProcesses(marker2);
    if (timedOut && child.pid) killTree(child.pid);
    killMarkerProcesses(marker1);
    killMarkerProcesses(marker2);

    expect(timedOut).toBe(false); // run-all-tests.mjs must have exited on its own
    expect(exitCode).not.toBe(0);
    expect(survivorsSuite1).toBe(0); // suite 1's tree was reaped by the SIGTERM cascade
    expect(survivorsSuite2).toBe(0); // suite 2 must NEVER have been launched
  }, 9_000);

  /**
   * apra-fleet-qe83.3.5.2: the case immediately above exercises ordering (a)
   * -- suite 1 has no SIGTERM trap of its own, so the group SIGTERM broadcast
   * in handleTerminatingSignal() reaps it almost immediately, well before the
   * deferred hard-kill timer (SOFT_KILL_GRACE_MS) ever fires. That leaves
   * ordering (b) -- the deferred timer firing FIRST because suite 1 ignores
   * the SIGTERM broadcast -- entirely uncovered by this file: the timer's own
   * setTimeout callback (scripts/run-all-tests.mjs, inside
   * handleTerminatingSignal) calls process.exit(1) directly, so this ordering
   * never reaches the trailing `process.exit(failed || terminating ? 1 : 0)`
   * line that apra-fleet-qe83.3.5.1 fixed -- but nothing was proving that
   * path exits non-zero, tree-kills suite 1, and still never launches suite 2
   * either. Suite 1 here traps and swallows SIGTERM (SIGKILL, sent by the
   * hard-kill path, cannot be ignored), which forces this ordering.
   */
  it('a SIGTERM sent to the runner while suite 1 ignores it is reaped by the deferred hard-kill timer, and suite 2 is never started', async () => {
    const marker1 = `APRA_QE83_3_5_2_TIMERFIRST_S1_${process.pid}_${Date.now()}`;
    const marker2 = `APRA_QE83_3_5_2_TIMERFIRST_S2_${process.pid}_${Date.now()}`;
    hangScriptDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'qe83-3-5-2-timerfirst-'));
    const file1 = path.join(hangScriptDir, `ignore-sigterm-${marker1}.mjs`);
    const file2 = path.join(hangScriptDir, `hang-forever-${marker2}.mjs`);
    // Ignoring SIGTERM (instead of letting the default action terminate it)
    // means the group SIGTERM broadcast below cannot reap suite 1 -- only
    // the deferred hard-kill timer's SIGKILL can.
    fs.writeFileSync(file1, "process.on('SIGTERM', () => {});\nsetInterval(function () {}, 1000);\n");
    fs.writeFileSync(file2, 'setInterval(function () {}, 1000);\n');

    // A short soft-kill grace window so the timer-fires-first path resolves
    // quickly, and a per-suite timeout generous enough that the runner's own
    // timeout never fires during this test -- only the externally-delivered
    // SIGTERM should end suite 1.
    const suites = JSON.stringify([
      { name: 'suite-1', cmd: 'node', args: [file1] },
      { name: 'suite-2', cmd: 'node', args: [file2] },
    ]);

    const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'run-all-tests.mjs')], {
      cwd: repoRoot,
      env: {
        ...process.env,
        APRA_TEST_SUITES_JSON: suites,
        APRA_TEST_TIMEOUT_MS: '30000',
        APRA_TEST_SOFT_KILL_GRACE_MS: '800',
      },
    });
    if (child.pid) spawnedPids.push(child.pid);

    let exitCode: number | null = null;
    const exitPromise = new Promise<void>(resolve => {
      child.on('exit', (code) => { exitCode = code; resolve(); });
    });

    // Suite 1 really is alive (and has installed its SIGTERM trap) before
    // the signal is sent.
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(countMarkerProcesses(marker1)).toBeGreaterThan(0);

    child.kill('SIGTERM');

    const timedOut = await Promise.race([
      exitPromise.then(() => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(true), 6_000)),
    ]);

    // A short extra wait past the runner's own exit: if the suite loop ever
    // regressed to launch suite 2 before the deferred timer's tree-kill
    // reached suite 1, suite 2 could still be starting up right around when
    // the runner process itself exits.
    await new Promise(resolve => setTimeout(resolve, 500));

    const survivorsSuite1 = countMarkerProcesses(marker1);
    const survivorsSuite2 = countMarkerProcesses(marker2);
    if (timedOut && child.pid) killTree(child.pid);
    killMarkerProcesses(marker1);
    killMarkerProcesses(marker2);

    expect(timedOut).toBe(false); // run-all-tests.mjs must have exited on its own
    expect(exitCode).not.toBe(0);
    expect(survivorsSuite1).toBe(0); // suite 1's tree was reaped by the deferred hard-kill timer
    expect(survivorsSuite2).toBe(0); // suite 2 must NEVER have been launched
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
