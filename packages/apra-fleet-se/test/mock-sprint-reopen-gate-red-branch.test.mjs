import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// End-to-end pin for the dropped-reopen bug.
//
// Live failure: in a P1/P2 sprint the reviewer found the test suite red from
// the sprint's own commits and asked to reopen P3 beads the sprint had
// dispatched in round 1 (ahead of P1/P2 work). The goal-scope guard skipped
// every one ("below this sprint's goal ... deferred scope"), so nothing ever
// fixed the red branch.
//
// Both scenarios drive the REAL runner.js develop/review loop against a real
// (or replayed) bd database:
//
//   1. Dispatch filter + worked-on exemption. Scope: a P1 task, a P3 task
//      that blocks a second P1 task, and an unrelated P3 task. The unrelated
//      P3 task is never dispatched; the blocking P3 task is. The reviewer then
//      reports failing tests and reopens the blocking P3 bead (which the
//      sprint worked on): it is reopened and re-dispatched next round, with no
//      "below this sprint's goal" SKIPPED line for it.
//   2. Red branch, nothing reopenable. The reviewer reports failing tests and
//      names ONLY an untouched below-goal bead: that reopen is skipped, but an
//      in-goal fix task is filed and dispatched -- the sprint does not idle on
//      a red branch.
// =============================================================================

// The orchestrator stages every new bead's description as a member-side OS
// temp file (stageCommandBodyMemberSide) before `bd create --body-file`. In
// this in-process mock the "member" is this host, so collect each staged path
// from the bd create command and remove it once the scenario ends -- the test
// must leave nothing behind outside its sandbox.
function bodyFileTracker() {
    const paths = new Set();
    return {
        onCommand: ({ command }) => {
            const m = /--body-file "([^"]+)"/.exec(command || '');
            if (m) paths.add(m[1]);
            return undefined; // observe only; never override the command
        },
        cleanup: async () => {
            for (const p of paths) await fs.rm(p, { force: true });
        },
    };
}

const assignedIds = (prompt) => {
    const match = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};

test('mock sprint: below-goal dispatch filter, and a reviewer reopen of a worked-on P3 bead is applied and re-dispatched', async () => {
    await withScenarioMarkers('reopengate (dispatch filter + worked-on reopen exemption)', async () => {
        const T1 = 'Task: P1 work closes (reopen gate scenario)';
        const T2 = 'Task: P1 work blocked by the P3 blocker (reopen gate scenario)';
        const X = 'Task: P3 blocker of P1 work (reopen gate scenario)';
        const U = 'Task: P3 unrelated work (reopen gate scenario)';
        const ids = {};
        const doerRounds = [];
        let reviewCalls = 0;
        const bodies = bodyFileTracker();

        let scenario;
        try {
        scenario = await runDevelopLoopScenario('reopengate', {
            onCommand: bodies.onCommand,
            members: ['local'],
            taskSpecs: [
                { title: T1, priority: 'P1' },
                { title: T2, priority: 'P1' },
                { title: X, priority: 'P3' },
                { title: U, priority: 'P3' },
            ],
            goal: 'P1/P2',
            maxCycles: 1,
            beforeSprint: async ({ tempDir: td, runCmd: run, tasks }) => {
                for (const t of tasks) ids[t.title] = t.id;
                // T2 depends on (is blocked by) X.
                await run(`bd dep add ${ids[T2]} ${ids[X]}`, td);
            },
            doerHandler: async ({ opts, tempDir: td }) => {
                const assigned = assignedIds(opts.prompt);
                // One doer dispatch per streak; a round is every dispatch
                // before the next review, so group by review count.
                (doerRounds[reviewCalls] ||= []).push(...assigned);
                for (const id of assigned) await runCmd(`bd close ${id}`, td);
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: assigned, notes: 'Closed all assigned.' }) }] };
            },
            reviewerHandler: async () => {
                reviewCalls++;
                if (reviewCalls === 1) {
                    return {
                        content: [{
                            text: JSON.stringify({
                                verdict: 'CHANGES_NEEDED',
                                notes: 'npm test fails: the P3 blocker change broke two tests.',
                                reopenIds: [ids[X]],
                                buildFailing: true,
                                newTasks: [],
                            }),
                        }],
                    };
                }
                return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Green again.', reopenIds: [], newTasks: [] }) }] };
            },
            finalReviewHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'Final review pass.', reopenIds: [], newTasks: [] }) }],
            }),
        });
        } finally {
            await bodies.cleanup();
        }

        check(!scenario.error, `Scenario should not throw: ${scenario.error ? scenario.error.message : ''}`);
        const allDispatched = doerRounds.flat();

        // (1) Dispatch filter: the unrelated P3 task is never dispatched, and
        //     the run log says why; the P3 task blocking P1 work IS dispatched.
        check(!allDispatched.includes(ids[U]),
            `The unrelated P3 task must never be dispatched. Doer rounds: ${JSON.stringify(doerRounds)}`);
        check(scenario.logs.some((m) => m.includes('EXCLUDED') && m.includes(ids[U]) && m.includes('excluded as below goal')),
            `Expected the run log to state the unrelated P3 task was excluded as below goal. Logs: ${JSON.stringify(scenario.logs.filter((m) => m.includes('Develop')))}`);
        check(doerRounds[0] && doerRounds[0].includes(ids[X]),
            `The P3 task blocking P1 work must be dispatched in round 1. Doer rounds: ${JSON.stringify(doerRounds)}`);

        // (2) The reviewer's reopen of the worked-on P3 bead is applied and a
        //     doer is dispatched on it in the NEXT round.
        check(!scenario.logs.some((m) => m.includes(`SKIPPED '${ids[X]}'`) && m.includes("below this sprint's goal")),
            `No "below this sprint's goal" SKIPPED line may be logged for the worked-on P3 bead. Logs: ${JSON.stringify(scenario.logs.filter((m) => m.includes('reopenIds')))}`);
        check(scenario.logs.some((m) => m.startsWith(`Reviewer reopenIds: KEPT '${ids[X]}'`)),
            `Expected the worked-on P3 reopen to be logged as KEPT. Logs: ${JSON.stringify(scenario.logs.filter((m) => m.includes('reopenIds')))}`);
        check(doerRounds[1] && doerRounds[1].includes(ids[X]),
            `The reopened P3 bead must be re-dispatched in round 2. Doer rounds: ${JSON.stringify(doerRounds)}`);
        check(scenario.finalBeadsById.get(ids[X]).status === 'closed',
            `The re-dispatched P3 bead should end closed, got ${JSON.stringify(scenario.finalBeadsById.get(ids[X]))}`);
        check(scenario.finalBeadsById.get(ids[U]).status === 'open',
            'The unrelated P3 task stays open (never dispatched)');
    });
});

test('mock sprint: a red branch whose only reopen is an untouched below-goal bead still gets an in-goal fix task dispatched', async () => {
    await withScenarioMarkers('redbranchfix (red branch always gets a fix dispatch)', async () => {
        const T1 = 'Task: P1 work closes (red branch scenario)';
        const U = 'Task: P3 untouched work (red branch scenario)';
        const FIX_TITLE = 'Fix the failing build or tests on the sprint branch';
        const ids = {};
        const doerRounds = [];
        let reviewCalls = 0;
        const bodies = bodyFileTracker();

        let scenario;
        try {
        scenario = await runDevelopLoopScenario('redbranchfix', {
            onCommand: bodies.onCommand,
            members: ['local'],
            taskSpecs: [
                { title: T1, priority: 'P1' },
                { title: U, priority: 'P3' },
            ],
            goal: 'P1/P2',
            maxCycles: 1,
            beforeSprint: async ({ tasks }) => {
                for (const t of tasks) ids[t.title] = t.id;
            },
            doerHandler: async ({ opts, tempDir: td }) => {
                const assigned = assignedIds(opts.prompt);
                // One doer dispatch per streak; a round is every dispatch
                // before the next review, so group by review count.
                (doerRounds[reviewCalls] ||= []).push(...assigned);
                for (const id of assigned) await runCmd(`bd close ${id}`, td);
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: assigned, notes: 'Closed all assigned.' }) }] };
            },
            reviewerHandler: async () => {
                reviewCalls++;
                if (reviewCalls === 1) {
                    return {
                        content: [{
                            text: JSON.stringify({
                                verdict: 'CHANGES_NEEDED',
                                notes: 'npm test fails with 3 errors after this round.',
                                reopenIds: [ids[U]],
                                buildFailing: true,
                                newTasks: [],
                            }),
                        }],
                    };
                }
                return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Green again.', reopenIds: [], newTasks: [] }) }] };
            },
            finalReviewHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'Final review pass.', reopenIds: [], newTasks: [] }) }],
            }),
        });
        } finally {
            await bodies.cleanup();
        }

        check(!scenario.error, `Scenario should not throw: ${scenario.error ? scenario.error.message : ''}`);
        const allDispatched = doerRounds.flat();

        // The untouched below-goal reopen is still refused, with the existing text.
        check(scenario.logs.some((m) => m === `Reviewer reopenIds: SKIPPED '${ids[U]}' (priority P3 is below this sprint's goal P1/P2 -- deferred scope, not reopened).`),
            `Expected the untouched P3 reopen to be skipped with the existing text. Logs: ${JSON.stringify(scenario.logs.filter((m) => m.includes('reopenIds')))}`);
        check(!allDispatched.includes(ids[U]), 'The untouched P3 bead is never dispatched');

        // An in-goal fix bead exists...
        const fix = [...scenario.finalBeadsById.values()].filter((b) => b.title === FIX_TITLE);
        check(fix.length === 1, `Expected exactly one red-branch fix bead. Final beads: ${JSON.stringify([...scenario.finalBeadsById.values()].map((b) => ({ id: b.id, t: b.title, s: b.status, p: b.priority })))}`);
        check(fix[0].priority <= 2, `The fix bead must be in-goal, got P${fix[0].priority}`);
        check(scenario.logs.some((m) => m.includes('filed in-goal red-branch fix task')),
            `Expected the fix-task filing to be logged. Logs: ${JSON.stringify(scenario.logs.slice(-40))}`);

        // ...and is dispatched in the next round, so the sprint does not idle.
        check(doerRounds.length >= 2 && doerRounds[1].includes(fix[0].id),
            `The fix bead must be dispatched in round 2. Doer rounds: ${JSON.stringify(doerRounds)}; fix id ${fix[0].id}`);
        check(fix[0].status === 'closed', `The dispatched fix bead should end closed, got ${fix[0].status}`);
    });
});
