import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    autoStartFleetServer, resolveFleetStartCommand, lastServerLog, FleetAutoStartError,
    AUTOSTART_MAX_STARTS, clientServerVersion, versionCore,
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
    // Every lookup here is injected (exists/homedir/probeVersion): a test never
    // probes or starts a real installed binary.
    const HOME = path.join(os.tmpdir(), 'h');
    const BIN = path.join(HOME, '.apra-fleet', 'bin', 'apra-fleet.exe');
    const base = { execPath: '/usr/bin/node', homedir: () => HOME, platform: 'win32', expectedVersion: 'v0.4.4_abc' };

    test('the running apra-fleet binary itself wins when its version matches', () => {
        const r = resolveFleetStartCommand({ ...base, execPath: path.join('C:', 'bin', 'apra-fleet.exe'), exists: () => false, probeVersion: () => 'v0.4.4_abc' });
        assert.deepStrictEqual(r.args, ['start']);
        assert.match(r.command, /apra-fleet\.exe$/);
    });

    test('bundled sibling index.js, run with node + start, when its version matches', () => {
        const r = resolveFleetStartCommand({ ...base, dirname: 'D', exists: (p) => p === path.join('D', 'index.js'), probeVersion: () => '0.4.4' });
        assert.deepStrictEqual(r.args, [path.join('D', 'index.js'), 'start']);
    });

    test('installed binary under ~/.apra-fleet/bin when its version matches', () => {
        const r = resolveFleetStartCommand({ ...base, exists: (p) => p === BIN, probeVersion: () => 'v0.4.4_def' });
        assert.deepStrictEqual(r, { command: BIN, args: ['start'], version: 'v0.4.4_def' });
    });

    test('prefers the matching build over a mismatched installed binary', () => {
        const entry = path.join('D', 'index.js');
        const r = resolveFleetStartCommand({
            ...base, dirname: 'D', exists: (p) => p === entry || p === BIN,
            probeVersion: (c) => (c.kind === 'binary' ? 'v0.4.3_95435e' : '0.4.4'),
        });
        assert.deepStrictEqual(r.args, [entry, 'start']);
    });

    test('version skew -> refuses, naming both versions and apra-fleet install', () => {
        assert.throws(
            () => resolveFleetStartCommand({ ...base, exists: (p) => p === BIN, probeVersion: () => 'v0.4.3_95435e' }),
            (err) => err.code === 'AUTOSTART_VERSION_SKEW'
                && err.message.includes('v0.4.4_abc') && err.message.includes('v0.4.3_95435e')
                && err.message.includes(BIN) && /apra-fleet install/.test(err.message),
        );
    });

    test('unknown client version -> refuses rather than guessing', () => {
        assert.throws(
            () => resolveFleetStartCommand({ ...base, expectedVersion: null, exists: (p) => p === BIN, probeVersion: () => 'v0.4.4' }),
            (err) => err.code === 'AUTOSTART_VERSION_UNKNOWN',
        );
    });

    test('nothing found -> actionable AUTOSTART_NO_BINARY error', () => {
        assert.throws(
            () => resolveFleetStartCommand({ ...base, exists: () => false }),
            (err) => err.code === 'AUTOSTART_NO_BINARY' && /APRA_FLEET_TRANSPORT=stdio/.test(err.message),
        );
    });

    test('inside the test sandbox an uninjected lookup is refused (never falls through to ~/.apra-fleet/bin)', () => {
        assert.throws(
            () => resolveFleetStartCommand({ env: { APRA_TEST_SANDBOX_ROOT: os.tmpdir() } }),
            (err) => err.code === 'AUTOSTART_TEST_UNINJECTED',
        );
    });
});

describe('clientServerVersion', () => {
    test('nearest version.json (dev monorepo)', () => {
        const files = { [path.join('R', 'version.json')]: '{"version":"0.4.4"}' };
        const v = clientServerVersion({ clientDir: path.join('R', 'packages', 'apra-fleet-client', 'src', 'client'), exists: (f) => f in files, readFile: (f) => files[f] });
        assert.strictEqual(v, '0.4.4');
    });

    test('workflows/.installed.json of the install that extracted the client', () => {
        const base = path.join('H', '.apra-fleet');
        const files = { [path.join(base, 'workflows', '.installed.json')]: '{"version":"v0.4.3_95435e"}' };
        const v = clientServerVersion({
            clientDir: path.join(base, 'node_modules', '@apralabs', 'apra-fleet-client', 'src', 'client'),
            exists: (f) => f in files, readFile: (f) => files[f],
        });
        assert.strictEqual(v, 'v0.4.3_95435e');
        assert.strictEqual(versionCore(v), '0.4.3');
    });

    test('this checkout: the client belongs to the repo version', () => {
        const repo = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'version.json'), 'utf8')).version;
        assert.strictEqual(versionCore(clientServerVersion()), versionCore(repo));
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
