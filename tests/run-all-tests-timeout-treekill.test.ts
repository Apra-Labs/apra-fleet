/**
 * Regression test for my-beads-db-0cd.21 (falsifies my-beads-db-0cd.16 if
 * reverted): scripts/run-all-tests.mjs's timeout must kill the WHOLE process
 * tree it spawned, not just the immediate child.
 *
 * The old code was `spawnSync(suite.cmd, suite.args, { shell: true, timeout,
 * killSignal: 'SIGKILL' })`. On win32 that signal only reaches the immediate
 * spawned process (cmd.exe, because shell:true) -- it does not recurse to
 * npm/vitest workers or anything they spawn. This test drives the real
 * timeout path with a fixture that plays the role of a hung suite: it
 * spawns its own grandchild (same process group -- see the fixture's own
 * comment for why it must NOT be detached), records both pids, then idles
 * forever.
 * A shim `npm`/`npm.cmd` placed first on PATH runs the fixture instead of
 * the real npm, so no real suite is ever invoked.
 *
 * FALSIFIABILITY: revert scripts/run-all-tests.mjs's killProcessTree to the
 * bare `spawnSync(..., { timeout, killSignal: 'SIGKILL' })` shape and this
 * test fails on win32 -- the fixture and its grandchild survive the kill.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const RUN_ALL_TESTS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'run-all-tests.mjs');
const FIXTURE_SCRIPT = path.join(__dirname, 'fixtures', 'run-all-tests-treekill-fixture.mjs');

function isPidAlive(pid: number): boolean {
    if (process.platform === 'win32') {
        const result = spawnSync(
            'tasklist',
            ['/FI', `PID eq ${pid}`, '/NH'],
            { encoding: 'utf8' },
        );
        return (result.stdout || '').includes(String(pid));
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ESRCH') {
            return false;
        }
        // Any other error (e.g. EPERM for a pid owned by someone else) means
        // we can't conclude it's gone -- treat as still alive so the test
        // fails loudly instead of passing on a bad assumption.
        return true;
    }
}

function killIfAlive(pid: number): void {
    if (!pid) return;
    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
            process.kill(pid, 'SIGKILL');
        }
    } catch {
        // Already gone -- nothing to do.
    }
}

// my-beads-db-0cd.21 (reopened): scripts/run-all-tests.mjs writes each
// suite's full log to os.tmpdir()/apra-fleet-tests-<suiteName>-<pid>.log
// (its OWN pid, i.e. the pid of the nested run-all-tests.mjs process this
// test spawns below) -- deliberately outside any tmpDir it's handed, since
// that is the runner's real log location, not a location this test controls.
// The bead's own criterion is "no files outside the test temp dir", so this
// test must clean those two files up itself once it has the pid.
const RUN_ALL_TESTS_LOG_SUITE_NAMES = ['vitest', 'apra-fleet-se'];

function runAllTestsLogPaths(pid: number): string[] {
    return RUN_ALL_TESTS_LOG_SUITE_NAMES.map((name) =>
        path.join(os.tmpdir(), `apra-fleet-tests-${name}-${pid}.log`),
    );
}

describe('run-all-tests.mjs: timeout kills the whole process tree (my-beads-db-0cd.21)', () => {
    let tmpDir: string;
    let binDir: string;
    let pidFile: string;
    let runnerPid: number | undefined;

    beforeEach(() => {
        tmpDir = path.join(os.tmpdir(), `fleet-test-0cd21-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        binDir = path.join(tmpDir, 'bin');
        fs.mkdirSync(binDir, { recursive: true });
        pidFile = path.join(tmpDir, 'pids.jsonl');
        runnerPid = undefined;

        // Shim npm/npm.cmd: ignores its args and runs the fixture instead,
        // so run-all-tests.mjs never invokes the real vitest/apra-fleet-se
        // suites. The fixture path travels via env var, not a baked-in path,
        // so the shim itself stays trivial.
        if (process.platform === 'win32') {
            fs.writeFileSync(path.join(binDir, 'npm.cmd'), '@echo off\r\nnode "%FIXTURE_PATH%"\r\n');
        } else {
            const shimPath = path.join(binDir, 'npm');
            fs.writeFileSync(shimPath, '#!/bin/sh\nexec node "$FIXTURE_PATH"\n');
            fs.chmodSync(shimPath, 0o755);
        }
    });

    afterEach(async () => {
        // Best-effort: kill any survivors so a failing run (e.g. the
        // falsifying revert) doesn't leak real processes into the host.
        if (fs.existsSync(pidFile)) {
            const lines = fs.readFileSync(pidFile, 'utf8').split('\n').filter(Boolean);
            for (const line of lines) {
                try {
                    const { childPid, grandchildPid } = JSON.parse(line);
                    killIfAlive(childPid);
                    killIfAlive(grandchildPid);
                } catch {
                    // malformed line -- nothing to clean up from it
                }
            }
        }

        // Clean up the nested runner's own log files -- see the comment above
        // runAllTestsLogPaths for why these land outside tmpDir.
        if (runnerPid !== undefined) {
            for (const logPath of runAllTestsLogPaths(runnerPid)) {
                fs.rmSync(logPath, { force: true });
            }
        }

        for (let attempt = 0; attempt < 10; attempt++) {
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
                return;
            } catch {
                await new Promise((r) => setTimeout(r, 300));
            }
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }, 15000);

    it('leaves no descendant process alive after a suite times out, and still reports failure', async () => {
        const env = {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
            FIXTURE_PATH: FIXTURE_SCRIPT,
            RUN_ALL_TESTS_TEST_PIDFILE: pidFile,
            APRA_FLEET_TEST_TIMEOUT_MS: '1500',
        };

        const exitCode: number | null = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [RUN_ALL_TESTS_SCRIPT], {
                cwd: REPO_ROOT,
                env,
                stdio: 'ignore',
            });
            runnerPid = child.pid;
            child.on('error', reject);
            child.on('exit', (code) => resolve(code));
        });

        // The kill must not mask the timeout as success.
        expect(exitCode).toBe(1);

        // Give the OS a brief moment to finish bookkeeping the terminations
        // (killProcessTree's taskkill/-pid kill already blocks until done,
        // this is just slack for tasklist's own cache on win32).
        await new Promise((r) => setTimeout(r, 300));

        expect(fs.existsSync(pidFile)).toBe(true);
        const lines = fs.readFileSync(pidFile, 'utf8').split('\n').filter(Boolean);
        // One line per suite that reached the fixture before timing out.
        expect(lines.length).toBeGreaterThanOrEqual(1);

        for (const line of lines) {
            const { childPid, grandchildPid } = JSON.parse(line) as { childPid: number; grandchildPid: number };
            expect(isPidAlive(childPid)).toBe(false);
            expect(isPidAlive(grandchildPid)).toBe(false);
        }
    }, 30000);
});
