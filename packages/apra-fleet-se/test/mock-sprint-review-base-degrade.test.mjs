// Review diff base failures are not sprint-fatal at a per-round review, and
// Final Review retries once before failing loudly with a relaunch hint.
//
// - Per-round: a failed `git merge-base origin/<base> <branch>` degrades the
//   round (synthesized CHANGES_NEEDED, dispatchFailed) exactly like the
//   reviewer ladder's own sync-bracket failure; the reviewer is not
//   dispatched for that round and the run continues.
// - Final Review: one failed attempt is retried; a second failure ends the
//   run with a loud [Review Base] error that says no work is lost and how to
//   relaunch. Never a fallback to the local base branch.
//
// ASCII only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, mockCmdResult, MOCK_REVIEW_MERGE_BASE_SHA } from './helpers/mock-sprint-harness.mjs';

const MERGE_BASE_RE = /^git merge-base origin\/\S+ \S+\s*$/;
const FETCH_BASE_RE = /^git fetch origin main$/;

/**
 * onCommand hook that fails selected review-base merge-base calls.
 * `failFirstPerRound`: fail the first merge-base of the run (a per-round review).
 * `finalFailures`: how many Final Review attempts fail (1 = transient, 2 = both).
 * A Final Review merge-base is recognised by the command just before its
 * fetch: Final Review reads `bd list --status=closed ...` immediately before.
 */
function reviewBaseFailer({ failFirstPerRound, finalFailures }) {
    // One resolve = `git fetch origin main` then the merge-base (which
    // runGitStep may itself retry once). Every merge-base of a failing
    // resolve fails, so runGitStep's own retry cannot mask the failure.
    let last = '';
    let resolves = 0;
    let finalAttempts = 0;
    let failing = false;
    const calls = { failedPerRound: 0, failedFinal: 0 };
    const fail = () => mockCmdResult(1, '', 'fatal: Not a valid object name origin/main');
    const onCommand = async ({ command }) => {
        const before = last;
        last = command;
        if (FETCH_BASE_RE.test(command)) {
            resolves += 1;
            const isFinalFirst = /^bd list --status=closed\b/.test(before);
            const isFinalRetry = finalAttempts > 0 && MERGE_BASE_RE.test(before);
            if (isFinalFirst || isFinalRetry) {
                finalAttempts += 1;
                failing = finalAttempts <= finalFailures;
                if (failing) calls.failedFinal += 1;
            } else {
                failing = failFirstPerRound && resolves === 1;
                if (failing) calls.failedPerRound += 1;
            }
            return undefined;
        }
        if (MERGE_BASE_RE.test(command) && failing) return fail();
        return undefined;
    };
    return { onCommand, calls };
}

test('per-round review-base failure degrades the round, and a transient Final Review failure is retried and completes', async () => {
    await withScenarioMarkers('reviewbasedegrade', async () => {
        const { onCommand, calls } = reviewBaseFailer({ failFirstPerRound: true, finalFailures: 1 });
        const run = await runDevelopLoopScenario('reviewbasedegrade', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: review base degrade scenario work' }],
            maxCycles: 2,
            onCommand,
        });
        assert.equal(run.error, null, `run must not abort: ${run.error && run.error.message}`);
        assert.equal(calls.failedPerRound, 1, 'the first per-round merge-base must have been failed');
        assert.equal(calls.failedFinal, 1, 'the first Final Review attempt must have been failed');
        assert.ok(
            run.logs.some((m) => m.includes('Reviewer: review diff base failed, degrading') && m.includes('NOT dispatched')),
            `expected the degraded-round log line, logs: ${JSON.stringify(run.logs)}`,
        );
        assert.ok(
            run.logs.some((m) => m.includes('[Review Base] Final Review: could not compute the review diff base') && m.includes('retrying once')),
            'expected the Final Review retry log line',
        );
        const reviews = run.dispatched.filter((d) => d.agent === 'reviewer');
        const final = reviews.filter((d) => d.label === 'Final Review');
        assert.equal(final.length, 1, 'Final Review must be dispatched once, after the retry');
        for (const d of reviews) {
            assert.ok(d.prompt.includes(`${MOCK_REVIEW_MERGE_BASE_SHA}..${run.branch}`), 'every dispatched review names the merge-base range');
            assert.ok(!d.prompt.includes(`main..${run.branch}`), 'no dispatched review names the bare base range');
        }
    });
});

test('Final Review review-base failing twice ends the run loudly with a relaunch hint and no Final Review dispatch', async () => {
    await withScenarioMarkers('reviewbasefinalfail', async () => {
        const { onCommand, calls } = reviewBaseFailer({ failFirstPerRound: false, finalFailures: 2 });
        const run = await runDevelopLoopScenario('reviewbasefinalfail', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: review base final failure scenario work' }],
            maxCycles: 2,
            onCommand,
        });
        assert.equal(calls.failedFinal, 2, 'both Final Review attempts must have been failed');
        assert.ok(run.error, 'the run must end with an error');
        const msg = run.error.message;
        assert.match(msg, /\[Review Base\] Final Review was NOT dispatched/);
        assert.match(msg, /never falls back to the local 'main' branch/);
        assert.match(msg, /No work is lost/);
        assert.ok(msg.includes(`relaunch the sprint on the same branch '${run.branch}' with base 'main'`), msg);
        assert.equal(run.dispatched.filter((d) => d.label === 'Final Review').length, 0, 'Final Review must not be dispatched');
    });
});
