import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreSprintValidationError, PRE_SPRINT_REFUSAL_REASONS, StalledSprintError } from '../fleet-sprint/errors.mjs';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// A bead blocked only by verify-routed beads, with no integ-test playbook.
//
// A verify-routed bead (open, every child closed) closes only through the
// integ-test phase. With no integ-test-playbook.md that phase never runs, so
// the verify-routed bead never closes -- and a bead whose only unmet `blocks`
// blockers are such beads can never become ready. Before the fix the sprint
// spun until the stall detector aborted. Now:
//   - present at launch: pre-sprint refuses with a typed reason, naming the
//     beads and the exact `bd dep` command, and leaves the DAG alone;
//   - arising mid-run: the cycle loop exits without a stall abort and the
//     summary names the unfinished bead and the command.
// =============================================================================

const APPROVE = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});

/** Creates a bug under `parentId` and returns its id. */
async function createBug(run, td, title, parentId) {
    const id = (await run(`bd create -t bug "${title}" -d "Scenario bug." --silent`, td)).stdout.trim();
    await run(`bd update ${id} --parent ${parentId}`, td);
    return id;
}

/** Creates a task under `parentId` and returns its id. */
async function createChild(run, td, title, parentId) {
    const id = (await run(`bd create -t task "${title}" -d "Scenario child." --silent`, td)).stdout.trim();
    await run(`bd update ${id} --parent ${parentId}`, td);
    return id;
}

const blocksDeps = (bead) => (bead && bead.dependencies ? bead.dependencies : [])
    .filter((d) => d.type === 'blocks')
    .map((d) => d.depends_on_id)
    .sort();

test('mock sprint: pre-sprint refuses a bead blocked only by verify-routed beads when no integ playbook exists', async () => {
    await withScenarioMarkers('verifyblockpresprint (pre-sprint refusal)', async () => {
        const ids = {};
        const res = await runDevelopLoopScenario('verifyblockpresprint', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Waits on bugs T' }],
            maxCycles: 2,
            reviewerHandler: APPROVE,
            beforeSprint: async ({ tempDir: td, runCmd: run, epicBead, tasks }) => {
                ids.t = tasks[0].id;
                ids.b1 = await createBug(run, td, 'Bug: verify-routed B1', epicBead.id);
                ids.b2 = await createBug(run, td, 'Bug: verify-routed B2', epicBead.id);
                for (const b of [ids.b1, ids.b2]) {
                    const c = await createChild(run, td, `Task: fix for ${b}`, b);
                    await run(`bd close ${c}`, td);
                }
                await run(`bd dep add ${ids.t} ${ids.b1}`, td);
                await run(`bd dep add ${ids.t} ${ids.b2}`, td);
            },
        });
        check(
            res.error instanceof PreSprintValidationError,
            `expected a PreSprintValidationError, got: ${res.error ? res.error.constructor.name + ': ' + res.error.message : 'no error'}`
        );
        check(
            res.error.reason === PRE_SPRINT_REFUSAL_REASONS.UNREACHABLE_VERIFY_BLOCK,
            `expected reason UNREACHABLE_VERIFY_BLOCK, got: ${res.error.reason}`
        );
        for (const id of [ids.t, ids.b1, ids.b2]) {
            check(res.error.message.includes(id), `expected the refusal to name ${id}: ${res.error.message}`);
        }
        check(
            res.error.message.includes(`bd dep remove ${ids.t} ${ids.b1}`),
            `expected the refusal to give the exact bd dep command: ${res.error.message}`
        );
        check(
            !res.dispatched.some((d) => d.agent === 'doer'),
            'the refusal must come before any doer dispatch'
        );
        const t = res.finalBeadsById.get(ids.t);
        assert.deepStrictEqual(
            blocksDeps(t),
            [ids.b1, ids.b2].sort(),
            `the DAG must be left unmodified, got: ${JSON.stringify(t)}`
        );
    });
});

test('mock sprint: the same shape arising mid-run exits the loop without a stall abort and names the unfinished bead', async () => {
    await withScenarioMarkers('verifyblockmidrun (mid-run exit)', async () => {
        const ids = {};
        const res = await runDevelopLoopScenario('verifyblockmidrun', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Waits on bug T' }],
            maxCycles: 4,
            reviewerHandler: APPROVE,
            beforeSprint: async ({ tempDir: td, runCmd: run, epicBead, tasks }) => {
                ids.t = tasks[0].id;
                ids.b = await createBug(run, td, 'Bug: becomes verify-routed B', epicBead.id);
                // The child is still open at launch, so B is not verify-routed
                // yet and pre-sprint has nothing to refuse; the default doer
                // closes it in cycle 1.
                ids.c = await createChild(run, td, 'Task: fix for B', ids.b);
                await run(`bd dep add ${ids.t} ${ids.b}`, td);
            },
        });
        check(
            !(res.error instanceof StalledSprintError),
            `the run must not stall-abort: ${res.error ? res.error.message : ''}`
        );
        check(!res.error, `scenario should not throw: ${res.error ? res.error.constructor.name + ': ' + res.error.message : ''}`);
        check(
            res.finalBeadsById.get(ids.c) && res.finalBeadsById.get(ids.c).status === 'closed',
            `expected the child ${ids.c} closed, got: ${JSON.stringify(res.finalBeadsById.get(ids.c))}`
        );
        check(
            res.logs.some((m) => m.includes('exiting cycle loop') && m.includes(`Unfinished: ${ids.t}`)),
            `expected the cycle-loop exit log to name ${ids.t}, logs: ${JSON.stringify(res.logs)}`
        );
        check(
            res.result && res.result.verdict === 'FAIL',
            `expected verdict FAIL, got: ${JSON.stringify(res.result)}`
        );
        check(
            typeof res.result.notes === 'string' && res.result.notes.includes(ids.t) && res.result.notes.includes(`bd dep remove ${ids.t} ${ids.b}`),
            `expected the final notes to name ${ids.t} and the bd dep command, got: ${JSON.stringify(res.result.notes)}`
        );
        check(
            res.finalBeadsById.get(ids.t) && res.finalBeadsById.get(ids.t).status === 'open',
            `expected ${ids.t} left open, got: ${JSON.stringify(res.finalBeadsById.get(ids.t))}`
        );
    });
});

test('mock sprint: a below-goal bead blocked only by verify-routed beads does not refuse the sprint and is logged as a warning', async () => {
    await withScenarioMarkers('verifyblockbelowgoal (below-goal warning)', async () => {
        const ids = {};
        const res = await runDevelopLoopScenario('verifyblockbelowgoal', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Goal work G' },
                { title: 'Task: Below-goal T', priority: 'P3' },
            ],
            maxCycles: 2,
            reviewerHandler: APPROVE,
            beforeSprint: async ({ tempDir: td, runCmd: run, epicBead, tasks }) => {
                ids.g = tasks[0].id;
                ids.t = tasks[1].id;
                ids.b = await createBug(run, td, 'Bug: verify-routed below-goal B', epicBead.id);
                await run(`bd update ${ids.b} --priority 3`, td);
                const c = await createChild(run, td, `Task: fix for ${ids.b}`, ids.b);
                await run(`bd update ${c} --priority 3`, td);
                await run(`bd close ${c}`, td);
                await run(`bd dep add ${ids.t} ${ids.b}`, td);
            },
        });
        check(
            !(res.error instanceof PreSprintValidationError),
            `a below-goal bead must not refuse the sprint: ${res.error ? res.error.message : ''}`
        );
        check(
            res.logs.some((m) => m.includes('Pre-sprint warning') && m.includes(ids.t) && m.includes(`bd dep remove ${ids.t} ${ids.b}`)),
            `expected a pre-sprint warning naming ${ids.t} and the bd dep command, logs: ${JSON.stringify(res.logs)}`
        );
        check(
            res.dispatched.some((d) => d.agent === 'doer'),
            'the goal work must still be dispatched'
        );
        check(
            res.finalBeadsById.get(ids.g) && res.finalBeadsById.get(ids.g).status === 'closed',
            `expected the goal bead ${ids.g} closed, got: ${JSON.stringify(res.finalBeadsById.get(ids.g))}`
        );
    });
});
