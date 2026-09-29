// =============================================================================
// A SERVICE-STYLE SUPERVISOR WITH NO `node` ON ITS PATH STILL LAUNCHES A SPRINT
// (apra-fleet-i9ag.19.14 -- the end-to-end acceptance of apra-fleet-i9ag.19)
// =============================================================================
//
// WHY THIS TEST EXISTS: a supervisor started by launchd (macOS) or a Windows
// scheduled task does not inherit a login shell's PATH. On a host whose
// `node` comes from a version manager (nvm/fnm/volta), that PATH therefore
// has no `node` in it at all, and every sprint launch used to fail -- the
// resolver's last tier is a PATH lookup, and there was nothing to look up.
// apra-fleet-i9ag.19's answer is to RECORD node's (and bd's) absolute path at
// install time (`supervisor.config.json`'s `toolchain` block), validate that
// recording at startup, and hand it to the sprint-runner resolver as its
// CONFIGURED tier.
//
// A launchd job and a Windows scheduled task differ from a login shell in
// exactly the ONE observable way that matters here -- `node` is not on the
// PATH the process inherits -- and that is directly reproducible on every
// platform CI runs: spawn `bin/serve.mjs` as a real child process whose PATH
// holds a single empty directory, with no FLEET_SE_NODE override, against a
// temp data dir holding a recorded toolchain. So this is a plain
// cross-platform end-to-end test, not a service-manager simulation: no
// launchd plist, no schtasks, no privileged install.
//
// WHAT IT PINS, and why each half matters:
//   1. GOOD RECORDING: the PATH-less supervisor accepts POST /api/sprints
//      (201) and the sprint child it actually spawns REPORTS ITS OWN
//      `process.execPath` as the recorded node -- the single fact this whole
//      sprint exists to deliver. The recorded path is a DISTINCT hard
//      link/copy of the test runner's own node, never `process.execPath`
//      itself, so "the recording was used" cannot be confused with "the
//      supervisor's own runtime happened to work" (tier 3, current-runtime)
//      and certainly not with a PATH lookup (tier 4, which this environment
//      makes impossible -- asserted directly below).
//   2. BROKEN RECORDING: the same supervisor, given a recorded `nodePath`
//      that does not exist, still BOOTS and still serves (loud, never
//      fatal), prints the loud `[supervisor] ERROR:` startup line NAMING
//      that path, and refuses a launch with 503 naming it too -- instead of
//      silently falling through to a PATH lookup that either fails vaguely
//      or, worse, succeeds with a different interpreter than the operator
//      recorded.
//
// HOW THE SPAWN TARGET IS NEUTERED (and why that is honest): the spawner's
// cli path is `<package>/bin/cli.mjs`, which is not injectable from outside
// the process -- so the child is made a STUB by a `--require` preload in the
// supervisor's own environment (inherited by the spawned child, exactly like
// a real service's environment is). The preload intercepts ONLY an
// invocation whose argv[1] is `cli.mjs`, records that child's real
// `process.execPath`/argv to a file, and exits 0 before the engine's CLI
// loads. So this test needs no project repo, no bd remote, no real sprint
// and no network, while still asserting on the real spawn: WHAT was spawned,
// with WHICH interpreter. The supervisor process itself (argv[1] is
// `serve.mjs`) is untouched by the preload, as is every `--version` probe.
//
// `bd` is also RECORDED (a tiny stub answering `--version` and `list`), not
// put on PATH: the launch path's own scope-overlap guard shells out to `bd`,
// and on this host PATH cannot resolve it either. That is the same recorded-
// toolchain mechanism under test, applied to the other recorded tool.
//
// SCOPE BOUNDARY -- this file asserts NOTHING about GET /api/health's
// `toolchain` object or the dashboard header. That surface belongs entirely
// to the health-surfacing task and its paired [test] task; duplicating it
// here would make this test depend on a payload it does not exist to verify.
// Liveness is confirmed only through health's pre-existing
// status/pid/uptimeSeconds fields. This test's subject is WHICH INTERPRETER
// a PATH-less service actually spawns with, nothing else.
//
// THE MANUAL HALF OF THE ACCEPTANCE IS NOT REPLACED BY THIS FILE: a real
// fresh install on macOS and on Windows, with a version-manager node, then a
// genuinely service-started launch (launchd / a Windows scheduled task), is
// an integration / regression pass. This test reduces the bug to what CI can
// run on ubuntu, macOS and Windows -- it does not cover the installer's own
// recording step on a real machine, nor the service manager's environment in
// full.
//
// ASCII only.
// =============================================================================

import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveServiceToken } from '../src/supervisor/auth.mjs';
import { writeSupervisorToolchain } from '../src/supervisor/project-config.mjs';
import { pathEnvKey } from './helpers/child-path-env.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SE_ROOT = path.resolve(__dirname, '..');
const SERVE_BIN = path.join(SE_ROOT, 'bin', 'serve.mjs');
const CLI_BIN = path.join(SE_ROOT, 'bin', 'cli.mjs');

/** Wall-clock ceiling for the supervisor to bind and answer /api/health. */
const BOOT_TIMEOUT_MS = scaledTimeout(30_000);
/** Wall-clock ceiling for the spawned stub child to write its record file. */
const SPAWN_RECORD_TIMEOUT_MS = scaledTimeout(20_000);
/** Wall-clock ceiling for a clean shutdown after POST /api/shutdown. */
const SHUTDOWN_TIMEOUT_MS = scaledTimeout(15_000);

/** @type {Set<string>} */
const tmpDirs = new Set();
/** @type {Set<number>} */
const spawnedPids = new Set();

function forceKill(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

function track(pid) {
    if (Number.isInteger(pid) && pid > 0) spawnedPids.add(pid);
    return pid;
}

// AC4: the child supervisor (and any sprint child a launch produced) is
// killed on EVERY exit path -- a passing run kills it in the test's own
// `finally` via a clean POST /api/shutdown, and this hook is the backstop
// for a thrown assertion, a timeout, or a crash before shutdown was reached.
after(async () => {
    for (const pid of spawnedPids) forceKill(pid);
    spawnedPids.clear();
    for (const dir of tmpDirs) {
        // eslint-disable-next-line no-await-in-loop
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tmpDirs.clear();
});

async function mkTmp(prefix) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.add(dir);
    // Resolve symlinks (macOS's /var -> /private/var) up front: serve.mjs's
    // isMainModule() compares `import.meta.url` (realpath-resolved by the ESM
    // loader) against `pathToFileURL(process.argv[1]).href` for strict string
    // equality, so an unresolved tmp path makes it exit 0 without ever
    // calling serveMain(). The recorded node path below is compared against
    // the CHILD's own `process.execPath`, which is likewise realpath-shaped,
    // so this also keeps that comparison exact rather than approximate.
    const real = await fsp.realpath(dir);
    tmpDirs.add(real);
    return real;
}

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Allocate a currently-free TCP port by binding to 0 and reading it back. */
function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

/**
 * One guarded HTTP request against the child supervisor. The whole `/api/`
 * surface is behind the bearer service token (auth.mjs), so every call here
 * carries it.
 * @returns {Promise<{ status: number, body: string }>}
 */
function httpRequest(port, pathname, method = 'GET', token = '', body = undefined) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf-8');
        const headers = {};
        if (token) headers.authorization = `Bearer ${token}`;
        if (payload) {
            headers['content-type'] = 'application/json';
            headers['content-length'] = String(payload.length);
        }
        const req = http.request(
            { host: '127.0.0.1', port, path: pathname, method, timeout: 10_000, headers },
            (res) => {
                let text = '';
                res.on('data', (c) => { text += c; });
                res.on('end', () => resolve({ status: res.statusCode, body: text }));
            },
        );
        req.on('timeout', () => { req.destroy(new Error('request timeout')); });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

/**
 * Waits for `child` to exit, or rejects after `timeoutMs`. The losing timer
 * is cleared the instant the process exits, so a fast shutdown does not pad
 * the suite's wall time by the whole budget.
 */
function waitForExit(child, timeoutMs) {
    return new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            reject(new Error(`process did not exit within ${timeoutMs}ms`));
        }, timeoutMs);
        function onExit() {
            clearTimeout(timer);
            resolve();
        }
        child.once('exit', onExit);
    });
}

/**
 * Polls `probe()` until it returns something truthy, or fails the test once
 * the budget is spent. Every wait in this file is bounded this way -- nothing
 * here can hang a dispatch.
 */
async function waitFor(probe, timeoutMs, describeFailure) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const result = await probe();
        if (result) return result;
        if (Date.now() > deadline) {
            assert.fail(`timed out after ${timeoutMs}ms: ${describeFailure()}`);
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(100);
    }
}

/**
 * Writes the recorded-toolchain fixture: a REAL node (a distinct hard
 * link/copy of this test runner's own node, so the recorded path is never
 * `process.execPath` itself), a tiny recorded `bd`, and the `--require`
 * preload that turns the spawned sprint CLI into a recording stub.
 *
 * Every path here is resolved in JavaScript -- nothing is left to shell-level
 * expansion, and the two stub scripts are written per-platform (`bd.cmd` for
 * cmd.exe on win32, a `#!/bin/sh` script elsewhere) rather than assuming a
 * POSIX shell on the host.
 */
async function buildToolchainFixture(label) {
    const toolDir = await mkTmp(`i9ag19-14-${label}-tools-`);
    const recordDir = path.join(toolDir, 'spawn-records');
    fs.mkdirSync(recordDir, { recursive: true });
    const isWin = process.platform === 'win32';

    // --- the recorded node: a REAL node runtime at a path of our choosing.
    // A hard link is preferred (instant, no 100MB copy) with a copy as the
    // fallback for a tmpdir on another volume. Either way the result is a
    // separate absolute path that reports ITSELF as process.execPath, which
    // is what makes "the child ran the RECORDED node" checkable at all.
    const realNode = fs.realpathSync(process.execPath);
    const recordedNode = path.join(toolDir, isWin ? 'recorded-node.exe' : 'recorded-node');
    try {
        fs.linkSync(realNode, recordedNode);
    } catch {
        fs.copyFileSync(realNode, recordedNode);
    }
    assert.notEqual(
        recordedNode, process.execPath,
        'the recorded node must be a DIFFERENT path from the test runner/supervisor own execPath, '
        + 'or a launch resolved from the current runtime would be indistinguishable from one resolved from the recording',
    );
    const probe = spawnSync(recordedNode, ['--version'], { encoding: 'utf-8' });
    assert.equal(probe.status, 0, `the recorded node copy is not executable: ${probe.error ? probe.error.message : probe.stderr}`);

    // --- the recorded bd: answers the two invocations this test's launch
    // path actually makes -- `--version` (startup validation) and a `list`
    // (the scope-overlap guard's bulk fetch, which only needs well-formed
    // JSON). Not on PATH, deliberately: PATH is empty here, and a recorded
    // absolute bd path is exactly what a service-started supervisor has.
    const recordedBd = path.join(toolDir, isWin ? 'recorded-bd.cmd' : 'recorded-bd');
    if (isWin) {
        fs.writeFileSync(
            recordedBd,
            '@echo off\r\n'
            + 'if "%~1"=="--version" (\r\n'
            + '  echo bd 0.44.0\r\n'
            + ') else (\r\n'
            + '  echo []\r\n'
            + ')\r\n',
            'utf-8',
        );
    } else {
        fs.writeFileSync(
            recordedBd,
            '#!/bin/sh\n'
            + 'if [ "$1" = "--version" ]; then\n'
            + '  echo "bd 0.44.0"\n'
            + '  exit 0\n'
            + 'fi\n'
            + 'echo "[]"\n',
            { encoding: 'utf-8', mode: 0o755 },
        );
        fs.chmodSync(recordedBd, 0o755);
    }
    const bdProbe = spawnSync(recordedBd, ['--version'], { encoding: 'utf-8', shell: isWin });
    assert.equal(bdProbe.status, 0, `the recorded bd stub is not runnable: ${bdProbe.error ? bdProbe.error.message : bdProbe.stderr}`);

    // --- the preload that makes the spawned sprint CLI a recording stub.
    // Intercepts ONLY a child whose argv[1] is cli.mjs: the supervisor itself
    // (serve.mjs) and every `<node> --version` probe run untouched.
    const preload = path.join(toolDir, 'record-cli-spawn.cjs');
    fs.writeFileSync(
        preload,
        '// Written by test/i9ag19-14-pathless-service-launch.test.mjs.\n'
        + 'const fs = require("node:fs");\n'
        + 'const path = require("node:path");\n'
        + `const RECORD_DIR = ${JSON.stringify(recordDir)};\n`
        + 'const target = process.argv[1] || "";\n'
        + 'if (/(^|[\\\\/])cli\\.mjs$/.test(target)) {\n'
        + '    try {\n'
        + '        fs.mkdirSync(RECORD_DIR, { recursive: true });\n'
        + '        fs.writeFileSync(\n'
        + '            path.join(RECORD_DIR, "spawn-" + process.pid + ".json"),\n'
        + '            JSON.stringify({ execPath: process.execPath, argv: process.argv, cwd: process.cwd() }, null, 2),\n'
        + '            "utf-8",\n'
        + '        );\n'
        + '    } catch (err) {\n'
        + '        process.stderr.write("[spawn-record-stub] " + err.message + "\\n");\n'
        + '        process.exit(3);\n'
        + '    }\n'
        + '    process.exit(0);\n'
        + '}\n',
        'utf-8',
    );

    return { toolDir, recordDir, recordedNode, recordedBd, preload };
}

/**
 * The environment a service-started supervisor has on a version-manager
 * host: a PATH with no `node` (and no `bd`) anywhere in it, and no
 * FLEET_SE_NODE escape hatch. Everything else (SystemRoot/ComSpec/TMP and
 * friends) is preserved -- destroying those would test a broken machine
 * rather than a PATH-less service.
 */
function serviceStyleEnv({ emptyPathDir, dataDir, appDataDir, homeDir, preload }) {
    const env = { ...process.env };
    // Case-correct: Windows spells it `Path`, and a plain spread of
    // process.env loses the case-insensitive lookup, so the existing key's
    // own spelling is reused rather than a second `PATH` added beside it.
    const key = pathEnvKey(env);
    for (const k of Object.keys(env)) {
        if (k.toLowerCase() === 'path') delete env[k];
    }
    env[key] = emptyPathDir;
    delete env.FLEET_SE_NODE;
    delete env.FLEET_SE_SWEEP_OWNER_DATA_DIR;
    delete env.BEADS_DIR;
    env.FLEET_SE_DATA_DIR = dataDir;
    env.APRA_FLEET_DATA_DIR = appDataDir;
    // An isolated home: no shared fleet.key, so the supervisor mints/reads
    // its service token under its own data dir and never reaches a real
    // fleet server (registration and member listing both degrade).
    env.HOME = homeDir;
    env.USERPROFILE = homeDir;
    const existingNodeOptions = typeof env.NODE_OPTIONS === 'string' && env.NODE_OPTIONS.trim() ? `${env.NODE_OPTIONS} ` : '';
    // Paths are resolved in JavaScript; quoted only if the resolved path
    // carries whitespace, since NODE_OPTIONS is whitespace-separated.
    const requireArg = /\s/.test(preload) ? `"${preload}"` : preload;
    env.NODE_OPTIONS = `${existingNodeOptions}--require ${requireArg}`;
    return env;
}

/**
 * Spawns `bin/serve.mjs` as a real child process in the service-style
 * environment above and waits (bounded) for it to answer GET /api/health.
 * Returns the child, its accumulated output, and the resolved token.
 */
async function startPathlessSupervisor(label, { toolchain, preload }) {
    const dataDir = await mkTmp(`i9ag19-14-${label}-se-data-`);
    const appDataDir = await mkTmp(`i9ag19-14-${label}-fleet-data-`);
    const homeDir = await mkTmp(`i9ag19-14-${label}-home-`);
    const emptyPathDir = await mkTmp(`i9ag19-14-${label}-empty-path-`);
    // A cwd that is NOT a project: no .beads anywhere above it, mirroring a
    // service whose working directory is the installed engine path. The
    // supervisor still boots (beads identity unknown is a WARNING, never
    // fatal) and -- importantly for this test -- runs no `bd` at startup.
    const cwd = await mkTmp(`i9ag19-14-${label}-cwd-`);

    // The recording itself, written through the product's own writer so this
    // fixture can never drift from the real on-disk shape.
    await writeSupervisorToolchain(toolchain, { dataDir });

    // The SAME token the child will resolve: no fleet.key exists under the
    // isolated home, so this mints (or re-reads) the private token under the
    // child's own data dir. Called with an explicit `home` so it can never
    // pick up the developer's real ~/.apra-fleet/fleet.key.
    const { token } = resolveServiceToken(dataDir, { home: homeDir });
    assert.ok(token && token.length > 0, 'resolveServiceToken() returned an empty token');

    const emptyPathEntries = fs.readdirSync(emptyPathDir);
    assert.deepEqual(emptyPathEntries, [], 'the scrubbed PATH directory must be empty');

    const env = serviceStyleEnv({ emptyPathDir, dataDir, appDataDir, homeDir, preload });

    // The premise of this whole test, asserted rather than assumed: with THIS
    // env, a PATH lookup for `node` fails outright (Node resolves a spawned
    // executable through the CHILD env's PATH), so nothing below can be
    // passing via the resolver's PATH tier.
    const pathLookup = spawnSync('node', ['--version'], { env, encoding: 'utf-8' });
    assert.ok(
        pathLookup.error && pathLookup.error.code === 'ENOENT',
        `'node' must NOT be resolvable on this environment's PATH (got status=${pathLookup.status}, stdout=${JSON.stringify(pathLookup.stdout)})`,
    );

    const port = await getFreePort();
    let output = '';
    const child = spawn(process.execPath, [SERVE_BIN, '--port', String(port)], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
    });
    track(child.pid);
    child.stdout.on('data', (c) => { output += c.toString('utf-8'); });
    child.stderr.on('data', (c) => { output += c.toString('utf-8'); });
    let exited = false;
    child.once('exit', () => { exited = true; });

    const supervisor = {
        child,
        port,
        token,
        dataDir,
        cwd,
        getOutput: () => output,
        request: (pathname, method, body) => httpRequest(port, pathname, method, token, body),
    };

    await waitFor(
        async () => {
            if (exited) {
                assert.fail(
                    `serve.mjs exited (code=${child.exitCode}, signal=${child.signalCode}) before /api/health responded.\n`
                    + `output:\n${output}`,
                );
            }
            const health = await httpRequest(port, '/api/health', 'GET', token).catch(() => null);
            return health && health.status === 200 ? health : null;
        },
        BOOT_TIMEOUT_MS,
        () => `the PATH-less supervisor never answered GET /api/health.\noutput:\n${output}`,
    );

    return supervisor;
}

/**
 * Clean, in-band shutdown, then a bounded wait for the process to actually
 * go. Force-kills on any failure so no test path can leave a live child.
 */
async function stopSupervisor(supervisor) {
    if (!supervisor) return;
    try {
        await supervisor.request('/api/shutdown', 'POST');
        await waitForExit(supervisor.child, SHUTDOWN_TIMEOUT_MS);
    } catch {
        // Fall through to the hard kill -- a supervisor that cannot be asked
        // to stop must still not survive this test.
    } finally {
        forceKill(supervisor.child.pid);
    }
}

/** Reads the single record file the intercepted sprint child wrote. */
function readSpawnRecords(recordDir) {
    let names;
    try {
        names = fs.readdirSync(recordDir);
    } catch {
        return [];
    }
    return names
        .filter((n) => n.endsWith('.json'))
        .map((n) => {
            try {
                return JSON.parse(fs.readFileSync(path.join(recordDir, n), 'utf-8'));
            } catch {
                return null; // a partially-written file on this poll; try again next tick
            }
        })
        .filter((r) => r && typeof r.execPath === 'string');
}

/**
 * The first captured line containing every `needles` entry, or undefined.
 * Line-scoped on purpose: "the ERROR line names the path" is a claim about
 * ONE line, not about the whole log happening to contain both strings.
 */
function findLine(output, needles) {
    return output
        .split(/\r?\n/)
        .find((line) => needles.every((needle) => line.includes(needle)));
}

/**
 * Bounded wait for a line the supervisor is expected to have already
 * printed. The child's stdout/stderr reach this process over a pipe, so a
 * line written BEFORE the HTTP response we just read can still be in flight
 * when we look -- polling removes that race instead of making a real
 * assertion flaky.
 */
function waitForOutputLine(supervisor, needles, timeoutMs, describeFailure) {
    return waitFor(
        () => findLine(supervisor.getOutput(), needles),
        timeoutMs,
        () => `${describeFailure()}\noutput:\n${supervisor.getOutput()}`,
    );
}

/** win32 paths compare case-insensitively; every other platform does not. */
function samePath(a, b) {
    const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    return norm(a) === norm(b);
}

describe('apra-fleet-i9ag.19.14: a service-style supervisor with no node on PATH still launches a sprint', () => {
    test('a GOOD recording: the PATH-less supervisor launches, and the sprint child runs the RECORDED node (not a PATH lookup, not its own runtime)', async () => {
        const fixture = await buildToolchainFixture('good');
        let supervisor;
        try {
            supervisor = await startPathlessSupervisor('good', {
                preload: fixture.preload,
                toolchain: {
                    nodePath: fixture.recordedNode,
                    nodeVersion: process.versions.node,
                    bdPath: fixture.recordedBd,
                    bdVersion: '0.44.0',
                },
            });

            // Liveness ONLY through health's pre-existing fields -- never its
            // `toolchain` block (that surface belongs to the health task's
            // own paired test; see this file's SCOPE BOUNDARY note).
            const health = JSON.parse((await supervisor.request('/api/health', 'GET')).body);
            assert.equal(health.status, 'ok', `unexpected health payload: ${JSON.stringify(health)}`);
            assert.equal(typeof health.pid, 'number');
            assert.equal(typeof health.uptimeSeconds, 'number');

            // THE LAUNCH. Nothing about this request is special: it is the
            // same POST /api/sprints an operator's dashboard sends. On this
            // host, before apra-fleet-i9ag.19, it answered 503.
            const launch = await supervisor.request('/api/sprints', 'POST', {
                issue: 'apra-fleet-i9ag.19.14-pathless-probe',
                members: 'i9ag19-14-probe-member',
                branch: 'feat/i9ag19-14-pathless-probe',
                base: 'main',
            });
            assert.equal(
                launch.status, 201,
                `POST /api/sprints from a PATH-less supervisor did not launch (this is the 503 apra-fleet-i9ag.19 exists to fix).\n`
                + `response: ${launch.body}\noutput:\n${supervisor.getOutput()}`,
            );
            const launched = JSON.parse(launch.body);
            track(launched.pid);
            assert.equal(typeof launched.pid, 'number', `launch response carries no child pid: ${launch.body}`);
            assert.ok(launched.sprintId, `launch response carries no sprintId: ${launch.body}`);

            // WHICH INTERPRETER actually ran: the spawned child's OWN
            // process.execPath, reported by the child itself.
            const records = await waitFor(
                () => {
                    const found = readSpawnRecords(fixture.recordDir);
                    return found.length > 0 ? found : null;
                },
                SPAWN_RECORD_TIMEOUT_MS,
                () => `the spawned sprint child never recorded its interpreter.\noutput:\n${supervisor.getOutput()}`,
            );
            assert.equal(records.length, 1, `expected exactly one spawned sprint child, got ${records.length}`);
            const [record] = records;

            assert.ok(
                samePath(record.execPath, fixture.recordedNode),
                `the sprint child was spawned with ${record.execPath}, not the RECORDED node ${fixture.recordedNode}`,
            );
            assert.ok(
                !samePath(record.execPath, process.execPath),
                `the sprint child ran the supervisor's own runtime (${process.execPath}) rather than the recorded node -- `
                + 'this test would not distinguish the CONFIGURED tier from the current-runtime tier',
            );
            // WHAT was spawned: the package's own fleet-sprint CLI, as
            // argv[1] of that interpreter, carrying THIS launch's run id.
            assert.ok(
                samePath(record.argv[1], CLI_BIN),
                `the spawned child's argv[1] is ${record.argv[1]}, not the fleet-sprint CLI ${CLI_BIN}`,
            );
            const runIdIndex = record.argv.indexOf('--run-id');
            assert.ok(runIdIndex > 0, `the spawned argv carries no --run-id: ${JSON.stringify(record.argv)}`);
            assert.equal(
                record.argv[runIdIndex + 1], launched.sprintId,
                'the recorded spawn belongs to a different launch than the one this test made',
            );

            // The resolver's own account of the same fact: the CONFIGURED
            // tier (the recording), never the PATH tier, never current-runtime.
            await waitForOutputLine(
                supervisor,
                [`[spawner] resolved sprint runner: ${fixture.recordedNode} (source: configured`],
                SPAWN_RECORD_TIMEOUT_MS,
                () => 'the supervisor never reported resolving the sprint runner from the recorded toolchain',
            );
        } finally {
            await stopSupervisor(supervisor);
        }
    });

    test('a BROKEN recording: the supervisor still boots but logs the loud startup ERROR naming the path, and refuses the launch 503 naming it too', async () => {
        const fixture = await buildToolchainFixture('broken');
        // A recorded node that is not there any more -- the version manager
        // removed that release, the checkout moved, the machine was
        // reimaged. Never created on disk, so this is not a timing artifact.
        const missingNode = path.join(fixture.toolDir, 'removed-by-version-manager', process.platform === 'win32' ? 'node.exe' : 'node');
        assert.ok(!fs.existsSync(missingNode), 'the broken recorded node path must not exist');

        let supervisor;
        try {
            supervisor = await startPathlessSupervisor('broken', {
                preload: fixture.preload,
                toolchain: {
                    nodePath: missingNode,
                    nodeVersion: process.versions.node,
                    bdPath: fixture.recordedBd,
                    bdVersion: '0.44.0',
                },
            });

            // LOUD BUT NEVER FATAL: it bound its port and answered health
            // above (a supervisor that refused to start could not serve the
            // console page an operator would use to fix the recording), and
            // it said so loudly at startup, naming the offending path.
            await waitForOutputLine(
                supervisor,
                ['[supervisor] ERROR:', missingNode],
                BOOT_TIMEOUT_MS,
                () => 'a broken recorded node must produce a loud startup ERROR line NAMING the offending path',
            );

            // And the launch is REFUSED, 503, naming that exact path --
            // rather than silently falling through to a PATH lookup (which
            // cannot succeed here) or to a different interpreter than the one
            // the operator recorded.
            const refused = await supervisor.request('/api/sprints', 'POST', {
                issue: 'apra-fleet-i9ag.19.14-broken-probe',
                members: 'i9ag19-14-probe-member',
                branch: 'feat/i9ag19-14-broken-probe',
                base: 'main',
            });
            assert.equal(
                refused.status, 503,
                `a launch over a broken recorded node must be refused 503.\nresponse: ${refused.body}`,
            );
            const body = JSON.parse(refused.body);
            assert.ok(
                body.error.includes(missingNode),
                `the 503 message does not name the broken recorded node path.\nmessage: ${body.error}`,
            );

            // Nothing was spawned: the refusal happens before any child.
            assert.deepEqual(
                readSpawnRecords(fixture.recordDir), [],
                'a refused launch must not have spawned a sprint child at all',
            );
        } finally {
            await stopSupervisor(supervisor);
        }
    });
});
