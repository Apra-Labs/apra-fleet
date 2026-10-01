import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { StreamableHttpTransport } from '../src/client/transport.mjs';
import { McpClient } from '../src/client/client.mjs';

// Regression test: a fleet server restart invalidates every MCP session it
// issued, and the server answers a request on an unknown session with HTTP
// 404 (the MCP Streamable HTTP rule: the client MUST then start a new
// session). The transport used to throw "Failed to send message: HTTP 404"
// on every later call, forever, so one routine server restart (an
// `install --force`) left every long-lived client -- a fleet-bridge daemon,
// a running sprint -- permanently unable to reach the server. Observed live:
// the bridge daemon's worker failed on its first call after a redeploy and
// the running sprint it was watching was orphaned.

function startSessionServer({ rejectEverySession = false } = {}) {
    const valid = new Set();
    let sessionSeq = 0;
    let initCount = 0;
    const sockets = new Set();
    const server = http.createServer((req, res) => {
        const sid = req.headers['mcp-session-id'];
        if (req.method === 'GET') {
            if (!sid || !valid.has(sid)) { res.statusCode = 404; res.end(); return; }
            res.setHeader('content-type', 'text/event-stream');
            res.write(':\n\n');
            return; // stays open until the server is destroyed
        }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const msg = JSON.parse(body);
            if (msg.method === 'initialize') {
                initCount++;
                const id = `session-${++sessionSeq}`;
                valid.add(id);
                res.setHeader('mcp-session-id', id);
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
                return;
            }
            if (rejectEverySession || !sid || !valid.has(sid)) { res.statusCode = 404; res.end(); return; }
            res.setHeader('content-type', 'text/event-stream');
            res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { session: sid } })}\n\n`);
        });
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${server.address().port}/mcp`,
            restart: () => valid.clear(),
            initCount: () => initCount,
            destroy: () => { for (const s of sockets) s.destroy(); server.close(); },
        }));
    });
}

async function connect(url) {
    const transport = new StreamableHttpTransport(url);
    const errors = [];
    transport.on('error', (e) => errors.push(e));
    const ready = new Promise((resolve) => transport.on('ready', resolve));
    await transport.start();
    await ready;
    return { transport, client: new McpClient(transport), errors };
}

test('a request after a server restart re-initializes the session and succeeds', async () => {
    const srv = await startSessionServer();
    const { transport, client, errors } = await connect(srv.url);
    try {
        const first = await client.callTool('version', {}, { timeoutMs: 5000 });
        assert.strictEqual(first.session, 'session-1');

        srv.restart(); // every issued session is now unknown to the server

        const second = await client.callTool('version', {}, { timeoutMs: 5000 });
        assert.strictEqual(second.session, 'session-2', 'the call must be re-sent on a freshly initialized session');
        assert.strictEqual(srv.initCount(), 2);
        assert.deepStrictEqual(errors, [], `no transport error may surface for a recovered session: ${errors}`);
    } finally {
        transport.stop();
        srv.destroy();
    }
});

test('concurrent requests after a restart share ONE re-initialization', async () => {
    const srv = await startSessionServer();
    const { transport, client } = await connect(srv.url);
    try {
        srv.restart();
        const results = await Promise.all([1, 2, 3].map(() => client.callTool('version', {}, { timeoutMs: 5000 })));
        assert.deepStrictEqual(results.map((r) => r.session), ['session-2', 'session-2', 'session-2']);
        assert.strictEqual(srv.initCount(), 2, 'a burst of 404s must not trigger one handshake per request');
    } finally {
        transport.stop();
        srv.destroy();
    }
});

test('a 404 that survives re-initialization fails loudly after ONE retry, never loops', async () => {
    const srv = await startSessionServer({ rejectEverySession: true });
    const { transport, client } = await connect(srv.url);
    try {
        await assert.rejects(
            client.callTool('version', {}, { timeoutMs: 5000 }),
            /HTTP 404/,
        );
        assert.strictEqual(srv.initCount(), 2, 'exactly one re-initialization, then the 404 is surfaced');
    } finally {
        transport.stop();
        srv.destroy();
    }
});
