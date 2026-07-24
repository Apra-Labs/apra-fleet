import { test, describe } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { spawn as realSpawn } from 'node:child_process';
import path from 'node:path';
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
        function onData(chunk) {
            buf += chunk.toString('utf-8');
            const idx = buf.indexOf('\n');
            if (idx !== -1) {
                stream.off('data', onData);
                resolve(buf.slice(0, idx));
            }
        }
        stream.on('data', onData);
        stream.once('error', reject);
    });
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
    test('spawnSprint launches detached+ignored-stdio, unrefs, and returns pid+port', async () => {
        const { spawnFn, calls, children } = makeFakeSpawn([111]);
        const spawner = createSpawner({
            spawn: spawnFn,
            command: '/usr/bin/node',
            cliPath: '/repo/bin/cli.mjs',
            basePort: 9000,
            isPortAvailable: async () => true,
        });

        const result = await spawner.spawnSprint({ issue: 'i1', members: 'm1', branch: 'b1', base: 'main' });

        assert.equal(result.pid, 111);
        assert.equal(result.port, 9000);
        assert.equal(result.command, '/usr/bin/node');
        assert.deepEqual(result.args.slice(0, 2), ['/repo/bin/cli.mjs', '--issue']);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].opts.detached, true);
        assert.equal(calls[0].opts.stdio, 'ignore');
        assert.equal(children[0].unrefCalled, true);
        assert.equal(spawner.liveCount, 1);
        assert.deepEqual(spawner.livePorts, new Set([9000]));
    });

    test('two concurrent sprints never receive the same port', async () => {
        const { spawnFn } = makeFakeSpawn([1, 2]);
        const spawner = createSpawner({ spawn: spawnFn, basePort: 9100, isPortAvailable: async () => true });

        const a = await spawner.spawnSprint({ issue: 'a', members: 'm', branch: 'ba', base: 'main' });
        const b = await spawner.spawnSprint({ issue: 'b', members: 'm', branch: 'bb', base: 'main' });

        assert.notEqual(a.port, b.port);
        assert.equal(spawner.liveCount, 2);
    });

    test('a port frees for reuse once its sprint exits, and not before', async () => {
        const { spawnFn, children } = makeFakeSpawn([1, 2, 3, 4]);
        const spawner = createSpawner({ spawn: spawnFn, basePort: 9200, isPortAvailable: async () => true });

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
        const spawner = createSpawner({ spawn: spawnFn, basePort: 9300, isPortAvailable: async () => true });

        await spawner.spawnSprint({ issue: 'a', members: 'm', branch: 'ba', base: 'main' });
        const b = await spawner.spawnSprint({ issue: 'b', members: 'm', branch: 'bb', base: 'main' });

        children[0].emit('exit', 1, null);

        assert.equal(spawner.liveCount, 1);
        assert.equal(spawner.getLiveEntry(b.pid).port, 9301);
    });

    test('stop() clears local bookkeeping but never kills a live child', async () => {
        const { spawnFn, children } = makeFakeSpawn([1]);
        let killed = false;
        const spawner = createSpawner({ spawn: spawnFn, basePort: 9400, isPortAvailable: async () => true });
        await spawner.spawnSprint({ issue: 'a', members: 'm', branch: 'ba', base: 'main' });
        children[0].kill = () => { killed = true; };

        await spawner.stop();

        assert.equal(spawner.liveCount, 0);
        assert.equal(killed, false);
    });

    test('spawnSprint rejects when spawn() returns no pid', async () => {
        const spawner = createSpawner({
            spawn: () => ({ once() {}, unref() {} }),
            basePort: 9500,
            isPortAvailable: async () => true,
        });
        await assert.rejects(
            () => spawner.spawnSprint({ issue: 'a', members: 'm', branch: 'ba', base: 'main' }),
            /failed to launch/,
        );
    });
});

describe('createSpawner -- real detached child process (orphan survival)', () => {
    test('killing the spawner\'s process (SIGKILL) leaves the spawned child running', async () => {
        const basePort = 18100 + Math.floor(Math.random() * 200);
        const harness = realSpawn(process.execPath, [path.join(fixturesDir, 'harness.mjs')], {
            stdio: ['ignore', 'pipe', 'inherit'],
            env: { ...process.env, SPAWNER_TEST_BASE_PORT: String(basePort), SPAWNER_TEST_SPRINT_COUNT: '1' },
        });

        try {
            const line = await firstLine(harness.stdout);
            const [{ pid }] = JSON.parse(line);
            assert.ok(Number.isInteger(pid));
            assert.equal(isAlive(pid), true, 'sprint child should be alive right after spawn');

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
        } finally {
            if (!harness.killed) harness.kill('SIGKILL');
        }
    });

    test('two sibling sprints get distinct real ports; killing one leaves the other alive', async () => {
        const basePort = 18300 + Math.floor(Math.random() * 200);
        const harness = realSpawn(process.execPath, [path.join(fixturesDir, 'harness.mjs')], {
            stdio: ['ignore', 'pipe', 'inherit'],
            env: { ...process.env, SPAWNER_TEST_BASE_PORT: String(basePort), SPAWNER_TEST_SPRINT_COUNT: '2' },
        });

        let pids = [];
        try {
            const line = await firstLine(harness.stdout);
            const results = JSON.parse(line);
            pids = results.map((r) => r.pid);
            const ports = results.map((r) => r.port);

            assert.equal(new Set(ports).size, 2, 'sibling sprints must get distinct viewer ports');
            assert.equal(isAlive(pids[0]), true);
            assert.equal(isAlive(pids[1]), true);

            process.kill(pids[0], 'SIGKILL');
            await sleep(300);

            assert.equal(isAlive(pids[0]), false);
            assert.equal(isAlive(pids[1]), true, 'killing one sibling must not affect the other');
        } finally {
            for (const pid of pids) {
                if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
            }
            if (!harness.killed) harness.kill('SIGKILL');
        }
    });
});
