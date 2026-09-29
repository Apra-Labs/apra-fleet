import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSupervisor, readJsonBody, sendJson } from '../src/supervisor/server.mjs';
import { registerProjectFolderRoutes } from '../src/supervisor/project-route.mjs';
import { discoverBeadsDir, isProjectBeadsDir } from '../src/supervisor/beads-identity.mjs';
import { createBacklog, registerBacklogRoutes } from '../src/supervisor/backlog.mjs';
import { createSprintController, registerSprintRoutes } from '../src/supervisor/api.mjs';

// apra-fleet-i9ag.17.12 -- a bd GLOBAL-state .beads (eventsData + machine-id,
// what ~/.beads holds) is not a project, and Backlog degrades to the empty
// state instead of a 500. Real temp dirs only; no bd or git is run.

const tmpDirs = [];
after(async () => {
    for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true }).catch(() => {});
});

/** home/.beads = global state only; home/work/cwd is the walk-up start. */
async function layout() {
    const root = fs.realpathSync.native(await fsp.mkdtemp(path.join(os.tmpdir(), 'apra-global-beads-')));
    tmpDirs.push(root);
    const home = path.join(root, 'home');
    const cwd = path.join(home, 'work', 'cwd');
    await fsp.mkdir(path.join(home, '.beads', 'eventsData'), { recursive: true });
    await fsp.writeFile(path.join(home, '.beads', 'machine-id'), 'x');
    await fsp.mkdir(cwd, { recursive: true });
    return { root, home, cwd };
}

const mockReq = (method, url, headers = {}) => ({ method, url, headers, on(ev, cb) { if (ev === 'end') cb(); return this; } });
const mockRes = () => ({
    statusCode: undefined, body: undefined, headersSent: false,
    writeHead(s) { this.statusCode = s; this.headersSent = true; },
    end(b) { this.body = b; },
});
const AUTH = { authorization: 'Bearer tok' };
async function call(supervisor, method, url) {
    const res = mockRes();
    await supervisor.handleRequest(mockReq(method, url, AUTH), res);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

describe('global-state .beads is not a project (apra-fleet-i9ag.17.12)', () => {
    test('discovery returns null when the only .beads above cwd is global state', async () => {
        const { home, cwd } = await layout();
        assert.equal(isProjectBeadsDir(path.join(home, '.beads')), false);
        assert.equal(discoverBeadsDir({ cwd }), null);
    });

    test('a real project .beads between cwd and the global one is still found', async () => {
        const { home, cwd } = await layout();
        const proj = path.join(home, 'work');
        await fsp.mkdir(path.join(proj, '.beads'), { recursive: true });
        await fsp.writeFile(path.join(proj, '.beads', 'metadata.json'), '{}');
        assert.deepEqual(discoverBeadsDir({ cwd }), { beadsDir: path.join(proj, '.beads'), repoRoot: proj });
    });

    test('GET /api/project reports hasBeadsDb false for the global-state folder and true for a real project', async () => {
        const { home, root } = await layout();
        const proj = path.join(root, 'proj');
        await fsp.mkdir(path.join(proj, '.beads'), { recursive: true });
        await fsp.writeFile(path.join(proj, '.beads', 'metadata.json'), '{}');
        for (const [dir, expected] of [[home, false], [proj, true]]) {
            const supervisor = createSupervisor({ token: 'tok' });
            registerProjectFolderRoutes(supervisor, {
                projectDir: dir, source: 'walk-up', flagActive: false, dataDir: path.join(root, 'data'),
                readJsonBody, sendJson,
            });
            const r = await call(supervisor, 'GET', '/api/project');
            assert.equal(r.status, 200);
            assert.equal(r.body.hasBeadsDb, expected, dir);
        }
    });

    test('GET /api/backlog/tasks and GET /api/backlog answer 200 with the no-project empty state', async () => {
        const noProject = createBacklog({
            ledger: { list: () => [] },
            hasProject: () => false,
            listAllBeads: async () => { throw new Error('bd must not be called with no project'); },
        });
        const bdSays = createBacklog({
            ledger: { list: () => [] },
            listAllBeads: async () => {
                throw Object.assign(new Error('bd list failed'), { stderr: '{"error":"no_beads_directory"}' });
            },
        });
        for (const backlog of [noProject, bdSays]) {
            const supervisor = createSupervisor({ token: 'tok' });
            registerBacklogRoutes(supervisor, backlog);
            const r = await call(supervisor, 'GET', '/api/backlog/tasks');
            assert.equal(r.status, 200);
            assert.equal(r.body.noProject, true);
            assert.deepEqual(r.body.tasks, []);
            assert.equal(r.body.total, 0);
        }

        const supervisor = createSupervisor({ token: 'tok' });
        const controller = createSprintController({
            ledger: { list: () => [], get: () => undefined, claim: () => {}, getScopeFreshness: () => null },
            listMembers: () => ({ members: [] }),
            spawner: { spawnSprint() {} },
            getBacklog: async () => ({ tree: await bdSays.buildTree() }),
        });
        registerSprintRoutes(supervisor, controller);
        const r = await call(supervisor, 'GET', '/api/backlog');
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.tree, []);
    });

    test('a genuine unexpected failure against a real project still surfaces as 500', async () => {
        const backlog = createBacklog({
            ledger: { list: () => [] },
            listAllBeads: async () => { throw new Error('dolt exploded'); },
        });
        const supervisor = createSupervisor({ token: 'tok' });
        registerBacklogRoutes(supervisor, backlog);
        const r = await call(supervisor, 'GET', '/api/backlog/tasks');
        assert.equal(r.status, 500);
    });
});
