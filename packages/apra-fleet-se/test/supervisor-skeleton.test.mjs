import { test, describe } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';

import {
    createSupervisor,
    makeSeamStub,
    readJsonBody,
    sendJson,
    DEFAULT_SERVICE_PORT,
} from '../src/supervisor/server.mjs';
import { parseServeArgs, serveMain, composeBeforeLaunch } from '../bin/serve.mjs';
import { defaultMemberOverlapGuard, ApiError } from '../src/supervisor/api.mjs';
import { createScopeGuard } from '../src/supervisor/scope-overlap.mjs';

// apra-fleet-eft.4.1 -- supervisor skeleton: always-on process, HTTP server
// bootstrap, POST /api/shutdown, error-isolated dispatcher, documented seams.

/** Tiny promise-based HTTP client so tests don't pull in a dep. */
function request(port, method, path, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const req = http.request(
            { host: '127.0.0.1', port, method, path,
              headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {} },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf-8');
                    let json;
                    try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
                    resolve({ status: res.statusCode, json });
                });
            },
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

describe('createSupervisor -- HTTP bootstrap + lifecycle', () => {
    test('starts, answers /api/health, and stays up with zero sprints', async () => {
        const supervisor = createSupervisor({ port: 0, logger: { log() {}, error() {} } });
        await supervisor.start();
        const port = supervisor.server.address().port;

        const health = await request(port, 'GET', '/api/health');
        assert.equal(health.status, 200);
        assert.equal(health.json.status, 'ok');
        // Server is still listening -- nothing drove an exit.
        assert.equal(supervisor.server.listening, true);

        await supervisor.stop();
    });

    test('POST /api/shutdown terminates cleanly and resolves shutdownRequested', async () => {
        const supervisor = createSupervisor({ port: 0, logger: { log() {}, error() {} } });
        await supervisor.start();
        const port = supervisor.server.address().port;

        const res = await request(port, 'POST', '/api/shutdown');
        assert.equal(res.status, 200);
        assert.equal(res.json.status, 'shutting-down');

        // shutdownRequested resolves once the server + seams are torn down.
        await supervisor.shutdownRequested;
        assert.equal(supervisor.server.listening, false);
    });

    test('an unhandled error inside a request never exits the process (returns 500)', async () => {
        const supervisor = createSupervisor({ port: 0, logger: { log() {}, error() {} } });
        supervisor.route('GET', '/api/boom', () => { throw new Error('kaboom'); });
        await supervisor.start();
        const port = supervisor.server.address().port;

        const res = await request(port, 'GET', '/api/boom');
        assert.equal(res.status, 500);
        assert.equal(res.json.error, 'internal supervisor error');

        // Still up and serving after the handler threw.
        const health = await request(port, 'GET', '/api/health');
        assert.equal(health.status, 200);
        assert.equal(supervisor.server.listening, true);

        await supervisor.stop();
    });

    test('unknown route returns 404 without crashing', async () => {
        const supervisor = createSupervisor({ port: 0, logger: { log() {}, error() {} } });
        await supervisor.start();
        const port = supervisor.server.address().port;

        const res = await request(port, 'GET', '/api/nope');
        assert.equal(res.status, 404);
        assert.equal(supervisor.server.listening, true);

        await supervisor.stop();
    });

    test('starts and stops all four seams via their lifecycle hooks', async () => {
        const events = [];
        const mkSeam = (name) => ({
            name,
            async start() { events.push(`start:${name}`); },
            async stop() { events.push(`stop:${name}`); },
        });
        const supervisor = createSupervisor({
            port: 0,
            logger: { log() {}, error() {} },
            ledger: mkSeam('ledger'),
            spawner: mkSeam('spawner'),
            watchdog: mkSeam('watchdog'),
            dashboard: mkSeam('dashboard'),
        });
        await supervisor.start();
        await supervisor.stop();

        assert.deepEqual(events.slice(0, 4), ['start:ledger', 'start:spawner', 'start:watchdog', 'start:dashboard']);
        // Seams torn down in reverse order.
        assert.deepEqual(events.slice(4), ['stop:dashboard', 'stop:watchdog', 'stop:spawner', 'stop:ledger']);
    });

    test('a failing seam stop does not block teardown of the others', async () => {
        const stopped = [];
        const supervisor = createSupervisor({
            port: 0,
            logger: { log() {}, error() {} },
            watchdog: { name: 'watchdog', async start() {}, async stop() { throw new Error('watchdog stop failed'); } },
            ledger: { name: 'ledger', async start() {}, async stop() { stopped.push('ledger'); } },
        });
        await supervisor.start();
        await supervisor.stop();
        // ledger (last in teardown order) still stopped despite watchdog throwing.
        assert.deepEqual(stopped, ['ledger']);
    });

    test('stop() is idempotent', async () => {
        const supervisor = createSupervisor({ port: 0, logger: { log() {}, error() {} } });
        await supervisor.start();
        const a = supervisor.stop();
        const b = supervisor.stop();
        assert.equal(a, b);
        await a;
    });

    test('default seams are inert stubs, reported by /api/health', async () => {
        const supervisor = createSupervisor({ port: 0, logger: { log() {}, error() {} } });
        await supervisor.start();
        const port = supervisor.server.address().port;
        const health = await request(port, 'GET', '/api/health');
        assert.equal(health.json.seams.ledger, 'ledger:stub');
        assert.equal(health.json.seams.spawner, 'spawner:stub');
        assert.equal(health.json.seams.watchdog, 'watchdog:stub');
        assert.equal(health.json.seams.dashboard, 'dashboard:stub');
        await supervisor.stop();
    });
});

describe('seam stubs + helpers', () => {
    test('makeSeamStub is a named no-op with start/stop', async () => {
        const s = makeSeamStub('ledger');
        assert.equal(s.name, 'ledger:stub');
        await s.start();
        await s.stop();
    });

    test('readJsonBody parses JSON and enforces a size cap', async () => {
        const parsed = await readJsonBody(mockReq('{"a":1}'));
        assert.deepEqual(parsed, { a: 1 });

        const empty = await readJsonBody(mockReq(''));
        assert.equal(empty, undefined);

        await assert.rejects(() => readJsonBody(mockReq('{bad'), { maxBytes: 100 }), /invalid JSON/);
        await assert.rejects(() => readJsonBody(mockReq('x'.repeat(50)), { maxBytes: 10 }), /byte limit/);
    });
});

describe('parseServeArgs', () => {
    test('accepts --port and --help; rejects unknown flags', () => {
        assert.equal(parseServeArgs(['--port', '9000']).values.port, '9000');
        assert.equal(parseServeArgs(['--help']).values.help, true);
        assert.throws(() => parseServeArgs(['--nope']), /Invalid command-line arguments/);
    });

    test('DEFAULT_SERVICE_PORT is a valid port', () => {
        assert.ok(Number.isInteger(DEFAULT_SERVICE_PORT) && DEFAULT_SERVICE_PORT > 0 && DEFAULT_SERVICE_PORT < 65536);
    });
});

// apra-fleet-k06.1/k06.2: the composed beforeLaunch wiring (member-overlap
// guard THEN issue-scope guard, both over the SAME ledger) that serveMain()
// builds and injects into createSprintController(). Exercises
// composeBeforeLaunch() with the SAME real guard collaborators
// (defaultMemberOverlapGuard, createScopeGuard) serveMain wires -- only the
// ledger/listChildren are faked/injected -- so this proves the composition
// itself, not just each guard's own already-covered unit suite. Includes the
// disjoint-member-but-overlapping/nested-issue-scope shape named in the k06
// bug report (epic root reserved vs one of its children targeted).
describe('api -- apra-fleet-k06.1/k06.2 composeBeforeLaunch (member guard + scope guard, wired-level)', () => {
    /** A minimal fake ledger -- both guards only ever call list(). */
    function fakeLedger(reservations) {
        return { list: () => reservations };
    }

    test('disjoint member sets but overlapping issue scope: rejected 409 field=issue, scope guard\'s checkLaunch runs', async () => {
        const ledger = fakeLedger([
            { sprintId: 's-active', members: ['carol'], issueRoots: ['epic-1'] },
        ]);
        const memberOverlapGuard = defaultMemberOverlapGuard(ledger);
        // No real `bd` process: listChildren stubbed to report no children, so
        // each side's live-expanded scope is exactly its own request roots.
        const scopeGuard = createScopeGuard({ ledger, listChildren: async () => [] });
        const beforeLaunch = composeBeforeLaunch({ memberOverlapGuard, scopeGuard });

        await assert.rejects(
            () => beforeLaunch({ members: ['alice'], issueRoots: ['epic-1'] }),
            (err) => {
                assert.ok(err instanceof ApiError);
                assert.equal(err.status, 409);
                assert.equal(err.field, 'issue');
                assert.match(err.message, /issue-scope overlap rejects launch/);
                assert.match(err.message, /s-active/);
                assert.match(err.message, /epic-1/);
                return true;
            },
        );
    });

    // apra-fleet-k06.2: the specific overlap shape the k06 bug report names --
    // one active sprint reserves an EPIC ROOT, a second (disjoint-member)
    // request targets one of that epic's CHILDREN, not the same root id. The
    // guard must live-expand 'epic-1' via listChildren to discover 'epic-1-
    // child' is in its subtree, then reject on the intersection.
    test('disjoint members but request targets a CHILD of an already-claimed epic root: rejected 409 field=issue, naming sprint + child bead id', async () => {
        const ledger = fakeLedger([
            { sprintId: 's-active', members: ['carol'], issueRoots: ['epic-1'] },
        ]);
        const memberOverlapGuard = defaultMemberOverlapGuard(ledger);
        const scopeGuard = createScopeGuard({
            ledger,
            listChildren: async (parentId) => (parentId === 'epic-1' ? ['epic-1-child'] : []),
        });
        const beforeLaunch = composeBeforeLaunch({ memberOverlapGuard, scopeGuard });

        await assert.rejects(
            () => beforeLaunch({ members: ['alice'], issueRoots: ['epic-1-child'] }),
            (err) => {
                assert.ok(err instanceof ApiError);
                assert.equal(err.status, 409);
                assert.equal(err.field, 'issue');
                assert.match(err.message, /issue-scope overlap rejects launch/);
                assert.match(err.message, /s-active/);
                assert.match(err.message, /epic-1-child/);
                return true;
            },
        );
    });

    test('overlapping members: rejected 409 field=members BEFORE the scope guard ever runs (member axis runs first)', async () => {
        const ledger = fakeLedger([
            { sprintId: 's-active', members: ['alice'], issueRoots: ['epic-1'] },
        ]);
        const memberOverlapGuard = defaultMemberOverlapGuard(ledger);
        let scopeGuardCalled = false;
        const scopeGuard = {
            checkLaunch: async () => {
                scopeGuardCalled = true;
                return { ok: true, conflicts: [] };
            },
        };
        const beforeLaunch = composeBeforeLaunch({ memberOverlapGuard, scopeGuard });

        // Disjoint issue scope (no overlap on that axis) but overlapping members.
        await assert.rejects(
            () => beforeLaunch({ members: ['alice'], issueRoots: ['epic-2'] }),
            (err) => {
                assert.ok(err instanceof ApiError);
                assert.equal(err.status, 409);
                assert.equal(err.field, 'members');
                return true;
            },
        );
        assert.equal(scopeGuardCalled, false, 'scope guard must not run once the member guard has already rejected');
    });

    test('no overlap on either axis: the launch is allowed through (composed guard resolves without throwing)', async () => {
        const ledger = fakeLedger([
            { sprintId: 's-active', members: ['carol'], issueRoots: ['epic-9'] },
        ]);
        const memberOverlapGuard = defaultMemberOverlapGuard(ledger);
        const scopeGuard = createScopeGuard({ ledger, listChildren: async () => [] });
        const beforeLaunch = composeBeforeLaunch({ memberOverlapGuard, scopeGuard });

        await assert.doesNotReject(() => beforeLaunch({ members: ['alice'], issueRoots: ['epic-1'] }));
    });
});

describe('serveMain', () => {
    test('--help returns exit 0 without starting a server', async () => {
        const { exitCode } = await serveMain(['--help']);
        assert.equal(exitCode, 0);
    });

    test('invalid --port returns exit 1', async () => {
        const origErr = console.error;
        console.error = () => {};
        try {
            const { exitCode } = await serveMain(['--port', 'notaport']);
            assert.equal(exitCode, 1);
        } finally {
            console.error = origErr;
        }
    });
});

// -- minimal fake IncomingMessage for readJsonBody --------------------------
function mockReq(bodyText) {
    const listeners = {};
    const req = {
        on(event, cb) { (listeners[event] ||= []).push(cb); return req; },
        destroy() {},
    };
    // Emit on next tick so `.on()` registrations complete first.
    setImmediate(() => {
        if (bodyText.length) (listeners.data || []).forEach((cb) => cb(Buffer.from(bodyText)));
        (listeners.end || []).forEach((cb) => cb());
    });
    return req;
}

// keep sendJson referenced so linters/tree-shakers see the export is exercised
test('sendJson writes a JSON response with content-length', async () => {
    const server = http.createServer((req, res) => sendJson(res, 201, { ok: true }));
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    const res = await request(port, 'GET', '/');
    assert.equal(res.status, 201);
    assert.deepEqual(res.json, { ok: true });
    await new Promise((r) => server.close(r));
});
