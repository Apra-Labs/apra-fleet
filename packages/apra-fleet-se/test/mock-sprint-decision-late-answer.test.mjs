// A decision answered at the end of the LAST allowed cycle grants exactly one
// extra cycle when the budget allows (the released bead is then dispatched), or
// is reported by name in the log and the verdict notes when it does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { activeDecisionWaits, PAUSED_AWAITING_DECISION } from '../fleet-sprint/decision-wait.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';

const resetSyncMemo = () => { invalidateSyncRemoteCache(); clearLastSyncedTip(); clearTipProbeFailures(); };
const assignedIds = (opts) => {
    const m = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return m ? m[1].split(',').map((x) => x.trim()).filter(Boolean) : [];
};
const approve = async () => ({ content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'ok', reopenIds: [], newTasks: [] }) }] });
const DECIDE = 'Task: decide the cookie handling';
const STEP1 = 'Task: step one';
const STEP2 = 'Task: step two';
const DECISION = (beadId) => ({
    beadId, question: 'Keep the attributes?',
    options: [{ id: 'a', text: 'Keep' }, { id: 'b', text: 'Drop' }], recommendation: 'a',
});

// maxCycles is 1, so the only cycle is the last one. The decision is raised in
// it; the answer arrives when the run parks.
async function lateScenario(tag, { exhaustBudget, parkAtRoundStart = false }) {
    const seen = { states: [], cycleGroups: [], answered: false };
    const scenario = await runDevelopLoopScenario(tag, {
        members: ['local'],
        taskSpecs: [STEP1, STEP2, DECIDE].map((title) => ({ title })),
        maxCycles: 1,
        beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
            const id = (title) => tasks.find((x) => x.title === title).id;
            // A chain, so the decision is raised in the third and last develop
            // round: the round loop then ends and the stall is met at Cycle
            // Evaluation (a wait at the start of a round is not "late").
            if (parkAtRoundStart) {
                // DECIDE is raised in round 1; STEP2 waits behind it, so round 2
                // starts with nothing ready and parks there (not at Cycle Evaluation).
                await rc(`bd dep add ${id(STEP2)} ${id(DECIDE)}`, td);
                return;
            }
            await rc(`bd dep add ${id(STEP2)} ${id(STEP1)}`, td);
            await rc(`bd dep add ${id(DECIDE)} ${id(STEP2)}`, td);
        },
        onWorkflow: async (workflow) => {
            workflow.on('state', (e) => { if (e.namespace === 'decisions') seen.states.push(e.data); });
            workflow.on('pause:requested', (e) => {
                if (e.source !== 'needs_decision' || seen.answered) return;
                seen.answered = true;
                const data = seen.states.filter((d) => d.state === PAUSED_AWAITING_DECISION).pop();
                // Exhausted: remaining() <= 0 without tripping agent()'s own
                // total-based ceiling (total stays null).
                if (exhaustBudget) workflow._currentBudget().remaining = () => 0;
                (async () => {
                    await new Promise((r) => setImmediate(r));
                    const live = activeDecisionWaits().find((w) => w.pending().some((d) => d.decisionId === data.pending[0].decisionId));
                    await live.recordDecisionAnswer(data.pending[0].decisionId, 'a: keep them');
                })().catch((err) => { seen.answerError = err; });
            });
        },
        doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
            const ids = assignedIds(opts);
            const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
            const decide = list.find((b) => b.title === DECIDE);
            if (decide && ids.includes(decide.id)) {
                const shown = JSON.parse((await rc(`bd show ${decide.id} --json`, td)).stdout || '[]');
                const notes = (Array.isArray(shown) ? shown[0] : shown).notes || '';
                if (!notes.includes('OPERATOR DECISION')) {
                    return { content: [{ text: JSON.stringify({ status: 'NEEDS-DECISION', closedIds: [], notes: 'choose', decision: DECISION(decide.id) }) }] };
                }
            }
            // Round-start scenario: STEP2 is never finished, so other work stays open.
            const step2 = list.find((b) => b.title === STEP2);
            const toClose = parkAtRoundStart ? ids.filter((x) => !step2 || x !== step2.id) : ids;
            for (const x of toClose) await rc(`bd close ${x}`, td);
            return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: toClose, notes: 'Done.' }) }] };
        },
        reviewerHandler: approve,
    });
    return { scenario, seen };
}
const doerOn = (scenario, id) => scenario.dispatched.filter((d) => d.agent === 'doer' && assignedIds(d).includes(id));

test('mock sprint: a decision answered in the last cycle with budget remaining gets exactly one extra cycle and the released bead is dispatched and closed', async () => {
    resetSyncMemo();
    await withScenarioMarkers('late decision answer, budget remains', async () => {
        const { scenario, seen } = await lateScenario('dlate-extra', { exhaustBudget: false });
        assert.ok(!seen.answerError, `answering failed: ${seen.answerError && seen.answerError.message}`);
        assert.equal(scenario.error, null, `run completes: ${scenario.error && scenario.error.message}`);
        const x = scenario.tasks.find((t) => t.title === DECIDE).id;
        const grants = scenario.logs.filter((l) => l.includes('granting one extra cycle'));
        assert.equal(grants.length, 1, `exactly one extra cycle granted: ${JSON.stringify(grants)}`);
        assert.ok(grants[0].includes(x), 'the grant names the released bead');
        assert.equal(doerOn(scenario, x).length, 2, 'dispatched in the cycle that raised the decision and again in the extra cycle');
        assert.equal(scenario.finalBeadsById.get(x).status, 'closed');
        assert.ok(!scenario.logs.some((l) => l.includes('answered too late')), 'nothing reported as too late');
    });
});

test('mock sprint: a decision answered in the last cycle with the budget exhausted runs no extra cycle and names the unworked bead and decision in the log and the verdict notes', async () => {
    resetSyncMemo();
    await withScenarioMarkers('late decision answer, budget exhausted', async () => {
        const { scenario, seen } = await lateScenario('dlate-budget', { exhaustBudget: true });
        assert.ok(!seen.answerError, `answering failed: ${seen.answerError && seen.answerError.message}`);
        const x = scenario.tasks.find((t) => t.title === DECIDE).id;
        assert.equal(scenario.logs.filter((l) => l.includes('granting one extra cycle')).length, 0, 'no extra cycle');
        assert.equal(doerOn(scenario, x).length, 1, 'the released bead was not re-dispatched');
        const line = scenario.logs.find((l) => l.includes('answered too late to be worked'));
        assert.ok(line, `a log line reports it: ${JSON.stringify(scenario.logs.slice(-15))}`);
        assert.ok(line.includes(x) && line.includes('decision-'), 'the line names the bead and the decision');
        const notes = scenario.result && scenario.result.notes;
        assert.ok(typeof notes === 'string' && notes.includes('answered too late to be worked') && notes.includes(x), `verdict notes name it: ${notes}`);
    });
});

test('mock sprint: a decision answered at the start of a develop round in the last cycle is not late and grants no extra cycle', async () => {
    resetSyncMemo();
    await withScenarioMarkers('decision parked at develop round start', async () => {
        const { scenario, seen } = await lateScenario('dlate-roundstart', { exhaustBudget: false, parkAtRoundStart: true });
        assert.ok(!seen.answerError, `answering failed: ${seen.answerError && seen.answerError.message}`);
        assert.ok(seen.answered, 'the run did park for a decision');
        const x = scenario.tasks.find((t) => t.title === DECIDE).id;
        assert.ok(scenario.logs.some((l) => /start of Develop C1 R2/.test(l)), `parked at the start of develop round 2: ${JSON.stringify(scenario.logs.slice(-20))}`);
        assert.equal(scenario.logs.filter((l) => l.includes('granting one extra cycle')).length, 0, 'no extra cycle granted');
        assert.ok(doerOn(scenario, x).length >= 2, 'released bead dispatched in the same cycle');
    });
});
