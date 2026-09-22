import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-unw2.6 (N8) regression 1: stale APPROVED verdict must never
// back an exit decision for a LATER cycle it never actually reviewed --
// when the exit check's goal-priority count reaches 0 on a cycle whose
// Develop/Review loop was skipped (no ready beads), a fresh re-review of
// the current state must be dispatched before the sprint is allowed to
// exit.
// =============================================================================
test('mock sprint: a stale APPROVED verdict must not back a later cycle\'s exit without a fresh re-review', async () => {
    await withScenarioMarkers('staleapproval (N8 stale verdict)', async () => {
        console.log('Running mock sprint scenario (stale APPROVED verdict must not back a later cycle\'s exit without a fresh re-review)...');
        let staleDeployCalls = 0;
        const staleApproval = await runDevelopLoopScenario('staleapproval', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: A closes normally (stale-approval scenario)' },
                { title: 'Task: B stays blocked (stale-approval scenario)' },
            ],
            maxCycles: 2,
            withRunbooks: true,
            // Cycle 1: close A, but deliberately leave B `blocked` (an
            // out-of-scope/deferred condition) rather than closed or left
            // `open` -- `blocked` still counts toward the goal-priority open
            // count (NOT_DONE_STATUSES) but is never re-offered via `--ready`,
            // so cycle 2's Develop/Review loop is skipped entirely (no ready
            // beads) -- exactly the "develop skipped" half of the N8 bug.
            doerHandler: async ({ opts, tempDir: td }) => {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
                const bTask = listRes.find((b) => b.title === 'Task: B stays blocked (stale-approval scenario)');
                const closedIds = [];
                for (const id of ids) {
                    if (bTask && id === bTask.id) {
                        await runCmd(`bd update ${id} --status=blocked`, td);
                    } else {
                        await runCmd(`bd close ${id}`, td);
                        closedIds.push(id);
                    }
                }
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds, notes: 'Closed A; left B blocked (out-of-scope, deferred).' }) }] };
            },
            // Approves whatever was actually reviewed each round -- this is the
            // verdict cycle 1 ends on ('APPROVED', with B noted as an
            // out-of-scope blocker) AND the verdict a correctly-dispatched
            // fresh re-review in cycle 2 must independently reach.
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved what was reviewed; B intentionally deferred as out-of-scope.', reopenIds: [], newTasks: [] }) }]
            }),
            // Cycle 2's Deploy phase (which runs every cycle regardless of
            // whether Develop/Review ran) closes B out-of-band -- simulating
            // the goal-priority open count reaching 0 on a cycle that never
            // itself reviewed that closure. This is the exact condition a
            // stale `lastReviewVerdict` from cycle 1 could otherwise satisfy.
            deployHandler: async ({ tempDir: td }) => {
                staleDeployCalls++;
                if (staleDeployCalls === 2) {
                    const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
                    const bTask = listRes.find((b) => b.title === 'Task: B stays blocked (stale-approval scenario)');
                    if (bTask) await runCmd(`bd close ${bTask.id}`, td);
                }
                return { content: [{ text: JSON.stringify({ deployed: true, notes: `Deploy call #${staleDeployCalls}` }) }] };
            },
        });
        check(!staleApproval.error, `Stale-approval scenario should not throw: ${staleApproval.error ? staleApproval.error.message : ''}`);
        check(
            staleApproval.result && staleApproval.result.status === 'success',
            `Expected the stale-approval scenario to eventually succeed (backed by a fresh re-review), got: ${JSON.stringify(staleApproval.result)}`
        );
        const staleReviewCalls = staleApproval.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
        check(
            staleReviewCalls.length === 2,
            `Expected exactly 2 non-final reviewer dispatches -- cycle 1's real review AND cycle 2's fresh re-review (never relying on cycle 1's stale verdict) -- got ${staleReviewCalls.length}: ${JSON.stringify(staleReviewCalls.map((d) => d.prompt.slice(0, 80)))}`
        );
        check(
            staleApproval.logs.some((m) => m.includes('no review ran THIS cycle') && m.includes('fresh re-review')),
            `Expected a logged re-review dispatch before exit, logs: ${JSON.stringify(staleApproval.logs)}`
        );
        const staleTaskA = staleApproval.tasks.find((t) => t.title === 'Task: A closes normally (stale-approval scenario)');
        const staleTaskB = staleApproval.tasks.find((t) => t.title === 'Task: B stays blocked (stale-approval scenario)');
        check(
            staleApproval.finalBeadsById.get(staleTaskA.id) && staleApproval.finalBeadsById.get(staleTaskA.id).status === 'closed',
            `Expected task A to be closed, got: ${JSON.stringify(staleApproval.finalBeadsById.get(staleTaskA.id))}`
        );
        check(
            staleApproval.finalBeadsById.get(staleTaskB.id) && staleApproval.finalBeadsById.get(staleTaskB.id).status === 'closed',
            `Expected task B to be closed (by the cycle-2 deploy side effect), got: ${JSON.stringify(staleApproval.finalBeadsById.get(staleTaskB.id))}`
        );
    });
});

// =============================================================================
// A goal-priority bead that is DEFERRED is out of the sprint's outstanding
// set, and the sprint exits on the normal goal-priority path -- naming it.
//
// THIS REPLACES THE OPPOSITE PIN, DELIBERATELY. The earlier rule here was "a
// deferred goal-priority bead must not allow exit success", which read
// `deferred` as just another flavour of "not finished". Run against a real
// sprint that deferred a bead on purpose, that rule wedged the run twice
// over: the completion check could never reach zero (nobody dispatches a
// deferred bead, so nothing could ever close it) and the deferred bead
// contributed nothing to the progress score, so every later cycle also read
// as stagnation -- a sprint whose work was genuinely finished died as
// SPRINT_STALLED. `deferred` is a decision, not a state of incompleteness.
//
// What the exit still requires is unchanged and is asserted below: an
// APPROVED reviewer verdict from the exiting cycle, the verify-closure gate,
// and a named report of what was parked. Deferring buys an exit from the
// dispatch loop, never an exemption from review. An out-of-goal (P3) bead is
// still never counted regardless of status (the "goalpriority" scenario
// below), and blocked/in_progress beads still count exactly as before.
// =============================================================================
test('mock sprint: a deferred goal-priority bead is out of scope and the sprint exits PASS, naming it', async () => {
    await withScenarioMarkers('deferredgoalpriority', async () => {
        console.log('Running mock sprint scenario (deferred goal-priority bead is out of scope, sprint exits and names it)...');
        const deferredGoalPriority = await runDevelopLoopScenario('deferredgoalpriority', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: A closes normally (deferred-goal-priority scenario)' },
                { title: 'Task: B deferred, never closed (deferred-goal-priority scenario)' },
            ],
            maxCycles: 2,
            // Close A normally; defer B (both are default/goal priority, i.e.
            // in-scope for the P1/P2 goal) -- simulating the harvester deferring
            // a goal-priority issue mid-sprint per its contract.
            doerHandler: async ({ opts, tempDir: td }) => {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
                const bTask = listRes.find((b) => b.title === 'Task: B deferred, never closed (deferred-goal-priority scenario)');
                const closedIds = [];
                for (const id of ids) {
                    if (bTask && id === bTask.id) {
                        await runCmd(`bd update ${id} --status=deferred`, td);
                    } else {
                        await runCmd(`bd close ${id}`, td);
                        closedIds.push(id);
                    }
                }
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds, notes: 'Closed A; deferred B (goal-priority, never closed).' }) }] };
            },
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'A approved; B deferred (still counts as goal-priority open).', reopenIds: [], newTasks: [] }) }]
            }),
        });
        check(!deferredGoalPriority.error, `Deferred goal-priority scenario should not throw: ${deferredGoalPriority.error ? deferredGoalPriority.error.message : ''}`);
        check(
            deferredGoalPriority.result && deferredGoalPriority.result.status === 'success',
            `Expected the sprint to exit on the normal goal-priority path once its only remaining not-done bead was deferred, got: ${JSON.stringify(deferredGoalPriority.result)}`
        );
        check(
            !deferredGoalPriority.logs.some((m) => /Sprint stalled/.test(m)),
            `A sprint whose only remaining not-done bead is deferred must never be reported as stalled, logs: ${JSON.stringify(deferredGoalPriority.logs.filter((m) => /stall/i.test(m)))}`
        );
        const deferredTaskA = deferredGoalPriority.tasks.find((t) => t.title === 'Task: A closes normally (deferred-goal-priority scenario)');
        const deferredTaskB = deferredGoalPriority.tasks.find((t) => t.title === 'Task: B deferred, never closed (deferred-goal-priority scenario)');
        check(
            deferredGoalPriority.finalBeadsById.get(deferredTaskA.id) && deferredGoalPriority.finalBeadsById.get(deferredTaskA.id).status === 'closed',
            `Expected task A to be closed, got: ${JSON.stringify(deferredGoalPriority.finalBeadsById.get(deferredTaskA.id))}`
        );
        check(
            deferredGoalPriority.finalBeadsById.get(deferredTaskB.id) && deferredGoalPriority.finalBeadsById.get(deferredTaskB.id).status === 'deferred',
            `Expected task B to remain deferred (never closed), got: ${JSON.stringify(deferredGoalPriority.finalBeadsById.get(deferredTaskB.id))}`
        );
        // Out of scope is not the same as out of sight: the exit must NAME
        // what it parked, in the log and in the sprint's own summary, or a
        // PASS is indistinguishable from work that quietly went missing.
        check(
            deferredGoalPriority.logs.some((m) => m.includes('DEFERRED') && m.includes(deferredTaskB.id))
            || deferredGoalPriority.logs.some((m) => m.includes('deferred') && m.includes(deferredTaskB.id)),
            `Expected the exit path to name the deferred bead ${deferredTaskB.id}, logs: ${JSON.stringify(deferredGoalPriority.logs.filter((m) => /defer/i.test(m)))}`
        );
        check(
            Array.isArray(deferredGoalPriority.result.deferredIds) && deferredGoalPriority.result.deferredIds.includes(deferredTaskB.id),
            `Expected the sprint summary to enumerate the deferred bead ${deferredTaskB.id}, got: ${JSON.stringify(deferredGoalPriority.result)}`
        );
    });

    // apra-fleet-unw2.18 (N18) fix (b): reviewer prompt's embedded bd show
    // --json must be wrapped with wrapUntrustedBlock for A7 fencing
    // compliance -- covered by the run1ReviewerDispatches assertions in
    // mock-sprint-happy-path.test.mjs (apra-fleet-fih.2; formerly a
    // dedicated 'reviewerpromptfence' scenario here).
    const runnerSource = await fs.readFile(path.join(__dirname, '../fleet-sprint/runner.js'), 'utf-8');
    check(
        !/return\s*\{\s*status:\s*'success'/.test(runnerSource),
        'runner.js source must not contain an unconditional return { status: \'success\', ... } -- the return value must be verdict-driven (A6)'
    );
    check(
        /status:\s*finalVerdictResult\.verdict\s*===\s*'PASS'\s*\?\s*'success'\s*:\s*'failed'/.test(runnerSource),
        'runner.js source must derive the returned status from the final verdict (A6)'
    );
});

// =============================================================================
// apra-fleet-unw.17 (A6) acceptance criterion 4: a final verdict of FAIL
// propagates to the workflow's returned status, and no unconditional
// {status:'success'} exists in runner.js's source
// =============================================================================
// apra-fleet-fih.2: also folds in the former dedicated 'prverdictfail'
// scenario (apra-fleet-unw2.9 (N11) acceptance criterion 2, FAIL side) --
// identical 1-task/maxCycles-1/FAIL shape, disjoint assertions on result
// fields (this scenario) vs the `gh pr create` title/body (below).
test('mock sprint: an explicit final FAIL verdict propagates to status:failed and still publishes the PR', async () => {
    await withScenarioMarkers('explicitfail (+prverdictfail)', async () => {
        console.log('Running mock sprint scenario (explicit final verdict FAIL propagates; PR still published with FAIL verdict)...');
        const explicitFail = await runDevelopLoopScenario('explicitfail', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Fully closed but explicitly failed by final review' }],
            maxCycles: 1,
            finalReviewHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'FAIL', notes: 'Explicit test-injected FAIL despite all beads closing.' }) }]
            }),
        });
        check(!explicitFail.error, `Explicit-FAIL scenario should not throw: ${explicitFail.error ? explicitFail.error.message : ''}`);
        check(
            explicitFail.result && explicitFail.result.status === 'failed',
            `Expected a FAIL final verdict to produce status:'failed', got: ${JSON.stringify(explicitFail.result)}`
        );
        check(
            explicitFail.result && explicitFail.result.verdict === 'FAIL' && explicitFail.result.notes === 'Explicit test-injected FAIL despite all beads closing.',
            `Expected the final verdict/notes to be surfaced on the result, got: ${JSON.stringify(explicitFail.result)}`
        );
        // apra-fleet-unw2.9 (N11) acceptance criterion 2 (FAIL side): per
        // plan.md's already-decided rule, a FAIL verdict still publishes the PR --
        // the verdict is stated plainly in the title/body, not suppressed.
        // apra-fleet-tfx.8.4: the reverted gh-based path is gone -- the PR is
        // now raised via VCSModule's `curl ... /pulls` create-pull-request
        // command, with title/body carried as JSON fields in the -d payload.
        const explicitFailPrCmd = explicitFail.commandLog.find((c) => c.startsWith('curl -sS -X POST') && c.includes('/pulls'));
        check(
            !!explicitFailPrCmd,
            `A FAIL verdict must still publish the PR (plan.md's already-made decision) -- expected a VCSModule create-pull-request command, commandLog: ${JSON.stringify(explicitFail.commandLog)}`
        );
        check(
            !!explicitFailPrCmd && /"title":"[^"]*FAIL[^"]*"/.test(explicitFailPrCmd) && /Final Verdict: FAIL/.test(explicitFailPrCmd),
            `Expected the PR title AND body to include the FAIL verdict, got: ${explicitFailPrCmd}`
        );
        // apra-fleet-eft.1.3 regression (folded in from the former
        // mock-sprint-abort-pr.test.mjs 'abortprfail' scenario): an ordinary
        // FAIL-verdict PR is NOT an abort -- it must never carry the abort
        // path's [ABORTED] prefix.
        check(
            !!explicitFailPrCmd && !explicitFailPrCmd.includes('[ABORTED]'),
            `An ordinary FAIL-verdict PR must NOT carry the [ABORTED] prefix, got: ${explicitFailPrCmd}`
        );
    });
});

// =============================================================================
// apra-fleet-unw.17 (A5) acceptance criterion 3: goal-priority exit --
// a P3 open bead does not block P1/P2 goal completion
// =============================================================================
test('mock sprint: an out-of-goal P3 bead does not block P1/P2 goal completion', async () => {
    await withScenarioMarkers('goalpriority (P3 left open)', async () => {
        console.log('Running mock sprint scenario (goal-priority exit: P3 bead left open)...');
        const goalPriority = await runDevelopLoopScenario('goalpriority', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: In-goal P2 work' },
                { title: 'Task: Out-of-goal P3 work', priority: 'P3' },
            ],
            maxCycles: 1,
            // Close only the in-goal (P2, default-priority) task; deliberately
            // leave the P3 task open every round -- it must never be dispatched
            // as "blocking" the P1/P2 goal from completing.
            doerHandler: async ({ opts, tempDir: td }) => {
                const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
                const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
                const p3Task = listRes.find((b) => b.title === 'Task: Out-of-goal P3 work');
                for (const id of ids) {
                    if (p3Task && id === p3Task.id) continue; // never close the out-of-goal task
                    await runCmd(`bd close ${id}`, td);
                }
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids.filter((id) => !p3Task || id !== p3Task.id), notes: 'Closed in-goal work only.' }) }] };
            },
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'In-goal work approved.', reopenIds: [], newTasks: [] }) }]
            }),
        });
        check(!goalPriority.error, `Goal-priority scenario should not throw: ${goalPriority.error ? goalPriority.error.message : ''}`);
        check(
            goalPriority.result && goalPriority.result.status === 'success',
            `Expected goal-priority completion (P1/P2) despite an open P3 bead, got: ${JSON.stringify(goalPriority.result)}`
        );
        const inGoalId = goalPriority.tasks.find((t) => t.title === 'Task: In-goal P2 work').id;
        const outOfGoalId = goalPriority.tasks.find((t) => t.title === 'Task: Out-of-goal P3 work').id;
        check(
            goalPriority.finalBeadsById.get(inGoalId) && goalPriority.finalBeadsById.get(inGoalId).status === 'closed',
            `Expected the in-goal (P2) bead to be closed, got: ${JSON.stringify(goalPriority.finalBeadsById.get(inGoalId))}`
        );
        check(
            goalPriority.finalBeadsById.get(outOfGoalId) && goalPriority.finalBeadsById.get(outOfGoalId).status !== 'closed',
            `Expected the out-of-goal (P3) bead to remain open (never blocking completion), got: ${JSON.stringify(goalPriority.finalBeadsById.get(outOfGoalId))}`
        );
    });
});
