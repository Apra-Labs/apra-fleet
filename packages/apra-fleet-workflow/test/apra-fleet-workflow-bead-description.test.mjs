import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { createDashboardViewer } from '../src/viewer/index.mjs';

// Tests for apra-fleet-eft.27.2: an on-demand GET /beads/:id/description
// endpoint.
//
// apra-fleet-eft.27.1 taught GET /state to strip every bead's full
// `description` down to a short `summary` (lean-state.mjs) so the recurring
// poll payload stays small -- these tests confirm the endpoint that recovers
// the full text on demand: it must read the LIVE, full-fidelity
// `state.extensions.beads` data (never the leaned /state projection), find
// the bead in either sprintTasks or backlogTasks, and 404 for an unknown id.

function httpGetFull(port, urlPath) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
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

describe('apra-fleet-eft.27.2: GET /beads/:id/description', () => {
    test('returns the full description + updatedAt for a bead in sprintTasks', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const server = createDashboardViewer(wf, { port: 0, name: 'Bead Description Test' });

        await withServer(server, async (port) => {
            const bigDescription = 'D'.repeat(5000);
            wf.publishState('beads', {
                sprintTasks: [{ id: 'bd-1', title: 'Task 1', status: 'open', description: bigDescription, updated_at: '2026-07-20T00:00:00Z' }],
                backlogTasks: []
            });

            // The lean /state projection must NOT carry the full description
            // (apra-fleet-eft.27.1) -- the on-demand endpoint is the only way
            // to get it back.
            const state = JSON.parse((await httpGetFull(port, '/state')).body);
            assert.ok(!JSON.stringify(state).includes(bigDescription), 'GET /state must never carry the full description');

            const { statusCode, body } = await httpGetFull(port, '/beads/bd-1/description');
            assert.equal(statusCode, 200);
            const parsed = JSON.parse(body);
            assert.equal(parsed.id, 'bd-1');
            assert.equal(parsed.description, bigDescription);
            assert.equal(parsed.updatedAt, '2026-07-20T00:00:00Z');
        });
    });

    test('finds a bead in backlogTasks too, not just sprintTasks', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const server = createDashboardViewer(wf, { port: 0, name: 'Bead Description Backlog Test' });

        await withServer(server, async (port) => {
            wf.publishState('beads', {
                sprintTasks: [],
                backlogTasks: [{ id: 'bd-backlog-1', title: 'Backlog item', status: 'open', description: 'backlog description', updated_at: '2026-07-19T00:00:00Z' }]
            });

            const { statusCode, body } = await httpGetFull(port, '/beads/bd-backlog-1/description');
            assert.equal(statusCode, 200);
            const parsed = JSON.parse(body);
            assert.equal(parsed.description, 'backlog description');
        });
    });

    test('an unknown bead id returns 404, not a crash', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const server = createDashboardViewer(wf, { port: 0, name: 'Bead Description 404 Test' });

        await withServer(server, async (port) => {
            wf.publishState('beads', { sprintTasks: [{ id: 'bd-1', title: 't', description: 'd' }], backlogTasks: [] });
            const { statusCode } = await httpGetFull(port, '/beads/does-not-exist/description');
            assert.equal(statusCode, 404);
        });
    });

    test('returns 404 (not a crash) when no beads state has been published yet', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const server = createDashboardViewer(wf, { port: 0, name: 'Bead Description No Extension Test' });

        await withServer(server, async (port) => {
            const { statusCode } = await httpGetFull(port, '/beads/bd-1/description');
            assert.equal(statusCode, 404);
        });
    });
});
