import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    checkExplicitIdCreatePath,
    checkExplicitIdCreateModules,
    findExplicitIdCreateViolations,
} from '../fleet-sprint/explicit-id-create-guard.mjs';
import {
    explicitIdCreateModulePaths,
    EXPLICIT_ID_CREATE_EXEMPT,
    guardedModuleBasenames,
    guardedModulePath,
} from '../fleet-sprint/guarded-modules.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// apra-fleet-btj9.8 -- explicit-id-create guard test.
//
// Invariant under test: checkExplicitIdCreateModules() (fleet-sprint/
// explicit-id-create-guard.mjs, built by apra-fleet-btj9.7) must actually run
// under `npm test`, so a second unguarded `bd create` call site anywhere
// outside beads-children.mjs -- the exact shape of the bug this bead's parent
// (apra-fleet-btj9) fixes -- is caught mechanically rather than silently
// slipping back in. Before this test existed, `grep -rn
// "checkExplicitIdCreateModules"` across the repo returned only the
// function's own definition and comments: the guard was dead code, invoked
// by nothing.
//
// Follows dolt-literal-guard.test.mjs's idiom exactly: drive the checker over
// fixtures under test/fixtures/ rather than mutating any production file to
// manufacture a failing case.
// =============================================================================

const NON_COMPLIANT_FIXTURE = path.join(__dirname, 'fixtures/explicit-id-create-guard/non-compliant.mjs');
const COMPLIANT_FIXTURE = path.join(__dirname, 'fixtures/explicit-id-create-guard/compliant.mjs');

const check = (cond, msg) => assert.ok(cond, msg);

test('checkExplicitIdCreateModules() passes over the real guarded-module set today (AC1: live regression guard)', () => {
    const { violations, files, skipped } = checkExplicitIdCreateModules();
    check(
        violations.length === 0,
        `Expected zero unguarded 'bd create' sites across the guarded modules, got: ${JSON.stringify(violations, null, 2)}`
    );
    // Reads the SHARED list, filtered by the SHARED exemption -- not a
    // private path array (AC4).
    assert.deepStrictEqual(
        files,
        guardedModuleBasenames().filter((name) => !EXPLICIT_ID_CREATE_EXEMPT.includes(name)),
        'the default scan set is the shared guarded-module list, minus the explicit-id-create exemption'
    );
    // explicitIdCreateModulePaths() already filters EXPLICIT_ID_CREATE_EXEMPT
    // out of the paths it hands back, so the default call never even offers
    // beads-children.mjs to checkExplicitIdCreateModules()'s own `skipped`
    // bookkeeping -- see the next test for a direct proof that the exemption
    // itself works when the exempt path IS offered.
    assert.deepStrictEqual(skipped, [], 'nothing exempt is offered to the default scan (already filtered upstream)');
});

test('checkExplicitIdCreateModules() consumes explicitIdCreateModulePaths()/EXPLICIT_ID_CREATE_EXEMPT, not a private list (AC4)', () => {
    const { files } = checkExplicitIdCreateModules(explicitIdCreateModulePaths());
    assert.deepStrictEqual(
        files,
        guardedModuleBasenames().filter((name) => !EXPLICIT_ID_CREATE_EXEMPT.includes(name)),
        'passing explicitIdCreateModulePaths() explicitly must produce the same scan set as the default'
    );
    check(!files.includes('beads-children.mjs'), 'the exempt module must never even be scanned');
});

test('beads-children.mjs is skipped (not scanned) even if offered directly, exempted by name via EXPLICIT_ID_CREATE_EXEMPT', () => {
    const beadsChildrenPath = guardedModulePath('beads-children.mjs');
    const { violations, files, skipped } = checkExplicitIdCreateModules([beadsChildrenPath]);
    assert.deepStrictEqual(files, [], 'beads-children.mjs must never be scanned, even when passed explicitly');
    assert.deepStrictEqual(skipped, ['beads-children.mjs'], 'the exempt module must be reported as skipped');
    assert.deepStrictEqual(violations, [], 'a skipped module contributes no violations');
});

test('explicit-id-create guard fails on a fixture that reintroduces an unguarded bd create site (AC2)', () => {
    const { violations } = checkExplicitIdCreatePath(NON_COMPLIANT_FIXTURE);
    check(violations.length === 1, `Expected exactly one violation in the non-compliant fixture, got: ${JSON.stringify(violations, null, 2)}`);
    check(violations[0].includes('non-compliant.mjs:21'), `Violation must name the offending file and line, got: ${violations[0]}`);
    check(violations[0].includes('bd create'), `Violation must quote the offending command, got: ${violations[0]}`);
    check(
        violations[0].includes('beads-children.mjs') && violations[0].includes('assertChildIdFree'),
        `Violation must point at the required probe-and-refuse seam, got: ${violations[0]}`
    );
});

test('explicit-id-create guard passes on a fixture that only mentions bd create in a comment/import, or routes through the helper (AC3)', () => {
    const { violations } = checkExplicitIdCreatePath(COMPLIANT_FIXTURE);
    check(violations.length === 0, `Expected zero violations against a comment-only/helper-routed mention, got: ${JSON.stringify(violations, null, 2)}`);
});

test('findExplicitIdCreateViolations: an interpolated id flag (no literal --id text) is still flagged', () => {
    const src = [
        'function f(title, id, member) {',
        '    return command(`bd create "${title}" ${idFlags(id)} --silent`, { member_name: member });',
        '}',
    ].join('\n');
    const violations = findExplicitIdCreateViolations(src);
    check(violations.length === 1, `Expected exactly one violation, got: ${JSON.stringify(violations)}`);
    check(violations[0].line === 2, `Expected the violation on line 2, got: ${JSON.stringify(violations[0])}`);
});

test('findExplicitIdCreateViolations: a full-line comment mentioning bd create is never a violation', () => {
    const src = [
        "// see beads-children.mjs -- it issues 'bd create ... --id ...'",
        '   * bd create is handled by createChildBeadWithAllocatedId now',
    ].join('\n');
    const violations = findExplicitIdCreateViolations(src);
    check(violations.length === 0, `Expected no violations for comment-only lines, got: ${JSON.stringify(violations)}`);
});

test('findExplicitIdCreateViolations: an agent() call mentioning bd create is never a violation (only command() dispatches bd)', () => {
    const src = "agent('reviewer', { prompt: \"never run bd create directly\" });";
    const violations = findExplicitIdCreateViolations(src);
    check(violations.length === 0, `Expected no violation for an agent() call, got: ${JSON.stringify(violations)}`);
});

// =============================================================================
// FALSIFICATION: prove the guard actually detects a violation rather than
// passing vacuously, by neutering the rule the same way a regression would --
// pointing the aggregate scan at the non-compliant fixture instead of the
// exempt module's real file.
// =============================================================================

test('falsification: pointing the aggregate scan at the non-compliant fixture set makes it fail', () => {
    const { violations } = checkExplicitIdCreateModules([NON_COMPLIANT_FIXTURE]);
    check(violations.length === 1, `Expected the aggregate scan to surface the fixture violation, got: ${JSON.stringify(violations, null, 2)}`);
});

test('checkExplicitIdCreateModules() rejects a non-array argument rather than silently scanning nothing', () => {
    assert.throws(() => checkExplicitIdCreateModules(NON_COMPLIANT_FIXTURE), /must be an array/);
});
