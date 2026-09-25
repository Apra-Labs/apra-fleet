import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isNodeSqliteAvailable, openStore } from '../src/projects/store/db.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { registerProjectRoutes, probeBeadsRemote } from '../src/projects/routes/projects.mjs';
import { findShellCommandViolations } from '../fleet-sprint/shell-command-guard.mjs';

// =============================================================================
// apra-fleet-972p.4.1 -- /api/projects route module (impl-task coverage).
//
// This is the doer's own verification of the route module it wrote: create
// success, every validation failure, duplicate id 409, unknown id 404, and a
// failed remote probe 400 (DQ-12: probe-only, never `git remote add`). The
// follow-on [test] task (972p.4.2) drives fuller coverage (GET/PUT/DELETE
// round-trip, the "not yet mounted in serve.mjs" check) against this same
// module; this file is not required to duplicate that scope.
//
// Framework: node:test, driving registerProjectRoutes() through the
// mockReq/mockRes pattern of test/supervisor-api.test.mjs, i.e.
// supervisor.handleRequest(req, res) directly -- no real HTTP listener.
// =============================================================================

const HAS_SQLITE = isNodeSqliteAvailable();
const skip = HAS_SQLITE ? false : 'node:sqlite is unavailable on this Node runtime';

/** @type {string[]} */
const tmpDirs = [];
/** @type {Array<{close: () => void}>} */
const openStores = [];

after(async () => {
    for (const s of openStores) {
        try { s.close(); } catch { /* best-effort */ }
    }
    for (const dir of tmpDirs) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
});

async function freshStore() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-se-routes-'));
    tmpDirs.push(dir);
    const store = openStore({ dataDir: dir });
    openStores.push(store);
    return store;
}

/** Mock req/res driving supervisor.handleRequest directly (mirrors supervisor-api.test.mjs). */
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

/**
 * A stub fleet client whose executeCommand records every call and answers
 * according to `outcome` ('ok' | 'error' | 'nonzero-exit' | 'throws').
 *
 * `members` (apra-fleet-vcnl.15), when supplied, wires up a `listMembers`
 * method too -- so `probeBeadsRemote`'s `resolveMemberRecord` can resolve the
 * target member's registered os/shell for `quoteArg`. When omitted (the
 * default, matching every pre-existing test in this file), the client carries
 * NO `listMembers` method at all -- exactly the narrower constructor contract
 * `registerProjectRoutes` documents (only `executeCommand` is required) --
 * and `probeBeadsRemote` must tolerate that by falling back to `quoteArg`'s
 * own POSIX default rather than throwing.
 */
function stubClient(outcome = 'ok', { members } = {}) {
    const calls = [];
    const listMembersCalls = [];
    const client = {
        calls,
        listMembersCalls,
        async executeCommand(opts) {
            calls.push(opts);
            if (outcome === 'throws') throw new Error('transport unreachable');
            if (outcome === 'error') {
                return { isError: true, content: [{ text: 'fatal: repository not found' }] };
            }
            if (outcome === 'nonzero-exit') {
                return {
                    isError: false,
                    content: [{ text: '' }],
                    structuredContent: { exitCode: 128, stdout: '', stderr: 'fatal: could not read from remote' },
                };
            }
            return {
                isError: false,
                content: [{ text: '' }],
                structuredContent: { exitCode: 0, stdout: 'deadbeef\trefs/dolt/data\n', stderr: '' },
            };
        },
    };
    if (members) {
        client.listMembers = async () => {
            listMembersCalls.push(1);
            return { content: [{ type: 'text', text: JSON.stringify({ members }) }] };
        };
    }
    return client;
}

function validBody(overrides = {}) {
    return {
        id: 'proj-1',
        name: 'Project One',
        backlogMember: 'alice',
        beads: { kind: 'clone', dir: '/repo/.beads' },
        operator: 'akhil',
        ...overrides,
    };
}

async function setup(clientOutcome = 'ok') {
    const store = await freshStore();
    const client = stubClient(clientOutcome);
    const supervisor = createSupervisor();
    registerProjectRoutes(supervisor, { store, client });
    return { store, client, supervisor };
}

describe('probeBeadsRemote', { skip }, () => {
    test('ok on exitCode 0', async () => {
        const client = stubClient('ok');
        const result = await probeBeadsRemote(client, 'alice', 'https://example.invalid/x/beads.git');
        assert.equal(result.ok, true);
        assert.equal(client.calls.length, 1);
        assert.equal(client.calls[0].command, "git ls-remote 'https://example.invalid/x/beads.git' refs/dolt/data");
        assert.equal(client.calls[0].member_name, 'alice');
    });

    test('not ok on isError', async () => {
        const client = stubClient('error');
        const result = await probeBeadsRemote(client, 'alice', 'https://example.invalid/x/beads.git');
        assert.equal(result.ok, false);
        assert.match(result.error, /not found/);
    });

    test('not ok on non-zero exitCode', async () => {
        const client = stubClient('nonzero-exit');
        const result = await probeBeadsRemote(client, 'alice', 'https://example.invalid/x/beads.git');
        assert.equal(result.ok, false);
    });

    test('not ok when the client throws (transport failure)', async () => {
        const client = stubClient('throws');
        const result = await probeBeadsRemote(client, 'alice', 'https://example.invalid/x/beads.git');
        assert.equal(result.ok, false);
        assert.match(result.error, /unreachable/);
    });
});

// =============================================================================
// apra-fleet-vcnl.15 -- probeBeadsRemote screens and quotes `remote` before it
// reaches a member. Mirrors ../checkout.mjs's own two-layer policy (screen at
// the edge via shellMetaCharError, then quote unconditionally via quoteArg,
// branching on the TARGET member's own registered shell). This call site was
// deliberately left unquoted by apra-fleet-vcnl.12 (scoped to checkout.mjs
// and health.mjs) and is fixed here.
// =============================================================================

describe('probeBeadsRemote quotes the emitted command for the resolved member shell', { skip }, () => {
    test('a POSIX member (no shell recorded) gets the remote single-quoted', async () => {
        const client = stubClient('ok', { members: [{ name: 'alice', os: 'linux' }] });
        const result = await probeBeadsRemote(client, 'alice', 'https://example.invalid/x/beads.git');
        assert.equal(result.ok, true);
        assert.equal(client.listMembersCalls.length, 1, 'resolves the target member record before building the command');
        assert.equal(client.calls.length, 1);
        assert.equal(client.calls[0].command, "git ls-remote 'https://example.invalid/x/beads.git' refs/dolt/data");
        assert.equal(client.calls[0].member_name, 'alice');
        assert.deepEqual(findShellCommandViolations(client.calls[0].command), [], 'command leaks shell expansion');
    });

    test('a PowerShell member (windows, pwsh7) gets the same single-quote style, never a backslash-escaped double quote', async () => {
        const client = stubClient('ok', { members: [{ name: 'winbox', os: 'windows', shell: 'pwsh7' }] });
        const remote = "https://example.invalid/o'brien/beads.git";
        const result = await probeBeadsRemote(client, 'winbox', remote);
        assert.equal(result.ok, true);
        assert.equal(client.calls[0].command, "git ls-remote 'https://example.invalid/o''brien/beads.git' refs/dolt/data");
        assert.ok(
            !client.calls[0].command.includes('\\"'),
            'a PowerShell member must never receive the POSIX backslash-escaped double quote',
        );
        assert.deepEqual(findShellCommandViolations(client.calls[0].command), [], 'command leaks shell expansion');
    });

    test('a client with no listMembers method at all (the narrower constructor contract) still probes, defaulting to POSIX quoting', async () => {
        const client = stubClient('ok'); // no `members` option -> no listMembers method, matching every other pre-existing test in this file
        assert.equal(typeof client.listMembers, 'undefined');
        const result = await probeBeadsRemote(client, 'alice', 'https://example.invalid/x/beads.git');
        assert.equal(result.ok, true);
        assert.equal(client.calls[0].command, "git ls-remote 'https://example.invalid/x/beads.git' refs/dolt/data");
    });

    test('a listMembers call that throws still probes, degrading to a null record rather than a thrown error', async () => {
        const client = stubClient('ok');
        client.listMembers = async () => { throw new Error('listMembers unreachable'); };
        const result = await probeBeadsRemote(client, 'alice', 'https://example.invalid/x/beads.git');
        assert.equal(result.ok, true);
        assert.equal(client.calls[0].command, "git ls-remote 'https://example.invalid/x/beads.git' refs/dolt/data");
    });
});

describe('probeBeadsRemote screens `remote` for shell metacharacters BEFORE any client call', { skip }, () => {
    const BACKTICK = String.fromCharCode(0x60);
    const cases = [
        ['a semicolon', 'https://example.invalid/x/beads.git;id'],
        ['a dollar-paren substitution', 'https://example.invalid/x/beads.git$(id)'],
        ['a backtick', `https://example.invalid/x/beads.git${BACKTICK}id${BACKTICK}`],
        ['an ampersand', 'https://example.invalid/x/beads.git&id'],
    ];
    for (const [label, remote] of cases) {
        test(`${label} in remote -> refused, zero execute_command calls, zero listMembers calls`, async () => {
            const client = stubClient('ok', { members: [{ name: 'alice', os: 'linux' }] });
            const result = await probeBeadsRemote(client, 'alice', remote);
            assert.equal(result.ok, false);
            assert.match(result.error, /must not contain the shell metacharacter/);
            assert.equal(client.calls.length, 0, 'the refusal path must never dispatch a command');
            assert.equal(client.listMembersCalls.length, 0, 'the screen runs before any client call, including listMembers');
        });
    }
});

describe('POST /api/projects -- create success', { skip }, () => {
    test('valid body with no beads.remote returns 201 and never probes', async () => {
        const { supervisor, client } = await setup();
        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects', validBody()), res);
        assert.equal(res.statusCode, 201);
        const project = payloadOf(res);
        assert.equal(project.id, 'proj-1');
        assert.equal(project.name, 'Project One');
        assert.equal(project.backlogMember, 'alice');
        assert.equal(project.beads.kind, 'clone');
        assert.equal(project.beads.dir, '/repo/.beads');
        assert.equal(project.beads.remote, null);
        assert.equal(client.calls.length, 0, 'no remote supplied -> no probe');
    });

    test('valid body WITH beads.remote probes exactly once on the backlogMember, then 201s', async () => {
        const { supervisor, client } = await setup('ok');
        const body = validBody({ id: 'proj-2', beads: { kind: 'clone', dir: '/repo/.beads', remote: 'https://example.invalid/o/beads.git' } });
        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects', body), res);
        assert.equal(res.statusCode, 201);
        assert.equal(client.calls.length, 1);
        assert.equal(client.calls[0].command, "git ls-remote 'https://example.invalid/o/beads.git' refs/dolt/data");
        assert.equal(client.calls[0].member_name, 'alice');
        const project = payloadOf(res);
        assert.equal(project.beads.remote, 'https://example.invalid/o/beads.git');
    });

    test('a client-supplied createdAt/updatedAt in the request body is ignored, not spoofed into the row (apra-fleet-vcnl.8)', async () => {
        // createProject() now accepts an explicit createdAt so bin/se.mjs's
        // importProject() can restore a project's original creation time
        // from a trusted export -- but this HTTP route is an untrusted
        // surface and must strip createdAt/updatedAt from the body before
        // delegating, so a client cannot spoof either timestamp.
        const { supervisor } = await setup();
        const before = new Date();
        const res = mockRes();
        await supervisor.handleRequest(
            mockReq('POST', '/api/projects', validBody({
                id: 'proj-spoof',
                createdAt: '1999-01-01T00:00:00.000Z',
                updatedAt: '1999-01-01T00:00:00.000Z',
            })),
            res,
        );
        assert.equal(res.statusCode, 201);
        const project = payloadOf(res);
        assert.notEqual(project.createdAt, '1999-01-01T00:00:00.000Z');
        assert.notEqual(project.updatedAt, '1999-01-01T00:00:00.000Z');
        assert.ok(new Date(project.createdAt) >= before, 'createdAt must reflect the actual create time, not the spoofed value');
    });
});

describe('POST /api/projects -- validation failures (400, {field, reason})', { skip }, () => {
    const cases = [
        { label: 'missing id', body: (() => { const b = validBody(); delete b.id; return b; })(), field: 'id' },
        { label: 'missing name', body: (() => { const b = validBody(); delete b.name; return b; })(), field: 'name' },
        { label: 'missing backlogMember', body: (() => { const b = validBody(); delete b.backlogMember; return b; })(), field: 'backlogMember' },
        { label: 'missing beads.dir', body: validBody({ beads: { kind: 'clone' } }), field: 'beads.dir' },
        { label: 'non-string id', body: validBody({ id: 42 }), field: 'id' },
    ];

    for (const { label, body, field } of cases) {
        test(`${label} -> 400 naming field '${field}'`, async () => {
            const { supervisor, client } = await setup();
            const res = mockRes();
            await supervisor.handleRequest(mockReq('POST', '/api/projects', body), res);
            assert.equal(res.statusCode, 400);
            const payload = payloadOf(res);
            assert.equal(payload.field, field);
            assert.ok(payload.reason, 'expects a human-readable reason');
            assert.ok(Array.isArray(payload.errors) && payload.errors.length > 0);
            assert.equal(client.calls.length, 0, 'a basic-field validation failure never reaches the remote probe');
        });
    }

    test('beads.remote supplied but backlogMember missing -> 400 on backlogMember, never probes', async () => {
        const { supervisor, client } = await setup();
        const body = validBody({ beads: { kind: 'clone', dir: '/repo/.beads', remote: 'https://example.invalid/o/beads.git' } });
        delete body.backlogMember;
        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects', body), res);
        assert.equal(res.statusCode, 400);
        assert.equal(payloadOf(res).field, 'backlogMember');
        assert.equal(client.calls.length, 0);
    });
});

describe('POST /api/projects -- duplicate id (409)', { skip }, () => {
    test('creating the same id twice 409s the second attempt', async () => {
        const { supervisor } = await setup();
        const first = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects', validBody()), first);
        assert.equal(first.statusCode, 201);

        const second = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects', validBody({ name: 'Project One Redux' })), second);
        assert.equal(second.statusCode, 409);
        assert.equal(payloadOf(second).field, 'id');
    });
});

describe('GET /api/projects/:id -- unknown id (404)', { skip }, () => {
    test('an id never created 404s', async () => {
        const { supervisor } = await setup();
        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects/does-not-exist'), res);
        assert.equal(res.statusCode, 404);
        assert.match(payloadOf(res).error, /does-not-exist/);
    });

    test('an id that WAS created round-trips via GET', async () => {
        const { supervisor } = await setup();
        await supervisor.handleRequest(mockReq('POST', '/api/projects', validBody()), mockRes());
        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects/proj-1'), res);
        assert.equal(res.statusCode, 200);
        assert.equal(payloadOf(res).id, 'proj-1');
    });
});

describe('PUT /api/projects/:id -- round-trip', { skip }, () => {
    test('a patch of non-remote fields returns 200 with the patched body, and GET reflects it', async () => {
        const { supervisor } = await setup();
        await supervisor.handleRequest(mockReq('POST', '/api/projects', validBody()), mockRes());

        const putRes = mockRes();
        await supervisor.handleRequest(
            mockReq('PUT', '/api/projects/proj-1', { name: 'Project One Renamed' }),
            putRes,
        );
        assert.equal(putRes.statusCode, 200);
        const patched = payloadOf(putRes);
        assert.equal(patched.id, 'proj-1');
        assert.equal(patched.name, 'Project One Renamed');

        const getRes = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects/proj-1'), getRes);
        assert.equal(getRes.statusCode, 200);
        assert.equal(payloadOf(getRes).name, 'Project One Renamed');
    });

    test('an unknown id 404s', async () => {
        const { supervisor } = await setup();
        const res = mockRes();
        await supervisor.handleRequest(
            mockReq('PUT', '/api/projects/does-not-exist', { name: 'New Name' }),
            res,
        );
        assert.equal(res.statusCode, 404);
        assert.match(payloadOf(res).error, /does-not-exist/);
    });
});

describe('PUT /api/projects/:id -- beads.remote probe (DQ-12, 972p.5)', { skip }, () => {
    test('a patch that omits beads.remote performs no probe and returns 200', async () => {
        const { supervisor, client } = await setup('ok');
        await supervisor.handleRequest(
            mockReq('POST', '/api/projects', validBody({ beads: { kind: 'clone', dir: '/repo/.beads', remote: 'https://example.invalid/o/beads.git' } })),
            mockRes(),
        );
        assert.equal(client.calls.length, 1, 'create probed once');

        const putRes = mockRes();
        await supervisor.handleRequest(mockReq('PUT', '/api/projects/proj-1', { name: 'Renamed' }), putRes);
        assert.equal(putRes.statusCode, 200);
        assert.equal(client.calls.length, 1, 'PUT omitting beads.remote must not probe again');
    });

    test('a patch that repeats the stored beads.remote value performs no probe and returns 200', async () => {
        const { supervisor, client } = await setup('ok');
        await supervisor.handleRequest(
            mockReq('POST', '/api/projects', validBody({ beads: { kind: 'clone', dir: '/repo/.beads', remote: 'https://example.invalid/o/beads.git' } })),
            mockRes(),
        );
        assert.equal(client.calls.length, 1, 'create probed once');

        const putRes = mockRes();
        await supervisor.handleRequest(
            mockReq('PUT', '/api/projects/proj-1', { beads: { remote: 'https://example.invalid/o/beads.git' } }),
            putRes,
        );
        assert.equal(putRes.statusCode, 200);
        assert.equal(client.calls.length, 1, 'PUT repeating the stored value must not probe again');
    });

    test('a patch with a NEW non-empty beads.remote whose probe succeeds returns 200 with the new remote', async () => {
        const { supervisor, client } = await setup('ok');
        await supervisor.handleRequest(mockReq('POST', '/api/projects', validBody()), mockRes());
        assert.equal(client.calls.length, 0, 'create had no remote -> no probe');

        const putRes = mockRes();
        await supervisor.handleRequest(
            mockReq('PUT', '/api/projects/proj-1', { beads: { remote: 'https://example.invalid/new/beads.git' } }),
            putRes,
        );
        assert.equal(putRes.statusCode, 200);
        assert.equal(payloadOf(putRes).beads.remote, 'https://example.invalid/new/beads.git');
        assert.equal(client.calls.length, 1, 'the changed remote was probed exactly once');
        assert.equal(client.calls[0].command, "git ls-remote 'https://example.invalid/new/beads.git' refs/dolt/data");
        assert.equal(client.calls[0].member_name, 'alice');
        assert.doesNotMatch(client.calls[0].command, /remote add/, 'DQ-12: never creates a remote');

        const getRes = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects/proj-1'), getRes);
        assert.equal(payloadOf(getRes).beads.remote, 'https://example.invalid/new/beads.git');
    });

    test('a patch with a NEW non-empty beads.remote whose probe fails 400s and leaves the stored row untouched', async () => {
        const { supervisor, client } = await setup('error');
        await supervisor.handleRequest(mockReq('POST', '/api/projects', validBody()), mockRes());
        assert.equal(client.calls.length, 0, 'create had no remote -> no probe');

        const putRes = mockRes();
        await supervisor.handleRequest(
            mockReq('PUT', '/api/projects/proj-1', { beads: { remote: 'https://example.invalid/bad/beads.git' } }),
            putRes,
        );
        assert.equal(putRes.statusCode, 400);
        const payload = payloadOf(putRes);
        assert.equal(payload.field, 'beads.remote');
        assert.ok(payload.reason, 'expects a human-readable reason');
        assert.equal(client.calls.length, 1, 'the probe was genuinely attempted');

        const getRes = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects/proj-1'), getRes);
        assert.equal(getRes.statusCode, 200);
        assert.equal(payloadOf(getRes).beads.remote, null, 'the failed probe left the stored row untouched');
        assert.equal(payloadOf(getRes).name, 'Project One', 'no partial write of other patched fields either');
    });
});

describe('PUT /api/projects/:id -- beads.remote probe never creates a remote (DQ-12, 972p.6)', { skip }, () => {
    test('no recorded command across create, omitted-PUT, repeated-PUT, a successful changed-PUT, and a failed changed-PUT ever contains "git remote add" or "git init"', async () => {
        // ok-path scenario: create with a remote, then omit/repeat/change across PUTs.
        const { supervisor: okSupervisor, client: okClient } = await setup('ok');
        await okSupervisor.handleRequest(
            mockReq('POST', '/api/projects', validBody({ beads: { kind: 'clone', dir: '/repo/.beads', remote: 'https://example.invalid/o/beads.git' } })),
            mockRes(),
        );
        await okSupervisor.handleRequest(mockReq('PUT', '/api/projects/proj-1', { name: 'Renamed' }), mockRes());
        await okSupervisor.handleRequest(
            mockReq('PUT', '/api/projects/proj-1', { beads: { remote: 'https://example.invalid/o/beads.git' } }),
            mockRes(),
        );
        await okSupervisor.handleRequest(
            mockReq('PUT', '/api/projects/proj-1', { beads: { remote: 'https://example.invalid/new/beads.git' } }),
            mockRes(),
        );

        // failing-probe scenario: create with no remote, then a changed-PUT whose probe fails.
        const { supervisor: errSupervisor, client: errClient } = await setup('error');
        await errSupervisor.handleRequest(mockReq('POST', '/api/projects', validBody()), mockRes());
        await errSupervisor.handleRequest(
            mockReq('PUT', '/api/projects/proj-1', { beads: { remote: 'https://example.invalid/bad/beads.git' } }),
            mockRes(),
        );

        const allCalls = [...okClient.calls, ...errClient.calls];
        assert.ok(allCalls.length > 0, 'expected the scenarios above to have recorded probe commands');
        for (const call of allCalls) {
            assert.doesNotMatch(call.command, /git remote add/, 'DQ-12: the console validates a remote, it never creates one');
            assert.doesNotMatch(call.command, /git init/, 'DQ-12: the console validates a remote, it never inits one');
        }
    });
});

describe('PUT /api/projects/:id probe reuses the single checkBeadsRemote gate', () => {
    test('projects.mjs contains exactly one call site of probeBeadsRemote (inside checkBeadsRemote, not per-handler)', async () => {
        const modulePath = path.join(import.meta.dirname, '..', 'src', 'projects', 'routes', 'projects.mjs');
        const contents = await fsp.readFile(modulePath, 'utf8');
        const matches = contents.match(/await probeBeadsRemote\(client/g) ?? [];
        assert.equal(matches.length, 1, 'expected exactly one probeBeadsRemote(client...) call site, inside checkBeadsRemote');
    });
});

describe('DELETE /api/projects/:id -- round-trip', { skip }, () => {
    test('deleting an existing project returns 200 {deleted:true, id}, then GET 404s', async () => {
        const { supervisor } = await setup();
        await supervisor.handleRequest(mockReq('POST', '/api/projects', validBody()), mockRes());

        const delRes = mockRes();
        await supervisor.handleRequest(mockReq('DELETE', '/api/projects/proj-1'), delRes);
        assert.equal(delRes.statusCode, 200);
        assert.deepEqual(payloadOf(delRes), { deleted: true, id: 'proj-1' });

        const getRes = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects/proj-1'), getRes);
        assert.equal(getRes.statusCode, 404);
    });

    test('an unknown id 404s', async () => {
        const { supervisor } = await setup();
        const res = mockRes();
        await supervisor.handleRequest(mockReq('DELETE', '/api/projects/does-not-exist'), res);
        assert.equal(res.statusCode, 404);
        assert.match(payloadOf(res).error, /does-not-exist/);
    });
});

describe('registerProjectRoutes is still NOT mounted on the live supervisor', () => {
    test('no file under src/supervisor/ imports or calls registerProjectRoutes', async () => {
        const supervisorDir = path.join(import.meta.dirname, '..', 'src', 'supervisor');
        const entries = await fsp.readdir(supervisorDir, { withFileTypes: true, recursive: true });
        const files = entries
            .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
            .map((e) => path.join(e.parentPath ?? e.path, e.name));
        assert.ok(files.length > 0, 'expected at least one .mjs file under src/supervisor/');
        for (const file of files) {
            const contents = await fsp.readFile(file, 'utf8');
            assert.ok(
                !contents.includes('registerProjectRoutes'),
                `${path.relative(supervisorDir, file)} must not reference registerProjectRoutes`,
            );
        }
    });
});

describe('POST /api/projects -- failed remote probe (400, DQ-12)', { skip }, () => {
    test('an MCP-level isError probe result 400s on field beads.remote and creates nothing', async () => {
        const { supervisor, client, store } = await setup('error');
        const body = validBody({ beads: { kind: 'clone', dir: '/repo/.beads', remote: 'https://example.invalid/o/beads.git' } });
        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects', body), res);
        assert.equal(res.statusCode, 400);
        assert.equal(payloadOf(res).field, 'beads.remote');
        assert.equal(client.calls.length, 1, 'the probe was genuinely attempted');
        assert.equal(client.calls[0].command, "git ls-remote 'https://example.invalid/o/beads.git' refs/dolt/data");

        // DQ-12: no row is left behind by a failed probe -- the console never
        // creates the remote OR the project row when the probe fails.
        const getRes = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects/proj-1'), getRes);
        assert.equal(getRes.statusCode, 404);
        void store;
    });

    test('a non-zero exitCode probe result also 400s on field beads.remote', async () => {
        const { supervisor, client } = await setup('nonzero-exit');
        const body = validBody({ beads: { kind: 'clone', dir: '/repo/.beads', remote: 'https://example.invalid/o/beads.git' } });
        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects', body), res);
        assert.equal(res.statusCode, 400);
        assert.equal(payloadOf(res).field, 'beads.remote');
        assert.equal(client.calls.length, 1);
    });

    test('a thrown transport failure also 400s on field beads.remote', async () => {
        const { supervisor, client } = await setup('throws');
        const body = validBody({ beads: { kind: 'clone', dir: '/repo/.beads', remote: 'https://example.invalid/o/beads.git' } });
        const res = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects', body), res);
        assert.equal(res.statusCode, 400);
        assert.equal(payloadOf(res).field, 'beads.remote');
        assert.equal(client.calls.length, 1);
    });
});
