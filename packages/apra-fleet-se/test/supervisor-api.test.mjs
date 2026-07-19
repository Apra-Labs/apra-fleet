import { test, describe } from 'node:test';
import assert from 'node:assert';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import {
    createSprintController,
    registerSprintRoutes,
    proxyChildState,
    proxyChildStop,
    defaultMemberOverlapGuard,
    formatMemberConflict,
    ApiError,
} from '../src/supervisor/api.mjs';

// apra-fleet-eft.4.4 -- supervisor HTTP endpoints: members, backlog,
// sprints CRUD, stop proxy. Validation reuses runner.js validateIssueId /
// validateBranchName (single source of truth, no duplicated regexes).

async function tmpDir() {
    return fsp.mkdtemp(path.join(os.tmpdir(), 'eft-api-'));
}

/** Real ledger + history over a temp dir. */
async function stores(dir) {
    const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
    await ledger.start();
    const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
    await history.start();
    return { ledger, history };
}

/**
 * A spawner built on the REAL createSpawner, with an injected spawn that never
 * launches a process but records the exact argv it was handed -- so goal
 * forwarding can be asserted on the true child argv.
 */
function recordingSpawner(captured) {
    let nextPid = 5000;
    return createSpawner({
        basePort: 9100,
        isPortAvailable: async () => true, // deterministic port allocation
        spawn: (command, args) => {
            const pid = nextPid++;
            captured.push({ command, args, pid });
            const listeners = {};
            return {
                pid,
                once(ev, cb) { listeners[ev] = cb; return this; },
                unref() {},
            };
        },
    });
}

/** Mock req/res driving supervisor.handleRequest directly. */
function mockReq(method, url, body) {
    const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
    return {
        method,
        url,
        on(event, cb) {
            if (event === 'data') { for (const c of chunks) cb(c); }
            if (event === 'end') { cb(); }
            return this;
        },
    };
}
function mockRes() {
    return {
        statusCode: undefined,
        body: undefined,
        headersSent: false,
        writeHead(status) { this.statusCode = status; this.headersSent = true; },
        end(body) { this.body = body; },
    };
}
const payloadOf = (res) => JSON.parse(res.body);

describe('api -- POST /api/sprints validation + goal forwarding', () => {
    test('forwards the per-request goal into the child argv (asserted on spawn args)', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        const captured = [];
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner(captured),
            listMembers: () => ({ members: [] }),
            getBacklog: () => ({ tasks: [] }),
        });

        const result = await controller.launch({
            issue: 'PROJ-1', members: ['alice', 'bob'], branch: 'feat/x', base: 'main', goal: 'P1/P2',
        });

        assert.equal(captured.length, 1);
        const args = captured[0].args;
        // The goal reaches the child argv as `--goal P1/P2`.
        const gi = args.indexOf('--goal');
        assert.ok(gi >= 0, 'child argv must contain --goal');
        assert.equal(args[gi + 1], 'P1/P2');
        // And it was recorded on the ledger reservation.
        assert.equal(result.goal, 'P1/P2');
        assert.deepEqual(result.issueRoots, ['PROJ-1']);
        assert.ok(ledger.get(result.sprintId));

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('a launch WITHOUT a goal emits no --goal flag', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        const captured = [];
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner(captured),
            listMembers: () => ({ members: [] }), getBacklog: () => ({}),
        });
        await controller.launch({ issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main' });
        assert.equal(captured[0].args.includes('--goal'), false);
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('invalid issue id => 400 naming the issue field (via imported validateIssueId)', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        const captured = [];
        const supervisor = createSupervisor({ port: 0 });
        registerSprintRoutes(supervisor, createSprintController({
            ledger, history, spawner: recordingSpawner(captured),
            listMembers: () => ({ members: [] }), getBacklog: () => ({}),
        }));

        const res = mockRes();
        await supervisor.handleRequest(
            mockReq('POST', '/api/sprints', { issue: 'bad id!!', members: ['a'], branch: 'feat/x', base: 'main' }),
            res,
        );
        assert.equal(res.statusCode, 400);
        assert.equal(payloadOf(res).field, 'issue');
        // No child was spawned on a rejected launch.
        assert.equal(captured.length, 0);
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('invalid branch name => 400 naming the branch field (via imported validateBranchName)', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        const captured = [];
        const supervisor = createSupervisor({ port: 0 });
        registerSprintRoutes(supervisor, createSprintController({
            ledger, history, spawner: recordingSpawner(captured),
            listMembers: () => ({ members: [] }), getBacklog: () => ({}),
        }));

        const res = mockRes();
        await supervisor.handleRequest(
            mockReq('POST', '/api/sprints', { issue: 'PROJ-1', members: ['a'], branch: 'bad branch~name', base: 'main' }),
            res,
        );
        assert.equal(res.statusCode, 400);
        assert.equal(payloadOf(res).field, 'branch');
        assert.equal(captured.length, 0);
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('invalid base branch => 400 naming the base field', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner([]),
            listMembers: () => ({}), getBacklog: () => ({}),
        });
        await assert.rejects(
            () => controller.launch({ issue: 'PROJ-1', members: ['a'], branch: 'feat/x', base: 'bad base!' }),
            (err) => err instanceof ApiError && err.status === 400 && err.field === 'base',
        );
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('empty members => 400 naming the members field', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner([]),
            listMembers: () => ({}), getBacklog: () => ({}),
        });
        await assert.rejects(
            () => controller.launch({ issue: 'PROJ-1', members: [], branch: 'feat/x', base: 'main' }),
            (err) => err instanceof ApiError && err.status === 400 && err.field === 'members',
        );
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('roleMap members are folded into the reserved member union', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner([]),
            listMembers: () => ({}), getBacklog: () => ({}),
        });
        const r = await controller.launch({
            issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main',
            roleMap: { doer: ['bob'], reviewer: ['carol'] },
        });
        assert.deepEqual([...r.members].sort(), ['alice', 'bob', 'carol']);
        await fsp.rm(dir, { recursive: true, force: true });
    });
});

describe('api -- apra-fleet-eft.5.2 member-axis overlap check (default beforeLaunch)', () => {
    test('a directly-overlapping member => 409 naming the conflicting sprint id and the overlapping member', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        await ledger.claim('s-active', { members: ['alice', 'bob'], issueRoots: ['R1'], childPid: 1 });
        const captured = [];
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner(captured),
            listMembers: () => ({}), getBacklog: () => ({}),
        });
        await assert.rejects(
            () => controller.launch({ issue: 'PROJ-2', members: ['bob', 'carol'], branch: 'feat/y', base: 'main' }),
            (err) => err instanceof ApiError
                && err.status === 409
                && err.field === 'members'
                && err.message.includes('s-active')
                && err.message.includes('bob'),
        );
        // No child was spawned on a rejected launch.
        assert.equal(captured.length, 0);
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('an orchestrator-only overlap (member appears only via roleMap.orchestrator) is caught', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        // s-active previously claimed 'orch1' purely through its own orchestrator role.
        await ledger.claim('s-active', { members: ['alice', 'orch1'], issueRoots: ['R1'], childPid: 1 });
        const captured = [];
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner(captured),
            listMembers: () => ({}), getBacklog: () => ({}),
        });
        await assert.rejects(
            () => controller.launch({
                issue: 'PROJ-2', members: ['dave'], branch: 'feat/y', base: 'main',
                // 'orch1' never appears in `members`, only in roleMap.orchestrator.
                roleMap: { orchestrator: ['orch1'] },
            }),
            (err) => err instanceof ApiError
                && err.status === 409
                && err.message.includes('s-active')
                && err.message.includes('orch1'),
        );
        assert.equal(captured.length, 0);
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('a rejected launch leaves the ledger byte-identical (no partial claim)', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        await ledger.claim('s-active', { members: ['alice'], issueRoots: ['R1'], childPid: 1 });
        const before = ledger.toDocument();
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner([]),
            listMembers: () => ({}), getBacklog: () => ({}),
        });
        await assert.rejects(
            () => controller.launch({ issue: 'PROJ-2', members: ['alice'], branch: 'feat/y', base: 'main' }),
        );
        const after = ledger.toDocument();
        assert.deepEqual(after, before);
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('a non-overlapping launch claims every member in the union', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        await ledger.claim('s-active', { members: ['alice'], issueRoots: ['R1'], childPid: 1 });
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner([]),
            listMembers: () => ({}), getBacklog: () => ({}),
        });
        const r = await controller.launch({
            issue: 'PROJ-2', members: ['bob'], branch: 'feat/y', base: 'main',
            roleMap: { doer: ['carol'], orchestrator: ['dave'] },
        });
        assert.deepEqual([...r.members].sort(), ['bob', 'carol', 'dave']);
        const reservation = ledger.get(r.sprintId);
        assert.deepEqual([...reservation.members].sort(), ['bob', 'carol', 'dave']);
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('defaultMemberOverlapGuard / formatMemberConflict directly: multiple conflicting sprints are all named', async () => {
        const ledgerStub = {
            list: () => [
                { sprintId: 's1', members: ['alice', 'bob'] },
                { sprintId: 's2', members: ['carol'] },
            ],
        };
        const guard = defaultMemberOverlapGuard(ledgerStub);
        await assert.rejects(
            () => guard({ members: ['alice', 'carol', 'dave'] }),
            (err) => err instanceof ApiError
                && err.status === 409
                && err.field === 'members'
                && err.message === formatMemberConflict([
                    { sprintId: 's1', members: ['alice'] },
                    { sprintId: 's2', members: ['carol'] },
                ]),
        );
    });

    test('defaultMemberOverlapGuard: no overlap resolves without throwing', async () => {
        const ledgerStub = { list: () => [{ sprintId: 's1', members: ['alice'] }] };
        const guard = defaultMemberOverlapGuard(ledgerStub);
        await assert.doesNotReject(() => guard({ members: ['bob', 'carol'] }));
    });
});

describe('api -- GET /api/members overlay', () => {
    test('members list is overlaid with live reservations', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        await ledger.claim('s1', { members: ['alice'], issueRoots: ['R'], childPid: 1 });
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner([]),
            listMembers: () => ({ members: [{ name: 'alice' }, { name: 'bob' }] }),
            getBacklog: () => ({}),
        });
        const out = await controller.members();
        const byName = Object.fromEntries(out.members.map((m) => [m.name, m]));
        assert.equal(byName.alice.reserved, true);
        assert.equal(byName.alice.reservedBy, 's1');
        assert.equal(byName.bob.reserved, false);
        assert.equal(byName.bob.reservedBy, null);
        await fsp.rm(dir, { recursive: true, force: true });
    });
});

describe('api -- apra-fleet-eft.5.5 scope-freshness indicator on claimed-scope responses', () => {
    test('GET /api/backlog includes scopeFreshness with an explicit never-synced marker when unknown', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner([]),
            listMembers: () => ({}), getBacklog: () => ({ tasks: ['t1'] }),
        });
        const out = await controller.backlog();
        assert.deepEqual(out.tasks, ['t1']);
        assert.deepEqual(out.scopeFreshness, { lastSyncedAt: null, ageSeconds: 'never-synced' });
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('GET /api/sprints includes scopeFreshness alongside the live reservation list', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        await ledger.claim('s1', { members: ['a'], issueRoots: ['R'], childPid: 42 });
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner([]),
            listMembers: () => ({}), getBacklog: () => ({}),
        });
        const out = await controller.listSprints();
        assert.equal(out.sprints.length, 1);
        assert.deepEqual(out.scopeFreshness, { lastSyncedAt: null, ageSeconds: 'never-synced' });
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('scopeFreshness on both endpoints reflects the recorded sync and updates after a later sync', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner([]),
            listMembers: () => ({}), getBacklog: () => ({}),
        });

        await ledger.setScopeFreshness('2026-07-18T00:00:00.000Z');
        const backlogOut = await controller.backlog();
        const sprintsOut = await controller.listSprints();
        assert.equal(backlogOut.scopeFreshness.lastSyncedAt, '2026-07-18T00:00:00.000Z');
        assert.equal(typeof backlogOut.scopeFreshness.ageSeconds, 'number');
        assert.equal(sprintsOut.scopeFreshness.lastSyncedAt, '2026-07-18T00:00:00.000Z');

        // A subsequent sync moves lastSyncedAt forward on both endpoints.
        await ledger.setScopeFreshness('2026-07-18T00:10:00.000Z');
        const backlogOut2 = await controller.backlog();
        assert.equal(backlogOut2.scopeFreshness.lastSyncedAt, '2026-07-18T00:10:00.000Z');
        await fsp.rm(dir, { recursive: true, force: true });
    });
});

describe('api -- GET /api/sprints and /api/sprints/:id', () => {
    test('GET /api/sprints/:id returns LIVE child state when running (proxied /state)', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        await ledger.claim('s1', { members: ['a'], issueRoots: ['R'], childPid: 42 });
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner([]),
            listMembers: () => ({}), getBacklog: () => ({}),
            resolvePort: (pid) => (pid === 42 ? 9200 : undefined),
            proxyState: async (port) => ({ port, status: 'running', tree: [] }),
        });
        const out = await controller.getSprint('s1');
        assert.equal(out.live, true);
        assert.equal(out.state.status, 'running');
        assert.equal(out.state.port, 9200);
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('GET /api/sprints/:id returns the HISTORICAL record when finished (not live)', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        await history.record({ sprintId: 's-done', event: 'force-released', reason: 'done', members: ['a'], issueRoots: ['R'] });
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner([]),
            listMembers: () => ({}), getBacklog: () => ({}),
        });
        const out = await controller.getSprint('s-done');
        assert.equal(out.live, false);
        assert.equal(out.latest.event, 'force-released');
        assert.ok(Array.isArray(out.history));
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('GET /api/sprints/:id for an unknown id => 404', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner([]),
            listMembers: () => ({}), getBacklog: () => ({}),
        });
        await assert.rejects(
            () => controller.getSprint('ghost'),
            (err) => err instanceof ApiError && err.status === 404,
        );
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('GET /api/sprints lists live reservations with resolved ports', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        await ledger.claim('s1', { members: ['a'], issueRoots: ['R'], childPid: 42 });
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner([]),
            listMembers: () => ({}), getBacklog: () => ({}),
            resolvePort: (pid) => (pid === 42 ? 9200 : undefined),
        });
        const out = await controller.listSprints();
        assert.equal(out.sprints.length, 1);
        assert.equal(out.sprints[0].sprintId, 's1');
        assert.equal(out.sprints[0].port, 9200);
        await fsp.rm(dir, { recursive: true, force: true });
    });
});

describe('api -- POST /api/sprints/:id/stop proxy', () => {
    test('reaches the child /stop endpoint for a live sprint', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        await ledger.claim('s1', { members: ['a'], issueRoots: ['R'], childPid: 42 });
        let stoppedPort = null;
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner([]),
            listMembers: () => ({}), getBacklog: () => ({}),
            resolvePort: (pid) => (pid === 42 ? 9200 : undefined),
            proxyStop: async (port) => { stoppedPort = port; return { statusCode: 200 }; },
        });
        const out = await controller.stopSprint('s1');
        assert.equal(stoppedPort, 9200);
        assert.equal(out.status, 'stopping');
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('stopping an unknown sprint => 404', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        const controller = createSprintController({
            ledger, history, spawner: recordingSpawner([]),
            listMembers: () => ({}), getBacklog: () => ({}),
        });
        await assert.rejects(
            () => controller.stopSprint('ghost'),
            (err) => err instanceof ApiError && err.status === 404,
        );
        await fsp.rm(dir, { recursive: true, force: true });
    });
});

describe('api -- route registration coexists with lifecycle routes', () => {
    test('all six routes register and exact/pattern routes do not shadow health', async () => {
        const dir = await tmpDir();
        const { ledger, history } = await stores(dir);
        const supervisor = createSupervisor({ port: 0 });
        registerSprintRoutes(supervisor, createSprintController({
            ledger, history, spawner: recordingSpawner([]),
            listMembers: () => ({ members: [] }), getBacklog: () => ({ tasks: [] }),
        }));

        // GET /api/members
        let res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/members'), res);
        assert.equal(res.statusCode, 200);

        // GET /api/backlog
        res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/backlog'), res);
        assert.equal(res.statusCode, 200);

        // GET /api/sprints (exact) still works alongside the :id pattern route
        res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/sprints'), res);
        assert.equal(res.statusCode, 200);
        assert.ok(Array.isArray(payloadOf(res).sprints));

        // Lifecycle-owned GET /api/health is not shadowed.
        res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/health'), res);
        assert.equal(res.statusCode, 200);
        assert.equal(payloadOf(res).status, 'ok');

        await fsp.rm(dir, { recursive: true, force: true });
    });
});

describe('api -- default HTTP proxies against a real child server', () => {
    test('proxyChildState reads /state and proxyChildStop reaches /stop', async () => {
        let stopHit = false;
        const server = http.createServer((req, res) => {
            if (req.url === '/state') { res.writeHead(200); res.end(JSON.stringify({ status: 'running' })); }
            else if (req.url === '/stop' && req.method === 'POST') { stopHit = true; res.writeHead(200); res.end(); }
            else { res.writeHead(404); res.end(); }
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        try {
            const state = await proxyChildState(port);
            assert.equal(state.status, 'running');
            await proxyChildStop(port);
            assert.equal(stopHit, true);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
