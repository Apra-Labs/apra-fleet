import { test, describe } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { spawn as realSpawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
    createSpawner,
    allocateFreePort,
    buildSprintArgv,
    defaultCliPath,
    isPortAvailable,
    DEFAULT_SPAWNER_BASE_PORT,
} from '../src/supervisor/spawner.mjs';

// apra-fleet-eft.4.2 -- detached child-per-sprint spawner with per-sprint
// --viewer-port allocation.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures/spawner');

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Resolve once a process has actually exited. */
function onExit(child) {
    return new Promise((resolve) => { child.once('exit', resolve); });
}

/** Resolve with the first line of stdout as text. */
function firstLine(stream) {
    return new Promise((resolve, reject) => {
        let buf = '';
        function cleanup() {
            stream.off('data', onData);
            stream.off('error', onError);
            stream.off('close', onClose);
        }
        function onData(chunk) {
            buf += chunk.toString('utf-8');
            const idx = buf.indexOf('\n');
            if (idx !== -1) {
                cleanup();
                resolve(buf.slice(0, idx));
            }
        }
        function onError(err) {
            cleanup();
            reject(err);
        }
        // The child can exit (crash, or close stdout) before ever writing a
        // full line -- without this, the promise would hang forever (no
        // 'data' with a newline ever arrives, and 'error' alone does not
        // fire on a clean-but-empty stream close), turning a fast child
        // failure into an indefinite test stall.
        function onClose() {
            cleanup();
            reject(new Error(`stream closed before a full line was read (buffered so far: ${JSON.stringify(buf)})`));
        }
        stream.on('data', onData);
        stream.once('error', onError);
        stream.once('close', onClose);
    });
}

// apra-fleet-ou7.1: bounded poll (never a single long sleep) for a log
// file's content to include `marker` -- the child writes it asynchronously
// after spawn, so a single immediate read can race it.
async function waitForFileContent(filePath, marker, { timeoutMs = 3000, intervalMs = 25 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        let content = '';
        try {
            content = fs.readFileSync(filePath, 'utf-8');
        } catch {
            // file not created/flushed yet
        }
        if (content.includes(marker)) return content;
        if (Date.now() >= deadline) {
            throw new Error(`timed out waiting for '${marker}' in '${filePath}'; last content: ${JSON.stringify(content)}`);
        }
        // eslint-disable-next-line no-await-in-loop -- intentional bounded poll
        await sleep(intervalMs);
    }
}

/** Whether a pid is currently alive, via the standard signal-0 probe. */
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

// -- fake, in-process spawn for fast/deterministic unit tests ---------------

function makeFakeSpawn(pids) {
    let i = 0;
    const calls = [];
    const children = [];
    const spawnFn = (command, args, opts) => {
        const child = new EventEmitter();
        child.pid = pids[i++];
        let unrefCalled = false;
        child.unref = () => { unrefCalled = true; };
        Object.defineProperty(child, 'unrefCalled', { get: () => unrefCalled });
        calls.push({ command, args, opts });
        children.push(child);
        return child;
    };
    return { spawnFn, calls, children };
}

// apra-fleet-ou7.1 -- an in-memory fake fs so the "fake spawn" unit tests
// below never touch the real filesystem (spawnSprint() now always
// mkdirSync/openSync/closeSync's a per-sprint log file). Fabricated fds are
// plain incrementing integers -- good enough to assert "a numeric fd, not
// the string 'ignore'" and to pair each openSync with its later closeSync.
function makeFakeFs() {
    let nextFd = 100;
    const mkdirCalls = [];
    const opened = []; // { path, flags, fd }
    const closed = []; // fd
    return {
        fs: {
            mkdirSync(dir, opts) { mkdirCalls.push({ dir, opts }); },
            openSync(p, flags) {
                const fd = nextFd++;
                opened.push({ path: p, flags, fd });
                return fd;
            },
            closeSync(fd) { closed.push(fd); },
        },
        mkdirCalls,
        opened,
        closed,
    };
}

/** A dataDir + fs pair good enough for any fake-spawn test that does not
 * itself care about log-file behavior -- still fully hermetic (no real
 * filesystem access). */
const FAKE_DATA_DIR = path.join('fake-data-dir'); // relative -- never actually written to (fake fs)

describe('buildSprintArgv', () => {
    test('builds the full cli.mjs flag set including --viewer-port', () => {
        const args = buildSprintArgv({
            issue: 'epic-1,epic-2',
            members: 'm1,m2',
            branch: 'auto-sprint/x',
            base: 'main',
            goal: 'P1/P2',
            maxCycles: 5,
            allowMissingMembers: true,
            requirementsFile: 'reqs.md',
            roleMap: { doer: ['m1'] },
            budget: 12.5,
            viewerPort: 9000,
            extraArgs: ['--help'],
        });
        assert.deepEqual(args, [
            '--issue', 'epic-1,epic-2',
            '--members', 'm1,m2',
            '--branch', 'auto-sprint/x',
            '--base', 'main',
            '--viewer-port', '9000',
            '--goal', 'P1/P2',
            '--max-cycles', '5',
            '--allow-missing-members',
            '--requirements-file', 'reqs.md',
            '--role-map', '{"doer":["m1"]}',
            '--budget', '12.5',
            '--help',
        ]);
    });

    test('omits optional flags entirely when not provided', () => {
        const args = buildSprintArgv({ issue: 'i', members: 'm', branch: 'b', base: 'main', viewerPort: 8080 });
        assert.deepEqual(args, ['--issue', 'i', '--members', 'm', '--branch', 'b', '--base', 'main', '--viewer-port', '8080']);
    });

    // apra-fleet-f34.1: --service-url is forwarded to the spawned cli.mjs
    // child so runner.js takes the HTTP-backed dolt-mutex/id-allocator
    // clients instead of the source-3 no-op fallback.
    test('appends --service-url when serviceUrl is provided', () => {
        const args = buildSprintArgv({
            issue: 'i', members: 'm', branch: 'b', base: 'main', viewerPort: 8080,
            serviceUrl: 'http://localhost:8787',
        });
        assert.deepEqual(args, [
            '--issue', 'i', '--members', 'm', '--branch', 'b', '--base', 'main',
            '--viewer-port', '8080', '--service-url', 'http://localhost:8787',
        ]);
    });

    test('omits --service-url entirely when serviceUrl is not provided (unchanged fallback behavior)', () => {
        const args = buildSprintArgv({ issue: 'i', members: 'm', branch: 'b', base: 'main', viewerPort: 8080 });
        assert.ok(!args.includes('--service-url'));
    });

    // apra-fleet-k7b.1: --run-id forwards the supervisor's own sprintId so the
    // spawned cli.mjs child's engine run-state and dashboard viewer identity
    // are keyed by an incarnation-unique id, not the (relaunch-shared) branch.
    test('appends --run-id when runId is provided', () => {
        const args = buildSprintArgv({
            issue: 'i', members: 'm', branch: 'b', base: 'main', viewerPort: 8080,
            runId: 'PROJ-1-abc123',
        });
        assert.deepEqual(args, [
            '--issue', 'i', '--members', 'm', '--branch', 'b', '--base', 'main',
            '--viewer-port', '8080', '--run-id', 'PROJ-1-abc123',
        ]);
    });

    test('omits --run-id entirely when runId is not provided (falls back to --branch in cli.mjs)', () => {
        const args = buildSprintArgv({ issue: 'i', members: 'm', branch: 'b', base: 'main', viewerPort: 8080 });
        assert.ok(!args.includes('--run-id'));
    });

    test('throws when a required flag is missing', () => {
        assert.throws(() => buildSprintArgv({ members: 'm', branch: 'b', base: 'main', viewerPort: 8080 }), /issue, members, branch, and base/);
    });

    test('throws for a non-integer or out-of-range viewerPort', () => {
        assert.throws(() => buildSprintArgv({ issue: 'i', members: 'm', branch: 'b', base: 'main', viewerPort: 'nope' }), /integer viewerPort/);
        assert.throws(() => buildSprintArgv({ issue: 'i', members: 'm', branch: 'b', base: 'main', viewerPort: 70000 }), /integer viewerPort/);
    });
});

describe('allocateFreePort', () => {
    test('returns the lowest port not excluded and reported available', async () => {
        const port = await allocateFreePort({
            startPort: 20000,
            excludedPorts: new Set([20000, 20001]),
            isAvailable: async () => true,
        });
        assert.equal(port, 20002);
    });

    test('skips ports the OS reports unavailable, independent of excludedPorts', async () => {
        const unavailable = new Set([30000, 30001]);
        const port = await allocateFreePort({
            startPort: 30000,
            excludedPorts: new Set(),
            isAvailable: async (p) => !unavailable.has(p),
        });
        assert.equal(port, 30002);
    });

    test('throws after exhausting maxAttempts', async () => {
        await assert.rejects(
            () => allocateFreePort({ startPort: 40000, maxAttempts: 3, isAvailable: async () => false }),
            /no free --viewer-port found/,
        );
    });

    test('isPortAvailable reflects real OS bind state', async () => {
        const net = await import('node:net');
        const server = net.createServer();
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        assert.equal(await isPortAvailable(port), false);
        await new Promise((resolve) => server.close(resolve));
        assert.equal(await isPortAvailable(port), true);
    });
});

describe('defaultCliPath / DEFAULT_SPAWNER_BASE_PORT', () => {
    test('resolves to the real bin/cli.mjs shipped in this package', async () => {
        const resolved = defaultCliPath();
        assert.match(resolved, /bin[\\/]cli\.mjs$/);
        const fs = await import('node:fs');
        assert.ok(fs.existsSync(resolved), `expected ${resolved} to exist`);
    });

    test('DEFAULT_SPAWNER_BASE_PORT is a valid port', () => {
        assert.ok(Number.isInteger(DEFAULT_SPAWNER_BASE_PORT) && DEFAULT_SPAWNER_BASE_PORT > 0 && DEFAULT_SPAWNER_BASE_PORT < 65536);
    });
});

describe('createSpawner -- unit behavior (fake spawn)', () => {
    test('spawnSprint launches detached with stdout/stderr teed to a log file fd (not "ignore"), unrefs, and returns pid+port+logPath', async () => {
        const { spawnFn, calls, children } = makeFakeSpawn([111]);
        const fakeFs = makeFakeFs();
        const spawner = createSpawner({
            spawn: spawnFn,
            command: '/usr/bin/node',
            cliPath: '/repo/bin/cli.mjs',
            basePort: 9000,
            isPortAvailable: async () => true,
            dataDir: FAKE_DATA_DIR,
            fs: fakeFs.fs,
        });

        const result = await spawner.spawnSprint({ issue: 'i1', members: 'm1', branch: 'b1', base: 'main' });

        assert.equal(result.pid, 111);
        assert.equal(result.port, 9000);
        assert.equal(result.command, '/usr/bin/node');
        assert.deepEqual(result.args.slice(0, 2), ['/repo/bin/cli.mjs', '--issue']);
        assert.ok(typeof result.logPath === 'string' && result.logPath.length > 0);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].opts.detached, true);
        // apra-fleet-ou7.1 acceptance criterion: spawn() must be called with
        // file descriptors for stdout/stderr, not the string 'ignore'.
        assert.ok(Array.isArray(calls[0].opts.stdio), 'stdio must be an array, not the string "ignore"');
        assert.equal(calls[0].opts.stdio[0], 'ignore'); // stdin unchanged
        assert.equal(typeof calls[0].opts.stdio[1], 'number');
        assert.equal(typeof calls[0].opts.stdio[2], 'number');
        assert.equal(calls[0].opts.stdio[1], calls[0].opts.stdio[2], 'stdout and stderr share the SAME fd (teed to one file)');
        assert.notEqual(calls[0].opts.stdio[1], 'ignore');

        assert.equal(children[0].unrefCalled, true);
        assert.equal(spawner.liveCount, 1);
        assert.deepEqual(spawner.livePorts, new Set([9000]));

        // The log file was opened (mkdir'd first) at the returned logPath.
        assert.equal(fakeFs.mkdirCalls.length, 1);
        assert.deepEqual(fakeFs.mkdirCalls[0].opts, { recursive: true });
        assert.equal(fakeFs.opened.length, 1);
        assert.equal(fakeFs.opened[0].path, result.logPath);
        assert.equal(fakeFs.opened[0].fd, calls[0].opts.stdio[1]);
        // Not yet closed -- the child hasn't exited.
        assert.equal(fakeFs.closed.length, 0);

        // Closed exactly once, the moment the child exits.
        children[0].emit('exit', 0, null);
        assert.deepEqual(fakeFs.closed, [fakeFs.opened[0].fd]);
    });

    // apra-fleet-f34.1: createSpawner's own deps.serviceUrl (the supervisor's
    // listening address, as wired by bin/serve.mjs) is forwarded into every
    // spawnSprint() call's argv via buildSprintArgv, without the caller
    // needing to pass serviceUrl itself on each spawnSprint() call.
    test('spawnSprint threads deps.serviceUrl through to the child argv as --service-url', async () => {
        const { spawnFn, calls } = makeFakeSpawn([222]);
        const spawner = createSpawner({
            spawn: spawnFn,
            basePort: 9050,
            isPortAvailable: async () => true,
            serviceUrl: 'http://localhost:8787',
            dataDir: FAKE_DATA_DIR,
            fs: makeFakeFs().fs,
        });

        await spawner.spawnSprint({ issue: 'i1', members: 'm1', branch: 'b1', base: 'main' });

        assert.ok(calls[0].args.includes('--service-url'));
        assert.equal(calls[0].args[calls[0].args.indexOf('--service-url') + 1], 'http://localhost:8787');
    });

    test('spawnSprint omits --service-url when neither deps.serviceUrl nor opts.serviceUrl is set', async () => {
        const { spawnFn, calls } = makeFakeSpawn([223]);
        const spawner = createSpawner({ spawn: spawnFn, basePort: 9060, isPortAvailable: async () => true, dataDir: FAKE_DATA_DIR, fs: makeFakeFs().fs });

        await spawner.spawnSprint({ issue: 'i1', members: 'm1', branch: 'b1', base: 'main' });

        assert.ok(!calls[0].args.includes('--service-url'));
    });

    // apra-fleet-k7b.3: the optional onChildExit callback is invoked with the
    // Node 'exit' event's own (code, signal) args, this launch's runId, and
    // an injectable clock -- so bin/serve.mjs's wiring can persist them into
    // the ledger/history without the spawner owning that persistence itself.
    describe('onChildExit (apra-fleet-k7b.3)', () => {
        test('is called with pid, runId, exitCode, signal, and the injected clock on a nonzero exit', async () => {
            const { spawnFn, children } = makeFakeSpawn([777]);
            const calls = [];
            const spawner = createSpawner({
                spawn: spawnFn,
                basePort: 9070,
                isPortAvailable: async () => true,
                onChildExit: (info) => calls.push(info),
                now: () => '2026-07-30T21:25:50.000Z',
                dataDir: FAKE_DATA_DIR,
                fs: makeFakeFs().fs,
            });

            const result = await spawner.spawnSprint({
                issue: 'i1', members: 'm1', branch: 'b1', base: 'main', runId: 'PROJ-1-abc123',
            });
            children[0].emit('exit', 1, null);

            assert.equal(calls.length, 1);
            assert.deepEqual(calls[0], {
                pid: result.pid,
                runId: 'PROJ-1-abc123',
                exitCode: 1,
                signal: null,
                at: '2026-07-30T21:25:50.000Z',
                // apra-fleet-ou7.1: the same logPath returned by spawnSprint().
                logPath: result.logPath,
            });
        });

        test('reports a null exitCode and the killing signal when the child was killed by a signal', async () => {
            const { spawnFn, children } = makeFakeSpawn([778]);
            const calls = [];
            const spawner = createSpawner({
                spawn: spawnFn,
                basePort: 9071,
                isPortAvailable: async () => true,
                onChildExit: (info) => calls.push(info),
                dataDir: FAKE_DATA_DIR,
                fs: makeFakeFs().fs,
            });

            await spawner.spawnSprint({ issue: 'i1', members: 'm1', branch: 'b1', base: 'main', runId: 'PROJ-1-xyz' });
            children[0].emit('exit', null, 'SIGKILL');

            assert.equal(calls.length, 1);
            assert.equal(calls[0].exitCode, null);
            assert.equal(calls[0].signal, 'SIGKILL');
            assert.equal(calls[0].runId, 'PROJ-1-xyz');
        });

        test('reports runId: null when the launch had no opts.runId (e.g. a direct/standalone call)', async () => {
            const { spawnFn, children } = makeFakeSpawn([779]);
            const calls = [];
            const spawner = createSpawner({
                spawn: spawnFn, basePort: 9072, isPortAvailable: async () => true,
                onChildExit: (info) => calls.push(info),
                dataDir: FAKE_DATA_DIR,
                fs: makeFakeFs().fs,
            });

            await spawner.spawnSprint({ issue: 'i1', members: 'm1', branch: 'b1', base: 'main' });
            children[0].emit('exit', 0, null);

            assert.equal(calls[0].runId, null);
        });

        test('a throwing onChildExit callback never blocks the port/pid bookkeeping cleanup', async () => {
            const { spawnFn, children } = makeFakeSpawn([780, 781]);
            const spawner = createSpawner({
                spawn: spawnFn, basePort: 9073, isPortAvailable: async () => true,
                dataDir: FAKE_DATA_DIR,
                fs: makeFakeFs().fs,
                onChildExit: () => { throw new Error('boom'); },
                logger: { error: () => {} }, // swallow the logged error for a clean test
            });

            await spawner.spawnSprint({ issue: 'a', members: 'm', branch: 'ba', base: 'main' });
            assert.equal(spawner.liveCount, 1);
            children[0].emit('exit', 1, null);
            // Bookkeeping cleanup (live.delete) still ran despite the callback throwing.
            assert.equal(spawner.liveCount, 0);

            // And the spawner is still fully usable afterward.
            const b = await spawner.spawnSprint({ issue: 'b', members: 'm', branch: 'bb', base: 'main' });
            assert.ok(Number.isInteger(b.port));
        });

        test('an onChildExit callback that returns a REJECTED promise (the real async wiring in serve.mjs) never surfaces as an unhandled rejection', async () => {
            const { spawnFn, children } = makeFakeSpawn([783, 784]);
            const spawner = createSpawner({
                spawn: spawnFn, basePort: 9075, isPortAvailable: async () => true,
                dataDir: FAKE_DATA_DIR,
                fs: makeFakeFs().fs,
                onChildExit: async () => { throw new Error('async boom'); },
                logger: { error: () => {} },
            });

            const unhandled = [];
            const onUnhandled = (err) => unhandled.push(err);
            process.on('unhandledRejection', onUnhandled);
            try {
                await spawner.spawnSprint({ issue: 'a', members: 'm', branch: 'ba', base: 'main' });
                children[0].emit('exit', 1, null);
                // Let the callback's rejected promise's microtask/catch settle.
                await new Promise((resolve) => setImmediate(resolve));
                assert.equal(unhandled.length, 0, 'the async callback rejection must be caught, never surfaced as unhandledRejection');
                assert.equal(spawner.liveCount, 0);
            } finally {
                process.removeListener('unhandledRejection', onUnhandled);
            }
        });

        test('spawnSprint works exactly as before when no onChildExit is injected', async () => {
            const { spawnFn, children } = makeFakeSpawn([782]);
            const spawner = createSpawner({ spawn: spawnFn, basePort: 9074, isPortAvailable: async () => true, dataDir: FAKE_DATA_DIR, fs: makeFakeFs().fs });

            await spawner.spawnSprint({ issue: 'a', members: 'm', branch: 'ba', base: 'main' });
            assert.doesNotThrow(() => children[0].emit('exit', 0, null));
            assert.equal(spawner.liveCount, 0);
        });
    });

    test('two concurrent sprints never receive the same port', async () => {
        const { spawnFn } = makeFakeSpawn([1, 2]);
        const spawner = createSpawner({ spawn: spawnFn, basePort: 9100, isPortAvailable: async () => true, dataDir: FAKE_DATA_DIR, fs: makeFakeFs().fs });

        const a = await spawner.spawnSprint({ issue: 'a', members: 'm', branch: 'ba', base: 'main' });
        const b = await spawner.spawnSprint({ issue: 'b', members: 'm', branch: 'bb', base: 'main' });

        assert.notEqual(a.port, b.port);
        assert.equal(spawner.liveCount, 2);
    });

    test('a port frees for reuse once its sprint exits, and not before', async () => {
        const { spawnFn, children } = makeFakeSpawn([1, 2, 3, 4]);
        const spawner = createSpawner({ spawn: spawnFn, basePort: 9200, isPortAvailable: async () => true, dataDir: FAKE_DATA_DIR, fs: makeFakeFs().fs });

        const a = await spawner.spawnSprint({ issue: 'a', members: 'm', branch: 'ba', base: 'main' });
        const b = await spawner.spawnSprint({ issue: 'b', members: 'm', branch: 'bb', base: 'main' });
        assert.equal(a.port, 9200);
        assert.equal(b.port, 9201);

        // Not yet exited: a third sprint must NOT reuse either live port.
        const c = await spawner.spawnSprint({ issue: 'c', members: 'm', branch: 'bc', base: 'main' });
        assert.equal(c.port, 9202);

        // Now "a" exits -- its port becomes eligible again.
        children[0].emit('exit', 0, null);
        assert.equal(spawner.liveCount, 2);
        assert.deepEqual(spawner.livePorts, new Set([9201, 9202]));

        const d = await spawner.spawnSprint({ issue: 'd', members: 'm', branch: 'bd', base: 'main' });
        assert.equal(d.port, 9200);
    });

    test('killing/exiting one sprint never affects bookkeeping for a sibling', async () => {
        const { spawnFn, children } = makeFakeSpawn([1, 2]);
        const spawner = createSpawner({ spawn: spawnFn, basePort: 9300, isPortAvailable: async () => true, dataDir: FAKE_DATA_DIR, fs: makeFakeFs().fs });

        await spawner.spawnSprint({ issue: 'a', members: 'm', branch: 'ba', base: 'main' });
        const b = await spawner.spawnSprint({ issue: 'b', members: 'm', branch: 'bb', base: 'main' });

        children[0].emit('exit', 1, null);

        assert.equal(spawner.liveCount, 1);
        assert.equal(spawner.getLiveEntry(b.pid).port, 9301);
    });

    test('stop() clears local bookkeeping but never kills a live child', async () => {
        const { spawnFn, children } = makeFakeSpawn([1]);
        let killed = false;
        const spawner = createSpawner({ spawn: spawnFn, basePort: 9400, isPortAvailable: async () => true, dataDir: FAKE_DATA_DIR, fs: makeFakeFs().fs });
        await spawner.spawnSprint({ issue: 'a', members: 'm', branch: 'ba', base: 'main' });
        children[0].kill = () => { killed = true; };

        await spawner.stop();

        assert.equal(spawner.liveCount, 0);
        assert.equal(killed, false);
    });

    test('spawnSprint rejects when spawn() returns no pid, and still closes the log fd it had already opened', async () => {
        const fakeFs = makeFakeFs();
        const spawner = createSpawner({
            spawn: () => ({ once() {}, unref() {} }),
            basePort: 9500,
            isPortAvailable: async () => true,
            dataDir: FAKE_DATA_DIR,
            fs: fakeFs.fs,
        });
        await assert.rejects(
            () => spawner.spawnSprint({ issue: 'a', members: 'm', branch: 'ba', base: 'main' }),
            /failed to launch/,
        );

        // apra-fleet-ou7.1: the log file WAS opened (before the pid check
        // failed) and must still be closed -- a failed launch must never
        // leak the fd.
        assert.equal(fakeFs.opened.length, 1);
        assert.deepEqual(fakeFs.closed, [fakeFs.opened[0].fd]);
    });
});

describe('createSpawner -- real detached child process (orphan survival)', () => {
    test('killing the spawner\'s process (SIGKILL) leaves the spawned child running', async () => {
        const basePort = 18100 + Math.floor(Math.random() * 200);
        // apra-fleet-ou7.1: harness.mjs's own createSpawner() now always opens a
        // real per-sprint log file -- point FLEET_SE_DATA_DIR at an isolated
        // temp dir so this test never writes under the real ~/.apra-fleet-se.
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-spawner-harness-'));
        const harness = realSpawn(process.execPath, [path.join(fixturesDir, 'harness.mjs')], {
            stdio: ['ignore', 'pipe', 'inherit'],
            env: { ...process.env, SPAWNER_TEST_BASE_PORT: String(basePort), SPAWNER_TEST_SPRINT_COUNT: '1', FLEET_SE_DATA_DIR: dataDir },
        });

        try {
            const line = await firstLine(harness.stdout);
            const [{ pid, logPath }] = JSON.parse(line);
            assert.ok(Number.isInteger(pid));
            assert.equal(isAlive(pid), true, 'sprint child should be alive right after spawn');

            // apra-fleet-ou7.1 acceptance criterion: a REAL, non-empty log file
            // on disk, at the path this SAME real spawnSprint() call recorded --
            // the actual OS-level detached + integer-fd tee, not a mock.
            assert.ok(typeof logPath === 'string' && logPath.length > 0);
            await waitForFileContent(logPath, 'SPRINT CHILD STARTED');

            // Kill the "supervisor" harness process hard.
            harness.kill('SIGKILL');
            await onExit(harness);

            // Give the OS a moment, then assert the child is STILL alive --
            // the whole point of detached + unref().
            await sleep(300);
            assert.equal(isAlive(pid), true, 'sprint child must survive its supervisor being SIGKILLed');

            process.kill(pid, 'SIGKILL');
            await sleep(100);
            assert.equal(isAlive(pid), false, 'sanity check: our own cleanup kill worked');

            // apra-fleet-ou7.1 acceptance criterion: the log file survives the
            // crash/kill (it was never owned by the now-dead child's lifetime --
            // this process's own copy of the fd was already closed at 'exit'
            // inside harness.mjs's spawnSprint(), and the file itself persists
            // on disk regardless of either process's state).
            assert.ok(fs.readFileSync(logPath, 'utf-8').includes('SPRINT CHILD STARTED'));
        } finally {
            if (!harness.killed) harness.kill('SIGKILL');
            // The sprint child (killed above) has released its log fd by now;
            // safe to remove the isolated temp data dir it was pointed at.
            try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    });

    test('two sibling sprints get distinct real ports; killing one leaves the other alive', async () => {
        const basePort = 18300 + Math.floor(Math.random() * 200);
        // apra-fleet-ou7.1: see the previous test's comment -- isolate the log dir.
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-spawner-harness-'));
        const harness = realSpawn(process.execPath, [path.join(fixturesDir, 'harness.mjs')], {
            stdio: ['ignore', 'pipe', 'inherit'],
            env: { ...process.env, SPAWNER_TEST_BASE_PORT: String(basePort), SPAWNER_TEST_SPRINT_COUNT: '2', FLEET_SE_DATA_DIR: dataDir },
        });

        let pids = [];
        try {
            const line = await firstLine(harness.stdout);
            const results = JSON.parse(line);
            pids = results.map((r) => r.pid);
            const ports = results.map((r) => r.port);
            const logPaths = results.map((r) => r.logPath);

            assert.equal(new Set(ports).size, 2, 'sibling sprints must get distinct viewer ports');
            assert.equal(isAlive(pids[0]), true);
            assert.equal(isAlive(pids[1]), true);

            // apra-fleet-ou7.1: each sibling gets its OWN real, non-empty log file.
            assert.equal(new Set(logPaths).size, 2, 'sibling sprints must get distinct log files');
            await Promise.all(logPaths.map((p) => waitForFileContent(p, 'SPRINT CHILD STARTED')));

            process.kill(pids[0], 'SIGKILL');
            await sleep(300);

            assert.equal(isAlive(pids[0]), false);
            assert.equal(isAlive(pids[1]), true, 'killing one sibling must not affect the other');
        } finally {
            for (const pid of pids) {
                if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
            }
            if (!harness.killed) harness.kill('SIGKILL');
            await sleep(100); // let the OS release the just-killed children's log fds
            try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    });
});
