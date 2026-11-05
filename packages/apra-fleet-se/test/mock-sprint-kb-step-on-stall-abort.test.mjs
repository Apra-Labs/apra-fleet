import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { TEST_CONCURRENCY } from './helpers/test-concurrency.mjs';
import { SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';
import { runHarvestKbStep } from '../fleet-sprint/phases/harvest.mjs';

// =============================================================================
// D5: the harvester's KB step (queued KB writes applied plus the harvest
// bible round, kbWork.commitRound) also runs when a sprint STALLS or ABORTS,
// through the REAL runner.js main() on the mock-sprint harness -- not only
// after a normal harvest. It is best-effort: the stall/abort error still
// reaches the caller unchanged.
// =============================================================================

const report = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });
const assignedIds = (prompt) => {
    const m = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const kbStepLines = (logs, label) => logs.filter((l) => l.includes(`[kb-work] KB step '${label}' ran:`));
const TIMEOUT = scaledTimeout(240000, { concurrency: TEST_CONCURRENCY });

describe('the KB step runs on a stalled or aborted sprint', () => {
    test('a stalled sprint (every bead BLOCKED, set-aside stall in cycle 1) still runs the KB step, and the stall stands', { timeout: TIMEOUT }, async () => {
        await withScenarioMarkers('kb step on stall', async () => {
            const run = await runDevelopLoopScenario('kbstepstall', {
                members: ['local'],
                taskSpecs: [{ title: 'Task: needs a missing toolchain' }],
                maxCycles: 3,
                doerHandler: async ({ opts }) => report({
                    status: 'BLOCKED', closedIds: [], blockedIds: assignedIds(opts.prompt),
                    notes: 'Missing toolchain: cargo is not installed on this member.',
                }),
                reviewerHandler: async () => report({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }),
            });
            assert.ok(run.error, 'the run must end in a stall');
            assert.equal(run.error.code, 'SPRINT_STALLED', run.error.message);
            assert.equal(kbStepLines(run.logs, 'harvest (sprint stalled)').length, 1, run.logs.filter((l) => l.includes('[kb-work]')).join('\n'));
            assert.equal(kbStepLines(run.logs, 'harvest').length, 0, 'no normal harvest ran');
            // The step precedes the seal: the bible is sealed only after it.
            const stepAt = run.logs.findIndex((l) => l.includes("KB step 'harvest (sprint stalled)' ran:"));
            const sealAt = run.logs.findIndex((l) => l.includes('[kb-work] bible commits sealed'));
            assert.ok(sealAt === -1 || sealAt > stepAt, `the seal must follow the KB step (step ${stepAt}, seal ${sealAt})`);
        });
    });

    test('an aborted sprint (plan rejected) still runs the KB step, and the abort stands', { timeout: TIMEOUT }, async () => {
        await withScenarioMarkers('kb step on abort', async () => {
            const run = await runDevelopLoopScenario('kbstepabort', {
                members: ['local'],
                taskSpecs: [{ title: 'Task: a plan the reviewer never approves' }],
                maxCycles: 1,
                planReviewerHandler: async () => report({
                    verdict: 'CHANGES_NEEDED',
                    notes: 'This can NOT be APPROVED: the DAG is still missing a documentation task.',
                    taskAssignments: [],
                }),
            });
            assert.ok(run.error instanceof SprintPlanRejectedError, `expected SprintPlanRejectedError, got ${run.error && run.error.constructor.name}`);
            assert.equal(kbStepLines(run.logs, 'harvest (sprint aborted)').length, 1, run.logs.filter((l) => l.includes('[kb-work]')).join('\n'));
        });
    });
});

describe('runHarvestKbStep is best-effort', () => {
    test('a throwing commitRound is logged and never rethrown', async () => {
        const logs = [];
        const out = await runHarvestKbStep({ commitRound: async () => { throw new Error('maintainer gone'); } }, { label: 'harvest (sprint stalled)', log: (m) => logs.push(m) });
        assert.deepEqual(out, { ran: true, error: 'maintainer gone' });
        assert.ok(logs.some((l) => /KB step 'harvest \(sprint stalled\)' failed \(non-fatal\): maintainer gone/.test(l)), logs.join('\n'));
    });

    test('a hung commitRound is abandoned after the bound', async () => {
        const logs = [];
        const out = await runHarvestKbStep({ commitRound: () => new Promise(() => {}) }, { label: 'harvest (sprint aborted)', log: (m) => logs.push(m), timeoutMs: 50 });
        assert.equal(out.ran, true);
        assert.match(out.error, /did not finish within 50ms/);
    });

    test('no KB work client: nothing runs', async () => {
        assert.deepEqual(await runHarvestKbStep(null), { ran: false, error: null });
    });

    test('a normal run: commitRound and warnPending are called, the outcome is logged', async () => {
        const calls = [];
        const logs = [];
        await runHarvestKbStep({
            commitRound: async (label) => { calls.push(['commitRound', label]); return { committed: 2, pending: 1 }; },
            warnPending: () => calls.push(['warnPending']),
        }, { log: (m) => logs.push(m) });
        assert.deepEqual(calls, [['commitRound', 'harvest'], ['warnPending']]);
        assert.ok(logs.includes("[kb-work] KB step 'harvest' ran: 2 confirmation(s) committed, 1 pending"), logs.join('\n'));
    });
});
