import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
    createHistoryView,
    registerHistoryViewRoutes,
    renderHistoryPageHtml,
    isSafeSprintId,
    resolveOldSprintPath,
    loadOldSprintState,
} from '../src/supervisor/history-view.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { createLiveProxy, registerLiveRoutes } from '../src/supervisor/proxy.mjs';

// apra-fleet-eft.6.5 -- process-free History view. Renders a finished
// sprint's persisted old_runs/<sprintId>.json (or the legacy
// old_sprints/<sprintId>.json, apra-fleet-eft.37.1) through the SAME HTML
// template the live viewer serves, fed a frozen state object: zero live
// processes, zero /state or /events polling, Save/Stop absent, and the
// renderer refuses any path-traversal attempt via the :id route param.

/** GET a supervisor path, resolving the full body once the response ends. */
function getText(port, urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

const SAMPLE_STATE = Object.freeze({
    workflowName: 'demo sprint',
    status: 'success',
    verdict: 'PASS',
    startedAt: '2026-07-18T00:00:00.000Z',
    endedAt: '2026-07-18T01:00:00.000Z',
    stats: {
        activitiesCount: 3,
        totalTokens: 1234,
        totalCost: 0.05,
        unknownCostCount: 0,
        startTime: 0,
        durationMs: 3_600_000,
    },
    tree: [],
    extensions: {},
});

describe('history-view -- isSafeSprintId / resolveOldSprintPath', () => {
    test('accepts an opaque sprint id (no path separators)', () => {
        assert.strictEqual(isSafeSprintId('sprint-abc123'), true);
    });

    test('rejects path-traversal / path-fragment sprint ids', () => {
        assert.strictEqual(isSafeSprintId('../../etc/passwd'), false);
        assert.strictEqual(isSafeSprintId('a/b'), false);
        assert.strictEqual(isSafeSprintId('a\\b'), false);
        assert.strictEqual(isSafeSprintId('..'), false);
        assert.strictEqual(isSafeSprintId('.'), false);
        assert.strictEqual(isSafeSprintId(''), false);
        assert.strictEqual(isSafeSprintId(undefined), false);
    });

    test('resolveOldSprintPath throws (never resolves) for an unsafe sprint id', () => {
        assert.throws(() => resolveOldSprintPath('../evil', { APRA_FLEET_DATA_DIR: '/tmp/fleet-se-data' }), RangeError);
    });

    test('resolveOldSprintPath resolves a never-before-seen id to old_runs/ (the canonical write target, apra-fleet-eft.37.1)', () => {
        const env = { APRA_FLEET_DATA_DIR: '/tmp/fleet-se-data' };
        const resolved = resolveOldSprintPath('sprint-1', env);
        assert.strictEqual(path.dirname(resolved), path.join('/tmp/fleet-se-data', 'old_runs'));
        assert.strictEqual(path.basename(resolved), 'sprint-1.json');
    });

    test('resolveOldSprintPath resolves an id that only exists under the legacy old_sprints/ (apra-fleet-eft.37.1 read fallback)', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-history-view-legacy-'));
        try {
            await fs.mkdir(path.join(dir, 'old_sprints'), { recursive: true });
            await fs.writeFile(path.join(dir, 'old_sprints', 'legacy-1.json'), JSON.stringify(SAMPLE_STATE));
            const env = { APRA_FLEET_DATA_DIR: dir };
            const resolved = resolveOldSprintPath('legacy-1', env);
            assert.strictEqual(path.dirname(resolved), path.join(dir, 'old_sprints'));
            assert.strictEqual(path.basename(resolved), 'legacy-1.json');
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});

describe('history-view -- renderHistoryPageHtml (same template as live view)', () => {
    test('renders zero /state or /events fetches, no Save/Stop controls, and the frozen state embedded', () => {
        const html = renderHistoryPageHtml(SAMPLE_STATE);
        assert.ok(html.includes('data-view="history"'), 'must mark itself as the history view');
        assert.ok(!html.includes("new EventSource('/events')"), 'must never open an SSE subscription');
        assert.ok(!html.includes('<button class="btn btn-save"'), 'Save control must be absent');
        assert.ok(!html.includes('<button class="btn btn-stop"'), 'Stop control must be absent');
        assert.ok(html.includes('renderState('), 'must feed the frozen state directly into the same renderer the live view uses');
        assert.ok(html.includes(SAMPLE_STATE.workflowName), 'frozen state content must be embedded');
    });

    test('never throws on a state object with HTML/script-breaking content', () => {
        const hostile = { ...SAMPLE_STATE, workflowName: '</script><script>alert(1)</script>' };
        assert.doesNotThrow(() => renderHistoryPageHtml(hostile));
        const html = renderHistoryPageHtml(hostile);
        assert.ok(!html.includes('</script><script>alert(1)</script>'), 'embedded state must not break out of the script tag');
    });
});

describe('history-view -- loadOldSprintState', () => {
    let dir;
    before(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-history-view-'));
        await fs.mkdir(path.join(dir, 'old_sprints'), { recursive: true });
        await fs.writeFile(path.join(dir, 'old_sprints', 'finished-1.json'), JSON.stringify(SAMPLE_STATE));
    });
    after(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    test('reads and parses a finished sprint state from old_sprints/', async () => {
        const state = await loadOldSprintState('finished-1', { APRA_FLEET_DATA_DIR: dir });
        assert.deepStrictEqual(state, SAMPLE_STATE);
    });

    test('returns null for a sprint id with no persisted history (never throws for a missing file)', async () => {
        const state = await loadOldSprintState('never-existed', { APRA_FLEET_DATA_DIR: dir });
        assert.strictEqual(state, null);
    });

    test('rejects a path-traversal sprint id rather than reading outside old_sprints/', async () => {
        await assert.rejects(() => loadOldSprintState('../../etc/passwd', { APRA_FLEET_DATA_DIR: dir }), RangeError);
    });
});

describe('history-view -- GET /sprints/:id/history (HTTP)', () => {
    let dir;
    let sup;
    let port;

    before(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-history-view-http-'));
        await fs.mkdir(path.join(dir, 'old_sprints'), { recursive: true });
        await fs.writeFile(path.join(dir, 'old_sprints', 'finished-1.json'), JSON.stringify(SAMPLE_STATE));

        const view = createHistoryView({ env: { APRA_FLEET_DATA_DIR: dir } });
        sup = createSupervisor({ port: 0 });
        registerHistoryViewRoutes(sup, view);
        await sup.start();
        port = sup.server.address().port;
    });

    after(async () => {
        await sup.stop('test');
        await fs.rm(dir, { recursive: true, force: true });
    });

    test('renders the finished sprint with zero processes running, no polling controls', async () => {
        const res = await getText(port, '/sprints/finished-1/history');
        assert.strictEqual(res.status, 200);
        assert.ok(res.headers['content-type'].includes('text/html'));
        assert.ok(res.body.includes('data-view="history"'));
        assert.ok(!res.body.includes("new EventSource('/events')"));
        assert.ok(!res.body.includes('<button class="btn btn-save"'));
        assert.ok(!res.body.includes('<button class="btn btn-stop"'));
        assert.ok(res.body.includes(SAMPLE_STATE.workflowName));
    });

    test('unknown sprint id (no persisted history) answers 404', async () => {
        const res = await getText(port, '/sprints/never-existed/history');
        assert.strictEqual(res.status, 404);
    });

    test('a path-traversal attempt on :id is rejected (never reads outside old_sprints/)', async () => {
        const res = await getText(port, '/sprints/' + encodeURIComponent('../../etc/passwd') + '/history');
        assert.strictEqual(res.status, 400);
    });
});

describe('history-view -- wired as the /sprints/:id/live fallthrough renderer', () => {
    // The SAME template must serve live and history at the SAME URL
    // (apra-fleet-eft.6.4's /sprints/:id/live history fallthrough, wired in
    // bin/serve.mjs to this module's renderForSprint()) -- not just at the
    // dedicated /sprints/:id/history link.
    let dir;
    let sup;
    let port;

    before(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-history-view-fallthrough-'));
        await fs.mkdir(path.join(dir, 'old_sprints'), { recursive: true });
        await fs.writeFile(path.join(dir, 'old_sprints', 'finished-1.json'), JSON.stringify(SAMPLE_STATE));

        const view = createHistoryView({ env: { APRA_FLEET_DATA_DIR: dir } });
        const liveProxy = createLiveProxy({
            resolvePort: () => undefined, // no live child -> always falls through
            renderHistory: (sprintId) => view.renderForSprint(sprintId),
        });
        sup = createSupervisor({ port: 0 });
        registerLiveRoutes(sup, liveProxy);
        await sup.start();
        port = sup.server.address().port;
    });

    after(async () => {
        await sup.stop('test');
        await fs.rm(dir, { recursive: true, force: true });
    });

    test('GET /sprints/:id/live falls through to the full eft.6.5 template for a finished sprint', async () => {
        const res = await getText(port, '/sprints/finished-1/live');
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.includes('data-view="history"'));
        assert.ok(!res.body.includes("new EventSource('/events')"));
        assert.ok(!res.body.includes('<button class="btn btn-save"'));
        assert.ok(!res.body.includes('<button class="btn btn-stop"'));
        assert.ok(res.body.includes(SAMPLE_STATE.workflowName));
    });

    test('a path-traversal :id at the /live URL is rejected too (renderHistory throws -> 404, never reads outside old_sprints/)', async () => {
        const res = await getText(port, '/sprints/' + encodeURIComponent('../../etc/passwd') + '/live');
        assert.strictEqual(res.status, 404);
    });
});
