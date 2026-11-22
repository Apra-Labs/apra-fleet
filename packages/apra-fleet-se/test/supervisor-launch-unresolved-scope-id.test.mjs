import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLedger } from '../src/supervisor/ledger.mjs';
import { createScopeGuard } from '../src/supervisor/scope-overlap.mjs';
import { createSprintController, ApiError } from '../src/supervisor/api.mjs';
import { composeBeforeLaunch } from '../bin/serve.mjs';

// A launch whose issue list names an id absent from the scope guard's own
// backlog snapshot is a loud 400 (field issue) before any spawn or member
// reservation, with a near-match suggestion for a prefix-only mismatch, and
// with no extra bulk fetch beyond the guard's existing one.

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const ROWS = [
    { id: 'proj-aaa', title: 'a', status: 'open', issue_type: 'epic' },
    { id: 'proj-aaa.1', title: 'a1', status: 'open', issue_type: 'task', parent: 'proj-aaa' },
    { id: 'bare1', title: 'unprefixed', status: 'open', issue_type: 'task' },
];

async function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unresolved-scope-'));
    tmpDirs.push(dir);
    const ledger = createLedger({ filePath: path.join(dir, 'ledger.json') });
    await ledger.start();
    const fetches = { n: 0 };
    const scopeGuard = createScopeGuard({ ledger, listAllBeads: async () => { fetches.n += 1; return ROWS; } });
    const spawned = [];
    const spawner = { spawnSprint: async (o) => { spawned.push(o); return { pid: 4242, port: 9100 }; } };
    const controller = createSprintController({
        ledger, spawner,
        listMembers: () => ({ members: [] }),
        getBacklog: () => ({ tasks: [] }),
        beforeLaunch: composeBeforeLaunch({ memberOverlapGuard: async () => {}, scopeGuard }),
    });
    const launch = (issue) => controller.launch({ issue, members: ['alice'], branch: 'feat/x', base: 'main' });
    return { ledger, fetches, spawned, launch };
}

async function rejection(p) {
    try { await p; } catch (err) { return err; }
    return assert.fail('expected a rejection');
}

describe('launch with an unresolvable scope id', () => {
    test('one valid + one non-existent id -> 400 field=issue naming the missing id; nothing spawned, no reservation', async () => {
        const t = await setup();
        const err = await rejection(t.launch('proj-aaa,proj-nope'));
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 400);
        assert.equal(err.field, 'issue');
        assert.match(err.message, /proj-nope/);
        assert.ok(!/not found in the backlog: proj-aaa[ ,]/.test(err.message), 'the valid id is not reported missing');
        assert.equal(t.spawned.length, 0);
        assert.equal(t.ledger.list().length, 0, 'no ledger claim / member reservation');
    });

    test('every missing id is named', async () => {
        const t = await setup();
        const err = await rejection(t.launch('nope-1,nope-2'));
        assert.equal(err.status, 400);
        assert.match(err.message, /nope-1/);
        assert.match(err.message, /nope-2/);
    });

    test('a prefix-only mismatch carries a near-match suggestion (both directions)', async () => {
        const t = await setup();
        const e1 = await rejection(t.launch('aaa'));
        assert.equal(e1.status, 400);
        assert.match(e1.message, /did you mean proj-aaa\?/);
        const e2 = await rejection(t.launch('other-bare1'));
        assert.match(e2.message, /did you mean bare1\?/);
        assert.equal(t.spawned.length, 0);
    });

    test('ids that resolve (prefixed and un-prefixed) are accepted and spawn', async () => {
        const t = await setup();
        const res = await t.launch('proj-aaa,bare1');
        assert.ok(res.sprintId);
        assert.equal(t.spawned.length, 1);
    });

    test('the scope guard makes exactly ONE bulk fetch per launch, accepted or rejected', async () => {
        const rejected = await setup();
        await rejection(rejected.launch('proj-aaa,proj-nope'));
        assert.equal(rejected.fetches.n, 1);
        const accepted = await setup();
        await accepted.launch('proj-aaa');
        assert.equal(accepted.fetches.n, 1);
    });
});
