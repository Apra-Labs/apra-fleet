import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createChildBeadWithAllocatedId, persistNewTaskBestEffort } from '../fleet-sprint/runner.js';
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

// A bd store whose `bd show` reflects real contents, so the pre-create probe
// SEES an occupant. `landThenError` makes the create write the row and then
// report a transport failure (the ambiguous landed-but-errored case).
// `storedDescription(staged)` lets a test model bd storing the body with its
// own whitespace (or a different body altogether).
function makeStoreCommand({ beads = [], landThenError = new Set(), storedDescription = (d) => d } = {}) {
    const store = new Map(beads.map((b) => [b.id, b]));
    const calls = [];
    let staged = '';
    const command = async (cmd) => {
        calls.push(cmd);
        if (/^node -e "/.test(cmd)) {
            const m = cmd.match(/"([A-Za-z0-9+/=]*)"\s*$/);
            staged = m ? Buffer.from(m[1], 'base64').toString('utf-8') : '';
            return STAGED_PATH;
        }
        const show = cmd.match(/^bd show (\S+) --json$/);
        if (show) {
            const b = store.get(show[1]);
            if (!b) throw new Error('Exit code 1: {"error": "no issues found matching the provided IDs", "schema_version": 1}');
            return JSON.stringify([b]);
        }
        const create = cmd.match(/^bd create "([^"]*)" .* --id (\S+) --silent$/);
        if (create) {
            const [, title, id] = create;
            if (store.has(id)) throw new Error(`Exit code 1: Error: issue ${id} already exists`);
            store.set(id, { id, title, description: storedDescription(staged), status: 'open' });
            if (landThenError.has(id)) throw new Error(`simulated transport fault after creating ${id}`);
            return '';
        }
        if (/^bd update \S+ --parent \S+$/.test(cmd)) return '';
        throw new Error(`unexpected command: ${cmd}`);
    };
    return { command, calls, store };
}

describe('createChildBeadWithAllocatedId -- review follow-ups (GitHub #615)', () => {
    test('a probe-PRESENT id is consumed, never re-pooled: three newTasks never all get refused at the same id', async () => {
        // An unlinked child the floor read misses (floor 0) occupies par-1.1.
        const { command } = makeStoreCommand({ beads: [{ id: 'par-1.1', title: 'Unlinked earlier child', status: 'open' }] });
        const ids = [];
        for (const title of ['Task A', 'Task B', 'Task C']) {
            const res = await createChildBeadWithAllocatedId(baseOpts(command, [], { title, floor: 0 }));
            ids.push(res.childId);
        }
        assert.deepEqual(ids, ['par-1.2', 'par-1.3', 'par-1.4']);
        const st = alloc.status().parents['par-1'];
        assert.deepEqual(st.free, [], 'the occupied par-1.1 must never be back in the pool');
        assert.equal(st.reserved.length, 0);
    });

    test('an UNKNOWN (unprobeable) id is consumed rather than released', async () => {
        let first = true;
        const { command: inner } = makeStoreCommand();
        const command = async (cmd, o) => {
            if (first && cmd === 'bd show par-1.1 --json') { first = false; throw new Error('transport blip'); }
            return inner(cmd, o);
        };
        const res = await createChildBeadWithAllocatedId(baseOpts(command, []));
        assert.equal(res.childId, 'par-1.2');
        assert.deepEqual(alloc.status().parents['par-1'].free, []);
    });

    test('a create that LANDED but reported failure is adopted (linked), not duplicated under a fresh id', async () => {
        const { command, calls, store } = makeStoreCommand({ landThenError: new Set(['par-1.1']) });
        const logs = [];
        const res = await createChildBeadWithAllocatedId(baseOpts(command, logs, { title: 'Only Once' }));
        assert.equal(res.childId, 'par-1.1');
        assert.deepEqual([...store.keys()], ['par-1.1'], 'no duplicate child created');
        assert.equal(calls.filter((c) => c.startsWith('bd create ')).length, 1);
        assert.ok(calls.includes('bd update par-1.1 --parent par-1'), 'the adopted child is linked to the parent');
        assert.ok(logs.some((l) => l.includes('adopting it instead of creating a duplicate')), JSON.stringify(logs));
    });

    test('bd\'s own whitespace (CRLF, trailing spaces) does not defeat adoption', async () => {
        const { command, store } = makeStoreCommand({
            landThenError: new Set(['par-1.1']),
            storedDescription: (d) => `${d.replace(/\n/g, '  \r\n')}\r\n\r\n`,
        });
        const res = await createChildBeadWithAllocatedId(baseOpts(command, [], { title: 'Ws', description: 'line one\nline two' }));
        assert.equal(res.childId, 'par-1.1');
        assert.deepEqual([...store.keys()], ['par-1.1']);
    });

    test('same title but a DIFFERENT description after a failed create is not adopted; the id stays consumed and a fresh id is used', async () => {
        const { command, store } = makeStoreCommand({
            landThenError: new Set(['par-1.1']),
            // What landed at par-1.1 is some other finding that shares the title.
            storedDescription: () => 'a different finding body',
        });
        const logs = [];
        const res = await createChildBeadWithAllocatedId(baseOpts(command, logs, { title: 'Same Title', description: 'my body' }));
        assert.equal(res.childId, 'par-1.2');
        assert.deepEqual([...store.keys()].sort(), ['par-1.1', 'par-1.2']);
        assert.deepEqual(alloc.status().parents['par-1'].free, [], 'the refused id stays consumed');
        assert.ok(logs.some((l) => l.includes("'par-1.1' holds a bead with this title but a different description; not adopting it")), JSON.stringify(logs));
    });

    test('an id that holds a DIFFERENT title after a failed create is not adopted; the retry uses a fresh id', async () => {
        const { command, store } = makeStoreCommand();
        // A concurrent writer takes par-1.1 between the probe and the create.
        const racing = async (cmd, o) => {
            if (cmd.startsWith('bd create ') && cmd.includes('--id par-1.1 ')) {
                store.set('par-1.1', { id: 'par-1.1', title: 'Someone else', status: 'open' });
            }
            return command(cmd, o);
        };
        const res = await createChildBeadWithAllocatedId(baseOpts(racing, [], { title: 'Mine' }));
        assert.equal(res.childId, 'par-1.2');
        assert.equal(store.get('par-1.1').title, 'Someone else');
    });

    test('the final error carries the consumed ids for the notes fallback', async () => {
        const { command } = makeCommand({ createAlwaysFails: true });
        await assert.rejects(
            () => createChildBeadWithAllocatedId(baseOpts(command, [])),
            (err) => { assert.deepEqual(err.consumedIds, ['par-1.1', 'par-1.2', 'par-1.3']); return true; },
        );
    });

    test('persistNewTaskBestEffort names the consumed ids in its fallback log and notes reason', async () => {
        const logs = [];
        const commands = [];
        const err = new Error('creating a child failed on all 3 attempts');
        err.consumedIds = ['par-1.1', 'par-1.2', 'par-1.3'];
        const ok = await persistNewTaskBestEffort({
            createFn: async () => { throw err; },
            command: async (cmd) => { commands.push(cmd); return STAGED_PATH; },
            member: 'local', parentId: 'par-1', cycle: 1, stage: 'develop-review',
            newTask: { title: 'T', description: 'D', priority: 'P2' },
            log: (m) => logs.push(m),
        });
        assert.equal(ok, false);
        assert.ok(logs.some((l) => l.includes('[consumed child ids: par-1.1, par-1.2, par-1.3]')), JSON.stringify(logs));
    });
});
