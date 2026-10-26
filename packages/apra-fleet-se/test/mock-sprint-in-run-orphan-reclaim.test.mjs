// =============================================================================
// GitHub #715: a bead a failed doer of THIS run left 'in_progress' is re-laned
// in the same sprint.
//
// Drives the REAL runner through the mock-sprint harness. DAG for every
// scenario: task X, task Y blocked by X (`bd dep add Y X`). The doer handler
// claims X itself (as doer.md step 1 does) and the scenario decides what the
// first dispatch on X returns.
//
//   1. First dispatch on X returns a success-looking report that leaves X
//      still in_progress -> next cycle X is reset to open, re-dispatched,
//      closes, and Y becomes ready and closes in the same sprint; the sprint
//      does not end FAIL. (Not BLOCKED: a doer-BLOCKED bead is set aside for
//      the whole run and never re-dispatched -- see
//      mock-sprint-doer-blocked-set-aside.test.mjs.)
//   2. Stale snapshot: X is in_progress in the cycle-top snapshot but closed by
//      the time of the fresh read -> no `bd update X --status open` is issued.
//   3. Liveness: the failed doer member's session is stopped (stop_prompt)
//      before X is dispatched again.
//   4. A streak that failed because every bead was already claimed by ANOTHER
//      sprint (structured reason all-beads-already-claimed) never has its claim
//      modified.
//   5. A reclaimed id leaves the dispatched record: a later claim of X by
//      another actor is not reset at the next cycle top.
//
// Scenarios share one process, so dolt-sync's per-process memo (sync.remote,
// last-synced tip, tip-probe failures) is reset before each one.
// =============================================================================

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    runCmd, runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool, mockCmdResult,
} from './helpers/mock-sprint-harness.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';
import { createOrphanClaimTracker, CLAIMED_ELSEWHERE_REASON } from '../fleet-sprint/orphan-reclaim.mjs';

beforeEach(() => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
});

const X_TITLE = 'Task: X the blocker';
const Y_TITLE = 'Task: Y blocked by X';

const assignedIds = (opts) => {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};

const verify = (ids) => ({ content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed all assigned beads.' }) }] });
// A failed doer that is NOT BLOCKED: it returns a success-looking report but
// leaves its bead open, so the engine's read-back marks the streak failed
// (failureReason 'left-open') and the bead stays eligible for re-laning.
const leftOpen = () => ({ content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: [], notes: 'Stopped before closing.' }) }] });

const approvingReviewer = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Looks good.', reopenIds: [], newTasks: [] }) }],
});

// Y depends on X (X blocks Y). tasks[] follows taskSpecs order.
const wireYBlockedByX = async ({ tempDir, tasks }) => {
    await runCmd(`bd dep add ${tasks[1].id} ${tasks[0].id}`, tempDir);
};

const reopenCommandFor = (id) => (c) => c.startsWith(`bd update ${id} --status open`);

/**
 * A doer that claims every assigned bead, then (for X's FIRST dispatch only)
 * runs `onFirstX` and returns its result; every other dispatch closes its beads.
 */
const scriptedDoer = ({ getXId, events, onFirstX, getStuckIds = () => [] }) => {
    let xDispatches = 0;
    return async ({ opts, tempDir }) => {
        const xId = getXId();
        const assigned = assignedIds(opts);
        // A "stuck" bead is never claimed or closed: the doer leaves it open
        // and it stays 'open' (ready) every cycle.
        const stuck = new Set(getStuckIds());
        if (assigned.length > 0 && assigned.every((id) => stuck.has(id))) return leftOpen();
        const ids = assigned.filter((id) => !stuck.has(id));
        for (const id of ids) await runCmd(`bd update ${id} --claim`, tempDir);
        if (ids.includes(xId)) {
            xDispatches++;
            events.push(`dispatch:${xId}:${xDispatches}`);
            if (xDispatches === 1) {
                // Only X fails: any other bead grouped into the same streak
                // still closes, so the scenario never depends on how the
                // engine groups the ready beads into streaks.
                for (const id of ids) if (id !== xId) await runCmd(`bd close ${id}`, tempDir);
                return onFirstX({ tempDir, ids });
            }
        }
        for (const id of ids) await runCmd(`bd close ${id}`, tempDir);
        return verify(ids);
    };
};

test('in-run reclaim: a failed doer\'s claim is re-laned next cycle and its dependent closes in the same sprint', async () => {
    await withScenarioMarkers('inrunreclaimrelane', async () => {
        const events = [];
        let xId = null;
        const run = await runDevelopLoopScenario('inrunreclaimrelane', {
            members: ['local'],
            taskSpecs: [{ title: X_TITLE }, { title: Y_TITLE }],
            maxCycles: 3,
            beforeSprint: async (ctx) => { xId = ctx.tasks[0].id; await wireYBlockedByX(ctx); },
            doerHandler: scriptedDoer({ getXId: () => xId, events, onFirstX: () => leftOpen() }),
            reviewerHandler: approvingReviewer,
        });
        assert.ok(!run.error, `scenario must not throw: ${run.error && run.error.message}`);
        const [x, y] = run.tasks;
        assert.equal(run.finalBeadsById.get(x.id).status, 'closed', 'X must be re-dispatched and closed in the same sprint');
        assert.equal(run.finalBeadsById.get(y.id).status, 'closed', 'Y must become ready once X closes and close in the same sprint');
        assert.notEqual(run.result.verdict, 'FAIL', `the sprint must not end FAIL for the orphaned claim: ${JSON.stringify(run.result)}`);
        assert.ok(run.commandLog.some(reopenCommandFor(x.id)), 'the orphaned claim must be reset to open');
        assert.ok(run.logs.some((l) => /in-run reclaim/.test(l) && l.includes(x.id) && /confirmed by a fresh read/.test(l)
            && l.includes(`Downstream bead(s) waiting on it: ${y.id}`)),
            `expected the reclaim log line naming the downstream bead it unblocks, logs: ${JSON.stringify(run.logs.filter((l) => /reclaim/i.test(l)))}`);
        // The write was preceded by a fresh read of exactly that bead.
        const writeIdx = run.commandLog.findIndex(reopenCommandFor(x.id));
        const freshIdx = run.commandLog.slice(0, writeIdx).lastIndexOf(`bd show ${x.id} --json`);
        assert.ok(freshIdx >= 0, 'the reclaim write must be preceded by a fresh bd show of the bead');
        assert.ok(events.includes(`dispatch:${x.id}:2`), 'X must be dispatched a second time');
    });
});

test('in-run reclaim: a bead the fresh read shows closed is never reopened, whatever the cached snapshot said', async () => {
    await withScenarioMarkers('inrunreclaimstale', async () => {
        const events = [];
        let xId = null;
        let tempDirRef = null;
        let armedShows = 0;
        const run = await runDevelopLoopScenario('inrunreclaimstale', {
            members: ['local'],
            taskSpecs: [{ title: X_TITLE }, { title: Y_TITLE }],
            maxCycles: 3,
            beforeSprint: async (ctx) => { xId = ctx.tasks[0].id; tempDirRef = ctx.tempDir; await wireYBlockedByX(ctx); },
            doerHandler: scriptedDoer({
                getXId: () => xId, events,
                onFirstX: () => { armedShows = 1; return leftOpen(); },
            }),
            reviewerHandler: approvingReviewer,
            // The first `bd show X` after the failed return is the engine's
            // post-dispatch verification; the next one is the reclaim's fresh
            // read. X closes (out of band) just before that fresh read, so the
            // cycle-top snapshot still says in_progress but the fresh read
            // must see closed.
            onCommand: async ({ command }) => {
                if (armedShows > 0 && command === `bd show ${xId} --json`) {
                    armedShows++;
                    if (armedShows === 3) await runCmd(`bd close ${xId}`, tempDirRef);
                }
                return undefined;
            },
        });
        assert.ok(!run.error, `scenario must not throw: ${run.error && run.error.message}`);
        const [x, y] = run.tasks;
        assert.ok(armedShows >= 3, `the fresh read must have been issued (bd show count after the failed return: ${armedShows - 1})`);
        assert.ok(!run.commandLog.some(reopenCommandFor(x.id)), 'a bead closed after the snapshot must never be reopened');
        assert.equal(run.finalBeadsById.get(x.id).status, 'closed');
        assert.equal(run.finalBeadsById.get(y.id).status, 'closed', 'Y still closes once X is closed');
        assert.ok(run.logs.some((l) => l.includes(x.id) && /fresh read shows 'closed' -- not reclaiming/.test(l)),
            `expected the not-reclaiming log, logs: ${JSON.stringify(run.logs.filter((l) => /reclaim/i.test(l)))}`);
    });
});

test('in-run reclaim: the failed doer session is stopped before its bead is dispatched again', async () => {
    await withScenarioMarkers('inrunreclaimliveness', async () => {
        const events = [];
        let xId = null;
        const run = await runDevelopLoopScenario('inrunreclaimliveness', {
            members: ['local'],
            taskSpecs: [{ title: X_TITLE }, { title: Y_TITLE }],
            maxCycles: 3,
            beforeSprint: async (ctx) => { xId = ctx.tasks[0].id; await wireYBlockedByX(ctx); },
            doerHandler: scriptedDoer({ getXId: () => xId, events, onFirstX: () => leftOpen() }),
            reviewerHandler: approvingReviewer,
            callToolFactory: (executeCommand) => {
                const base = defaultMockCallTool({ executeCommand });
                return async (name, toolArgs) => {
                    if (name === 'stop_prompt') {
                        events.push(`stop:${toolArgs && toolArgs.member_name}`);
                        return { content: [{ text: 'No running session.' }] };
                    }
                    return base(name, toolArgs);
                };
            },
        });
        assert.ok(!run.error, `scenario must not throw: ${run.error && run.error.message}`);
        const stopIdx = events.indexOf('stop:local');
        const redispatchIdx = events.indexOf(`dispatch:${xId}:2`);
        assert.ok(stopIdx >= 0, `the failed doer member's session must be stopped, events: ${JSON.stringify(events)}`);
        assert.ok(redispatchIdx > stopIdx, `the stop must precede the re-dispatch, events: ${JSON.stringify(events)}`);
        assert.ok(events.indexOf(`dispatch:${xId}:1`) < stopIdx, 'the stop happens after the failed dispatch, not before it');
    });
});

test('in-run reclaim: a claim another sprint holds (all-beads-already-claimed) is never modified', () => {
    // The structured reason is what identifies another sprint's claim; the
    // tracker never offers such a bead as a candidate, whatever its status.
    const tracker = createOrphanClaimTracker();
    tracker.recordOutcomes([{
        beadIds: ['X'], doerMember: 'local', outcome: 'failed', unclosedIds: ['X'], closedIds: [],
        error: 'some message that does not mention claims at all', failureReason: CLAIMED_ELSEWHERE_REASON,
    }]);
    const { candidates } = tracker.candidates([{ id: 'X', status: 'in_progress' }]);
    assert.deepEqual(candidates, []);
    assert.equal(tracker.isTracked('X'), false, 'another sprint\'s claim is dropped from the record, never retried');

    // The reason is read from the structured field, never the message text:
    // a message that LOOKS like the claimed-elsewhere case but carries a
    // different reason is still this run's own orphan.
    const t2 = createOrphanClaimTracker();
    t2.recordOutcomes([{
        beadIds: ['X'], doerMember: 'local', outcome: 'failed', unclosedIds: ['X'], closedIds: [],
        error: 'All beads already claimed by other sprints', failureReason: 'dispatch-error',
    }]);
    assert.deepEqual(t2.candidates([{ id: 'X', status: 'in_progress' }]).candidates, [{ id: 'X', doerMember: 'local' }]);
});

test('in-run reclaim: completed-but-unpublished streaks are never re-laned; the cap is bounded and surfaced', () => {
    const tracker = createOrphanClaimTracker({ limit: 2 });
    tracker.recordOutcomes([
        { beadIds: ['P'], doerMember: 'm', outcome: 'failed', unclosedIds: ['P'], failureReason: 'dispatch-error', postDispatchSyncFailed: true },
        { beadIds: ['Q'], doerMember: 'm', outcome: 'failed', unclosedIds: ['Q'], failureReason: 'dispatch-error', publishBlocked: true },
        { beadIds: ['R'], doerMember: 'm', outcome: 'failed', unclosedIds: ['R'], failureReason: 'blocked' },
    ]);
    const snap = [{ id: 'P', status: 'in_progress' }, { id: 'Q', status: 'in_progress' }, { id: 'R', status: 'in_progress' }];
    assert.deepEqual(tracker.candidates(snap).candidates.map((c) => c.id), ['R']);
    for (let i = 0; i < 2; i++) {
        tracker.markReclaimed('R');
        tracker.recordOutcomes([{ beadIds: ['R'], doerMember: 'm', outcome: 'failed', unclosedIds: ['R'], failureReason: 'blocked' }]);
    }
    const third = tracker.candidates(snap);
    assert.deepEqual(third.candidates, [], 'a bead past the cap is not re-laned again');
    assert.deepEqual(third.newlyCappedIds, ['R']);
    assert.deepEqual(tracker.cappedIds(), ['R']);
});

test('in-run reclaim: a reclaimed id leaves the record, so a later claim by another actor is not reset', async () => {
    await withScenarioMarkers('inrunreclaimforget', async () => {
        const events = [];
        let xId = null;
        let wId = null;
        let tempDirRef = null;
        const run = await runDevelopLoopScenario('inrunreclaimforget', {
            members: ['local'],
            // Z is independent work that closes in C1, so the stall net (two
            // no-progress cycles) cannot end the sprint before the C3 cycle top
            // this scenario needs to observe. W is never claimed and stays
            // ready, so the ready set is never empty and the separate
            // pre-launch self-heal (reclaimStaleInProgress, which judges by
            // started_at) never runs -- this scenario isolates the in-run
            // dispatch record.
            taskSpecs: [{ title: X_TITLE }, { title: Y_TITLE }, { title: 'Task: Z independent work' }, { title: 'Task: W never claimed' }],
            maxCycles: 3,
            beforeSprint: async (ctx) => { xId = ctx.tasks[0].id; wId = ctx.tasks[3].id; tempDirRef = ctx.tempDir; await wireYBlockedByX(ctx); },
            doerHandler: scriptedDoer({ getXId: () => xId, events, onFirstX: () => leftOpen(), getStuckIds: () => [wId] }),
            reviewerHandler: approvingReviewer,
            // Right after the reclaim re-opens X, another actor claims it.
            onCommand: async ({ command }) => {
                if (reopenCommandFor(xId)(command)) {
                    const res = await runCmd(command, tempDirRef);
                    await runCmd(`bd --actor other-sprint update ${xId} --claim`, tempDirRef);
                    return mockCmdResult(res.err ? (res.err.code ?? 1) : 0, res.stdout, res.stderr);
                }
                return undefined;
            },
        });
        assert.ok(run.logs.some((l) => /^Cycle 2 evaluation:/.test(l)),
            'the sprint must reach the C3 cycle top, where a still-recorded X would be reset again');
        const reopens = run.commandLog.filter(reopenCommandFor(xId));
        assert.equal(reopens.length, 1, `X is reclaimed exactly once, never again after another actor claimed it: ${JSON.stringify(reopens)}`);
        const x = run.finalBeadsById.get(xId);
        assert.equal(x.status, 'in_progress');
        assert.equal(x.assignee, 'other-sprint', 'the other actor\'s later claim must be left untouched');
        assert.ok(!events.includes(`dispatch:${xId}:2`), 'X held by another actor is not dispatched again by this sprint');
    });
});
