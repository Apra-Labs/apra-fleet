import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME, HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { createReconciler } from '../src/supervisor/reconcile.mjs';
import { createSprintController, ApiError, isProvablyDeadHolder } from '../src/supervisor/api.mjs';
import { buildSprintArgv } from '../src/supervisor/spawner.mjs';
import { parseCliArgs, memberReservationHolder } from '../bin/cli.mjs';
import { sprintIdentity } from '../fleet-sprint/coordination.mjs';

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

async function build(dir, fleet, opts = {}) {
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
        ...(opts.killPid ? { killPid: opts.killPid } : {}),
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

        // Nothing was killed (the holder may be a live CLI sprint that
        // re-reserves), so the event never proves the holder dead.
        assert.equal(ev[0].serverOnly, true);
        assert.equal(isProvablyDeadHolder('feat/old-branch', sys.ledger, sys.history).dead, false);

    });

    test('an id held nowhere still 404s (SprintNotFoundError)', async () => {
        const dir = await tmpDir();
        const fleet = fakeFleet([{ name: 'alice', reservedBy: 'other' }]);
        const sys = await build(dir, fleet);
        await assert.rejects(() => sys.reconciler.forceRelease('ghost'), (err) => err.code === 'SPRINT_NOT_FOUND');
        assert.deepEqual(fleet.calls, []);
    });
});

describe('stale reservations -- a force-release proves the holder dead only when the kill landed', () => {
    // Launch a sprint on alice, have it also hold alice on the fleet server,
    // then force-release it through the reconciler with the given kill result.
    async function forceReleasedHolder(killPid) {
        const dir = await tmpDir();
        const fleet = fakeFleet([{ name: 'alice', reservedBy: null }]);
        const sys = await build(dir, fleet, { killPid });
        const first = await sys.controller.launch(launchBody(['alice'], 'R1'));
        fleet.members[0].reservedBy = first.sprintId;
        const audit = await sys.reconciler.forceRelease(first.sprintId, { by: 'op' });
        return { sys, fleet, holder: first.sprintId, audit };
    }

    test('kill failed (EPERM, killPid false): the child may be alive, so the next launch gets a 409 naming the holder', async () => {
        const { sys, fleet, holder, audit } = await forceReleasedHolder(() => false);
        assert.equal(audit.killed, false);
        const ev = sys.history.forSprint(holder).filter((e) => e.event === HISTORY_EVENTS.FORCE_RELEASED);
        assert.equal(ev.length, 1);
        assert.equal(ev[0].killed, false);
        assert.equal(isProvablyDeadHolder(holder, sys.ledger, sys.history).dead, false);

        await assert.rejects(
            () => sys.controller.launch(launchBody(['alice'], 'R2')),
            (err) => err instanceof ApiError && err.status === 409 && err.message.includes(`'${holder}'`),
        );
        assert.deepEqual(fleet.calls, []);
        assert.equal(fleet.members[0].reservedBy, holder);
        assert.equal(sys.spawned.length, 1);
    });

    test('server-only holder force-released, then re-reserved by its live CLI sprint: the next launch gets a 409', async () => {
        const dir = await tmpDir();
        const fleet = fakeFleet([{ name: 'alice', reservedBy: 'cli-sprint-7' }]);
        const sys = await build(dir, fleet, { killPid: () => true });
        const audit = await sys.reconciler.forceRelease('cli-sprint-7', { by: 'op' });
        assert.equal(audit.serverOnly, true);
        assert.equal(fleet.members[0].reservedBy, null);
        // The live CLI sprint re-reserves under the same id on its next resume.
        fleet.members[0].reservedBy = 'cli-sprint-7';
        fleet.calls.length = 0;

        await assert.rejects(
            () => sys.controller.launch(launchBody(['alice'])),
            (err) => err instanceof ApiError && err.status === 409 && err.message.includes("'cli-sprint-7'"),
        );
        assert.deepEqual(fleet.calls, []);
        assert.equal(fleet.members[0].reservedBy, 'cli-sprint-7');
        assert.equal(sys.spawned.length, 0);
    });

    test('kill confirmed (killPid true): the holder is dead, the next launch releases it and reports staleReservationsReleased', async () => {
        const { sys, fleet, holder, audit } = await forceReleasedHolder(() => true);
        assert.equal(audit.killed, true);
        assert.equal(sys.history.forSprint(holder).find((e) => e.event === HISTORY_EVENTS.FORCE_RELEASED).killed, true);

        const warn = captureConsole('warn');
        let out;
        try { out = await sys.controller.launch(launchBody(['alice'], 'R2')); } finally { warn.restore(); }
        assert.equal(sys.spawned.length, 2);
        assert.deepEqual(fleet.calls, [{ member: 'alice', holder }]);
        assert.deepEqual(out.staleReservationsReleased, [{ member: 'alice', holder, event: HISTORY_EVENTS.FORCE_RELEASED }]);
    });

    test('isProvablyDeadHolder: force-released counts only with killed true and not serverOnly; legacy events without the field do not', () => {
        const ledger = { get: () => undefined };
        const FR = HISTORY_EVENTS.FORCE_RELEASED;
        const history = {
            forSprint: (id) => ({
                landed: [{ event: FR, killed: true }],
                failed: [{ event: FR, killed: false }],
                nochild: [{ event: FR }],
                server: [{ event: FR, serverOnly: true }],
                exitedThenFailed: [{ event: HISTORY_EVENTS.CHILD_EXITED }, { event: FR, killed: false }],
            }[id] ?? []),
        };
        assert.deepEqual(isProvablyDeadHolder('landed', ledger, history), { dead: true, event: FR });
        assert.deepEqual(isProvablyDeadHolder('failed', ledger, history), { dead: false });
        assert.deepEqual(isProvablyDeadHolder('nochild', ledger, history), { dead: false });
        assert.deepEqual(isProvablyDeadHolder('server', ledger, history), { dead: false });
        assert.deepEqual(isProvablyDeadHolder('exitedThenFailed', ledger, history), { dead: true, event: HISTORY_EVENTS.CHILD_EXITED });
    });
});

describe('stale reservations -- the holder id a supervisor-spawned child really writes', () => {
    // The child's fleet-server holder id, derived from the argv this
    // supervisor's spawner builds, through the child's own argument parsing.
    const childHolderId = (spawnOpts) =>
        memberReservationHolder(parseCliArgs(buildSprintArgv({ ...spawnOpts, viewerPort: 9301 })).values);

    test('sprintIdentity: run id wins, then branch, then a constant', () => {
        assert.equal(sprintIdentity({ runId: 'R1-x', branch: 'feat/x' }), 'R1-x');
        assert.equal(sprintIdentity({ runId: undefined, branch: 'feat/x' }), 'feat/x');
        assert.equal(sprintIdentity({ runId: '', branch: 'feat/x' }), 'feat/x');
        assert.equal(sprintIdentity({}), 'sprint');
    });

    test('the child reserves under the supervisor sprint id, not the branch; a direct CLI launch keeps the branch', () => {
        assert.equal(childHolderId({ issue: 'R1', members: 'alice', branch: 'feat/r1', base: 'main', runId: 'sup-7' }), 'sup-7');
        assert.equal(childHolderId({ issue: 'R1', members: 'alice', branch: 'feat/r1', base: 'main' }), 'feat/r1');
    });

    test('a kill -9 child (exit recorded, reservation auto-released) holding its members under its real holder id: the relaunch releases them (201)', async () => {
        const dir = await tmpDir();
        const fleet = fakeFleet([{ name: 'alice', reservedBy: null }, { name: 'bob', reservedBy: null }]);
        const sys = await build(dir, fleet);
        const first = await sys.controller.launch(launchBody(['alice', 'bob'], 'R1'));
        // What the child wrote on the fleet server, from its real argv.
        const holder = childHolderId(sys.spawned[0]);
        assert.equal(holder, first.sprintId);
        for (const m of fleet.members) m.reservedBy = holder;
        // kill -9: the watchdog records the exit and releases the ledger entry;
        // the dead child never released its fleet-server reservations.
        await sys.history.record({ sprintId: first.sprintId, event: HISTORY_EVENTS.CHILD_EXITED, exitCode: 137 });
        await sys.ledger.release(first.sprintId);
        await sys.history.record({ sprintId: first.sprintId, event: HISTORY_EVENTS.AUTO_RELEASED });

        const warn = captureConsole('warn');
        let out;
        try { out = await sys.controller.launch(launchBody(['alice', 'bob'], 'R2')); } finally { warn.restore(); }
        assert.equal(sys.spawned.length, 2);
        assert.deepEqual(out.staleReservationsReleased.map((r) => r.holder), [holder, holder]);
        assert.deepEqual(fleet.members.map((m) => m.reservedBy), [null, null]);
    });

    test('a direct CLI sprint on the SAME branch as a dead supervisor sprint (holder = branch name) still gets a 409', async () => {
        const dir = await tmpDir();
        const fleet = fakeFleet([{ name: 'alice', reservedBy: null }]);
        const sys = await build(dir, fleet);
        const first = await sys.controller.launch(launchBody(['alice'], 'R1'));
        await sys.history.record({ sprintId: first.sprintId, event: HISTORY_EVENTS.CHILD_EXITED, exitCode: 137 });
        await sys.ledger.release(first.sprintId);
        // A CLI sprint launched directly on the same branch holds alice.
        const cliHolder = memberReservationHolder(parseCliArgs(['--issue', 'R1', '--members', 'alice', '--branch', 'feat/r1', '--base', 'main']).values);
        assert.equal(cliHolder, 'feat/r1');
        fleet.members[0].reservedBy = cliHolder;

        await assert.rejects(
            () => sys.controller.launch(launchBody(['alice'], 'R2')),
            (err) => err instanceof ApiError && err.status === 409 && err.message.includes("'feat/r1'"),
        );
        assert.deepEqual(fleet.calls, []);
        assert.equal(fleet.members[0].reservedBy, 'feat/r1');
    });
});
