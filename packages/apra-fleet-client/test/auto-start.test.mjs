import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    autoStartFleetServer, resolveFleetStartCommand, lastServerLog, FleetAutoStartError,
    AUTOSTART_MAX_STARTS,
} from '../src/client/auto-start.mjs';
import { resolveFleetServerConnection } from '../src/client/server-resolution.mjs';

// GitHub #585 recovery: a client that finds the shared HTTP server GONE
// starts it the way 'apra-fleet start' does (never a private stdio server),
// serialised across racing clients and capped by a loop guard.

const URL_ = 'http://127.0.0.1:7999/mcp';

/** A fake "world": the server comes up some ms after `start` runs. */
function world({ upAfterMs = 150, startsServer = true } = {}) {
    const w = { up: false, starts: [], probes: 0 };
    w.probe = async () => {
        w.probes++;
        return w.up ? { running: true, state: 'running', url: URL_, pid: 4321 } : { running: false, state: 'gone' };
    };
    w.runStart = (command, args, env) => {
        w.starts.push({ command, args, env });
        if (startsServer) setTimeout(() => { w.up = true; }, upAfterMs);
        return { done: Promise.resolve({ code: 0, output: 'Server starting...' }) };
    };
    return w;
}

describe('autoStartFleetServer', () => {
    let dataDir;
    let env;
    beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-autostart-'));
        env = { APRA_FLEET_DATA_DIR: dataDir };
    });
    afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

    test('gone -> runs `start` once with the resolved command, waits for /health, records the start', async () => {
        const w = world();
        const r = await autoStartFleetServer({
            env, checkRunningInstance: w.probe, runStart: w.runStart,
            startCommand: { command: '/opt/apra-fleet', args: ['start'] }, timeoutMs: 5000,
        });
        assert.deepStrictEqual([r.running, r.url, r.started], [true, URL_, true]);
        assert.strictEqual(w.starts.length, 1);
        assert.deepStrictEqual(w.starts[0].args, ['start']);
        assert.strictEqual(w.starts[0].env, env);
        const ledger = JSON.parse(fs.readFileSync(path.join(dataDir, 'client-autostart.json'), 'utf8'));
        assert.strictEqual(ledger.starts.length, 1);
        assert.strictEqual(fs.existsSync(path.join(dataDir, 'client-autostart.lock')), false, 'lock released');
    });

    test('two concurrent clients on a gone server start exactly one server', async () => {
        const w = world({ upAfterMs: 700 });
        const deps = { env, checkRunningInstance: w.probe, runStart: w.runStart, startCommand: { command: 'x', args: ['start'] }, timeoutMs: 8000 };
        const [a, b] = await Promise.all([autoStartFleetServer(deps), autoStartFleetServer(deps)]);
        assert.strictEqual(w.starts.length, 1, 'exactly one `start` ran');
        assert.strictEqual(a.url, URL_);
        assert.strictEqual(b.url, URL_);
        assert.deepStrictEqual([a.started, b.started].sort(), [false, true]);
    });

    test('unresponsive server -> no start, actionable error', async () => {
        const w = world();
        await assert.rejects(
            autoStartFleetServer({
                env, runStart: w.runStart, startCommand: { command: 'x', args: ['start'] },
                checkRunningInstance: async () => ({ running: false, state: 'unresponsive', pid: 9, url: URL_ }),
            }),
            (err) => err instanceof FleetAutoStartError && err.code === 'SERVER_UNRESPONSIVE' && /apra-fleet stop/.test(err.message),
        );
        assert.strictEqual(w.starts.length, 0);
    });

    test(`loop guard: after ${AUTOSTART_MAX_STARTS} starts in the window, fails naming the last server log`, async () => {
        const logs = path.join(dataDir, 'logs');
        fs.mkdirSync(logs);
        fs.writeFileSync(path.join(logs, 'fleet-100.log'), 'old');
        fs.writeFileSync(path.join(logs, 'fleet-200.log'), 'new');
        const later = new Date(Date.now() + 5000);
        fs.utimesSync(path.join(logs, 'fleet-200.log'), later, later);
        const now = Date.now();
        fs.writeFileSync(path.join(dataDir, 'client-autostart.json'), JSON.stringify({
            starts: [now - 60_000, now - 30_000, now - 1000, now - 3 * 60 * 60 * 1000 /* outside the window */],
        }));
        const w = world();
        await assert.rejects(
            autoStartFleetServer({ env, checkRunningInstance: w.probe, runStart: w.runStart, startCommand: { command: 'x', args: ['start'] } }),
            (err) => {
                assert.strictEqual(err.code, 'AUTOSTART_LIMIT');
                assert.ok(err.message.includes(path.join(logs, 'fleet-200.log')), err.message);
                return true;
            },
        );
        assert.strictEqual(w.starts.length, 0, 'no start past the cap');
    });

    test('entries older than the window do not count toward the cap', async () => {
        const old = Date.now() - 60 * 60 * 1000;
        fs.writeFileSync(path.join(dataDir, 'client-autostart.json'), JSON.stringify({ starts: [old, old, old, old] }));
        const w = world();
        const r = await autoStartFleetServer({ env, checkRunningInstance: w.probe, runStart: w.runStart, startCommand: { command: 'x', args: ['start'] }, timeoutMs: 5000 });
        assert.strictEqual(r.started, true);
    });

    test('server never answers -> AUTOSTART_TIMEOUT naming the log and the start output', async () => {
        const w = world({ startsServer: false });
        await assert.rejects(
            autoStartFleetServer({ env, checkRunningInstance: w.probe, runStart: w.runStart, startCommand: { command: 'x', args: ['start'] }, timeoutMs: 1200 }),
            (err) => err.code === 'AUTOSTART_TIMEOUT' && err.message.includes(path.join(dataDir, 'fleet.log')) && /Server starting/.test(err.message),
        );
        assert.strictEqual(fs.existsSync(path.join(dataDir, 'client-autostart.lock')), false);
    });

    test('a stale lock left by a dead client is broken', async () => {
        fs.writeFileSync(path.join(dataDir, 'client-autostart.lock'), JSON.stringify({ pid: 2 ** 30, at: Date.now() }));
        const w = world();
        const r = await autoStartFleetServer({ env, checkRunningInstance: w.probe, runStart: w.runStart, startCommand: { command: 'x', args: ['start'] }, timeoutMs: 5000 });
        assert.strictEqual(r.started, true);
        assert.strictEqual(w.starts.length, 1);
    });

    test('lastServerLog falls back to fleet.log', () => {
        assert.strictEqual(lastServerLog(dataDir), path.join(dataDir, 'fleet.log'));
    });
});

describe('resolveFleetStartCommand', () => {
    test('the running apra-fleet binary itself wins', () => {
        const r = resolveFleetStartCommand({ execPath: path.join('C:', 'bin', 'apra-fleet.exe'), exists: () => false });
        assert.deepStrictEqual(r.args, ['start']);
        assert.match(r.command, /apra-fleet\.exe$/);
    });

    test('bundled sibling index.js, then dev dist, run with node + start', () => {
        const r = resolveFleetStartCommand({ execPath: '/usr/bin/node', dirname: 'D', exists: (p) => p === path.join('D', 'index.js') });
        assert.deepStrictEqual(r.args, [path.join('D', 'index.js'), 'start']);
    });

    test('installed binary under ~/.apra-fleet/bin', () => {
        const home = path.join(os.tmpdir(), 'h');
        const bin = path.join(home, '.apra-fleet', 'bin', 'apra-fleet.exe');
        const r = resolveFleetStartCommand({ execPath: '/usr/bin/node', homedir: () => home, platform: 'win32', exists: (p) => p === bin });
        assert.deepStrictEqual(r, { command: bin, args: ['start'] });
    });

    test('nothing found -> actionable AUTOSTART_NO_BINARY error', () => {
        assert.throws(
            () => resolveFleetStartCommand({ execPath: '/usr/bin/node', homedir: () => 'H', exists: () => false }),
            (err) => err.code === 'AUTOSTART_NO_BINARY' && /APRA_FLEET_TRANSPORT=stdio/.test(err.message),
        );
    });
});

describe('resolveFleetServerConnection step 3 and the transport overrides', () => {
    const gone = async () => ({ running: false, state: 'gone' });

    test('gone -> auto-start, then attach over HTTP (no stdio descriptor)', async () => {
        let calls = 0;
        const r = await resolveFleetServerConnection({
            env: {}, checkRunningInstance: gone,
            autoStartFleetServer: async (d) => { calls++; assert.strictEqual(d.checkRunningInstance, gone); return { url: URL_, pid: 1, started: true }; },
        });
        assert.strictEqual(calls, 1);
        assert.strictEqual(r.mode, 'http');
        assert.strictEqual(r.url, URL_);
        assert.strictEqual(r.command, undefined);
    });

    test('unresponsive -> unchanged actionable error, no auto-start', async () => {
        let calls = 0;
        await assert.rejects(resolveFleetServerConnection({
            env: {},
            checkRunningInstance: async () => ({ running: false, state: 'unresponsive', pid: 3, url: URL_ }),
            autoStartFleetServer: async () => { calls++; return { url: URL_, pid: 1 }; },
        }), /alive but not answering \/health/);
        assert.strictEqual(calls, 0);
    });

    test('APRA_FLEET_TRANSPORT=stdio keeps the private stdio server: no probe, no auto-start', async () => {
        const r = await resolveFleetServerConnection({
            env: { APRA_FLEET_TRANSPORT: 'stdio', APRA_FLEET_SERVER_CMD: 'node srv.js run' },
            checkRunningInstance: async () => { throw new Error('must not probe'); },
            autoStartFleetServer: async () => { throw new Error('must not auto-start'); },
        });
        assert.deepStrictEqual([r.mode, r.command, r.args], ['stdio', 'node', ['srv.js', 'run']]);
    });

    test('APRA_FLEET_TRANSPORT=http keeps the hard error: no auto-start', async () => {
        let calls = 0;
        await assert.rejects(resolveFleetServerConnection({
            env: { APRA_FLEET_TRANSPORT: 'http' }, checkRunningInstance: gone,
            autoStartFleetServer: async () => { calls++; return { url: URL_, pid: 1 }; },
        }), /APRA_FLEET_TRANSPORT=http was requested/);
        assert.strictEqual(calls, 0);
    });
});
