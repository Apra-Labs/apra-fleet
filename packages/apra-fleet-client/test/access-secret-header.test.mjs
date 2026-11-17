import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { StreamableHttpTransport } from '../src/client/transport.mjs';
import { withFleetAccessSecret, readMemberAccessSecret, MEMBER_SECRET_HEADER } from '../src/client/server-resolution.mjs';

const SECRET = 'ab'.repeat(32);

function dataDirWith(secret) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-secret-'));
    if (secret !== null) fs.writeFileSync(path.join(dir, 'member-access.key'), secret + '\n');
    return dir;
}

test('withFleetAccessSecret adds the install secret as X-Apra-Fleet-Member-Secret', () => {
    const dir = dataDirWith(SECRET);
    try {
        const env = { APRA_FLEET_DATA_DIR: dir };
        assert.strictEqual(readMemberAccessSecret(env), SECRET);
        const opts = withFleetAccessSecret({ headers: { 'X-Other': '1' } }, env);
        assert.strictEqual(opts.headers[MEMBER_SECRET_HEADER], SECRET);
        assert.strictEqual(opts.headers['X-Other'], '1');
        // an explicit header wins
        assert.strictEqual(withFleetAccessSecret({ headers: { [MEMBER_SECRET_HEADER]: 'explicit' } }, env).headers[MEMBER_SECRET_HEADER], 'explicit');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('withFleetAccessSecret leaves options alone when no (or a malformed) secret file exists', () => {
    const none = dataDirWith(null);
    const bad = dataDirWith('not-a-secret');
    try {
        const o = { headers: { a: 'b' } };
        assert.strictEqual(withFleetAccessSecret(o, { APRA_FLEET_DATA_DIR: none }), o);
        assert.strictEqual(withFleetAccessSecret(o, { APRA_FLEET_DATA_DIR: bad }), o);
    } finally { fs.rmSync(none, { recursive: true, force: true }); fs.rmSync(bad, { recursive: true, force: true }); }
});

test('a transport built from withFleetAccessSecret sends the header on the wire', async () => {
    const dir = dataDirWith(SECRET);
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
        const t = new StreamableHttpTransport(`http://127.0.0.1:${server.address().port}/mcp`, withFleetAccessSecret({}, { APRA_FLEET_DATA_DIR: dir }));
        await t.start();
        assert.ok(seen.length > 0);
        assert.ok(seen.every(h => h === SECRET), `every request carries the secret: ${JSON.stringify(seen)}`);
        await t.stop();
    } finally {
        server.closeAllConnections();
        await new Promise(r => server.close(r));
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
