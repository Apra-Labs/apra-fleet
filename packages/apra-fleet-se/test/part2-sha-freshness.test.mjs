import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPart2Sha, validatePart2Evidence } from '../auto-sprint/runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Captures every console.warn call made during `fn()`, restoring the real
 * console.warn afterward regardless of outcome. Mirrors the helper of the
 * same name in contracts-schema-observability.test.mjs.
 * @param {() => void} fn
 * @returns {string[]} one joined string per console.warn call
 */
function withCapturedWarnings(fn) {
    const calls = [];
    const original = console.warn;
    console.warn = (...args) => {
        calls.push(args.join(' '));
    };
    try {
        fn();
    } finally {
        console.warn = original;
    }
    return calls;
}

// apra-fleet-eft.55.2: run 19 Integ C5 saw a resumed integ-test-runner
// session reuse a part-2 (smoke test) result executed BEFORE the cycle's
// fixes were deployed, then issue verification verdicts from that stale
// evidence. The engine now hands the runner this cycle's deploy-verified
// SHA and requires the report to echo it back via a "PART2_SHA: <sha>"
// marker in `summary`; validatePart2Evidence checks that marker against the
// deploy-verified SHA and flags an absent/mismatched SHA as INCONCLUSIVE
// (never silently treated as pass or fail).

describe('extractPart2Sha', () => {
    test('extracts a full 40-char SHA from the marker, lowercased', () => {
        const summary = `Ran part 1 and part 2. PART2_SHA: ${'A'.repeat(40)}`;
        assert.strictEqual(extractPart2Sha(summary), 'a'.repeat(40));
    });

    test('extracts a short SHA from the marker', () => {
        assert.strictEqual(extractPart2Sha('All good. PART2_SHA: 19a84a1'), '19a84a1');
    });

    test('is case-insensitive on the marker label itself', () => {
        assert.strictEqual(extractPart2Sha('part2_sha: abc1234'), 'abc1234');
    });

    test('returns null when no marker is present', () => {
        assert.strictEqual(extractPart2Sha('Ran part 1 and part 2, all green.'), null);
    });

    test('returns null for non-string input without throwing', () => {
        assert.doesNotThrow(() => extractPart2Sha(undefined));
        assert.strictEqual(extractPart2Sha(undefined), null);
        assert.strictEqual(extractPart2Sha(null), null);
        assert.strictEqual(extractPart2Sha(12345), null);
    });
});

// apra-fleet-eft.55.3 / apra-fleet-eft.66.2: regression pin for the engine's
// report validation, exercised at the level a live cycle actually sees it --
// a full mock integ report shaped like the real integ-test-runner output
// schema (featuresClosed/issuesCreated/passed/bugsFiled/summary/deployedSha;
// see FALLBACK_integReport in auto-sprint/contracts.mjs and
// agents/schemas/integ-test-runner-output.json), not just a bare
// { summary } stub.
//
// Updated for eft.66/eft.66.1's field-first semantics: the structured
// `deployedSha` report field is now the PRIMARY evidence source; the legacy
// `PART2_SHA: <sha>` summary-marker grep only fires when that field is
// absent. This describe block covers both the field-first path (mirroring a
// current, upgraded integ-test-runner build) and the legacy marker-only
// fallback path (mirroring a pre-upgrade build), confirming: (a) a report
// with a structured field is validated on the FIELD alone, never consulting
// the marker grep -- proven by giving the two conflicting values and
// checking the field wins; (b) a report with no field falls back to the
// marker grep AND logs a one-line deprecation warning; (c) a mismatched or
// absent SHA (by either path) is rejected as INCONCLUSIVE, distinct from a
// pass/fail verdict, mirroring the passed !== true / inconclusive branching
// in runner.js's cycle loop (see validatePart2Evidence call site).
describe('engine report validation with a full mock integ report (eft.55.3 / eft.66.2 pin)', () => {
    function mockIntegReport(overrides = {}) {
        return {
            featuresClosed: 2,
            issuesCreated: 0,
            passed: true,
            bugsFiled: [],
            summary: 'Ran the full playbook, all green.',
            ...overrides,
        };
    }

    test('field-first: a matching structured deployedSha is accepted, with no summary marker present', () => {
        const deployedSha = 'c0ffee1'.repeat(5).slice(0, 40);
        const report = mockIntegReport({ deployedSha });
        const warnings = withCapturedWarnings(() => {
            const result = validatePart2Evidence(report, deployedSha);
            assert.strictEqual(result.inconclusive, false);
            assert.strictEqual(result.reason, null);
            assert.strictEqual(result.reportedSha, deployedSha);
        });
        // The field satisfied validation on its own -- the legacy marker
        // fallback (and its deprecation warning) must never have fired.
        assert.deepStrictEqual(warnings, []);
        // The report itself is untouched -- validatePart2Evidence never
        // mutates its input.
        assert.deepStrictEqual(report, mockIntegReport({ deployedSha }));
    });

    test('field-first: the structured deployedSha field wins even when the free-text summary carries a conflicting stale marker (proves the marker is not grepped when the field is present)', () => {
        const deployedSha = 'c0ffee1'.repeat(5).slice(0, 40);
        const staleSha = 'deadbeef'.repeat(5).slice(0, 40);
        const report = mockIntegReport({
            deployedSha,
            summary: `Ran the full playbook, all green. PART2_SHA: ${staleSha}`,
        });
        const warnings = withCapturedWarnings(() => {
            // If runner.js ever reverts to marker-first, this would read the
            // stale marker instead of the matching field and come back
            // inconclusive/mismatched -- so this assertion is the direct
            // regression guard for that revert.
            const result = validatePart2Evidence(report, deployedSha);
            assert.strictEqual(result.inconclusive, false);
            assert.strictEqual(result.reason, null);
            assert.strictEqual(result.reportedSha, deployedSha);
        });
        assert.deepStrictEqual(warnings, []);
    });

    test('legacy fallback: a report with no structured field but a stale part-2 marker is rejected as inconclusive, and a deprecation warning is logged', () => {
        const deployedSha = 'c0ffee1'.repeat(5).slice(0, 40);
        const staleSha = 'deadbeef'.repeat(5).slice(0, 40);
        const report = mockIntegReport({ summary: `Ran the full playbook, all green. PART2_SHA: ${staleSha}` });
        let result;
        const warnings = withCapturedWarnings(() => {
            result = validatePart2Evidence(report, deployedSha);
        });
        assert.strictEqual(result.inconclusive, true);
        assert.strictEqual(result.reason, 'mismatched');
        assert.strictEqual(result.reportedSha, staleSha);
        // Not silently accepted as a pass just because the mock report says
        // passed:true -- the report object itself is left unchanged; it's
        // the caller (runner.js's cycle loop) that must treat `inconclusive`
        // as taking precedence over `passed`.
        assert.strictEqual(report.passed, true);
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], /\[deprecated\]/);
        assert.match(warnings[0], /deployedSha/);
    });

    test('legacy fallback: a report with no structured field and no marker at all is rejected as inconclusive, with no deprecation warning (nothing legacy was found either)', () => {
        const deployedSha = 'c0ffee1'.repeat(5).slice(0, 40);
        const report = mockIntegReport({ summary: 'Ran the full playbook, all green. No SHA recorded anywhere.' });
        let result;
        const warnings = withCapturedWarnings(() => {
            result = validatePart2Evidence(report, deployedSha);
        });
        assert.strictEqual(result.inconclusive, true);
        assert.strictEqual(result.reason, 'absent');
        assert.strictEqual(result.reportedSha, null);
        // No marker was found, so there is nothing deprecated to warn about.
        assert.deepStrictEqual(warnings, []);
    });

    test('legacy fallback: a report with no structured field but a matching legacy marker is accepted, and still logs the deprecation warning', () => {
        const deployedSha = 'c0ffee1'.repeat(5).slice(0, 40);
        const report = mockIntegReport({ summary: `Ran the full playbook, all green. PART2_SHA: ${deployedSha}` });
        let result;
        const warnings = withCapturedWarnings(() => {
            result = validatePart2Evidence(report, deployedSha);
        });
        assert.strictEqual(result.inconclusive, false);
        assert.strictEqual(result.reason, null);
        assert.strictEqual(result.reportedSha, deployedSha);
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], /\[deprecated\]/);
    });
});

// apra-fleet-eft.66.2: the dispatch/golden fixture must ASK for the
// structured `deployedSha` output field (not just accept it if volunteered).
// This pins two things statically, so a revert is caught even though no
// golden-transcript scenario currently has a non-null deployedSha in-flight
// (the existing fixture's part-2 cycle runs before any deploy succeeds):
//   (a) runner.js's Part-2 dispatch clause (the `part2ShaClause` template
//       literal built in runSprintCycle right before the integ-test-runner
//       dispatch) instructs the runner to record the SHA in the structured
//       `deployedSha` output field, not the legacy `PART2_SHA:` prose marker.
//   (b) the vendored integ-test-runner output schema fixture actually
//       defines a `deployedSha` property, so a role obeying (a) has
//       somewhere schema-valid to put it.
describe('dispatch/golden fixture requests the deployedSha field (eft.66.2)', () => {
    const runnerSource = fs.readFileSync(
        path.join(__dirname, '..', 'auto-sprint', 'runner.js'),
        'utf8'
    );

    test('the Part-2 dispatch clause in runner.js asks for the structured deployedSha output field', () => {
        assert.match(runnerSource, /part2ShaClause/);
        assert.match(runnerSource, /your report's "deployedSha" output field/);
    });

    test('the vendored integ-test-runner output schema fixture declares a deployedSha property', () => {
        const schemaPath = path.join(
            __dirname,
            '..',
            'apra-pm',
            'agents',
            'schemas',
            'integ-test-runner-output.json'
        );
        const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
        assert.ok(schema.properties && schema.properties.deployedSha, 'expected a deployedSha property on the integ-test-runner output schema');
        assert.strictEqual(schema.properties.deployedSha.type, 'string');
    });
});

describe('validatePart2Evidence', () => {
    test('field-first happy path: a structured deployedSha field (no summary marker at all) is accepted', () => {
        const sha = '19a84a1b'.repeat(5); // 40 chars
        const result = validatePart2Evidence({ deployedSha: sha, summary: 'All good.' }, sha);
        assert.strictEqual(result.inconclusive, false);
        assert.strictEqual(result.reason, null);
        assert.strictEqual(result.reportedSha, sha);
    });

    test('field-first: a mismatched structured deployedSha field is INCONCLUSIVE even with no marker in summary', () => {
        const deployedSha = 'a'.repeat(40);
        const staleSha = 'b'.repeat(40);
        const result = validatePart2Evidence({ deployedSha: staleSha, summary: 'All good, no marker here.' }, deployedSha);
        assert.strictEqual(result.inconclusive, true);
        assert.strictEqual(result.reason, 'mismatched');
        assert.strictEqual(result.reportedSha, staleSha);
    });

    test('field absent, legacy marker present: falls back to the marker AND logs a one-line deprecation warning', () => {
        const sha = '19a84a1b'.repeat(5);
        let result;
        const warnings = withCapturedWarnings(() => {
            result = validatePart2Evidence({ summary: `All good. PART2_SHA: ${sha}` }, sha);
        });
        assert.strictEqual(result.inconclusive, false);
        assert.strictEqual(result.reportedSha, sha);
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], /\[deprecated\]/i);
    });

    test('happy path: matching full SHA is accepted (not inconclusive)', () => {
        const sha = '19a84a1b'.repeat(5); // 40 chars
        const result = validatePart2Evidence({ summary: `All good. PART2_SHA: ${sha}` }, sha);
        assert.strictEqual(result.inconclusive, false);
        assert.strictEqual(result.reason, null);
        assert.strictEqual(result.reportedSha, sha);
    });

    test('happy path: a short reported SHA matching the deployed SHA prefix is accepted', () => {
        const deployedSha = '19a84a1bcccccccccccccccccccccccccccccccccccc'.slice(0, 40);
        const result = validatePart2Evidence({ summary: `PART2_SHA: ${deployedSha.slice(0, 7)}` }, deployedSha);
        assert.strictEqual(result.inconclusive, false);
    });

    test('happy path: case differences between reported and deployed SHA are tolerated', () => {
        const deployedSha = 'a'.repeat(40);
        const result = validatePart2Evidence({ summary: `PART2_SHA: ${'A'.repeat(40)}` }, deployedSha);
        assert.strictEqual(result.inconclusive, false);
    });

    test('absent marker is INCONCLUSIVE, distinct from pass/fail', () => {
        const result = validatePart2Evidence({ summary: 'All tests passed.' }, 'deadbeef'.repeat(5));
        assert.strictEqual(result.inconclusive, true);
        assert.strictEqual(result.reason, 'absent');
        assert.strictEqual(result.reportedSha, null);
    });

    test('mismatched SHA is INCONCLUSIVE, distinct from pass/fail', () => {
        const deployedSha = 'a'.repeat(40);
        const staleSha = 'b'.repeat(40);
        const result = validatePart2Evidence({ summary: `PART2_SHA: ${staleSha}` }, deployedSha);
        assert.strictEqual(result.inconclusive, true);
        assert.strictEqual(result.reason, 'mismatched');
        assert.strictEqual(result.reportedSha, staleSha);
    });

    test('null deployedSha (engine could not resolve this cycle) is never inconclusive -- falls back to plain pass/fail', () => {
        const result = validatePart2Evidence({ summary: 'All tests passed, no SHA marker.' }, null);
        assert.strictEqual(result.inconclusive, false);
        assert.strictEqual(result.reason, null);
    });

    test('missing/malformed integResult does not throw', () => {
        assert.doesNotThrow(() => validatePart2Evidence({}, 'a'.repeat(40)));
        assert.doesNotThrow(() => validatePart2Evidence(null, 'a'.repeat(40)));
        const result = validatePart2Evidence(null, 'a'.repeat(40));
        assert.strictEqual(result.inconclusive, true);
        assert.strictEqual(result.reason, 'absent');
    });
});
