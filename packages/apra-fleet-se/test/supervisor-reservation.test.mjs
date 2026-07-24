import { test, describe } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME, HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import {
    createSprintController,
    defaultMemberOverlapGuard,
    ApiError,
} from '../src/supervisor/api.mjs';
import {
    createScopeGuard,
    expandScope,
    formatScopeConflict,
} from '../src/supervisor/scope-overlap.mjs';
import { createReconciler } from '../src/supervisor/reconcile.mjs';

// =============================================================================
// apra-fleet-eft.5.6 -- combined member + issue-scope reservation ledger,
// END-TO-END. Where the per-module suites (supervisor-ledger, -scope-overlap,
// -reconcile, -api) each exercise ONE seam in isolation, this suite composes
// the REAL modules exactly the way the supervisor wires them -- one shared
// ledger, the eft.5.2 member guard AND the eft.5.3 issue-scope guard composed
// into a single beforeLaunch, plus the eft.5.4 reconciler/force-release and the
// history log -- and drives the seven acceptance cases through that whole stack:
//
//   (a) member overlap (incl. an orchestrator-only overlap) -> 409 naming the
//       conflicting sprint AND the overlapping member(s).
//   (b) issue-scope overlap -> 409 naming the conflicting sprint AND the
//       overlapping bead ids.
//   (c) a child bead grafted AFTER launch under a claimed root is still
//       detected -- proving LIVE recomputation, not a launch-time snapshot
//       (the same case is shown to be MISSED by a frozen-snapshot guard).
//   (d) both axes claim/release ATOMICALLY on every terminal path -- success,
//       fail, abort, crash-reconciled -- parameterized over all four.
//   (e) the ledger survives a supervisor restart (reload from disk) and PID
//       reconciliation releases dead-child reservations while retaining live.
//   (f) force-release tears a wedged reservation down (both axes) with audit.
//   (g) the intra-sprint memberLocks mechanism (auto-sprint/runner.js role-level
//       serialization) is a DIFFERENT concern and stays untouched: the ledger
//       exposes no per-member intra-sprint lock surface and co-reserves a
//       sprint's whole member union under one key.
// =============================================================================

async function tmpDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'eft-reservation-'));
}

/**
 * A spawner built on the REAL createSpawner with an injected spawn that never
 * launches a process but hands back a deterministic, incrementing pid. Records
 * every spawn so tests can assert a REJECTED launch never spawns a child.
 */
function recordingSpawner(captured) {
    let nextPid = 5000;
    return createSpawner({
        basePort: 9100,
        isPortAvailable: async () => true,
        spawn: (command, args) => {
            const pid = nextPid++;
            captured.push({ command, args, pid });
            return { pid, once() { return this; }, unref() {} };
        },
    });
}

/**
 * Compose the REAL reservation stack over a temp dir. `childMap` is MUTABLE so a
 * test can graft a bead under a claimed root mid-run (case c). `alivePids` is a
 * mutable Set the reconciler probes, so liveness is deterministic (no real
 * process.kill). Ledger disk writes are counted to prove both-axis atomicity.
 */
async function buildSystem(dir, childMap = {}) {
    const alivePids = new Set();
    const ledgerWrites = { count: 0 };
    const realWriteFile = fsp.writeFile;

    const ledger = createLedger({
        filePath: path.join(dir, LEDGER_FILENAME),
        now: () => '2026-07-18T00:00:00.000Z',
        fs: {
            mkdir: fsp.mkdir,
            readFile: fsp.readFile,
            rename: fsp.rename,
            async writeFile(p, data, enc) {
                ledgerWrites.count += 1;
                return realWriteFile(p, data, enc);
            },
        },
    });
    await ledger.start();

    const history = createHistory({
        filePath: path.join(dir, HISTORY_FILENAME),
        now: () => '2026-07-18T01:00:00.000Z',
    });
    await history.start();

    // A live child-lister over the mutable childMap. Records every queried
    // parent so we can assert we never comma-join a multi-parent query.
    const queried = [];
    const listChildren = async (parentId) => {
        queried.push(parentId);
        return childMap[parentId] ? [...childMap[parentId]] : [];
    };
    const scopeGuard = createScopeGuard({ ledger, listChildren });

    // The composed beforeLaunch the supervisor uses: eft.5.2 member-union guard
    // FIRST, then eft.5.3 live issue-scope guard. Either axis rejects the whole
    // launch with a 409, BEFORE ledger.claim() -- no partial claim, no spawn.
    const memberGuard = defaultMemberOverlapGuard(ledger);
    const beforeLaunch = async (ctx) => {
        await memberGuard(ctx);
        const scope = await scopeGuard.checkLaunch(ctx.issueRoots);
        if (!scope.ok) {
            throw new ApiError(409, formatScopeConflict(scope.conflicts), 'issueRoots');
        }
    };

    const captured = [];
    let seq = 0;
    const controller = createSprintController({
        ledger,
        history,
        spawner: recordingSpawner(captured),
        listMembers: () => ({}),
        getBacklog: () => ({}),
        beforeLaunch,
        resolveRoleMap: async (raw) => (raw ? JSON.parse(raw) : undefined),
        generateSprintId: (issue) => `sprint-${issue}-${seq++}`,
    });

    const reconciler = createReconciler({
        ledger,
        history,
        isPidAlive: (pid) => alivePids.has(pid),
        now: () => '2026-07-18T02:00:00.000Z',
    });

    return {
        ledger, history, scopeGuard, controller, reconciler,
        captured, queried, childMap, alivePids, ledgerWrites,
    };
}

// -- (a) member-axis overlap, including an orchestrator-only overlap ----------

describe('reservation e2e -- (a) member overlap -> 409 naming sprint + members', () => {
    test('a directly-shared member rejects the launch, naming the active sprint and member', async () => {
        const dir = await tmpDir();
        const sys = await buildSystem(dir, { R1: [], R2: [] });

        const first = await sys.controller.launch({
            issue: 'R1', members: ['alice', 'bob'], branch: 'feat/one', base: 'main',
        });
        assert.equal(sys.captured.length, 1);

        await assert.rejects(
            () => sys.controller.launch({
                issue: 'R2', members: ['bob', 'carol'], branch: 'feat/two', base: 'main',
            }),
            (err) => err instanceof ApiError
                && err.status === 409
                && err.field === 'members'
                && err.message.includes(first.sprintId) // names the conflicting sprint
                && err.message.includes('bob'),         // names the overlapping member
        );
        // A rejected launch never spawned a second child, and never touched the ledger.
        assert.equal(sys.captured.length, 1);
        assert.equal(sys.ledger.size, 1);

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('an ORCHESTRATOR-only overlap (member only via roleMap.orchestrator) is still caught', async () => {
        const dir = await tmpDir();
        const sys = await buildSystem(dir, { R1: [], R2: [] });

        // sprint-1 claims 'orch1' purely through its orchestrator role -- it is
        // folded into the reserved member union by memberUnion().
        const first = await sys.controller.launch({
            issue: 'R1', members: ['alice'], branch: 'feat/one', base: 'main',
            roleMap: { orchestrator: ['orch1'] },
        });
        assert.deepEqual([...sys.ledger.get(first.sprintId).members].sort(), ['alice', 'orch1']);

        // sprint-2 shares NO explicit member, only the orchestrator 'orch1'.
        await assert.rejects(
            () => sys.controller.launch({
                issue: 'R2', members: ['dave'], branch: 'feat/two', base: 'main',
                roleMap: { orchestrator: ['orch1'] },
            }),
            (err) => err instanceof ApiError
                && err.status === 409
                && err.message.includes(first.sprintId)
                && err.message.includes('orch1'),
        );
        assert.equal(sys.captured.length, 1);

        await fsp.rm(dir, { recursive: true, force: true });
    });
});

// -- (b) issue-scope overlap --------------------------------------------------

describe('reservation e2e -- (b) issue-scope overlap -> 409 naming sprint + bead ids', () => {
    test('launching over a descendant of a claimed root rejects, naming the sprint and overlapping bead ids', async () => {
        const dir = await tmpDir();
        // R1 -> f1 -> t1. A second sprint rooted at f1 collides on {f1, t1}.
        const sys = await buildSystem(dir, { R1: ['f1'], f1: ['t1'], t1: [] });

        const first = await sys.controller.launch({
            issue: 'R1', members: ['alice'], branch: 'feat/one', base: 'main',
        });

        await assert.rejects(
            // Disjoint MEMBERS (bob) so the member guard passes and the SCOPE
            // guard is what fires -- isolating the issue-scope axis.
            () => sys.controller.launch({
                issue: 'f1', members: ['bob'], branch: 'feat/two', base: 'main',
            }),
            (err) => err instanceof ApiError
                && err.status === 409
                && err.field === 'issueRoots'
                && err.message.includes(first.sprintId)
                && err.message.includes('f1')
                && err.message.includes('t1'), // every overlapping bead id is named
        );
        assert.equal(sys.captured.length, 1);
        assert.equal(sys.ledger.size, 1);

        await fsp.rm(dir, { recursive: true, force: true });
    });
});

// -- (c) live recomputation, NOT a launch-time snapshot -----------------------

describe('reservation e2e -- (c) child bead grafted after launch is still detected (live, not snapshot)', () => {
    test('a bead grafted under a claimed root AFTER launch is detected live; a frozen snapshot would MISS it', async () => {
        const dir = await tmpDir();
        // At launch, R has NO children. C does not yet exist under R.
        const childMap = { R: [], C: [] };
        const sys = await buildSystem(dir, childMap);

        const first = await sys.controller.launch({
            issue: 'R', members: ['alice'], branch: 'feat/one', base: 'main',
        });

        // BEFORE the graft, launching over C is clean -- capture the frozen
        // snapshot the "snapshot" strategy would have kept for sprint-1 here.
        const beforeGraft = await sys.scopeGuard.checkLaunch(['C']);
        assert.equal(beforeGraft.ok, true);
        const frozenSnapshot = [];
        for (const r of sys.ledger.list()) {
            // eslint-disable-next-line no-await-in-loop
            frozenSnapshot.push({ sprintId: r.sprintId, scope: await expandScope(r.issueRoots, async (p) => (childMap[p] ? [...childMap[p]] : [])) });
        }

        // A planner grafts C under R mid-run.
        childMap.R = ['C'];

        // LIVE guard: re-expands R right now, sees C, rejects naming sprint-1 + [C].
        const live = await sys.scopeGuard.checkLaunch(['C']);
        assert.equal(live.ok, false);
        assert.equal(live.conflicts.length, 1);
        assert.equal(live.conflicts[0].sprintId, first.sprintId);
        assert.deepEqual(live.conflicts[0].overlappingIds, ['C']);

        // And the full controller launch is a 409 (integration, not just the guard).
        await assert.rejects(
            () => sys.controller.launch({ issue: 'C', members: ['bob'], branch: 'feat/two', base: 'main' }),
            (err) => err instanceof ApiError && err.status === 409 && err.message.includes('C'),
        );

        // CASE (c) MUST fail under a launch-time snapshot: the frozen scope
        // captured before the graft does NOT contain C, so a snapshot strategy
        // would have MISSED this overlap. This is what live recomputation buys.
        const requestScope = await expandScope(['C'], async (p) => (childMap[p] ? [...childMap[p]] : []));
        const snapshotWouldReject = frozenSnapshot.some(
            (s) => [...requestScope].some((id) => s.scope.has(id)),
        );
        assert.equal(snapshotWouldReject, false);

        await fsp.rm(dir, { recursive: true, force: true });
    });
});

// -- (d) both axes claim/release atomically on EVERY terminal path ------------

describe('reservation e2e -- (d) both axes atomic on all four terminal paths', () => {
    // Each terminal driver takes the composed system + a launched sprintId and
    // its childPid, drives the sprint to that terminal state, and returns
    // whether a durable history event is expected (abort / crash-reconciled).
    const TERMINAL_PATHS = [
        {
            name: 'success',
            // Normal completion releases both axes via the shared ledger.release.
            drive: async (sys, sprintId) => { await sys.ledger.release(sprintId); return null; },
        },
        {
            name: 'fail',
            // A failed sprint cleans up through the SAME both-axis release.
            drive: async (sys, sprintId) => { await sys.ledger.release(sprintId); return null; },
        },
        {
            name: 'abort',
            // Operator force-release: both axes + a FORCE_RELEASED audit event.
            drive: async (sys, sprintId) => {
                await sys.reconciler.forceRelease(sprintId, { by: 'op', reason: 'aborted' });
                return HISTORY_EVENTS.FORCE_RELEASED;
            },
        },
        {
            name: 'crash-reconciled',
            // Child crashed: restart reconcile releases both axes + aborts.
            drive: async (sys, sprintId) => {
                // childPid is NOT in alivePids -> probed dead -> released.
                const result = await sys.reconciler.reconcile();
                assert.ok(result.released.includes(sprintId));
                return HISTORY_EVENTS.ABORTED_BY_RESTART;
            },
        },
    ];

    for (const path0 of TERMINAL_PATHS) {
        test(`terminal path '${path0.name}': both axes present before, both gone after, in one atomic write`, async () => {
            const dir = await tmpDir();
            const sys = await buildSystem(dir, { R: [] });

            const launched = await sys.controller.launch({
                issue: 'R', members: ['alice', 'bob'], branch: 'feat/x', base: 'main',
                roleMap: { orchestrator: ['orch1'] },
            });
            const sprintId = launched.sprintId;

            // Before the terminal event: BOTH axes are held together.
            const held = sys.ledger.get(sprintId);
            assert.deepEqual([...held.members].sort(), ['alice', 'bob', 'orch1']);
            assert.deepEqual(held.issueRoots, ['R']);

            // Count ledger writes across ONLY the terminal release, to prove the
            // two axes drop in ONE atomic write (never a torn half-release).
            const writesBefore = sys.ledgerWrites.count;
            const expectedHistory = await path0.drive(sys, sprintId);
            assert.equal(sys.ledgerWrites.count - writesBefore, 1, 'exactly one atomic ledger write releases both axes');

            // After: the WHOLE entry is gone -- neither axis lingers.
            assert.equal(sys.ledger.get(sprintId), undefined);

            // The on-disk ledger reloads WITHOUT the released sprint (restart fidelity).
            const reloaded = createLedger({ filePath: path.join(dir, LEDGER_FILENAME) });
            await reloaded.start();
            assert.equal(reloaded.get(sprintId), undefined);

            // Abort / crash paths leave a durable audit recording BOTH axes.
            if (expectedHistory) {
                const ev = sys.history.latestFor(sprintId);
                assert.equal(ev.event, expectedHistory);
                assert.deepEqual([...ev.members].sort(), ['alice', 'bob', 'orch1']);
                assert.deepEqual(ev.issueRoots, ['R']);
            } else {
                // Success / fail cleanup keeps the ledger torn-state-free without
                // fabricating a terminal history event.
                assert.equal(sys.history.latestFor(sprintId), undefined);
            }

            await fsp.rm(dir, { recursive: true, force: true });
        });
    }
});

// -- (e) restart survival + PID reconciliation --------------------------------

describe('reservation e2e -- (e) ledger survives restart; reconcile releases dead, retains live', () => {
    test('after a restart the reloaded ledger PID-probes: dead child released (both axes), live retained', async () => {
        const dir = await tmpDir();
        const ledgerPath = path.join(dir, LEDGER_FILENAME);

        // First supervisor incarnation: launch two sprints (disjoint members + scopes).
        const sys1 = await buildSystem(dir, { Rlive: [], Rdead: [] });
        const live = await sys1.controller.launch({
            issue: 'Rlive', members: ['alice'], branch: 'feat/live', base: 'main',
        });
        const dead = await sys1.controller.launch({
            issue: 'Rdead', members: ['bob'], branch: 'feat/dead', base: 'main',
        });
        const livePid = sys1.ledger.get(live.sprintId).childPid;

        // ---- supervisor RESTART: a brand-new stack reloads the SAME on-disk ledger.
        const sys2 = await buildSystem(dir, { Rlive: [], Rdead: [] });
        // Both reservations survived the restart, both axes intact.
        assert.equal(sys2.ledger.size, 2);
        assert.deepEqual(sys2.ledger.get(live.sprintId).members, ['alice']);
        assert.deepEqual(sys2.ledger.get(dead.sprintId).issueRoots, ['Rdead']);

        // Only the live sprint's child is still alive at reconcile time.
        sys2.alivePids.add(livePid);
        const result = await sys2.reconciler.reconcile();

        assert.deepEqual(result.released, [dead.sprintId]);
        assert.deepEqual(result.retained, [live.sprintId]);
        // Dead child: BOTH axes released and marked aborted-by-restart.
        assert.equal(sys2.ledger.get(dead.sprintId), undefined);
        assert.equal(sys2.history.latestFor(dead.sprintId).event, HISTORY_EVENTS.ABORTED_BY_RESTART);
        // Live child: both axes retained for eft.4.5 re-adoption; no terminal event.
        assert.ok(sys2.ledger.get(live.sprintId));
        assert.equal(sys2.history.latestFor(live.sprintId), undefined);

        // The reconciled state is itself durable across a further reload.
        const reloaded = createLedger({ filePath: ledgerPath });
        await reloaded.start();
        assert.equal(reloaded.get(dead.sprintId), undefined);
        assert.ok(reloaded.get(live.sprintId));

        await fsp.rm(dir, { recursive: true, force: true });
    });
});

// -- (f) force-release --------------------------------------------------------

describe('reservation e2e -- (f) force-release tears down a wedged reservation', () => {
    test('force-release frees both axes, records an audit reason, and frees the scope for relaunch', async () => {
        const dir = await tmpDir();
        const sys = await buildSystem(dir, { R: ['child'], child: [] });

        const wedged = await sys.controller.launch({
            issue: 'R', members: ['alice'], branch: 'feat/one', base: 'main',
        });

        // While wedged, an overlapping relaunch (same scope) is rejected.
        await assert.rejects(
            () => sys.controller.launch({ issue: 'child', members: ['bob'], branch: 'feat/two', base: 'main' }),
            (err) => err instanceof ApiError && err.status === 409,
        );

        const audit = await sys.reconciler.forceRelease(wedged.sprintId, { by: 'akhil', reason: 'stuck child' });
        assert.equal(audit.event, HISTORY_EVENTS.FORCE_RELEASED);
        assert.equal(audit.by, 'akhil');
        assert.equal(audit.reason, 'stuck child');
        // Both axes recorded in the audit, both gone from the ledger.
        assert.deepEqual(audit.members, ['alice']);
        assert.deepEqual(audit.issueRoots, ['R']);
        assert.equal(sys.ledger.get(wedged.sprintId), undefined);

        // With the scope freed, the previously-blocked relaunch now succeeds.
        const relaunch = await sys.controller.launch({
            issue: 'child', members: ['bob'], branch: 'feat/two', base: 'main',
        });
        assert.ok(sys.ledger.get(relaunch.sprintId));

        await fsp.rm(dir, { recursive: true, force: true });
    });
});

// -- (g) intra-sprint memberLocks are a DIFFERENT, untouched mechanism --------

describe('reservation e2e -- (g) intra-sprint memberLocks behavior unchanged', () => {
    test('the ledger co-reserves a sprint whole member union under one key and exposes no per-member intra-sprint lock surface', async () => {
        const dir = await tmpDir();
        const sys = await buildSystem(dir, { R: [] });

        // One sprint claims MANY members (doer + reviewer + orchestrator) at once.
        // The reservation ledger is a CROSS-sprint exclusion only: within a single
        // sprint every member coexists freely under ONE sprintId key. The
        // role-level serialization that keeps two roles of the SAME sprint from
        // dispatching concurrently (auto-sprint/runner.js globalDoerTurn /
        // inFlightAgents) is an ORTHOGONAL, intra-sprint mechanism this ledger
        // deliberately does not model or touch (see ledger.mjs header).
        const launched = await sys.controller.launch({
            issue: 'R', members: ['alice'], branch: 'feat/x', base: 'main',
            roleMap: { doer: ['bob'], reviewer: ['carol'], orchestrator: ['orch1'] },
        });
        const reservation = sys.ledger.get(launched.sprintId);
        assert.deepEqual([...reservation.members].sort(), ['alice', 'bob', 'carol', 'orch1']);

        // The ledger has NO per-member intra-sprint lock/unlock API -- it neither
        // owns nor overrides runner.js's role-level serialization.
        for (const surface of ['lockMember', 'unlockMember', 'acquireMemberLock', 'memberLocks']) {
            assert.equal(typeof sys.ledger[surface], 'undefined', `ledger must not expose intra-sprint ${surface}`);
        }

        // Reserving these members for THIS sprint imposes no cross-lock between
        // them: a SECOND sprint may reuse them the instant this one releases,
        // proving the reservation is per-sprint, not a lingering per-member lock.
        await sys.ledger.release(launched.sprintId);
        const reused = await sys.controller.launch({
            issue: 'R', members: ['alice', 'bob', 'carol'], branch: 'feat/y', base: 'main',
        });
        assert.deepEqual([...sys.ledger.get(reused.sprintId).members].sort(), ['alice', 'bob', 'carol']);

        await fsp.rm(dir, { recursive: true, force: true });
    });
});
