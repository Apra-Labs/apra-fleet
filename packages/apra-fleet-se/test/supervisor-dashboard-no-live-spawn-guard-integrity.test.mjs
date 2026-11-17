// apra-fleet-3swo.36.3.2: falsifiability harness for the fix landed in
// apra-fleet-3swo.36.3.1 (commit 957ffbcd) -- dropping the absolute
// `assert.ok(elapsedMs < 5000, ...)` wall-clock-budget assertion from
// supervisor-dashboard-backlog-no-live-spawn.test.mjs ("the guard file"
// below). This file proves TWO independent, non-temporal properties so a
// future reader can trust the fix held without re-deriving it:
//
// (A) THE CORRECTNESS GUARD SURVIVED: the guard file still fails -- via its
//     spawnedLive marker-file assertion, not a timing threshold -- when a
//     live bd/git subprocess spawn is actually induced in the scenario it
//     covers.
// (B) NO ABSOLUTE WALL-CLOCK BUDGET REMAINS: the guard file's source
//     contains no assertion gating on an absolute elapsedMs threshold, and
//     that check is itself falsifiable (proven by reconstructing the
//     pre-fix content and showing it WOULD trip the check).
//
// POSIX-only for (A)/(A control), same rationale and precedent as the guard
// file itself (bash-based marker scripts; gated behind `process.platform !==
// 'win32'`). (B) is pure source-text inspection and runs on every platform.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import {
    mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync,
    chmodSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const repoRoot = path.join(packageRoot, '..', '..');
const GUARD_FILE_PATH = path.join(packageRoot, 'test', 'supervisor-dashboard-backlog-no-live-spawn.test.mjs');

/**
 * Verbatim copy of the guard file's own makeFakeBinDir() helper (kept in
 * sync by hand -- this whole file exists to test that file's behavior from
 * the outside, so importing it directly would defeat the point). Builds fake
 * `bd`/`git` executables that append their invocation to `markerFile` and
 * exit 0, so any code path that actually shells out leaves a trace.
 * @param {string} markerFile
 * @returns {string} the directory to prepend to PATH
 */
function makeFakeBinDir(markerFile) {
    const dir = mkdtempSync(path.join(tmpdir(), 'guard-integrity-fake-bin-'));
    const body = '#!/usr/bin/env bash\n'
        + `echo "$(basename "$0") $*" >> ${JSON.stringify(markerFile)}\n`
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
 * Runs `node --test <args>` as a child process and resolves with its exit
 * code and captured output. NODE_TEST_CONTEXT (set by the OUTER `node --test`
 * run executing THIS file) is always stripped from the child's env before
 * spawning -- inherited, it makes a nested `node --test` child silently
 * treat itself as a reporter-driven grandchild and exit near-instantly having
 * run zero tests (a vacuous "pass"). See the guard file's own identical
 * comment for the empirical basis.
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} opts
 */
function runNodeTestChild(args, opts) {
    return new Promise((resolve, reject) => {
        const childEnv = { ...opts.env };
        delete childEnv.NODE_TEST_CONTEXT;
        const child = spawn(process.execPath, ['--test', ...args], {
            cwd: opts.cwd,
            env: childEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

/**
 * Builds an isolated sandbox directory that reproduces exactly what the
 * guard file needs to run standalone: a byte-identical copy of the guard
 * file itself, a byte-identical copy of supervisor-backlog.test.mjs, and a
 * copy of supervisor-dashboard.test.mjs -- optionally patched to strip the
 * FIRST `listAllBeads: async () => [],` fixture seam, which forces that
 * fixture's `dashboard.buildSprintViews()` call onto the real
 * `bdListAllBeadsWithClosed()` path (deps.listAllBeads ?? bdListAllBeadsWithClosed,
 * see src/supervisor/dashboard.mjs) -- i.e. a genuine (PATH-shimmed, not
 * live-live) `bd list --all --limit 0 --json` subprocess spawn, which is
 * exactly the regression this guard exists to catch.
 *
 * `src/`, `fleet-sprint/`, `test/helpers/`, and the repo's hoisted
 * `node_modules/` are symlinked in (not copied) so every relative/bare
 * import the copied test files make resolves identically to the real tree,
 * without duplicating the whole package.
 *
 * Everything lives under the OS temp root; nothing is ever written into the
 * repo working tree.
 * @param {{ patchDashboard: boolean }} opts
 * @returns {{ sandboxDir: string, cleanup: () => void }}
 */
function buildSandbox({ patchDashboard }) {
    const sandboxDir = mkdtempSync(path.join(tmpdir(), 'guard-integrity-sandbox-'));
    mkdirSync(path.join(sandboxDir, 'test'), { recursive: true });
    symlinkSync(path.join(packageRoot, 'test', 'helpers'), path.join(sandboxDir, 'test', 'helpers'), 'dir');
    symlinkSync(path.join(packageRoot, 'src'), path.join(sandboxDir, 'src'), 'dir');
    symlinkSync(path.join(packageRoot, 'fleet-sprint'), path.join(sandboxDir, 'fleet-sprint'), 'dir');
    symlinkSync(path.join(repoRoot, 'node_modules'), path.join(sandboxDir, 'node_modules'), 'dir');

    writeFileSync(
        path.join(sandboxDir, 'test', 'supervisor-backlog.test.mjs'),
        readFileSync(path.join(packageRoot, 'test', 'supervisor-backlog.test.mjs'), 'utf-8'),
    );
    writeFileSync(
        path.join(sandboxDir, 'test', 'supervisor-dashboard-backlog-no-live-spawn.test.mjs'),
        readFileSync(GUARD_FILE_PATH, 'utf-8'),
    );

    const dashboardSrc = readFileSync(path.join(packageRoot, 'test', 'supervisor-dashboard.test.mjs'), 'utf-8');
    let dashboardOut = dashboardSrc;
    if (patchDashboard) {
        // Strips only the FIRST occurrence (no /g flag) -- one broken fixture
        // is enough to induce a live spawn; regex (not a fixed-indentation
        // literal) so this survives incidental reformatting.
        dashboardOut = dashboardSrc.replace(/\n[ \t]*listAllBeads: async \(\) => \[\],/, '\n');
        assert.notStrictEqual(
            dashboardOut,
            dashboardSrc,
            "expected to find and strip one 'listAllBeads: async () => [],' fixture seam in " +
            "supervisor-dashboard.test.mjs to induce a live spawn -- if this no longer matches, " +
            'the fixture shape has drifted and this induction technique needs updating (CRITERIA-DEFECT risk, not a silent skip)',
        );
    }
    writeFileSync(path.join(sandboxDir, 'test', 'supervisor-dashboard.test.mjs'), dashboardOut);

    return {
        sandboxDir,
        cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }),
    };
}

const WIN32_SKIP = process.platform === 'win32' ? 'POSIX-only bash marker scripts (matches the guard file itself)' : false;

describe('apra-fleet-3swo.36.3.2: no-live-spawn guard integrity (falsifiability of apra-fleet-3swo.36.3.1)', () => {
    test(
        '(A) the guard fails on an induced live bd/git spawn, via the marker-file assertion, non-vacuously',
        { skip: WIN32_SKIP, timeout: scaledTimeout(30000) },
        async (t) => {
            const sandbox = buildSandbox({ patchDashboard: true });
            const markerDir = mkdtempSync(path.join(tmpdir(), 'guard-integrity-marker-'));
            const markerFile = path.join(markerDir, 'spawns.log');
            const fakeBinDir = makeFakeBinDir(markerFile);
            t.after(() => {
                sandbox.cleanup();
                rmSync(fakeBinDir, { recursive: true, force: true });
                rmSync(markerDir, { recursive: true, force: true });
            });

            // --- Preflight: confirm the induced scenario is real (a live `bd`
            // spawn actually happened) and non-vacuous (lots of tests actually
            // ran) BEFORE trusting any red/green verdict derived from it. This
            // is deliberately independent of the guard file's own internal
            // TAP-count check, so criterion (4) does not rely solely on the
            // very mechanism under test to vouch for itself.
            const preflightEnv = { ...process.env, PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}` };
            const preflight = await runNodeTestChild(
                ['test/supervisor-dashboard.test.mjs', 'test/supervisor-backlog.test.mjs'],
                { cwd: sandbox.sandboxDir, env: preflightEnv },
            );
            const preflightTestsMatch = preflight.stdout.match(/^# tests (\d+)$/m);
            const KNOWN_MINIMUM_TESTS = 40; // same generous floor the guard file itself uses
            assert.ok(
                preflightTestsMatch && Number(preflightTestsMatch[1]) >= KNOWN_MINIMUM_TESTS,
                'expected the induced-live-spawn fixture run to be non-vacuous ' +
                `(>=${KNOWN_MINIMUM_TESTS} tests actually executed) BEFORE trusting any verdict off it; got:\n${preflight.stdout}`,
            );
            const preflightMarker = existsSync(markerFile) ? readFileSync(markerFile, 'utf-8') : '';
            assert.match(
                preflightMarker,
                /^bd .*list.*--json/m,
                "expected stripping the fixture's listAllBeads seam to induce a real 'bd list' " +
                `subprocess spawn (caught by the PATH-shimmed fake bd); observed marker file:\n${JSON.stringify(preflightMarker)}`,
            );
            t.diagnostic(`preflight: ${preflightTestsMatch[1]} tests executed non-vacuously; induced spawn(s): ${JSON.stringify(preflightMarker.trim())}`);

            // --- Now run the ACTUAL guard file (byte-identical copy) against
            // this same induced-live-spawn sandbox and confirm it goes RED via
            // the specific marker-file assertion -- not a timeout, not a
            // missing file, not an unrelated nonzero exit.
            const guardRun = await runNodeTestChild(
                [path.join(sandbox.sandboxDir, 'test', 'supervisor-dashboard-backlog-no-live-spawn.test.mjs')],
                { cwd: sandbox.sandboxDir, env: { ...process.env } },
            );
            assert.notStrictEqual(
                guardRun.code,
                0,
                'expected supervisor-dashboard-backlog-no-live-spawn.test.mjs to go RED once a live bd/git ' +
                `spawn is induced; it exited 0 instead:\nstdout:\n${guardRun.stdout}\nstderr:\n${guardRun.stderr}`,
            );
            assert.match(
                guardRun.stdout,
                /no fixture that injects listAllBeads\/driftCheck may spawn a live bd\/git subprocess/,
                'expected the guard failure output to name the live-spawn/marker-file assertion specifically ' +
                `(not a timeout or unrelated error):\nstdout:\n${guardRun.stdout}\nstderr:\n${guardRun.stderr}`,
            );
            const guardTestsMatch = guardRun.stdout.match(/^# tests (\d+)$/m);
            const guardFailMatch = guardRun.stdout.match(/^# fail (\d+)$/m);
            assert.ok(
                guardTestsMatch && Number(guardTestsMatch[1]) === 1 && guardFailMatch && Number(guardFailMatch[1]) === 1,
                `expected the guard file's own single test to run (non-vacuously) and fail:\n${guardRun.stdout}`,
            );
        },
    );

    test(
        '(A control) the same guard file still PASSES against the same sandbox with the seam intact',
        { skip: WIN32_SKIP, timeout: scaledTimeout(30000) },
        async (t) => {
            // Proves the sandbox harness above is not simply always-red: the
            // ONLY difference from test (A) is whether the fixture seam was
            // stripped, so a pass here pins that (A)'s failure is caused by
            // the induced live spawn and not by some artifact of the sandbox
            // (symlink layout, node_modules resolution, etc.).
            const sandbox = buildSandbox({ patchDashboard: false });
            t.after(() => sandbox.cleanup());

            const guardRun = await runNodeTestChild(
                [path.join(sandbox.sandboxDir, 'test', 'supervisor-dashboard-backlog-no-live-spawn.test.mjs')],
                { cwd: sandbox.sandboxDir, env: { ...process.env } },
            );
            assert.strictEqual(
                guardRun.code,
                0,
                'expected the guard to still pass against the sandbox when no live spawn is induced ' +
                `(seam intact):\nstdout:\n${guardRun.stdout}\nstderr:\n${guardRun.stderr}`,
            );
        },
    );

    describe('(B) no absolute wall-clock-budget assertion remains in the guard file, and that check is falsifiable', () => {
        // Matches the ASSERTION (an assert.* call directly comparing elapsedMs
        // to a numeric literal), not merely the identifier: the guard file
        // legitimately still uses `elapsedMs` in a t.diagnostic() report
        // (currently around line 175), so a naive `/elapsedMs/` grep would
        // produce a false red on that legitimate usage.
        const WALL_CLOCK_BUDGET_RE = /assert\.\w+\(\s*elapsedMs\s*(?:<=|>=|<|>)\s*\d+/;
        const currentSource = readFileSync(GUARD_FILE_PATH, 'utf-8');

        test('sanity: the guard file still legitimately references elapsedMs (for its t.diagnostic report)', () => {
            assert.match(
                currentSource,
                /elapsedMs/,
                'expected elapsedMs to still be referenced by the guard file (t.diagnostic elapsed-time report) -- ' +
                'if this no longer holds, the naive-grep-hazard premise below needs re-checking',
            );
            assert.match(currentSource, /t\.diagnostic\(/, 'expected the guard file to still report elapsed time via t.diagnostic()');
        });

        test('the guard file contains no assertion gating on an absolute elapsedMs threshold', () => {
            assert.doesNotMatch(
                currentSource,
                WALL_CLOCK_BUDGET_RE,
                'found an assertion gating on an absolute elapsedMs threshold in supervisor-dashboard-backlog-no-live-spawn.test.mjs -- ' +
                'this reintroduces the apra-fleet-3swo.36.3 contention flake (elapsedMs has been observed up to ~6.9s under full-suite ' +
                'load on an otherwise-passing run); see apra-fleet-3swo.36.3.1',
            );
        });

        test(
            'FALSIFICATION: reverting apra-fleet-3swo.36.3.1 (restoring `assert.ok(elapsedMs < 5000, ...)`) makes the check above fail',
            () => {
                // Manual re-run recipe for a future reader who wants to see this
                // with their own eyes rather than trust the reconstruction below:
                //   git show 957ffbcd^:./test/supervisor-dashboard-backlog-no-live-spawn.test.mjs
                // prints the exact pre-fix file content (still containing
                // `assert.ok(elapsedMs < 5000, ...)`); temporarily restoring that
                // content in place of the current file and re-running just the
                // two tests in this describe block reproduces exactly the
                // failure this test asserts below.
                const ANCHOR_START = '// No absolute wall-clock threshold is asserted here (apra-fleet-3swo.36.3.1):';
                const ANCHOR_END = '// Belt-and-suspenders: exit 0 + an empty marker file';
                const startIdx = currentSource.indexOf(ANCHOR_START);
                const endIdx = currentSource.indexOf(ANCHOR_END);
                assert.ok(
                    startIdx !== -1 && endIdx !== -1 && startIdx < endIdx,
                    'expected both the apra-fleet-3swo.36.3.1 explanatory-comment anchor and the belt-and-suspenders ' +
                    'anchor to be present (in that order) in the guard file -- if the file has since changed shape, ' +
                    'update these anchors rather than silently skipping this falsification',
                );

                const REVERTED_ASSERTION_SNIPPET =
                    'assert.ok(\n'
                    + '    elapsedMs < 5000,\n'
                    + "    `expected combined runtime well under the pre-fix live-spawn baseline, got ${elapsedMs.toFixed(0)}ms`,\n"
                    + ');\n\n';
                const revertedSource = currentSource.slice(0, startIdx) + REVERTED_ASSERTION_SNIPPET + currentSource.slice(endIdx);

                assert.match(
                    revertedSource,
                    WALL_CLOCK_BUDGET_RE,
                    'expected the reconstructed pre-apra-fleet-3swo.36.3.1 content to trip the wall-clock-budget ' +
                    'regex above -- if it does not, that regex is not actually anchored to the assertion this task exists to keep out',
                );
            },
        );
    });
});
