import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { listFleetMembers } from '../src/supervisor/fleet-members.mjs';
import { StreamableHttpTransport } from '@apralabs/apra-fleet-client/transport';
import { ApraFleet } from '@apralabs/apra-fleet-client';

// apra-fleet-eft.4.8.7 -- unit coverage for the supervisor's
// listFleetMembers() helper (added in b477bf55, imported only by
// bin/serve.mjs, previously untested). See src/supervisor/fleet-members.mjs
// for the full contract this pins: a short-lived MCP connection that must
// NEVER throw, degrading to { members: [] } on any resolution/connection/
// parse failure instead of taking its GET /api/members caller down.
//
// listFleetMembers() only accepts one injectable collaborator
// (resolveConnection); the StreamableHttpTransport/McpClient/ApraFleet
// chain it constructs internally is not itself parameterized. Branches (1)
// and (2) below only need to stub resolveConnection. Branches (3) and (4)
// need to exercise real transport/client construction without touching the
// network or a real fleet server -- this test does that by mocking the
// exact two prototype methods listFleetMembers() actually calls
// (StreamableHttpTransport.prototype.start/.stop and
// ApraFleet.prototype.listMembers) via node:test's built-in t.mock.method,
// which is stable (no --experimental-test-module-mocks flag needed, unlike
// mock.module()) and auto-restores after each test. The real classes are
// otherwise used unmodified, so their harmless (no-I/O) constructor/event-
// wiring behavior is exercised for real.

describe('listFleetMembers (apra-fleet-eft.4.8.7)', () => {
    test('branch 1: resolveConnection() throwing resolves to { members: [] }', async () => {
        const result = await listFleetMembers({
            resolveConnection: async () => {
                throw new Error('boom: cannot resolve fleet server connection');
            },
            logger: { error: () => {} },
        });
        assert.deepEqual(result, { members: [] });
    });

    test('branch 2: a non-"http" connection mode resolves to { members: [] } without constructing a transport', async (t) => {
        const startMock = t.mock.method(StreamableHttpTransport.prototype, 'start', async () => {});
        const result = await listFleetMembers({
            resolveConnection: async () => ({ mode: 'stdio', reason: 'no reachable HTTP singleton' }),
            logger: { error: () => {} },
        });
        assert.deepEqual(result, { members: [] });
        assert.equal(startMock.mock.callCount(), 0);
    });

    test('branch 2b: a missing connection (falsy) also resolves to { members: [] }', async () => {
        const result = await listFleetMembers({
            resolveConnection: async () => undefined,
            logger: { error: () => {} },
        });
        assert.deepEqual(result, { members: [] });
    });

    test('branch 3: a successful list response is parsed into { members: [...] } with the expected shape, and transport.stop() runs', async (t) => {
        const startMock = t.mock.method(StreamableHttpTransport.prototype, 'start', async () => {});
        const stopMock = t.mock.method(StreamableHttpTransport.prototype, 'stop', function stop() { /* no-op stub */ });
        const expectedMembers = [
            { id: 'member-a', status: 'idle' },
            { id: 'member-b', status: 'busy' },
        ];
        const listMembersMock = t.mock.method(ApraFleet.prototype, 'listMembers', async (options) => {
            assert.deepEqual(options, { format: 'json' });
            return {
                content: [{ type: 'text', text: JSON.stringify({ members: expectedMembers }) }],
            };
        });

        const result = await listFleetMembers({
            resolveConnection: async () => ({ mode: 'http', url: 'http://127.0.0.1:9451/mcp' }),
            logger: { error: () => {} },
        });

        assert.deepEqual(result, { members: expectedMembers });
        assert.equal(startMock.mock.callCount(), 1);
        assert.equal(listMembersMock.mock.callCount(), 1);
        assert.equal(stopMock.mock.callCount(), 1);
    });

    test('branch 4a: a transport start failure resolves to { members: [] } while still best-effort calling transport.stop()', async (t) => {
        t.mock.method(StreamableHttpTransport.prototype, 'start', async () => {
            throw new Error('simulated transport start failure (no real network)');
        });
        const stopMock = t.mock.method(StreamableHttpTransport.prototype, 'stop', function stop() { /* no-op stub */ });
        const listMembersMock = t.mock.method(ApraFleet.prototype, 'listMembers', async () => {
            throw new Error('listMembers must not be reached when transport.start() failed');
        });

        const result = await listFleetMembers({
            resolveConnection: async () => ({ mode: 'http', url: 'http://127.0.0.1:9451/mcp' }),
            logger: { error: () => {} },
        });

        assert.deepEqual(result, { members: [] });
        assert.equal(listMembersMock.mock.callCount(), 0);
        assert.equal(stopMock.mock.callCount(), 1);
    });

    test('branch 4b: an unparseable list response resolves to { members: [] } while still best-effort calling transport.stop()', async (t) => {
        t.mock.method(StreamableHttpTransport.prototype, 'start', async () => {});
        const stopMock = t.mock.method(StreamableHttpTransport.prototype, 'stop', function stop() { /* no-op stub */ });
        t.mock.method(ApraFleet.prototype, 'listMembers', async () => ({
            content: [{ type: 'text', text: 'not valid json' }],
        }));

        const result = await listFleetMembers({
            resolveConnection: async () => ({ mode: 'http', url: 'http://127.0.0.1:9451/mcp' }),
            logger: { error: () => {} },
        });

        assert.deepEqual(result, { members: [] });
        assert.equal(stopMock.mock.callCount(), 1);
    });

    test('branch 4c: even a failure inside transport.stop() itself is swallowed (best-effort teardown, never throws)', async (t) => {
        t.mock.method(StreamableHttpTransport.prototype, 'start', async () => {});
        t.mock.method(StreamableHttpTransport.prototype, 'stop', function stop() {
            throw new Error('simulated teardown failure');
        });
        t.mock.method(ApraFleet.prototype, 'listMembers', async () => ({
            content: [{ type: 'text', text: JSON.stringify({ members: [] }) }],
        }));

        const result = await listFleetMembers({
            resolveConnection: async () => ({ mode: 'http', url: 'http://127.0.0.1:9451/mcp' }),
            logger: { error: () => {} },
        });

        assert.deepEqual(result, { members: [] });
    });

    test('requires a resolveConnection() collaborator (fails loud on a wiring mistake rather than silently returning empty)', async () => {
        await assert.rejects(
            () => listFleetMembers({}),
            (err) => {
                assert.ok(err instanceof TypeError);
                assert.match(err.message, /resolveConnection/);
                return true;
            },
        );
    });
});
