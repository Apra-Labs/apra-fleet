import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// GitHub #585 recovery, end to end against the REAL built server
// (<repo>/dist/index.js): two client processes find no server, exactly one
// shared HTTP server is started (via the server's own `start` verb), both
// attach over HTTP (no stdio child), and the server outlives both clients.
// Fully sandboxed: temp data dir, free port, temp HOME/USERPROFILE.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');
const RESOLUTION = pathToFileURL(path.resolve(__dirname, '..', 'src', 'client', 'server-resolution.mjs')).href;

async function freePort() {
    const s = net.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const { port } = s.address();
    await new Promise((r) => s.close(r));
    return port;
}

function health(url) {
    return new Promise((resolve) => {
        const req = http.get(url.replace(/\/mcp$/, '/health'), { timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on('error', () => resolve(0));
        req.on('timeout', () => { req.destroy(); resolve(0); });
    });
}

function alive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function runClient(script, env) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [script], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        const killer = setTimeout(() => child.kill(), 90_000);
        child.once('exit', (code) => { clearTimeout(killer); resolve({ code, out, err }); });
    });
}

test('gone server: two concurrent clients start exactly one shared HTTP server, attach over HTTP, and it outlives them',
    { skip: !fs.existsSync(DIST_INDEX) && 'dist/index.js missing -- run npm run build first', timeout: 150_000 },
    async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-autostart-real-'));
        const dataDir = path.join(root, 'data');
        const home = path.join(root, 'home');
        fs.mkdirSync(home, { recursive: true });
        const port = await freePort();
        const script = path.join(root, 'client.mjs');
        fs.writeFileSync(script, [
            `import { connectFleet } from ${JSON.stringify(RESOLUTION)};`,
            // Binary resolution is injected: this test starts THIS build, never an installed binary.
            `const { transport, fleetApi, mode } = await connectFleet({ startCommand: { command: process.execPath, args: [${JSON.stringify(DIST_INDEX)}, 'start'] } });`,
            "const res = await fleetApi.listMembers({ format: 'json' });",
            'console.log(JSON.stringify({ mode, transport: transport.constructor.name, listed: !!res }));',
            'transport.stop();',
            'process.exit(0);',
        ].join('\n'));
        // isolated-home-allow: HOME/USERPROFILE point at this test's own temp home, never the real profile.
        const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir, APRA_FLEET_PORT: String(port), HOME: home, USERPROFILE: home };
        for (const k of ['APRA_FLEET_TRANSPORT', 'APRA_FLEET_SERVER_CMD', 'APRA_FLEET_SERVER_BIN', 'APRA_FLEET_SERVICE', 'INVOCATION_ID', 'XPC_SERVICE_NAME']) delete env[k];

        let pid = null;
        try {
            const [a, b] = await Promise.all([runClient(script, env), runClient(script, env)]);
            for (const r of [a, b]) {
                assert.strictEqual(r.code, 0, `client failed: ${r.err}`);
                const line = JSON.parse(r.out.trim().split(/\r?\n/).pop());
                assert.deepStrictEqual(line, { mode: 'http', transport: 'ReconnectingHttpTransport', listed: true });
            }
            const info = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.json'), 'utf8'));
            pid = info.pid;
            assert.strictEqual(Number(new URL(info.url).port), port);
            // Both clients have exited; the server they started is still up.
            assert.ok(alive(pid), 'server outlives its clients');
            assert.strictEqual(await health(info.url), 200);
            // Exactly one server process ever started listening.
            const logs = fs.readdirSync(path.join(dataDir, 'logs')).filter((n) => /^fleet-\d+\.log$/.test(n));
            const started = logs.filter((n) => /started transport=http/.test(fs.readFileSync(path.join(dataDir, 'logs', n), 'utf8')));
            assert.deepStrictEqual(started, [`fleet-${pid}.log`]);
            const ledger = JSON.parse(fs.readFileSync(path.join(dataDir, 'client-autostart.json'), 'utf8'));
            assert.strictEqual(ledger.starts.length, 1, 'exactly one auto-start');
        } finally {
            if (!pid) { try { pid = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.json'), 'utf8')).pid; } catch { /* none */ } }
            if (pid && alive(pid)) {
                try { process.kill(pid); } catch { /* gone */ }
                const until = Date.now() + 15_000;
                while (alive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
            }
            try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best-effort */ }
        }
    });
