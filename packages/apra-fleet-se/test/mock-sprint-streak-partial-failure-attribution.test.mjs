import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.76.6 -- end-to-end (mock-sprint) verification of eft.76
// change #4 (per-bead failure attribution, apra-fleet-eft.76.4): a 3-bead
// streak (one lane, via eft.76.1/eft.76.3 lane metadata + deterministic
// grouping) whose doer closes 2 of the 3 assigned beads and refuses the 3rd
// must:
//   (1) keep the 2 verifiably-closed beads closed permanently,
//   (2) emit an exact "Doer streak attribution" log line naming which beads
//       closed vs which are still open,
//   (3) re-dispatch ONLY the still-open 3rd bead on the next develop round
//       within the same cycle (not the whole 3-bead streak again), and
//   (4) eventually close everything once the re-dispatched bead is
//       actually finished.
// =============================================================================

const idsForDispatch = (d) => {
    const match = d.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};

test('mock sprint: a 3-bead streak that closes 2 and refuses 1 keeps the 2 closed, re-dispatches only the 1, with an attribution log line', async () => {
    await withScenarioMarkers('streak partial failure attribution', async () => {
        console.log('Running mock sprint scenario (3-bead streak: 2 close, 1 refused)...');

        let round1Ids = null;

        const scenario = await runDevelopLoopScenario('streak-attr', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Lane C first' },
                { title: 'Task: Lane C second' },
                { title: 'Task: Lane C third' },
            ],
            // Stamp all three beads into the SAME lane, ordered, so
            // groupStreaksFromLaneMetadata() (eft.76.3) puts all three into
            // one doer streak on round 1 -- exactly the "3-bead streak" this
            // acceptance criterion is about.
            beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
                const first = tasks.find((t) => t.title === 'Task: Lane C first');
                const second = tasks.find((t) => t.title === 'Task: Lane C second');
                const third = tasks.find((t) => t.title === 'Task: Lane C third');
                await rc(`bd update ${first.id} --set-metadata streak=lane-c --set-metadata streakOrder=1`, td);
                await rc(`bd update ${second.id} --set-metadata streak=lane-c --set-metadata streakOrder=2`, td);
                await rc(`bd update ${third.id} --set-metadata streak=lane-c --set-metadata streakOrder=3`, td);
            },
            // Always approve -- the default mock reviewer reopens the first
            // closed bead on review round 1, which would reopen one of the
            // two beads this scenario needs to STAY closed. This scenario is
            // about doer-side per-bead attribution, not the reviewer loop.
            reviewerHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }]
            }),
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                const ids = idsForDispatch({ prompt: opts.prompt });
                if (ids.length === 3) {
                    // Round 1: the full 3-bead streak. Actually close the
                    // first two for real; deliberately do NOT close the
                    // third -- an honest partial-completion report (unlike
                    // the "liar" scenario elsewhere in this suite, which
                    // falsely claims a close that never happened).
                    round1Ids = ids;
                    await rc(`bd close ${ids[0]}`, td);
                    await rc(`bd close ${ids[1]}`, td);
                    return {
                        content: [{
                            text: JSON.stringify({
                                status: 'VERIFY',
                                closedIds: [ids[0], ids[1]],
                                notes: `Closed ${ids[0]} and ${ids[1]}; refusing ${ids[2]} this round.`,
                            })
                        }]
                    };
                }
                // Round 2 (or later): whatever is dispatched now should be
                // ONLY the still-open third bead, re-laned alone. Finish it
                // for real this time.
                for (const id of ids) {
                    await rc(`bd close ${id}`, td);
                }
                return {
                    content: [{
                        text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed on retry.' })
                    }]
                };
            },
        });

        check(!scenario.error, `Partial-failure scenario should not error: ${scenario.error ? scenario.error.message : ''}`);
        check(scenario.result && scenario.result.status === 'success', `Expected the sprint to eventually succeed once the retried bead closes: ${JSON.stringify(scenario.result)}`);
        check(round1Ids && round1Ids.length === 3, `Expected the doer handler to observe a 3-bead streak on round 1, got: ${JSON.stringify(round1Ids)}`);

        const [firstId, secondId, thirdId] = round1Ids;

        // (1) The exact per-bead attribution log line fired for round 1,
        // naming the 2 verifiably-closed beads and the 1 still-open bead --
        // the EXACT shape runner.js's attribution logging produces (see
        // "Doer streak attribution [...]: closed=[...] failed=[...]." in
        // fleet-sprint/runner.js), not just "some log happened".
        const expectedAttributionLine =
            `Doer streak attribution [${firstId}, ${secondId}, ${thirdId}]: closed=[${firstId}, ${secondId}] failed=[${thirdId}].`;
        check(
            scenario.logs.some((m) => m === expectedAttributionLine),
            `Expected the exact attribution log line, got logs: ${JSON.stringify(scenario.logs.filter((m) => m.includes('attribution')))}`
        );

        // (2) Round 1's streak was treated as FAILED overall (one bead never
        // closed) even though 2/3 of it genuinely succeeded.
        check(
            scenario.logs.some((m) => m.includes(`Doer streak [${firstId}, ${secondId}, ${thirdId}]`) && m.includes('treating streak as FAILED') && m.includes(thirdId)),
            `Expected the 3-bead streak to be flagged FAILED due to the still-open third bead, logs: ${JSON.stringify(scenario.logs.filter((m) => m.includes('treating streak as FAILED')))}`
        );

        // (3) Exactly one doer dispatch carried all 3 ids (round 1), and a
        // LATER doer dispatch carried ONLY the still-open third bead (the
        // re-lane) -- never re-dispatching the two already-closed beads.
        const doerDispatches = scenario.dispatched.filter((d) => d.agent === 'doer');
        const threeIdDispatches = doerDispatches.filter((d) => idsForDispatch(d).length === 3);
        check(threeIdDispatches.length === 1, `Expected exactly one 3-bead doer dispatch, got ${threeIdDispatches.length}: ${JSON.stringify(doerDispatches.map(idsForDispatch))}`);

        const retryDispatch = doerDispatches.find((d) => idsForDispatch(d).length === 1 && idsForDispatch(d)[0] === thirdId);
        check(retryDispatch, `Expected a follow-up doer dispatch re-laning ONLY bead '${thirdId}', got dispatches: ${JSON.stringify(doerDispatches.map(idsForDispatch))}`);
        check(
            !doerDispatches.some((d) => idsForDispatch(d).length > 1 && d !== threeIdDispatches[0] && idsForDispatch(d).some((id) => id === firstId || id === secondId)),
            `Expected the already-closed beads '${firstId}'/'${secondId}' to never be re-dispatched, got: ${JSON.stringify(doerDispatches.map(idsForDispatch))}`
        );

        // (4) Final state: all three beads closed -- the 2 stayed closed
        // from round 1, the 3rd closed on its solo re-dispatch.
        for (const id of [firstId, secondId, thirdId]) {
            check(
                scenario.finalBeadsById.get(id) && scenario.finalBeadsById.get(id).status === 'closed',
                `Expected bead '${id}' to be closed, got: ${JSON.stringify(scenario.finalBeadsById.get(id))}`
            );
        }
    });
});
