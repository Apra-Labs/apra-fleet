import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { createDashboardViewer } from '../src/viewer/index.mjs';
import { tryRivalBind } from './rival-bind-helper.mjs';

// Tests for apra-fleet-eft.37.4 (M3, docs/workflow-core-boundary-refactoring.md):
// the former apra-fleet-eft.27.2 GET /beads/:id/description endpoint was
// replaced with a GENERIC on-demand-detail hook. Core no longer knows
// anything about a 'beads' extension's shape (sprintTasks/backlogTasks) --
// it only knows that ANY dashboard extension may register
// `detailLookup(state, id) => {text, updatedAt} | null`, and serves
// GET /extensions/:extId/detail/:itemId by delegating to whichever
// registered extension's `id` matches `:extId`. The old route now lives on
// as a one-release BOUNDARY-COMPAT redirect alias (see the route's own
// comment in src/viewer/index.mjs) to the new generic route under the
// 'beads' extension id specifically, so these tests cover BOTH the
// extension-agnostic generic route (with a made-up, non-beads extension id,
// proving core carries no beads-specific knowledge) and the alias's
// redirect behavior.

function httpGetFull(port, urlPath) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
        }).on('error', reject);
    });
}

async function withServer(server, fn) {
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    try {
        return await fn(server.address().port);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

// apra-fleet-i9ag.15.10: attempt a rival HTTP listener on the SAME loopback
// port the viewer already owns, via the shared tryRivalBind() helper
// (apra-fleet-i9ag.15.14 -- previously a near-verbatim local copy here).
// Resolves { code: 'EADDRINUSE', close } if the bind was correctly refused
// (the exclusive-bind contract holding), or { code: null, close } if the
// rival's bind unexpectedly succeeded (the silent port-hijack condition
// apra-fleet-i9ag.15.9 fixed).
function tryRivalLoopbackBind(port) {
    return tryRivalBind({ port, host: '127.0.0.1' });
}

// createDashboardViewer() persists sprint state under process.cwd() -- run
// every test in this file against a fresh temp cwd so nothing is written
// into the real repo checkout.
let __cwdGuardOriginal;
let __cwdGuardTemp;
beforeEach(() => {
    __cwdGuardTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-bead-desc-test-cwd-'));
    __cwdGuardOriginal = process.cwd();
    process.chdir(__cwdGuardTemp);
});
afterEach(() => {
    process.chdir(__cwdGuardOriginal);
    fs.rmSync(__cwdGuardTemp, { recursive: true, force: true });
});

function createMockFleetApi() {
    return {
        async executePrompt() { return { content: [{ text: 'ok' }] }; },
        async executeCommand() { return { content: [{ text: 'ok' }], isError: false }; }
    };
}

describe('apra-fleet-eft.37.4: GET /extensions/:extId/detail/:itemId (generic hook)', () => {
    test('delegates to the matching extension\'s detailLookup and returns {id, text, updatedAt}', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const stuffExtension = {
            id: 'stuff',
            title: 'Stuff',
            js: '',
            detailLookup(state, id) {
                if (id !== 'item-1') return null;
                return { text: 'the full text', updatedAt: 'v1' };
            }
        };
        const server = createDashboardViewer(wf, { port: 0, name: 'Detail Hook Test', dashboardExtensions: [stuffExtension] });

        await withServer(server, async (port) => {
            const { statusCode, body } = await httpGetFull(port, '/extensions/stuff/detail/item-1');
            assert.equal(statusCode, 200);
            const parsed = JSON.parse(body);
            assert.equal(parsed.id, 'item-1');
            assert.equal(parsed.text, 'the full text');
            assert.equal(parsed.updatedAt, 'v1');
        });
    });

    test('an extension whose detailLookup returns null (unknown item) yields 404, not a crash', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const stuffExtension = { id: 'stuff', title: 'Stuff', js: '', detailLookup() { return null; } };
        const server = createDashboardViewer(wf, { port: 0, name: 'Detail Hook 404 Test', dashboardExtensions: [stuffExtension] });

        await withServer(server, async (port) => {
            const { statusCode } = await httpGetFull(port, '/extensions/stuff/detail/does-not-exist');
            assert.equal(statusCode, 404);
        });
    });

    test('an unknown extension id yields 404, not a crash', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const server = createDashboardViewer(wf, { port: 0, name: 'Detail Hook Unknown Ext Test' });

        await withServer(server, async (port) => {
            const { statusCode } = await httpGetFull(port, '/extensions/does-not-exist/detail/item-1');
            assert.equal(statusCode, 404);
        });
    });

    test('a registered extension with no detailLookup at all yields 404, not a crash (default no-op)', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const noHookExtension = { id: 'no-hook', title: 'No Hook', js: '' };
        const server = createDashboardViewer(wf, { port: 0, name: 'Detail Hook No-Op Test', dashboardExtensions: [noHookExtension] });

        await withServer(server, async (port) => {
            const { statusCode } = await httpGetFull(port, '/extensions/no-hook/detail/item-1');
            assert.equal(statusCode, 404);
        });
    });

    test('core carries no beads-specific knowledge: an arbitrary extension id works identically to "beads" would', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const arbitraryExtension = {
            id: 'totally-unrelated-domain',
            title: 'Unrelated',
            js: '',
            detailLookup(state, id) { return { text: 'domain-agnostic text for ' + id, updatedAt: null }; }
        };
        const server = createDashboardViewer(wf, { port: 0, name: 'Detail Hook Generic Test', dashboardExtensions: [arbitraryExtension] });

        await withServer(server, async (port) => {
            const { statusCode, body } = await httpGetFull(port, '/extensions/totally-unrelated-domain/detail/x');
            assert.equal(statusCode, 200);
            assert.equal(JSON.parse(body).text, 'domain-agnostic text for x');
        });
    });

    // apra-fleet-i9ag.15.10: generalization half of the apra-fleet-i9ag.15.9
    // pin. The triage that closed apra-fleet-i9ag.15.9 proved the fix is a
    // LISTENER-level guard (exclusive loopback bind in createDashboardViewer,
    // see src/viewer/index.mjs), not a per-route patch -- so it must cover
    // every route the viewer serves, not just the alias below. This is the
    // "natural sibling" route named in apra-fleet-i9ag.15.10's task
    // description: GET /extensions/:extId/detail/:itemId.
    test('apra-fleet-i9ag.15.9: the generic detail route also survives a rival loopback bind on the same port -- the exclusive-bind guard is listener-level, not alias-specific', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const stuffExtension = {
            id: 'stuff',
            title: 'Stuff',
            js: '',
            detailLookup(state, id) { return id === 'item-1' ? { text: 'the full text', updatedAt: 'v1' } : null; }
        };
        const server = createDashboardViewer(wf, { port: 0, name: 'Detail Hook Bind Hijack Test', dashboardExtensions: [stuffExtension] });

        await withServer(server, async (port) => {
            const rival = await tryRivalLoopbackBind(port);
            try {
                assert.equal(
                    rival.code,
                    'EADDRINUSE',
                    'a rival loopback bind on the viewer\'s live port must be refused -- see the alias test below for ' +
                    'why an unrefused rival bind means routes can silently answer from the wrong socket'
                );
                const { statusCode, body } = await httpGetFull(port, '/extensions/stuff/detail/item-1');
                assert.equal(statusCode, 200, 'the generic detail route must still be answered by the real viewer');
                assert.equal(JSON.parse(body).text, 'the full text');
            } finally {
                await rival.close();
            }
        });
    });
});

describe('apra-fleet-eft.37.4: GET /beads/:id/description (BOUNDARY-COMPAT one-release alias)', () => {
    test('redirects (302) to the generic route under the beads extension id', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const server = createDashboardViewer(wf, { port: 0, name: 'Bead Alias Redirect Test' });

        await withServer(server, async (port) => {
            const { statusCode, headers } = await httpGetFull(port, '/beads/bd-1/description');
            assert.equal(statusCode, 302);
            assert.equal(headers.location, '/extensions/beads/detail/bd-1');
        });
    });

    test('the alias is a dumb redirect -- it never reaches into state itself, regardless of what is published', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const server = createDashboardViewer(wf, { port: 0, name: 'Bead Alias No-State-Touch Test' });

        await withServer(server, async (port) => {
            wf.publishState('beads', { sprintTasks: [{ id: 'bd-1', description: 'd' }], backlogTasks: [] });
            const { statusCode, headers } = await httpGetFull(port, '/beads/bd-1/description');
            assert.equal(statusCode, 302);
            assert.equal(headers.location, '/extensions/beads/detail/bd-1');
        });
    });

    // apra-fleet-i9ag.15.10: pins the mechanism apra-fleet-i9ag.15.9's
    // triage named for the intermittent "404 instead of 302" seen here under
    // full-suite concurrency.
    //
    // MECHANISM (from apra-fleet-i9ag.15.9's fix, src/viewer/index.mjs): the
    // 404 provably could not come from this alias route -- it is an
    // unconditional `else if` in one synchronous http.createServer handler,
    // with no route table and no async registration, so it answers 302 from
    // the very first accepted connection. That ruled out a registration or
    // readiness race; 'listening' was never the wrong signal here. The real
    // cause was the LISTENER'S BIND: createDashboardViewer() used to call
    // `server.listen(port, cb)` with no host, which binds the OS WILDCARD
    // address. A wildcard bind does not give a process exclusive ownership
    // of 127.0.0.1:<port> -- a second process can still bind that exact port
    // on the loopback address specifically (both sockets carry
    // SO_REUSEADDR), and the kernel's most-specific-match routing then hands
    // the newcomer every loopback connection meant for the real viewer.
    // Neither side errors: the real viewer stays "listening" on a port it no
    // longer serves, and this alias request below would silently reach the
    // impostor instead and get its 404. The fix binds
    // `{ port, host: '127.0.0.1', exclusive: true }`, so a second loopback
    // bind on this port now fails loudly with EADDRINUSE and cannot steal
    // the connection below.
    //
    // Revert-check: reverting src/viewer/index.mjs's
    // `server.listen({ port, host, exclusive: true }, ...)` back to the
    // pre-fix `server.listen(port, cb)` makes the rival bind below succeed
    // (code stays `null` instead of 'EADDRINUSE'), which fails this test's
    // first assertion immediately -- confirmed by hand against the pre-fix
    // source while writing this test.
    test('apra-fleet-i9ag.15.9: the alias survives a rival loopback bind attempt on the same port -- it never answers a stolen-socket 404', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const server = createDashboardViewer(wf, { port: 0, name: 'Bead Alias Bind Hijack Test' });

        await withServer(server, async (port) => {
            const rival = await tryRivalLoopbackBind(port);
            try {
                assert.equal(
                    rival.code,
                    'EADDRINUSE',
                    'a rival process must not be able to grab the viewer\'s live loopback port -- if it can, the ' +
                    'viewer is bound to the wildcard address again and this alias request is no longer guaranteed ' +
                    'to reach it (the intermittent-404 bug apra-fleet-i9ag.15.9 fixed)'
                );

                const { statusCode, headers } = await httpGetFull(port, '/beads/bd-1/description');
                assert.equal(statusCode, 302, 'the alias must still answer 302, never the stolen-socket 404');
                assert.equal(headers.location, '/extensions/beads/detail/bd-1');
            } finally {
                await rival.close();
            }
        });
    });
});
