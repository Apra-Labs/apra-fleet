import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// Stale in_progress claims must not hide a dependency chain.
//
// `bd ready` never lists an in_progress bead, nor anything blocked on it. The
// old self-heal only ran when the ready set was EMPTY, so one unrelated ready
// bead was enough to hide a stale claim -- and its whole downstream chain --
// for the entire sprint. These scenarios pin the reclaim call sites:
//   - pre-sprint, once, whether or not other work is ready;
//   - each cycle top, for beads THIS run dispatched and left in_progress;
//   - never per cycle for a pre-launch claim while ready work exists;
// plus the bounce cap surfacing in the final summary.
// =============================================================================

const APPROVE = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});

const assignedIds = (prompt) => {
    const match = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};

const doerReport = (status, closedIds, notes) => ({
    content: [{ text: JSON.stringify({ status, closedIds, notes }) }],
});

const idOf = (tasks, title) => tasks.find((t) => t.title === title).id;

test('mock sprint: a stale pre-launch claim is reclaimed pre-sprint even while other work is ready, unblocking its chain', async () => {
    await withScenarioMarkers('stalereclaimchain (pre-sprint reclaim with ready work)', async () => {
        const res = await runDevelopLoopScenario('stalereclaimchain', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Ready R' },
                { title: 'Task: Stale S' },
                { title: 'Task: Downstream D' },
            ],
            maxCycles: 1,
            reviewerHandler: APPROVE,
            beforeSprint: async ({ tempDir: td, tasks: ts }) => {
                await runCmd(`bd update ${idOf(ts, 'Task: Stale S')} --status=in_progress`, td);
                await runCmd(`bd dep add ${idOf(ts, 'Task: Downstream D')} ${idOf(ts, 'Task: Stale S')}`, td);
            },
        });
        check(!res.error, `scenario should not throw: ${res.error ? res.error.message : ''}`);
        const r = idOf(res.tasks, 'Task: Ready R');
        const s = idOf(res.tasks, 'Task: Stale S');
        const d = idOf(res.tasks, 'Task: Downstream D');
        check(
            res.logs.some((m) => m.startsWith('Pre-sprint self-heal') && m.includes(`${s} is stuck`) && m.includes(`Downstream bead(s) waiting on it: ${d}`)),
            `expected a pre-sprint reclaim log naming ${s} and its downstream ${d}, logs: ${JSON.stringify(res.logs)}`
        );
        check(
            res.dispatched.some((x) => x.agent === 'doer' && assignedIds(x.prompt || '').includes(d)),
            `expected ${d} (blocked by the stale claim) to be dispatched in the same run`
        );
        for (const id of [r, s, d]) {
            check(
                res.finalBeadsById.get(id) && res.finalBeadsById.get(id).status === 'closed',
                `expected ${id} closed, got: ${JSON.stringify(res.finalBeadsById.get(id))}`
            );
        }
    });
});

test('mock sprint: a bead this run dispatched and left in_progress is reclaimed at the next cycle top', async () => {
    await withScenarioMarkers('orphanreclaimcycle (cycle-top orphan reclaim)', async () => {
        let aDispatches = 0;
        let aId = null;
        let cId = null;
        const res = await runDevelopLoopScenario('orphanreclaimcycle', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Orphaned by doer A' },
                { title: 'Task: Closes B' },
                { title: 'Task: Keeps ready C' },
            ],
            maxCycles: 2,
            reviewerHandler: APPROVE,
            beforeSprint: async ({ tasks: ts }) => {
                aId = idOf(ts, 'Task: Orphaned by doer A');
                cId = idOf(ts, 'Task: Keeps ready C');
            },
            doerHandler: async ({ opts, tempDir: td, runCmd: run }) => {
                const ids = assignedIds(opts.prompt);
                const closed = [];
                for (const id of ids) {
                    if (id === aId) {
                        aDispatches++;
                        if (aDispatches === 1) {
                            // Claims the bead, then stops: the dispatch returns
                            // with nothing owning the claim.
                            await run(`bd update ${id} --status=in_progress`, td);
                            continue;
                        }
                    }
                    // C stays open and ready until A has been re-dispatched, so
                    // cycle 2 starts with ready work: only the cycle-top orphan
                    // reclaim can bring A back.
                    if (id === cId && aDispatches < 2) continue;
                    await run(`bd close ${id}`, td);
                    closed.push(id);
                }
                return doerReport(closed.length === ids.length ? 'VERIFY' : 'BLOCKED', closed, 'Scenario doer.');
            },
        });
        check(!res.error, `scenario should not throw: ${res.error ? res.error.message : ''}`);
        check(
            res.logs.some((m) => m.startsWith('Cycle 2 orphan reclaim') && m.includes(`${aId} is stuck`) && m.includes('orphaned claim')),
            `expected a cycle-2 orphan reclaim log naming ${aId}, logs: ${JSON.stringify(res.logs)}`
        );
        check(aDispatches >= 2, `expected ${aId} to be re-dispatched after the reclaim, dispatches: ${aDispatches}`);
        check(
            res.finalBeadsById.get(aId) && res.finalBeadsById.get(aId).status === 'closed',
            `expected ${aId} closed, got: ${JSON.stringify(res.finalBeadsById.get(aId))}`
        );
    });
});

test('mock sprint: a pre-launch claim is not reclaimed per cycle while ready work exists', async () => {
    await withScenarioMarkers('stalenoreclaimready (no per-cycle reclaim while ready)', async () => {
        let qId = null;
        const res = await runDevelopLoopScenario('stalenoreclaimready', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Blocker P' },
                { title: 'Task: Never closes Q' },
                { title: 'Task: Claimed X' },
            ],
            maxCycles: 2,
            reviewerHandler: APPROVE,
            beforeSprint: async ({ tempDir: td, tasks: ts }) => {
                qId = idOf(ts, 'Task: Never closes Q');
                const x = idOf(ts, 'Task: Claimed X');
                // X waits on P, so the pre-sprint check leaves it alone; once P
                // closes mid-run, X is a pre-launch claim with no unmet blocker
                // -- but Q keeps the ready set non-empty, so no per-cycle
                // reclaim may touch it.
                await runCmd(`bd dep add ${x} ${idOf(ts, 'Task: Blocker P')}`, td);
                await runCmd(`bd update ${x} --status=in_progress`, td);
            },
            doerHandler: async ({ opts, tempDir: td, runCmd: run }) => {
                const ids = assignedIds(opts.prompt);
                const closed = [];
                for (const id of ids) {
                    if (id === qId) continue;
                    await run(`bd close ${id}`, td);
                    closed.push(id);
                }
                return doerReport(closed.length === ids.length ? 'VERIFY' : 'BLOCKED', closed, 'Scenario doer.');
            },
        });
        check(!res.error, `scenario should not throw: ${res.error ? res.error.message : ''}`);
        const x = idOf(res.tasks, 'Task: Claimed X');
        const p = idOf(res.tasks, 'Task: Blocker P');
        check(
            res.finalBeadsById.get(p) && res.finalBeadsById.get(p).status === 'closed',
            `expected ${p} closed, got: ${JSON.stringify(res.finalBeadsById.get(p))}`
        );
        check(
            !res.logs.some((m) => m.includes(`${x} is stuck`)),
            `a pre-launch claim must not be reclaimed per cycle while ready work exists, logs: ${JSON.stringify(res.logs)}`
        );
        check(
            res.finalBeadsById.get(x) && res.finalBeadsById.get(x).status === 'in_progress',
            `expected ${x} left in_progress, got: ${JSON.stringify(res.finalBeadsById.get(x))}`
        );
    });
});

test('mock sprint: a bead that hits the reclaim bounce cap is named in the final summary', async () => {
    await withScenarioMarkers('stalereclaimcap (bounce cap in summary)', async () => {
        let aId = null;
        let bId = null;
        let aDispatches = 0;
        const res = await runDevelopLoopScenario('stalereclaimcap', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Bounces A' },
                { title: 'Task: Late progress B' },
                { title: 'Task: Early progress E' },
            ],
            maxCycles: 3,
            reviewerHandler: APPROVE,
            beforeSprint: async ({ tempDir: td, tasks: ts }) => {
                aId = idOf(ts, 'Task: Bounces A');
                bId = idOf(ts, 'Task: Late progress B');
                await runCmd(`bd update ${aId} --status=in_progress`, td);
            },
            doerHandler: async ({ opts, tempDir: td, runCmd: run }) => {
                const ids = assignedIds(opts.prompt);
                const closed = [];
                for (const id of ids) {
                    if (id === aId) {
                        // Every attempt claims the bead and stops.
                        aDispatches++;
                        await run(`bd update ${id} --status=in_progress`, td);
                        continue;
                    }
                    // B closes only once A has been dispatched twice (cycle 2),
                    // so each cycle makes real progress and the stall detector
                    // stays out of the way of the cap.
                    if (id === bId && aDispatches < 2) continue;
                    await run(`bd close ${id}`, td);
                    closed.push(id);
                }
                return doerReport(closed.length === ids.length ? 'VERIFY' : 'BLOCKED', closed, 'Scenario doer.');
            },
        });
        check(!res.error, `scenario should not throw: ${res.error ? res.error.message : ''}`);
        check(
            res.logs.some((m) => m.includes('bounce cap') && m.includes(aId)),
            `expected a bounce-cap log naming ${aId}, logs: ${JSON.stringify(res.logs)}`
        );
        check(
            res.result && typeof res.result.notes === 'string' && res.result.notes.includes('bounce cap') && res.result.notes.includes(aId),
            `expected the final notes to name the capped bead ${aId}, got: ${JSON.stringify(res.result)}`
        );
        check(
            res.finalBeadsById.get(aId) && res.finalBeadsById.get(aId).status === 'in_progress',
            `expected the capped bead ${aId} left in_progress, got: ${JSON.stringify(res.finalBeadsById.get(aId))}`
        );
    });
});
