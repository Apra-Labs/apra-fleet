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
//   3. THE CONTROL: the same npm-shaped `bd` shim, under the same node-less
//      environment but with the recorded node cleared out of it, FAILS --
//      and the single change that makes it pass again is the recorded node's
//      own directory on the search path. Without this, every "bd works under
//      a PATH-less service" assertion above could be passing for a reason
//      that has nothing to do with the product.
//
// `bd` IS RECORDED TOO, AND IS A REAL npm-SHAPED SHIM (amended AC A1, the
// judge of PR #561's defect D3). This suite used to write a `#!/bin/sh`
// script (POSIX) / a plain batch file (Windows) as its recorded `bd`.
// Neither needs `node` to run, so neither could reproduce this defect at
// all: a PATH with no `node` on it is invisible to them, and the "real
// repro" therefore only ever covered node itself. A real `bd` install is an
// npm shim -- a `#!/usr/bin/env node` script on POSIX, an npm-generated
// `.cmd` on Windows -- and an npm shim is precisely the thing that dies with
// `env: node: No such file or directory` (exit 127) on a launchd PATH. The
// fixture now builds exactly that (see `installNpmShapedBd()`), and the
// recorded node is named `node`/`node.exe` for the same reason: that literal
// name is the only one `#!/usr/bin/env node` or `%dp0%\node.exe` will ever
// resolve.
//
// BOTH bd HALVES ARE ASSERTED (amended AC A2), because they are two
// independent defects: the SUPERVISOR'S OWN bd calls (fixed by exec-bd.mjs /
// toolchain.mjs prepending the recorded node's directory to the bd child's
// PATH -- apra-fleet-i9ag.19.7/.30) and the SPRINT CHILD'S bd calls (fixed
// by spawner.mjs putting that same directory on the PATH the child inherits
// -- apra-fleet-i9ag.19.32). The first is asserted from the supervisor's own
// clean-toolchain startup line, which is only printed when its
// `bd --version` probe actually answered; the second from the spawned
// child's OWN captured exit status for a bd call it makes itself with no env
// override whatsoever.
//
// The recorded node comes from the SHARED test/helpers fixture (amended AC
// A4, ./helpers/recorded-node-fixture.mjs) -- this file does no
// `fs.linkSync`/`copyFileSync` of `process.execPath` of its own.
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
import { pathEnvKey, prependToPathEnv } from './helpers/child-path-env.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { buildRecordedNode } from './helpers/recorded-node-fixture.mjs';
import { startFakeFleet, writeProjectBeadsDir } from './helpers/fake-fleet-server.mjs';

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
/** Wall-clock ceiling for a single HTTP request against the child supervisor. */
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

// AC4: the child supervisor (and any sprint child a launch produced) is
// killed on EVERY exit path -- a passing run kills it in the test's own
// `finally` via a clean POST /api/shutdown, and this hook is the backstop
// for a thrown assertion, a timeout, or a crash before shutdown was reached.
/** @type {Set<{ stop: () => Promise<void> }>} */
const fakeFleets = new Set();

after(async () => {
    for (const pid of spawnedPids) forceKill(pid);
    spawnedPids.clear();
    for (const fleet of fakeFleets) {
        // eslint-disable-next-line no-await-in-loop
        await fleet.stop().catch(() => {});
    }
    fakeFleets.clear();
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

/** The version the npm-shaped bd shim below reports for `bd --version`. */
const BD_SHIM_VERSION = '0.44.0';

/**
 * A file path handed to a `{ shell: true }` invocation, quoted so a resolved
 * path containing whitespace survives cmd.exe's word splitting. Every path in
 * this file is resolved in JavaScript first (never left to shell-level `$VAR`
 * / `~` expansion, which would be wrong under PowerShell anyway) -- this only
 * protects the one place a fully-resolved path is handed to a shell.
 */
function quoteShellPath(file) {
    return /\s/.test(file) ? `"${file}"` : file;
}

/**
 * The BODY of the npm-shaped `bd` shim: a CommonJS script whose FIRST LINE is
 * `#!/usr/bin/env node`, i.e. a script that CANNOT run at all unless a `node`
 * is resolvable by that literal name (amended AC A1). It records every
 * invocation it receives -- argv, and crucially the `process.execPath` of the
 * interpreter that actually ran it -- then answers the two calls this test's
 * paths make: `--version` (the supervisor's startup toolchain validation) and
 * anything else (a `list`-shaped bulk fetch, which only needs well-formed
 * JSON).
 */
function bdShimSource(bdRecordDir) {
    return '#!/usr/bin/env node\n'
        + '// Written by test/i9ag19-14-pathless-service-launch.test.mjs.\n'
        + 'const fs = require("node:fs");\n'
        + 'const path = require("node:path");\n'
        + `const RECORD_DIR = ${JSON.stringify(bdRecordDir)};\n`
        + `const VERSION = ${JSON.stringify(BD_SHIM_VERSION)};\n`
        + 'const args = process.argv.slice(2);\n'
        + 'try {\n'
        + '    fs.mkdirSync(RECORD_DIR, { recursive: true });\n'
        + '    const name = "bd-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".json";\n'
        + '    fs.writeFileSync(\n'
        + '        path.join(RECORD_DIR, name),\n'
        + '        JSON.stringify({ argv: args, execPath: process.execPath, ppid: process.ppid }, null, 2),\n'
        + '        "utf-8",\n'
        + '    );\n'
        + '} catch (err) {\n'
        + '    process.stderr.write("[bd-shim] " + err.message + "\\n");\n'
        + '    process.exit(3);\n'
        + '}\n'
        + 'if (args[0] === "--version") {\n'
        + '    process.stdout.write("bd " + VERSION + "\\n");\n'
        + '    process.exit(0);\n'
        + '}\n'
        + 'process.stdout.write("[]\\n");\n'
        + 'process.exit(0);\n';
}

/**
 * Installs a REAL npm-shaped `bd` shim into `binDir` and returns its absolute
 * path (amended AC A1 -- the judge of PR #561's defect D3).
 *
 * WHY THE SHIM'S SHAPE IS THE WHOLE POINT: the previous version of this
 * fixture wrote a `#!/bin/sh` script (POSIX) / a plain `@echo off` batch file
 * (Windows). Neither needs `node` to run, so neither could reproduce the
 * defect this suite exists to pin at all -- a PATH with no `node` on it is
 * completely invisible to them, and the "real repro" therefore only ever
 * covered node itself, never `bd`. A real `bd` install is an npm shim, and an
 * npm shim is exactly the thing that dies on a node-less PATH:
 *
 *   - POSIX: npm links `<prefix>/bin/bd` to the package's own
 *     `bin/bd.js`, whose first line is `#!/usr/bin/env node`. The kernel runs
 *     `/usr/bin/env node <script>`, and `env` resolves `node` THROUGH PATH and
 *     nothing else -- co-location next to the script is irrelevant. Under a
 *     launchd PATH this is the literal `env: node: No such file or directory`
 *     (exit 127) failure apra-fleet-i9ag.19.7/.32 exist to fix, and it is
 *     reproduced here byte for byte. This fixture mirrors npm's real layout:
 *     a symlink at `<binDir>/bd` pointing at
 *     `<binDir>/node_modules/bd/bin/bd.js`.
 *   - WINDOWS: npm generates a `bd.cmd` shim that prefers a `node.exe`
 *     CO-LOCATED with itself (`%dp0%\node.exe`) and only falls back to a bare
 *     `node` on PATH. Because a real npm global prefix DOES have node.exe
 *     sitting next to the shims, PATH-lessness is much less lethal there --
 *     which is precisely why the production fix
 *     (`withConfiguredNodeDirOnPath()` in src/supervisor/lib/exec-bd.mjs,
 *     `withNodeFirstBdExec()` in src/supervisor/toolchain.mjs) is POSIX-gated
 *     by design. So this fixture reproduces npm's real Windows layout too:
 *     the shim sits in the SAME directory as the recorded node, and its body
 *     matches npm's generated shape exactly -- trailing
 *     `"%dp0%\...\bd.js" %*` -- which is also what
 *     `resolveConfiguredWindowsBdScript()` parses to invoke the wrapped
 *     `bd.js` directly under the recorded node. A shim in a node-LESS
 *     directory is what the control case (amended AC A3) uses to prove the
 *     shim genuinely needs a node.
 *
 * `type: "commonjs"` is written into the shim package's own package.json on
 * purpose: without it, Node's module-syntax detection would parse this
 * `require()`-shaped script as ESM (a bare call expression is valid ESM
 * syntax) and it would die with `require is not defined` -- a fixture
 * artifact that has nothing to do with what this suite tests.
 */
function installNpmShapedBd(binDir, bdRecordDir) {
    const isWin = process.platform === 'win32';
    const pkgDir = path.join(binDir, 'node_modules', 'bd');
    const pkgBinDir = path.join(pkgDir, 'bin');
    fs.mkdirSync(pkgBinDir, { recursive: true });
    fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        `${JSON.stringify({ name: 'bd', version: BD_SHIM_VERSION, type: 'commonjs', bin: { bd: 'bin/bd.js' } }, null, 2)}\n`,
        'utf-8',
    );
    const bdJs = path.join(pkgBinDir, 'bd.js');
    fs.writeFileSync(bdJs, bdShimSource(bdRecordDir), { encoding: 'utf-8', mode: 0o755 });
    fs.chmodSync(bdJs, 0o755);

    if (!isWin) {
        const bd = path.join(binDir, 'bd');
        fs.symlinkSync(bdJs, bd);
        // Asserted, not assumed: the thing this suite calls "a real npm-shaped
        // shim" must actually BE a `#!/usr/bin/env node` script (AC A1), so a
        // future edit cannot quietly regress it to a shell script that needs
        // no node and reproduces nothing.
        const firstLine = fs.readFileSync(fs.realpathSync(bd), 'utf-8').split('\n')[0];
        assert.equal(
            firstLine, '#!/usr/bin/env node',
            'the recorded bd must be a REAL npm-shaped shim -- a `#!/usr/bin/env node` script, never a #!/bin/sh stub that needs no node at all',
        );
        return bd;
    }

    // npm's generated Windows shim, verbatim in shape (see this function's
    // doc comment): `%dp0%` is cmd.exe's own expansion of the shim's OWN
    // directory, computed by cmd, not a shell variable this test relies on
    // expanding -- every path this test itself contributes is already
    // resolved in JavaScript.
    const bdCmd = path.join(binDir, 'bd.cmd');
    fs.writeFileSync(
        bdCmd,
        '@ECHO off\r\n'
        + 'SETLOCAL\r\n'
        + 'CALL :find_dp0\r\n'
        + 'IF EXIST "%dp0%\\node.exe" (\r\n'
        + '  SET "_prog=%dp0%\\node.exe"\r\n'
        + ') ELSE (\r\n'
        + '  SET "_prog=node"\r\n'
        + '  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n'
        + ')\r\n'
        + 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\bd\\bin\\bd.js" %*\r\n'
        + 'GOTO :EOF\r\n'
        + ':find_dp0\r\n'
        + 'SET dp0=%~dp0\r\n'
        + 'EXIT /b\r\n',
        'utf-8',
    );
    // Same guard as the POSIX branch: this must remain a shim that RESOLVES A
    // NODE (and one `resolveConfiguredWindowsBdScript()` can parse), never a
    // self-contained batch file that answers `--version` on its own.
    const cmdBody = fs.readFileSync(bdCmd, 'utf-8');
    assert.match(
        cmdBody, /"%dp0%\\([^"]+\.js)"\s*%\*/,
        'the recorded bd.cmd must match npm\'s generated Windows shim shape (a wrapped "<...>.js" %* invocation), never a hand-rolled batch stub',
    );
    return bdCmd;
}

/** Reads every invocation the npm-shaped bd shim has recorded so far. */
function readBdInvocations(bdRecordDir) {
    let names;
    try {
        names = fs.readdirSync(bdRecordDir);
    } catch {
        return [];
    }
    return names
        .filter((n) => n.endsWith('.json'))
        .map((n) => {
            try {
                return JSON.parse(fs.readFileSync(path.join(bdRecordDir, n), 'utf-8'));
            } catch {
                return null; // a partially-written file on this poll; try again next tick
            }
        })
        .filter((r) => r && typeof r.execPath === 'string' && Array.isArray(r.argv));
}

/**
 * Writes the recorded-toolchain fixture: a REAL node (see
 * ./helpers/recorded-node-fixture.mjs for the exact shape and why -- the
 * recorded path is never `process.execPath` itself), a REAL npm-shaped
 * recorded `bd` beside it (see `installNpmShapedBd()` above), and the
 * `--require` preload that turns the spawned sprint CLI into a recording
 * stub which makes its own `bd` call.
 *
 * Every path here is resolved in JavaScript -- nothing is left to shell-level
 * expansion, and the shim is written per-platform (npm's `.cmd` shape for
 * cmd.exe on win32, npm's `#!/usr/bin/env node` script + symlink elsewhere)
 * rather than assuming a POSIX shell on the host.
 *
 * The recorded node is built by the SHARED fixture (AC A4) -- this suite does
 * no `fs.linkSync`/`copyFileSync` of `process.execPath` of its own -- and is
 * named `node`/`node.exe` (the shared fixture's `name` option) because that
 * is the ONLY name an npm-shaped shim ever resolves: `#!/usr/bin/env node`
 * and `%dp0%\node.exe` both look for that literal name and nothing else.
 */
async function buildToolchainFixture(label) {
    const toolDir = await mkTmp(`i9ag19-14-${label}-tools-`);
    const recordDir = path.join(toolDir, 'spawn-records');
    const bdRecordDir = path.join(toolDir, 'bd-invocations');
    fs.mkdirSync(recordDir, { recursive: true });
    fs.mkdirSync(bdRecordDir, { recursive: true });
    const isWin = process.platform === 'win32';

    const recordedNode = buildRecordedNode(toolDir, { name: 'node' });
    const binDir = path.dirname(recordedNode);

    // --- the recorded bd: a real npm-shaped shim, co-located with the
    // recorded node exactly as npm's own global prefix co-locates them. Not
    // on PATH, deliberately: PATH is empty here, and a recorded absolute bd
    // path is exactly what a service-started supervisor has.
    const recordedBd = installNpmShapedBd(binDir, bdRecordDir);
    // Runnable AT ALL, checked under the test runner's own (node-bearing)
    // env, so a broken fixture fails here rather than as a confusing 503
    // later. The PATH-less behaviour is what the tests themselves assert.
    const bdProbe = spawnSync(isWin ? quoteShellPath(recordedBd) : recordedBd, ['--version'], { encoding: 'utf-8', shell: isWin });
    assert.equal(bdProbe.status, 0, `the recorded bd shim is not runnable: ${bdProbe.error ? bdProbe.error.message : bdProbe.stderr}`);
    assert.match(bdProbe.stdout, new RegExp(`bd ${BD_SHIM_VERSION}`), `the recorded bd shim did not report its version: ${JSON.stringify(bdProbe.stdout)}`);
    // Its records are the test's own instrument -- clear the probe above out
    // of the way so each test counts only the invocations IT caused.
    for (const name of fs.readdirSync(bdRecordDir)) fs.rmSync(path.join(bdRecordDir, name), { force: true });

    // --- the preload that makes the spawned sprint CLI a recording stub.
    // Intercepts ONLY a child whose argv[1] is cli.mjs: the supervisor itself
    // (serve.mjs), every `<node> --version` probe, and the bd shim's own node
    // (argv[1] is bd/bd.js) all run untouched.
    //
    // The stub also makes THE SPRINT CHILD'S OWN `bd` CALL (amended AC A2):
    // the child-env half of this defect is separate from the supervisor's own
    // bd calls -- the child inherits the service's node-less PATH and shells
    // out to the npm-shaped `bd` on its own, which is exactly what
    // spawner.mjs's PATH prepend (apra-fleet-i9ag.19.32) exists to keep
    // working. It runs bd with its OWN INHERITED ENVIRONMENT (no `env`
    // override at all), because that inherited environment IS the thing under
    // test, and records the outcome so the test can assert it succeeded.
    const preload = path.join(toolDir, 'record-cli-spawn.cjs');
    fs.writeFileSync(
        preload,
        '// Written by test/i9ag19-14-pathless-service-launch.test.mjs.\n'
        + 'const fs = require("node:fs");\n'
        + 'const path = require("node:path");\n'
        + 'const { spawnSync } = require("node:child_process");\n'
        + `const RECORD_DIR = ${JSON.stringify(recordDir)};\n`
        + `const BD_PATH = ${JSON.stringify(recordedBd)};\n`
        + 'const target = process.argv[1] || "";\n'
        + 'if (/(^|[\\\\/])cli\\.mjs$/.test(target)) {\n'
        + '    const isWin = process.platform === "win32";\n'
        + '    const quoted = isWin && /\\s/.test(BD_PATH) ? JSON.stringify(BD_PATH) : BD_PATH;\n'
        + '    let bdCall;\n'
        + '    try {\n'
        + '        const r = spawnSync(quoted, ["list", "--json"], { encoding: "utf-8", shell: isWin });\n'
        + '        bdCall = { status: r.status, error: r.error ? String(r.error.message) : null, stdout: r.stdout || "", stderr: r.stderr || "" };\n'
        + '    } catch (err) {\n'
        + '        bdCall = { status: null, error: String(err && err.message), stdout: "", stderr: "" };\n'
        + '    }\n'
        + '    try {\n'
        + '        fs.mkdirSync(RECORD_DIR, { recursive: true });\n'
        + '        fs.writeFileSync(\n'
        + '            path.join(RECORD_DIR, "spawn-" + process.pid + ".json"),\n'
        + '            JSON.stringify({ execPath: process.execPath, argv: process.argv, cwd: process.cwd(), bdCall }, null, 2),\n'
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

    return { toolDir, binDir, recordDir, bdRecordDir, recordedNode, recordedBd, preload };
}

/**
 * The environment a service-started supervisor has on a version-manager
 * host: a PATH with no `node` (and no `bd`) anywhere in it, and no
 * FLEET_SE_NODE escape hatch. Everything else (SystemRoot/ComSpec/TMP and
 * friends) is preserved -- destroying those would test a broken machine
 * rather than a PATH-less service.
 */
function nodeLessPathEnv(emptyPathDir) {
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
    return env;
}

function serviceStyleEnv({ emptyPathDir, dataDir, appDataDir, homeDir, preload }) {
    const env = nodeLessPathEnv(emptyPathDir);
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
    // The project the supervisor serves: a `.beads` holding bd init's
    // metadata.json, so it discovers a project and ensures its LLM-less
    // backlog member for it (a supervisor with no project, or with no
    // reachable fleet, refuses every launch 503 by design). Its own startup
    // bd calls (the identity probe) go through the recorded npm-shaped shim
    // under this same PATH-less environment.
    const cwd = await mkTmp(`i9ag19-14-${label}-cwd-`);
    writeProjectBeadsDir(cwd);
    // A real fleet server on the wire (test/helpers/fake-fleet-server.mjs),
    // discovered the product's own way (server.json in APRA_FLEET_DATA_DIR):
    // the supervisor registers its backlog member there and runs the
    // backlog member's tip-checked D-pull over execute_command, unmodified.
    const fleet = await startFakeFleet({ dataDir: appDataDir });
    fakeFleets.add(fleet);

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
        fleet,
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
        if (supervisor.fleet) await supervisor.fleet.stop().catch(() => {});
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
                    bdVersion: BD_SHIM_VERSION,
                },
            });

            // AC A2, THE SUPERVISOR'S OWN `bd` CALL: this exact line is only
            // printed when the startup toolchain validation had NO problems
            // at all (bin/serve.mjs prints a WARNING line naming bd instead
            // the moment the bd probe failed) -- so seeing it is a direct
            // statement that `<recorded bd> --version`, an npm-shaped
            // `#!/usr/bin/env node` shim, RAN AND ANSWERED on a host whose
            // PATH has no `node` on it. Before apra-fleet-i9ag.19.7's PATH
            // composition it died with `env: node: No such file or directory`.
            await waitForOutputLine(
                supervisor,
                ['[supervisor] toolchain: node', fixture.recordedNode, `bd ${fixture.recordedBd} (v${BD_SHIM_VERSION})`],
                BOOT_TIMEOUT_MS,
                () => 'the PATH-less supervisor never reported a clean toolchain -- its own npm-shaped bd call did not succeed',
            );

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

            // AC A2, THE SPRINT CHILD'S OWN `bd` CALL -- a SEPARATE defect
            // from the supervisor's own bd calls above, and both are in scope
            // here. The child inherits the service's node-less PATH and
            // shells out to the npm-shaped `bd` itself; spawner.mjs's PATH
            // prepend (apra-fleet-i9ag.19.32) is what keeps that working.
            // Asserted from the CHILD's own captured exit status, not
            // inferred from the supervisor's log.
            assert.ok(record.bdCall, `the spawned sprint child recorded no bd call at all: ${JSON.stringify(record)}`);
            assert.equal(
                record.bdCall.status, 0,
                'the SPRINT CHILD\'s own npm-shaped bd call failed under the inherited service PATH '
                + `(status=${record.bdCall.status}, error=${record.bdCall.error}, stderr=${JSON.stringify(record.bdCall.stderr)}) -- `
                + 'this is the child-env half of apra-fleet-i9ag.19, separate from the supervisor\'s own bd calls',
            );
            assert.equal(
                record.bdCall.stdout.trim(), '[]',
                `the sprint child's bd call produced no usable output: ${JSON.stringify(record.bdCall.stdout)}`,
            );

            // Both halves, from the shim's OWN side of the pipe: every `bd`
            // invocation that happened under this PATH-less supervisor ran
            // under the RECORDED node -- which, for a `#!/usr/bin/env node`
            // shim on a PATH with no node, can only be true if the recorded
            // node's directory was put on the search path the shim's `env`
            // lookup (or npm's `.cmd` node resolution) actually consults.
            const bdCalls = await waitFor(
                () => {
                    const found = readBdInvocations(fixture.bdRecordDir);
                    return found.length >= 2 ? found : null;
                },
                SPAWN_RECORD_TIMEOUT_MS,
                () => 'expected at least two recorded bd invocations (the supervisor\'s own --version probe and the sprint child\'s call)'
                    + `\noutput:\n${supervisor.getOutput()}`,
            );
            for (const call of bdCalls) {
                assert.ok(
                    samePath(call.execPath, fixture.recordedNode),
                    `a bd invocation (${JSON.stringify(call.argv)}) ran under ${call.execPath}, not the RECORDED node ${fixture.recordedNode}`,
                );
            }
            assert.ok(
                bdCalls.some((call) => call.argv[0] === '--version'),
                `the supervisor's own 'bd --version' probe was never recorded: ${JSON.stringify(bdCalls.map((c) => c.argv))}`,
            );
            assert.ok(
                bdCalls.some((call) => call.argv[0] === 'list'),
                `the sprint child's own 'bd list' call was never recorded: ${JSON.stringify(bdCalls.map((c) => c.argv))}`,
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
                    bdVersion: BD_SHIM_VERSION,
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

    // AC A3: THE CONTROL. Everything above asserts that an npm-shaped `bd`
    // SUCCEEDS on a node-less PATH -- which is only meaningful if that shim
    // would genuinely FAIL without the recorded node the product supplies.
    // This is the check that the harness is not cheating: the SAME shim,
    // under the SAME node-less environment, with the recorded node cleared
    // from it, must fail; and the ONLY difference that makes it pass must be
    // the recorded node's own directory on the search path.
    test('the control: the SAME npm-shaped bd shim FAILS under the same node-less PATH once the recorded node is cleared, and passes for that reason alone', async () => {
        const fixture = await buildToolchainFixture('control');
        const emptyPathDir = await mkTmp('i9ag19-14-control-empty-path-');
        const isWin = process.platform === 'win32';

        // A SECOND copy of the identical shim, in a directory with NO node
        // beside it. On POSIX the directory is irrelevant (`#!/usr/bin/env
        // node` consults PATH and nothing else), so this copy behaves exactly
        // like the recorded one; on Windows it is what removes npm's
        // `%dp0%\node.exe` preference, leaving the shim's bare `node` PATH
        // fallback -- i.e. on BOTH platforms this is the shim with every
        // node it could find taken away but its own body unchanged.
        const controlBinDir = path.join(fixture.toolDir, 'control-bin');
        fs.mkdirSync(controlBinDir, { recursive: true });
        const controlBd = installNpmShapedBd(controlBinDir, path.join(fixture.toolDir, 'control-bd-invocations'));
        assert.ok(
            !fs.existsSync(path.join(controlBinDir, isWin ? 'node.exe' : 'node')),
            'the control shim must have no node co-located with it, or the control would not be a control at all',
        );

        const env = nodeLessPathEnv(emptyPathDir);
        // The premise, asserted rather than assumed (same check the
        // supervisor harness makes): `node` is not resolvable here.
        const lookup = spawnSync('node', ['--version'], { env, encoding: 'utf-8' });
        assert.ok(
            lookup.error && lookup.error.code === 'ENOENT',
            `'node' must NOT be resolvable on the control environment's PATH (got status=${lookup.status}, stdout=${JSON.stringify(lookup.stdout)})`,
        );

        const bdFile = isWin ? quoteShellPath(controlBd) : controlBd;
        const failed = spawnSync(bdFile, ['--version'], { env, encoding: 'utf-8', shell: isWin });
        assert.ok(
            failed.error || failed.status !== 0,
            'the npm-shaped bd shim SUCCEEDED with no node anywhere on its PATH -- it cannot need node, '
            + 'so it could never have reproduced this defect and every "bd works under a PATH-less service" '
            + `assertion in this file would be vacuous (status=${failed.status}, stdout=${JSON.stringify(failed.stdout)})`,
        );
        assert.ok(
            !/bd \d/.test(failed.stdout ?? ''),
            `the failing control still answered with a bd version: ${JSON.stringify(failed.stdout)}`,
        );

        // ...and the ONE change that fixes it is exactly what the product
        // does: the recorded node's own directory on the search path. Same
        // shim, same node-less base env, one prepended directory (through the
        // SAME case-correct helper production uses, so this is correct on
        // Windows' `Path` too).
        const healed = prependToPathEnv({ ...env }, fixture.binDir);
        const passed = spawnSync(bdFile, ['--version'], { env: healed, encoding: 'utf-8', shell: isWin });
        assert.equal(
            passed.status, 0,
            `the same shim must succeed once the recorded node's directory is on the search path `
            + `(status=${passed.status}, error=${passed.error ? passed.error.message : 'none'}, stderr=${JSON.stringify(passed.stderr)})`,
        );
        assert.match(
            passed.stdout, new RegExp(`bd ${BD_SHIM_VERSION}`),
            `the healed control did not report the shim's version: ${JSON.stringify(passed.stdout)}`,
        );
    });
});
