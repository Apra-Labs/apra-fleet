import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.79.2 -- mode (i) BATCH behind the `doer_worklist_mode`
// config flag: ONE dispatch carries the doer's whole ordered worklist
// (tier-homogeneous required); the default (flag omitted) remains mode (ii)
// per-streak dispatches. A mixed-tier round in batch mode never produces a
// mixed batch -- each tier partition batches separately.
// =============================================================================

const idsForDispatch = (d) => {
    const match = d.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};

const stampLanes = (specs) => async ({ runCmd: rc, tempDir: td, tasks }) => {
    for (const { title, streak, order, model } of specs) {
        const t = tasks.find((x) => x.title === title);
        await rc(`bd update ${t.id} --set-metadata streak=${streak} --set-metadata streakOrder=${order} --set-metadata model=${model}`, td);
    }
};

const approveReviewer = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }]
});

const closeAllDoer = async ({ opts, runCmd: rc, tempDir: td }) => {
    const ids = idsForDispatch({ prompt: opts.prompt });
    for (const id of ids) {
        await rc(`bd close ${id}`, td);
    }
    return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed.' }) }] };
};

test('mock sprint (mode i, config-gated): doer_worklist_mode=batch sends ONE dispatch carrying the whole ordered worklist', async () => {
    await withScenarioMarkers('worklist batch mode', async () => {
        const scenario = await runDevelopLoopScenario('wlbatch', {
            members: ['solo'],
            taskSpecs: [
                { title: 'Task: WLB one' },
                { title: 'Task: WLB two' },
                { title: 'Task: WLB three' },
            ],
            beforeSprint: stampLanes([
                { title: 'Task: WLB one', streak: 'lane-1', order: 1, model: 'standard' },
                { title: 'Task: WLB two', streak: 'lane-2', order: 2, model: 'standard' },
                { title: 'Task: WLB three', streak: 'lane-3', order: 3, model: 'standard' },
            ]),
            reviewerHandler: approveReviewer,
            doerHandler: closeAllDoer,
            doerWorklistMode: 'batch',
        });

        check(!scenario.error, `Scenario should not error: ${scenario.error ? scenario.error.message : ''}`);
        check(scenario.result && scenario.result.status === 'success', `Expected sprint success, got: ${JSON.stringify(scenario.result)}`);

        const oneId = scenario.tasks.find((t) => t.title === 'Task: WLB one').id;
        const twoId = scenario.tasks.find((t) => t.title === 'Task: WLB two').id;
        const threeId = scenario.tasks.find((t) => t.title === 'Task: WLB three').id;

        check(
            scenario.logs.some((m) => m.includes('Doer worklists: 3 ready streak(s) > 1 doer(s)') && m.includes('mode: batch')),
            `Expected the batch-mode packing log, got: ${JSON.stringify(scenario.logs.filter((m) => m.includes('Doer worklists')))}`
        );

        // Exactly ONE doer dispatch in the whole sprint, carrying all three
        // streaks IN ORDER, with the batch preamble naming each streak
        // boundary.
        const doerDispatches = scenario.dispatched.filter((d) => d.agent === 'doer');
        check(doerDispatches.length === 1, `Expected exactly 1 batched doer dispatch, got ${doerDispatches.length}: ${JSON.stringify(doerDispatches.map(idsForDispatch))}`);
        assert.deepEqual(idsForDispatch(doerDispatches[0]), [oneId, twoId, threeId], 'Batch must carry the worklist in order');
        check(doerDispatches[0].prompt.includes('ORDERED MULTI-STREAK WORKLIST'), 'Expected the batch preamble');
        check(
            doerDispatches[0].prompt.includes(`streak 1: [${oneId}]`)
            && doerDispatches[0].prompt.includes(`streak 2: [${twoId}]`)
            && doerDispatches[0].prompt.includes(`streak 3: [${threeId}]`),
            `Expected per-streak boundaries in the batch prompt, got: ${doerDispatches[0].prompt.slice(0, 400)}`
        );

        // Per-streak outcome attribution still happened (one outcome per
        // sub-streak, not one blob for the batch).
        check(
            scenario.logs.some((m) => m.includes('streak outcomes:')
                && m.includes(`["${oneId}"]`) && m.includes(`["${twoId}"]`) && m.includes(`["${threeId}"]`)),
            `Expected three per-streak outcomes from the single batch, got: ${JSON.stringify(scenario.logs.filter((m) => m.includes('streak outcomes')))}`
        );

        for (const id of [oneId, twoId, threeId]) {
            const b = scenario.finalBeadsById.get(id);
            check(b && b.status === 'closed', `Expected bead '${id}' closed, got: ${JSON.stringify(b)}`);
        }
    });
});

test('mock sprint: the DEFAULT (flag omitted) remains mode (ii) -- per-streak dispatches, no batch preamble', async () => {
    await withScenarioMarkers('worklist default mode', async () => {
        const scenario = await runDevelopLoopScenario('wldefault', {
            members: ['solo'],
            taskSpecs: [
                { title: 'Task: WLD one' },
                { title: 'Task: WLD two' },
                { title: 'Task: WLD three' },
            ],
            beforeSprint: stampLanes([
                { title: 'Task: WLD one', streak: 'lane-1', order: 1, model: 'standard' },
                { title: 'Task: WLD two', streak: 'lane-2', order: 2, model: 'standard' },
                { title: 'Task: WLD three', streak: 'lane-3', order: 3, model: 'standard' },
            ]),
            reviewerHandler: approveReviewer,
            doerHandler: closeAllDoer,
            // NO doerWorklistMode: default must be mode (ii) RESUMED SEQUENCE.
        });

        check(!scenario.error, `Scenario should not error: ${scenario.error ? scenario.error.message : ''}`);
        check(scenario.result && scenario.result.status === 'success', `Expected sprint success, got: ${JSON.stringify(scenario.result)}`);

        const doerDispatches = scenario.dispatched.filter((d) => d.agent === 'doer');
        check(doerDispatches.length === 3, `Expected 3 per-streak dispatches by default, got ${doerDispatches.length}`);
        check(doerDispatches.every((d) => idsForDispatch(d).length === 1), `Each default-mode dispatch carries ONE streak, got: ${JSON.stringify(doerDispatches.map(idsForDispatch))}`);
        check(doerDispatches.every((d) => !d.prompt.includes('ORDERED MULTI-STREAK WORKLIST')), 'Default mode must never send the batch preamble');
        check(
            scenario.logs.some((m) => m.includes('Doer worklists:') && m.includes('mode: resume')),
            `Expected the default packing log to say mode: resume, got: ${JSON.stringify(scenario.logs.filter((m) => m.includes('Doer worklists')))}`
        );
    });
});

test('mock sprint (mode i): a mixed-tier round batches each tier separately -- a cheap+premium batch is never dispatched', async () => {
    await withScenarioMarkers('worklist batch tier separation', async () => {
        const scenario = await runDevelopLoopScenario('wlbatchtier', {
            members: ['solo'],
            taskSpecs: [
                { title: 'Task: WLT cheap one' },
                { title: 'Task: WLT cheap two' },
                { title: 'Task: WLT premium' },
            ],
            beforeSprint: stampLanes([
                { title: 'Task: WLT cheap one', streak: 'lane-c1', order: 1, model: 'cheap' },
                { title: 'Task: WLT cheap two', streak: 'lane-c2', order: 2, model: 'cheap' },
                { title: 'Task: WLT premium', streak: 'lane-p', order: 3, model: 'premium' },
            ]),
            reviewerHandler: approveReviewer,
            doerHandler: closeAllDoer,
            doerWorklistMode: 'batch',
        });

        check(!scenario.error, `Scenario should not error: ${scenario.error ? scenario.error.message : ''}`);
        check(scenario.result && scenario.result.status === 'success', `Expected sprint success, got: ${JSON.stringify(scenario.result)}`);

        const cheap1 = scenario.tasks.find((t) => t.title === 'Task: WLT cheap one').id;
        const cheap2 = scenario.tasks.find((t) => t.title === 'Task: WLT cheap two').id;
        const premium = scenario.tasks.find((t) => t.title === 'Task: WLT premium').id;

        const doerDispatches = scenario.dispatched.filter((d) => d.agent === 'doer');
        const dispatchIds = doerDispatches.map(idsForDispatch);
        // Two dispatches: the 2-streak cheap batch and the lone premium
        // streak -- NEVER one 3-bead cheap+premium batch.
        check(doerDispatches.length === 2, `Expected 2 tier-pure dispatches, got ${doerDispatches.length}: ${JSON.stringify(dispatchIds)}`);
        check(
            dispatchIds.some((ids) => ids.length === 2 && ids.includes(cheap1) && ids.includes(cheap2)),
            `Expected a cheap-only 2-streak batch, got: ${JSON.stringify(dispatchIds)}`
        );
        check(
            dispatchIds.some((ids) => ids.length === 1 && ids[0] === premium),
            `Expected the premium streak dispatched alone, got: ${JSON.stringify(dispatchIds)}`
        );
        check(
            !dispatchIds.some((ids) => ids.includes(premium) && (ids.includes(cheap1) || ids.includes(cheap2))),
            `A cheap+premium batch must never be assigned, got: ${JSON.stringify(dispatchIds)}`
        );
        // Per-dispatch models: the batch runs at cheap, the outlier at premium
        // -- no silent escalation of cheap work, no premium work below tier.
        const cheapDispatch = doerDispatches[dispatchIds.findIndex((ids) => ids.length === 2)];
        const premiumDispatch = doerDispatches[dispatchIds.findIndex((ids) => ids.length === 1)];
        check(cheapDispatch.model === 'cheap', `Expected the cheap batch at model=cheap, got ${JSON.stringify(cheapDispatch.model)}`);
        check(premiumDispatch.model === 'premium', `Expected the premium streak at model=premium, got ${JSON.stringify(premiumDispatch.model)}`);

        for (const id of [cheap1, cheap2, premium]) {
            const b = scenario.finalBeadsById.get(id);
            check(b && b.status === 'closed', `Expected bead '${id}' closed, got: ${JSON.stringify(b)}`);
        }
    });
});
