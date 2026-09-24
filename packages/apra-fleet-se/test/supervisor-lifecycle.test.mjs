import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createWatchdog, WATCHDOG_STATUS, readProcessCmdline } from '../src/supervisor/watchdog.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createReconciler, isPidAlive } from '../src/supervisor/reconcile.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import { createReadopter } from '../src/supervisor/readopt.mjs';
import { resolveServiceToken } from '../src/supervisor/auth.mjs';

// =============================================================================
// apra-fleet-eft.4.6 -- supervisor lifecycle end-to-end test.
//
// Covers, against REAL OS processes wherever a real process is meaningful:
//   (a) the supervisor stays up across a sprint completing and exits ONLY on
//       POST /api/shutdown (a real `fleet-se serve` subprocess);
//   (b) a detached sprint child survives the supervisor being SIGKILLed (the
//       real createSpawner()'s detached-orphan contract, driven from a real
//       parent process so the SIGKILL is genuine);
//   (c) each of the four watchdog statuses is exercised against real children:
//       healthy (alive + HTTP answering), hung (alive + HTTP silent =>
//       running-unresponsive, NOT crashed), killed (SIGKILLed, no terminal
//       state => crashed), completed (exited after writing a terminal state
//       in old_sprints/ => finished);
//   (d) a restart re-adopts the live child by PID, recovering its --viewer-port
//       from the live process's own command line.
//
// The suite tracks every spawned PID and force-kills them all in an after()
// hook so no orphan survives even when a test fails mid-flight.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD_FIXTURE = path.join(__dirname, 'fixtures/lifecycle/child.mjs');
const SPAWNER_HARNESS = path.join(__dirname, 'fixtures/spawner/harness.mjs');
const SERVE_BIN = path.join(__dirname, '../bin/serve.mjs');
const SE_PKG_ROOT = path.join(__dirname, '..');

// apra-fleet-v6t7.8: the wait for the real `fleet-se serve` subprocess's
// /api/health to answer, previously a bare literal (15000ms) at the call
// site, gets the same treatment as GET_ROOT_TIMEOUT_MS in
// supervisor-guard-e2e.test.mjs (apra-fleet-v6t7.7): a single named,
// env-overridable constant with a comment stating why it is sized as it
// is, rather than an anonymous number that silently drifts. This wait
// covers the subprocess's full cold-start path (module load, supervisor
// wiring, ledger/history/reconcile bootstrap) before the listener is even
// up, so 15s already carries real headroom -- the one observed timeout
// (15050ms, barely over budget) happened in a full bounded-runner run
// alongside sibling suites and their own spawned subprocesses contending
// for the same CPU/IO; a standalone re-run of this exact file passed in
// 3954ms, over 3x faster than the budget. 15s is kept as the documented
// default rather than raised blind; the env override exists for a
// genuinely slower environment to prove its own number instead of every
// caller inheriting a bigger guess.
const SUPERVISOR_HEALTH_TIMEOUT_MS = (() => {
    const override = Number(process.env.APRA_TEST_SUPERVISOR_HEALTH_BUDGET_MS);
    return Number.isFinite(override) && override > 0 ? override : 15000;
})();

// -- global PID cleanup: every spawned pid is tracked and force-killed --------
/** @type {Set<number>} */
const spawnedPids = new Set();
/** @type {Set<string>} */
const tmpDirs = new Set();

function track(pid) {
    if (Number.isInteger(pid) && pid > 0) spawnedPids.add(pid);
    return pid;
}

function forceKill(pid) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
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

// -- small async helpers ------------------------------------------------------

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function mkTmp(prefix) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.add(dir);
    return dir;
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

/** Poll until `pred()` is truthy or the deadline passes; throws on timeout. */
async function waitFor(pred, { timeoutMs = 8000, intervalMs = 50, label = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const val = await pred();
        if (val) return val;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(intervalMs);
    }
}

/** Resolve once a pid is no longer alive (via the real signal-0 probe). */
function waitDead(pid, timeoutMs = 8000) {
    return waitFor(() => !isPidAlive(pid), { timeoutMs, label: `pid ${pid} to exit` });
}

const LISTENING_LOG_RE = /listening on http:\/\/localhost:\d+/;

/**
 * Wrap a supervisor health-wait timeout with a diagnostic that
 * distinguishes "the supervisor process never logged its listening line"
 * from "it bound but /api/health did not answer", using the
 * already-captured serve.mjs stdout, and appends the captured
 * stdout/stderr tail so a CI log is actionable without a re-run.
 * Exercised directly (see the "health-wait timeout diagnostic" test below)
 * against a real failed wait on a deliberately unbound port, rather than
 * only asserted against hand-built strings.
 */
function describeHealthWaitFailure(err, { stdoutBuf, stderrBuf }) {
    const bindState = LISTENING_LOG_RE.test(stdoutBuf)
        ? 'supervisor bound but /api/health did not answer'
        : 'supervisor never logged its listening line';
    const context = `${bindState}\n--- serve.mjs stdout so far ---\n${stdoutBuf}\n--- serve.mjs stderr so far ---\n${stderrBuf}`;
    if (err instanceof Error) {
        err.message = `${err.message}\n${context}`;
        return err;
    }
    return new Error(`${String(err)}\n${context}`);
}

/** Resolve once a child process object has emitted 'exit'. */
function onExit(child) {
    return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        child.once('exit', () => resolve());
    });
}

/**
 * Spawn a real lifecycle-child fixture in the given mode, capturing stdout so
 * the caller can await its READY/DONE line. The pid is tracked for cleanup.
 */
function spawnChild({ mode, viewerPort = 0, sprintId, dataDir }) {
    const args = [
        CHILD_FIXTURE,
        '--mode', mode,
        '--viewer-port', String(viewerPort),
        '--sprint-id', sprintId,
    ];
    const child = spawn(process.execPath, args, {
        env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    track(child.pid);
    return child;
}

/** Resolve with the first newline-terminated stdout line of a child. */
function firstLine(child) {
    return new Promise((resolve, reject) => {
        let buf = '';
        const onData = (chunk) => {
            buf += chunk.toString('utf-8');
            const idx = buf.indexOf('\n');
            if (idx !== -1) {
                child.stdout.off('data', onData);
                resolve(buf.slice(0, idx).trim());
            }
        };
        child.stdout.on('data', onData);
        child.once('error', reject);
        child.once('exit', () => {
            // A finished child may exit right after printing; flush what we have.
            const idx = buf.indexOf('\n');
            if (idx !== -1) resolve(buf.slice(0, idx).trim());
        });
    });
}

// -- minimal HTTP client against the supervisor -------------------------------

/**
 * apra-fleet-50j6.1.2: `serviceToken`, when provided, rides as a Bearer
 * Authorization header -- the whole `/api/` surface (including /api/health)
 * is guarded now, so every real-subprocess request in this suite needs it.
 */
function httpRequest(port, pathname, method = 'GET', serviceToken) {
    return new Promise((resolve, reject) => {
        const headers = serviceToken ? { authorization: `Bearer ${serviceToken}` } : {};
        const req = http.request(
            { host: '127.0.0.1', port, path: pathname, method, timeout: 3000, headers },
            (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => resolve({ status: res.statusCode, body }));
            },
        );
        req.on('timeout', () => { req.destroy(new Error('request timeout')); });
        req.on('error', reject);
        req.end();
    });
}

// -----------------------------------------------------------------------------
// (c) four statuses -- real children, real (default-probe) watchdog
// -----------------------------------------------------------------------------
describe('supervisor lifecycle -- watchdog four statuses over real children', () => {
    test('healthy / hung / killed / completed each classify to their exact status', async () => {
        const dataDir = await mkTmp('eft46-status-');

        // healthy: a real child listening on its --viewer-port and answering HTTP.
        const healthyPort = await getFreePort();
        const healthy = spawnChild({ mode: 'healthy', viewerPort: healthyPort, sprintId: 'healthy', dataDir });
        const healthyReady = await firstLine(healthy);
        assert.equal(healthyReady, `READY ${healthyPort}`, 'healthy child should bind its viewer port');

        // hung: a real child that stays alive but runs NO HTTP server.
        const hungPort = await getFreePort();
        const hung = spawnChild({ mode: 'alive', viewerPort: hungPort, sprintId: 'hung', dataDir });
        assert.equal(await firstLine(hung), 'READY 0');

        // killed: a real child, SIGKILLed with no terminal state persisted.
        const killedPort = await getFreePort();
        const killed = spawnChild({ mode: 'alive', viewerPort: killedPort, sprintId: 'killed', dataDir });
        assert.equal(await firstLine(killed), 'READY 0');
        const killedPid = killed.pid;
        process.kill(killedPid, 'SIGKILL');
        await waitDead(killedPid);

        // completed: a real child that writes a terminal state file then exits 0.
        const finishedPort = await getFreePort();
        const finished = spawnChild({ mode: 'finished', viewerPort: finishedPort, sprintId: 'finished', dataDir });
        const finishedPid = finished.pid;
        await onExit(finished);
        await waitDead(finishedPid);
        // The terminal state file must actually be present in old_sprints/.
        await assert.doesNotReject(fsp.access(path.join(dataDir, 'old_sprints', 'finished.json')));

        const ledger = {
            list: () => [
                { sprintId: 'healthy', childPid: healthy.pid },
                { sprintId: 'hung', childPid: hung.pid },
                { sprintId: 'killed', childPid: killedPid },
                { sprintId: 'finished', childPid: finishedPid },
            ],
        };
        const ports = { healthy: healthyPort, hung: hungPort };

        const watchdog = createWatchdog({
            ledger,
            env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir },
            resolvePort: (id) => ports[id],
            intervalMs: 200,
            logger: { log() {}, error() {} },
        });

        const results = await watchdog.classifyAll();
        const byId = Object.fromEntries(results.map((r) => [r.sprintId, r.status]));

        // Each scenario asserts its EXACT status string.
        assert.equal(byId.healthy, WATCHDOG_STATUS.RUNNING_HEALTHY);
        assert.equal(byId.hung, WATCHDOG_STATUS.RUNNING_UNRESPONSIVE);
        assert.equal(byId.killed, WATCHDOG_STATUS.CRASHED);
        assert.equal(byId.finished, WATCHDOG_STATUS.FINISHED);

        // The hung child is running-unresponsive -- explicitly NOT crashed.
        assert.notEqual(byId.hung, WATCHDOG_STATUS.CRASHED);
        const hungResult = results.find((r) => r.sprintId === 'hung');
        assert.equal(hungResult.pidAlive, true, 'a hung child is still alive');
        assert.equal(hungResult.httpOk, false, 'a hung child is not answering HTTP');

        // Cleanup the still-live children.
        forceKill(healthy.pid);
        forceKill(hung.pid);
    });
});

// -----------------------------------------------------------------------------
// (b) detach survival -- a detached child survives the supervisor's SIGKILL
// -----------------------------------------------------------------------------
describe('supervisor lifecycle -- detached child survives supervisor SIGKILL', () => {
    test('SIGKILLing the spawner (supervisor) process leaves the detached sprint child alive', async () => {
        const basePort = await getFreePort();
        // apra-fleet-ou7.1: harness.mjs's own createSpawner() now always opens a
        // real per-sprint log file -- point FLEET_SE_DATA_DIR at an isolated,
        // auto-cleaned-up (mkTmp/tmpDirs) temp dir.
        const dataDir = await mkTmp('eft46-detach-');
        // The harness plays "the supervisor": it uses the REAL createSpawner()
        // to launch a detached sprint child, prints its pid/port, then stays
        // alive so we can SIGKILL it out from under the child.
        const harness = spawn(process.execPath, [SPAWNER_HARNESS], {
            stdio: ['ignore', 'pipe', 'ignore'],
            env: { ...process.env, SPAWNER_TEST_BASE_PORT: String(basePort), SPAWNER_TEST_SPRINT_COUNT: '1', FLEET_SE_DATA_DIR: dataDir },
        });
        track(harness.pid);

        const line = await firstLine(harness);
        const [{ pid: childPid }] = JSON.parse(line);
        track(childPid);
        assert.ok(Number.isInteger(childPid), 'harness should report a numeric child pid');
        assert.equal(isPidAlive(childPid), true, 'child alive right after spawn');

        // Kill the supervisor hard.
        harness.kill('SIGKILL');
        await onExit(harness);
        await waitDead(harness.pid);

        // The detached child must outlive its parent's SIGKILL.
        await sleep(300);
        assert.equal(isPidAlive(childPid), true, 'detached child must survive supervisor SIGKILL');

        // Cleanup and sanity-check the cleanup itself worked.
        process.kill(childPid, 'SIGKILL');
        await waitDead(childPid);
        assert.equal(isPidAlive(childPid), false);
    });
});

// -----------------------------------------------------------------------------
// (d) restart re-adoption -- re-adopt a real live child by PID
// -----------------------------------------------------------------------------
describe('supervisor lifecycle -- restart re-adopts a live child by PID', () => {
    test('a persisted ledger entry for a live real child is re-adopted, port recovered from its command line', async () => {
        const dir = await mkTmp('eft46-readopt-');
        const viewerPort = await getFreePort();

        // A real, still-live sprint child carrying --viewer-port in its argv.
        const child = spawnChild({ mode: 'alive', viewerPort, sprintId: 'live', dataDir: dir });
        assert.equal(await firstLine(child), 'READY 0');
        assert.equal(isPidAlive(child.pid), true);

        // A prior supervisor persisted this child's reservation + pid to disk.
        const ledgerA = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-07-18T00:00:00.000Z' });
        await ledgerA.start();
        await ledgerA.claim('live', { members: ['alice'], issueRoots: ['root-live'], childPid: child.pid });

        // Simulate a restart: a brand-new ledger reloads purely from disk.
        const ledgerB = createLedger({ filePath: path.join(dir, LEDGER_FILENAME) });
        await ledgerB.start();
        const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME) });
        await history.start();

        const reconciler = createReconciler({ ledger: ledgerB, history, logger: { log() {} } });
        const spawner = createSpawner({ logger: { log() {}, error() {} } });
        const readopter = createReadopter({
            ledger: ledgerB,
            spawner,
            reconciler,
            // Per-platform read of the REAL process's command line (Linux /proc,
            // Windows WMIC/CIM, macOS `ps`); this recovers the genuine
            // --viewer-port it launched with on every supported platform.
            readCmdline: readProcessCmdline,
            logger: { log() {}, warn() {} },
        });

        const result = await readopter.readopt();

        assert.deepEqual(result.retained, ['live']);
        assert.deepEqual(result.released, []);
        assert.deepEqual(result.unresolved, []);
        assert.equal(result.adopted.length, 1);
        assert.deepEqual(result.adopted[0], { sprintId: 'live', childPid: child.pid, port: viewerPort });

        // The re-adopted real pid is now tracked by the spawner exactly like a
        // freshly-spawned child (its recovered port registered).
        // apra-fleet-ou7.1: adopt() sets logPath: null (not recovered from a
        // re-adopted child's command line; consumers read it from the
        // ledger's own persisted reservation instead).
        assert.deepEqual(spawner.getLiveEntry(child.pid), { port: viewerPort, child: null, logPath: null });
        assert.ok(spawner.livePorts.has(viewerPort));

        // The live reservation is untouched by the restart reconciliation.
        const stillLive = ledgerB.get('live');
        assert.deepEqual(stillLive.members, ['alice']);
        assert.deepEqual(stillLive.issueRoots, ['root-live']);

        forceKill(child.pid);
    });
});

// -----------------------------------------------------------------------------
// (a) real supervisor stays up across a sprint completing; exits only on shutdown
// -----------------------------------------------------------------------------
describe('supervisor lifecycle -- real `fleet-se serve` stays up, exits only on /api/shutdown', () => {
    test('a sprint completing on the box does not stop the supervisor; POST /api/shutdown does', async () => {
        const dataDir = await mkTmp('eft46-serve-data-');
        const seDataDir = await mkTmp('eft46-serve-se-');
        const port = await getFreePort();
        // apra-fleet-50j6.1.2 / apra-fleet-ky2l.1.2 (DQ-20): resolve the SAME
        // shared bearer service token the spawned subprocess will -- via the
        // SAME resolveServiceToken() seam, with NO `home` override (the
        // child's env below has no HOME override either, so both resolve
        // against the real os.homedir(), and thus the SAME fleet.key when
        // one exists -- see auth.mjs).
        const serviceToken = resolveServiceToken(seDataDir).token;

        const serve = spawn(process.execPath, [SERVE_BIN, '--port', String(port)], {
            cwd: SE_PKG_ROOT,
            // apra-fleet-v6t7.8: piped (not ignored) so a health-wait timeout
            // can carry the "never bound" vs "bound but silent" diagnostic
            // plus the stdout/stderr tail -- see describeHealthWaitFailure().
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir, FLEET_SE_DATA_DIR: seDataDir },
        });
        track(serve.pid);
        let stdoutBuf = '';
        let stderrBuf = '';
        serve.stdout.on('data', (c) => { stdoutBuf += c.toString('utf-8'); });
        serve.stderr.on('data', (c) => { stderrBuf += c.toString('utf-8'); });
        const serveExited = onExit(serve);

        // Wait for the supervisor to come up.
        try {
            await waitFor(async () => {
                try {
                    const res = await httpRequest(port, '/api/health', 'GET', serviceToken);
                    return res.status === 200;
                } catch {
                    return false;
                }
            }, { timeoutMs: SUPERVISOR_HEALTH_TIMEOUT_MS, label: 'supervisor /api/health' });
        } catch (err) {
            throw describeHealthWaitFailure(err, { stdoutBuf, stderrBuf });
        }

        // A sprint "completing" on the machine: a real short-lived child that
        // writes a terminal state and exits. The supervisor must not react.
        const finishedPort = await getFreePort();
        const finished = spawnChild({ mode: 'finished', viewerPort: finishedPort, sprintId: 'serve-sprint', dataDir });
        await onExit(finished);
        await waitDead(finished.pid);

        // Give the supervisor a beat, then confirm it is still up.
        await sleep(300);
        assert.equal(isPidAlive(serve.pid), true, 'supervisor must stay up after a sprint completes');
        const health = await httpRequest(port, '/api/health', 'GET', serviceToken);
        assert.equal(health.status, 200);

        // The ONLY in-band way to stop it.
        const shutdown = await httpRequest(port, '/api/shutdown', 'POST', serviceToken);
        assert.equal(shutdown.status, 200);

        // The serve process should exit cleanly (code 0) once shutdown completes.
        await Promise.race([
            serveExited,
            sleep(10000).then(() => { throw new Error('serve did not exit after /api/shutdown'); }),
        ]);
        assert.equal(serve.exitCode, 0, 'serve exits 0 on /api/shutdown');

        // And its port is no longer answering.
        await assert.rejects(httpRequest(port, '/api/health', 'GET', serviceToken));
    });
});

// -----------------------------------------------------------------------------
// health-wait timeout diagnostic (apra-fleet-v6t7.8)
// -----------------------------------------------------------------------------
describe('supervisor lifecycle -- health-wait timeout diagnostic', () => {
    // Proves describeHealthWaitFailure()'s two messages against a REAL
    // failed health wait (a deliberately unbound port -- nothing ever
    // listens on it), rather than only asserting against hand-built
    // strings, so the diagnostic text is demonstrated on an actual
    // connection failure instead of merely assumed correct.
    test('distinguishes "supervisor never logged its listening line" from "bound but /api/health did not answer"', async () => {
        const port = await getFreePort(); // closed immediately after allocation; nothing listens on it
        // apra-fleet-v6t7.9 / apra-fleet-v6t7.7: the unexpected-success
        // assertion MUST live outside this try/catch. An assert.fail()
        // thrown inside the try produces an AssertionError, which the catch
        // below would accept (it IS an Error) and stash into `caught` --
        // silently passing the very case (the "unbound" port actually
        // answering) this subtest exists to catch. `succeeded` is asserted
        // after the try/catch so an unexpected success genuinely reds the
        // test.
        let caught;
        let succeeded = false;
        try {
            await waitFor(async () => {
                try {
                    const res = await httpRequest(port, '/api/health', 'GET', 'irrelevant-token');
                    return res.status === 200;
                } catch {
                    return false;
                }
            }, { timeoutMs: 300, intervalMs: 50, label: 'unbound port /api/health' });
            succeeded = true;
        } catch (err) {
            caught = err;
        }
        assert.equal(succeeded, false, 'expected the wait against an unbound port to time out');
        assert.ok(caught instanceof Error, 'the wait against an unbound port must reject with an Error');

        // describeHealthWaitFailure() mutates err.message in place (matching
        // how it is actually used against the single shared serve.mjs error
        // above), so each invocation below gets its own fresh Error built
        // from the same real failure -- otherwise the second call's
        // diagnostic would stack onto the first's message.
        const neverBound = describeHealthWaitFailure(new Error(caught.message), { stdoutBuf: '', stderrBuf: '' });
        assert.match(
            neverBound.message,
            /supervisor never logged its listening line/,
            'stdout with no listening line must be diagnosed as "supervisor never logged its listening line"',
        );
        assert.doesNotMatch(neverBound.message, /supervisor bound but \/api\/health did not answer/);

        const boundButSilent = describeHealthWaitFailure(new Error(caught.message), {
            stdoutBuf: `[supervisor] listening on http://localhost:${port} (pid 12345)\n`,
            stderrBuf: '',
        });
        assert.match(
            boundButSilent.message,
            /supervisor bound but \/api\/health did not answer/,
            'stdout containing the listening line must be diagnosed as "supervisor bound but /api/health did not answer"',
        );
        assert.doesNotMatch(boundButSilent.message, /supervisor never logged its listening line/);
    });
});
