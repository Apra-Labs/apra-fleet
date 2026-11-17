import { test, describe } from 'node:test';
import assert from 'node:assert';
import { buildAnalysisText, formatRegressionHeadline } from '../fleet-sprint/sprint-report.mjs';

const base = {
    targetIssues: ['PROJ-1'], branch: 'feat/x', baseBranch: 'main', cyclesRun: 1,
    closedCountHistory: [1], highWaterClosedCount: 1, deployFailures: [], integFailures: [],
    rejectedNewTasks: [], finalVerdictResult: { status: 'PASS', notes: '' },
    finalClosedCount: 1, finalOpenAtGoalCount: 0,
};
const sha = '0123456789abcdef0123456789abcdef01234567';

describe('sprint report: regression verdict', () => {
    test('verdict INCONCLUSIVE renders "Regression: INCONCLUSIVE", never FAILED', () => {
        const text = buildAnalysisText({
            ...base,
            regressionResult: {
                passed: false, verdict: 'INCONCLUSIVE', testedSha: sha,
                sections: [{ name: 'Suite', passed: false }], bugsFiled: [], summary: 's',
            },
        });
        assert.match(text, /Regression: INCONCLUSIVE @ 0123456789ab \(Suite: fail\)\./);
        assert.doesNotMatch(text, /FAILED/);
    });

    test('verdict line carries evidence counts and the run URL when present', () => {
        const line = formatRegressionHeadline({
            passed: false, verdict: 'FAIL', testedSha: sha, bugsFiled: [], summary: 's',
            evidence: { runUrl: 'https://ci.example/run/7', newFailures: ['a', 'b'], inventoryMissing: [] },
        });
        assert.strictEqual(line, 'Regression: FAIL @ 0123456789ab [2 new failure(s), 0 inventory missing] https://ci.example/run/7');
    });

    test('verdict without testedSha omits the sha', () => {
        assert.strictEqual(formatRegressionHeadline({ passed: true, verdict: 'PASS' }), 'Regression: PASS');
    });

    test('no verdict keeps the legacy PASSED/FAILED line', () => {
        const text = buildAnalysisText({
            ...base,
            regressionResult: { passed: false, sections: [{ name: 'Suite', passed: false }], bugsFiled: ['BD-1'], summary: 's' },
        });
        assert.match(text, /Regression pass: FAILED \(Suite: fail\)\./);
    });
});
