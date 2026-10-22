import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';

// =============================================================================
// GitHub #715: a stale PRE-LAUNCH in_progress claim must not hide its
// dependency chain while other work is ready.
//
// `bd ready` never lists an in_progress bead, nor anything blocked on it. The
// pre-launch self-heal used to run only when the ready set was EMPTY, so one
// unrelated ready bead was enough to hide a stale claim -- and its whole
// downstream chain -- for the entire sprint. (A claim a failed doer of THIS
// run leaves behind is a different path, covered by
// mock-sprint-in-run-orphan-reclaim.test.mjs.) These scenarios pin:
//   - pre-sprint, once, whether or not other work is ready, the pre-launch
//     claim is reclaimed and the log names the downstream bead it unblocks;
//   - that reclaim pre-filters on the cached snapshot but a fresh read
//     authorizes the write: a bead the fresh read shows closed is never
//     reopened, whatever the snapshot said;
//   - the pre-launch rule is still never applied per cycle while ready work
//     exists;
//   - the reclaim clears the stale assignee, so a claim another actor made
//     with a real `--claim` no longer refuses this run's doer;
//   - once this run reclaimed or dispatched a bead, the pre-launch rule
//     never touches it again: bd keeps the old started_at on a re-claim, so
//     only that exclusion stops it re-laning this run's own claims behind the
//     in-run tracker's back (its re-dispatch cap included).
// =============================================================================

beforeEach(() => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
});

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
// bd stamps started_at with second precision: wait past the next second so a
// claim made in beforeSprint reliably predates the sprint launch under real bd
// (record/real mode). A no-op cost in replay mode, where the recorded stamps
// are already older than any launch.
const predateLaunch = () => new Promise((resolve) => setTimeout(resolve, 1100));
const reopenCommandFor = (id) => (c) => c.startsWith(`bd update ${id} --status open`);

test('stale pre-launch claim: reclaimed pre-sprint even while other work is ready, after a fresh read, unblocking its chain', async () => {
    await withScenarioMarkers('stalereclaimchain (pre-sprint reclaim with ready work)', async () => {
        const res = await runDevelopLoopScenario('stalereclaimchain', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Ready R' },
                { title: 'Task: Stale S' },
                { title: 'Task: Downstream D' },
            ],
            maxCycles: 2,
            reviewerHandler: APPROVE,
            beforeSprint: async ({ tempDir: td, tasks: ts }) => {
                await runCmd(`bd update ${idOf(ts, 'Task: Stale S')} --status=in_progress`, td);
                await predateLaunch();
                await runCmd(`bd dep add ${idOf(ts, 'Task: Downstream D')} ${idOf(ts, 'Task: Stale S')}`, td);
            },
        });
        assert.ok(!res.error, `scenario should not throw: ${res.error ? res.error.message : ''}`);
        const r = idOf(res.tasks, 'Task: Ready R');
        const s = idOf(res.tasks, 'Task: Stale S');
        const d = idOf(res.tasks, 'Task: Downstream D');
        assert.ok(
            res.logs.some((m) => m.startsWith('Pre-sprint self-heal') && m.includes(`${s} is stuck`)
                && m.includes('confirmed by a fresh read') && m.includes(`Downstream bead(s) waiting on it: ${d}`)),
            `expected a pre-sprint reclaim log naming ${s}, the fresh read and its downstream ${d}, logs: ${JSON.stringify(res.logs.filter((l) => /self-heal|reclaim/i.test(l)))}`
        );
        // The write is the guarded one, and a fresh read of S precedes it.
        const writeIdx = res.commandLog.findIndex(reopenCommandFor(s));
        assert.ok(writeIdx >= 0, 'the stale claim must be reset to open');
        assert.equal(res.commandLog[writeIdx], `bd update ${s} --status open --assignee= --force --if-status in_progress`,
            'the snapshot-sourced reclaim write must clear the assignee and be guarded on the status still being in_progress');
        const freshIdx = res.commandLog.slice(0, writeIdx).lastIndexOf(`bd show ${s} --json`);
        assert.ok(freshIdx >= 0, 'the reclaim write must be preceded by a fresh bd show of the bead');
        assert.ok(
            res.dispatched.some((x) => x.agent === 'doer' && assignedIds(x.prompt || '').includes(d)),
            `expected ${d} (blocked by the stale claim) to be dispatched in the same run`
        );
        for (const id of [r, s, d]) {
            assert.equal(res.finalBeadsById.get(id) && res.finalBeadsById.get(id).status, 'closed',
                `expected ${id} closed, got: ${JSON.stringify(res.finalBeadsById.get(id))}`);
        }
    });
});

test('stale pre-launch claim: a bead the fresh read shows closed is never reopened, whatever the cached snapshot said', async () => {
    await withScenarioMarkers('stalereclaimfreshread (snapshot lags a close)', async () => {
        let sId = null;
        let tempDirRef = null;
        let closedOutOfBand = false;
        const res = await runDevelopLoopScenario('stalereclaimfreshread', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Ready R' },
                { title: 'Task: Stale S' },
                { title: 'Task: Downstream D' },
            ],
            maxCycles: 2,
            reviewerHandler: APPROVE,
            beforeSprint: async ({ tempDir: td, tasks: ts }) => {
                sId = idOf(ts, 'Task: Stale S');
                tempDirRef = td;
                await runCmd(`bd update ${sId} --status=in_progress`, td);
                await predateLaunch();
                await runCmd(`bd dep add ${idOf(ts, 'Task: Downstream D')} ${sId}`, td);
            },
            // S closes (out of band, e.g. another actor finishing it) after the
            // snapshot was taken and just before the reclaim's fresh read: the
            // snapshot still says in_progress, the fresh read must see closed.
            onCommand: async ({ command }) => {
                if (!closedOutOfBand && command === `bd show ${sId} --json`) {
                    closedOutOfBand = true;
                    await runCmd(`bd close ${sId}`, tempDirRef);
                }
                return undefined;
            },
        });
        assert.ok(!res.error, `scenario should not throw: ${res.error ? res.error.message : ''}`);
        const s = idOf(res.tasks, 'Task: Stale S');
        const d = idOf(res.tasks, 'Task: Downstream D');
        assert.ok(closedOutOfBand, 'the pre-sprint reclaim must have issued its fresh read of the stale bead');
        assert.ok(!res.commandLog.some(reopenCommandFor(s)), 'a bead closed after the snapshot must never be reopened');
        assert.ok(
            res.logs.some((m) => m.startsWith('Pre-sprint self-heal') && m.includes(s) && /fresh read shows 'closed' -- not reclaiming/.test(m)),
            `expected the not-reclaiming log, logs: ${JSON.stringify(res.logs.filter((l) => /self-heal|reclaim/i.test(l)))}`
        );
        assert.equal(res.finalBeadsById.get(s).status, 'closed');
        assert.equal(res.finalBeadsById.get(d).status, 'closed', 'D still closes once S is closed');
    });
});

test('stale pre-launch claim: not reclaimed per cycle while ready work exists', async () => {
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
                // Left-open, not BLOCKED: a BLOCKED Q would be set aside and
                // stall the run before the second cycle this scenario needs.
                return doerReport('VERIFY', closed, 'Scenario doer.');
            },
        });
        assert.ok(!res.error, `scenario should not throw: ${res.error ? res.error.message : ''}`);
        const x = idOf(res.tasks, 'Task: Claimed X');
        const p = idOf(res.tasks, 'Task: Blocker P');
        assert.equal(res.finalBeadsById.get(p) && res.finalBeadsById.get(p).status, 'closed',
            `expected ${p} closed, got: ${JSON.stringify(res.finalBeadsById.get(p))}`);
        assert.ok(
            !res.logs.some((m) => m.includes(`${x} is stuck`)),
            `a pre-launch claim must not be reclaimed per cycle while ready work exists, logs: ${JSON.stringify(res.logs.filter((l) => /self-heal|reclaim/i.test(l)))}`
        );
        assert.equal(res.finalBeadsById.get(x) && res.finalBeadsById.get(x).status, 'in_progress',
            `expected ${x} left in_progress, got: ${JSON.stringify(res.finalBeadsById.get(x))}`);
    });
});

test('stale pre-launch claim held by a DIFFERENT actor via --claim: the reclaim clears the assignee, so this run\'s doer can claim and close it', async () => {
    await withScenarioMarkers('stalereclaimotheractor (foreign --claim)', async () => {
        const res = await runDevelopLoopScenario('stalereclaimotheractor', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Ready R' },
                { title: 'Task: Stale S' },
                { title: 'Task: Downstream D' },
            ],
            maxCycles: 2,
            reviewerHandler: APPROVE,
            beforeSprint: async ({ tempDir: td, tasks: ts }) => {
                // A real claim by another actor (e.g. a crashed sprint or a
                // human on another machine), not a bare status change.
                await runCmd(`bd --actor stale-other-actor update ${idOf(ts, 'Task: Stale S')} --claim`, td);
                await predateLaunch();
                await runCmd(`bd dep add ${idOf(ts, 'Task: Downstream D')} ${idOf(ts, 'Task: Stale S')}`, td);
            },
            // A doer that claims before it works, as doer.md requires: a bead
            // still assigned to another actor refuses the claim.
            doerHandler: async ({ opts, tempDir: td, runCmd: run }) => {
                const ids = assignedIds(opts.prompt);
                const closed = [];
                for (const id of ids) {
                    try {
                        await run(`bd update ${id} --claim`, td);
                    } catch (err) {
                        return doerReport('BLOCKED', closed, `claim of ${id} refused: ${err.message}`);
                    }
                    await run(`bd close ${id}`, td);
                    closed.push(id);
                }
                return doerReport('VERIFY', closed, 'Scenario doer.');
            },
        });
        assert.ok(!res.error, `scenario should not throw: ${res.error ? res.error.message : ''}`);
        const s = idOf(res.tasks, 'Task: Stale S');
        const d = idOf(res.tasks, 'Task: Downstream D');
        assert.ok(
            res.logs.some((m) => m.startsWith('Pre-sprint self-heal') && m.includes(`${s} is stuck`) && m.includes('assignee=stale-other-actor')),
            `expected a pre-sprint reclaim log naming ${s} and its foreign assignee, logs: ${JSON.stringify(res.logs.filter((l) => /self-heal|reclaim/i.test(l)))}`
        );
        assert.ok(res.commandLog.includes(`bd update ${s} --status open --assignee= --force --if-status in_progress`),
            'the reclaim write must clear the stale assignee and be guarded on in_progress');
        for (const id of [s, d]) {
            assert.equal(res.finalBeadsById.get(id) && res.finalBeadsById.get(id).status, 'closed',
                `expected ${id} claimed and closed by this run's doer, got: ${JSON.stringify(res.finalBeadsById.get(id))}`);
        }
    });
});

test('stale pre-launch claim: once reclaimed and dispatched, the pre-launch rule never touches it again (bd keeps the old started_at on re-claim)', async () => {
    await withScenarioMarkers('stalereclaimsettled (later claims are not pre-launch claims)', async () => {
        let sId = null;
        let tempDirRef = null;
        let armed = false;
        let foreignClaimMade = false;
        let reopenWritesSeen = 0;
        const res = await runDevelopLoopScenario('stalereclaimsettled', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Stale S' },
            ],
            maxCycles: 3,
            reviewerHandler: APPROVE,
            beforeSprint: async ({ tempDir: td, tasks: ts }) => {
                sId = idOf(ts, 'Task: Stale S');
                tempDirRef = td;
                await runCmd(`bd update ${sId} --status=in_progress`, td);
                await predateLaunch();
            },
            // This run's doer claims S and fails without closing it.
            doerHandler: async ({ opts, tempDir: td, runCmd: run }) => {
                for (const id of assignedIds(opts.prompt)) {
                    try { await run(`bd update ${id} --claim`, td); } catch { /* a refused claim is a failure either way */ }
                }
                // Left-open, not BLOCKED: a BLOCKED S would be set aside and the
                // run would stall before the in-run re-lane this scenario needs.
                return doerReport('VERIFY', [], 'Scenario doer: cannot finish.');
            },
            // Right after the in-run tracker re-lanes S, another actor claims
            // it. bd keeps S's pre-launch started_at on that claim, so only the
            // settled-id exclusion stops the per-cycle pre-launch rule from
            // treating this LIVE, post-launch claim as stale and resetting it.
            onCommand: async ({ command }) => {
                if (armed && !foreignClaimMade) {
                    foreignClaimMade = true;
                    await runCmd(`bd --actor other-sprint-actor update ${sId} --claim`, tempDirRef);
                }
                // The first such write is the pre-sprint reclaim, the second
                // the in-run re-lane: arm on the second.
                if (command === `bd update ${sId} --status open --assignee= --force --if-status in_progress`) {
                    reopenWritesSeen += 1;
                    if (reopenWritesSeen === 2) armed = true;
                }
                return undefined;
            },
        });
        assert.ok(sId, 'scenario must have created S');
        const s = sId;
        assert.ok(foreignClaimMade, `the scenario must have reached the in-run re-lane of ${s}, logs: ${JSON.stringify(res.logs.filter((l) => /self-heal|reclaim|re-lan/i.test(l)))}`);
        const preLaunchLogs = res.logs.filter((m) => /self-heal: /.test(m) && m.includes(`${s} is stuck 'in_progress'`));
        assert.equal(preLaunchLogs.length, 1,
            `the pre-launch rule must reclaim ${s} exactly once (pre-sprint); later claims are not pre-launch claims, logs: ${JSON.stringify(res.logs.filter((l) => /self-heal|reclaim|re-lan/i.test(l)))}`);
        assert.ok(preLaunchLogs[0].startsWith('Pre-sprint self-heal'));
        assert.ok(res.logs.some((m) => m.includes('in-run reclaim') && m.includes(`${s} was left 'in_progress' by a failed doer streak`)),
            'the in-run tracker owns the re-lane of a bead this run dispatched');
        const final = res.finalBeadsById.get(s);
        assert.equal(final && final.status, 'in_progress', `the other actor's live claim must survive, got: ${JSON.stringify(final)}`);
        assert.equal(final && final.assignee, 'other-sprint-actor', `the other actor's live claim must survive, got: ${JSON.stringify(final)}`);
    });
});
