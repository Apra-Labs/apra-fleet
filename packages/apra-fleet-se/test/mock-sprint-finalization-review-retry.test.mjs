import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-j6i.2: Final Review used to have zero retry on dispatch failure --
// a single transient failure on the sprint's LAST dispatch would flip an
// otherwise fully-successful sprint straight to verdict:FAIL. runner.js now
// retries the Final Review dispatch once before falling back to FAIL.
// =============================================================================
test('mock sprint: Final Review survives one transient dispatch failure via retry-once', async () => {
    await withScenarioMarkers('finalreviewretry', async () => {
        console.log('Running mock sprint scenario (Final Review retries once after a transient failure, then succeeds)...');
        let finalReviewCalls = 0;
        const finalReviewRetry = await runDevelopLoopScenario('finalreviewretry', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Final Review retry-once scenario work' }],
            maxCycles: 1,
            finalReviewHandler: async () => {
                finalReviewCalls++;
                // The first outer dispatch attempt exhausts schema-repair (default
                // maxRepairs=2, so 3 sub-attempts) by returning unparseable output --
                // this is what makes the FIRST `dispatchFinalReview()` call throw.
                // The retry's own first sub-attempt (call #4) then succeeds.
                if (finalReviewCalls <= 3) {
                    return { content: [{ text: 'not valid JSON, simulating a transient dispatch failure' }] };
                }
                return { content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'Approved after transient-failure retry.' }) }] };
            },
        });
        check(!finalReviewRetry.error, `Final-Review-retry scenario should not throw/reject the whole sprint: ${finalReviewRetry.error ? finalReviewRetry.error.message : ''}`);
        check(
            finalReviewRetry.result && finalReviewRetry.result.status === 'success',
            `Expected the sprint to succeed via the retry (not fall back to hardcoded FAIL), got: ${JSON.stringify(finalReviewRetry.result)}`
        );
        check(
            finalReviewRetry.result && finalReviewRetry.result.verdict === 'PASS' && finalReviewRetry.result.notes === 'Approved after transient-failure retry.',
            `Expected the retry's real PASS verdict/notes to be surfaced (not the hardcoded FAIL fallback text), got: ${JSON.stringify(finalReviewRetry.result)}`
        );
        check(
            finalReviewRetry.logs.some((m) => m.includes('Final Review: dispatch failed') && m.includes('Retrying once')),
            `Expected a logged "Final Review: dispatch failed ... Retrying once." message, logs: ${JSON.stringify(finalReviewRetry.logs)}`
        );
        check(
            !finalReviewRetry.logs.some((m) => m.includes('schema-repair exhausted after retry')),
            `Did NOT expect the "exhausted after retry" fallback message to fire, since the retry itself succeeded, logs: ${JSON.stringify(finalReviewRetry.logs)}`
        );
    });
});

// =============================================================================
// If BOTH the original dispatch and the one retry fail, Final Review must
// still fall back to the hardcoded FAIL verdict (not throw/crash the sprint) --
// the retry is a mitigation, not a guarantee.
// =============================================================================
test('mock sprint: Final Review falls back to hardcoded FAIL if the retry also fails', async () => {
    await withScenarioMarkers('finalreviewretryfail', async () => {
        console.log('Running mock sprint scenario (Final Review retry also fails -> hardcoded FAIL fallback)...');
        const finalReviewRetryFail = await runDevelopLoopScenario('finalreviewretryfail', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Final Review retry-also-fails scenario work' }],
            maxCycles: 1,
            finalReviewHandler: async () => ({ content: [{ text: 'always unparseable, both the original dispatch and the retry fail' }] }),
        });
        check(!finalReviewRetryFail.error, `Sprint should not throw/reject even when both Final Review attempts fail -- expected the FAIL fallback instead: ${finalReviewRetryFail.error ? finalReviewRetryFail.error.message : ''}`);
        check(
            finalReviewRetryFail.result && finalReviewRetryFail.result.status === 'failed',
            `Expected the hardcoded FAIL fallback to produce status:'failed', got: ${JSON.stringify(finalReviewRetryFail.result)}`
        );
        check(
            finalReviewRetryFail.logs.some((m) => m.includes('Final Review: dispatch failed') && m.includes('Retrying once')),
            `Expected the retry attempt to have been logged, logs: ${JSON.stringify(finalReviewRetryFail.logs)}`
        );
        check(
            finalReviewRetryFail.logs.some((m) => m.includes('schema-repair exhausted after retry, treating as FAIL')),
            `Expected the "exhausted after retry" fallback message once the retry itself also fails, logs: ${JSON.stringify(finalReviewRetryFail.logs)}`
        );
    });
});
