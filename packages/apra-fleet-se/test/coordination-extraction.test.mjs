import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// apra-fleet-3swo.4.3: coordination.mjs owns the dolt-push-mutex clients, the
// child-id-allocator clients and the member-reservation-ledger client,
// extracted move-only out of runner.js. Imported directly from
// coordination.mjs (not the runner.js facade) so this suite proves the new
// module -- not just runner.js's re-export -- actually holds the
// implementation.
import {
    createHttpDoltPushMutexClient,
    createHttpChildIdAllocatorClient,
    createMcpDoltPushMutexClient,
    createMcpChildIdAllocatorClient,
    createMemberReservationClient,
} from '../fleet-sprint/coordination.mjs';
// Same symbols, resolved through the runner.js facade -- must be the exact
// same function objects (re-exported, not re-implemented).
import * as runner from '../fleet-sprint/runner.js';

describe('coordination.mjs is the single source of truth runner.js re-exports (apra-fleet-3swo.4.3)', () => {
    test('runner.js re-exports the identical function objects, not copies', () => {
        assert.equal(runner.createHttpDoltPushMutexClient, createHttpDoltPushMutexClient);
        assert.equal(runner.createHttpChildIdAllocatorClient, createHttpChildIdAllocatorClient);
        assert.equal(runner.createMcpDoltPushMutexClient, createMcpDoltPushMutexClient);
        assert.equal(runner.createMcpChildIdAllocatorClient, createMcpChildIdAllocatorClient);
        assert.equal(runner.createMemberReservationClient, createMemberReservationClient);
    });
});

describe('constructor error messages are byte-identical to the pre-move text (apra-fleet-3swo.4.3)', () => {
    test('createHttpDoltPushMutexClient requires a serviceUrl', () => {
        assert.throws(
            () => createHttpDoltPushMutexClient({}),
            { message: 'createHttpDoltPushMutexClient requires a serviceUrl' },
        );
    });

    test('createHttpDoltPushMutexClient requires a fetch implementation', () => {
        // `opts.fetch ?? globalThis.fetch` only falls back on a NULLISH
        // opts.fetch, so a present-but-non-function value (not null/undefined)
        // is what actually exercises the typeof guard on a Node >=18 runtime
        // where globalThis.fetch always exists.
        assert.throws(
            () => createHttpDoltPushMutexClient({ serviceUrl: 'http://x', fetch: 'not-a-function' }),
            { message: 'createHttpDoltPushMutexClient requires a fetch implementation (Node >=18 global fetch or an injected one)' },
        );
    });

    test('createMcpDoltPushMutexClient requires a callTool function', () => {
        assert.throws(
            () => createMcpDoltPushMutexClient({}),
            { message: 'createMcpDoltPushMutexClient requires a callTool function' },
        );
    });
});

describe('sprintMutexId flows through every coordination client verbatim -- unmodified, unprefixed, unreformatted (apra-fleet-3swo.4.3)', () => {
    // A deliberately "ugly" fixed input: mixed case, a slash (real sprint
    // branches look like this) and characters that WOULD change shape under
    // any accidental reformat/namespace/prefix step.
    const FIXED_SPRINT_ID = 'feat/Runner-Refactor_2026';

    test('createHttpDoltPushMutexClient sends the fixed sprintId, percent-encoded but otherwise untouched, on acquire/release/renew', async () => {
        const calls = [];
        const fetchImpl = async (url, opts) => {
            calls.push({ url, body: JSON.parse(opts.body) });
            return { ok: true, status: 200, json: async () => ({ token: 'tok', granted: true, released: true, renewed: true }) };
        };
        const client = createHttpDoltPushMutexClient({ serviceUrl: 'http://svc', sprintId: FIXED_SPRINT_ID, fetch: fetchImpl });
        await client.acquire(FIXED_SPRINT_ID, { pid: 123 });
        await client.release('tok');
        await client.renew('tok');

        const expectedEncoded = encodeURIComponent(FIXED_SPRINT_ID);
        assert.equal(calls.length, 3);
        for (const call of calls) {
            assert.ok(
                call.url.includes(`/api/dolt-push-mutex/${expectedEncoded}/`),
                `expected the exact percent-encoded fixed sprintId in the URL, got: ${call.url}`,
            );
        }
    });

    test('createMcpDoltPushMutexClient sends the fixed sprintId verbatim as sprint_id', async () => {
        const calls = [];
        const callTool = async (name, args) => {
            calls.push({ name, args });
            return { content: [{ type: 'text', text: JSON.stringify({ granted: true, token: 'tok' }) }] };
        };
        const client = createMcpDoltPushMutexClient({ callTool });
        await client.acquire(FIXED_SPRINT_ID, { pid: 1 });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].args.sprint_id, FIXED_SPRINT_ID, 'sprint_id must be the exact fixed input, unmodified');
    });

    test('createHttpChildIdAllocatorClient sends the fixed sprintId verbatim on allocate', async () => {
        const calls = [];
        const fetchImpl = async (url, opts) => {
            calls.push({ url, body: JSON.parse(opts.body) });
            return { ok: true, status: 200, json: async () => ({ childId: 'apra-fleet-x.1', seq: 1, token: 'tok' }) };
        };
        const client = createHttpChildIdAllocatorClient({ serviceUrl: 'http://svc', sprintId: FIXED_SPRINT_ID, fetch: fetchImpl });
        await client.allocate('apra-fleet-x');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].body.sprintId, FIXED_SPRINT_ID, 'sprintId must be the exact fixed input, unmodified');
    });

    test('createMcpChildIdAllocatorClient sends the fixed sprintId verbatim as sprint_id', async () => {
        const calls = [];
        const callTool = async (name, args) => {
            calls.push({ name, args });
            return { content: [{ type: 'text', text: JSON.stringify({ childId: 'apra-fleet-x.1', seq: 1, token: 'tok' }) }] };
        };
        const client = createMcpChildIdAllocatorClient({ callTool, sprintId: FIXED_SPRINT_ID });
        await client.allocate('apra-fleet-x');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].args.sprint_id, FIXED_SPRINT_ID, 'sprint_id must be the exact fixed input, unmodified');
    });

    test('createMemberReservationClient sends the fixed sprintId verbatim as sprint_id on reserve/release', async () => {
        const calls = [];
        const callTool = async (name, args) => {
            calls.push({ name, args });
            return { content: [{ text: '[+] ok' }] };
        };
        const client = createMemberReservationClient({ callTool, members: ['solo'], sprintId: FIXED_SPRINT_ID });
        await client.reserveAll();
        await client.releaseAll();
        assert.equal(calls.length, 2);
        for (const call of calls) {
            assert.equal(call.args.sprint_id, FIXED_SPRINT_ID, 'sprint_id must be the exact fixed input, unmodified');
        }
    });
});
