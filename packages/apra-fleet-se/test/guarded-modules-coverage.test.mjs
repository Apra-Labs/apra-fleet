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
import { guardedModulePaths, GUARDED_MODULES, guardedModuleBasenames } from '../fleet-sprint/guarded-modules.mjs';

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
        // with it -- nothing here names it directly to a guard. Compared
        // against basenames, not GUARDED_MODULES verbatim -- see
        // guardedModuleBasenames()'s doc comment (apra-fleet-3swo.14).
        assert.deepEqual(paths.map((p) => path.basename(p)), [...guardedModuleBasenames(), FIXTURE_NAME]);

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
// (1b) apra-fleet-3swo.14 regression pin: a NESTED registered path (e.g. the
// parent epic's planned 'phases/plan.mjs' module group) must still be scanned
// and attributed correctly by all four guards.
//
// guardedModulePath()/guardedModulePaths() resolve a nested GUARDED_MODULES
// entry (documented as "filenames relative to this directory", joined via
// path.join()) to a real, correct absolute path today -- that part was never
// broken. What broke is every guard's `files` aggregate and violation-string
// attribution: both are built from path.basename(p) (dispatch-safety-
// guard.mjs:219, dolt-literal-guard.mjs:114/75, full-db-fetch-guard.mjs:216/
// 190, shell-command-guard.mjs:276/291), so a nested entry is always reported
// under its bare filename ('plan.mjs'), never its registered relative path
// ('phases/plan.mjs'). A baseline test that compares a guard's `files` output
// against GUARDED_MODULES (or an extraPaths list) VERBATIM breaks the moment
// a nested entry is registered, even though the guard itself scanned it
// correctly.
//
// This test exercises exactly that mismatch through guardedModulePaths()'s
// public extraPaths contract (no need to mutate the real, on-disk
// GUARDED_MODULES/fleet-sprint tree to prove it): a fixture is written one
// directory level DEEPER than the sandbox root passed to
// guardedModulePaths([nestedFixture]) -- structurally identical to what a
// 'phases/plan.mjs' GUARDED_MODULES registration would produce, since every
// guard only ever sees the resolved absolute path, never how it was
// registered. Pins two things: (a) the guards' own attribution stays
// basename-only and unambiguous ('newly-extracted-module.mjs:N', never a
// 'phases/newly-extracted-module.mjs:N' path), and (b) comparing `files`
// against guardedModuleBasenames() -- not GUARDED_MODULES/extraPaths verbatim
// -- is what a baseline assertion must do to keep working once a nested
// module is registered.
// -----------------------------------------------------------------------------

test('a nested fixture path registered through guardedModulePaths is scanned and attributed by basename by all four guards', () => {
    const sandbox = createSandbox();
    try {
        const nestedDir = path.join(sandbox.dir, 'phases');
        fs.mkdirSync(nestedDir, { recursive: true });
        const nestedFixture = path.join(nestedDir, FIXTURE_NAME);
        fs.writeFileSync(nestedFixture, SEEDED_SRC.join('\n'), 'utf8');

        const paths = guardedModulePaths([nestedFixture]);

        // The registered path is nested (mirrors a 'phases/plan.mjs'-style
        // GUARDED_MODULES entry), but guardedModuleBasenames() -- what a
        // baseline assertion must compare `files` against -- strips the
        // directory component just like every guard's own attribution does.
        assert.deepEqual(guardedModuleBasenames([nestedFixture]), [...guardedModuleBasenames(), FIXTURE_NAME]);

        const found = runAllGuards(paths);

        // Same seeded violations as test (1) above, still attributed to the
        // fixture's bare filename -- never the nested path it was registered
        // under.
        assert.equal(found.dispatchSafety.length, 1, `dispatch-safety: expected exactly the seeded violation, got: ${JSON.stringify(found.dispatchSafety, null, 2)}`);
        assert.match(found.dispatchSafety[0], /^newly-extracted-module\.mjs:5 /);

        assert.equal(found.doltLiteral.length, 1, `dolt-literal: expected exactly the seeded violation, got: ${JSON.stringify(found.doltLiteral, null, 2)}`);
        assert.match(found.doltLiteral[0], /^newly-extracted-module\.mjs:6 /);

        assert.equal(found.fullDbFetch.length, 1, `full-db-fetch: expected exactly the seeded violation, got: ${JSON.stringify(found.fullDbFetch, null, 2)}`);
        assert.match(found.fullDbFetch[0], /^newly-extracted-module\.mjs:7 /);

        assert.equal(found.shellCommand.length, 1, `shell-command: expected exactly the seeded violation, got: ${JSON.stringify(found.shellCommand, null, 2)}`);
        assert.match(found.shellCommand[0], /^newly-extracted-module\.mjs:8:/);

        // The aggregate `files` output of each guard -- the exact value the
        // four rewritten baselines assert against -- matches
        // guardedModuleBasenames(), not a raw path/extraPaths comparison.
        assert.deepEqual(checkModules(paths).files, [...guardedModuleBasenames(), FIXTURE_NAME]);
        assert.deepEqual(checkDoltLiteralModules(paths).files, [...guardedModuleBasenames(), FIXTURE_NAME]);
        assert.deepEqual(checkFullDbFetchModules(paths).files, [...guardedModuleBasenames(), FIXTURE_NAME]);
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

// -----------------------------------------------------------------------------
// (5) apra-fleet-3swo.12: end-to-end coverage proof for the three modules
// extracted out of runner.js so far (vcs-auth.mjs, mcp-result.mjs,
// member-target.mjs, registered via apra-fleet-3swo.8).
//
// The positive assertion below reads GUARDED_MODULES/guardedModulePaths()
// directly rather than restating their current contents as a literal path
// array, so it stays correct as more modules are extracted. It is proven
// non-vacuous by folding the SAME seeded-violation fixture technique tests
// (1)/(3) above already established into the SAME guardedModulePaths() call
// that resolves the three real modules: since checkModules()/
// checkDoltLiteralModules()/checkFullDbFetchModules()/checkShellCommandPaths()
// each scan every path they are handed in one pass, a fixture with an
// injected violation sitting alongside vcs-auth.mjs/mcp-result.mjs/
// member-target.mjs in the SAME scanned set is the most direct possible proof
// that "zero violations for these three" is a real finding and not a check
// that could never fail.
// -----------------------------------------------------------------------------

const EXTRACTED_MODULE_NAMES = ['vcs-auth.mjs', 'mcp-result.mjs', 'member-target.mjs'];

test('vcs-auth.mjs, mcp-result.mjs and member-target.mjs are each registered in GUARDED_MODULES and scanned clean by all four guards', () => {
    for (const name of EXTRACTED_MODULE_NAMES) {
        assert.ok(GUARDED_MODULES.includes(name), `${name} must be registered in GUARDED_MODULES (apra-fleet-3swo.8)`);
    }

    // Reads the shared list itself -- not a restated literal path array.
    const paths = guardedModulePaths();
    for (const name of EXTRACTED_MODULE_NAMES) {
        assert.ok(paths.some((p) => path.basename(p) === name), `guardedModulePaths() must resolve a real path for ${name}`);
    }

    const found = runAllGuards(paths);
    for (const [guardName, violations] of Object.entries(found)) {
        const attributedToExtracted = violations.filter((v) => EXTRACTED_MODULE_NAMES.some((name) => v.startsWith(`${name}:`)));
        assert.deepEqual(
            attributedToExtracted,
            [],
            `${guardName} reported violation(s) against an extracted module: ${JSON.stringify(attributedToExtracted, null, 2)}`
        );
    }
});

test('falsification: a seeded violation registered alongside the three extracted modules (same guardedModulePaths() call) is found by every guard, and disappears once dropped from the scanned set', () => {
    const sandbox = createSandbox();
    try {
        const fixture = sandbox.write(FIXTURE_NAME, SEEDED_SRC);

        // The fixture rides in the SAME guardedModulePaths() call the
        // positive test above uses to resolve vcs-auth.mjs/mcp-result.mjs/
        // member-target.mjs -- proving the zero-violations check just above
        // is capable of catching something, not vacuously green.
        const withFixture = runAllGuards(guardedModulePaths([fixture]));
        assert.equal(withFixture.dispatchSafety.length, 1, 'seeded dispatch-safety violation must be found while the fixture is registered');
        assert.equal(withFixture.doltLiteral.length, 1, 'seeded dolt-literal violation must be found while the fixture is registered');
        assert.equal(withFixture.fullDbFetch.length, 1, 'seeded full-db-fetch violation must be found while the fixture is registered');
        assert.equal(withFixture.shellCommand.length, 1, 'seeded shell-command violation must be found while the fixture is registered');
        // Still nothing attributed to the three real extracted modules --
        // the fixture's violations and theirs are disjoint.
        for (const violations of Object.values(withFixture)) {
            assert.deepEqual(violations.filter((v) => EXTRACTED_MODULE_NAMES.some((name) => v.startsWith(`${name}:`))), []);
        }

        // Dropped from the scanned set (the fixture is simply not passed):
        // its violations vanish, exactly as they would for a real module
        // whose GUARDED_MODULES entry was removed.
        const withoutFixture = runAllGuards(guardedModulePaths());
        assert.deepEqual(withoutFixture.dispatchSafety.filter((v) => v.startsWith(`${FIXTURE_NAME}:`)), []);
        assert.deepEqual(withoutFixture.doltLiteral.filter((v) => v.startsWith(`${FIXTURE_NAME}:`)), []);
        assert.deepEqual(withoutFixture.fullDbFetch.filter((v) => v.startsWith(`${FIXTURE_NAME}:`)), []);
        assert.deepEqual(withoutFixture.shellCommand.filter((v) => v.startsWith(`${FIXTURE_NAME}:`)), []);

        // Restored: registering it again (extraPaths, same mechanism) finds
        // it again.
        const restored = runAllGuards(guardedModulePaths([fixture]));
        assert.equal(restored.dispatchSafety.length, 1, 'restoring the registration must make the seeded violation detected again');
        assert.equal(restored.doltLiteral.length, 1, 'restoring the registration must make the seeded violation detected again');
        assert.equal(restored.fullDbFetch.length, 1, 'restoring the registration must make the seeded violation detected again');
        assert.equal(restored.shellCommand.length, 1, 'restoring the registration must make the seeded violation detected again');
    } finally {
        sandbox.cleanup();
    }
});

test('falsification: re-pointing a guard at a private hard-coded path array (not guardedModulePaths()) loses the seeded violation', () => {
    const sandbox = createSandbox();
    try {
        const fixture = sandbox.write(FIXTURE_NAME, SEEDED_SRC);

        // Correctly wired: the guard is handed paths DERIVED from the shared
        // list (guardedModulePaths([fixture])) and finds the seeded
        // violation -- this is how every guard is actually called in
        // production (checkModules() defaults to guardedModulePaths()).
        const viaSharedList = checkModules(guardedModulePaths([fixture])).violations;
        assert.equal(viaSharedList.length, 1, 'dispatch-safety must find the seeded violation when scanning paths derived from the shared list');

        // Simulates the regression this whole mechanism exists to prevent:
        // one guard re-pointed at a private hard-coded path array instead of
        // the shared list (here, literally RUNNER_PATH alone -- the exact
        // pre-generalization wiring every one of these guards used to have).
        // The fixture is on disk and registered nowhere this private array
        // looks, so its seeded violation is silently lost.
        const viaPrivateHardcodedArray = checkModules([RUNNER_PATH]).violations;
        assert.deepEqual(
            viaPrivateHardcodedArray.filter((v) => v.startsWith(`${FIXTURE_NAME}:`)),
            [],
            'a guard re-pointed at a private hard-coded path array must NOT see a violation registered only through the shared list'
        );
    } finally {
        sandbox.cleanup();
    }
});

test('the shared list registers real, on-disk modules only -- a fixture is never left registered', () => {
    // A registration leak (a fixture path accidentally committed into
    // GUARDED_MODULES) would make the guards scan a file that does not exist
    // on a fresh clone, so the suite would fail for everyone else. Pin the
    // registry's structural invariants -- not a hard-coded snapshot of its
    // contents, since a legitimate extraction is expected to append entries
    // here (that is the whole point of the shared list).
    assert.ok(Array.isArray(GUARDED_MODULES) && GUARDED_MODULES.length > 0, 'GUARDED_MODULES must be a non-empty array');
    assert.deepEqual(
        new Set(GUARDED_MODULES).size,
        GUARDED_MODULES.length,
        `GUARDED_MODULES must not contain duplicate entries, got: ${JSON.stringify(GUARDED_MODULES)}`
    );
    for (const p of guardedModulePaths()) {
        assert.ok(fs.existsSync(p), `registered guarded module missing on disk: ${p}`);
        assert.ok(fs.realpathSync(p).startsWith(fs.realpathSync(REPO_ROOT) + path.sep), 'registered modules live in the repo');
    }
});
