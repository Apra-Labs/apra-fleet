import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME, HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { createReconciler } from '../src/supervisor/reconcile.mjs';
import { createSprintController, ApiError, isProvablyDeadHolder } from '../src/supervisor/api.mjs';

// Stale fleet-server member reservations: the launch-time release rule
// (isProvablyDeadHolder) and force-release of a holder id that only the fleet
// server knows about.

// Every test's temp dir, removed after the file even when an assertion fails.
const dirs = [];
after(async () => { await Promise.all(dirs.map((d) => fsp.rm(d, { recursive: true, force: true }))); });

async function tmpDir() {
    const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'stale-res-'));
    dirs.push(d);
    return d;
}

/** A fake fleet server: a mutable member list plus a conditional release. */
function fakeFleet(members) {
    const calls = [];
    return {
        members,
        calls,
        listMembers: () => ({ members: members.map((m) => ({ ...m })) }),
        releaseMemberReservation: async ({ member, holder }) => {
            calls.push({ member, holder });
            const m = members.find((x) => x.name === member);
            if (!m) return { ok: false, error: 'member_not_found' };
            if (m.reservedBy !== holder) return { ok: false, error: `reserved by ${m.reservedBy}` };
            m.reservedBy = null;
            return { ok: true, outcome: 'released' };
        },
    };
}

async function build(dir, fleet) {
    const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-11-25T00:00:00.000Z' });
    await ledger.start();
    const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => '2026-11-25T01:00:00.000Z' });
    await history.start();
    const spawned = [];
    let seq = 0;
    const controller = createSprintController({
        ledger,
        history,
        spawner: { spawnSprint: async (o) => { spawned.push(o); return { pid: 7000 + spawned.length, port: 9300 + spawned.length }; } },
        listMembers: fleet.listMembers,
        releaseMemberReservation: fleet.releaseMemberReservation,
        resolveRoleMap: async (raw) => (raw ? JSON.parse(raw) : undefined),
        generateSprintId: () => `sup-${seq++}`,
        hasTerminalState: () => null,
        getBuildVersion: () => null,
    });
    const reconciler = createReconciler({
        ledger, history,
        listMembers: fleet.listMembers,
        releaseMemberReservation: fleet.releaseMemberReservation,
        logger: { log() {}, warn() {}, error() {} },
    });
    return { ledger, history, controller, reconciler, spawned };
}

const launchBody = (members, issue = 'R1') => ({ issue, members, branch: `feat/${issue.toLowerCase()}`, base: 'main' });

function captureConsole(method) {
    const lines = [];
    const orig = console[method];
    console[method] = (...a) => { lines.push(a.join(' ')); };
    return { lines, restore: () => { console[method] = orig; } };
}

describe('stale reservations -- launch-time release rule', () => {
    test('a holder this supervisor recorded as ended is released, logged with holder and member, and the launch succeeds', async () => {
        const dir = await tmpDir();
        const fleet = fakeFleet([{ name: 'alice', reservedBy: 'old-sprint-1' }]);
        const sys = await build(dir, fleet);
        await sys.history.record({ sprintId: 'old-sprint-1', event: HISTORY_EVENTS.CHILD_EXITED, exitCode: 1 });

        const warn = captureConsole('warn');
        let out;
        try { out = await sys.controller.launch(launchBody(['alice'])); } finally { warn.restore(); }

        assert.equal(sys.spawned.length, 1);
        assert.deepEqual(fleet.calls, [{ member: 'alice', holder: 'old-sprint-1' }]);
        assert.equal(fleet.members[0].reservedBy, null);
        assert.deepEqual(out.staleReservationsReleased, [{ member: 'alice', holder: 'old-sprint-1', event: HISTORY_EVENTS.CHILD_EXITED }]);
        const line = warn.lines.find((l) => l.includes('STALE RESERVATION RELEASED'));
        assert.ok(line, `expected a loud release log line, got: ${warn.lines.join('\n')}`);
        assert.ok(line.includes("'alice'") && line.includes("'old-sprint-1'"), line);

    });

    test('a holder with no ledger entry and no history (branch-name form, or a direct CLI sprint) is not released: 409 names holder and recovery', async () => {
        const dir = await tmpDir();
        const fleet = fakeFleet([{ name: 'alice', reservedBy: 'feat/old-branch' }]);
        const sys = await build(dir, fleet);

        await assert.rejects(
            () => sys.controller.launch(launchBody(['alice'])),
            (err) => err instanceof ApiError && err.status === 409
                && err.message.includes("'feat/old-branch'")
                && err.message.includes('/api/reservations/feat%2Fold-branch/force-release')
                && err.message.includes('member_reservation {"member_name":"alice","action":"force_release"}'),
        );
        assert.deepEqual(fleet.calls, []);
        assert.equal(fleet.members[0].reservedBy, 'feat/old-branch');
        assert.equal(sys.spawned.length, 0);

    });

    test('a member held by a live ledger sprint is never released by launch; the 409 keeps its meaning', async () => {
        const dir = await tmpDir();
        const fleet = fakeFleet([{ name: 'alice', reservedBy: null }]);
        const sys = await build(dir, fleet);
        const first = await sys.controller.launch(launchBody(['alice'], 'R1'));
        // The live sprint also holds alice on the fleet server.
        fleet.members[0].reservedBy = first.sprintId;
        // Even a stray terminal-looking event never releases a ledger holder.
        await sys.history.record({ sprintId: first.sprintId, event: HISTORY_EVENTS.CHILD_EXITED, exitCode: 0 });

        await assert.rejects(
            () => sys.controller.launch(launchBody(['alice'], 'R2')),
            (err) => err instanceof ApiError && err.status === 409
                && err.message === `member overlap rejects launch: sprint '${first.sprintId}' already claims [alice]`,
        );
        assert.deepEqual(fleet.calls, []);
        assert.equal(fleet.members[0].reservedBy, first.sprintId);
        assert.ok(sys.ledger.get(first.sprintId));

    });

    test('isProvablyDeadHolder: ledger entry or missing history -> not dead; release-class event -> dead', async () => {
        const ledger = { get: (id) => (id === 'live' ? { sprintId: 'live' } : undefined) };
        const history = {
            forSprint: (id) => ({
                live: [{ event: HISTORY_EVENTS.FINISHED }],
                gone: [{ event: HISTORY_EVENTS.AUTO_RELEASED }],
            }[id] ?? []),
        };
        assert.deepEqual(isProvablyDeadHolder('live', ledger, history), { dead: false });
        assert.deepEqual(isProvablyDeadHolder('feat/x', ledger, history), { dead: false });
        assert.deepEqual(isProvablyDeadHolder('gone', ledger, history), { dead: true, event: HISTORY_EVENTS.AUTO_RELEASED });
    });
});

describe('stale reservations -- force-release of a fleet-server-only holder', () => {
    test('a branch-name holder only on the fleet server: releases exactly its members and records history', async () => {
        const dir = await tmpDir();
        const fleet = fakeFleet([
            { name: 'alice', reservedBy: 'feat/old-branch' },
            { name: 'bob', reservedBy: 'feat/old-branch' },
            { name: 'carol', reservedBy: 'someone-else' },
        ]);
        const sys = await build(dir, fleet);

        const audit = await sys.reconciler.forceRelease('feat/old-branch', { by: 'op' });
        assert.equal(audit.serverOnly, true);
        assert.deepEqual(audit.releasedMembers, ['alice', 'bob']);
        assert.deepEqual(fleet.members.map((m) => m.reservedBy), [null, null, 'someone-else']);
        const ev = sys.history.forSprint('feat/old-branch');
        assert.equal(ev.length, 1);
        assert.equal(ev[0].event, HISTORY_EVENTS.FORCE_RELEASED);
        assert.deepEqual(ev[0].members, ['alice', 'bob']);

        // Recorded as force-released, so the holder now counts as provably dead.
        assert.equal(isProvablyDeadHolder('feat/old-branch', sys.ledger, sys.history).dead, true);

    });

    test('an id held nowhere still 404s (SprintNotFoundError)', async () => {
        const dir = await tmpDir();
        const fleet = fakeFleet([{ name: 'alice', reservedBy: 'other' }]);
        const sys = await build(dir, fleet);
        await assert.rejects(() => sys.reconciler.forceRelease('ghost'), (err) => err.code === 'SPRINT_NOT_FOUND');
        assert.deepEqual(fleet.calls, []);
    });
});
