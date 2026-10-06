// Supervisor sprint rows render the CHILD's pulled summary (GET
// /state?summary=1) and each explicit degradation state, exercised against a
// REAL http server on an ephemeral port standing in for the child viewer.
// resolvePort is injected to point at that stub; fetchSummary is left at its
// production default (dashboard.mjs's fetchChildSummary()), so the real HTTP
// client path -- request, timeout, body parse -- is what runs here.
//
// Reproduces the original bug: the injected listAllBeads returns every bead
// OPEN, so a supervisor-side recompute over that bulk fetch (the old
// computeSprintProgress-over-the-supervisor-clone path) would render 0/N.
// Reverting the fix -- restoring that recompute in buildSprintViews() --
// makes the equality assertion in the first test FAIL: the row would read
// Required: 0/2 (root is a decomposed parent) instead of the stub's
// Required: 4/7.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
    createDashboard,
    renderSprintSection,
    buildStatePayload,
    renderIndexPageHtml,
} from '../src/supervisor/dashboard.mjs';
import { WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

const SPRINT_ID = 'sprint-pulled-1';
// Must match dashboard.mjs's DEFAULT_SUMMARY_TIMEOUT_MS (production default,
// not overridden here).
const SUMMARY_TIMEOUT_MS = 2000;
const DIGITS_SLASH_DIGITS = /\d+\/\d+/;

/** Every server this file starts, so after() can prove none is left listening. */
const servers = new Set();

/**
 * Start a stub child viewer. `handler(req, res)` decides each response; the
 * server tracks its sockets so close() never waits on a hung connection.
 */
async function startStub(handler) {
    const sockets = new Set();
    const server = http.createServer(handler);
    server.on('connection', (s) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const stub = {
        server,
        port: server.address().port,
        async close() {
            if (!server.listening) return;
            for (const s of sockets) s.destroy();
            await new Promise((resolve) => server.close(() => resolve()));
            servers.delete(stub);
        },
    };
    servers.add(stub);
    return stub;
}

function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
}

/** A summary body in the pinned wire shape. */
function summaryBody({ runId = SPRINT_ID, beads } = {}) {
    const now = new Date().toISOString();
    return {
        summaryVersion: 1,
        runId,
        status: 'running',
        phase: 'Execute',
        pause: { status: 'none', reason: null, since: null, phase: null, group: null, resumeAt: null },
        terminalReason: null,
        updatedAt: now,
        endedAt: null,
        stats: { totalCost: 0, totalTokens: 0 },
        extensions: beads ? { beads: { publishedAt: now, ...beads } } : {},
    };
}

function beadsSummary(closed, required, computedAt = new Date().toISOString()) {
    return { closed, required, fraction: required ? closed / required : 0, computed_at: computedAt };
}

/** Serve `body` (status 200) on GET /state?summary=1, 404 otherwise. */
function summaryHandler(getResponse) {
    return (req, res) => {
        if (req.method === 'GET' && req.url === '/state?summary=1') {
            const { status = 200, body, raw } = getResponse();
            if (raw !== undefined) {
                res.writeHead(status, { 'Content-Type': 'text/html' });
                res.end(raw);
                return;
            }
            sendJson(res, status, body);
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
    };
}

/**
 * A dashboard over one running sprint whose bulk beads fetch would naively
 * recompute to 0/N (every bead open). resolvePort is injected; fetchSummary
 * stays at the production default.
 */
function makeDashboard(resolvePort) {
    return createDashboard({
        ledger: { list: () => [{ sprintId: SPRINT_ID, members: [], issueRoots: ['root'], childPid: 4242 }] },
        watchdog: { classifySprint: async () => ({ status: WATCHDOG_STATUS.RUNNING_HEALTHY }) },
        listAllBeads: async () => [
            { id: 'root', status: 'open' },
            { id: 'child1', status: 'open', parent: 'root' },
            { id: 'child2', status: 'open', parent: 'root' },
        ],
        resolvePort,
        driftCheck: async () => null,
        logger: { log() {}, error() {} },
    });
}

async function renderRow(dashboard) {
    const views = await dashboard.buildSprintViews();
    assert.equal(views.length, 1);
    return { view: views[0], html: renderSprintSection(views[0]) };
}

after(async () => {
    for (const stub of [...servers]) await stub.close();
    assert.equal(servers.size, 0, 'no stub server left listening');
});

describe('supervisor rows render the pulled child summary', () => {
    test('Required: C/R comes from the stub summary, not a recompute of the bulk beads fetch', async () => {
        const stub = await startStub(summaryHandler(() => ({ body: summaryBody({ beads: beadsSummary(4, 7) }) })));
        try {
            const dashboard = makeDashboard(() => stub.port);
            const { view, html } = await renderRow(dashboard);
            const rendered = (html.match(/Required: \d+\/\d+/) || ['(none)'])[0];
            assert.equal(rendered, 'Required: 4/7', 'the row shows exactly the stub summary closed/required');
            assert.equal(view.progress.state, 'ok');
            const page = await dashboard.renderIndexPage();
            assert.ok(page.includes('Required: 4/7'), 'the full page render carries it too');
        } finally {
            await stub.close();
        }
    });

    test('client-side re-render path (buildStatePayload -> renderSprintSection) shows the same text as the server render', async () => {
        const stub = await startStub(summaryHandler(() => ({ body: summaryBody({ beads: beadsSummary(2, 5) }) })));
        try {
            const dashboard = makeDashboard(() => stub.port);
            const views = await dashboard.buildSprintViews();
            const nowMs = Date.now();
            const serverHtml = renderSprintSection(views[0], nowMs);
            // The client receives buildStatePayload() as JSON over GET /state
            // and renders each sprint with the SAME renderSprintSection()
            // (embedded verbatim into the page script).
            const payload = JSON.parse(JSON.stringify(buildStatePayload(views)));
            const clientHtml = renderSprintSection(payload.sprints[0], nowMs);
            assert.equal(clientHtml, serverHtml);
            assert.ok(clientHtml.includes('Required: 2/5'));
            // And the live script really embeds that builder (plus the age
            // helper it needs), so the browser runs the same markup code.
            const page = renderIndexPageHtml(views, '', '');
            assert.ok(page.includes('function renderSprintSection('));
            assert.ok(page.includes('function renderSprintProgressHtml('));
            assert.ok(page.includes('function formatSummaryAge('));
        } finally {
            await stub.close();
        }
    });

    test('freshness: computed_at 30s in the past renders an "as of" label of about 30s', async () => {
        const computedAt = new Date(Date.now() - 30_000).toISOString();
        const stub = await startStub(summaryHandler(() => ({ body: summaryBody({ beads: beadsSummary(1, 2, computedAt) }) })));
        try {
            const { html } = await renderRow(makeDashboard(() => stub.port));
            const m = html.match(/as of (\d+)s/);
            assert.ok(m, `expected an "as of Ns" label in: ${html}`);
            const secs = Number(m[1]);
            assert.ok(secs >= 29 && secs <= 35, `expected about 30s, got ${secs}s`);
        } finally {
            await stub.close();
        }
    });
});

describe('supervisor rows render every degradation state, never digits/digits', () => {
    test('old child: 404 for ?summary=1 -> status unavailable', async () => {
        const stub = await startStub((req, res) => { res.writeHead(404); res.end('Not Found'); });
        try {
            const { view, html } = await renderRow(makeDashboard(() => stub.port));
            assert.equal(view.progress.state, 'unavailable');
            assert.ok(html.includes('status unavailable'));
            assert.doesNotMatch(html, DIGITS_SLASH_DIGITS);
        } finally {
            await stub.close();
        }
    });

    test('old child variant: full-state-like JSON with no summaryVersion -> status unavailable', async () => {
        const fullStateLike = {
            runId: SPRINT_ID, status: 'running', tree: [], _strings: ['x'],
            extensions: { beads: { sprintTasks: [], closed: 3, required: 9 } },
        };
        const stub = await startStub(summaryHandler(() => ({ body: fullStateLike })));
        try {
            const { view, html } = await renderRow(makeDashboard(() => stub.port));
            assert.equal(view.progress.state, 'unavailable');
            assert.ok(html.includes('status unavailable'));
            assert.doesNotMatch(html, DIGITS_SLASH_DIGITS);
        } finally {
            await stub.close();
        }
    });

    test('non-JSON body -> status unavailable', async () => {
        const stub = await startStub(summaryHandler(() => ({ raw: '<html>old viewer</html>' })));
        try {
            const { view, html } = await renderRow(makeDashboard(() => stub.port));
            assert.equal(view.progress.state, 'unavailable');
            assert.doesNotMatch(html, DIGITS_SLASH_DIGITS);
        } finally {
            await stub.close();
        }
    });

    test('no summary yet: valid summary with no extensions.beads', async () => {
        const stub = await startStub(summaryHandler(() => ({ body: summaryBody() })));
        try {
            const { view, html } = await renderRow(makeDashboard(() => stub.port));
            assert.equal(view.progress.state, 'no-summary');
            assert.ok(html.includes('no summary yet'));
            assert.doesNotMatch(html, DIGITS_SLASH_DIGITS);
        } finally {
            await stub.close();
        }
    });

    test('unreachable: an OK render is cached, then the stub stops -> last C/R plus an unreachable marker', async () => {
        const stub = await startStub(summaryHandler(() => ({ body: summaryBody({ beads: beadsSummary(3, 8) }) })));
        const port = stub.port;
        const dashboard = makeDashboard(() => port);
        const first = await renderRow(dashboard);
        assert.equal(first.view.progress.state, 'ok');
        assert.ok(first.html.includes('Required: 3/8'));
        assert.ok(!first.html.includes('unreachable'));

        await stub.close();
        const second = await renderRow(dashboard);
        assert.equal(second.view.progress.state, 'unreachable');
        assert.ok(second.html.includes('Required: 3/8'), 'the last good summary is still shown');
        assert.ok(second.html.includes('unreachable'), 'with an unreachable marker');
    });

    test('unreachable with no prior summary -> status unavailable, not 0/N', async () => {
        // Grab a free port, then close it so nothing is listening there.
        const stub = await startStub(() => {});
        const deadPort = stub.port;
        await stub.close();
        const { view, html } = await renderRow(makeDashboard(() => deadPort));
        assert.equal(view.progress.state, 'unavailable');
        assert.ok(html.includes('status unavailable'));
        assert.doesNotMatch(html, DIGITS_SLASH_DIGITS);
    });

    test('runId mismatch: a summary for another run is never rendered as this sprint\'s progress', async () => {
        const stub = await startStub(summaryHandler(() => ({ body: summaryBody({ runId: 'some-other-run', beads: beadsSummary(6, 6) }) })));
        try {
            const { view, html } = await renderRow(makeDashboard(() => stub.port));
            assert.notEqual(view.progress.state, 'ok');
            assert.ok(!html.includes('6/6'), `another run's numbers must not render: ${html}`);
            assert.doesNotMatch(html, DIGITS_SLASH_DIGITS, 'no prior good summary for this sprint, so no numbers at all');
        } finally {
            await stub.close();
        }
    });

    test('timeout: a stub that accepts the connection but never responds -> buildSprintViews resolves within timeout + 1s', async () => {
        // Accepts and reads the request, never writes a response.
        const stub = await startStub(() => {});
        try {
            const dashboard = makeDashboard(() => stub.port);
            const started = Date.now();
            const { view, html } = await renderRow(dashboard);
            const elapsed = Date.now() - started;
            const budget = SUMMARY_TIMEOUT_MS + scaledTimeout(1000);
            assert.ok(elapsed < budget, `buildSprintViews took ${elapsed}ms; budget ${budget}ms`);
            assert.ok(elapsed >= SUMMARY_TIMEOUT_MS - 100, `the production timeout actually elapsed (${elapsed}ms)`);
            assert.equal(view.progress.state, 'unavailable');
            assert.doesNotMatch(html, DIGITS_SLASH_DIGITS);
        } finally {
            await stub.close();
        }
    });
});
