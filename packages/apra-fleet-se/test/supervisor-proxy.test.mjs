import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';

import {
    createLiveProxy,
    registerLiveRoutes,
    rewriteChildHtml,
    livePrefixFor,
    renderReadOnlyHistoryHtml,
} from '../src/supervisor/proxy.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';

// apra-fleet-eft.6.4 -- /sprints/:id/live reverse proxy. Serves the child
// viewer's HTML + SSE through the SUPERVISOR port (no bare child port leaks),
// streams SSE incrementally, propagates client disconnect to the upstream, and
// falls through to a read-only historical view once a sprint finishes.

/** GET a supervisor path, resolving the full body once the response ends. */
function getText(port, path) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

/** Start a supervisor with the live proxy routes registered on an ephemeral port. */
async function startSupervisorWith(proxyDeps) {
    const proxy = createLiveProxy(proxyDeps);
    const supervisor = createSupervisor({ port: 0 });
    registerLiveRoutes(supervisor, proxy);
    await supervisor.start();
    const port = supervisor.server.address().port;
    return { supervisor, port };
}

describe('proxy -- rewriteChildHtml', () => {
    test('rewrites the child client endpoints to the live prefix (no bare port)', () => {
        const prefix = livePrefixFor('sprint-x');
        const html = "new EventSource('/events'); fetch('/state?_t=1'); fetch('/stop', {method:'POST'})";
        const out = rewriteChildHtml(html, prefix);
        assert.ok(out.includes("'" + prefix + "/events'"));
        assert.ok(out.includes("'" + prefix + "/state?_t=1'"));
        assert.ok(out.includes("'" + prefix + "/stop'"));
        // No leftover bare absolute app-paths.
        assert.ok(!out.includes("'/events'"));
        assert.ok(!out.includes("'/stop'"));
    });

    test('is a no-op on non-string input', () => {
        assert.strictEqual(rewriteChildHtml(undefined, '/p'), undefined);
    });
});

describe('proxy -- livePrefixFor', () => {
    test('is supervisor-relative and encodes the sprint id', () => {
        assert.strictEqual(livePrefixFor('a b'), '/sprints/a%20b/live');
    });
});

describe('proxy -- renderReadOnlyHistoryHtml', () => {
    test('renders a read-only page with no live controls and no child port', () => {
        const html = renderReadOnlyHistoryHtml('sprint-x', { status: 'success', terminalReason: 'end' });
        assert.ok(html.includes('data-view="history"'));
        assert.ok(html.toLowerCase().includes('read-only'));
        assert.ok(!html.includes('/events'));
        assert.ok(!html.includes('/stop'));
        assert.ok(!/:80\d\d/.test(html), 'must not embed a child port');
    });

    test('never throws on missing/odd state', () => {
        assert.doesNotThrow(() => renderReadOnlyHistoryHtml('x', null));
        assert.ok(renderReadOnlyHistoryHtml('x', null).includes('unknown'));
    });
});

describe('proxy -- HTTP passthrough + no port leak', () => {
    let child;
    let childPort;
    let sup;

    before(async () => {
        // Fake child viewer: serves '/' HTML that references its own endpoints
        // via absolute app-paths, exactly like the real viewer.
        child = http.createServer((req, res) => {
            if (req.url === '/') {
                const body = "<html><body><script>new EventSource('/events');" +
                    "fetch('/state?_t=1');fetch('/stop',{method:'POST'});</script></body></html>";
                res.writeHead(200, { 'content-type': 'text/html' });
                res.end(body);
            } else if (req.url.startsWith('/state')) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        await new Promise((r) => child.listen(0, '127.0.0.1', r));
        childPort = child.address().port;
        sup = await startSupervisorWith({ resolvePort: () => childPort });
    });

    after(async () => {
        await sup.supervisor.stop('test');
        await new Promise((r) => child.close(r));
    });

    test('GET /sprints/:id/live serves the child HTML with endpoints rewritten', async () => {
        const res = await getText(sup.port, '/sprints/s1/live');
        assert.strictEqual(res.status, 200);
        assert.ok(res.headers['content-type'].includes('text/html'));
        const prefix = livePrefixFor('s1');
        assert.ok(res.body.includes("'" + prefix + "/events'"), res.body);
        // The child's actual port must appear nowhere in the served HTML.
        assert.ok(!res.body.includes(String(childPort)), 'child port leaked into HTML');
    });

    test('GET /sprints/:id/live/state proxies through to the child', async () => {
        const res = await getText(sup.port, '/sprints/s1/live/state');
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(JSON.parse(res.body), { ok: true });
    });
});

describe('proxy -- SSE streams incrementally and disconnect propagates', () => {
    let child;
    let childPort;
    let sup;
    let upstreamClosed;
    let resolveUpstreamClosed;

    before(async () => {
        upstreamClosed = new Promise((r) => { resolveUpstreamClosed = r; });
        child = http.createServer((req, res) => {
            if (req.url === '/events') {
                res.writeHead(200, {
                    'content-type': 'text/event-stream',
                    'cache-control': 'no-cache',
                    connection: 'keep-alive',
                });
                res.write('data: one\n\n');
                // Second event arrives later -- proves incremental (non-buffered)
                // delivery through the proxy.
                const t = setTimeout(() => { try { res.write('data: two\n\n'); } catch { /* gone */ } }, 120);
                // When the proxy destroys the upstream on client disconnect, the
                // child sees its request close.
                req.on('close', () => { clearTimeout(t); resolveUpstreamClosed(true); });
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        await new Promise((r) => child.listen(0, '127.0.0.1', r));
        childPort = child.address().port;
        sup = await startSupervisorWith({ resolvePort: () => childPort });
    });

    after(async () => {
        await sup.supervisor.stop('test');
        await new Promise((r) => child.close(r));
    });

    test('events arrive incrementally, then client disconnect closes upstream', async () => {
        const firstChunk = await new Promise((resolve, reject) => {
            const req = http.request(
                { host: '127.0.0.1', port: sup.port, path: '/sprints/s1/live/events', method: 'GET' },
                (res) => {
                    assert.ok(res.headers['content-type'].includes('text/event-stream'));
                    res.setEncoding('utf-8');
                    res.once('data', (chunk) => {
                        // Got the first event BEFORE the stream ended -> not buffered.
                        resolve({ chunk, req });
                    });
                    res.on('error', () => { /* aborted on purpose below */ });
                },
            );
            req.on('error', () => { /* client abort races the assertion; ignored */ });
            req.end();
        });
        assert.ok(firstChunk.chunk.includes('data: one'), firstChunk.chunk);
        // Disconnect the client mid-stream; the child must observe req 'close'.
        firstChunk.req.destroy();
        const closed = await upstreamClosed;
        assert.strictEqual(closed, true);
    });
});

describe('proxy -- history fallthrough', () => {
    test('finished sprint (no live port) renders the history view at the same URL', async () => {
        const sup = await startSupervisorWith({
            resolvePort: () => undefined,
            renderHistory: (id) => renderReadOnlyHistoryHtml(id, { status: 'success' }),
        });
        try {
            const res = await getText(sup.port, '/sprints/gone/live');
            assert.strictEqual(res.status, 200);
            assert.ok(res.headers['content-type'].includes('text/html'));
            assert.ok(res.body.includes('data-view="history"'));
            assert.ok(res.body.toLowerCase().includes('read-only'));
        } finally {
            await sup.supervisor.stop('test');
        }
    });

    test('no live port and no history yields 404 (never a dead proxy)', async () => {
        const sup = await startSupervisorWith({
            resolvePort: () => undefined,
            renderHistory: () => null,
        });
        try {
            const res = await getText(sup.port, '/sprints/nothing/live');
            assert.strictEqual(res.status, 404);
        } finally {
            await sup.supervisor.stop('test');
        }
    });

    test('live port that refuses connection falls through to history, not a dead proxy', async () => {
        // Point at a port nothing is listening on -> ECONNREFUSED before any
        // response. The base handler must fall through to history.
        const deadPort = 1; // reserved/unusable -> connection refused
        let historyCalled = false;
        const sup = await startSupervisorWith({
            resolvePort: () => deadPort,
            renderHistory: (id) => { historyCalled = true; return renderReadOnlyHistoryHtml(id, {}); },
        });
        try {
            const res = await getText(sup.port, '/sprints/racing/live');
            assert.strictEqual(res.status, 200);
            assert.ok(historyCalled, 'history fallthrough should have run');
            assert.ok(res.body.includes('data-view="history"'));
        } finally {
            await sup.supervisor.stop('test');
        }
    });
});
