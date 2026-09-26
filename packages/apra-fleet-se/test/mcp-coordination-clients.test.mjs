import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
    createMcpDoltPushMutexClient,
    createMcpChildIdAllocatorClient,
} from '../fleet-sprint/runner.js';

// apra-fleet-f34.2: unit coverage for the MCP-transport dolt-mutex / child-id
// allocator clients used by the SUPERVISOR-LESS (standalone CLI) launch path.
//
// The supervisor HTTP clients need `--service-url`, which a standalone launch
// never has; these clients instead speak the fleet MCP server's own
// `dolt_push_mutex` / `child_id_allocator` tools over the already-connected
// mcpClient. Both tools answer with a JSON STRING inside the standard MCP
// content[] envelope, so these tests use that exact shape.

const envelope = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

describe('createMcpDoltPushMutexClient (apra-fleet-f34.2)', () => {
    test('acquire returns the token when granted on the first call', async () => {
        const calls = [];
        const client = createMcpDoltPushMutexClient({
            sprintId: 'feat/x',
            callTool: async (name, args) => {
                calls.push({ name, args });
                return envelope({ granted: true, ticket: 't1', token: 'tok-1', expiresAt: 123 });
            },
        });
        const grant = await client.acquire('feat/x', { pid: 4321 });
        assert.equal(grant.token, 'tok-1');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].name, 'dolt_push_mutex');
        assert.equal(calls[0].args.action, 'acquire');
        assert.equal(calls[0].args.sprint_id, 'feat/x');
        assert.equal(calls[0].args.pid, 4321);
    });

    test('acquire re-polls the SAME ticket until granted (waiter keeps its FIFO slot)', async () => {
        const calls = [];
        let polls = 0;
        const client = createMcpDoltPushMutexClient({
            sprintId: 'feat/x',
            waitMs: 1,
            callTool: async (name, args) => {
                calls.push(args);
                if (args.action === 'acquire') return envelope({ granted: false, ticket: 'ticket-9' });
                polls += 1;
                return polls < 3
                    ? envelope({ granted: false, ticket: args.ticket })
                    : envelope({ granted: true, ticket: args.ticket, token: 'tok-9', expiresAt: 5 });
            },
        });

        const grant = await client.acquire('feat/x', { pid: 7 });
        assert.equal(grant.token, 'tok-9');
        // Exactly one acquire; every subsequent call is a poll of that ticket.
        assert.equal(calls.filter((c) => c.action === 'acquire').length, 1);
        assert.ok(calls.filter((c) => c.action === 'poll').length >= 1);
        for (const c of calls.filter((c) => c.action === 'poll')) {
            assert.equal(c.ticket, 'ticket-9');
        }
    });

    test('acquire gives up (and cancels its ticket) after the overall timeout', async () => {
        const calls = [];
        const client = createMcpDoltPushMutexClient({
            sprintId: 'feat/x',
            waitMs: 1,
            timeoutMs: 1,
            callTool: async (name, args) => {
                calls.push(args);
                return envelope({ granted: false, ticket: 'ticket-slow' });
            },
        });
        await assert.rejects(() => client.acquire('feat/x'), /timed out/i);
        assert.ok(calls.some((c) => c.action === 'cancel' && c.ticket === 'ticket-slow'));
    });

    test('release posts the token and is non-fatal when the call fails', async () => {
        const seen = [];
        const ok = createMcpDoltPushMutexClient({
            sprintId: 'feat/x',
            callTool: async (name, args) => { seen.push(args); return envelope({ released: true }); },
        });
        assert.equal(await ok.release('tok-1'), true);
        assert.deepEqual(seen[0], { action: 'release', token: 'tok-1' });

        const logs = [];
        const broken = createMcpDoltPushMutexClient({
            sprintId: 'feat/x',
            log: (m) => logs.push(m),
            callTool: async () => { throw new Error('transport down'); },
        });
        assert.equal(await broken.release('tok-1'), false);
        assert.ok(logs.some((m) => m.includes('release failed')));

        // A null token (no-op client upstream) never calls the tool at all.
        assert.equal(await ok.release(null), true);
    });

    test('a tool-level error payload is surfaced as a thrown error', async () => {
        const client = createMcpDoltPushMutexClient({
            sprintId: 'feat/x',
            callTool: async () => envelope({ error: 'sprint_id is required for action "acquire"' }),
        });
        await assert.rejects(() => client.acquire('feat/x'), /sprint_id is required/);
    });
});

describe('createMcpChildIdAllocatorClient (apra-fleet-f34.2)', () => {
    test('allocate forwards parent/pid/sprint/floor and returns the minted child id', async () => {
        const calls = [];
        const client = createMcpChildIdAllocatorClient({
            sprintId: 'feat/x',
            callTool: async (name, args) => {
                calls.push({ name, args });
                return envelope({ status: 'allocated', childId: 'apra-fleet-p.4', seq: 4, token: 'res-1', expiresAt: 9 });
            },
        });
        const grant = await client.allocate('apra-fleet-p', { pid: 4321, floor: 3 });
        assert.equal(grant.childId, 'apra-fleet-p.4');
        assert.equal(grant.token, 'res-1');
        assert.equal(calls[0].name, 'child_id_allocator');
        assert.deepEqual(calls[0].args, {
            action: 'allocate',
            parent_id: 'apra-fleet-p',
            pid: 4321,
            sprint_id: 'feat/x',
            floor: 3,
        });
    });

    test('confirm/release forward the token and stay non-fatal on failure', async () => {
        const seen = [];
        const client = createMcpChildIdAllocatorClient({
            sprintId: 'feat/x',
            callTool: async (name, args) => {
                seen.push(args);
                return envelope(args.action === 'confirm' ? { confirmed: true } : { released: true });
            },
        });
        assert.equal(await client.confirm('res-1'), true);
        assert.equal(await client.release('res-1'), true);
        assert.deepEqual(seen, [
            { action: 'confirm', token: 'res-1' },
            { action: 'release', token: 'res-1' },
        ]);

        const logs = [];
        const broken = createMcpChildIdAllocatorClient({
            sprintId: 'feat/x',
            log: (m) => logs.push(m),
            callTool: async () => { throw new Error('transport down'); },
        });
        assert.equal(await broken.confirm('res-1'), false);
        assert.equal(await broken.release('res-1'), false);
        assert.equal(logs.length, 2);

        // Null tokens short-circuit (uniform call sites with the no-op client).
        assert.equal(await client.confirm(null), true);
        assert.equal(await client.release(null), true);
    });

    test('a non-JSON tool response is reported as such', async () => {
        const client = createMcpChildIdAllocatorClient({
            sprintId: 'feat/x',
            callTool: async () => 'not json at all',
        });
        await assert.rejects(() => client.allocate('apra-fleet-p'), /non-JSON response/);
    });
});
