import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { reserveThenAlign, createViewerOrRelease } from '../bin/cli.mjs';
import { createMemberReservationClient } from '../fleet-sprint/coordination.mjs';

// Launch alignment stashes WIP and switches branches on members, so a launch
// must reserve its members BEFORE aligning them: a member another sprint holds
// must never be moved, and a refused alignment must leave no reservation.
// FALSIFICATION: running align() before reserveForLaunch() in reserveThenAlign
// fails "a member held by another sprint is never aligned".

/** A fake member_reservation server: `owners` maps member -> owning sprint id. */
function fakeServer(owners = {}) {
    const calls = [];
    const callTool = async (name, args) => {
        calls.push({ name, ...args });
        const owner = owners[args.member_name];
        if (args.action === 'reserve') {
            if (owner && owner !== args.sprint_id) {
                return { content: [{ type: 'text', text: `[-] reserved by ${owner}` }], structuredContent: { ok: false, outcome: 'already_reserved_by_other', ownerSprintId: owner } };
            }
            owners[args.member_name] = args.sprint_id;
            return { content: [{ type: 'text', text: '[OK] reserved' }], structuredContent: { ok: true, outcome: owner ? 'reservation_refreshed' : 'reserved' } };
        }
        if (owner === args.sprint_id) delete owners[args.member_name];
        return { content: [{ type: 'text', text: '[OK] released' }], structuredContent: { ok: true, outcome: 'released' } };
    };
    return { calls, owners, callTool };
}

function client(server, members) {
    return createMemberReservationClient({ callTool: server.callTool, members, sprintId: 'feat/sprint', log: () => {} });
}

describe('reserveThenAlign (launch reserves members before aligning them)', () => {
    test('a member held by another sprint is never aligned; nothing stays reserved', async () => {
        const server = fakeServer({ bob: 'feat/other' });
        let aligned = false;
        const res = await reserveThenAlign({
            sprintReservation: client(server, ['alice', 'bob']),
            align: async () => { aligned = true; return { ok: true }; },
        });
        assert.equal(aligned, false);
        assert.equal(res.ok, false);
        assert.equal(res.reserved, false);
        assert.match(res.message, /bob/);
        assert.doesNotMatch(res.message, /alice/);
        // alice was reserved, then handed back; bob still belongs to the other sprint.
        assert.deepEqual(server.owners, { bob: 'feat/other' });
    });

    test('reserves every member before alignment runs, and keeps them on success', async () => {
        const server = fakeServer();
        let ownersAtAlign;
        const res = await reserveThenAlign({
            sprintReservation: client(server, ['alice', 'bob']),
            align: async () => { ownersAtAlign = { ...server.owners }; return { ok: true, singleMember: false, message: 'aligned' }; },
        });
        assert.deepEqual(ownersAtAlign, { alice: 'feat/sprint', bob: 'feat/sprint' });
        assert.equal(res.ok, true);
        assert.equal(res.reserved, true);
        assert.equal(res.message, 'aligned');
        assert.deepEqual(server.owners, { alice: 'feat/sprint', bob: 'feat/sprint' });
    });

    test('an alignment refusal releases every reservation and passes the refusal through', async () => {
        const server = fakeServer();
        const res = await reserveThenAlign({
            sprintReservation: client(server, ['alice', 'bob']),
            align: async () => ({ ok: false, message: 'origin differs on bob' }),
        });
        assert.equal(res.ok, false);
        assert.equal(res.reserved, false);
        assert.equal(res.message, 'origin differs on bob');
        assert.deepEqual(server.owners, {});
    });

    test('an alignment throw releases every reservation and rethrows', async () => {
        const server = fakeServer();
        await assert.rejects(
            reserveThenAlign({
                sprintReservation: client(server, ['alice']),
                align: async () => { throw new Error('boom'); },
            }),
            /boom/,
        );
        assert.deepEqual(server.owners, {});
    });

    test('a relaunch on the same sprint id (reservation_refreshed) proceeds', async () => {
        const server = fakeServer({ alice: 'feat/sprint' });
        const res = await reserveThenAlign({
            sprintReservation: client(server, ['alice']),
            align: async () => ({ ok: true }),
        });
        assert.equal(res.ok, true);
    });

    test('a transport failure stays best-effort (not treated as held)', async () => {
        const res = await reserveThenAlign({
            sprintReservation: createMemberReservationClient({
                callTool: async () => { throw new Error('no member_reservation tool'); },
                members: ['alice'], sprintId: 'feat/sprint', log: () => {},
            }),
            align: async () => ({ ok: true }),
        });
        assert.equal(res.ok, true);
    });
});

describe('launch reservation hygiene (viewer throw, holder in refusal)', () => {
    test('a synchronous viewer throw releases every reservation and exits non-zero', async () => {
        const server = fakeServer();
        const sprintReservation = client(server, ['alice', 'bob']);
        await sprintReservation.reserveForLaunch();
        assert.deepEqual(Object.keys(server.owners).sort(), ['alice', 'bob']);
        let exitCode;
        await createViewerOrRelease({
            sprintReservation,
            create: () => { throw new Error('viewer boom'); },
            exit: (c) => { exitCode = c; },
        });
        assert.equal(exitCode, 1);
        assert.deepEqual(server.owners, {});
    });

    test('a viewer that constructs fine is returned and nothing is released', async () => {
        const server = fakeServer();
        const sprintReservation = client(server, ['alice']);
        await sprintReservation.reserveForLaunch();
        const v = await createViewerOrRelease({ sprintReservation, create: () => ({ ok: 1 }), exit: () => assert.fail('no exit') });
        assert.deepEqual(v, { ok: 1 });
        assert.deepEqual(server.owners, { alice: 'feat/sprint' });
    });

    test('refusal names each holder sprint id and a copy-pasteable release command', async () => {
        const server = fakeServer({ bob: 'feat/other', carol: 'sprint-xyz' });
        const res = await reserveThenAlign({
            sprintReservation: client(server, ['alice', 'bob', 'carol']),
            align: async () => ({ ok: true }),
        });
        assert.equal(res.ok, false);
        assert.match(res.message, /bob: held by sprint 'feat\/other'/);
        assert.match(res.message, /member_reservation \{"member_name":"bob","action":"force_release"\}/);
        assert.match(res.message, /carol: held by sprint 'sprint-xyz'/);
        assert.match(res.message, /member_reservation \{"member_name":"carol","action":"force_release"\}/);
        assert.match(res.message, /\/api\/reservations\/sprint-xyz\/force-release/);
        assert.doesNotMatch(res.message, /alice/);
    });
});
