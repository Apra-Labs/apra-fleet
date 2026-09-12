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
import { checkUnbracketedPushModules } from '../fleet-sprint/unbracketed-push-guard.mjs';
import {
    guardedModulePaths,
    GUARDED_MODULES,
    guardedModuleBasenames,
    UNBRACKETED_PUSH_EXEMPT,
    GUARD_REGISTRATION_EXEMPT,
} from '../fleet-sprint/guarded-modules.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const RUNNER_PATH = path.join(__dirname, '../fleet-sprint/runner.js');
const FLEET_SPRINT_DIR = path.join(__dirname, '../fleet-sprint');

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
        // apra-fleet-3swo.4.2: fifth guard, wired the same way as the other
        // four -- reads paths derived from the shared list and applies its
        // own exemption (UNBRACKETED_PUSH_EXEMPT, git-sync.mjs) internally,
        // exactly like checkDoltLiteralModules() applies DOLT_LITERAL_EXEMPT.
        // Not asserted against the SEEDED_FIXTURE/CLEARED_FIXTURE pair above:
        // CLEARED_FIXTURE's `await doltPushAfter({ command, member });` fix
        // for the dolt-literal violation is itself a bare, unsanctioned
        // primitive call under THIS guard's invariant (only git-sync.mjs may
        // call the raw primitive directly) -- a real module fixing the
        // dolt-literal hole would route through gitSync.pushBeadsAfter()
        // instead. That is a property of the shared fixture, not a defect in
        // this wiring; see the dedicated unbracketedPush coverage below.
        unbracketedPush: checkUnbracketedPushModules(paths).violations,
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
// (1b) apra-fleet-3swo.14 regression pin: a NESTED GUARDED_MODULES entry (e.g.
// the parent epic's planned 'phases/plan.mjs' module group) must be reported
// under its bare filename by guardedModuleBasenames() -- the function every
// rewritten baseline compares a guard's `files` output against -- never under
// its full registered relative path.
//
// WHY THIS NEEDS NO DISK WRITE OR FIXTURE: guardedModuleBasenames() is a pure
// derivation of GUARDED_MODULES; it never touches disk. GUARDED_MODULES is a
// `const` BINDING but a mutable array, so this test pushes a nested entry
// directly onto the real, shared list -- in a try/finally that always pops it,
// so no other test in this file (or process) ever observes the mutation --
// and asserts guardedModuleBasenames() reports it as 'plan.mjs', never
// 'phases/plan.mjs'.
//
// WHY THE PRIOR VERSION OF THIS PIN WAS VACUOUS: it registered a nested path
// only through guardedModulePaths()'s `extraPaths` parameter, never through
// GUARDED_MODULES itself. With every REAL entry in GUARDED_MODULES flat today,
// `[...GUARDED_MODULES, extra]` and `[...guardedModuleBasenames(), extra]` are
// byte-identical regardless of extra's own nesting, so that assertion passed
// identically whether or not guardedModuleBasenames() existed at all
// (confirmed: reverting all four baselines to compare a guard's `files`
// against raw GUARDED_MODULES breaks no test today). Only nesting the entry
// INSIDE GUARDED_MODULES itself makes the divergence real, which this version
// does.
// -----------------------------------------------------------------------------

test('a nested GUARDED_MODULES entry is reported under its bare filename by guardedModuleBasenames(), never its registered relative path', () => {
    const NESTED_ENTRY = 'phases/plan.mjs';
    const before = guardedModuleBasenames();
    GUARDED_MODULES.push(NESTED_ENTRY);
    try {
        const after = guardedModuleBasenames();

        // Correct behaviour: the nested entry is appended under its bare
        // filename, matching exactly what every guard's own path.basename(p)
        // attribution reports.
        assert.deepEqual(after, [...before, 'plan.mjs']);
        assert.ok(
            !after.includes(NESTED_ENTRY),
            `guardedModuleBasenames() must never report the full registered relative path, got: ${JSON.stringify(after)}`
        );

        // The regression this pins: comparing a guard's `files` output
        // (basename-only) against GUARDED_MODULES verbatim -- what all four
        // baselines did before apra-fleet-3swo.14 -- diverges the instant a
        // nested entry is registered, even though nothing is actually wrong.
        // This assertion is what fails against a raw-GUARDED_MODULES
        // comparison and passes only once baselines compare against
        // guardedModuleBasenames() instead.
        assert.notDeepEqual(
            after,
            GUARDED_MODULES,
            'a basename-derived list must diverge from raw GUARDED_MODULES once a nested entry is registered -- this is exactly why the baselines must compare against guardedModuleBasenames(), not GUARDED_MODULES directly'
        );
    } finally {
        GUARDED_MODULES.pop();
    }

    // Popped cleanly: the shared list (and therefore every other test in this
    // process importing it) sees no trace of the nested entry afterward.
    assert.deepEqual(guardedModuleBasenames(), before, 'GUARDED_MODULES must be restored to its pre-test state');
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

// -----------------------------------------------------------------------------
// (6) apra-fleet-3swo.4.2: the fifth guard, checkUnbracketedPushModules(), is
// registered via runAllGuards() and reads the shared list with its OWN
// exemption applied, mirroring the dolt-literal guard's dolt-sync.mjs
// precedent.
// -----------------------------------------------------------------------------

test('git-sync.mjs is registered in UNBRACKETED_PUSH_EXEMPT and skipped by checkUnbracketedPushModules over the real shared list', () => {
    assert.ok(UNBRACKETED_PUSH_EXEMPT.includes('git-sync.mjs'), 'git-sync.mjs must be exempt -- it owns the bracketed primitive calls');
    const { violations, files, skipped } = checkUnbracketedPushModules(guardedModulePaths());
    assert.ok(skipped.includes('git-sync.mjs'), 'git-sync.mjs must be skipped, not scanned');
    assert.ok(!files.includes('git-sync.mjs'), 'git-sync.mjs must not appear in the scanned files list');
    assert.deepEqual(violations, [], `expected zero unbracketed-push violations across the real registered module set today, got: ${JSON.stringify(violations, null, 2)}`);
});

test('falsification: a fixture with a bare doltPushAfter() call registered via the shared list is flagged, and disappears once dropped', () => {
    const sandbox = createSandbox();
    try {
        const fixture = sandbox.write('unbracketed-push-fixture.mjs', [
            "import { doltPushAfter } from './dolt-sync.mjs';",
            'export async function run(orchestratorMember, opts) {',
            '    // bare call, no gitSync.pushBeadsAfter bracket -- exactly the hole',
            '    // apra-fleet-3swo.4.1 closed for the two named sites.',
            '    await doltPushAfter(orchestratorMember, opts);',
            '}',
            '',
        ]);

        const withFixture = checkUnbracketedPushModules(guardedModulePaths([fixture])).violations;
        assert.equal(withFixture.length, 1, `expected exactly the seeded bare doltPushAfter() call to be flagged, got: ${JSON.stringify(withFixture, null, 2)}`);
        assert.match(withFixture[0], /^unbracketed-push-fixture\.mjs:5 bare doltPushAfter\(\) call site/);

        const withoutFixture = checkUnbracketedPushModules(guardedModulePaths()).violations;
        assert.deepEqual(withoutFixture.filter((v) => v.startsWith('unbracketed-push-fixture.mjs:')), []);
    } finally {
        sandbox.cleanup();
    }
});

test('a bare syncMemberAfter() call inside a function literally named syncMemberAfterOrdered is sanctioned by SCOPE, not by filename or variable name', () => {
    const sandbox = createSandbox();
    try {
        // Proves the per-site exemption is structural (which FUNCTION BODY the
        // call sits in) rather than tied to runner.js by name or to a specific
        // local variable name (the prior version's brittle `gPush = await
        // syncMemberAfter(...)` regex) -- the same wrapper name in an
        // unrelated fixture module is exempted identically.
        const fixture = sandbox.write('sanctioned-wrapper-fixture.mjs', [
            "import { syncMemberAfter } from './runner.js';",
            'export async function syncMemberAfterOrdered(member, opts) {',
            '    const result = await syncMemberAfter(member, opts);',
            '    return result;',
            '}',
            '',
        ]);
        const violations = checkUnbracketedPushModules(guardedModulePaths([fixture])).violations;
        assert.deepEqual(
            violations.filter((v) => v.startsWith('sanctioned-wrapper-fixture.mjs:')),
            [],
            `expected the call inside syncMemberAfterOrdered's own body to be sanctioned, got: ${JSON.stringify(violations, null, 2)}`
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

// =============================================================================
// (7) apra-fleet-3swo.25: REGISTRATION COMPLETENESS -- the shared list proves
// it is READ by the guards ((1)-(6) above), but until now nothing proved the
// list itself is COMPLETE. A newly extracted module that is never added to
// GUARDED_MODULES (or the new GUARD_REGISTRATION_EXEMPT map below) silently
// escapes every guard while all of them keep reporting green -- exactly the
// hole this bead closes.
//
// The enumeration below is a RECURSIVE walk of fleet-sprint/, built
// independently in this test file (not re-exported from guarded-modules.mjs),
// so a bug in the walk itself cannot also hide in the code under test.
// =============================================================================

/** Recursively lists every *.mjs/*.js file under `dir`, relative-path sorted. */
function walkFleetSprintRecursive(dir, base = '') {
    let out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            out = out.concat(walkFleetSprintRecursive(path.join(dir, entry.name), rel));
        } else if (/\.(mjs|js)$/.test(entry.name)) {
            out.push(rel);
        }
    }
    return out.sort();
}

/**
 * Every file the RECURSIVE walk must find one level down -- the concrete
 * proof that the enumeration is not a flat `fs.readdirSync(fleetSprintDir)`,
 * which would never see any of them.
 *
 * Two directories now, not one: apra-fleet-3swo.6.2's Phase 4 slice made the
 * once-hypothetical `phases/*` case real, which is exactly why it is listed
 * here alongside vcs-providers/. A walk that regressed to a flat listing
 * would stop seeing the phase modules -- and, because they are registered
 * under nested paths, the completeness test below would keep passing while
 * silently checking a smaller tree.
 */
const KNOWN_NESTED_FILES = [
    'phases/ensure-sprint-branch.mjs',
    'phases/plan.mjs',
    'phases/replan.mjs',
    'phases/develop.mjs',
    'phases/review.mjs',
    'phases/deploy.mjs',
    'phases/integ-test.mjs',
    'phases/re-review.mjs',
    'phases/final-review.mjs',
    'phases/regression-test.mjs',
    'vcs-providers/azure-devops.mjs',
    'vcs-providers/bitbucket.mjs',
    'vcs-providers/dolt.mjs',
    'vcs-providers/generic-git.mjs',
    'vcs-providers/github.mjs',
    'vcs-providers/index.mjs',
    'vcs-providers/shell-helpers.mjs',
];

/**
 * True if `relPath` (relative to fleet-sprint/, as produced by
 * walkFleetSprintRecursive() -- e.g. 'vcs-providers/azure-devops.mjs') is
 * accounted for: either registered in GUARDED_MODULES or present in
 * GUARD_REGISTRATION_EXEMPT, compared by FULL RELATIVE PATH.
 *
 * apra-fleet-3swo.33: this is DELIBERATELY NOT the same comparison
 * guardedModuleBasenames() uses (apra-fleet-3swo.14's basename convention is
 * for guard REPORTING/baseline comparisons only -- every guard's `files`
 * output and violation strings label a scanned file by path.basename(p), so
 * baselines must compare against basenames to match that reporting). This
 * COMPLETENESS check answers a different question -- "is this exact file on
 * disk registered anywhere?" -- and basename comparison answered it wrong: a
 * nested file was reported accounted-for whenever ANY registered/exempt entry
 * merely shared its bare filename, regardless of directory. Concretely (this
 * was verified against the tree before the fix): a hypothetical
 * 'phases/index.mjs' reported true solely because 'vcs-providers/index.mjs'
 * is registered; 'phases/errors.mjs' reported true because 'errors.mjs' is
 * registered; 'phases/dolt-sync.mjs' reported true because 'dolt-sync.mjs' is
 * exempt. Comparing full relative paths instead means a nested module is only
 * accounted for when IT ITSELF (not some other file sharing its filename) is
 * registered or exempted.
 */
function isAccountedFor(relPath, registered = GUARDED_MODULES, exempt = GUARD_REGISTRATION_EXEMPT) {
    return registered.includes(relPath) || Object.prototype.hasOwnProperty.call(exempt, relPath);
}

test('recursion is real: the walk finds vcs-providers/ files one level down, which a flat listing would miss', () => {
    const all = walkFleetSprintRecursive(FLEET_SPRINT_DIR);
    for (const nested of KNOWN_NESTED_FILES) {
        assert.ok(all.includes(nested), `recursive walk must find nested file ${nested}, got: ${JSON.stringify(all)}`);
    }

    // The differential control: a FLAT listing of the same directory (the
    // regression this test pins -- someone "simplifying" the walk back to
    // fs.readdirSync(fleetSprintDir) with no recursion) sees none of them.
    const flat = fs.readdirSync(FLEET_SPRINT_DIR, { withFileTypes: true }).filter((e) => e.isFile() && /\.(mjs|js)$/.test(e.name)).map((e) => e.name);
    for (const nested of KNOWN_NESTED_FILES) {
        assert.ok(!flat.includes(nested), `a flat listing must NOT see nested file ${nested} -- if it does, the control below is meaningless`);
    }
});

test('every *.mjs/*.js file under fleet-sprint/ (recursive) is registered in GUARDED_MODULES or present in GUARD_REGISTRATION_EXEMPT', () => {
    const all = walkFleetSprintRecursive(FLEET_SPRINT_DIR);
    assert.ok(all.length > 30, `sanity: expected more than 30 files under fleet-sprint/, found ${all.length}`);

    const unaccounted = all.filter((f) => !isAccountedFor(f));
    assert.deepEqual(
        unaccounted,
        [],
        `every fleet-sprint module must be registered in GUARDED_MODULES or exempted in GUARD_REGISTRATION_EXEMPT with a reason; unaccounted: ${JSON.stringify(unaccounted)}`
    );
});

test('apra-fleet-3swo.33 regression: a nested file whose BASENAME collides with an unrelated registered/exempt entry is reported unaccounted-for', () => {
    // Pins the exact false positives this bead's investigation found by
    // calling the same predicate the completeness test above uses -- no
    // fixture/filesystem write needed, since isAccountedFor() is a pure
    // string comparison and none of these paths need to exist on disk.
    assert.ok(GUARDED_MODULES.includes('vcs-providers/index.mjs'), 'this pin assumes vcs-providers/index.mjs is registered today');
    assert.ok(GUARDED_MODULES.includes('errors.mjs'), 'this pin assumes errors.mjs is registered today');
    assert.ok(
        Object.prototype.hasOwnProperty.call(GUARD_REGISTRATION_EXEMPT, 'dolt-sync.mjs'),
        'this pin assumes dolt-sync.mjs is exempt today'
    );
    // apra-fleet-3swo.6.2 landed the real phases/ modules, so 'phases/plan.mjs'
    // is now REGISTERED and can no longer serve as the "not registered
    // anywhere" control below. The control moved to a nested path that is
    // still hypothetical; this line now pins the opposite fact, which is what
    // makes the replacement control's premise checkable.
    assert.ok(GUARDED_MODULES.includes('phases/plan.mjs'), 'this pin assumes phases/plan.mjs is registered today (apra-fleet-3swo.6.2)');
    // apra-fleet-3swo.6.7 registered phases/replan.mjs and phases/develop.mjs,
    // apra-fleet-3swo.6.5 then registered phases/review.mjs and
    // phases/deploy.mjs, apra-fleet-3swo.6.8 registered phases/integ-test.mjs
    // and phases/re-review.mjs, apra-fleet-3swo.6.6 registered
    // phases/final-review.mjs and phases/regression-test.mjs, and
    // apra-fleet-3swo.6.9 has now registered the LAST two,
    // phases/harvest.mjs and phases/publish-pr.mjs.
    //
    // THE CONTROL IS NOW RETIRED ONTO A PERMANENTLY HYPOTHETICAL PATH, exactly
    // as the note this comment replaces instructed. All twelve phase()
    // boundaries are sliced, so there is no "next unextracted phase" left to
    // borrow: any successor picked from the phase list would be a module that
    // will never exist, and a control whose premise is a lie rots the moment
    // someone tries to check it. UNEXTRACTED_CONTROL below is instead a nested
    // path under a directory that exists, with a basename deliberately chosen
    // to collide with NOTHING in GUARDED_MODULES or GUARD_REGISTRATION_EXEMPT
    // -- and the premise is still pinned (it must be neither registered nor
    // exempt), so a future registration that happened to use this name fails
    // loudly here instead of silently testing nothing.
    assert.ok(GUARDED_MODULES.includes('phases/replan.mjs'), 'this pin assumes phases/replan.mjs is registered today (apra-fleet-3swo.6.7)');
    assert.ok(GUARDED_MODULES.includes('phases/develop.mjs'), 'this pin assumes phases/develop.mjs is registered today (apra-fleet-3swo.6.7)');
    assert.ok(GUARDED_MODULES.includes('phases/review.mjs'), 'this pin assumes phases/review.mjs is registered today (apra-fleet-3swo.6.5)');
    assert.ok(GUARDED_MODULES.includes('phases/deploy.mjs'), 'this pin assumes phases/deploy.mjs is registered today (apra-fleet-3swo.6.5)');
    assert.ok(GUARDED_MODULES.includes('phases/integ-test.mjs'), 'this pin assumes phases/integ-test.mjs is registered today (apra-fleet-3swo.6.8)');
    assert.ok(GUARDED_MODULES.includes('phases/re-review.mjs'), 'this pin assumes phases/re-review.mjs is registered today (apra-fleet-3swo.6.8)');
    assert.ok(GUARDED_MODULES.includes('phases/final-review.mjs'), 'this pin assumes phases/final-review.mjs is registered today (apra-fleet-3swo.6.6)');
    assert.ok(GUARDED_MODULES.includes('phases/regression-test.mjs'), 'this pin assumes phases/regression-test.mjs is registered today (apra-fleet-3swo.6.6)');
    assert.ok(GUARDED_MODULES.includes('phases/harvest.mjs'), 'this pin assumes phases/harvest.mjs is registered today (apra-fleet-3swo.6.9)');
    assert.ok(GUARDED_MODULES.includes('phases/publish-pr.mjs'), 'this pin assumes phases/publish-pr.mjs is registered today (apra-fleet-3swo.6.9)');
    const UNEXTRACTED_CONTROL = 'phases/not-a-phase-module.mjs';
    assert.ok(
        !GUARDED_MODULES.includes(UNEXTRACTED_CONTROL),
        `this control assumes ${UNEXTRACTED_CONTROL} is registered nowhere -- pick another hypothetical name if it ever is`
    );
    assert.ok(
        !Object.prototype.hasOwnProperty.call(GUARD_REGISTRATION_EXEMPT, UNEXTRACTED_CONTROL),
        `this control assumes ${UNEXTRACTED_CONTROL} is exempt nowhere -- pick another hypothetical name if it ever is`
    );
    assert.ok(
        !GUARDED_MODULES.some((m) => path.basename(m) === path.basename(UNEXTRACTED_CONTROL)) &&
        !Object.keys(GUARD_REGISTRATION_EXEMPT).some((m) => path.basename(m) === path.basename(UNEXTRACTED_CONTROL)),
        `this control assumes ${UNEXTRACTED_CONTROL}'s BASENAME collides with nothing -- otherwise it stops being the ` +
        'no-collision control and silently duplicates the collision cases above'
    );

    // A nested 'phases/index.mjs' must NOT be considered accounted-for merely
    // because a DIFFERENT file, 'vcs-providers/index.mjs', shares its bare
    // filename -- under the old basename-only comparison this incorrectly
    // reported true.
    assert.equal(isAccountedFor('phases/index.mjs'), false, "phases/index.mjs must not ride on vcs-providers/index.mjs's registration");
    // Same shape against a flat registered entry (errors.mjs).
    assert.equal(isAccountedFor('phases/errors.mjs'), false, "phases/errors.mjs must not ride on errors.mjs's registration");
    // Same shape against a GUARD_REGISTRATION_EXEMPT entry (dolt-sync.mjs).
    assert.equal(isAccountedFor('phases/dolt-sync.mjs'), false, "phases/dolt-sync.mjs must not ride on dolt-sync.mjs's exemption");
    // Control: a file that shares no basename with anything registered or
    // exempt was already correctly unaccounted-for under either comparison.
    // Uses the permanently hypothetical UNEXTRACTED_CONTROL pinned above, now
    // that every phases/ module in the epic -- through harvest.mjs and
    // publish-pr.mjs, the last two -- is genuinely registered.
    assert.equal(isAccountedFor(UNEXTRACTED_CONTROL), false, `${UNEXTRACTED_CONTROL} has no colliding basename and must still report unaccounted-for`);
    // The nested entries apra-fleet-3swo.6.2 actually registered are accounted
    // for by their FULL RELATIVE PATH -- the first real exercise of nested
    // registration, and the reason the two assertions below are not redundant
    // with the vcs-providers/ one further down: these are the entries whose
    // basenames ('plan.mjs', 'ensure-sprint-branch.mjs') differ from the paths
    // under which they are registered.
    assert.equal(isAccountedFor('phases/plan.mjs'), true, 'the really-registered nested phase module must be accounted for');
    assert.equal(isAccountedFor('phases/ensure-sprint-branch.mjs'), true, 'the really-registered nested phase module must be accounted for');
    assert.equal(isAccountedFor('phases/replan.mjs'), true, 'the really-registered nested phase module must be accounted for');
    assert.equal(isAccountedFor('phases/develop.mjs'), true, 'the really-registered nested phase module must be accounted for');
    assert.equal(isAccountedFor('phases/review.mjs'), true, 'the really-registered nested phase module must be accounted for');
    assert.equal(isAccountedFor('phases/deploy.mjs'), true, 'the really-registered nested phase module must be accounted for');
    assert.equal(isAccountedFor('phases/integ-test.mjs'), true, 'the really-registered nested phase module must be accounted for');
    assert.equal(isAccountedFor('phases/re-review.mjs'), true, 'the really-registered nested phase module must be accounted for');
    assert.equal(isAccountedFor('phases/final-review.mjs'), true, 'the really-registered nested phase module must be accounted for');
    assert.equal(isAccountedFor('phases/regression-test.mjs'), true, 'the really-registered nested phase module must be accounted for');
    assert.equal(isAccountedFor('phases/harvest.mjs'), true, 'the really-registered nested phase module must be accounted for');
    assert.equal(isAccountedFor('phases/publish-pr.mjs'), true, 'the really-registered nested phase module must be accounted for');
    // ...and registering them must NOT make a bare 'plan.mjs' at the
    // fleet-sprint/ root ride on the nested entry, which is the same
    // directory-blind failure this bead's fix prevents in the other direction.
    assert.equal(isAccountedFor('plan.mjs'), false, "a root-level plan.mjs must not ride on phases/plan.mjs's registration");

    // The real registered/exempt files themselves are unaffected by the
    // fix -- comparing full relative paths still finds them.
    assert.equal(isAccountedFor('vcs-providers/index.mjs'), true, 'the real, correctly-registered file must still be accounted for');
    assert.equal(isAccountedFor('errors.mjs'), true, 'the real, correctly-registered flat file must still be accounted for');
    assert.equal(isAccountedFor('dolt-sync.mjs'), true, 'the real, correctly-exempted file must still be accounted for');
});

test('falsifiability: dropping a currently-registered module (kb.mjs) from GUARDED_MODULES makes it unaccounted for', () => {
    assert.ok(GUARDED_MODULES.includes('kb.mjs'), 'this pin assumes kb.mjs is registered today -- update the pinned filename if it is ever removed');
    const withoutKb = GUARDED_MODULES.filter((f) => f !== 'kb.mjs');

    assert.equal(isAccountedFor('kb.mjs', withoutKb), false, 'kb.mjs must become unaccounted for once dropped from GUARDED_MODULES (and it carries no exemption)');
    // Restated as the real completeness test above would see it: kb.mjs
    // would show up in the unaccounted-for list.
    const all = walkFleetSprintRecursive(FLEET_SPRINT_DIR);
    const unaccounted = all.filter((f) => !isAccountedFor(f, withoutKb));
    assert.ok(unaccounted.includes('kb.mjs'), `dropping kb.mjs from GUARDED_MODULES must surface it as unaccounted, got: ${JSON.stringify(unaccounted)}`);

    // GUARDED_MODULES itself is untouched by this test -- `withoutKb` is a
    // derived copy, never assigned back.
    assert.ok(GUARDED_MODULES.includes('kb.mjs'), 'GUARDED_MODULES must be unmodified after this test');
});

test('GUARD_REGISTRATION_EXEMPT: every entry carries a non-empty reason, no file is both registered and exempt, and every exempted file exists on disk', () => {
    const exemptEntries = Object.entries(GUARD_REGISTRATION_EXEMPT);
    assert.ok(exemptEntries.length > 0, 'GUARD_REGISTRATION_EXEMPT must not be empty');

    const registeredBasenames = new Set(GUARDED_MODULES.map((f) => path.basename(f)));
    for (const [file, reason] of exemptEntries) {
        assert.equal(typeof reason, 'string', `exemption reason for ${file} must be a string`);
        assert.ok(reason.trim().length > 0, `exemption reason for ${file} must be non-empty`);

        assert.ok(
            !registeredBasenames.has(path.basename(file)),
            `${file} is both registered in GUARDED_MODULES and present in GUARD_REGISTRATION_EXEMPT -- a file must be exactly one of the two`
        );

        const abs = path.join(FLEET_SPRINT_DIR, file);
        assert.ok(fs.existsSync(abs), `exempted file does not exist on disk: ${abs} (a stale exemption entry hides nothing real)`);
    }
});

test('the five shell builders and dolt-sync.mjs reuse the reasons already written verbatim in this file\'s header, not new prose', () => {
    const SHELL_BUILDER_REASON =
        'deliberately emits `$HOME`, `$env:USERPROFILE`, `$env:TEMP` and `$( )` because it IS the ' +
        'OS-branched command surface the shell-command invariant tells everyone else to route ' +
        'through; scanning it would report its entire reason for existing as violations.';
    for (const file of ['se-posix.mjs', 'se-windows.mjs', 'se-windows-gitbash.mjs', 'se-os-commands.mjs', 'dolt-settle.mjs']) {
        assert.equal(
            GUARD_REGISTRATION_EXEMPT[file],
            SHELL_BUILDER_REASON,
            `${file}'s exemption reason must reuse the shell-builder header reason verbatim, not re-derived prose`
        );
    }
    assert.match(
        GUARD_REGISTRATION_EXEMPT['dolt-sync.mjs'],
        /bd dolt pull.*bd dolt push/,
        'dolt-sync.mjs\'s exemption reason must reuse the header\'s dolt-sync rationale'
    );
});

test('all 26 fleet-sprint files unregistered before apra-fleet-3swo.25 are now accounted for', () => {
    // The bead's own audit (25 files) plus dolt-sync.mjs, which the same
    // audit separately called out for exemption-reason reuse but omitted
    // from its enumerated count -- 26 total, verified against a fresh
    // recursive walk this pass.
    const PREVIOUSLY_UNREGISTERED = [
        'conflict-ladder.mjs',
        'contracts.mjs',
        'dispatch-safety-guard.mjs',
        'dolt-literal-guard.mjs',
        'dolt-settle.mjs',
        'dolt-sync.mjs',
        'errors.mjs',
        'full-db-fetch-guard.mjs',
        'guarded-modules.mjs',
        'se-os-commands.mjs',
        'se-posix.mjs',
        'se-windows-gitbash.mjs',
        'se-windows.mjs',
        'shell-command-guard.mjs',
        'sprint-lock.mjs',
        'sprint-progress.mjs',
        'unbracketed-push-guard.mjs',
        'vcs-module.mjs',
        'vcs-providers/azure-devops.mjs',
        'vcs-providers/bitbucket.mjs',
        'vcs-providers/dolt.mjs',
        'vcs-providers/generic-git.mjs',
        'vcs-providers/github.mjs',
        'vcs-providers/index.mjs',
        'vcs-providers/shell-helpers.mjs',
        'viewer-extensions.mjs',
    ];
    assert.equal(PREVIOUSLY_UNREGISTERED.length, 26);

    for (const f of PREVIOUSLY_UNREGISTERED) {
        assert.ok(isAccountedFor(f), `${f} must now be registered in GUARDED_MODULES or exempted in GUARD_REGISTRATION_EXEMPT, got neither`);
    }
});
