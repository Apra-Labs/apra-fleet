import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { StreamableHttpTransport } from '../src/client/transport.mjs';
import { connectFleetMember } from '../src/client/server-resolution.mjs';

function startServer(initStatus) {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push(`${req.method} ${req.url} ${req.headers['mcp-session-id'] || ''}`.trim());
        if (req.method === 'POST') {
            res.statusCode = initStatus;
            res.setHeader('mcp-session-id', 'sid-1');
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
        } else if (req.method === 'GET') {
            res.setHeader('content-type', 'text/event-stream');
            res.write(':\n\n');
        } else { res.statusCode = 200; res.end(); }
    });
    return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}
const stopServer = (s) => { s.server.closeAllConnections(); return new Promise(r => s.server.close(r)); };

test('start() rejects a non-OK initialize with a typed HTTP_403 error', async () => {
    const s = await startServer(403);
    try {
        const t = new StreamableHttpTransport(s.url);
        await assert.rejects(() => t.start(), (e) => e.status === 403 && e.code === 'HTTP_403');
    } finally { await stopServer(s); }
});

test('connectFleetMember refuses a stdio resolution', async () => {
    await assert.rejects(
        () => connectFleetMember('11111111-2222-4333-8444-555555555555', {
            env: { APRA_FLEET_TRANSPORT: 'stdio', APRA_FLEET_SERVER_CMD: 'node' },
            checkRunningInstance: async () => ({ running: false }),
        }),
        /requires the local apra-fleet HTTP server/,
    );
});

test('connectFleetMember appends ?member= and close() sends the session DELETE', async () => {
    const s = await startServer(200);
    try {
        const h = await connectFleetMember('abcdef12-0000-4000-8000-000000000000', {
            env: {},
            checkRunningInstance: async () => ({ running: true, url: s.url, pid: process.pid }),
        });
        assert.ok(h.url.endsWith('?member=abcdef12-0000-4000-8000-000000000000'));
        await h.close();
        assert.ok(s.seen.includes('DELETE /mcp?member=abcdef12-0000-4000-8000-000000000000 sid-1'), JSON.stringify(s.seen));
    } finally { await stopServer(s); }
});

test('connectFleetMember adds origin=engine only when asked, and refuses any other origin', async () => {
    const s = await startServer(200);
    try {
        const deps = { env: {}, checkRunningInstance: async () => ({ running: true, url: s.url, pid: process.pid }) };
        const plain = await connectFleetMember('abcdef12-0000-4000-8000-000000000000', deps);
        assert.ok(!plain.url.includes('origin='), plain.url);
        await plain.close();
        const engine = await connectFleetMember('abcdef12-0000-4000-8000-000000000000', { ...deps, origin: 'engine' });
        assert.ok(engine.url.endsWith('?member=abcdef12-0000-4000-8000-000000000000&origin=engine'), engine.url);
        await engine.close();
        await assert.rejects(
            () => connectFleetMember('abcdef12-0000-4000-8000-000000000000', { ...deps, origin: 'agent' }),
            /unsupported origin/,
        );
    } finally { await stopServer(s); }
});

test('connectFleetMember sends the member access secret of its data dir on every request, and none when the install has none', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { MEMBER_SECRET_HEADER } = await import('../src/client/server-resolution.mjs');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-member-secret-'));
    const headers = [];
    const server = http.createServer((req, res) => {
        headers.push(`${req.method} ${req.headers[MEMBER_SECRET_HEADER.toLowerCase()] ?? '<none>'}`);
        if (req.method === 'POST') {
            res.setHeader('mcp-session-id', 'sid-1');
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
        } else { res.statusCode = 200; res.end(); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const deps = { env: { APRA_FLEET_DATA_DIR: dataDir }, checkRunningInstance: async () => ({ running: true, url, pid: process.pid }) };
    try {
        const none = await connectFleetMember('abcdef12-0000-4000-8000-000000000000', deps);
        await none.close();
        assert.ok(headers.length > 0 && headers.every(h => h.endsWith('<none>')), JSON.stringify(headers));
        headers.length = 0;
        const secret = 'a'.repeat(64);
        fs.writeFileSync(path.join(dataDir, 'member-access.key'), `${secret}\n`);
        const withSecret = await connectFleetMember('abcdef12-0000-4000-8000-000000000000', deps);
        await withSecret.close();
        assert.ok(headers.some(h => h.startsWith('POST')), JSON.stringify(headers));
        assert.ok(headers.some(h => h.startsWith('DELETE')), JSON.stringify(headers));
        assert.ok(headers.every(h => h.endsWith(secret)), JSON.stringify(headers));
    } finally {
        server.closeAllConnections();
        await new Promise(r => server.close(r));
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test('connectFleetMember adds kb_maintainer=1 only with origin engine', async () => {
    const s = await startServer(200);
    try {
        const deps = { env: {}, checkRunningInstance: async () => ({ running: true, url: s.url, pid: process.pid }) };
        const engine = await connectFleetMember('abcdef12-0000-4000-8000-000000000000', { ...deps, origin: 'engine' });
        assert.ok(!engine.url.includes('kb_maintainer'), engine.url);
        await engine.close();
        const maint = await connectFleetMember('abcdef12-0000-4000-8000-000000000000', { ...deps, origin: 'engine', kbMaintainer: true });
        assert.ok(maint.url.endsWith('?member=abcdef12-0000-4000-8000-000000000000&origin=engine&kb_maintainer=1'), maint.url);
        await maint.close();
        await assert.rejects(
            () => connectFleetMember('abcdef12-0000-4000-8000-000000000000', { ...deps, kbMaintainer: true }),
            /kbMaintainer requires origin 'engine'/,
        );
        await assert.rejects(
            () => connectFleetMember('abcdef12-0000-4000-8000-000000000000', { ...deps, origin: 'engine', kbMaintainer: 'yes' }),
            /kbMaintainer must be a boolean/,
        );
    } finally { await stopServer(s); }
});
