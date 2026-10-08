// createWorkflowEngine({ transport: 'http' }) must authenticate like every
// other orchestrator-side client: the local server refuses an /mcp session
// without the install's access secret (HTTP 401).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createWorkflowEngine } from '../src/client/factory.mjs';
import { MEMBER_SECRET_HEADER } from '../src/client/server-resolution.mjs';

const SECRET = 'ef'.repeat(32);

async function withStubServer(fn) {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push(req.headers[MEMBER_SECRET_HEADER.toLowerCase()]);
        if (req.method === 'POST') {
            res.setHeader('mcp-session-id', 'sid');
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
        } else if (req.method === 'GET') { res.setHeader('content-type', 'text/event-stream'); res.write(':\n\n'); }
        else { res.statusCode = 200; res.end(); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    try {
        await fn(`http://127.0.0.1:${server.address().port}/mcp`, seen);
    } finally {
        server.closeAllConnections();
        await new Promise(r => server.close(r));
    }
}

function dataDirWithSecret() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-factory-'));
    fs.writeFileSync(path.join(dir, 'member-access.key'), SECRET + '\n');
    return dir;
}

test('createWorkflowEngine (http) sends the install access secret on every request', async () => {
    const dir = dataDirWithSecret();
    try {
        await withStubServer(async (url, seen) => {
            const r = await createWorkflowEngine({ transport: 'http', url, env: { APRA_FLEET_DATA_DIR: dir } });
            try {
                assert.ok(r.engine && r.fleetWorkflow && r.apraFleet, 'engine stack is built');
                assert.ok(seen.length > 0);
                assert.ok(seen.every(h => h === SECRET), `every request carries the secret: ${JSON.stringify(seen)}`);
            } finally { await r.transport.stop(); }
        });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('createWorkflowEngine (http): an explicit caller header wins over the install secret', async () => {
    const dir = dataDirWithSecret();
    try {
        await withStubServer(async (url, seen) => {
            const r = await createWorkflowEngine({
                transport: 'http', url, env: { APRA_FLEET_DATA_DIR: dir },
                options: { headers: { [MEMBER_SECRET_HEADER]: 'explicit' } },
            });
            try {
                assert.ok(seen.length > 0);
                assert.ok(seen.every(h => h === 'explicit'), JSON.stringify(seen));
            } finally { await r.transport.stop(); }
        });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
