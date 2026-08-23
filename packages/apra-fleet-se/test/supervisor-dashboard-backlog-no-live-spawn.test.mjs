// apra-fleet-7h6n.8: verification for apra-fleet-7h6n.1 -- confirms
// supervisor-dashboard.test.mjs and supervisor-backlog.test.mjs no longer
// spawn a live `bd`/`git` subprocess from their mocked fixtures.
//
// apra-fleet-7h6n.1's fixture fix (commit c632e371) added
// `listAllBeads: async () => []` / `driftCheck: async () => null` seams to
// every fixture that omitted them, since createDashboard()/createBacklog()
// default those two seams to REAL subprocess calls (bdListAllBeads() ->
// `bd list --json --limit 0`; computeBaseDrift() -> `git rev-list --count`).
// Before that fix, every one of those fixtures silently shelled out to the
// live dev DB/repo on every buildSprintViews()/renderIndexPage() call.
//
// This test proves the fix holds (and will catch a regression) by actually
// running both target files as `node --test` CHILD PROCESSES with `bd` and
// `git` shimmed on PATH to marker scripts, rather than by patching
// `node:child_process` in-process: `exec-bd.mjs` (the shared helper
// backlog.mjs/scope-overlap.mjs route through) captures its own
// `execFile`/`execFileSync` references via a named import at module-eval
// time, and empirically mutating `child_process.execFile` afterward from a
// sibling module does NOT redirect that already-bound reference -- only an
// OS-level PATH shim reliably intercepts every invocation shape
// (execFile/execFileSync, `{ shell: true }` or not) regardless of which
// helper or call style is used internally.
//
// POSIX-only (bash-based marker scripts) -- gated behind `process.platform
// !== 'win32'`, matching the existing precedent in
// supervisor-dolt-orphan-sweep.test.mjs for bash-dependent subprocess checks.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');

/**
 * Builds a directory containing fake `bd` and `git` executables that append
 * their own invocation (argv) to `markerFile` and exit 0 -- so any fixture
 * that still shells out to the real `bd`/`git` leaves a trace, without
 * actually touching the live dev DB/repo.
 * @param {string} markerFile
 * @returns {string} the directory to prepend to PATH
 */
function makeFakeBinDir(markerFile) {
    const dir = mkdtempSync(path.join(tmpdir(), 'fake-bd-git-'));
    const body = '#!/usr/bin/env bash\n'
        + `echo "$(basename "$0") $*" >> ${JSON.stringify(markerFile)}\n`
        // `bd list --json ...` output must parse as JSON in case anything
        // downstream ever reads it -- an empty array is a safe, harmless stub.
        + 'echo "[]"\n'
        + 'exit 0\n';
    for (const name of ['bd', 'git']) {
        const p = path.join(dir, name);
        writeFileSync(p, body);
        chmodSync(p, 0o755);
    }
    return dir;
}

/**
 * Runs `node --test <files>` as a child process with the given env, and
 * resolves with its exit code, captured output, and wall-clock duration.
 * @param {string[]} files
 * @param {NodeJS.ProcessEnv} env
 */
function runNodeTest(files, env) {
    return new Promise((resolve, reject) => {
        const start = process.hrtime.bigint();
        // NODE_TEST_CONTEXT (set by the OUTER `node --test` run that executes
        // this very file, e.g. `child-v8`) must NOT be inherited by this
        // nested `node --test` child: with it present, the child silently
        // treats itself as a reporter-driven grandchild of the outer run and
        // exits almost immediately without actually executing either target
        // file (empirically: exit 0, ~25ms, zero tests run) -- which would
        // make this whole check vacuously pass. Stripping it restores normal
        // standalone `node --test` behavior for the nested process.
        const childEnv = { ...env };
        delete childEnv.NODE_TEST_CONTEXT;
        const child = spawn(process.execPath, ['--test', ...files], {
            cwd: packageRoot,
            env: childEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', reject);
        child.on('close', (code) => {
            const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
            resolve({ code, stdout, stderr, elapsedMs });
        });
    });
}

describe('apra-fleet-7h6n.8: supervisor-dashboard/backlog mocked fixtures spawn no live bd/git', () => {
    test(
        'both files pass under a bd/git PATH spawn-spy, spawn nothing, and run well under the pre-fix ~12s baseline',
        { skip: process.platform === 'win32' ? 'POSIX-only bash marker scripts' : false },
        async (t) => {
            const markerDir = mkdtempSync(path.join(tmpdir(), 'spawn-marker-'));
            const markerFile = path.join(markerDir, 'spawns.log');
            const fakeBinDir = makeFakeBinDir(markerFile);
            // Both mkdtempSync() dirs above are scratch state under the OS temp
            // root, outside this repo -- clean them up regardless of pass/fail
            // so repeated runs don't accumulate `fake-bd-git-*`/`spawn-marker-*`
            // leftovers there.
            t.after(() => {
                rmSync(fakeBinDir, { recursive: true, force: true });
                rmSync(markerDir, { recursive: true, force: true });
            });
            const env = { ...process.env, PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}` };
            const files = ['test/supervisor-dashboard.test.mjs', 'test/supervisor-backlog.test.mjs'];

            const { code, stdout, stderr, elapsedMs } = await runNodeTest(files, env);

            assert.equal(
                code,
                0,
                `both test files must still pass with bd/git shimmed on PATH (proves no fixture needs a REAL bd/git to pass)\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            );

            const spawnedLive = existsSync(markerFile) ? readFileSync(markerFile, 'utf-8') : '';
            assert.equal(
                spawnedLive,
                '',
                `no fixture that injects listAllBeads/driftCheck may spawn a live bd/git subprocess; observed invocation(s):\n${spawnedLive}`,
            );

            // Pre-fix (apra-fleet-7h6n.1's parent commit c632e371 message):
            // combined wall time for both files dropped from ~6.9s (real bd/git
            // spawns) to ~0.2s once the fixtures were stubbed; the standalone
            // supervisor-backlog.test.mjs baseline this bead cites is ~12s. 5s
            // leaves generous headroom for a slow CI host while still failing
            // hard if a live spawn regresses back in.
            assert.ok(
                elapsedMs < 5000,
                `expected combined runtime well under the pre-fix live-spawn baseline, got ${elapsedMs.toFixed(0)}ms`,
            );

            // Belt-and-suspenders: exit 0 + an empty marker file + a fast
            // runtime are ALSO exactly what a vacuous nested run (zero tests
            // actually executed) would produce -- today that's prevented
            // solely by stripping NODE_TEST_CONTEXT above. Parse the child's
            // TAP summary directly so a regression that reintroduces the
            // vacuous-run condition fails loudly here instead of silently
            // passing.
            const testsMatch = stdout.match(/^# tests (\d+)$/m);
            const passMatch = stdout.match(/^# pass (\d+)$/m);
            assert.ok(
                testsMatch && passMatch,
                `expected the child's TAP summary to include "# tests N" and "# pass N" lines\nstdout:\n${stdout}`,
            );
            const testsRun = Number(testsMatch[1]);
            const testsPassed = Number(passMatch[1]);
            // Combined current count (2026-08-23) is 86 (49 dashboard + 37
            // backlog); 40 leaves generous headroom for tests removed/merged
            // over time while still failing hard on a vacuous zero-test run.
            const KNOWN_MINIMUM_TESTS = 40;
            assert.ok(
                testsRun >= KNOWN_MINIMUM_TESTS,
                `expected the nested run to actually execute at least ${KNOWN_MINIMUM_TESTS} tests across both files (got ${testsRun}) -- a low/zero count means the child silently no-op'd instead of running\nstdout:\n${stdout}`,
            );
            assert.equal(
                testsPassed,
                testsRun,
                `expected every executed test to pass (${testsPassed}/${testsRun})\nstdout:\n${stdout}`,
            );

            t.diagnostic(`combined wall-clock time for both files under the bd/git spawn spy: ${elapsedMs.toFixed(0)}ms`);
        },
    );
});
