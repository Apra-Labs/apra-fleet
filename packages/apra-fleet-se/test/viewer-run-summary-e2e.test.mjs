// End-to-end: a real createDashboardViewer wired with the real
// beadsExtension serves a once-per-publish progress summary at
// GET /state?summary=1.
//
// The viewer is started on an ephemeral port with dashboardExtensions
// [beadsExtension] and a minimal EventEmitter workflow stand-in; beads state
// is published through the same 'state' event ({ namespace, data }) that
// FleetWorkflow.publishState() emits for the runner.
//
// Regression guard: removing the summary branch of the viewer's /state
// route makes GET /state?summary=1 fall through to the full lean payload.
// The summaryVersion === 1 assertion (first in 'serves the beads
// summary...', also checked in 'before any beads publish...') catches it
// as `undefined !== 1`, and 'a 200-bead summary body stays under 2048
// bytes' catches it independently on size (~44 KB without the branch).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { createDashboardViewer } from '@apralabs/apra-fleet-workflow/viewer';
import { beadsExtension } from '../fleet-sprint/viewer-extensions.mjs';
import { computeSprintProgress } from '../fleet-sprint/sprint-progress.mjs';

const RUN_ID = 'summary-e2e-run';
const DEBOUNCE_MS = 200;
const FETCHED_AT = '2026-01-02T03:04:05.000Z';

function httpGet(port, urlPath) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode, headers: res.headers, body, json: JSON.parse(body) });
            });
        }).on('error', reject);
    });
}

// Sprint-tree fixture with a below-goal bead (P4 vs goalMax 2) and a
// decomposed parent (T), both excluded from the progress counts.
const FIXTURE = {
    sprintTasks: [
        { id: 'T', title: 'target', status: 'open', priority: 1 },
        { id: 'T.1', parent: 'T', title: 'done', status: 'closed', priority: 1 },
        { id: 'T.2', parent: 'T', title: 'open', status: 'open', priority: 2 },
        { id: 'T.3', parent: 'T', title: 'also done', status: 'closed', priority: 2 },
        { id: 'T.4', parent: 'T', title: 'below goal', status: 'open', priority: 4 },
    ],
    goalMax: 2,
    decomposedParentIds: ['T'],
    fetchedAt: FETCHED_AT,
};

function bigFixture(n) {
    const sprintTasks = [{ id: 'B', title: 'big target', status: 'open', priority: 1 }];
    for (let i = 0; i < n; i++) {
        sprintTasks.push({
            id: `B.${i}`,
            parent: 'B',
            title: `bead number ${i} with a reasonably long title to bulk up the payload`,
            description: 'x'.repeat(400),
            status: i % 3 === 0 ? 'closed' : 'open',
            priority: 2,
        });
    }
    return { sprintTasks, goalMax: 2, decomposedParentIds: ['B'], fetchedAt: FETCHED_AT };
}

describe('child viewer serves a once-per-publish beads summary at GET /state?summary=1', () => {
    let tmpDir;
    let server;
    let port;
    let wf;
    let summarizeCalls = 0;
    const countingBeads = {
        ...beadsExtension,
        summarize(data) {
            summarizeCalls++;
            return beadsExtension.summarize(data);
        },
    };

    before(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-se-summary-e2e-'));
        wf = new EventEmitter();
        server = createDashboardViewer(wf, {
            port: 0,
            runId: RUN_ID,
            name: 'Summary E2E',
            dashboardExtensions: [countingBeads],
            debouncedStatePath: path.join(tmpDir, 'running.json'),
            debounceMs: DEBOUNCE_MS,
            stateSnapshotDir: path.join(tmpDir, 'snapshots'),
        });
        if (!server.listening) {
            await new Promise((resolve, reject) => {
                server.once('listening', resolve);
                server.once('error', reject);
            });
        }
        port = server.address().port;
    });

    after(async () => {
        await new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
        });
        // Let any pending debounced state write land, then remove it all.
        await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 150));
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('before any beads publish, extensions has no beads key', async () => {
        const r = await httpGet(port, '/state?summary=1');
        assert.equal(r.status, 200);
        assert.equal(r.json.summaryVersion, 1);
        assert.ok(!('beads' in r.json.extensions));
        assert.equal(summarizeCalls, 0);
    });

    test('serves the beads summary computed once from the published payload', async () => {
        const reqStart = Date.now();
        wf.emit('state', { namespace: 'beads', data: FIXTURE });
        const r = await httpGet(port, '/state?summary=1');
        assert.equal(r.json.summaryVersion, 1);
        assert.equal(r.status, 200);
        assert.match(r.headers['content-type'], /application\/json/);
        assert.equal(r.json.runId, RUN_ID);
        assert.ok(!('tree' in r.json) && !('_strings' in r.json));

        const expected = computeSprintProgress(FIXTURE.sprintTasks, {
            goalMax: FIXTURE.goalMax,
            decomposedParentIds: FIXTURE.decomposedParentIds,
        });
        const beads = r.json.extensions.beads;
        assert.equal(beads.closed, expected.closed);
        assert.equal(beads.required, expected.required);
        assert.equal(beads.fraction, expected.fraction);
        // Fixture sanity: below-goal T.4 and decomposed parent T excluded.
        assert.deepEqual([beads.closed, beads.required], [2, 3]);
        // computed_at is the runner's fetch time, not the request time.
        assert.equal(beads.computed_at, FETCHED_AT);
        assert.ok(Date.parse(beads.publishedAt) >= reqStart - 1000);
        assert.deepEqual(Object.keys(beads).sort(), ['closed', 'computed_at', 'fraction', 'publishedAt', 'required']);
    });

    test('10 summary requests after one publish call summarize exactly once', async () => {
        const base = summarizeCalls;
        wf.emit('state', { namespace: 'beads', data: FIXTURE });
        for (let i = 0; i < 10; i++) {
            const r = await httpGet(port, `/state?summary=1&_t=${i}`);
            assert.equal(r.json.extensions.beads.required, 3);
        }
        assert.equal(summarizeCalls - base, 1);
    });

    test('a beadsIdentity publish leaves extensions.beads unchanged and calls no summarize', async () => {
        const before = (await httpGet(port, '/state?summary=1')).json.extensions.beads;
        const base = summarizeCalls;
        wf.emit('state', { namespace: 'beadsIdentity', data: { members: [{ member: 'm1', dbPath: '/x/.beads' }] } });
        const after = (await httpGet(port, '/state?summary=1')).json;
        assert.deepEqual(after.extensions.beads, before);
        assert.ok(!('beadsIdentity' in after.extensions));
        assert.equal(summarizeCalls - base, 0);
    });

    test('plain GET /state?_t=1 still returns the lean payload', async () => {
        const r = await httpGet(port, '/state?_t=1');
        assert.ok(Array.isArray(r.json._strings), 'lean payload has _strings');
        assert.ok(Array.isArray(r.json.tree), 'lean payload has tree');
        assert.ok(r.json.extensions && r.json.extensions.beads, 'lean payload carries raw extension data');
    });

    test('a 200-bead summary body stays under 2048 bytes', async () => {
        const big = bigFixture(200);
        wf.emit('state', { namespace: 'beads', data: big });
        const r = await httpGet(port, '/state?summary=1');
        const bytes = Buffer.byteLength(r.body, 'utf8');
        assert.ok(bytes < 2048, `summary body is ${bytes} bytes`);
        assert.equal(r.json.extensions.beads.required, 200);
        // Contrast: the plain payload for the same state is far larger.
        const lean = await httpGet(port, '/state?_t=2');
        assert.ok(Buffer.byteLength(lean.body, 'utf8') > 10 * bytes);
    });
});
