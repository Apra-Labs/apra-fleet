import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';

import { checkModules } from '../fleet-sprint/dispatch-safety-guard.mjs';
import { checkDoltLiteralModules } from '../fleet-sprint/dolt-literal-guard.mjs';
import { checkFullDbFetchModules } from '../fleet-sprint/full-db-fetch-guard.mjs';
import { checkShellCommandPaths, formatShellCommandViolation } from '../fleet-sprint/shell-command-guard.mjs';
import { guardedModulePaths, GUARDED_MODULES } from '../fleet-sprint/guarded-modules.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const RUNNER_PATH = path.join(__dirname, '../fleet-sprint/runner.js');

// =============================================================================
// The shared guarded-module list is LOAD-BEARING, not decorative.
//
// Each of the four mechanical guards in fleet-sprint/ (dispatch-safety,
// dolt-literal, full-db-fetch, shell-command) was originally pointed at ONE
// hard-coded file, runner.js. runner.js is being decomposed; under the old
// wiring, the moment a guarded construct moved into a newly extracted module
// every guard silently stopped covering it while still reporting green. The
// shared list (fleet-sprint/guarded-modules.mjs) is the single registration
// point that fixes that.
//
// This suite proves the fix works END TO END, across all four guards at once:
//   (1) a throwaway fixture module registered ONLY via the shared list, and
//       carrying exactly one seeded violation per guard, is reported by each
//       guard -- that violation and no other;
//   (2) clearing the seeded violations clears every guard's report;
//   (3) the PRE-GENERALIZATION scan set (runner.js alone) sees none of it --
//       the differential control that makes (1) meaningful. If the module-list
//       generalization is reverted so a guard scans runner.js regardless of
//       the paths it is handed, (1)'s assertions fail; (3) is what pins the
//       reason down to "the list is what is being read".
//
// SANDBOX: every fixture is written inside a per-test mkdtemp sandbox under
// os.tmpdir() (the unit-test sandbox convention across this package -- the
// regression playbook's `$SANDBOX` is a live fleet install, a different
// thing) and removed on teardown, in a finally, even on failure. A dedicated
// test below asserts the sandbox lives outside the repo tree and is gone
// afterwards, so a run can never leave a fixture behind for `git status` to
// find.
// =============================================================================

/** Creates a sandbox dir under os.tmpdir(); returns { dir, write, cleanup }. */
function createSandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-modules-coverage-'));
    return {
        dir,
        write(name, lines) {
            const file = path.join(dir, name);
            fs.writeFileSync(file, lines.join('\n'), 'utf8');
            return file;
        },
        cleanup() {
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

const FIXTURE_NAME = 'newly-extracted-module.mjs';

// One seeded violation per guard, and NOT more: every other line is
// deliberately compliant with all four invariants, so "exactly one violation"
// is a real assertion and not an accident of a noisy fixture.
//   line 5  -- dispatch-safety: command() with no member_name/member_id
//   line 6  -- dolt-literal:    a direct `bd dolt push` literal
//   line 7  -- full-db-fetch:   an ad hoc unscoped full-list-shaped bd list
//   line 8  -- shell-command:   a leading `~/` path in a command string
const SEEDED_FIXTURE = [
    "import { doltPushAfter } from './dolt-sync.mjs';",
    '',
    'export async function run(command, member, homeDir) {',
    '    // Each of the next four lines trips exactly one guard.',
    "    await command('git status --short', { timeout: 60 });",
    "    await command('bd dolt push', { member_name: member });",
    "    await command('bd list --limit 0 --all', { member_name: member });",
    "    await command('cat ~/.fleet-git-credential-github', { member_name: member });",
];
const SEEDED_FIXTURE_TAIL = ['}', ''];

// The same module with every seeded violation cleared: an explicit
// member_name, the sync module's exported entry point instead of the literal,
// the single documented full-DB command text, and a JS-resolved home path.
const CLEARED_FIXTURE = [
    "import { doltPushAfter } from './dolt-sync.mjs';",
    '',
    'export async function run(command, member, homeDir) {',
    '    // Every seeded violation cleared, one by one.',
    "    await command('git status --short', { member_name: member, timeout: 60 });",
    '    await doltPushAfter({ command, member });',
    "    await command('bd list --all --limit 0 --json', { member_name: member });",
    '    await command(`cat "${homeDir}/.fleet-git-credential-github"`, { member_name: member });',
    '}',
    '',
];

const SEEDED_SRC = [...SEEDED_FIXTURE, ...SEEDED_FIXTURE_TAIL];

/**
 * Runs all four guards over exactly the same `paths`, returning a per-guard
 * violation map. Every guard is handed the identical scan set, so a
 * difference between two runAllGuards() calls can only come from the paths --
 * which is the whole point of the differential control below.
 * checkDoltLiteralModules() applies the dolt-sync.mjs exemption internally, so
 * it needs no special-casing here.
 */
function runAllGuards(paths) {
    return {
        dispatchSafety: checkModules(paths).violations,
        doltLiteral: checkDoltLiteralModules(paths).violations,
        fullDbFetch: checkFullDbFetchModules(paths).violations,
        shellCommand: checkShellCommandPaths(paths).violations.map(formatShellCommandViolation),
    };
}

// -----------------------------------------------------------------------------
// (1) Each guard flags its own seeded violation in a module reachable ONLY via
//     the shared list -- that violation and no other.
// -----------------------------------------------------------------------------

test('all four guards flag their seeded violation in a fixture module registered via the shared list', () => {
    const sandbox = createSandbox();
    try {
        const fixture = sandbox.write(FIXTURE_NAME, SEEDED_SRC);
        const paths = guardedModulePaths([fixture]);

        // The fixture is reachable only because the shared list was extended
        // with it -- nothing here names it directly to a guard.
        assert.deepEqual(paths.map((p) => path.basename(p)), ['runner.js', FIXTURE_NAME]);

        const found = runAllGuards(paths);

        assert.equal(
            found.dispatchSafety.length,
            1,
            `dispatch-safety: expected exactly the seeded violation, got: ${JSON.stringify(found.dispatchSafety, null, 2)}`
        );
        assert.match(found.dispatchSafety[0], /^newly-extracted-module\.mjs:5 \(command\(\)\) is missing member_name\/member_id$/);

        assert.equal(
            found.doltLiteral.length,
            1,
            `dolt-literal: expected exactly the seeded violation, got: ${JSON.stringify(found.doltLiteral, null, 2)}`
        );
        assert.match(found.doltLiteral[0], /^newly-extracted-module\.mjs:6 /);
        assert.match(found.doltLiteral[0], /bd dolt push/);

        assert.equal(
            found.fullDbFetch.length,
            1,
            `full-db-fetch: expected exactly the seeded violation, got: ${JSON.stringify(found.fullDbFetch, null, 2)}`
        );
        assert.match(found.fullDbFetch[0], /^newly-extracted-module\.mjs:7 /);
        assert.match(found.fullDbFetch[0], /"bd list --limit 0 --all"/);

        assert.equal(
            found.shellCommand.length,
            1,
            `shell-command: expected exactly the seeded violation, got: ${JSON.stringify(found.shellCommand, null, 2)}`
        );
        assert.match(found.shellCommand[0], /^newly-extracted-module\.mjs:8:/);
        assert.match(found.shellCommand[0], /tilde path/);
    } finally {
        sandbox.cleanup();
    }
});

// -----------------------------------------------------------------------------
// (2) Clearing the seeded violations clears every guard's report.
// -----------------------------------------------------------------------------

test('clearing the seeded violations makes all four guards report zero', () => {
    const sandbox = createSandbox();
    try {
        const fixture = sandbox.write(FIXTURE_NAME, CLEARED_FIXTURE);
        const found = runAllGuards(guardedModulePaths([fixture]));

        assert.deepEqual(found.dispatchSafety, []);
        assert.deepEqual(found.doltLiteral, []);
        assert.deepEqual(found.fullDbFetch, []);
        assert.deepEqual(found.shellCommand, []);
    } finally {
        sandbox.cleanup();
    }
});

// -----------------------------------------------------------------------------
// (3) The differential control: the pre-generalization scan set sees nothing.
// -----------------------------------------------------------------------------

test('pointing the guards back at runner.js alone (pre-generalization) misses every seeded violation', () => {
    const sandbox = createSandbox();
    try {
        const fixture = sandbox.write(FIXTURE_NAME, SEEDED_SRC);

        // Exactly the OLD wiring: each guard pointed at the one hard-coded
        // file, with the seeded fixture sitting right there on disk. Every
        // guard reports green -- which is precisely the silent-coverage-loss
        // failure the shared list exists to prevent, and precisely what would
        // make the first test above fail if the generalization were reverted.
        const preGeneralization = runAllGuards([RUNNER_PATH]);
        assert.deepEqual(preGeneralization.dispatchSafety, []);
        assert.deepEqual(preGeneralization.doltLiteral, []);
        assert.deepEqual(preGeneralization.fullDbFetch, []);
        assert.deepEqual(preGeneralization.shellCommand, []);

        // ...while the SAME guards over the SAME tree, with the fixture
        // registered in the shared list, see all four. The list is the only
        // difference between the two runs.
        const viaSharedList = runAllGuards(guardedModulePaths([fixture]));
        assert.equal(viaSharedList.dispatchSafety.length, 1);
        assert.equal(viaSharedList.doltLiteral.length, 1);
        assert.equal(viaSharedList.fullDbFetch.length, 1);
        assert.equal(viaSharedList.shellCommand.length, 1);

        assert.ok(
            fs.existsSync(fixture),
            'the fixture really is on disk during the pre-generalization run -- it is unscanned, not missing'
        );
    } finally {
        sandbox.cleanup();
    }
});

// -----------------------------------------------------------------------------
// (4) Sandbox hygiene: nothing is ever written into the repo tree, and the
//     sandbox is gone after teardown.
// -----------------------------------------------------------------------------

test('every fixture lives in a sandbox outside the repo tree and is removed on teardown', () => {
    const sandbox = createSandbox();
    let fixture;
    try {
        fixture = sandbox.write(FIXTURE_NAME, SEEDED_SRC);
        assert.ok(fs.existsSync(fixture));

        const realSandbox = fs.realpathSync(sandbox.dir);
        const realRepo = fs.realpathSync(REPO_ROOT);
        assert.ok(
            !realSandbox.startsWith(realRepo + path.sep),
            `the sandbox must live outside the repo tree, got ${realSandbox} under ${realRepo}`
        );
        assert.ok(realSandbox.startsWith(fs.realpathSync(os.tmpdir())), 'the sandbox must live under os.tmpdir()');
    } finally {
        sandbox.cleanup();
    }

    assert.ok(!fs.existsSync(sandbox.dir), 'teardown must remove the sandbox directory');
    assert.ok(!fs.existsSync(fixture), 'teardown must remove every fixture inside it');
});

test('the shared list registers real, on-disk modules only -- a fixture is never left registered', () => {
    // A registration leak (a fixture path accidentally committed into
    // GUARDED_MODULES) would make the guards scan a file that does not exist
    // on a fresh clone, so the suite would fail for everyone else. Pin it.
    assert.deepEqual(GUARDED_MODULES, ['runner.js']);
    for (const p of guardedModulePaths()) {
        assert.ok(fs.existsSync(p), `registered guarded module missing on disk: ${p}`);
        assert.ok(fs.realpathSync(p).startsWith(fs.realpathSync(REPO_ROOT) + path.sep), 'registered modules live in the repo');
    }
});
