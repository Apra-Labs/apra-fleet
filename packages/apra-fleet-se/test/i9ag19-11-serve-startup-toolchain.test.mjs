// =============================================================================
// apra-fleet-i9ag.19.11 -- supervisor STARTUP wiring around the recorded
// toolchain (bin/serve.mjs's toolchain-validation block, apra-fleet-i9ag.19.10)
// =============================================================================
//
// SCOPE: this file pins bin/serve.mjs's OWN startup wiring -- what it LOGS and
// how it gates configureBdInvocation()/the sprint-runner's configured node --
// as distinct from:
//   - packages/apra-fleet-se/test/i9ag19-9-toolchain.test.mjs, which already
//     exhaustively unit-tests validateRecordedToolchain() itself (good/bad
//     node, bd-only problems, malformed config, win32 quoting, never-throws);
//   - packages/apra-fleet-se/test/i9ag19-14-pathless-service-launch.test.mjs,
//     which already proves (end to end, in a genuinely PATH-less env) that a
//     GOOD recording is what a spawned sprint child actually runs with, and
//     that a BROKEN recorded node is loud-but-never-fatal and refuses a
//     launch 503 naming the path.
//
// So this file does NOT re-derive those two files' own claims. It adds the
// bullets from apra-fleet-i9ag.19.11's own acceptance criteria that neither
// sibling file asserts:
//   1. a GOOD recording produces EXACTLY ONE informational startup line (not
//      zero, not a duplicate) and no toolchain ERROR/WARNING line at all;
//   2. a BROKEN recorded node's loud ERROR line carries the module's own
//      exported fix line (TOOLCHAIN_FIX_LINE), not a hand-copied literal;
//   3. a broken recorded BD with a FINE node reports the bd problem as its
//      own WARNING (never an ERROR, never rolled into the node line), and a
//      launch still succeeds through bd's PATH fallback;
//   4. NOTHING recorded produces no ERROR/WARNING line at all, and the
//      sprint-runner resolver falls through to a tier OTHER than "configured"
//      (i.e. the spawner never received a configured runner);
//   5. a malformed supervisor.config.json still binds the port and reports
//      the reader's own reason, exactly as a missing file does.
//
// Every "problem reported" / "no problem reported" assertion below keys off
// TOOLCHAIN_FIX_LINE (the ONE fix line toolchain.mjs exports) rather than a
// hand-copied string: that line appears in EVERY ERROR/WARNING toolchain line
// this module ever produces and in no other startup line (including the
// pre-existing, unrelated "[supervisor] WARNING: <no beads found>" line every
// boot below also emits, since none of these fixtures point at a real
// project) -- so scanning for it is a precise, single-source-of-truth signal
// for "did toolchain.mjs report a problem", never a substring collision with
// that unrelated beads warning.
//
// FIXTURES: a REAL node (a distinct hard link/copy of this test runner's own
// node -- never `process.execPath` itself, so "the recording was honored" is
// never confused with "the current runtime happened to work") plus small,
// self-written `bd` stub scripts (never a real installed `bd`) -- matching
// this task's own constraint that no case may require a real node install
// other than the one running the test, a real bd, or the network. A spawned
// sprint child is neutered exactly as i9ag19-14 does: a `--require` preload
// (inherited via the child supervisor's own env, NODE_OPTIONS) intercepts
// ONLY an invocation whose argv[1] is cli.mjs, records the interpreter it was
// actually run with, and exits 0 before the real engine ever loads.
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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveServiceToken } from '../src/supervisor/auth.mjs';
import { writeSupervisorToolchain, supervisorConfigPath } from '../src/supervisor/project-config.mjs';
import { TOOLCHAIN_FIX_LINE } from '../src/supervisor/toolchain.mjs';
import { prependToPathEnv } from './helpers/child-path-env.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { buildRecordedNode } from './helpers/recorded-node-fixture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SE_ROOT = path.resolve(__dirname, '..');
const SERVE_BIN = path.join(SE_ROOT, 'bin', 'serve.mjs');

const BOOT_TIMEOUT_MS = scaledTimeout(30_000);
const SPAWN_RECORD_TIMEOUT_MS = scaledTimeout(20_000);
const SHUTDOWN_TIMEOUT_MS = scaledTimeout(15_000);
const HTTP_REQUEST_TIMEOUT_MS = scaledTimeout(10_000);

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
    // Realpath up front (macOS's /var -> /private/var): serve.mjs's
    // isMainModule() strictly string-compares realpath-resolved URLs, so an
    // unresolved tmp path makes the spawned child exit 0 without ever calling
    // serveMain() at all.
    const real = await fsp.realpath(dir);
    tmpDirs.add(real);
    return real;
}

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

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
            { host: '127.0.0.1', port, path: pathname, method, timeout: HTTP_REQUEST_TIMEOUT_MS, headers },
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

/** The first line containing every `needles` entry, or undefined. */
function findLine(output, needles) {
    return output
        .split(/\r?\n/)
        .find((line) => needles.every((needle) => line.includes(needle)));
}

/** Every line matching `pattern` (a RegExp tested against the whole line). */
function findLines(output, pattern) {
    return output.split(/\r?\n/).filter((line) => pattern.test(line));
}

function waitForOutputLine(supervisor, needles, timeoutMs, describeFailure) {
    return waitFor(
        () => findLine(supervisor.getOutput(), needles),
        timeoutMs,
        () => `${describeFailure()}\noutput:\n${supervisor.getOutput()}`,
    );
}

/**
 * Writes a tiny recorded `bd` stub at `filePath` (platform-appropriate: a
 * `.cmd` batch file on win32, a `#!/bin/sh` script elsewhere). `versionOk`
 * controls whether `bd --version` succeeds (a good/working stub, used both
 * for a GOOD recording and for the fallback stub reachable via PATH) or
 * fails outright (a broken/unprobeable recording). Never a real installed
 * `bd` -- this is what lets every case here run with no real bd anywhere.
 */
function writeBdStub(filePath, { versionOk }) {
    const isWin = process.platform === 'win32';
    if (isWin) {
        const content = versionOk
            ? '@echo off\r\n'
              + 'if "%~1"=="--version" (\r\n'
              + '  echo bd 1.2.3\r\n'
              + ') else (\r\n'
              + '  echo []\r\n'
              + ')\r\n'
            : '@echo off\r\nexit /b 1\r\n';
        fs.writeFileSync(filePath, content, 'utf-8');
        return;
    }
    const content = versionOk
        ? '#!/bin/sh\n'
          + 'if [ "$1" = "--version" ]; then\n'
          + '  echo "bd 1.2.3"\n'
          + '  exit 0\n'
          + 'fi\n'
          + 'echo "[]"\n'
        : '#!/bin/sh\nexit 1\n';
    fs.writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o755 });
    fs.chmodSync(filePath, 0o755);
}

/**
 * Builds the fixture tools shared by every scenario below: a REAL recorded
 * node (see ./helpers/recorded-node-fixture.mjs for the exact shape and why)
 * and the `--require` preload that turns a spawned sprint CLI (argv[1]
 * matching `cli.mjs`) into a stub that records its own interpreter and exits
 * 0 -- identical technique to i9ag19-14's own fixture, trimmed to only what
 * this file needs (no recorded bd here; each scenario below writes its own
 * bd stub(s) at the path(s) it needs).
 */
async function buildFixtureTools(label) {
    const toolDir = await mkTmp(`i9ag19-11-${label}-tools-`);
    const recordDir = path.join(toolDir, 'spawn-records');
    fs.mkdirSync(recordDir, { recursive: true });

    const recordedNode = buildRecordedNode(toolDir);

    const preload = path.join(toolDir, 'record-cli-spawn.cjs');
    fs.writeFileSync(
        preload,
        '// Written by test/i9ag19-11-serve-startup-toolchain.test.mjs.\n'
        + 'const fs = require("node:fs");\n'
        + 'const path = require("node:path");\n'
        + `const RECORD_DIR = ${JSON.stringify(recordDir)};\n`
        + 'const target = process.argv[1] || "";\n'
        + 'if (/(^|[\\\\/])cli\\.mjs$/.test(target)) {\n'
        + '    try {\n'
        + '        fs.mkdirSync(RECORD_DIR, { recursive: true });\n'
        + '        fs.writeFileSync(\n'
        + '            path.join(RECORD_DIR, "spawn-" + process.pid + ".json"),\n'
        + '            JSON.stringify({ execPath: process.execPath, argv: process.argv }, null, 2),\n'
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

    return { toolDir, recordDir, recordedNode, preload };
}

/** A fresh temp dir holding ONLY a working `bd` stub named exactly `bd`
 * (`bd.cmd` on win32) -- for prepending to a child's PATH so the
 * UNCONFIGURED bd fallback resolves to this fixture, never a real bd. */
async function buildPathBdDir(label) {
    const dir = await mkTmp(`i9ag19-11-${label}-pathbd-`);
    const isWin = process.platform === 'win32';
    writeBdStub(path.join(dir, isWin ? 'bd.cmd' : 'bd'), { versionOk: true });
    return dir;
}

function serviceStyleEnv({ dataDir, appDataDir, homeDir, preload, extraPathDir }) {
    const env = { ...process.env };
    delete env.BEADS_DIR;
    delete env.FLEET_SE_NODE;
    delete env.FLEET_SE_SWEEP_OWNER_DATA_DIR;
    env.FLEET_SE_DATA_DIR = dataDir;
    env.APRA_FLEET_DATA_DIR = appDataDir;
    // An isolated home: no shared fleet.key, so the supervisor mints/reads
    // its own service token and never reaches a real fleet server.
    env.HOME = homeDir;
    env.USERPROFILE = homeDir;
    if (preload) {
        const existingNodeOptions = typeof env.NODE_OPTIONS === 'string' && env.NODE_OPTIONS.trim() ? `${env.NODE_OPTIONS} ` : '';
        const requireArg = /\s/.test(preload) ? `"${preload}"` : preload;
        env.NODE_OPTIONS = `${existingNodeOptions}--require ${requireArg}`;
    }
    if (extraPathDir) prependToPathEnv(env, extraPathDir);
    return env;
}

/**
 * Boots the REAL `bin/serve.mjs` as a subprocess against a fixture toolchain
 * (or none / a malformed file), waits (bounded) for it to answer GET
 * /api/health, and returns a handle exposing its accumulated stdout/stderr
 * and a guarded HTTP request helper.
 *
 * @param {string} label
 * @param {{
 *   toolchainConfig?: { nodePath: string, nodeVersion?: string, bdPath?: string, bdVersion?: string } | null,
 *   malformedConfigText?: string,
 *   preload?: string,
 *   extraPathDir?: string,
 * }} opts
 */
async function bootServe(label, opts = {}) {
    const dataDir = await mkTmp(`i9ag19-11-${label}-se-data-`);
    const appDataDir = await mkTmp(`i9ag19-11-${label}-fleet-data-`);
    const homeDir = await mkTmp(`i9ag19-11-${label}-home-`);
    // A cwd that is NOT a project: no .beads anywhere the supervisor should
    // adopt, mirroring the "no project resolved yet" shape every scenario
    // here shares -- none of them are about project-folder resolution.
    const cwd = await mkTmp(`i9ag19-11-${label}-cwd-`);

    if (typeof opts.malformedConfigText === 'string') {
        const filePath = supervisorConfigPath({ dataDir });
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, opts.malformedConfigText, 'utf-8');
    } else if (opts.toolchainConfig) {
        await writeSupervisorToolchain(opts.toolchainConfig, { dataDir });
    }
    // opts.toolchainConfig omitted AND no malformed text -- nothing recorded
    // at all (the AC4 case): no config file is written.

    const { token } = resolveServiceToken(dataDir, { home: homeDir });
    assert.ok(token && token.length > 0, 'resolveServiceToken() returned an empty token');

    const env = serviceStyleEnv({
        dataDir, appDataDir, homeDir, preload: opts.preload, extraPathDir: opts.extraPathDir,
    });

    const port = await getFreePort();
    let output = '';
    const child = spawn(process.execPath, [SERVE_BIN, '--port', String(port)], {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], env,
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
        () => `the supervisor never answered GET /api/health.\noutput:\n${output}`,
    );

    return supervisor;
}

async function stopSupervisor(supervisor) {
    if (!supervisor) return;
    try {
        await supervisor.request('/api/shutdown', 'POST');
        await waitForExit(supervisor.child, SHUTDOWN_TIMEOUT_MS);
    } catch {
        // Fall through to the hard kill.
    } finally {
        forceKill(supervisor.child.pid);
    }
}

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
                return null;
            }
        })
        .filter((r) => r && typeof r.execPath === 'string');
}

/** A minimal, always-valid launch body -- `issue` is required so the launch
 * reaches the scope-overlap guard, which is what actually shells out to
 * `bd` (see scope-overlap.mjs's checkLaunch()). */
function launchBody(label) {
    return {
        issue: `apra-fleet-i9ag.19.11-${label}-probe`,
        members: `i9ag19-11-${label}-probe-member`,
        branch: `feat/i9ag19-11-${label}-probe`,
        base: 'main',
    };
}

describe('apra-fleet-i9ag.19.11: a GOOD recording produces exactly one informational startup line, no problems', () => {
    test('exactly one "[supervisor] toolchain:" line, naming the recorded node+bd and their versions; no ERROR/WARNING toolchain line', async () => {
        const fixture = await buildFixtureTools('good');
        const recordedBd = path.join(fixture.toolDir, 'recorded-bd');
        writeBdStub(recordedBd, { versionOk: true });

        let supervisor;
        try {
            supervisor = await bootServe('good', {
                toolchainConfig: { nodePath: fixture.recordedNode, bdPath: recordedBd },
            });

            const toolchainLines = findLines(supervisor.getOutput(), /^\[supervisor\] toolchain: /);
            assert.equal(
                toolchainLines.length, 1,
                `expected exactly one informational toolchain line, got ${toolchainLines.length}:\n${supervisor.getOutput()}`,
            );
            const [line] = toolchainLines;
            assert.ok(line.includes(fixture.recordedNode), line);
            assert.ok(line.includes(`(v${process.versions.node})`), line);
            assert.ok(line.includes(recordedBd), line);
            assert.ok(line.includes('(v1.2.3)'), line);
            assert.match(line, /\(source: .*supervisor\.config\.json\)/);

            // No problem was ever reported: the module's own fix line never
            // appears anywhere in the output.
            assert.ok(
                !supervisor.getOutput().includes(TOOLCHAIN_FIX_LINE),
                `a good recording must never print the toolchain fix line:\n${supervisor.getOutput()}`,
            );
        } finally {
            await stopSupervisor(supervisor);
        }
    });
});

describe('apra-fleet-i9ag.19.35: a launch is never refused for a recorded node startup validation ACCEPTED in the same process', () => {
    // The defect this closes end to end: the supervisor logged
    // "[supervisor] toolchain: node <path> (vX)" at startup -- its own
    // validateRecordedToolchain() had probed that exact binary and it
    // answered -- and moments later the launch path's INDEPENDENT re-probe of
    // the SAME path failed under host load and hard-refused the launch with a
    // 503 "does not resolve to a usable Node.js runtime". One binary, two
    // probes, two policies, and the second one fatal.
    //
    // The fix is that the launch path no longer re-probes what startup
    // accepted: bin/serve.mjs hands the ACCEPTED version to createSpawner
    // (configuredNodeVersion), which threads it to node-runner.mjs's
    // CONFIGURED tier, which consumes it. What is observable from outside the
    // process -- and what this case asserts -- is that the version the
    // spawner reports resolving is EXACTLY the version the startup line
    // reported for that same path, with source "configured" and no 503
    // anywhere. (The unit-level proof that consuming it means no probe
    // happens at all, even against an exec that fails every probe, is in
    // test/i9ag15-node-runner.test.mjs's own apra-fleet-i9ag.19.35 block.)
    test('the spawner resolves the recorded node with the exact version the startup toolchain line accepted, and the launch is never 503\'d', async () => {
        const fixture = await buildFixtureTools('accepted');
        const recordedBd = path.join(fixture.toolDir, 'recorded-bd');
        writeBdStub(recordedBd, { versionOk: true });
        const pathBdDir = await buildPathBdDir('accepted');

        let supervisor;
        try {
            supervisor = await bootServe('accepted', {
                toolchainConfig: { nodePath: fixture.recordedNode, bdPath: recordedBd },
                preload: fixture.preload,
                extraPathDir: pathBdDir,
            });

            // Startup ACCEPTED the recorded node -- this is the precondition
            // the whole case is about, read off the supervisor's own line
            // rather than assumed.
            const startupLine = findLine(supervisor.getOutput(), ['[supervisor] toolchain: node ', fixture.recordedNode]);
            assert.ok(startupLine, `startup never reported accepting the recorded node:\n${supervisor.getOutput()}`);
            const acceptedVersion = /\(v([0-9]+\.[0-9]+\.[0-9]+)\)/.exec(startupLine)?.[1];
            assert.ok(acceptedVersion, `could not read the accepted version off: ${startupLine}`);
            assert.deepEqual(findLines(supervisor.getOutput(), /^\[supervisor\] ERROR: /), []);

            const launch = await supervisor.request('/api/sprints', 'POST', launchBody('accepted'));
            assert.equal(
                launch.status, 201,
                `a launch over a node startup validation ACCEPTED must never be refused.\nresponse: ${launch.body}\noutput:\n${supervisor.getOutput()}`,
            );
            track(JSON.parse(launch.body).pid);

            const resolvedLine = await waitForOutputLine(
                supervisor,
                ['[spawner] resolved sprint runner:'],
                SPAWN_RECORD_TIMEOUT_MS,
                () => 'the supervisor never reported resolving the sprint runner',
            );
            assert.ok(resolvedLine.includes('source: configured'), resolvedLine);
            assert.ok(resolvedLine.includes(fixture.recordedNode), resolvedLine);
            assert.ok(
                resolvedLine.includes(`version: ${acceptedVersion}`),
                `the launch must report the SAME version startup accepted (${acceptedVersion}) -- a different one means it re-probed: ${resolvedLine}`,
            );
            assert.ok(
                !supervisor.getOutput().includes('does not resolve to a usable Node.js runtime'),
                `the wording reserved for a genuinely broken recording must never appear for an accepted one:\n${supervisor.getOutput()}`,
            );
        } finally {
            await stopSupervisor(supervisor);
        }
    });
});

describe('apra-fleet-i9ag.19.11: a BROKEN recorded node -- loud ERROR naming the path and the module\'s own fix line', () => {
    test('the ERROR line carries TOOLCHAIN_FIX_LINE verbatim (not a hand-copied literal); still listening; launch refused 503 naming the path', async () => {
        const fixture = await buildFixtureTools('brokennode');
        const missingNode = path.join(fixture.toolDir, 'removed-by-version-manager', process.platform === 'win32' ? 'node.exe' : 'node');
        assert.ok(!fs.existsSync(missingNode), 'the broken recorded node path must not exist');
        const recordedBd = path.join(fixture.toolDir, 'recorded-bd');
        writeBdStub(recordedBd, { versionOk: true });

        let supervisor;
        try {
            supervisor = await bootServe('brokennode', {
                toolchainConfig: { nodePath: missingNode, bdPath: recordedBd },
            });

            const errorLines = findLines(supervisor.getOutput(), /^\[supervisor\] ERROR: /);
            assert.equal(errorLines.length, 1, `expected exactly one ERROR line:\n${supervisor.getOutput()}`);
            const [line] = errorLines;
            assert.ok(line.includes(missingNode), `the ERROR line must name the broken path: ${line}`);
            assert.ok(
                line.includes(TOOLCHAIN_FIX_LINE),
                `the ERROR line must carry the module's own exported fix line verbatim, got: ${line}`,
            );

            // No informational toolchain line is ALSO printed for this boot
            // -- exactly one of the three branches fires.
            assert.deepEqual(findLines(supervisor.getOutput(), /^\[supervisor\] toolchain: /), []);

            // Loud but never fatal: still bound and answering.
            const health = JSON.parse((await supervisor.request('/api/health', 'GET')).body);
            assert.equal(health.status, 'ok');

            const refused = await supervisor.request('/api/sprints', 'POST', launchBody('brokennode'));
            assert.equal(refused.status, 503, `a launch over a broken recorded node must be refused 503.\nresponse: ${refused.body}`);
            const body = JSON.parse(refused.body);
            assert.ok(body.error.includes(missingNode), `the 503 message does not name the broken recorded node path.\nmessage: ${body.error}`);
        } finally {
            await stopSupervisor(supervisor);
        }
    });
});

describe('apra-fleet-i9ag.19.11: a broken recorded BD with a FINE node -- its own WARNING, launch still succeeds via the PATH fallback', () => {
    test('bd\'s problem is a WARNING (never an ERROR, never folded into the node line); a launch still succeeds', async () => {
        const fixture = await buildFixtureTools('bdbroken');
        const recordedBrokenBd = path.join(fixture.toolDir, 'recorded-broken-bd');
        writeBdStub(recordedBrokenBd, { versionOk: false });
        // The UNCONFIGURED PATH fallback exec-bd.mjs falls back to when no
        // bdPath validates -- a working stub, never a real installed bd.
        const pathBdDir = await buildPathBdDir('bdbroken');

        let supervisor;
        try {
            supervisor = await bootServe('bdbroken', {
                toolchainConfig: { nodePath: fixture.recordedNode, bdPath: recordedBrokenBd },
                preload: fixture.preload,
                extraPathDir: pathBdDir,
            });

            // Node reported on its OWN line (the node-is-fine/bd-is-not
            // branch), never the combined "node ..., bd ..." good-recording
            // line -- so this is not just "no ERROR", it is the SPECIFIC
            // third branch.
            const nodeLines = findLines(supervisor.getOutput(), /^\[supervisor\] toolchain: node /);
            assert.equal(nodeLines.length, 1, `expected exactly one node-status line:\n${supervisor.getOutput()}`);
            assert.ok(!nodeLines[0].includes(', bd '), `node's own line must not fold in bd's status: ${nodeLines[0]}`);
            assert.ok(nodeLines[0].includes(fixture.recordedNode));
            assert.ok(nodeLines[0].includes(`(v${process.versions.node})`));

            const warnLines = findLines(supervisor.getOutput(), /^\[supervisor\] WARNING: /)
                .filter((l) => l.includes(recordedBrokenBd));
            assert.equal(warnLines.length, 1, `expected exactly one bd WARNING line naming the broken path:\n${supervisor.getOutput()}`);
            assert.ok(warnLines[0].includes(TOOLCHAIN_FIX_LINE), `the WARNING must carry the module's own fix line: ${warnLines[0]}`);
            assert.ok(warnLines[0].includes('falls back to a PATH lookup'), warnLines[0]);

            // Never escalated to an ERROR: node stayed fine.
            assert.deepEqual(findLines(supervisor.getOutput(), /^\[supervisor\] ERROR: /), []);

            const launch = await supervisor.request('/api/sprints', 'POST', launchBody('bdbroken'));
            assert.equal(
                launch.status, 201,
                `a launch with only bd broken (node fine) must still succeed via bd's PATH fallback.\nresponse: ${launch.body}\noutput:\n${supervisor.getOutput()}`,
            );
            const launched = JSON.parse(launch.body);
            track(launched.pid);

            // The sprint itself still ran with the RECORDED (good) node --
            // bd being broken must not affect node's own resolution.
            const records = await waitFor(
                () => {
                    const found = readSpawnRecords(fixture.recordDir);
                    return found.length > 0 ? found : null;
                },
                SPAWN_RECORD_TIMEOUT_MS,
                () => `the spawned sprint child never recorded its interpreter.\noutput:\n${supervisor.getOutput()}`,
            );
            assert.equal(records.length, 1);
            assert.equal(path.resolve(records[0].execPath), path.resolve(fixture.recordedNode));
        } finally {
            await stopSupervisor(supervisor);
        }
    });
});

describe('apra-fleet-i9ag.19.11: NOTHING recorded -- no ERROR/WARNING line, and the spawner never receives a configured runner', () => {
    test('an informational "not recorded" line only; a launch resolves through a non-configured tier', async () => {
        const fixture = await buildFixtureTools('norecord');
        const pathBdDir = await buildPathBdDir('norecord');

        let supervisor;
        try {
            supervisor = await bootServe('norecord', {
                // No toolchainConfig at all -- an older install / a
                // foreground dev run, this task's "nothing recorded" case.
                preload: fixture.preload,
                extraPathDir: pathBdDir,
            });

            const toolchainLines = findLines(supervisor.getOutput(), /^\[supervisor\] toolchain: /);
            assert.equal(toolchainLines.length, 1, `expected exactly one toolchain line:\n${supervisor.getOutput()}`);
            assert.match(toolchainLines[0], /^\[supervisor\] toolchain: not recorded \(/);
            assert.deepEqual(findLines(supervisor.getOutput(), /^\[supervisor\] ERROR: /), []);
            assert.deepEqual(findLines(supervisor.getOutput(), /^\[supervisor\] WARNING: /).filter((l) => l.includes(TOOLCHAIN_FIX_LINE)), []);

            const launch = await supervisor.request('/api/sprints', 'POST', launchBody('norecord'));
            assert.equal(launch.status, 201, `a launch with nothing recorded must still succeed (today's PATH/current-runtime behavior).\nresponse: ${launch.body}\noutput:\n${supervisor.getOutput()}`);
            const launched = JSON.parse(launch.body);
            track(launched.pid);

            // The resolver's own account: some OTHER tier resolved, never
            // "configured" -- there was nothing to configure it with.
            const resolvedLine = await waitForOutputLine(
                supervisor,
                ['[spawner] resolved sprint runner:'],
                SPAWN_RECORD_TIMEOUT_MS,
                () => 'the supervisor never reported resolving the sprint runner',
            );
            assert.ok(
                !resolvedLine.includes('source: configured'),
                `the spawner must NOT receive a configured runner when nothing was recorded: ${resolvedLine}`,
            );
        } finally {
            await stopSupervisor(supervisor);
        }
    });
});

describe('apra-fleet-i9ag.19.11: a malformed supervisor.config.json -- startup still binds the port and reports the reader\'s own reason', () => {
    test('an unparsable config file still starts, and the "not recorded" line carries the reader\'s own JSON-parse reason', async () => {
        let supervisor;
        try {
            supervisor = await bootServe('malformed', { malformedConfigText: 'not valid json {{{' });

            const health = JSON.parse((await supervisor.request('/api/health', 'GET')).body);
            assert.equal(health.status, 'ok', 'a malformed supervisor.config.json must not prevent the supervisor from starting and serving');

            const toolchainLines = findLines(supervisor.getOutput(), /^\[supervisor\] toolchain: /);
            assert.equal(toolchainLines.length, 1, `expected exactly one toolchain line:\n${supervisor.getOutput()}`);
            assert.match(toolchainLines[0], /^\[supervisor\] toolchain: not recorded \(.*is not valid JSON/);
            assert.deepEqual(findLines(supervisor.getOutput(), /^\[supervisor\] ERROR: /), []);
            assert.ok(!supervisor.getOutput().includes(TOOLCHAIN_FIX_LINE), 'a malformed file is reported, never treated as a validation problem');
        } finally {
            await stopSupervisor(supervisor);
        }
    });
});
