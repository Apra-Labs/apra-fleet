import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { listFleetMembers, fleetMembersUnavailableReason } from '../src/supervisor/fleet-members.mjs';
import { ensureBacklogMember, BACKLOG_STATUS } from '../src/supervisor/backlog-member.mjs';
import { StreamableHttpTransport } from '@apralabs/apra-fleet-client/transport';
import { ApraFleet } from '@apralabs/apra-fleet-client';

// Carry-over regression guard (recurrence of an earlier closed fix): a fleet
// with an EMPTY registry answers list_members {format:'json'} with the
// tool-registry wrapper's shape -- a user-audience <apra-fleet-display> item
// FIRST, then the JSON envelope (total 0, members []). The real
// listFleetMembers() parse path and the real ensureBacklogMember() must treat
// that as a valid empty list: no parse error log, no unavailable marker, and
// the backlog member goes ready on the first attempt (no 30s retry), so
// POST /api/sprints is not refused with 503 "fleet member list unavailable".
// The list_members json early-return half is pinned by tests/list-members.test.ts.

const EMPTY_JSON = JSON.stringify({ server_version: 'test', total: 0, members: [] });
const WRAPPED = {
    content: [
        { type: 'text', text: '<apra-fleet-display>\nwelcome\n</apra-fleet-display>', annotations: { audience: ['user'], priority: 1 } },
        { type: 'text', text: EMPTY_JSON },
    ],
};

describe('supervisor boot against an empty fleet registry', () => {
    test('listFleetMembers parses the wrapped empty registry, no error log, not marked unavailable', async (t) => {
        t.mock.method(StreamableHttpTransport.prototype, 'start', async () => {});
        t.mock.method(StreamableHttpTransport.prototype, 'stop', function stop() {});
        t.mock.method(ApraFleet.prototype, 'listMembers', async () => WRAPPED);
        const errors = [];
        const result = await listFleetMembers({
            resolveConnection: async () => ({ mode: 'http', url: 'http://127.0.0.1:9451/mcp' }),
            logger: { error: (...a) => errors.push(a) },
        });
        assert.deepEqual(result.members, []);
        assert.equal(errors.length, 0, `unexpected error logs: ${JSON.stringify(errors)}`);
        assert.equal(fleetMembersUnavailableReason(result), null);
    });

    test('backlog member is ready immediately (no retry wait) so launch is not refused with 503', async (t) => {
        t.mock.method(StreamableHttpTransport.prototype, 'start', async () => {});
        t.mock.method(StreamableHttpTransport.prototype, 'stop', function stop() {});
        t.mock.method(ApraFleet.prototype, 'listMembers', async () => WRAPPED);
        const registered = [];
        const logs = [];
        const logger = { log: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a) };
        const scheduled = [];
        const resolveConnection = async () => ({ mode: 'http', url: 'http://127.0.0.1:9451/mcp' });
        const bm = await ensureBacklogMember({
            beadsDir: process.platform === 'win32' ? 'C:\proj\demo' : '/proj/demo',
            listMembers: () => listFleetMembers({ resolveConnection, logger }),
            registerMember: async (o) => { registered.push(o); return { ok: true }; },
            updateMember: async () => ({ ok: true }),
            logger,
            scheduler: { setTimeout: (...a) => { scheduled.push(a); return null; }, clearTimeout: () => {} },
        });
        const st = bm.get();
        assert.equal(st.status, BACKLOG_STATUS.READY, `degraded: ${st.reason}`);
        assert.equal(scheduled.length, 0, 'no degraded retry may be scheduled');
        assert.equal(logs.filter((l) => String(l[0]).includes('failed to list fleet members')).length, 0);
        bm.stop();
    });
});
