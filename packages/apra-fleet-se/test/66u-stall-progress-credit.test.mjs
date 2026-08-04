import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StalledSprintError } from '../fleet-sprint/errors.mjs';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-66u.3: same-cycle Integ Test closures increment the progress
// score, and the abort message matches the evidence
// =============================================================================
//
// Root cause (see apra-fleet-66u.1's bd comment for the full writeup): a
// sprint's own top-level --issue target is, by construction, a bead WITH
// children (its own tasks). bdListScoped()'s scope-construction used to seed
// a target's own id into scope ONLY when it was childless -- so once all of a
// target's children closed and classifyVerifySet() (a separate, already-
// unconditional implementation of the same BFS) correctly routed the target
// itself to verify, the integ-test-runner closing that target for real was
// structurally invisible to closedCount/openAtGoal: the target's id was never
// in the scope those queries filter against, no matter how fresh the
// underlying bd read was. That is exactly the shape of the real 2026-08-02
// incident (apra-fleet-eft.52/apra-fleet-vak, both targets WITH children,
// closing without ever moving closedCountHistory).
//
// apra-fleet-66u.1's fix widens scope to always include a target's own id.
// apra-fleet-66u.2 additionally fixed the stall-abort message wording, and an
// independent review then found the naive widening alone regressed the exit
// gate (a childful target's own closure became REQUIRED to see
// openAtGoal===0, reintroducing the exact false-stall shape via a different
// path) and a stale-cache read in the new verifyDispatchAttempts/
// verifyDispatchClosures counters. Both are fixed alongside this test: the
// exit-gate queries (openAtGoal/stillOpen/finalOpenAtGoal) now post-filter
// decomposed parents via a shared decomposedParentIds() helper (matching
// readyLeafBeads()'s existing structural exclusion), so closedCount alone
// carries the scope-widening's benefit while exit timing is unchanged from
// before 66u.1 and still backstopped by the pre-existing, scope-independent
// stillOpenVerifyIds/verifyEverIds mechanism (apra-fleet-jfo). All
// verify-closure freshness checks (including the new counters) now read a
// single fresh `bd list --status=closed` snapshot per check instead of the
// separately-cached fetchAllBeadsShared(), which is not refreshed by a
// bdListScoped call and can go stale for a full cycle when no dolt sync
// remote is configured (the integ runner's own `bd close` happens inside an
// agent() dispatch, never through the cache-invalidating command() wrapper).
//
// Scenario (a) reproduces the real incident shape end-to-end: a single-child
// epic whose child closes in Cycle 1, becomes verify-eligible in Cycle 2, and
// is deliberately NOT closed by the mocked Integ Test dispatch until its
// THIRD dispatch (Cycle 4) -- exactly the cycle at which the pre-fix code's
// staleCycles would already have reached the stall limit, since closedCount
// never saw the closure and verifyEverIds (monotone) had already credited
// its one-time high-water bump back in Cycle 2. Asserts the sprint completes
// cleanly instead of falsely aborting.
//
// Scenario (b) covers acceptance criterion 2 directly: a genuine verifier
// failure (routed beads dispatched repeatedly, never closed) still stalls,
// and the abort message names the verifier condition.
//
// Scenario (c) covers acceptance criterion 3, previously dropped for being
// too fragile under title-substring prompt matching: a sprint that stalls for
// a genuinely UNRELATED reason (a sibling task permanently blocked on an
// out-of-scope dependency that never closes) AFTER a real, earlier
// verify-closure (a childful sub-target, closed for real by Integ Test in an
// earlier cycle) must NOT blame the verifier. Built entirely on explicit
// bead-id parsing of the runner's own "verification-closure: <ids>." prompt
// clause and a plain dispatch counter -- no title-substring matching, which
// is what made the earlier attempt cross-talk across batched dispatch
// prompts.

function parseAssignedIds(prompt) {
    const match = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function parseVerifyIds(prompt) {
    const match = prompt.match(/verification-closure:\s*([^.]+)\./);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

async function closingDoerHandler({ opts, tempDir }) {
    const ids = parseAssignedIds(opts.prompt);
    for (const id of ids) {
        await runCmd(`bd close ${id} --reason "Done"`, tempDir);
    }
    return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed for real.' }) }] };
}

const approvingReviewerHandler = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }]
});

test('mock sprint: a same-cycle Integ Test closure of a childful verify-routed target (the sprint epic itself) is credited to that cycle\'s progress score, avoiding a false stall', async () => {
    await withScenarioMarkers('66u.3 (a): verify-close credited, no false stall', async () => {
        let epicVerifyDispatchCount = 0;
        const stalled = await runDevelopLoopScenario('66u3a', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: closes normally' }],
            maxCycles: 5,
            withRunbooks: true,
            doerHandler: closingDoerHandler,
            reviewerHandler: approvingReviewerHandler,
            integHandler: async ({ opts, tempDir, epicBead }) => {
                const verifyIds = parseVerifyIds(opts.prompt);
                if (verifyIds.includes(epicBead.id)) {
                    epicVerifyDispatchCount++;
                    // Deliberately withhold the real closure for the first
                    // two dispatches -- simulates verification genuinely
                    // taking multiple cycles -- then close on the third,
                    // the exact cycle the pre-fix code's stall net would
                    // already have tripped on (see header comment).
                    if (epicVerifyDispatchCount >= 3) {
                        await runCmd(`bd close ${epicBead.id} --reason "Verified"`, tempDir);
                        return {
                            content: [{
                                text: JSON.stringify({
                                    featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [],
                                    summary: `Verified and closed ${epicBead.id} on dispatch ${epicVerifyDispatchCount}.`,
                                })
                            }]
                        };
                    }
                    return {
                        content: [{
                            text: JSON.stringify({
                                featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [],
                                summary: `Verification of ${epicBead.id} still in progress (dispatch ${epicVerifyDispatchCount}).`,
                            })
                        }]
                    };
                }
                return {
                    content: [{
                        text: JSON.stringify({ featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [], summary: 'Nothing to verify this cycle.' })
                    }]
                };
            },
        });

        check(
            !stalled.error,
            `Expected the sprint to complete cleanly (the epic's own verify-closure, even withheld across two prior dispatches, must be credited so staleCycles never reaches the limit), got: ${stalled.error ? stalled.error.constructor.name + ': ' + stalled.error.message : 'none'}`
        );
        check(epicVerifyDispatchCount >= 3, `Expected the epic to have been dispatched to verify at least 3 times (scenario setup check), got ${epicVerifyDispatchCount}`);
        const epic = stalled.finalBeadsById.get(stalled.epicBeadId);
        check(epic && epic.status === 'closed', `Expected the epic (childful verify-routed target) to be closed in final bd state, got status=${epic ? epic.status : 'MISSING'}`);
    });
});

test('mock sprint: verify-routed beads dispatched repeatedly with zero closures triggers a real stall whose message correctly blames the verifier', async () => {
    await withScenarioMarkers('66u.3 (b): genuine verifier failure -> stall names the verifier', async () => {
        const stalled = await runDevelopLoopScenario('66u3b', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: closes normally' }],
            maxCycles: 5,
            withRunbooks: true,
            doerHandler: closingDoerHandler,
            reviewerHandler: approvingReviewerHandler,
            // The verifier NEVER closes the routed target, every cycle it is
            // named -- a genuine "verifier is failing" shape, not a
            // bookkeeping gap.
            integHandler: async () => ({
                content: [{
                    text: JSON.stringify({ featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [], summary: 'Verified but did not close anything (simulated verifier failure).' })
                }]
            }),
        });

        check(stalled.error instanceof StalledSprintError, `Expected a StalledSprintError, got: ${stalled.error ? stalled.error.constructor.name + ': ' + stalled.error.message : 'no error'}`);
        check(
            /the verifier may be failing/.test(stalled.error.message),
            `Expected the abort message to name the verifier condition (it genuinely never closed anything it was asked to verify), got: ${stalled.error.message}`
        );
    });
});

test('mock sprint: a genuine stall for an unrelated reason, after a real earlier verify-closure, does not blame the verifier', async () => {
    await withScenarioMarkers('66u.3 (c): unrelated stall after real verify-closure -> no verifier blame', async () => {
        let subTargetId = null;
        let subTargetChildId = null;
        let blockerBeadId = null;

        const stalled = await runDevelopLoopScenario('66u3c', {
            members: ['local'],
            // tasks[0] = closes normally (leaf). tasks[1] = permanently
            // blocked (leaf, unmet dependency on an out-of-scope bead that
            // is never touched by this sprint). tasks[2] = childful
            // sub-target -- gets its own child below, becomes verify-eligible
            // once that child closes, and IS genuinely closed by Integ Test.
            taskSpecs: [
                { title: 'Task: closes normally' },
                { title: 'Task: permanently blocked' },
                { title: 'Task: childful sub-target, closes via verify' },
            ],
            maxCycles: 6,
            withRunbooks: true,
            beforeSprint: async ({ tempDir, runCmd: run, tasks }) => {
                subTargetId = tasks[2].id;
                const blockedTaskId = tasks[1].id;

                // An out-of-scope bead (no --parent under the epic) that this
                // sprint never touches -- gives tasks[1] a real, permanent,
                // unmet `blocks` dependency without needing any special-case
                // deadlock-detector behavior.
                const blockerRes = await run('bd create "Out-of-scope blocker, never closes" -d "Deliberately never touched by this sprint." --silent', tempDir);
                blockerBeadId = blockerRes.stdout.trim();
                await run(`bd dep add ${blockedTaskId} ${blockerBeadId}`, tempDir);

                // A genuine child of tasks[2], making it a childful sub-target
                // exactly like the sprint epic itself in scenario (a).
                const childRes = await run(`bd create "Sub-target child, closes normally" -d "Scenario task." --silent`, tempDir);
                subTargetChildId = childRes.stdout.trim();
                await run(`bd update ${subTargetChildId} --parent ${subTargetId}`, tempDir);
            },
            doerHandler: closingDoerHandler,
            reviewerHandler: approvingReviewerHandler,
            integHandler: async ({ opts, tempDir }) => {
                const verifyIds = parseVerifyIds(opts.prompt);
                if (verifyIds.includes(subTargetId)) {
                    await runCmd(`bd close ${subTargetId} --reason "Verified"`, tempDir);
                    return {
                        content: [{
                            text: JSON.stringify({
                                featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [],
                                summary: `Verified and closed ${subTargetId}.`,
                            })
                        }]
                    };
                }
                return {
                    content: [{
                        text: JSON.stringify({ featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [], summary: 'Nothing to verify this cycle.' })
                    }]
                };
            },
        });

        check(stalled.error instanceof StalledSprintError, `Expected a genuine StalledSprintError from the permanently-blocked sibling task, got: ${stalled.error ? stalled.error.constructor.name + ': ' + stalled.error.message : 'no error'}`);
        check(
            !/the verifier may be failing/.test(stalled.error.message),
            `Expected the abort message to NOT blame the verifier (the sub-target it verified was genuinely closed earlier; the stall's real cause is the permanently-blocked sibling task) -- got: ${stalled.error.message}`
        );
        const subTarget = stalled.finalBeadsById.get(subTargetId);
        check(subTarget && subTarget.status === 'closed', `Expected the verify-routed sub-target to be closed in final bd state (proving the earlier real verify-closure genuinely happened), got status=${subTarget ? subTarget.status : 'MISSING'}`);
    });
});
