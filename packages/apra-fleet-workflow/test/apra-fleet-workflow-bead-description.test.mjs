import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { createDashboardViewer } from '../src/viewer/index.mjs';

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
});
