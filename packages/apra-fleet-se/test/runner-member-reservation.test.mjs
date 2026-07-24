import { test, describe } from 'node:test';
import assert from 'node:assert';

import { createMemberReservationClient } from '../auto-sprint/runner.js';

// apra-fleet-eft.26.1 (Reservation interop gap, Hole 1): unit coverage for
// the fleet-server member_reservation bracket runner.js/bin/cli.mjs use to
// make a directly-launched sprint (never routed through the supervisor's
// POST /api/sprints) visible to execute_prompt's dispatch-time reservedBy
// check (eft.10.3) and the eft.26.2 supervisor overlap guard. This is a pure
// unit of the reserve/release CLIENT itself (an injected callTool), not the
// full cli.mjs process wiring (SIGINT handler / try-catch bracket), which is
// exercised end to end by the eft.26.3 test task.

describe('createMemberReservationClient (apra-fleet-eft.26.1)', () => {
    test('reserveAll calls member_reservation with action=reserve for every member, using the bound sprintId', async () => {
        const calls = [];
        const client = createMemberReservationClient({
            callTool: async (name, args) => { calls.push({ name, args }); return '[OK] reserved'; },
            members: ['alice', 'bob'],
            sprintId: 'feat/sprint-1',
        });
        await client.reserveAll();
        assert.deepEqual(calls, [
            { name: 'member_reservation', args: { member_name: 'alice', action: 'reserve', sprint_id: 'feat/sprint-1' } },
            { name: 'member_reservation', args: { member_name: 'bob', action: 'reserve', sprint_id: 'feat/sprint-1' } },
        ]);
    });

    test('releaseAll calls member_reservation with action=release for every member, using the SAME bound sprintId', async () => {
        const calls = [];
        const client = createMemberReservationClient({
            callTool: async (name, args) => { calls.push({ name, args }); return '[OK] released'; },
            members: ['alice', 'bob'],
            sprintId: 'feat/sprint-1',
        });
        await client.releaseAll();
        assert.deepEqual(calls, [
            { name: 'member_reservation', args: { member_name: 'alice', action: 'release', sprint_id: 'feat/sprint-1' } },
            { name: 'member_reservation', args: { member_name: 'bob', action: 'release', sprint_id: 'feat/sprint-1' } },
        ]);
    });

    test('is a no-op (never calls callTool) when members is empty', async () => {
        const calls = [];
        const client = createMemberReservationClient({
            callTool: async (name, args) => { calls.push({ name, args }); },
            members: [],
            sprintId: 'feat/sprint-1',
        });
        await client.reserveAll();
        await client.releaseAll();
        assert.equal(calls.length, 0);
    });

    test('is a no-op (never calls callTool) when sprintId is missing', async () => {
        const calls = [];
        const client = createMemberReservationClient({
            callTool: async (name, args) => { calls.push({ name, args }); },
            members: ['alice'],
        });
        await client.reserveAll();
        await client.releaseAll();
        assert.equal(calls.length, 0);
    });

    test('is a no-op (never throws) when callTool is not injected at all', async () => {
        const client = createMemberReservationClient({ members: ['alice'], sprintId: 'feat/sprint-1' });
        await assert.doesNotReject(() => client.reserveAll());
        await assert.doesNotReject(() => client.releaseAll());
    });

    test('best-effort: a rejected callTool() for one member is logged and does NOT throw, and later members still run', async () => {
        const calls = [];
        const logs = [];
        const client = createMemberReservationClient({
            callTool: async (name, args) => {
                calls.push(args.member_name);
                if (args.member_name === 'alice') throw new Error('transport down');
                return '[OK] reserved';
            },
            members: ['alice', 'bob'],
            sprintId: 'feat/sprint-1',
            log: (msg) => logs.push(msg),
        });
        await assert.doesNotReject(() => client.reserveAll());
        assert.deepEqual(calls, ['alice', 'bob']);
        assert.equal(logs.length, 1);
        assert.match(logs[0], /reserve failed for member 'alice'.*non-fatal/);
    });

    test('best-effort: a tool-level rejection (e.g. already reserved by another sprint) is logged, not thrown', async () => {
        const logs = [];
        const client = createMemberReservationClient({
            callTool: async () => '[-] Member "alice" is already reserved by "other-sprint".',
            members: ['alice'],
            sprintId: 'feat/sprint-1',
            log: (msg) => logs.push(msg),
        });
        await assert.doesNotReject(() => client.reserveAll());
        assert.equal(logs.length, 1);
        assert.match(logs[0], /reserve rejected for member 'alice'/);
        assert.match(logs[0], /already reserved by "other-sprint"/);
    });

    test('an MCP content-array result shape is read the same as a plain string result', async () => {
        const logs = [];
        const client = createMemberReservationClient({
            callTool: async () => ({ content: [{ type: 'text', text: '[-] already reserved' }] }),
            members: ['alice'],
            sprintId: 'feat/sprint-1',
            log: (msg) => logs.push(msg),
        });
        await client.reserveAll();
        assert.equal(logs.length, 1);
        assert.match(logs[0], /already reserved/);
    });

    test('a successful result (no leading "[-]", no isError) logs nothing', async () => {
        const logs = [];
        const client = createMemberReservationClient({
            callTool: async () => '[OK] Member "alice" reserved for "feat/sprint-1".',
            members: ['alice'],
            sprintId: 'feat/sprint-1',
            log: (msg) => logs.push(msg),
        });
        await client.reserveAll();
        assert.equal(logs.length, 0);
    });
});
