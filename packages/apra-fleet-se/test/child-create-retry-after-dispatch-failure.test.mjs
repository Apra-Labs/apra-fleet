import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createChildBeadWithAllocatedId } from '../fleet-sprint/runner.js';
import { CHILD_CREATE_MAX_ATTEMPTS } from '../fleet-sprint/beads-children.mjs';
import { createIdAllocator } from '../src/supervisor/id-allocator.mjs';

// GitHub #615: once `bd create --id` has been DISPATCHED, a failure must not
// return the id to the allocator's pool (bd refuses a duplicate --id, so the
// id is occupied; re-pooling it made it re-minted every round and across
// sprints). The id stays consumed and the create retries with a fresh id,
// bounded. Only a failure BEFORE dispatch (staging the body) releases.
//
// Driven against the REAL supervisor allocator so "never re-minted" is
// observed on the allocator's own state, not on a test double.

const STAGED_PATH = '/tmp/staged-body.txt';

function makeCommand({ occupied = new Set(), stageFails = false, createAlwaysFails = false } = {}) {
    const calls = [];
    const created = new Set();
    const command = async (cmd) => {
        calls.push(cmd);
        if (/^node -e "/.test(cmd)) {
            if (stageFails) throw new Error('simulated staging fault');
            return STAGED_PATH;
        }
        const show = cmd.match(/^bd show (\S+) --json$/);
        if (show) {
            // The pre-create probe reports free (as observed in the field):
            // only the create itself discovers the occupant.
            const err = new Error('Exit code 1: {"error": "no issues found matching the provided IDs", "schema_version": 1}');
            throw err;
        }
        const create = cmd.match(/^bd create .* --id (\S+) --silent$/);
        if (create) {
            const id = create[1];
            if (createAlwaysFails) throw new Error(`simulated transport fault creating ${id}`);
            if (occupied.has(id) || created.has(id)) {
                throw new Error(`Exit code 1: Error: issue ${id} already exists`);
            }
            created.add(id);
            return '';
        }
        if (/^bd update \S+ --parent \S+$/.test(cmd)) return '';
        throw new Error(`unexpected command: ${cmd}`);
    };
    return { command, calls, created };
}

let dir;
let alloc;
beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'child-create-retry-'));
    alloc = createIdAllocator({ dataDir: dir, leaseMs: 100_000 });
    await alloc.start();
});
afterEach(async () => {
    await alloc.stop();
    await rm(dir, { recursive: true, force: true });
});

function baseOpts(command, logs, extra = {}) {
    return {
        command, allocator: alloc, member: 'local',
        title: 'Follow-up task', description: 'Body.', priority: 'P2',
        parentId: 'par-1', log: (m) => logs.push(m), ...extra,
    };
}

describe('createChildBeadWithAllocatedId -- dispatched create failures consume the id and retry', () => {
    test('bd refusing a duplicate id: the occupied id is consumed (never re-pooled) and a fresh id is created', async () => {
        const { command, calls, created } = makeCommand({ occupied: new Set(['par-1.1']) });
        const logs = [];

        const res = await createChildBeadWithAllocatedId(baseOpts(command, logs));

        assert.equal(res.childId, 'par-1.2');
        assert.deepEqual([...created], ['par-1.2']);
        assert.equal(calls.filter((c) => c.startsWith('bd create ')).length, 2);
        assert.equal(calls.filter((c) => c.startsWith('node -e ')).length, 1, 'the body is staged once and reused by the retry');
        const st = alloc.status().parents['par-1'];
        assert.deepEqual(st.free, [], 'the occupied id must not be back in the pool');
        assert.equal(st.reserved.length, 0);
        assert.ok(logs.some((l) => l.includes("bd create failed for 'par-1.1' (attempt 1/3)") && l.includes('retrying with a freshly allocated id')), JSON.stringify(logs));

        // A later allocation (next round / next sprint) never re-mints .1.
        const next = await alloc.allocate('par-1', { pid: process.pid });
        assert.equal(next.childId, 'par-1.3');
    });

    test('every attempt failing: bounded to CHILD_CREATE_MAX_ATTEMPTS, all ids consumed, error names them', async () => {
        assert.equal(CHILD_CREATE_MAX_ATTEMPTS, 3);
        const { command, calls } = makeCommand({ createAlwaysFails: true });
        const logs = [];

        await assert.rejects(
            () => createChildBeadWithAllocatedId(baseOpts(command, logs)),
            (err) => {
                assert.match(err.message, /failed on all 3 attempts/);
                assert.match(err.message, /par-1\.1, par-1\.2, par-1\.3/);
                assert.match(err.message, /simulated transport fault creating par-1\.3/);
                return true;
            },
        );
        assert.equal(calls.filter((c) => c.startsWith('bd create ')).length, 3);
        const st = alloc.status().parents['par-1'];
        assert.deepEqual(st.free, [], 'no dispatched id may return to the pool');
        assert.equal(st.reserved.length, 0);
        assert.equal(logs.filter((l) => l.includes('bd create failed for')).length, 3);
    });

    test('a staging failure (before bd create is dispatched) still releases the id for reuse', async () => {
        const { command, calls } = makeCommand({ stageFails: true });
        const logs = [];

        await assert.rejects(
            () => createChildBeadWithAllocatedId(baseOpts(command, logs)),
            /simulated staging fault/,
        );
        assert.equal(calls.filter((c) => c.startsWith('bd create ')).length, 0);
        assert.deepEqual(alloc.status().parents['par-1'].free, [1], 'the never-dispatched id goes back to the pool');
        assert.ok(logs.some((l) => l.includes('before bd create was dispatched')), JSON.stringify(logs));
    });

    test('maxAttempts: 1 throws the original create error unchanged', async () => {
        const { command } = makeCommand({ createAlwaysFails: true });
        await assert.rejects(
            () => createChildBeadWithAllocatedId(baseOpts(command, [], { maxAttempts: 1 })),
            (err) => err.message === 'simulated transport fault creating par-1.1',
        );
        assert.deepEqual(alloc.status().parents['par-1'].free, []);
    });
});
