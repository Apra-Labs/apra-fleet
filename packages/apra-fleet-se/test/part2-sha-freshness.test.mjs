import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractPart2Sha, validatePart2Evidence } from '../auto-sprint/runner.js';

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

// apra-fleet-eft.55.3: regression pin for eft.55.2's engine-side report
// validation, exercised at the level a live cycle actually sees it -- a full
// mock integ report shaped like the real integ-test-runner output schema
// (featuresClosed/issuesCreated/passed/bugsFiled/summary; see
// FALLBACK_integReport in auto-sprint/contracts.mjs), not just a bare
// { summary } stub. Confirms the engine's report validation (a) rejects a
// report whose part-2 evidence cites a stale (mismatched) SHA as
// INCONCLUSIVE, (b) rejects one with no SHA marker at all as INCONCLUSIVE,
// distinct from a pass/fail verdict, and (c) accepts a matching-SHA report
// unchanged -- `passed` and the rest of the report fields flow through
// untouched, mirroring the passed !== true / inconclusive branching in
// runner.js's cycle loop (see validatePart2Evidence call site).
describe('engine report validation with a full mock integ report (eft.55.3 pin)', () => {
    function mockIntegReport(summary, overrides = {}) {
        return {
            featuresClosed: 2,
            issuesCreated: 0,
            passed: true,
            bugsFiled: [],
            summary,
            ...overrides,
        };
    }

    test('a mock integ report with a stale part-2 SHA is rejected as inconclusive', () => {
        const deployedSha = 'c0ffee1'.repeat(5).slice(0, 40);
        const staleSha = 'deadbeef'.repeat(5).slice(0, 40);
        const report = mockIntegReport(`Ran the full playbook, all green. PART2_SHA: ${staleSha}`);
        const result = validatePart2Evidence(report, deployedSha);
        assert.strictEqual(result.inconclusive, true);
        assert.strictEqual(result.reason, 'mismatched');
        assert.strictEqual(result.reportedSha, staleSha);
        // Not silently accepted as a pass just because the mock report says
        // passed:true -- the report object itself is left unchanged; it's
        // the caller (runner.js's cycle loop) that must treat `inconclusive`
        // as taking precedence over `passed`.
        assert.strictEqual(report.passed, true);
    });

    test('a mock integ report with an absent part-2 SHA is rejected as inconclusive', () => {
        const deployedSha = 'c0ffee1'.repeat(5).slice(0, 40);
        const report = mockIntegReport('Ran the full playbook, all green. No SHA marker recorded.');
        const result = validatePart2Evidence(report, deployedSha);
        assert.strictEqual(result.inconclusive, true);
        assert.strictEqual(result.reason, 'absent');
        assert.strictEqual(result.reportedSha, null);
    });

    test('a matching-SHA mock integ report is accepted unchanged', () => {
        const deployedSha = 'c0ffee1'.repeat(5).slice(0, 40);
        const report = mockIntegReport(`Ran the full playbook, all green. PART2_SHA: ${deployedSha}`);
        const result = validatePart2Evidence(report, deployedSha);
        assert.strictEqual(result.inconclusive, false);
        assert.strictEqual(result.reason, null);
        assert.strictEqual(result.reportedSha, deployedSha);
        // The report itself is untouched -- validatePart2Evidence never
        // mutates its input.
        assert.deepStrictEqual(report, mockIntegReport(`Ran the full playbook, all green. PART2_SHA: ${deployedSha}`));
    });
});

describe('validatePart2Evidence', () => {
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
