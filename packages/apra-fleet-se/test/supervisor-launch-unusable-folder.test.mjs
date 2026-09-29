import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { createSprintController, registerSprintRoutes } from '../src/supervisor/api.mjs';
import { formatUnusableLaunchFolderError } from '../src/supervisor/beads-identity.mjs';
import { launchFolderUsable } from '../bin/serve.mjs';

// A stale configured project folder leaves serve's launch cwd pointing at a
// path that does not exist. POST /api/sprints must refuse up front (naming
// the folder and the fix) and never spawn; a usable cwd with NO local beads is
// not refused by this guard.

const tmpDirs = [];
after(async () => {
    for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
});

async function setup(project, cwd) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'launch-guard-'));
    tmpDirs.push(dir);
    const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME) });
    await ledger.start();
    const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME) });
    await history.start();
    const spawned = [];
    const spawner = { spawnSprint: async (o) => { spawned.push(o); return { pid: 4242, port: 9100, command: 'x', args: [], logPath: path.join(dir, 'l.log') }; } };
    const controller = createSprintController({
        ledger, history, spawner,
        listMembers: () => ({ members: [] }),
        getBacklog: () => ({ tasks: [] }),
        launchGuard: () => (launchFolderUsable(project, cwd)
            ? null
            : formatUnusableLaunchFolderError(cwd, { launchMode: 'installed-service' })),
    });
    const token = 'g'.repeat(64);
    const supervisor = createSupervisor({ token });
    registerSprintRoutes(supervisor, controller);
    return { supervisor, spawned, token, dir };
}

async function launch({ supervisor, token }) {
    const chunks = [Buffer.from(JSON.stringify({ issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main' }))];
    const req = {
        method: 'POST', url: '/api/sprints', headers: { authorization: `Bearer ${token}` },
        on(ev, cb) { if (ev === 'data') for (const c of chunks) cb(c); if (ev === 'end') cb(); return this; },
    };
    const res = { statusCode: undefined, body: undefined, headersSent: false, writeHead(s) { this.statusCode = s; this.headersSent = true; }, end(b) { this.body = b; } };
    await supervisor.handleRequest(req, res);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

describe('launch guard for an unusable project folder (apra-fleet-i9ag.17.10)', () => {
    test('stale configured folder (nonexistent) -> 4xx naming the folder and the fix; nothing is spawned', async () => {
        const gone = path.join(os.tmpdir(), 'launch-guard-does-not-exist-xyz');
        const t = await setup({ usable: false }, gone);
        const r = await launch(t);
        assert.ok(r.status >= 400 && r.status < 500, `status ${r.status}`);
        assert.ok(r.body.error.includes(gone), r.body.error);
        assert.match(r.body.error, /does not exist or is not a directory/);
        assert.match(r.body.error, /apra-fleet restart/);
        assert.equal(t.spawned.length, 0, 'no child may be spawned');
    });

    test('a usable cwd is not refused by the guard (no local beads identity is irrelevant to it)', async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'launch-guard-ok-'));
        tmpDirs.push(dir);
        const t = await setup({ usable: true }, dir);
        const r = await launch(t);
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(t.spawned.length, 1);
    });

    test('launchFolderUsable: unusable project, missing dir and a plain file are all unusable', async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'launch-guard-f-'));
        tmpDirs.push(dir);
        const file = path.join(dir, 'f.txt');
        await fsp.writeFile(file, 'x');
        assert.equal(launchFolderUsable({ usable: true }, dir), true);
        assert.equal(launchFolderUsable({ usable: false }, dir), false);
        assert.equal(launchFolderUsable({ usable: true }, path.join(dir, 'nope')), false);
        assert.equal(launchFolderUsable({ usable: true }, file), false);
    });
});
