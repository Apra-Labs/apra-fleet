import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';
import { activeDecisionWaits, PAUSED_AWAITING_DECISION } from '../fleet-sprint/decision-wait.mjs';

// =============================================================================
// The premium-cap gate end to end through runner.js (fleet-sprint/tier-cap.mjs):
// after plan approval and before the first Develop round, a plan whose premium
// task beads exceed the tier policy's cap gets at most two scoped re-plans,
// then an operator decision that holds Develop until it is answered. A re-plan
// that fixes the cap lets Develop start; quality has no gate. The engine never
// writes a bead's model metadata.
//
// Every scenario: five tasks, two of them premium (P1, P2). balanced allows
// floor(20% x 5) = 1 premium bead, so the plan is over the cap by one.
// =============================================================================

const check = (cond, msg) => assert.ok(cond, msg);

let priorPoll;
before(() => {
    priorPoll = process.env.APRA_FLEET_DECISION_POLL_MS;
    process.env.APRA_FLEET_DECISION_POLL_MS = '1500';
});
after(() => {
    if (priorPoll === undefined) delete process.env.APRA_FLEET_DECISION_POLL_MS;
    else process.env.APRA_FLEET_DECISION_POLL_MS = priorPoll;
});

const resetSyncMemo = () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
};

const P1 = 'Task: PC premium one';
const P2 = 'Task: PC premium two';
const S = ['Task: PC standard one', 'Task: PC standard two', 'Task: PC standard three'];
const TITLES = [P1, P2, ...S];

const assignedIds = (opts) => {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const approve = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});
const closeAll = async ({ opts, runCmd: rc, tempDir: td }) => {
    const ids = assignedIds(opts);
    for (const id of ids) await rc(`bd close ${id}`, td);
    return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Done.' }) }] };
};
const isCapReplan = (d) => d.agent === 'planner' && d.prompt.startsWith('PREMIUM-CAP REPLAN');
const isMainPlanner = (d) => d.agent === 'planner' && d.prompt.includes('build a features+tasks DAG');
const isMainPlanReviewer = (d) => d.agent === 'plan-reviewer' && d.prompt.startsWith('Review the beads DAG') && !d.prompt.includes('REPLAN REVIEW');
// An engine-issued bd write of a bead's model tier, in any spelling.
const writesModel = (cmd) => /^bd (update|create)\b/.test(cmd) && /model/.test(cmd) && /(--set-metadata|--metadata)/.test(cmd);

/**
 * @param {string} tag
 * @param {{ tierPolicy?: string, fixOnReplan?: boolean, answer?: boolean }} opts
 */
async function capScenario(tag, { tierPolicy, fixOnReplan = false, answer = false } = {}) {
    const seen = { states: [], pauses: [], doerCalls: 0, doersAtPause: null, decision: null, answerError: null, ids: {} };
    const scenario = await runDevelopLoopScenario(tag, {
        members: ['local'],
        taskSpecs: TITLES.map((title) => ({ title })),
        ...(tierPolicy ? { tierPolicy } : {}),
        beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
            let n = 0;
            for (const t of tasks) {
                n += 1;
                const model = t.title === P1 || t.title === P2 ? 'premium' : 'standard';
                seen.ids[t.title] = t.id;
                await rc(`bd update ${t.id} --set-metadata streak=lane-${n} --set-metadata streakOrder=1 --set-metadata model=${model}`, td);
            }
        },
        // The planner never touches beads in the main pass; on a premium-cap
        // re-plan it lowers P2 only when the scenario fixes the cap.
        plannerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
            if (fixOnReplan && opts.prompt.startsWith('PREMIUM-CAP REPLAN')) {
                await rc(`bd update ${seen.ids[P2]} --set-metadata model=standard`, td);
            }
            return { content: [{ text: 'Plan reviewed; no changes needed.' }] };
        },
        onWorkflow: async (workflow) => {
            workflow.on('state', (e) => { if (e.namespace === 'decisions') seen.states.push(e.data); });
            workflow.on('pause:requested', (e) => {
                seen.pauses.push(e);
                if (e.source !== 'needs_decision' || seen.pauses.length > 1) return;
                seen.doersAtPause = seen.doerCalls;
                const data = seen.states.filter((d) => d.state === PAUSED_AWAITING_DECISION).pop();
                seen.decision = data ? data.pending[0] : null;
                if (!answer || !seen.decision) return;
                (async () => {
                    await new Promise((r) => setImmediate(r));
                    const live = activeDecisionWaits().find((w) => w.pending().some((d) => d.decisionId === seen.decision.decisionId));
                    await live.recordDecisionAnswer(seen.decision.decisionId, 'a: accept the premium beads for this run');
                })().catch((err) => { seen.answerError = err; });
            });
        },
        doerHandler: async (ctx) => { seen.doerCalls += 1; return closeAll(ctx); },
        reviewerHandler: approve,
    });
    return { scenario, seen };
}

test('mock sprint (balanced): a planner that keeps the plan over the premium cap gets exactly 2 scoped re-plans naming the premium beads, then a decision; Develop waits for the answer', async () => {
    resetSyncMemo();
    {
        await withScenarioMarkers('premium cap decision', async () => {
            const { scenario, seen } = await capScenario('pcap-decide', { answer: true });
            check(!seen.answerError, `answering failed: ${seen.answerError && seen.answerError.message}`);
            assert.equal(scenario.error, null, `the run completes: ${scenario.error && scenario.error.message}`);
            const p1 = seen.ids[P1];
            const p2 = seen.ids[P2];

            // Exactly two scoped re-plans, each naming both premium beads and
            // the number that must move.
            const replans = scenario.dispatched.filter(isCapReplan);
            assert.equal(replans.length, 2, `exactly 2 premium-cap re-plans, got ${replans.length}`);
            for (const r of replans) {
                check(r.prompt.includes(p1) && r.prompt.includes(p2), 'the re-plan prompt names both premium beads');
                check(r.prompt.includes('Move at least 1 of them'), 'the re-plan prompt names the number that must move');
            }

            // Then one decision naming the beads, the cap and the fix.
            check(seen.decision, 'a decision was pending when the run paused');
            assert.equal(seen.decision.beadId, [p1, p2].sort()[0]);
            check(seen.decision.question.includes(p1) && seen.decision.question.includes(p2), seen.decision.question);
            check(seen.decision.question.includes('cap 20%'), seen.decision.question);
            check(seen.decision.options.some((o) => o.text.includes('tierOverrides')), 'the raise-the-cap fix is offered');
            assert.equal(seen.pauses.filter((p) => p.source === 'needs_decision').length, 1);

            // Develop did not start before the decision: no doer dispatch at
            // the pause, and every re-plan precedes the first doer dispatch.
            assert.equal(seen.doersAtPause, 0, 'no doer was dispatched before the decision was answered');
            const firstDoer = scenario.dispatched.findIndex((d) => d.agent === 'doer');
            check(firstDoer > scenario.dispatched.lastIndexOf(replans[1]), 'Develop starts only after the re-plans');
            // Answered (accept): the premium beads are released and developed.
            for (const id of [p1, p2]) assert.equal(scenario.finalBeadsById.get(id).status, 'closed', `${id} developed after the answer`);
            check(scenario.logs.some((l) => l.includes('still over cap after 2 scoped re-plan(s)') && l.includes(p1) && l.includes(p2)),
                'the gate logs the beads and the fix');

            // The engine never wrote a model tier.
            assert.deepEqual(scenario.commandLog.filter((c) => writesModel(String(c))), []);
            for (const id of [p1, p2]) assert.equal(scenario.finalBeadsById.get(id).metadata.model, 'premium');
        });
    }
});

test('mock sprint (balanced): a re-plan that brings the plan within the cap lets Develop start with no decision', async () => {
    resetSyncMemo();
    await withScenarioMarkers('premium cap fixed by re-plan', async () => {
        const { scenario, seen } = await capScenario('pcap-fixed', { fixOnReplan: true });
        assert.equal(scenario.error, null, `the run completes: ${scenario.error && scenario.error.message}`);
        assert.equal(scenario.dispatched.filter(isCapReplan).length, 1, 'one re-plan was enough');
        assert.equal(seen.pauses.filter((p) => p.source === 'needs_decision').length, 0, 'no decision');
        check(scenario.dispatched.some((d) => d.agent === 'doer'), 'Develop started');
        check(scenario.logs.some((l) => l.includes('after scoped re-plan 1') && l.includes('within cap')), 'the recount is logged');
        // The cap percentage is in the main planner and plan-reviewer prompts.
        check(scenario.dispatched.filter(isMainPlanner).every((d) => d.prompt.includes('allows at most 20% ')), 'planner prompt carries the cap');
        check(scenario.dispatched.filter(isMainPlanReviewer).every((d) => d.prompt.includes('allows at most 20% ')), 'plan-reviewer prompt carries the cap');
        // Only the planner (this scenario's handler) lowered P2; the engine wrote no tier.
        assert.deepEqual(scenario.commandLog.filter((c) => writesModel(String(c))), []);
        assert.equal(scenario.finalBeadsById.get(seen.ids[P1]).metadata.model, 'premium');
    });
});

test('mock sprint (quality): the same over-cap plan gets no gate -- no re-plan, no decision, no cap text in the prompts', async () => {
    resetSyncMemo();
    await withScenarioMarkers('premium cap quality no-op', async () => {
        const { scenario, seen } = await capScenario('pcap-quality', { tierPolicy: 'quality' });
        assert.equal(scenario.error, null, `the run completes: ${scenario.error && scenario.error.message}`);
        assert.equal(scenario.dispatched.filter(isCapReplan).length, 0, 'no premium-cap re-plan');
        assert.equal(seen.pauses.filter((p) => p.source === 'needs_decision').length, 0, 'no decision');
        check(scenario.dispatched.some((d) => d.agent === 'doer'), 'Develop started');
        check(!scenario.logs.some((l) => l.includes('[tier-cap]')), 'the gate logs nothing under quality');
        for (const d of scenario.dispatched.filter((x) => x.agent === 'planner' || x.agent === 'plan-reviewer')) {
            check(!d.prompt.includes('PREMIUM CAP') && !d.prompt.includes('PREMIUM-CAP'), 'no cap text under quality');
        }
        assert.deepEqual(scenario.commandLog.filter((c) => writesModel(String(c))), []);
        for (const id of [seen.ids[P1], seen.ids[P2]]) assert.equal(scenario.finalBeadsById.get(id).metadata.model, 'premium');
    });
});
