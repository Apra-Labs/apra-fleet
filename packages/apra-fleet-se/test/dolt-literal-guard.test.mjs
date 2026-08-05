import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkDoltLiteralPath, findDoltLiteralViolations } from '../fleet-sprint/dolt-literal-guard.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// apra-fleet-417.2.3 -- dolt-literal guard test.
//
// Invariant under test: NO line in packages/apra-fleet-se/fleet-sprint/
// runner.js may issue a direct `bd dolt pull` or `bd dolt push` command --
// every dolt sync call must route through ./dolt-sync.mjs (the single
// permitted dolt command surface, apra-fleet-417.2.1/417.2.2's
// consolidation). This locks that invariant in at the source level so a
// future edit cannot silently re-inline a dolt command in runner.js.
//
// The checker itself (findDoltLiteralViolations/checkDoltLiteralPath) lives
// in ../fleet-sprint/dolt-literal-guard.mjs, parameterizable by path, so it
// can be pointed at a fixture that deliberately violates the invariant --
// proving the guard actually fails on a reintroduced literal rather than
// passing vacuously -- WITHOUT mutating runner.js to manufacture that
// failure case (test/fixtures/dolt-literal-guard/{non-compliant,compliant}.mjs).
// =============================================================================

const RUNNER_PATH = path.join(__dirname, '../fleet-sprint/runner.js');
const NON_COMPLIANT_FIXTURE = path.join(__dirname, 'fixtures/dolt-literal-guard/non-compliant.mjs');
const COMPLIANT_FIXTURE = path.join(__dirname, 'fixtures/dolt-literal-guard/compliant.mjs');

const check = (cond, msg) => assert.ok(cond, msg);

test('dolt-literal guard passes on the migrated runner.js tree (AC2)', () => {
    const { violations } = checkDoltLiteralPath(RUNNER_PATH);
    check(
        violations.length === 0,
        `Expected zero direct 'bd dolt pull'/'bd dolt push' literals in runner.js, found: ${JSON.stringify(violations, null, 2)}`
    );
});

test('dolt-literal guard fails on a fixture that reintroduces a direct dolt literal (AC1)', () => {
    const { violations } = checkDoltLiteralPath(NON_COMPLIANT_FIXTURE);
    check(violations.length === 1, `Expected exactly one violation in the non-compliant fixture, got: ${JSON.stringify(violations, null, 2)}`);
    check(violations[0].includes('non-compliant.mjs:15'), `Violation must name the offending file and line, got: ${violations[0]}`);
    check(violations[0].includes('bd dolt push'), `Violation must quote the offending literal, got: ${violations[0]}`);
    check(
        violations[0].includes('./dolt-sync.mjs') && violations[0].includes('DoltSync'),
        `Violation must point at the sync module as the required entry point, got: ${violations[0]}`
    );
});

test('dolt-literal guard passes on a fixture that only mentions the literal in a comment or the sync-module import (no false positive)', () => {
    const { violations } = checkDoltLiteralPath(COMPLIANT_FIXTURE);
    check(violations.length === 0, `Expected zero violations against a comment-only/import-only mention, got: ${JSON.stringify(violations, null, 2)}`);
});

test('findDoltLiteralViolations: a full-line comment mentioning the literal is never a violation', () => {
    const src = [
        "// see ./dolt-sync.mjs -- it issues 'bd dolt pull' and 'bd dolt push'",
        '   * bd dolt push is handled by DoltSync now',
    ].join('\n');
    const violations = findDoltLiteralViolations(src);
    check(violations.length === 0, `Expected no violations for comment-only lines, got: ${JSON.stringify(violations)}`);
});

test("findDoltLiteralViolations: an import/require line referencing dolt-sync is never a violation, even if it mentions the literal in a trailing comment", () => {
    const src = "import { doltPushAfter } from './dolt-sync.mjs'; // wraps 'bd dolt push'";
    const violations = findDoltLiteralViolations(src);
    check(violations.length === 0, `Expected no violation for a dolt-sync import line, got: ${JSON.stringify(violations)}`);
});

test('findDoltLiteralViolations: a live command() call carrying the literal is flagged, naming the exact line', () => {
    const src = [
        'function f(member) {',
        "    return command('bd dolt pull', { member_name: member });",
        '}',
    ].join('\n');
    const violations = findDoltLiteralViolations(src);
    check(violations.length === 1, `Expected exactly one violation, got: ${JSON.stringify(violations)}`);
    check(violations[0].line === 2, `Expected the violation on line 2, got: ${JSON.stringify(violations[0])}`);
});
