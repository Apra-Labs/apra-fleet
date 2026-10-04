import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import net from 'node:net';

import { ReconnectingHttpTransport, isNeverDeliveredError } from '../src/client/reconnecting-transport.mjs';
import { McpClient } from '../src/client/client.mjs';

// GitHub #585 recovery: a long-lived client survives the shared server going
// away. A request is re-sent at most once, and only when it provably never
// reached the server (refused before send, or 404 unknown session) -- never
// an in-flight execute_prompt/execute_command.

/**
 * Minimal streamable-HTTP MCP stand-in. Every non-initialize POST is recorded;
 * tools/call execute_prompt never answers (an in-flight dispatch).
 */
const cleanups = [];

function fakeServer(name, port = 0) {
    const sessions = new Set();
    const received = [];
    const sockets = new Set();
    let n = 0;
    const server = http.createServer((req, res) => {
        if (req.method === 'GET') {
            if (!sessions.has(req.headers['mcp-session-id'])) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(':\n\n');
            return; // held open
        }
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
            const msg = JSON.parse(body);
            if (msg.method === 'initialize') {
                const sid = `${name}-${++n}`;
                sessions.add(sid);
                res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': sid });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
                return;
            }
            if (!sessions.has(req.headers['mcp-session-id'])) { res.writeHead(404); res.end('Session not found'); return; }
            received.push(msg);
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            if (msg.params && msg.params.name === 'execute_prompt') { res.write(':\n\n'); return; } // in flight forever
            res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { from: name } })}\n\n`);
        });
    });
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    const kill = () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); });
    cleanups.push(kill);
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
        name, received, sessions,
        url: `http://127.0.0.1:${server.address().port}/mcp`,
        port: server.address().port,
        kill,
    })));
}

async function freePort() {
    const s = net.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const { port } = s.address();
    await new Promise((r) => s.close(r));
    return port;
}

function connect(url, relocate) {
    const t = new ReconnectingHttpTransport(url, { relocate });
    cleanups.push(async () => { try { t.stop(); } catch { /* ignore */ } });
    return t.start().then(() => ({ t, client: new McpClient(t) }));
}

describe('isNeverDeliveredError', () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    test('refused connection / unknown session -> never delivered', () => {
        assert.strictEqual(isNeverDeliveredError(refused), true);
        assert.strictEqual(isNeverDeliveredError(Object.assign(new TypeError('fetch failed'), {
            cause: { errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }] },
        })), true);
        assert.strictEqual(isNeverDeliveredError(Object.assign(new Error('HTTP 404'), { status: 404 })), true);
    });
    test('reset / timeout / 5xx / plain errors -> maybe delivered', () => {
        assert.strictEqual(isNeverDeliveredError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })), false);
        assert.strictEqual(isNeverDeliveredError(Object.assign(new TypeError('fetch failed'), {
            cause: { errors: [{ code: 'ECONNREFUSED' }, { code: 'ETIMEDOUT' }] },
        })), false);
        assert.strictEqual(isNeverDeliveredError(Object.assign(new Error('HTTP 500'), { status: 500 })), false);
        assert.strictEqual(isNeverDeliveredError(new Error('fetch failed')), false);
        assert.strictEqual(isNeverDeliveredError(null), false);
    });
});

describe('ReconnectingHttpTransport', () => {
    // Failed assertions must not leave servers/streams holding the runner open.
    afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

    test('connection refused mid-run -> re-probe/auto-start, request sent exactly once to the new server', async () => {
        const a = await fakeServer('A');
        let b = null;
        let relocations = 0;
        const { t, client } = await connect(a.url, async () => { relocations++; b = await fakeServer('B'); return b.url; });
        assert.deepStrictEqual(await client.request('tools/list', {}, { timeoutMs: 5000 }), { from: 'A' });
        await a.kill(); // the shared server dies between requests
        const r = await client.request('tools/call', { name: 'execute_command', arguments: { command: 'echo hi' } }, { timeoutMs: 15000 });
        assert.deepStrictEqual(r, { from: 'B' });
        assert.strictEqual(relocations, 1);
        assert.strictEqual(b.received.filter((m) => m.method === 'tools/call').length, 1, 'retried exactly once');
        t.stop();
        await b.kill();
    });

    test('in-flight execute_prompt when the server dies -> rejected, never re-sent; the NEXT request reconnects', async () => {
        const a = await fakeServer('A');
        let b = null;
        let relocations = 0;
        const { t, client } = await connect(a.url, async () => { relocations++; b = await fakeServer('B'); return b.url; });
        const inflight = client.request('tools/call', { name: 'execute_prompt', arguments: { prompt: 'p' } }, { timeoutMs: 15000 });
        while (!a.received.some((m) => m.params && m.params.name === 'execute_prompt')) await new Promise((r) => setTimeout(r, 20));
        await a.kill();
        await assert.rejects(inflight);
        assert.strictEqual(relocations, 0, 'no reconnect/re-send for the in-flight request');
        assert.strictEqual(a.received.filter((m) => m.params && m.params.name === 'execute_prompt').length, 1);
        // Later request: the connection is known stale -> one re-probe, then sent.
        assert.deepStrictEqual(await client.request('tools/list', {}, { timeoutMs: 15000 }), { from: 'B' });
        assert.strictEqual(relocations, 1);
        assert.strictEqual(b.received.some((m) => m.params && m.params.name === 'execute_prompt'), false, 'execute_prompt never re-sent');
        t.stop();
        await b.kill();
    });

    test('server restarted on the same port (old session unknown -> 404) -> new session, request retried once', async () => {
        const port = await freePort();
        let a = await fakeServer('A', port);
        let relocations = 0;
        const { t, client } = await connect(a.url, async () => { relocations++; return a.url; });
        await a.kill();
        a = await fakeServer('A2', port);
        const r = await client.request('tools/call', { name: 'execute_command', arguments: { command: 'x' } }, { timeoutMs: 15000 });
        assert.deepStrictEqual(r, { from: 'A2' });
        assert.strictEqual(relocations, 1);
        assert.strictEqual(a.received.filter((m) => m.method === 'tools/call').length, 1);
        t.stop();
        await a.kill();
    });

    test('retry happens at most once: still refused after relocation -> the error surfaces', async () => {
        const a = await fakeServer('A');
        const deadPort = await freePort();
        let relocations = 0;
        const { t, client } = await connect(a.url, async () => {
            relocations++;
            if (relocations > 1) throw new Error('relocated twice');
            return `http://127.0.0.1:${deadPort}/mcp`;
        });
        await a.kill();
        await assert.rejects(client.request('tools/list', {}, { timeoutMs: 20000 }));
        assert.strictEqual(relocations, 1);
        t.stop();
    });

    test('relocation failure (e.g. auto-start loop guard) propagates to the caller', async () => {
        const a = await fakeServer('A');
        const { t, client } = await connect(a.url, async () => { throw new Error('auto-started 3 times; see fleet-9.log'); });
        await a.kill();
        await assert.rejects(client.request('tools/list', {}, { timeoutMs: 15000 }), /see fleet-9\.log/);
        t.stop();
    });
});

describe('reconnect after a deliberate stop', () => {
    afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

    test("mid-run: server stopped with 'apra-fleet stop' -> the next request fails with the stop message, no auto-start", async () => {
        const fsMod = (await import('node:fs')).default;
        const osMod = (await import('node:os')).default;
        const pathMod = (await import('node:path')).default;
        const { createFleetHttpTransport } = await import('../src/client/server-resolution.mjs');
        const dataDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'fleet-reconnect-stopped-'));
        cleanups.push(async () => fsMod.rmSync(dataDir, { recursive: true, force: true }));
        const a = await fakeServer('A');
        let autoStarts = 0;
        const t = createFleetHttpTransport({ url: a.url }, {
            env: { APRA_FLEET_DATA_DIR: dataDir },
            checkRunningInstance: async () => ({ running: false, state: 'gone' }),
            autoStartFleetServer: async () => { autoStarts++; return { url: a.url, pid: 1 }; },
        });
        cleanups.push(async () => { try { t.stop(); } catch { /* ignore */ } });
        await t.start();
        const client = new McpClient(t);
        assert.deepStrictEqual(await client.request('tools/list', {}, { timeoutMs: 5000 }), { from: 'A' });
        // The user runs 'apra-fleet stop': marker written, server goes away.
        fsMod.writeFileSync(pathMod.join(dataDir, 'stopped-by-user.json'),
            JSON.stringify({ stoppedAt: '2026-10-03T10:00:00.000Z', by: 'apra-fleet stop', user: 'alice' }));
        await a.kill();
        await assert.rejects(client.request('tools/list', {}, { timeoutMs: 20000 }), /stopped by the user .*run 'apra-fleet start'/);
        assert.strictEqual(autoStarts, 0);
    });
});
