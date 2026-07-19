import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { StreamableHttpTransport } from '../src/client/transport.mjs';

// Regression test for the persistent-GET-stream reconnect loop
// (2026-07-19 stabilization: Node's built-in fetch enforces a ~300s idle
// bodyTimeout on response bodies; the persistent SSE GET stream is normally
// silent, so a single-shot GET deterministically died ~5 minutes into every
// session, emitted 'close', and rejected EVERY in-flight request -- killing
// live auto-sprint runs mid-dispatch. The stream must quietly reconnect on
// idle-death instead, and only surface 'close' on deliberate stop()).

function startSseServer() {
    let getCount = 0;
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        if (req.method === 'POST') {
            // initialize (or any JSON-RPC POST): reply minimally.
            res.setHeader('mcp-session-id', 'test-session-1');
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
            return;
        }
        if (req.method === 'GET') {
            getCount++;
            res.setHeader('content-type', 'text/event-stream');
            res.write(':\n\n'); // SSE comment to flush headers
            if (getCount === 1) {
                // Simulate the idle bodyTimeout death: end the first
                // persistent stream shortly after it opens.
                setTimeout(() => res.end(), 50);
            }
            // Second and later streams stay open until server close.
            return;
        }
        res.statusCode = 404;
        res.end();
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            server,
            url: `http://127.0.0.1:${server.address().port}/mcp`,
            getCountRef: () => getCount,
            destroy: () => { for (const s of sockets) s.destroy(); server.close(); },
        }));
    });
}

test('persistent GET stream reconnects after dying instead of emitting close', async () => {
    const { url, getCountRef, destroy } = await startSseServer();
    const transport = new StreamableHttpTransport(url);

    let closed = false;
    let errored = null;
    transport.on('close', () => { closed = true; });
    transport.on('error', (e) => { errored = e; });

    const ready = new Promise((resolve) => transport.on('ready', resolve));
    await transport.start();
    await ready;

    // Give the first stream time to die (50ms) plus the ~1s reconnect
    // backoff, then confirm a SECOND GET arrived and no close/error fired.
    await new Promise((r) => setTimeout(r, 1800));

    assert.ok(getCountRef() >= 2, `expected the transport to reopen the GET stream after it died, got ${getCountRef()} GET(s)`);
    assert.strictEqual(closed, false, 'transport must NOT emit close when the persistent stream dies and reconnects');
    assert.strictEqual(errored, null, `transport must NOT emit error on a recoverable stream death, got: ${errored}`);

    // Deliberate stop() must still surface close exactly as before.
    const closeEvt = new Promise((resolve) => transport.on('close', resolve));
    transport.stop();
    await closeEvt;
    destroy();
});
