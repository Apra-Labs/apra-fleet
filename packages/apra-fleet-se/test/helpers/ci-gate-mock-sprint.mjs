import { runDevelopLoopScenario, withScenarioMarkers, mockCmdResult } from './mock-sprint-harness.mjs';

// =============================================================================
// Shared driver for the full-runner ci_gate / sprint-extension mock sprints.
//
// Every scenario here reuses the 'regressiongreen' scenario
// (mock-sprint-regression-failure-never-gates.test.mjs) verbatim -- same tag,
// members, task and regression playbook -- so its committed bd recording
// answers the run's bd calls. That only holds while the run issues NO bd
// command of its own beyond that stream: the CI gate issues none, and the
// Finalization barrier issues none when it does not extend. A scenario that
// extends (a Fix-CI bead plus another cycle) needs a new bd stream, which can
// only be recorded against a real `bd` (npm run test:record), so such a
// scenario passes its own `tag` and commits its own recording. Each scenario
// must live in its OWN test file: the replay queues are per process and a
// second run of the same tag in one process would find them consumed.
//
// The fake CI REST surface sits behind the harness's onCommand hook, the real
// vcs_credential_exec mock, the real GitHub ciGate builders and the real gate
// code. `runs` scripts one entry per gate run (each Finalization pass and each
// TIMEOUT retry starts one): 'pass' | 'fail' | 'timeout' | 'forbidden'.
// ASCII only.
// =============================================================================

export const CI_SHA = '1111111111111111111111111111111111111111';
export const LATER_SHA = '2222222222222222222222222222222222222222';
export const RUN_URL = 'https://github.example/acme/widgets/actions/runs/5150';

const JOBS_FOR = {
    pass: [{ name: 'build (os-a)', conclusion: 'success' }, { name: 'build (os-b)', conclusion: 'success' }],
    fail: [{ name: 'build (os-a)', conclusion: 'success' }, { name: 'build (os-b)', conclusion: 'failure' }],
};

/**
 * @param {{
 *   label: string,
 *   runs: string[],
 *   ciGate?: object,
 *   maxExtensions?: number,
 *   holdFirstRunUntilFinalReview?: boolean,
 *   tag?: string,
 *   finalReviews?: object[],
 * }} o
 *
 * `tag` defaults to 'regressiongreen' (the shared recording). A scenario that
 * extends passes its own tag, so its own bd stream is recorded under
 * test/fixtures/bd-recordings. `finalReviews` scripts the Final Review
 * verdict JSON per pass (the last entry repeats); default: one PASS.
 */
export async function runCiGateMockSprint({ label, runs, ciGate = { workflow: 'ci.yml' }, maxExtensions, holdFirstRunUntilFinalReview = false, tag = 'regressiongreen', finalReviews }) {
    const reviewScript = Array.isArray(finalReviews) && finalReviews.length > 0
        ? finalReviews
        : [{ verdict: 'PASS', notes: 'All goal-priority beads closed, last review APPROVED.' }];
    let finalReviewPass = -1;
    const prRecordState = new Map();
    const events = [];
    const ciCalls = [];
    let localHead = CI_SHA;
    let gateRun = -1;
    let releaseFirst;
    const firstHeld = new Promise((r) => { releaseFirst = r; });
    if (!holdFirstRunUntilFinalReview) releaseFirst();
    const fallback = setTimeout(() => { events.push('fallback-release'); releaseFirst(); }, 120000);
    let ciSettledCount = 0;

    const ciAnswer = (body, status = 200) => mockCmdResult(0, `${JSON.stringify(body)}\n${status}`, '');
    const kindOf = () => runs[Math.min(gateRun, runs.length - 1)];
    const runBody = (kind) => ({
        id: 5150 + gateRun, html_url: `${RUN_URL}-${gateRun}`, head_sha: CI_SHA,
        status: kind === 'timeout' ? 'in_progress' : 'completed',
        conclusion: kind === 'pass' ? 'success' : (kind === 'fail' ? 'failure' : null),
    });

    const onCommand = async ({ command }) => {
        if (/^git push -u origin /.test(command)) { events.push('publish-push'); return undefined; }
        if (/^git rev-parse HEAD\s*$/.test(command)) return mockCmdResult(0, `${localHead}\n`, '');
        if (/^git ls-remote origin refs\/heads\//.test(command)) {
            const ref = command.split(' ').pop();
            return mockCmdResult(0, `${localHead}\t${ref}\n`, '');
        }
        if (/^curl /.test(command) && command.includes('/pulls') && command.includes(' -X POST ')) {
            events.push('pr-post');
            return undefined;
        }
        if (!/^curl /.test(command) || !/\/branches\/|\/actions\//.test(command)) return undefined;
        if (command.includes('/branches/')) {
            gateRun += 1;
            ciCalls.push(`branch-head#${gateRun}`);
            events.push(`ci-start#${gateRun}`);
            return ciAnswer({ commit: { sha: localHead } });
        }
        if (command.includes('/runs?head_sha=')) {
            const kind = kindOf();
            ciCalls.push(`find-runs#${gateRun}:${kind}`);
            if (gateRun === 0) await firstHeld;
            if (kind === 'forbidden') {
                ciSettledCount += 1;
                events.push(`ci-settled#${gateRun}`);
                return ciAnswer({ message: 'Resource not accessible by integration' }, 403);
            }
            return ciAnswer({ workflow_runs: [runBody(kind)] });
        }
        if (/\/actions\/runs\/\d+\/jobs/.test(command)) {
            const kind = kindOf();
            ciCalls.push(`list-jobs#${gateRun}`);
            ciSettledCount += 1;
            events.push(`ci-settled#${gateRun}`);
            return ciAnswer({ jobs: JOBS_FOR[kind] || [] });
        }
        if (/\/actions\/runs\/\d+/.test(command)) {
            const kind = kindOf();
            ciCalls.push(`get-run#${gateRun}`);
            return ciAnswer(runBody(kind));
        }
        ciCalls.push(`unexpected: ${command.slice(0, 80)}`);
        return ciAnswer({ message: 'unexpected' }, 500);
    };

    let run;
    try {
        run = await withScenarioMarkers(label, () => runDevelopLoopScenario(tag, {
            members: ['local'],
            taskSpecs: [{ title: 'Task: regression-never-gates scenario work' }],
            maxCycles: 1,
            withRegressionPlaybook: true,
            finalReviewHandler: async () => {
                finalReviewPass += 1;
                events.push('final-review');
                // CI is still running while Final Review runs; release it only
                // now, so the barrier is what waits for it.
                events.push(`final-review-saw-ci-settled=${ciSettledCount}`);
                setTimeout(releaseFirst, 50);
                const verdict = reviewScript[Math.min(finalReviewPass, reviewScript.length - 1)];
                return { content: [{ text: JSON.stringify(verdict) }] };
            },
            regressionHandler: () => {
                events.push(`regression(ci-settled=${ciSettledCount})`);
                // Commits land after the barrier (the harvester's docs commit
                // in a real sprint): the pushed head moves past the CI sha.
                localHead = LATER_SHA;
                return { content: [{ text: JSON.stringify({ passed: true, suitePassed: true, smokePassed: true, bugsFiled: [], summary: 'Mock regression pass.' }) }] };
            },
            ciGate,
            ...(maxExtensions !== undefined ? { maxExtensions } : {}),
            prRecordState,
            onCommand,
        }));
    } finally {
        clearTimeout(fallback);
    }
    const rec = prRecordState.get(run.branch);
    return { run, events, ciCalls, prBody: rec ? rec.body : null };
}
