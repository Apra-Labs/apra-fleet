import { test, describe } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createMemberReservationClient } from '../auto-sprint/runner.js';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import { createSprintController, ApiError } from '../src/supervisor/api.mjs';

// =============================================================================
// apra-fleet-eft.26.3 -- END-TO-END coverage for the eft.26.1 + eft.26.2 fix
// pair (the "Reservation interop gap", apra-fleet-eft.26). Where
// runner-member-reservation.test.mjs unit-tests createMemberReservationClient
// in isolation and supervisor-api.test.mjs unit-tests
// defaultMemberOverlapGuard()/the /api/members overlay against a stubbed
// listMembers, THIS suite composes them the way a real deployment does:
//
//   * a fake fleet-server member registry (`createFakeFleetServer`) that
//     reproduces the REAL reserve/release/force_release semantics of
//     src/tools/member-reservation.ts (ownership check, rejection text
//     shape, "[OK]"/"[-]" prefixes) and the REAL GET-list_members shape
//     (`{ name, reservedBy }`) consumed by both defaultMemberOverlapGuard and
//     the supervisor's /api/members overlay;
//   * `runCliStyleBracket` below reproduces the EXACT reserve/release bracket
//     bin/cli.mjs wires around a sprint run (reserve before the run; release
//     exactly once on success, on a caught failure/stall-abort, or on
//     SIGINT) using the SAME exported `createMemberReservationClient` cli.mjs
//     itself imports -- see bin/cli.mjs lines ~650-725. It is deliberately
//     NOT a spawned child process (this package's tests never shell out to
//     the real CLI); it drives the identical client/bracket shape so the
//     assertions below are about the real reserve/release CONTRACT, not a
//     reimplementation of it.
//
// Four acceptance cases (apra-fleet-eft.26 / eft.26.3):
//   1. reserve/release bracket: reserved during the run, released on every
//      exit path (success, stall-abort, SIGINT).
//   2. cross-sprint overlap: with the local ledger EMPTY and a member held
//      only via the server-side reservedBy record, POST /api/sprints (here:
//      controller.launch()) rejects 409 naming the owning sprint id.
//   3. GET /api/members (controller.members()) surfaces the server-side
//      reservation.
//   4. abnormal-exit (killed child) release -- documented below.
// =============================================================================

async function tmpDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'eft-reservation-interop-'));
}

/**
 * A fake fleet server member registry reproducing the REAL semantics of
 * src/tools/member-reservation.ts (reserve/release/force_release, ownership
 * rules, "[OK]"/"[-]" text prefixes) and src/tools/list-members.ts's
 * `reservedBy` field. `callTool` is a drop-in for the MCP client
 * `createMemberReservationClient` expects; `listMembers` is a drop-in for the
 * collaborator `defaultMemberOverlapGuard` / the supervisor /api/members
 * overlay consult.
 */
function createFakeFleetServer(memberNames) {
    // name -> owning sprintId | null. This Map IS the "reservedBy" field on
    // every member -- there is no TTL/expiry/timestamp tracked alongside it,
    // matching the real Agent.reservedBy field (src/types.ts) exactly.
    const state = new Map(memberNames.map((n) => [n, null]));

    function reserve(name, sprintId) {
        const current = state.get(name) ?? null;
        if (current && current !== sprintId) {
            return `[-] Member "${name}" is already reserved by "${current}". Use force_release to clear a wedged reservation, or release it as that sprint first.`;
        }
        state.set(name, sprintId);
        return current === sprintId
            ? `[OK] Member "${name}" reservation refreshed for "${sprintId}" (was already held by this sprint).`
            : `[OK] Member "${name}" reserved for "${sprintId}".`;
    }

    function release(name, sprintId) {
        const current = state.get(name) ?? null;
        if (!current) return `[OK] Member "${name}" was not reserved. Nothing to release.`;
        if (current !== sprintId) {
            return `[-] Member "${name}" is reserved by "${current}", not "${sprintId}". Refusing to release someone else's reservation -- use force_release to override.`;
        }
        state.set(name, null);
        return `[OK] Member "${name}" reservation released.`;
    }

    function forceRelease(name) {
        const current = state.get(name) ?? null;
        state.set(name, null);
        return current
            ? `[OK] Member "${name}" reservation forcibly cleared (was held by "${current}").`
            : `[OK] Member "${name}" was not reserved. Nothing to force-release.`;
    }

    async function callTool(toolName, args) {
        if (toolName !== 'member_reservation') throw new Error(`unexpected tool '${toolName}'`);
        const { member_name, action, sprint_id } = args;
        if (action === 'reserve') return reserve(member_name, sprint_id);
        if (action === 'release') return release(member_name, sprint_id);
        if (action === 'force_release') return forceRelease(member_name);
        throw new Error(`unknown member_reservation action '${action}'`);
    }

    function listMembers() {
        return { members: memberNames.map((n) => ({ name: n, reservedBy: state.get(n) ?? null })) };
    }

    return { state, reserve, release, forceRelease, callTool, listMembers };
}

/**
 * Reproduces bin/cli.mjs's reserve/release bracket (lines ~650-725): reserve
 * every member BEFORE the run, release exactly once on success, on a caught
 * failure (stall-abort et al.), OR on SIGINT -- whichever happens first.
 * `run` stands in for `engine.executeFile(...)`. Returns once the members are
 * reserved and the run has been kicked off (mirroring cli.mjs's own
 * control flow up to `await engine.executeFile(...)`), so a test can inspect
 * "reserved during the run" state before the run settles, and can invoke
 * `onSigint()` to model Ctrl-C independently of whether `run()` ever resolves.
 */
async function runCliStyleBracket({ fleetServer, members, sprintId, run }) {
    const client = createMemberReservationClient({
        callTool: fleetServer.callTool,
        members,
        sprintId,
        log: () => {},
    });
    await client.reserveAll();

    let released = false;
    const releaseOnce = async () => {
        if (released) return;
        released = true;
        await client.releaseAll();
    };

    const settled = (async () => {
        try {
            const result = await run();
            await releaseOnce();
            return { outcome: 'success', result };
        } catch (error) {
            await releaseOnce();
            return { outcome: 'failed', error };
        }
    })();

    return {
        // Mirrors cli.mjs's process.once('SIGINT', onSigint): release-once,
        // independent of whatever `run()`/`settled` eventually does.
        onSigint: async () => { await releaseOnce(); return { outcome: 'sigint' }; },
        settled,
    };
}

// -- (1) reserve/release bracket: reserved during run, released on every exit path

describe('reservation interop e2e -- (1) reserve/release bracket, every exit path', () => {
    test('success: members reserved during the run, released after it resolves', async () => {
        const fleetServer = createFakeFleetServer(['alice', 'bob']);
        let resolveRun;
        const run = () => new Promise((resolve) => { resolveRun = resolve; });

        const handle = await runCliStyleBracket({
            fleetServer, members: ['alice', 'bob'], sprintId: 'feat/sprint-1', run,
        });

        // Reserved DURING the run (before the run has settled).
        assert.equal(fleetServer.state.get('alice'), 'feat/sprint-1');
        assert.equal(fleetServer.state.get('bob'), 'feat/sprint-1');

        resolveRun('sprint finished');
        const outcome = await handle.settled;
        assert.equal(outcome.outcome, 'success');

        // Released after normal completion.
        assert.equal(fleetServer.state.get('alice'), null);
        assert.equal(fleetServer.state.get('bob'), null);
    });

    test('stall-abort (caught failure): reserved during the run, released in the catch branch', async () => {
        const fleetServer = createFakeFleetServer(['alice']);
        let rejectRun;
        const run = () => new Promise((_resolve, reject) => { rejectRun = reject; });

        const handle = await runCliStyleBracket({
            fleetServer, members: ['alice'], sprintId: 'feat/sprint-2', run,
        });
        assert.equal(fleetServer.state.get('alice'), 'feat/sprint-2');

        rejectRun(new Error('StalledSprintError: no progress after N cycles'));
        const outcome = await handle.settled;
        assert.equal(outcome.outcome, 'failed');
        assert.match(outcome.error.message, /StalledSprintError/);

        // Released even though the run failed -- the catch branch's
        // releaseReservationOnce() bracket (mirrored here) still runs.
        assert.equal(fleetServer.state.get('alice'), null);
    });

    test('SIGINT: reserved during the run, released by the SIGINT handler even though the run never settles', async () => {
        const fleetServer = createFakeFleetServer(['alice', 'carol']);
        const run = () => new Promise(() => {}); // never resolves -- models an in-flight sprint

        const handle = await runCliStyleBracket({
            fleetServer, members: ['alice', 'carol'], sprintId: 'feat/sprint-3', run,
        });
        assert.equal(fleetServer.state.get('alice'), 'feat/sprint-3');
        assert.equal(fleetServer.state.get('carol'), 'feat/sprint-3');

        const sigintOutcome = await handle.onSigint();
        assert.equal(sigintOutcome.outcome, 'sigint');

        // Released on Ctrl-C, independent of the (still-pending) run.
        assert.equal(fleetServer.state.get('alice'), null);
        assert.equal(fleetServer.state.get('carol'), null);

        // releaseOnce is idempotent: a second SIGINT (or the run eventually
        // settling and calling its own releaseOnce) never double-releases or
        // throws -- matches cli.mjs's `reservationReleased` guard.
        await assert.doesNotReject(() => handle.onSigint());
    });
});

// -- (2) + (3): composed supervisor stack over the SAME fake fleet server -----

/** Compose the real ledger + history + controller, wired to a fake fleet server. */
async function buildSupervisorSystem(dir, fleetServer) {
    const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-07-20T00:00:00.000Z' });
    await ledger.start();
    const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => '2026-07-20T00:00:00.000Z' });
    await history.start();

    const captured = [];
    let nextPid = 6000;
    const spawner = createSpawner({
        basePort: 9200,
        isPortAvailable: async () => true,
        spawn: (command, args) => {
            const pid = nextPid++;
            captured.push({ command, args, pid });
            return { pid, once() { return this; }, unref() {} };
        },
    });

    let seq = 0;
    // beforeLaunch is NOT injected: the default is
    // defaultMemberOverlapGuard(ledger, listMembers), exactly what a real
    // supervisor wires (src/supervisor/api.mjs createSprintController).
    const controller = createSprintController({
        ledger,
        history,
        spawner,
        listMembers: fleetServer.listMembers,
        getBacklog: () => ({ tasks: [] }),
        generateSprintId: (issue) => `sprint-${issue}-${seq++}`,
    });

    return { ledger, history, controller, captured };
}

describe('reservation interop e2e -- (2) cross-sprint overlap: ledger-empty, server-reserved', () => {
    test('POST /api/sprints (controller.launch) rejects 409 naming the workflow-launched sprint id, before any child spawns', async () => {
        const dir = await tmpDir();
        const fleetServer = createFakeFleetServer(['alice', 'bob', 'carol']);

        // A workflow/cli-launched sprint reserved 'alice' server-side via
        // eft.26.1's bracket -- this supervisor's OWN ledger never saw it
        // (ledger-empty-but-server-reserved is exactly the eft.26.2 gap).
        const workflowOutcome = fleetServer.reserve('alice', 'workflow-feat-x');
        assert.match(workflowOutcome, /^\[OK\]/);

        const sys = await buildSupervisorSystem(dir, fleetServer);
        assert.equal(sys.ledger.size, 0, 'the local ledger is empty -- the reservation is server-side only');

        await assert.rejects(
            () => sys.controller.launch({
                issue: 'R1', members: ['alice', 'bob'], branch: 'feat/two', base: 'main',
            }),
            (err) => err instanceof ApiError
                && err.status === 409
                && err.field === 'members'
                && err.message.includes('workflow-feat-x') // names the OWNING sprint id
                && err.message.includes('alice'),
        );

        // Rejected before ledger.claim() and before any child spawn -- no
        // partial claim, byte-identical ledger.
        assert.equal(sys.ledger.size, 0);
        assert.equal(sys.captured.length, 0);

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('a launch whose member union is disjoint from every server-side reservation still succeeds', async () => {
        const dir = await tmpDir();
        const fleetServer = createFakeFleetServer(['alice', 'bob', 'carol']);
        fleetServer.reserve('alice', 'workflow-feat-x');

        const sys = await buildSupervisorSystem(dir, fleetServer);
        const launched = await sys.controller.launch({
            issue: 'R2', members: ['bob', 'carol'], branch: 'feat/three', base: 'main',
        });
        assert.ok(launched.sprintId);
        assert.equal(sys.captured.length, 1);

        await fsp.rm(dir, { recursive: true, force: true });
    });
});

describe('reservation interop e2e -- (3) GET /api/members overlay shows the server-side reservation', () => {
    test('controller.members() surfaces reservedBy for a server-only (non-ledger) reservation', async () => {
        const dir = await tmpDir();
        const fleetServer = createFakeFleetServer(['alice', 'bob']);
        fleetServer.reserve('alice', 'workflow-feat-x');

        const sys = await buildSupervisorSystem(dir, fleetServer);
        const overlay = await sys.controller.members();
        const byName = Object.fromEntries(overlay.members.map((m) => [m.name, m]));

        assert.equal(byName.alice.reserved, true);
        assert.equal(byName.alice.reservedBy, 'workflow-feat-x');
        assert.equal(byName.bob.reserved, false);
        assert.equal(byName.bob.reservedBy, null);

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('a LOCAL ledger reservation is layered on top of (and taken over) the server-side overlay too', async () => {
        const dir = await tmpDir();
        const fleetServer = createFakeFleetServer(['alice']);
        const sys = await buildSupervisorSystem(dir, fleetServer);

        const launched = await sys.controller.launch({
            issue: 'R3', members: ['alice'], branch: 'feat/four', base: 'main',
        });
        const overlay = await sys.controller.members();
        const byName = Object.fromEntries(overlay.members.map((m) => [m.name, m]));
        assert.equal(byName.alice.reservedBy, launched.sprintId);

        await fsp.rm(dir, { recursive: true, force: true });
    });
});

// -- (4) abnormal-exit (killed child) release: DOCUMENTED mechanism -----------
//
// This codebase has NO lease/TTL on the fleet server's per-member
// `reservedBy` field (src/types.ts Agent.reservedBy is a plain
// `string | null`, and src/tools/member-reservation.ts reserve/release never
// stamp or check a timestamp) and NO automated watchdog that reaches into it:
// the supervisor's PID-liveness watchdog (packages/apra-fleet-se/src/
// supervisor/watchdog.mjs, createWatchdog) only classifies sprints IN ITS OWN
// LEDGER (supervisor-routed launches) into running-healthy /
// running-unresponsive / crashed / finished, and never calls
// member_reservation at all -- a workflow/cli-launched sprint (eft.26.1) is
// never in that ledger to begin with. So a killed workflow/cli-launched child
// (SIGKILL, OOM, host crash -- anything that skips both the try/catch and the
// SIGINT handler in bin/cli.mjs) leaves its server-side reservation held
// INDEFINITELY: there is no lease to expire.
//
// The recovery mechanism that DOES exist and IS exercised below is the
// `member_reservation` tool's `action: "force_release"` (member-reservation.ts
// lines 71-78): it clears `reservedBy` UNCONDITIONALLY, regardless of the
// current holder, and is documented in its own zod schema description as the
// tool to "recover a wedged reservation". This is an OPERATOR- or
// external-watchdog-DRIVEN recovery path (there is no code in this repo that
// invokes it automatically on a timer), not a self-expiring lease -- exactly
// the "watchdog force-release" branch of this task's acceptance criterion 4.

describe('reservation interop e2e -- (4) abnormal-exit release: no lease expiry; force_release is the documented recovery path', () => {
    test('a killed child leaves its reservation held indefinitely (no auto-release, no lease to expire)', async () => {
        const dir = await tmpDir();
        const fleetServer = createFakeFleetServer(['dave']);

        // Model an abrupt kill: reserve exactly as the eft.26.1 bracket does
        // at sprint start, then simulate SIGKILL by simply NEVER running any
        // more of the bracket's code -- no try/catch, no SIGINT handler, no
        // releaseOnce() ever fires. This is deliberately NOT
        // runCliStyleBracket()'s onSigint/catch paths (both of which DO
        // release) -- it is what happens when neither of them gets a chance
        // to run at all.
        const reserveOutcome = fleetServer.reserve('dave', 'workflow-crashed-1');
        assert.match(reserveOutcome, /^\[OK\]/);
        // -- the child is "killed" here; nothing further runs on its behalf --

        assert.equal(fleetServer.state.get('dave'), 'workflow-crashed-1', 'held indefinitely: no timer, no expiry');

        // The wedged reservation still blocks a real overlapping launch --
        // proving this is a genuine hazard an operator must actively resolve,
        // not a cosmetic status field.
        const sys = await buildSupervisorSystem(dir, fleetServer);
        await assert.rejects(
            () => sys.controller.launch({ issue: 'R4', members: ['dave'], branch: 'feat/five', base: 'main' }),
            (err) => err instanceof ApiError && err.status === 409 && err.message.includes('workflow-crashed-1'),
        );

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('force_release is the documented recovery path: clears the reservation regardless of holder, and unblocks a subsequent launch', async () => {
        const dir = await tmpDir();
        const fleetServer = createFakeFleetServer(['dave']);
        fleetServer.reserve('dave', 'workflow-crashed-1');

        // Confirm force_release works even though NO sprint_id names the
        // current holder (unconditional, per member-reservation.ts).
        const forceOutcome = await fleetServer.callTool('member_reservation', {
            member_name: 'dave', action: 'force_release',
        });
        assert.match(forceOutcome, /^\[OK\]/);
        assert.match(forceOutcome, /forcibly cleared/);
        assert.equal(fleetServer.state.get('dave'), null);

        // The overlay reflects the recovery immediately.
        const sys = await buildSupervisorSystem(dir, fleetServer);
        const overlay = await sys.controller.members();
        const dave = overlay.members.find((m) => m.name === 'dave');
        assert.equal(dave.reserved, false);
        assert.equal(dave.reservedBy, null);

        // And the previously-blocked launch now succeeds.
        const launched = await sys.controller.launch({ issue: 'R5', members: ['dave'], branch: 'feat/six', base: 'main' });
        assert.ok(launched.sprintId);

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('force_release is idempotent when the member was never (or is no longer) reserved', async () => {
        const fleetServer = createFakeFleetServer(['erin']);
        const outcome = await fleetServer.callTool('member_reservation', { member_name: 'erin', action: 'force_release' });
        assert.match(outcome, /^\[OK\]/);
        assert.match(outcome, /was not reserved/);
        assert.equal(fleetServer.state.get('erin'), null);
    });
});
