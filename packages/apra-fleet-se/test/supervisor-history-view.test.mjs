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
    // (apra-fleet-i9ag.16.8) the finished-run reason reader and its consumers
    summarizeTerminalReason,
    summarizeFinishedRun,
    createFinishedRunsIndex,
} from '../src/supervisor/history-view.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { createLiveProxy, registerLiveRoutes } from '../src/supervisor/proxy.mjs';
import { MOUNT_PATH_HEADER } from '../src/supervisor/mount-prefix.mjs';
import { sprintCardAnchorId } from '../src/supervisor/sprint-anchor.mjs';

// apra-fleet-eft.6.5 -- process-free History view. Renders a finished
// sprint's persisted old_runs/<sprintId>.json (or the legacy
// old_sprints/<sprintId>.json, apra-fleet-eft.37.1) through the SAME HTML
// template the live viewer serves, fed a frozen state object: zero live
// processes, zero /state or /events polling, Save/Stop absent, and the
// renderer refuses any path-traversal attempt via the :id route param.

/** GET a supervisor path, resolving the full body once the response ends. */
function getText(port, urlPath, { headers } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
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

    test('reads and parses a finished sprint state from old_sprints/, backfilling a legacy top-level verdict/prUrl into state.result (BOUNDARY-COMPAT, apra-fleet-eft.37.3)', async () => {
        const state = await loadOldSprintState('finished-1', { APRA_FLEET_DATA_DIR: dir });
        assert.deepStrictEqual(state, { ...SAMPLE_STATE, result: { verdict: 'PASS', prUrl: null } });
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
        // (apra-fleet-i9ag.3.8) Mirrors bin/serve.mjs's real wiring: the live
        // proxy's own per-request resolveMountPrefix() result is forwarded
        // into renderForSprint() as its second argument, not dropped.
        const liveProxy = createLiveProxy({
            resolvePort: () => undefined, // no live child -> always falls through
            renderHistory: (sprintId, mountPrefix) => view.renderForSprint(sprintId, mountPrefix),
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

    // (apra-fleet-i9ag.3.8) The finished-sprint page reached through the
    // /sprints/:id/live fallthrough must carry the SAME mount-aware,
    // target="_top" back-link the live proxy injects into a still-live
    // sprint's HTML (apra-fleet-i9ag.5.2/3.6) -- previously this renderer
    // dropped the mount prefix entirely, so the back-link was either absent
    // or always unprefixed even when embedded in the console's /ext/<id>
    // iframe.
    test('history fallthrough back-link is unprefixed with target="_top" when no mount-path header is set', async () => {
        const res = await getText(port, '/sprints/finished-1/live');
        assert.strictEqual(res.status, 200);
        const anchorHref = '/#' + sprintCardAnchorId('finished-1');
        assert.ok(res.body.includes('href="' + anchorHref + '" target="_top"'), res.body);
    });

    test('history fallthrough back-link is prefixed when the console mount-path header is set', async () => {
        const res = await getText(port, '/sprints/finished-1/live', { headers: { [MOUNT_PATH_HEADER]: '/ext/se' } });
        assert.strictEqual(res.status, 200);
        const anchorHref = '/ext/se/#' + sprintCardAnchorId('finished-1');
        assert.ok(res.body.includes('href="' + anchorHref + '" target="_top"'), res.body);
    });

    test('a path-traversal :id at the /live URL is rejected too (renderHistory throws -> 404, never reads outside old_sprints/)', async () => {
        const res = await getText(port, '/sprints/' + encodeURIComponent('../../etc/passwd') + '/live');
        assert.strictEqual(res.status, 404);
    });
});

describe('history-view -- GET /sprints/:id/history resolves the mount prefix itself', () => {
    // (apra-fleet-i9ag.3.9) The DEDICATED History route is entered directly --
    // nothing threads a mount prefix into it the way bin/serve.mjs threads the
    // live proxy's resolved value into the /sprints/:id/live fallthrough tested
    // above. It therefore calls resolveMountPrefix(req) itself, so the SAME
    // page carries a correct back-link whether it was opened on the
    // supervisor's own port or through the console's /ext/<id> iframe hop.
    // Previously handleGet dropped the prefix entirely, so the History page's
    // back-link left the console's mount point behind when embedded.
    let dir;
    let sup;
    let port;
    const anchorSuffix = '/#' + sprintCardAnchorId('finished-1');

    before(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-history-view-mount-'));
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

    test('back-link is prefixed exactly once, with target="_top", when the console mount-path header is set', async () => {
        const res = await getText(port, '/sprints/finished-1/history', { headers: { [MOUNT_PATH_HEADER]: '/ext/se' } });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.includes('href="/ext/se' + anchorSuffix + '" target="_top"'), res.body);
        assert.ok(!res.body.includes('/ext/se/ext/se'), 'the prefix must be applied exactly once, never doubled');
    });

    test('back-link stays rooted at / when no mount-path header is set (serve-direct is unchanged)', async () => {
        const res = await getText(port, '/sprints/finished-1/history');
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.includes('href="' + anchorSuffix + '" target="_top"'), res.body);
        assert.ok(!res.body.includes('href="/ext/'), 'no prefix may appear when none was sent');
    });

    test('a hostile mount-path header fails closed to the unprefixed back-link', async () => {
        const res = await getText(port, '/sprints/finished-1/history', { headers: { [MOUNT_PATH_HEADER]: '//evil.example' } });
        assert.strictEqual(res.status, 200);
        assert.ok(res.body.includes('href="' + anchorSuffix + '" target="_top"'), res.body);
        assert.ok(!res.body.includes('evil.example'), 'a protocol-relative header value must never reach the rendered page');
    });
});

// =============================================================================
// apra-fleet-i9ag.16.8 -- where a finished run's REASON comes from
// =============================================================================
//
// createFinishedRunsIndex() used to stamp `reason: null` onto every
// file-backed row unconditionally, so a failed/aborted run's Finished Sprints
// card had no reason to render even though its terminal state file carried
// one. summarizeTerminalReason() (apra-fleet-i9ag.16.7) is the reader that
// closes that gap; these pin the real producer shapes it has to cope with.
describe('apra-fleet-i9ag.16.8: summarizeTerminalReason reads the reason out of a terminal state file', () => {
    test("the fatal-diagnostics guard's shape: terminalReason label plus the lastError message an operator actually needs", () => {
        // fleet-sprint/fatal-diagnostics.mjs's publishState('terminal', ...) --
        // the exact producer behind the ABORTED card the final M1 acceptance
        // run saw with no reason at all. The bare label ('uncaughtException')
        // explains nothing on its own, so both halves must survive.
        const reason = summarizeTerminalReason({
            extensions: {
                terminal: {
                    verdict: 'ABORTED',
                    failed: true,
                    terminalReason: 'uncaughtException',
                    lastError: { message: 'claude: command not found', phase: 'Plan' },
                },
            },
        });
        assert.equal(reason, 'uncaughtException: claude: command not found');
    });

    test("runner.js's typed-abort shape: terminalReason plus the error message carried alongside it", () => {
        const reason = summarizeTerminalReason({
            extensions: { terminal: { verdict: 'ABORTED', terminalReason: 'BEADS_SYNC_CONFLICT', message: 'bd dolt push rejected' } },
        });
        assert.equal(reason, 'BEADS_SYNC_CONFLICT: bd dolt push rejected');
    });

    test("a FAIL verdict's explanation comes from the workflow result's notes", () => {
        const reason = summarizeTerminalReason({
            terminalReason: 'failed',
            result: { status: 'failed', verdict: 'FAIL', notes: 'integration tests red on windows-latest' },
        });
        assert.equal(reason, 'failed: integration tests red on windows-latest');
    });

    test("the engine's own top-level terminalReason is used when the child recorded nothing more specific", () => {
        assert.equal(summarizeTerminalReason({ terminalReason: 'SIGTERM' }), 'SIGTERM');
    });

    test('a label that duplicates its detail is not repeated back twice', () => {
        const reason = summarizeTerminalReason({
            terminalReason: 'boom',
            extensions: { terminal: { lastError: { message: 'boom' } } },
        });
        assert.equal(reason, 'boom');
    });

    test('an empty/garbage/absent state yields null, never a throw or an empty "Reason:" line', () => {
        assert.equal(summarizeTerminalReason({}), null);
        assert.equal(summarizeTerminalReason(null), null);
        assert.equal(summarizeTerminalReason(undefined), null);
        assert.equal(summarizeTerminalReason('not an object'), null);
        assert.equal(summarizeTerminalReason({ terminalReason: '   ' }), null, 'whitespace is not a reason');
        assert.equal(summarizeTerminalReason({ extensions: { terminal: 'not an object' } }), null);
    });

    test('summarizeFinishedRun() carries that reason on the row, so it is cached with the rest of the summary', () => {
        const row = summarizeFinishedRun('sprint-a', {
            extensions: { terminal: { verdict: 'ABORTED', terminalReason: 'uncaughtException', lastError: { message: 'claude: command not found' } } },
        });
        assert.equal(row.verdict, 'ABORTED');
        assert.equal(row.reason, 'uncaughtException: claude: command not found');
    });
});

describe('apra-fleet-i9ag.16.8: createFinishedRunsIndex surfaces a file-backed row reason end-to-end', () => {
    let dataDir;
    before(async () => {
        dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-i9ag168-index-'));
        const oldRuns = path.join(dataDir, 'old_runs');
        await fs.mkdir(oldRuns, { recursive: true });
        await fs.writeFile(path.join(oldRuns, 'sprint-aborted.json'), JSON.stringify({
            endedAt: '2026-09-28T12:00:00.000Z',
            extensions: { terminal: { verdict: 'ABORTED', terminalReason: 'uncaughtException', lastError: { message: 'claude: command not found' } } },
        }));
    });
    after(async () => {
        await fs.rm(dataDir, { recursive: true, force: true });
    });

    test("a real old_runs/ file's reason reaches the row the dashboard renders -- no longer a hard-coded null", async () => {
        const index = createFinishedRunsIndex({ env: { APRA_FLEET_DATA_DIR: dataDir }, logger: { log() {}, error() {} } });
        const rows = await index.list();
        const row = rows.find((r) => r.sprintId === 'sprint-aborted');
        assert.ok(row, `expected a row for sprint-aborted, got ${JSON.stringify(rows)}`);
        assert.equal(row.status, 'finished');
        assert.equal(row.hasTerminalState, true);
        assert.equal(row.verdict, 'ABORTED');
        assert.equal(row.reason, 'uncaughtException: claude: command not found');
    });
});
