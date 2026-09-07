import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'node:fs';
import os from 'node:os';
import { checkDoltLiteralPath, checkDoltLiteralModules, findDoltLiteralViolations } from '../fleet-sprint/dolt-literal-guard.mjs';
import { doltLiteralModulePaths } from '../fleet-sprint/guarded-modules.mjs';

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

// =============================================================================
// SHARED GUARDED-MODULE LIST (fleet-sprint/guarded-modules.mjs).
//
// checkDoltLiteralPath() above is the single-file entry point, kept and
// unchanged. What follows exercises checkDoltLiteralModules(), which reads the
// SHARED list -- the single place a newly extracted fleet-sprint module is
// registered -- and defines no list of its own, so a dolt command that moves
// out of runner.js into a new module cannot silently fall out of coverage.
// =============================================================================

test('checkDoltLiteralModules() over the shared list is clean today and defines no list of its own', () => {
    const { violations, files, skipped } = checkDoltLiteralModules();
    assert.deepStrictEqual(files, ['runner.js'], 'the default scan set is the shared list, minus dolt-literal exemptions');
    assert.deepStrictEqual(skipped, [], 'nothing exempt is registered in the shared list today');
    assert.deepStrictEqual(violations, [], `Expected zero direct dolt literals across the guarded modules, got: ${JSON.stringify(violations, null, 2)}`);
});

test('dolt-sync.mjs is excluded from the dolt-literal list, while byte-identical content under another name is not', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dolt-literal-list-'));
    try {
        // The REAL sync module's source, copied verbatim under two names.
        // dolt-sync.mjs legitimately builds `bd dolt pull`/`bd dolt push`
        // command strings -- it is the single permitted dolt command surface --
        // so the exemption must be by NAME, mechanically enforced, not by
        // whoever happens to wire up the call.
        const syncSrc = fs.readFileSync(path.join(__dirname, '../fleet-sprint/dolt-sync.mjs'), 'utf8');
        const exempt = path.join(dir, 'dolt-sync.mjs');
        const impostor = path.join(dir, 'not-the-sync-module.mjs');
        fs.writeFileSync(exempt, syncSrc, 'utf8');
        fs.writeFileSync(impostor, syncSrc, 'utf8');

        // Sanity: the copied source really does contain dolt literals, so the
        // exemption below is doing work rather than passing vacuously.
        const rawFindings = findDoltLiteralViolations(syncSrc);
        check(rawFindings.length > 0, 'dolt-sync.mjs must actually contain dolt literals for this test to mean anything');

        const exemptRun = checkDoltLiteralModules(doltLiteralModulePaths([exempt]));
        assert.deepStrictEqual(exemptRun.violations, [], `dolt-sync.mjs must be exempt, got: ${JSON.stringify(exemptRun.violations, null, 2)}`);
        check(!exemptRun.files.includes('dolt-sync.mjs'), 'dolt-sync.mjs must never even be scanned');

        const impostorRun = checkDoltLiteralModules(doltLiteralModulePaths([impostor]));
        check(
            impostorRun.violations.length === rawFindings.length,
            `identical content under another name must still be flagged, got: ${JSON.stringify(impostorRun.violations, null, 2)}`
        );
        check(
            impostorRun.violations.every((v) => v.startsWith('not-the-sync-module.mjs:')),
            `each violation must be attributed to the fixture's own filename, got: ${JSON.stringify(impostorRun.violations, null, 2)}`
        );

        // Belt and braces: the exemption holds even if someone passes the
        // exempt path straight through, bypassing doltLiteralModulePaths().
        assert.deepStrictEqual(checkDoltLiteralModules([exempt]).violations, []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('adding a newly extracted module to the shared list makes the dolt-literal guard scan it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dolt-literal-list-'));
    const fixture = path.join(dir, 'extracted-module.mjs');
    try {
        fs.writeFileSync(
            fixture,
            [
                "import { doltPushAfter } from './dolt-sync.mjs';",
                '',
                'export async function sync(command, member) {',
                "    await command('bd dolt push', { member_name: member });",
                '}',
            ].join('\n'),
            'utf8'
        );
        const { violations, files } = checkDoltLiteralModules(doltLiteralModulePaths([fixture]));
        assert.deepStrictEqual(files, ['runner.js', 'extracted-module.mjs']);
        check(violations.length === 1, `expected exactly one violation, got: ${JSON.stringify(violations, null, 2)}`);
        check(violations[0].startsWith('extracted-module.mjs:4'), `violation must name the fixture's own file and line, got: ${violations[0]}`);

        // Clear the seeded violation -> clean report.
        fs.writeFileSync(
            fixture,
            [
                "import { doltPushAfter } from './dolt-sync.mjs';",
                '',
                'export async function sync(command, member) {',
                '    await doltPushAfter({ command, member });',
                '}',
            ].join('\n'),
            'utf8'
        );
        assert.deepStrictEqual(checkDoltLiteralModules(doltLiteralModulePaths([fixture])).violations, []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('checkDoltLiteralModules() rejects a non-array argument rather than silently scanning nothing', () => {
    assert.throws(() => checkDoltLiteralModules(RUNNER_PATH), /must be an array/);
});
