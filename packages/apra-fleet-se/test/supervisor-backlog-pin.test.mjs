// POST /api/sprints backlog hard pin (createSprintController's launch() with
// a backlog-member handle, src/supervisor/backlog-member.mjs): inject,
// accept (both spellings), 400 on a different member, 503 when the fleet
// member list is unavailable or the handle is degraded. Fake ledger,
// spawner, listMembers and handle -- no processes, sockets or fleet server.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createSprintController, ApiError } from '../src/supervisor/api.mjs';
import { markFleetMembersUnavailable } from '../src/supervisor/fleet-members.mjs';

const SUPERVISOR_MEMBER = 'backlog-toyBacklog';

function readyHandle(name = SUPERVISOR_MEMBER) {
    return { get: () => ({ member: { name }, status: 'ready', reason: null }) };
}

function memoryLedger() {
    const claims = [];
    return {
        claims,
        list: () => [],
        get: () => undefined,
        claim: async (id, r) => { claims.push({ id, ...r }); return r; },
        getScopeFreshness: () => null,
    };
}

// The supervisor member is unreservable in the fleet list, exactly as the
// ensure step leaves it -- so it never enters the reserved member union.
const FLEET = {
    members: [
        { name: SUPERVISOR_MEMBER, type: 'local', llmProvider: 'none', unreservable: true, tags: ['backlog'] },
        { name: 'toy-doer', type: 'local', llmProvider: 'claude', unreservable: false },
        { name: 'other-backlog', type: 'local', llmProvider: 'none', unreservable: true },
    ],
};

function setup({ handle = readyHandle(), listMembers = async () => FLEET } = {}) {
    const spawned = [];
    const ledger = memoryLedger();
    const controller = createSprintController({
        ledger,
        spawner: { spawnSprint: async (opts) => { spawned.push(opts); return { pid: 4242, port: 5151 }; } },
        listMembers,
        backlogMember: handle,
        getBuildVersion: () => null,
    });
    return { controller, spawned, ledger };
}

const BASE = { issue: 'gh-toy-4ef', branch: 'smoke-1', base: 'main', members: ['toy-doer'], maxCycles: 1 };

describe('POST /api/sprints backlog hard pin', () => {
    test('inject: no roleMap -> the child receives roleMap.backlog = [supervisor member]', async () => {
        const { controller, spawned, ledger } = setup();
        const out = await controller.launch({ ...BASE });
        assert.equal(spawned.length, 1);
        assert.deepEqual(spawned[0].roleMap, { backlog: [SUPERVISOR_MEMBER] });
        assert.deepEqual(out.warnings, []);
        assert.deepEqual(ledger.claims[0].members, ['toy-doer'], 'the unreservable supervisor member is never reserved');
    });

    test('inject alongside other roles: roleMap with only doer keeps doer unchanged and gains backlog', async () => {
        const { controller, spawned } = setup();
        await controller.launch({ ...BASE, roleMap: { doer: ['toy-doer'] } });
        assert.equal(spawned.length, 1);
        assert.deepEqual(spawned[0].roleMap, { doer: ['toy-doer'], backlog: [SUPERVISOR_MEMBER] });
    });

    test('inject also when roleMap arrives as a JSON string', async () => {
        const { controller, spawned } = setup();
        await controller.launch({ ...BASE, roleMap: JSON.stringify({ reviewer: ['toy-doer'] }) });
        assert.deepEqual(spawned[0].roleMap, { reviewer: ['toy-doer'], backlog: [SUPERVISOR_MEMBER] });
    });

    test('accept: roleMap.backlog = [supervisor member] spawns unchanged', async () => {
        const { controller, spawned } = setup();
        const out = await controller.launch({ ...BASE, roleMap: { backlog: [SUPERVISOR_MEMBER] } });
        assert.equal(spawned.length, 1);
        assert.deepEqual(spawned[0].roleMap, { backlog: [SUPERVISOR_MEMBER] });
        assert.deepEqual(out.warnings, []);
    });

    test('accept: the deprecated orchestrator alias naming the supervisor member spawns, alias warning still surfaced, alias forwarded intact', async () => {
        const { controller, spawned } = setup();
        const out = await controller.launch({ ...BASE, roleMap: { Orchestrator: [SUPERVISOR_MEMBER] } });
        assert.equal(spawned.length, 1);
        assert.deepEqual(spawned[0].roleMap, { orchestrator: [SUPERVISOR_MEMBER] }, 'no second backlog key is added next to the alias');
        assert.equal(out.warnings.length, 1);
        assert.match(out.warnings[0], /roleMap.orchestrator/);
    });

    for (const [label, roleMap] of [
        ['backlog naming a different member', { backlog: ['other-backlog'] }],
        ['the alias naming a different member', { orchestrator: ['other-backlog'] }],
        ['backlog listing the supervisor member plus another', { backlog: [SUPERVISOR_MEMBER, 'other-backlog'] }],
    ]) {
        test(`mismatch (${label}) -> 400 on field roleMap naming the supervisor member, nothing spawned`, async () => {
            const { controller, spawned, ledger } = setup();
            await assert.rejects(controller.launch({ ...BASE, roleMap }), (err) => {
                assert.ok(err instanceof ApiError);
                assert.equal(err.status, 400);
                assert.equal(err.field, 'roleMap');
                assert.ok(err.message.includes(`'${SUPERVISOR_MEMBER}'`), err.message);
                return true;
            });
            assert.equal(spawned.length, 0);
            assert.equal(ledger.claims.length, 0);
        });
    }

    test('member list unavailable (the listFleetMembers marker) -> 503 "cannot verify backlog member", nothing spawned', async () => {
        const { controller, spawned, ledger } = setup({
            listMembers: async () => markFleetMembersUnavailable({ members: [] }, 'no reachable fleet HTTP singleton (test)'),
        });
        await assert.rejects(controller.launch({ ...BASE }), (err) => {
            assert.ok(err instanceof ApiError);
            assert.equal(err.status, 503);
            assert.match(err.message, /cannot verify backlog member/);
            assert.match(err.message, /no reachable fleet HTTP singleton/);
            return true;
        });
        assert.equal(spawned.length, 0);
        assert.equal(ledger.claims.length, 0);
    });

    test('member list read throwing -> the same 503, nothing spawned', async () => {
        const { controller, spawned } = setup({ listMembers: async () => { throw new Error('socket hang up'); } });
        await assert.rejects(controller.launch({ ...BASE }),
            (err) => err instanceof ApiError && err.status === 503 && /cannot verify backlog member/.test(err.message));
        assert.equal(spawned.length, 0);
    });

    test('degraded handle -> 503 carrying its reason, nothing spawned, member list never read', async () => {
        let listed = 0;
        const reason = 'fleet member list unavailable: no reachable fleet HTTP singleton (test)';
        const { controller, spawned } = setup({
            handle: { get: () => ({ member: null, status: 'degraded', reason }) },
            listMembers: async () => { listed += 1; return FLEET; },
        });
        await assert.rejects(controller.launch({ ...BASE }),
            (err) => err instanceof ApiError && err.status === 503 && err.message.includes(reason));
        assert.equal(spawned.length, 0);
        assert.equal(listed, 0);
    });

    test('request-shape errors still win over the pin (400 on the bad field, not 503)', async () => {
        const { controller } = setup({ handle: { get: () => ({ member: null, status: 'degraded', reason: 'x' }) } });
        await assert.rejects(controller.launch({ ...BASE, branch: 'bad branch' }),
            (err) => err instanceof ApiError && err.status === 400 && err.field === 'branch');
    });

    test('a controller built without the handle keeps the unpinned behaviour (no injection, any backlog member accepted)', async () => {
        const spawned = [];
        const controller = createSprintController({
            ledger: memoryLedger(),
            spawner: { spawnSprint: async (opts) => { spawned.push(opts); return { pid: 1, port: 2 }; } },
            listMembers: async () => markFleetMembersUnavailable({ members: [] }, 'down'),
            getBuildVersion: () => null,
        });
        await controller.launch({ ...BASE });
        await controller.launch({ ...BASE, branch: 'smoke-2', roleMap: { backlog: ['other-backlog'] } });
        assert.equal(spawned[0].roleMap, undefined);
        assert.deepEqual(spawned[1].roleMap, { backlog: ['other-backlog'] });
    });
});
