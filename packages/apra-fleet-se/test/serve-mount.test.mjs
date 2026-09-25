import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { isNodeSqliteAvailable, openStore } from '../src/projects/store/db.mjs';
import { registerProjectRoutes } from '../src/projects/routes/projects.mjs';
import { registerUiRoutes } from '../src/registration/ui-placeholder.mjs';
import { registerProjectsStoreUnavailableRoutes } from '../bin/serve.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { PACKAGE_ID, buildManifest } from '../src/registration/manifest.mjs';
import { deriveUpstreamCredential } from '@apralabs/apra-fleet-client/auth/local-token';

// =============================================================================
// apra-fleet-g6ap.3.2 -- five named cases proving bin/serve.mjs's project-
// routes/store/`/ui`/guard wiring (apra-fleet-g6ap.3.1), driven by
// constructing "a supervisor built the way serve.mjs builds it" in-process
// (createSupervisor + the SAME registerProjectRoutes / registerUiRoutes /
// registerProjectsStoreUnavailableRoutes exports bin/serve.mjs itself calls)
// rather than spawning the real subprocess -- this mirrors
// test/projects-routes.test.mjs's own established convention and lets case 4
// force a store-unavailable path deterministically without needing to break
// node:sqlite on the actual test runtime.
// =============================================================================

const HAS_SQLITE = isNodeSqliteAvailable();
const sqliteSkip = HAS_SQLITE ? false : 'node:sqlite is unavailable on this Node runtime';

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
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'se-servemount-'));
    tmpDirs.push(dir);
    const store = openStore({ dataDir: dir });
    openStores.push(store);
    return store;
}

/** A stub fleet client -- executeCommand is never actually exercised by any
 *  case in this file (no case here posts a beads.remote), so it just needs
 *  to be present to satisfy registerProjectRoutes()'s constructor guard. */
function stubClient() {
    return { async executeCommand() { return { isError: false, content: [{ text: '' }], structuredContent: { exitCode: 0 } }; } };
}

/** Mock req/res driving supervisor.handleRequest directly (mirrors
 *  test/projects-routes.test.mjs's own helper of the same name). */
function mockReq(method, url, { headers = {}, body } = {}) {
    const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
    return {
        method,
        url,
        headers,
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
        writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
        end(body) { this.body = body; },
    };
}
const payloadOf = (res) => (res.body ? JSON.parse(res.body) : null);

/** Build a supervisor + mount the project routes exactly the way
 *  bin/serve.mjs does (given a store already opened by the caller). */
function mountServeStyle({ token, store, client = stubClient() }) {
    const supervisor = createSupervisor({ token });
    registerProjectRoutes(supervisor, { store, client });
    registerUiRoutes(supervisor);
    return supervisor;
}

describe('serve-mount: /api/projects, /ui, store-unavailable, proxy-hop credential', () => {
    test('GET /api/projects with the token -> 200 []; POST creates a project and GET lists it', { skip: sqliteSkip }, async () => {
        const store = await freshStore();
        const token = 'a'.repeat(64);
        const supervisor = mountServeStyle({ token, store });

        const listBefore = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects', { headers: { authorization: `Bearer ${token}` } }), listBefore);
        assert.equal(listBefore.statusCode, 200);
        assert.deepEqual(payloadOf(listBefore), { projects: [] });

        const created = mockRes();
        await supervisor.handleRequest(mockReq('POST', '/api/projects', {
            headers: { authorization: `Bearer ${token}` },
            body: { id: 'proj1', name: 'Project One', backlogMember: 'akhil', beads: { dir: '/tmp/proj1' } },
        }), created);
        assert.equal(created.statusCode, 201);
        assert.equal(payloadOf(created).id, 'proj1');

        const listAfter = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects', { headers: { authorization: `Bearer ${token}` } }), listAfter);
        assert.equal(listAfter.statusCode, 200);
        assert.deepEqual(payloadOf(listAfter), { projects: [{ ...payloadOf(created) }] });
    });

    test('GET /api/projects without a credential -> 401 (guard still applies)', { skip: sqliteSkip }, async () => {
        const store = await freshStore();
        const token = 'b'.repeat(64);
        const supervisor = mountServeStyle({ token, store });

        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects', {}), res);
        assert.equal(res.statusCode, 401);
    });

    test('GET /ui and GET /ui/projects without a token -> 200 text/html placeholder', { skip: sqliteSkip }, async () => {
        const store = await freshStore();
        const token = 'c'.repeat(64);
        const supervisor = mountServeStyle({ token, store });

        const uiRes = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/ui', {}), uiRes);
        assert.equal(uiRes.statusCode, 200);
        assert.ok(uiRes.headers['Content-Type'].includes('text/html'));
        assert.ok(uiRes.body.includes('fleet-supervisor UI arrives in a later sprint'));

        const uiProjectsRes = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/ui/projects', {}), uiProjectsRes);
        assert.equal(uiProjectsRes.statusCode, 200);
        assert.ok(uiProjectsRes.headers['Content-Type'].includes('text/html'));
        assert.ok(uiProjectsRes.body.includes('fleet-supervisor UI arrives in a later sprint'));
    });

    test('GET /ui/panels/git (two-segment manifest panel path) without a token -> 200 text/html placeholder', async () => {
        // apra-fleet-g6ap.11: manifest.mjs declares panels: [{path: '/ui/panels/git'}],
        // a TWO-segment path -- server.mjs's `:param` matcher only ever matches
        // one segment, so a bare /ui/:rest pattern route cannot reach this path.
        // registerUiRoutes() must register it as its own exact route (derived
        // from the manifest itself) for the shell's panel iframe not to 404.
        const token = 'f'.repeat(64);
        const supervisor = createSupervisor({ token });
        registerUiRoutes(supervisor);

        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/ui/panels/git', {}), res);
        assert.equal(res.statusCode, 200);
        assert.ok(res.headers['Content-Type'].includes('text/html'));
        assert.ok(res.body.includes('fleet-supervisor UI arrives in a later sprint'));
    });

    test('every nav[].path and panels[].path buildManifest() declares resolves to 200 text/html against the placeholder', async () => {
        // Guards against the manifest ever outrunning the placeholder's routes
        // again: whatever paths buildManifest() declares -- of ANY depth --
        // must all answer 200, not just the ones the routing table happens to
        // hardcode today.
        const token = 'g'.repeat(64);
        const supervisor = createSupervisor({ token });
        registerUiRoutes(supervisor);

        const manifest = buildManifest({ baseUrl: 'http://127.0.0.1:1' });
        const declaredPaths = [...manifest.nav, ...manifest.panels].map((entry) => entry.path);
        assert.ok(declaredPaths.length > 0, 'expected buildManifest() to declare at least one nav/panel path');

        for (const path of declaredPaths) {
            const res = mockRes();
            // eslint-disable-next-line no-await-in-loop
            await supervisor.handleRequest(mockReq('GET', path, {}), res);
            assert.equal(res.statusCode, 200, `expected GET ${path} -> 200, got ${res.statusCode}`);
            assert.ok(res.headers['Content-Type'].includes('text/html'), `expected GET ${path} -> text/html`);
        }
    });

    test('store-unavailable: supervisor starts, GET /api/projects -> 503 store-unavailable', async () => {
        // No openStore() call at all here -- this proves
        // registerProjectsStoreUnavailableRoutes() itself (the exact fallback
        // bin/serve.mjs calls when openStore() throws NodeSqliteUnavailableError),
        // which is deterministic regardless of whether node:sqlite is actually
        // available on this test runtime.
        const token = 'd'.repeat(64);
        const supervisor = createSupervisor({ token });
        registerProjectsStoreUnavailableRoutes(supervisor, 'node:sqlite is not available on this Node runtime (vX.Y.Z)');
        registerUiRoutes(supervisor);

        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects', { headers: { authorization: `Bearer ${token}` } }), res);
        assert.equal(res.statusCode, 503);
        const payload = payloadOf(res);
        assert.equal(payload.error, 'store-unavailable');
        assert.ok(typeof payload.detail === 'string' && payload.detail.length > 0);

        // The supervisor as a whole is still up -- /ui (unguarded) still answers.
        const uiRes = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/ui', {}), uiRes);
        assert.equal(uiRes.statusCode, 200);
    });

    test('proxy hop: Bearer deriveUpstreamCredential(fleetKey, "se") -> 200 with the project list; derived for another id -> 401', { skip: sqliteSkip }, async () => {
        const store = await freshStore();
        const fleetKey = 'e'.repeat(64);
        const supervisor = mountServeStyle({ token: fleetKey, store });

        // What src/console/proxy.ts forwards on the /ext/se/* hop: ONLY the
        // derived credential on the bearer header, no cookie.
        const derivedSe = deriveUpstreamCredential(fleetKey, PACKAGE_ID);
        const proxyRes = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects', { headers: { authorization: `Bearer ${derivedSe}` } }), proxyRes);
        assert.equal(proxyRes.statusCode, 200);
        assert.deepEqual(payloadOf(proxyRes), { projects: [] });

        const derivedOther = deriveUpstreamCredential(fleetKey, 'not-se');
        const otherRes = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/projects', { headers: { authorization: `Bearer ${derivedOther}` } }), otherRes);
        assert.equal(otherRes.statusCode, 401);
    });
});
