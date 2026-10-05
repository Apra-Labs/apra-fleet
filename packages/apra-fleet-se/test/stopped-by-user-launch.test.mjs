// A fleet server stopped on purpose ('apra-fleet stop') must make sprint
// launches fail fast with the client's actionable message -- in the
// supervisor's POST /api/sprints response and on a sprint child's stderr --
// never a generic "fleet unavailable" or a stack trace in a log only.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createSprintController, ApiError } from '../src/supervisor/api.mjs';
import { listFleetMembers, fleetMembersStoppedByUserReason, fleetMembersUnavailableReason } from '../src/supervisor/fleet-members.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MSG = "apra-fleet was stopped by the user at 2026-10-03T10:00:00.000Z (alice, via 'apra-fleet stop'); run 'apra-fleet start' to start it again.";

function stoppedErr() {
    return Object.assign(new Error(MSG), { code: 'SERVER_STOPPED_BY_USER' });
}

describe("supervisor: server stopped with 'apra-fleet stop'", () => {
    test('listFleetMembers carries the stop message (and stays "unavailable")', async () => {
        const res = await listFleetMembers({ resolveConnection: async () => { throw stoppedErr(); }, logger: { error: () => {} } });
        assert.deepEqual(res, { members: [] });
        assert.equal(fleetMembersStoppedByUserReason(res), MSG);
        assert.ok(fleetMembersUnavailableReason(res));
        const other = await listFleetMembers({ resolveConnection: async () => { throw new Error('boom'); }, logger: { error: () => {} } });
        assert.equal(fleetMembersStoppedByUserReason(other), null);
    });

    test('POST /api/sprints refuses with 503 and the stop message; nothing is spawned', async () => {
        const spawned = [];
        const controller = createSprintController({
            ledger: { list: () => [], get: () => undefined, claim: async (_id, r) => r, getScopeFreshness: () => null },
            spawner: { spawnSprint: async (o) => { spawned.push(o); return { pid: 1, port: 2 }; } },
            listMembers: () => listFleetMembers({ resolveConnection: async () => { throw stoppedErr(); }, logger: { error: () => {} } }),
            getBuildVersion: () => null,
        });
        await assert.rejects(
            controller.launch({ issue: 'gh-toy-1', branch: 'b', base: 'main', members: ['toy-doer'], maxCycles: 1 }),
            (err) => err instanceof ApiError && err.status === 503 && err.message === MSG,
        );
        assert.equal(spawned.length, 0);
    });
});

describe("sprint child (bin/cli.mjs): server stopped with 'apra-fleet stop'", () => {
    test('fails fast at connect with the stop message on stderr, exit 1', () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cli-stopped-'));
        try {
            fs.writeFileSync(path.join(dataDir, 'stopped-by-user.json'),
                JSON.stringify({ stoppedAt: '2026-10-03T10:00:00.000Z', by: 'apra-fleet stop', user: 'alice' }));
            const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
            // NODE_TEST_CONTEXT would make cli.mjs skip main() (its test-load guard).
            for (const k of ['APRA_FLEET_TRANSPORT', 'APRA_FLEET_SERVER_CMD', 'APRA_FLEET_SERVER_BIN', 'NODE_TEST_CONTEXT']) delete env[k];
            const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'cli.mjs'),
                '--issue', 'gh-toy-1', '--members', 'toy-doer', '--branch', 'b', '--base', 'main'], {
                env, encoding: 'utf8', timeout: 60_000, windowsHide: true,
            });
            assert.equal(r.status, 1, r.stderr);
            assert.match(r.stderr, /^Error: apra-fleet was stopped by the user at 2026-10-03T10:00:00\.000Z .*run 'apra-fleet start'/m);
            assert.doesNotMatch(r.stderr, /^\s+at .+:\d+:\d+/m, 'no stack trace');
        } finally {
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });
});
