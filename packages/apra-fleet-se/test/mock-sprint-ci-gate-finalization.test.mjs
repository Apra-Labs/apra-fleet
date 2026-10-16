import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, mockCmdResult } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// ci_gate end to end: one full deterministic mock sprint with
// ci_gate {"workflow":"ci.yml"} and a fake CI REST surface (served through the
// harness's onCommand hook, behind the real vcs_credential_exec mock, the real
// GitHub ciGate builders and the real gate/resolver code).
//
// Proves, by running the real runner.js:
//   (1) the gate is STARTED at Finalization, before Final Review;
//   (2) it does not block Final Review, Regression Test or Harvest: the fake
//       CI holds its find-runs answer until it sees Publish PR's own branch
//       push (`git push -u origin <branch>`) -- which only happens after
//       Harvest -- so any earlier await would deadlock (caught by the fallback
//       timer below, which the test then fails on);
//   (3) Publish PR awaits the result before the PR POST and renders PASS
//       (workflow, run url, sha, jobs) into the PR body;
//   (4) the harvester's later commit is reported as not covered by CI (the
//       sha-mismatch note), and no second CI run is started;
//   (5) the sprint verdict is untouched.
// ASCII only.
// =============================================================================

const CI_SHA = '1111111111111111111111111111111111111111';
const LATER_SHA = '2222222222222222222222222222222222222222';
const RUN_URL = 'https://github.example/acme/widgets/actions/runs/5150';

test('mock sprint: ci_gate runs once at Finalization in parallel and Publish PR reports it in the PR body', { timeout: 300000 }, async () => {
    const prRecordState = new Map();
    const ciCalls = [];
    let localHead = CI_SHA;
    let releaseCi;
    const ciHeld = new Promise((r) => { releaseCi = r; });
    let releasedBy = null;
    const fallback = setTimeout(() => { releasedBy = releasedBy || 'fallback-timeout'; releaseCi(); }, 120000);
    let ciPendingAtRegression = null;
    let ciResolvedBeforePrPost = null;
    let ciDone = false;

    const ciAnswer = (body, status = 200) => mockCmdResult(0, `${JSON.stringify(body)}\n${status}`, '');

    const onCommand = async ({ command }) => {
        if (/^git push -u origin /.test(command)) {
            // Publish PR's own push: Final Review, Regression and Harvest are done.
            if (!releasedBy) { releasedBy = 'publish-push'; releaseCi(); }
            return undefined;
        }
        if (/^git rev-parse HEAD\s*$/.test(command)) return mockCmdResult(0, `${localHead}\n`, '');
        if (/^git ls-remote origin refs\/heads\//.test(command)) {
            const ref = command.split(' ').pop();
            return mockCmdResult(0, `${localHead}\t${ref}\n`, '');
        }
        if (/^curl /.test(command) && command.includes('/pulls') && command.includes(' -X POST ')) {
            ciResolvedBeforePrPost = ciDone;
            return undefined;
        }
        if (!/^curl /.test(command) || !/\/branches\/|\/actions\//.test(command)) return undefined;
        if (command.includes('/branches/')) {
            ciCalls.push('branch-head');
            const sha = localHead;
            // The harvester commits after CI started: the head moves on.
            localHead = LATER_SHA;
            return ciAnswer({ commit: { sha } });
        }
        if (command.includes('/runs?head_sha=')) {
            ciCalls.push('find-runs');
            await ciHeld;
            return ciAnswer({ workflow_runs: [{ id: 5150, html_url: RUN_URL, head_sha: CI_SHA, status: 'completed', conclusion: 'success' }] });
        }
        if (/\/runs\/5150\/jobs/.test(command)) {
            ciCalls.push('list-jobs');
            ciDone = true;
            return ciAnswer({ jobs: [{ name: 'build (os-a)', conclusion: 'success' }, { name: 'build (os-b)', conclusion: 'success' }] });
        }
        ciCalls.push(`unexpected: ${command.slice(0, 80)}`);
        return ciAnswer({ message: 'unexpected' }, 500);
    };

    let run;
    try {
        // Reuses the 'regressiongreen' scenario (mock-sprint-regression-failure-
        // never-gates.test.mjs) verbatim -- same tag, members, task and
        // regression playbook -- so its committed bd recording answers this
        // run's bd calls: the CI gate issues no bd command of its own, so the
        // bd stream is identical. Keep the two configurations in step.
        run = await withScenarioMarkers('regressiongreen-cigate', () => runDevelopLoopScenario('regressiongreen', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: regression-never-gates scenario work' }],
            maxCycles: 1,
            withRegressionPlaybook: true,
            regressionHandler: () => {
                ciPendingAtRegression = !ciDone;
                return { content: [{ text: JSON.stringify({ passed: true, suitePassed: true, smokePassed: true, bugsFiled: [], summary: 'Mock regression pass.' }) }] };
            },
            ciGate: { workflow: 'ci.yml' },
            prRecordState,
            onCommand,
        }));
    } finally {
        clearTimeout(fallback);
    }

    assert.ok(!run.error, `sprint must not throw: ${run.error && run.error.message}`);
    assert.equal(run.result.verdict, 'PASS', 'CI never changes the verdict');
    assert.equal(releasedBy, 'publish-push', 'the CI answer was held until Publish PR pushed: nothing before Publish PR awaited the gate');
    assert.equal(ciPendingAtRegression, true, 'Regression Test ran while CI was still running');
    assert.ok(run.dispatched.some((d) => d.agent === 'harvester'), 'Harvest ran');
    assert.equal(ciResolvedBeforePrPost, true, 'Publish PR awaited the CI result before the PR POST');
    assert.deepEqual(ciCalls, ['branch-head', 'find-runs', 'list-jobs'], 'exactly one CI run located, no second run');

    // 'owed triage:' is the first line logged after Final Review returns.
    const startIdx = run.logs.findIndex((l) => l.includes('[CI Gate] started at Finalization'));
    const afterFinalReviewIdx = run.logs.findIndex((l) => l.startsWith('owed triage:'));
    assert.ok(startIdx >= 0, 'the gate start is logged');
    assert.ok(afterFinalReviewIdx > startIdx, `the gate starts before Final Review (start ${startIdx}, after-final-review ${afterFinalReviewIdx})`);
    const finalReview = run.dispatched.find((d) => d.label === 'Final Review');
    assert.ok(finalReview, 'Final Review dispatched');
    for (const d of run.dispatched) {
        assert.doesNotMatch(String(d.prompt || ''), /CI gate|ci_gate|actions\/runs/i, `no CI result may reach a ${d.agent} prompt`);
    }

    const rec = prRecordState.get(run.branch);
    assert.ok(rec && rec.body, 'a PR was raised');
    assert.ok(rec.body.includes('### CI'), rec.body);
    assert.ok(rec.body.includes("CI gate: PASS -- workflow 'ci.yml'."), rec.body);
    assert.ok(rec.body.includes(RUN_URL));
    assert.ok(rec.body.includes(`CI ran on commit: ${CI_SHA}`));
    assert.ok(rec.body.includes('build (os-a)=success, build (os-b)=success'));
    assert.ok(rec.body.includes(`CI ran on ${CI_SHA}; branch head is now ${LATER_SHA} (commits after CI started: not covered).`), rec.body);
    assert.ok(run.logs.some((l) => l.includes('[CI Gate] WARNING') && l.includes('not covered')));
});
