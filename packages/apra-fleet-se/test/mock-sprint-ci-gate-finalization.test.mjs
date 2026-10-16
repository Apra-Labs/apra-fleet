import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCiGateMockSprint, CI_SHA, LATER_SHA, RUN_URL } from './helpers/ci-gate-mock-sprint.mjs';

// =============================================================================
// ci_gate end to end: one full deterministic mock sprint with
// ci_gate {"workflow":"ci.yml"} and a fake CI REST surface (see
// helpers/ci-gate-mock-sprint.mjs).
//
// Proves, by running the real runner.js, the Finalization barrier ordering:
//   (1) the gate is STARTED at Finalization, before Final Review;
//   (2) Final Review runs while CI is still running (the fake CI holds its
//       answer until Final Review has been dispatched);
//   (3) the barrier then WAITS for CI: Regression Test, Harvest and Publish PR
//       all run only after the CI result is in (Regression moved behind the
//       barrier; it runs once, on the final head);
//   (4) a CI PASS triggers no extension: no Fix-CI bead, no extra cycle, one
//       CI run, no "Sprint extensions" PR section;
//   (5) Publish PR renders the awaited record (workflow, run url, sha, jobs)
//       and notes the later commit as not covered by CI;
//   (6) the sprint verdict is untouched.
// ASCII only.
// =============================================================================

test('mock sprint: the Finalization barrier awaits the CI gate after Final Review and before Regression/Harvest/Publish', { timeout: 300000 }, async () => {
    const { run, events, ciCalls, prBody } = await runCiGateMockSprint({
        label: 'regressiongreen-cigate',
        runs: ['pass'],
        holdFirstRunUntilFinalReview: true,
    });

    assert.ok(!run.error, `sprint must not throw: ${run.error && run.error.message}`);
    assert.equal(run.result.verdict, 'PASS', 'CI never changes the verdict');
    assert.ok(!events.includes('fallback-release'), `the CI answer was released by Final Review, not by the fallback timer: ${events.join(', ')}`);

    const at = (e) => events.indexOf(e);
    assert.ok(at('ci-start#0') >= 0 && at('ci-start#0') < at('final-review'), `the gate starts before Final Review: ${events.join(', ')}`);
    assert.ok(events.includes('final-review-saw-ci-settled=0'), 'Final Review ran while CI was still running');
    assert.ok(at('ci-settled#0') > at('final-review'), 'CI settled after Final Review');
    assert.ok(events.includes('regression(ci-settled=1)'), `the barrier awaited CI before Regression Test: ${events.join(', ')}`);
    assert.ok(at('ci-settled#0') < at('publish-push') && at('publish-push') < at('pr-post'), events.join(', '));
    assert.deepEqual(ciCalls, ['branch-head#0', 'find-runs#0:pass', 'list-jobs#0'], 'exactly one CI run located, no retry, no second Finalization');

    // Log order: barrier wait line after Final Review, Regression after it.
    const idx = (pred) => run.logs.findIndex(pred);
    const startIdx = idx((l) => l.includes('[CI Gate] started at Finalization'));
    const barrierIdx = idx((l) => l.includes('Finalization barrier: Final Review is done; awaiting the CI gate run'));
    const passIdx = idx((l) => l.includes('[CI Gate] PASS'));
    const regressionIdx = idx((l) => l.includes('Regression pass PASSED'));
    assert.ok(startIdx >= 0 && startIdx < barrierIdx && barrierIdx < regressionIdx && passIdx < regressionIdx,
        `log order start(${startIdx}) < barrier(${barrierIdx}) < regression(${regressionIdx}), pass(${passIdx}) < regression`);
    assert.ok(run.logs.some((l) => l.includes('[Sprint Extension] no extension')), 'the no-extension decision is logged when CI is configured');
    assert.ok(!run.logs.some((l) => /Extension \d+ of at most/.test(l)), 'no extension ran');
    assert.ok(!run.dispatched.some((d) => /Sprint Cycle 2/.test(String(d.prompt || ''))), 'no second cycle');
    assert.equal(run.dispatched.filter((d) => d.label === 'Final Review').length, 1, 'one Final Review');

    for (const d of run.dispatched) {
        assert.doesNotMatch(String(d.prompt || ''), /CI gate|ci_gate|actions\/runs/i, `no CI result may reach a ${d.agent} prompt`);
    }

    assert.ok(prBody, 'a PR was raised');
    assert.ok(prBody.includes('### CI'), prBody);
    assert.ok(!prBody.includes('### Sprint extensions'), 'no extension section without a trigger');
    assert.ok(prBody.includes("CI gate: PASS -- workflow 'ci.yml'."), prBody);
    assert.ok(prBody.includes(`${RUN_URL}-0`));
    assert.ok(prBody.includes(`CI ran on commit: ${CI_SHA}`));
    assert.ok(prBody.includes('build (os-a)=success, build (os-b)=success'));
    assert.ok(prBody.includes(`CI ran on ${CI_SHA}; branch head is now ${LATER_SHA} (commits after CI started: not covered).`), prBody);
    assert.ok(run.logs.some((l) => l.includes('[CI Gate] WARNING') && l.includes('not covered')));
});
