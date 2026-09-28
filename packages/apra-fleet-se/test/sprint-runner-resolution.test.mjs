// apra-fleet-i9ag.15.3 -- end-to-end verification for the parent bug
// (apra-fleet-i9ag.15): a supervisor running as the installed binary must
// spawn sprints with a real node, and a host with no usable node must fail
// loudly at launch instead of producing a dead child and a green form.
//
// This file is the dedicated regression suite tying together the three
// pieces the parent bug spans, each already implemented by an earlier task
// in this streak:
//   1. node-runner.mjs's resolveSprintRunnerCommand() (apra-fleet-i9ag.15.1)
//      -- resolver unit coverage, every branch.
//   2. spawner.mjs's createSpawner()/spawnSprint() (apra-fleet-i9ag.15.2)
//      -- wiring the REAL resolver into the spawn call, proving the
//      regression directly: the installed-binary execPath must never reach
//      spawn() as the command.
//   3. api.mjs's POST /api/sprints (apra-fleet-i9ag.15.2) -- a resolution
//      failure surfaces as a 503 with the operator-facing fix line through
//      the real HTTP route layer, and leaves no trace (no ledger
//      reservation, no per-sprint log file).
//
// Nothing here spawns a real process, touches the real home directory, or
// depends on the host actually having/not having node on PATH -- every
// external seam (exec, isSea, execPath, platform, spawn, fs, dataDir/home)
// is injected.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    resolveSprintRunnerCommand,
    SprintRunnerResolutionError,
    SPRINT_RUNNER_SOURCE,
    MIN_NODE_VERSION,
} from '../src/supervisor/node-runner.mjs';
import { createSpawner, defaultCliPath } from '../src/supervisor/spawner.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSprintController, registerSprintRoutes, ApiError } from '../src/supervisor/api.mjs';
import { createTestSupervisor } from './helpers/supervisor-harness.mjs';

// -- shared test doubles ------------------------------------------------

/** A fake `exec(file, args, options)` -- `versions` maps file -> version
 * string (parsed by node-runner.mjs's own parseVersionString(), so 'vX.Y.Z'
 * or 'X.Y.Z' both work) or `null`/absent to simulate a spawn failure. */
function fakeExec(versions) {
    return (file) => {
        if (!Object.prototype.hasOwnProperty.call(versions, file) || versions[file] === null) {
            throw new Error(`spawn ENOENT: ${file}`);
        }
        return versions[file];
    };
}

async function tmpDir(prefix) {
    return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Real ledger + history over a temp dir, mirroring supervisor-api.test.mjs's own `stores()`. */
async function stores(dir) {
    const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-09-28T00:00:00.000Z' });
    await ledger.start();
    const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => '2026-09-28T00:00:00.000Z' });
    await history.start();
    return { ledger, history };
}

function mockReq(method, url, body, headers) {
    const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
    return {
        method,
        url,
        headers: headers ?? {},
        on(event, cb) {
            if (event === 'data') { for (const c of chunks) cb(c); }
            if (event === 'end') { cb(); }
            return this;
        },
    };
}
function mockRes() {
    return {
        statusCode: undefined,
        body: undefined,
        headersSent: false,
        writeHead(status) { this.statusCode = status; this.headersSent = true; },
        end(body) { this.body = body; },
    };
}
const payloadOf = (res) => JSON.parse(res.body);

// =============================================================================
// 1. Resolver unit coverage -- every branch of resolveSprintRunnerCommand()
// =============================================================================

describe('sprint-runner-resolution -- resolveSprintRunnerCommand() branch coverage', () => {
    test('current-runtime tier: isSea() false + a probeable execPath resolves to execPath', () => {
        const result = resolveSprintRunnerCommand({
            env: {},
            execPath: '/usr/bin/node-under-test',
            isSea: () => false,
            exec: fakeExec({ '/usr/bin/node-under-test': 'v22.16.0' }),
            platform: 'linux',
        });
        assert.deepEqual(result, {
            command: '/usr/bin/node-under-test',
            source: SPRINT_RUNNER_SOURCE.CURRENT_RUNTIME,
            version: '22.16.0',
        });
    });

    test('sea tier: isSea() true resolves the PATH node, NEVER the injected execPath', () => {
        const result = resolveSprintRunnerCommand({
            env: {},
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true,
            exec: fakeExec({ node: 'v22.17.1', '/opt/apra-fleet/apra-fleet': 'v99.99.99' }),
            platform: 'linux',
        });
        assert.equal(result.command, 'node');
        assert.equal(result.source, SPRINT_RUNNER_SOURCE.PATH);
        assert.equal(result.version, '22.17.1');
    });

    test('FLEET_SE_NODE override wins over both other tiers, even when they would also resolve', () => {
        const result = resolveSprintRunnerCommand({
            env: { FLEET_SE_NODE: '/custom/node' },
            execPath: '/usr/bin/node-under-test',
            isSea: () => false,
            exec: fakeExec({
                '/custom/node': 'v20.0.0',
                '/usr/bin/node-under-test': 'v22.16.0',
                node: 'v22.16.0',
            }),
            platform: 'linux',
        });
        assert.deepEqual(result, {
            command: '/custom/node',
            source: SPRINT_RUNNER_SOURCE.OVERRIDE,
            version: '20.0.0',
        });
    });

    test('a set-but-unusable FLEET_SE_NODE override throws -- never a silent fall-through to PATH/execPath', () => {
        assert.throws(
            () => resolveSprintRunnerCommand({
                env: { FLEET_SE_NODE: '/bad/node' },
                execPath: '/usr/bin/node-under-test',
                isSea: () => false,
                exec: fakeExec({ '/usr/bin/node-under-test': 'v22.16.0', node: 'v22.16.0' }),
                platform: 'linux',
            }),
            (err) => {
                assert.ok(err instanceof SprintRunnerResolutionError);
                assert.ok(err.isSprintRunnerResolutionError);
                assert.ok(err.message.includes('/bad/node'), 'names the unusable override');
                return true;
            },
        );
    });

    test('a too-old PATH node throws instead of being used, naming the version actually found', () => {
        assert.throws(
            () => resolveSprintRunnerCommand({
                env: {},
                execPath: '/opt/apra-fleet/apra-fleet',
                isSea: () => true,
                exec: fakeExec({ node: 'v22.9.0' }),
                platform: 'linux',
            }),
            (err) => {
                assert.ok(err instanceof SprintRunnerResolutionError);
                assert.ok(err.message.includes('22.9.0'), 'names the too-old version actually found');
                assert.ok(err.message.includes(MIN_NODE_VERSION), 'names the required minimum');
                return true;
            },
        );
    });

    test('nothing usable anywhere throws naming every candidate and the 22.16+ fix line', () => {
        assert.throws(
            () => resolveSprintRunnerCommand({
                env: {},
                execPath: '/opt/apra-fleet/apra-fleet',
                isSea: () => true,
                exec: fakeExec({}),
                platform: 'linux',
            }),
            (err) => {
                assert.ok(err instanceof SprintRunnerResolutionError);
                assert.ok(err.isSprintRunnerResolutionError, 'discriminating property must be set');
                assert.ok(err.message.includes('/opt/apra-fleet/apra-fleet'), 'names the skipped current-runtime candidate');
                assert.ok(err.message.includes('PATH'), 'names the PATH candidate');
                assert.ok(err.message.includes('Node.js 22.16+'), 'carries the operator fix line');
                return true;
            },
        );
    });

    test('version comparison is numeric: 22.9.0 is OLDER than 22.16.0, never "greater" by a naive string compare', () => {
        // A naive string compare treats '22.9.0' > '22.16.0' (since '9' > '1'
        // lexically) -- assert the PATH tier actually rejects it as too old.
        assert.throws(() => resolveSprintRunnerCommand({
            env: {},
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true,
            exec: fakeExec({ node: 'v22.9.0' }),
            platform: 'linux',
        }), SprintRunnerResolutionError);

        // A version at (or above) the minimum is accepted.
        const ok = resolveSprintRunnerCommand({
            env: {},
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true,
            exec: fakeExec({ node: MIN_NODE_VERSION }),
            platform: 'linux',
        });
        assert.equal(ok.version, MIN_NODE_VERSION);
        assert.equal(compareIsOlder('22.9.0', '22.16.0'), true, 'sanity: 22.9.0 really is older than 22.16.0 numerically');

        function compareIsOlder(a, b) {
            const pa = a.split('.').map(Number);
            const pb = b.split('.').map(Number);
            for (let i = 0; i < 3; i += 1) {
                if (pa[i] !== pb[i]) return pa[i] < pb[i];
            }
            return false;
        }
    });

    test('win32: the shell probe is used (shell: true) and a spaced execPath still resolves', () => {
        const spacedPath = 'C:\\Program Files\\nodejs\\node.exe';
        const quoted = `"${spacedPath}"`;
        const calls = [];
        const exec = (file, args, options) => {
            calls.push({ file, args, options });
            if (file !== quoted) throw new Error(`spawn ENOENT: ${file}`);
            return 'v22.16.0';
        };

        const result = resolveSprintRunnerCommand({
            env: {},
            execPath: spacedPath,
            isSea: () => false,
            exec,
            platform: 'win32',
        });

        assert.deepEqual(result, {
            command: spacedPath,
            source: SPRINT_RUNNER_SOURCE.CURRENT_RUNTIME,
            version: '22.16.0',
        }, 'the resolved command returned to the caller is the ORIGINAL unquoted path');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].options.shell, true, 'win32 probing uses shell: true');
    });
});

// =============================================================================
// 2. Spawner behaviour with an injected spawn seam -- the regression itself:
//    the installed-binary case must spawn NODE, never the SEA executable.
// =============================================================================

describe('sprint-runner-resolution -- createSpawner() spawns the resolved node, never the SEA execPath', () => {
    /** Fake, in-process spawn -- records exactly what createSpawner() hands it. */
    function makeFakeSpawn(pid) {
        const calls = [];
        const spawnFn = (command, args, opts) => {
            const child = new EventEmitter();
            child.pid = pid;
            child.unref = () => {};
            calls.push({ command, args, opts });
            return child;
        };
        return { spawnFn, calls };
    }

    function fakeFs() {
        return { mkdirSync() {}, openSync() { return 42; }, closeSync() {} };
    }

    test('installed-binary case (isSea() true, execPath = a fake apra-fleet executable): argv[0] handed to spawn is the resolved node, and argv[1] is the cli path', async () => {
        const fakeExecPath = '/opt/apra-fleet/bin/apra-fleet';
        const { spawnFn, calls } = makeFakeSpawn(4242);

        // The REAL resolveSprintRunnerCommand, wired with injected deps that
        // simulate exactly the installed-binary bug scenario: this process is
        // a SEA binary (isSea() true) whose own execPath is NOT node, but a
        // real `node` is available on PATH.
        const spawner = createSpawner({
            spawn: spawnFn,
            resolveRunner: () => resolveSprintRunnerCommand({
                env: {},
                execPath: fakeExecPath,
                isSea: () => true,
                exec: fakeExec({ node: 'v22.16.0', [fakeExecPath]: 'v99.99.99' }),
                platform: 'linux',
            }),
            basePort: 9200,
            isPortAvailable: async () => true,
            dataDir: 'fake-data-dir',
            fs: fakeFs(),
            logger: { log() {}, error() {} },
        });

        const cliPath = defaultCliPath();
        const result = await spawner.spawnSprint({ issue: 'PROJ-1', members: 'alice', branch: 'feat/x', base: 'main' });

        assert.equal(result.command, 'node', 'the sprint must be resolved and reported as spawned with node');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].command, 'node', 'argv[0] handed to spawn() is the resolved node');
        assert.notEqual(calls[0].command, fakeExecPath, 'the regression assertion: the spawned command is NEVER the injected non-node execPath');
        assert.equal(calls[0].args[0], cliPath, 'argv[1] (the first spawn arg) is still the cli path');
    });

    test('non-installed-binary case (isSea() false, a real node execPath): argv[0] is that execPath (unchanged plain-`node bin/serve.mjs` behaviour)', async () => {
        const realExecPath = '/usr/bin/node-under-test';
        const { spawnFn, calls } = makeFakeSpawn(4343);

        const spawner = createSpawner({
            spawn: spawnFn,
            resolveRunner: () => resolveSprintRunnerCommand({
                env: {},
                execPath: realExecPath,
                isSea: () => false,
                exec: fakeExec({ [realExecPath]: 'v22.16.0' }),
                platform: 'linux',
            }),
            basePort: 9200,
            isPortAvailable: async () => true,
            dataDir: 'fake-data-dir',
            fs: fakeFs(),
            logger: { log() {}, error() {} },
        });

        await spawner.spawnSprint({ issue: 'PROJ-1', members: 'alice', branch: 'feat/x', base: 'main' });

        assert.equal(calls[0].command, realExecPath);
    });
});

// =============================================================================
// 3. Launch failure path through the real HTTP route layer.
// =============================================================================

describe('sprint-runner-resolution -- POST /api/sprints launch failure through the real HTTP route layer', () => {
    const FIX_LINE = 'Install Node.js 22.16+ and ensure \'node\' resolves on PATH, ' +
        'or set FLEET_SE_NODE to an explicit Node.js binary to launch sprints with.';

    test('a host with no usable node fails the launch with 503, the fix line in the body, no ledger reservation, and no log file created', async () => {
        const dir = await tmpDir('i9ag15-3-sprint-runner-resolution-');
        const { ledger, history } = await stores(dir);

        // The REAL resolveSprintRunnerCommand, driven end to end via a
        // resolveRunner that simulates a host with no usable node at all:
        // an installed-binary SEA process whose PATH has no node either.
        const spawner = createSpawner({
            resolveRunner: () => resolveSprintRunnerCommand({
                env: {},
                execPath: '/opt/apra-fleet/bin/apra-fleet',
                isSea: () => true,
                exec: fakeExec({}), // nothing resolves: neither the SEA execPath nor PATH's `node`
                platform: 'linux',
            }),
            isPortAvailable: async () => true,
            // A REAL, temp-dir-backed dataDir/fs -- so "no log file was
            // created" is asserted against the real filesystem, not a fake.
            dataDir: dir,
        });

        const controller = createSprintController({
            ledger, history, spawner,
            listMembers: () => ({ members: [] }),
            getBacklog: () => ({}),
        });
        const { supervisor, headers } = await createTestSupervisor({ dataDir: dir });
        registerSprintRoutes(supervisor, controller);

        const res = mockRes();
        await supervisor.handleRequest(
            mockReq('POST', '/api/sprints', { issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main' }, headers()),
            res,
        );

        assert.equal(res.statusCode, 503);
        const body = payloadOf(res);
        assert.ok(body.error.includes(FIX_LINE), 'the 503 body must carry the resolver\'s own operator-facing fix line');
        assert.ok(!/internal supervisor error/i.test(body.error), 'must never degrade to the generic 500 message');

        assert.equal(ledger.list().length, 0, 'a runner-resolution failure must claim no ledger reservation');

        const logsDir = path.join(dir, 'logs');
        assert.equal(fs.existsSync(logsDir), false, 'no per-sprint log file/directory may be created when resolution fails before spawn');

        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('once a usable node becomes available, the SAME controller launches successfully (failure is not sticky/cached)', async () => {
        const dir = await tmpDir('i9ag15-3-sprint-runner-resolution-recover-');
        const { ledger, history } = await stores(dir);

        let attempt = 0;
        const spawnCalls = [];
        const spawner = createSpawner({
            spawn: (command, args) => {
                spawnCalls.push({ command, args });
                const child = new EventEmitter();
                child.pid = 9999;
                child.unref = () => {};
                return child;
            },
            resolveRunner: () => {
                attempt += 1;
                if (attempt === 1) {
                    return resolveSprintRunnerCommand({
                        env: {},
                        execPath: '/opt/apra-fleet/bin/apra-fleet',
                        isSea: () => true,
                        exec: fakeExec({}),
                        platform: 'linux',
                    });
                }
                return resolveSprintRunnerCommand({
                    env: {},
                    execPath: '/opt/apra-fleet/bin/apra-fleet',
                    isSea: () => true,
                    exec: fakeExec({ node: 'v22.16.0' }),
                    platform: 'linux',
                });
            },
            isPortAvailable: async () => true,
            dataDir: dir,
        });

        const controller = createSprintController({
            ledger, history, spawner,
            listMembers: () => ({ members: [] }),
            getBacklog: () => ({}),
        });
        const { supervisor, headers } = await createTestSupervisor({ dataDir: dir });
        registerSprintRoutes(supervisor, controller);

        const first = mockRes();
        await supervisor.handleRequest(
            mockReq('POST', '/api/sprints', { issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main' }, headers()),
            first,
        );
        assert.equal(first.statusCode, 503);
        assert.equal(ledger.list().length, 0);

        const second = mockRes();
        await supervisor.handleRequest(
            mockReq('POST', '/api/sprints', { issue: 'PROJ-2', members: ['bob'], branch: 'feat/y', base: 'main' }, headers()),
            second,
        );
        assert.equal(second.statusCode, 201, JSON.stringify(payloadOf(second)));
        assert.equal(spawnCalls.length, 1);
        assert.equal(spawnCalls[0].command, 'node');
        assert.equal(ledger.list().length, 1, 'the recovered launch must claim exactly one ledger reservation');

        await fsp.rm(dir, { recursive: true, force: true });
    });
});
