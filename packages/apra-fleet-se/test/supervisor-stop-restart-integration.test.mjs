import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSpawner } from '../src/supervisor/spawner.mjs';
import { createReconciler, registerReservationRoutes, isPidAlive, killPid } from '../src/supervisor/reconcile.mjs';
import { createSprintController, registerSprintRoutes } from '../src/supervisor/api.mjs';
import { formatStopError } from '../src/supervisor/dashboard.mjs';
import { formatLaunchError } from '../src/supervisor/launch-form.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';

// =============================================================================
// apra-fleet-3i3.4 -- Sprint Stack Stop/Restart, end to end against a REAL
// supervisor HTTP surface.
//
// apra-fleet-3i3.1/3i3.2/3i3.3 already have solid unit coverage of their own
// individual seams (reconcile.mjs's forceRelease()+killPid injection,
// ledger.mjs's branch/base/goal persistence, dashboard.mjs's embedded
// SPRINT_STOP_SCRIPT/SPRINT_RESTART_SCRIPT text). What none of them exercise
// is the WHOLE wired-together flow a real operator click drives: a genuine
// spawned child process, a real supervisor HTTP server, the real killPid
// signal delivery, and (for Restart) the exact two-network-call sequence
// SPRINT_RESTART_SCRIPT performs (force-release -> reuse ITS OWN response to
// reconstruct the relaunch body -> POST /api/sprints), with NO separate
// manual Stop first.
//
// Follows supervisor-dashboard-integration.test.mjs's harness pattern: the
// REAL createSpawner()/createSprintController()/createReconciler() production
// code path, launching the lightweight viewer-child.mjs fixture (a genuine
// detached OS process) via the real createSupervisor() HTTP server -- no
// fleet/beads/git machinery, no mocked HTTP layer.
//
// Three cases:
//   1. Stop: force-release kills the real child (pid genuinely not alive
//      afterward) AND releases the reservation (GET /api/members ->
//      reserved:false) in ONE action; the response shape is exactly what
//      SPRINT_STOP_SCRIPT's `r.status === 200` success branch keys off.
//   2. Stop error surfacing: force-release against an unknown sprintId 404s,
//      and formatStopError() (the SAME function embedded verbatim in the
//      client script) renders a legible, non-blank message from that REAL
//      response -- never a silent no-op.
//   3. Restart: replays SPRINT_RESTART_SCRIPT's exact two-call sequence
//      against the real server -- old reservation released (old child
//      genuinely killed, no prior manual Stop), branch/base/goal/members/
//      issueRoots recovered from the force-release response alone (no
//      operator prompt needed), then relaunched as a NEW sprint id claiming
//      the SAME scope; a deliberately-forced relaunch conflict (a second
//      sprint grabs the just-freed member before the relaunch call lands)
//      surfaces via formatLaunchError() exactly as the client script does.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_FIXTURE = path.join(__dirname, 'fixtures/dashboard/viewer-child.mjs');

const silentLogger = { log() {}, error() {} };

/** @type {Set<number>} tracked regardless of pass/fail, force-killed in after() */
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

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function mkTmp(prefix) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.add(dir);
    return dir;
}

/** Poll until `pred()` is truthy or the deadline passes; throws on timeout. */
async function waitFor(pred, { timeoutMs = 10000, intervalMs = 50, label = 'condition' } = {}) {
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

function httpGet(port, urlPath, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const req = http.request({ host, port, path: urlPath, method: 'GET' }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, json: body.length ? JSON.parse(body) : null }));
        });
        req.on('error', reject);
        req.end();
    });
}

/** POST a JSON body against a given host:port, resolving `{ status, json }` -- mirrors what SPRINT_STOP_SCRIPT/SPRINT_RESTART_SCRIPT's own fetch().then(res => res.json()) chain resolves to. */
function httpPostJson(port, urlPath, payload, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify(payload ?? {}), 'utf-8');
        const req = http.request({
            host, port, path: urlPath, method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': body.length },
        }, (res) => {
            let raw = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { raw += c; });
            res.on('end', () => {
                let json = null;
                try { json = raw.length ? JSON.parse(raw) : null; } catch { json = null; }
                resolve({ status: res.statusCode, json });
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

/** Waits for a just-spawned viewer-child fixture to actually be answering. */
async function waitForChildUp(childPort) {
    await waitFor(async () => {
        try {
            const r = await httpGet(childPort, '/state');
            return r.status === 200;
        } catch {
            return false;
        }
    }, { label: 'viewer-child /state to answer' });
}

/** Finds a named member's row in a GET /api/members response body. */
function findMember(membersJson, name) {
    return (membersJson.members || []).find((m) => m.name === name);
}

describe('Sprint Stack Stop/Restart (apra-fleet-3i3.4) -- end to end against a real supervisor', () => {
    let dataDir;
    let ledger;
    let history;
    let spawner;
    let reconciler;
    let sprintController;
    let supervisor;
    let port;

    before(async () => {
        dataDir = await mkTmp('3i3-stop-restart-');

        ledger = createLedger({ filePath: path.join(dataDir, LEDGER_FILENAME) });
        await ledger.start();
        history = createHistory({ filePath: path.join(dataDir, HISTORY_FILENAME) });
        await history.start();

        // The REAL spawner, launching the lightweight viewer-child.mjs fixture
        // (a genuine detached OS process) in place of bin/cli.mjs.
        spawner = createSpawner({
            command: process.execPath,
            cliPath: VIEWER_FIXTURE,
            env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir },
            logger: silentLogger,
        });

        // apra-fleet-3i3.1: the REAL killPid export (process.kill(pid,
        // 'SIGKILL'), guarded) -- not the safe no-op default -- so Stop/
        // Restart's "kills the real child" behavior is genuinely exercised,
        // exactly as bin/serve.mjs's production wiring injects it.
        reconciler = createReconciler({ ledger, history, killPid, logger: silentLogger });

        sprintController = createSprintController({
            ledger,
            spawner,
            history,
            listMembers: () => ({ members: [{ name: 'alice' }, { name: 'bob' }, { name: 'dave' }] }),
        });

        supervisor = createSupervisor({ port: 0, ledger, spawner, logger: silentLogger });
        registerSprintRoutes(supervisor, sprintController);
        registerReservationRoutes(supervisor, reconciler);

        await supervisor.start();
        port = supervisor.server.address().port;
    });

    after(async () => {
        await supervisor.stop('test');
    });

    // -------------------------------------------------------------------------
    // (1) Stop: kill + release in one action; success surfaces as the
    // SPRINT_STOP_SCRIPT `r.status === 200` branch.
    // -------------------------------------------------------------------------
    test('(1) Stop: force-release kills the real child AND releases the reservation (member reserved:false) in one action', async () => {
        const launchRes = await httpPostJson(port, '/api/sprints', {
            issue: 'stop-target', members: ['alice'], branch: 'feat/3i3-stop', base: 'main',
        });
        assert.equal(launchRes.status, 201, JSON.stringify(launchRes.json));
        const sprintId = launchRes.json.sprintId;
        const pid = track(launchRes.json.pid);
        const childPort = launchRes.json.port;
        await waitForChildUp(childPort);

        // The member is genuinely reserved while the sprint is live.
        const beforeMembers = await httpGet(port, '/api/members');
        const aliceBefore = findMember(beforeMembers.json, 'alice');
        assert.equal(aliceBefore.reserved, true);
        assert.equal(aliceBefore.reservedBy, sprintId);
        assert.ok(isPidAlive(pid), 'sanity: the freshly-launched child must genuinely be alive');

        // Click Stop: POST /api/reservations/:sprintId/force-release, exactly
        // as SPRINT_STOP_SCRIPT does.
        const stopRes = await httpPostJson(port, `/api/reservations/${encodeURIComponent(sprintId)}/force-release`, {
            reason: 'stopped via Sprint Stack Stop button',
        });
        // This is precisely the condition SPRINT_STOP_SCRIPT branches on for
        // its success path (resultEl.textContent = 'Stopped.'; section.remove()).
        assert.equal(stopRes.status, 200, JSON.stringify(stopRes.json));
        assert.equal(stopRes.json.status, 'force-released');
        assert.equal(stopRes.json.sprintId, sprintId);
        assert.equal(stopRes.json.audit.childPid, pid);
        assert.equal(stopRes.json.audit.killed, true, 'the force-release must report the real kill signal as delivered');

        // The real OS process is genuinely gone (not merely reported as such).
        await waitFor(() => !isPidAlive(pid), { label: 'stopped child pid to exit' });

        // ...AND the reservation is released in the SAME action -- no
        // separate release step was needed.
        const afterMembers = await httpGet(port, '/api/members');
        const aliceAfter = findMember(afterMembers.json, 'alice');
        assert.equal(aliceAfter.reserved, false);
        assert.equal(aliceAfter.reservedBy, null);
    });

    // -------------------------------------------------------------------------
    // (2) Stop error surfacing: an unknown/already-gone sprintId 404s, and
    // formatStopError() -- the SAME function embedded verbatim in the client
    // script -- renders a legible message from the REAL response.
    // -------------------------------------------------------------------------
    test('(2) Stop error surfacing: force-release on an unknown sprintId 404s, and formatStopError() renders a legible message (never a silent no-op)', async () => {
        const res = await httpPostJson(port, '/api/reservations/definitely-not-a-live-sprint/force-release', {
            reason: 'stopped via Sprint Stack Stop button',
        });
        assert.equal(res.status, 404, JSON.stringify(res.json));
        assert.ok(typeof res.json.error === 'string' && res.json.error.length > 0);

        const message = formatStopError(res.status, res.json);
        assert.ok(message.length > 0, 'the surfaced message must never be blank');
        assert.ok(message.startsWith('Already gone: '), `expected the 404-specific prefix, got: ${message}`);
        assert.ok(message.includes(res.json.error), 'the real server error text must flow through into the surfaced message');
    });

    // -------------------------------------------------------------------------
    // (3) Restart: releases the old reservation (killing its child, no prior
    // manual Stop) and relaunches the SAME scope as a NEW sprint, replaying
    // SPRINT_RESTART_SCRIPT's exact two-call sequence.
    // -------------------------------------------------------------------------
    test('(3) Restart: releases + kills the old sprint (no manual Stop first) and relaunches the identical scope as a new sprint id, recovered entirely from the force-release response', async () => {
        const launchRes = await httpPostJson(port, '/api/sprints', {
            issue: 'restart-target', members: ['bob'], branch: 'feat/3i3-restart', base: 'main', goal: 'P1',
        });
        assert.equal(launchRes.status, 201, JSON.stringify(launchRes.json));
        const oldSprintId = launchRes.json.sprintId;
        const oldPid = track(launchRes.json.pid);
        const oldChildPort = launchRes.json.port;
        await waitForChildUp(oldChildPort);

        // -- Step 1 (SPRINT_RESTART_SCRIPT): the SAME force-release route Stop
        // uses -- no separate manual Stop call precedes this.
        const releaseRes = await httpPostJson(port, `/api/reservations/${encodeURIComponent(oldSprintId)}/force-release`, {
            reason: 'restarted via Sprint Stack Restart button',
        });
        assert.equal(releaseRes.status, 200, JSON.stringify(releaseRes.json));
        const audit = releaseRes.json.audit;

        // The old child is genuinely killed as part of THIS SAME action.
        await waitFor(() => !isPidAlive(oldPid), { label: 'restarted-away child pid to exit' });

        // -- Step 2: reconstruct the relaunch body straight off the
        // force-release response (no second network round-trip, no operator
        // prompt needed -- branch/base/goal were all recoverable).
        const issueRoots = Array.isArray(audit.issueRoots) ? audit.issueRoots : [];
        const members = Array.isArray(audit.members) ? audit.members : [];
        assert.deepEqual(issueRoots, ['restart-target']);
        assert.deepEqual(members, ['bob']);
        assert.equal(audit.branch, 'feat/3i3-restart');
        assert.equal(audit.base, 'main');
        assert.equal(audit.goal, 'P1');

        const relaunchBody = { issue: issueRoots[0], members, branch: audit.branch, base: audit.base, goal: audit.goal };
        const relaunchRes = await httpPostJson(port, '/api/sprints', relaunchBody);
        assert.equal(relaunchRes.status, 201, JSON.stringify(relaunchRes.json));
        const newSprintId = relaunchRes.json.sprintId;
        const newPid = track(relaunchRes.json.pid);
        const newChildPort = relaunchRes.json.port;

        assert.notEqual(newSprintId, oldSprintId, 'a genuinely NEW sprint id, not a resurrection of the old one');
        assert.deepEqual(relaunchRes.json.issueRoots, ['restart-target']);
        assert.deepEqual(relaunchRes.json.members, ['bob']);

        // The new child is genuinely alive -- a real relaunch, not just a
        // ledger bookkeeping update.
        await waitForChildUp(newChildPort);
        assert.ok(isPidAlive(newPid));

        // The scope is now claimed under the NEW sprint id.
        const membersRes = await httpGet(port, '/api/members');
        const bob = findMember(membersRes.json, 'bob');
        assert.equal(bob.reserved, true);
        assert.equal(bob.reservedBy, newSprintId);
    });

    // -------------------------------------------------------------------------
    // (4) Restart error surfacing: the old reservation is released
    // irreversibly by step 1, but a relaunch conflict at step 2 (another
    // sprint grabs the just-freed member first) still surfaces via
    // formatLaunchError() -- the SAME function SPRINT_RESTART_SCRIPT calls --
    // never a silent no-op.
    // -------------------------------------------------------------------------
    test('(4) Restart error surfacing: a relaunch conflict at step 2 surfaces via formatLaunchError(), matching SPRINT_RESTART_SCRIPT\'s own error path', async () => {
        const launchRes = await httpPostJson(port, '/api/sprints', {
            issue: 'restart-conflict-target', members: ['dave'], branch: 'feat/3i3-restart-conflict', base: 'main',
        });
        assert.equal(launchRes.status, 201, JSON.stringify(launchRes.json));
        const oldSprintId = launchRes.json.sprintId;
        const oldPid = track(launchRes.json.pid);
        await waitForChildUp(launchRes.json.port);

        const releaseRes = await httpPostJson(port, `/api/reservations/${encodeURIComponent(oldSprintId)}/force-release`, {
            reason: 'restarted via Sprint Stack Restart button',
        });
        assert.equal(releaseRes.status, 200, JSON.stringify(releaseRes.json));
        await waitFor(() => !isPidAlive(oldPid), { label: 'restarted-away child pid to exit' });

        // Simulate a race: some OTHER launch grabs 'dave' in the window
        // between the release above and the relaunch call below.
        const interloperRes = await httpPostJson(port, '/api/sprints', {
            issue: 'interloper', members: ['dave'], branch: 'feat/interloper', base: 'main',
        });
        assert.equal(interloperRes.status, 201, JSON.stringify(interloperRes.json));
        track(interloperRes.json.pid);
        await waitForChildUp(interloperRes.json.port);

        // Step 2 of the restart now conflicts (409): 'dave' is claimed by the
        // interloper sprint.
        const audit = releaseRes.json.audit;
        const relaunchRes = await httpPostJson(port, '/api/sprints', {
            issue: audit.issueRoots[0], members: audit.members, branch: audit.branch, base: audit.base,
        });
        assert.equal(relaunchRes.status, 409, JSON.stringify(relaunchRes.json));

        const message = formatLaunchError(relaunchRes.status, relaunchRes.json);
        assert.ok(message.length > 0, 'the surfaced message must never be blank');
        assert.ok(message.startsWith('Conflict: '), `expected the 409-specific prefix, got: ${message}`);
        assert.ok(message.includes('dave'), `expected the conflicting member named in the message, got: ${message}`);

        // The old reservation is gone regardless -- Restart's release step
        // is irreversible even when the relaunch step fails (matches
        // SPRINT_RESTART_SCRIPT's own "Reservation released, but relaunch
        // failed: ..." framing, never silently re-claimed).
        const membersRes = await httpGet(port, '/api/members');
        const daveEntry = findMember(membersRes.json, 'dave');
        assert.equal(daveEntry.reservedBy, interloperRes.json.sprintId, 'dave now belongs to the interloper, never resurrected under the old sprint');
    });
});
