import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSupervisor } from '../src/supervisor/server.mjs';
import { createSprintController, registerSprintRoutes } from '../src/supervisor/api.mjs';
import { createReconciler, registerReservationRoutes } from '../src/supervisor/reconcile.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';

// Scenario test over the REAL supervisor HTTP routes (createSupervisor on an
// ephemeral port, createSprintController + createReconciler over a real
// ledger and history). Only the fleet server's member list is faked: a
// mutable list whose release is conditional on the holder, as the fleet
// server's member_reservation "release" is.
//
//   (1) a member reserved server-side by a dead sprint in the older
//       branch-name form, absent from the ledger and from /api/sprints: the
//       launch gets 409 naming the holder and the recovery; following the
//       recovery then lets the launch succeed.
//   (2) POST /api/reservations/<branch-name-id>/force-release -> 200 and the
//       member is no longer reserved.
//   (3) a member held by a live ledger sprint: untouched, launch 409 names it.
//   (4) a member held server-side by a holder the rule cannot prove dead
//       (stands in for a sprint launched directly from the CLI): untouched,
//       launch 409 names it.

function request(port, method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const headers = { 'content-type': 'application/json' };
        if (data) headers['content-length'] = data.length;
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch { /* not json */ }
                resolve({ status: res.statusCode, json, text });
            });
        });
        req.on('error', reject);
        req.end(data);
    });
}

describe('stale member reservations over the supervisor HTTP API', () => {
    let dir; let supervisor; let port; let ledger;
    const spawned = [];
    // The fake fleet server's member list (mutable, shared with assertions).
    const fleet = [
        { name: 'm-dead', reservedBy: 'feat/old-branch' },
        { name: 'm-live', reservedBy: null },
        { name: 'm-cli', reservedBy: 'direct-cli-sprint-7' },
        { name: 'm-free', reservedBy: null },
    ];
    const releaseCalls = [];
    const listMembers = () => ({ members: fleet.map((m) => ({ ...m })) });
    const releaseMemberReservation = async ({ member, holder }) => {
        releaseCalls.push({ member, holder });
        const m = fleet.find((x) => x.name === member);
        if (!m || m.reservedBy !== holder) return { ok: false, error: `not held by ${holder}` };
        m.reservedBy = null;
        return { ok: true, outcome: 'released' };
    };
    const reservedBy = (name) => fleet.find((m) => m.name === name).reservedBy;
    let seq = 0;
    const launchBody = (issue, members) => ({ issue, members, branch: `feat/${issue.toLowerCase()}`, base: 'main' });

    before(async () => {
        dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stale-res-http-'));
        ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-11-25T00:00:00.000Z' });
        await ledger.start();
        const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => '2026-11-25T00:00:00.000Z' });
        await history.start();
        const controller = createSprintController({
            ledger, history,
            spawner: { spawnSprint: async (o) => { spawned.push(o); return { pid: 6000 + spawned.length, port: 9400 + spawned.length }; } },
            listMembers, releaseMemberReservation,
            getBacklog: () => ({}),
            resolveRoleMap: async (raw) => (raw ? JSON.parse(raw) : undefined),
            generateSprintId: () => `sup-${seq++}`,
            hasTerminalState: () => null,
            resolvePort: () => undefined,
            getBuildVersion: () => null,
        });
        const quiet = { log() {}, warn() {}, error() {} };
        const reconciler = createReconciler({ ledger, history, listMembers, releaseMemberReservation, logger: quiet });
        supervisor = createSupervisor({ port: 0, host: '127.0.0.1', logger: quiet });
        registerSprintRoutes(supervisor, controller);
        registerReservationRoutes(supervisor, reconciler);
        await supervisor.start();
        port = supervisor.port;
    });

    after(async () => {
        if (supervisor) await supervisor.stop();
        if (dir) await fsp.rm(dir, { recursive: true, force: true });
    });

    test('(1) a branch-name holder absent from the ledger: 409 names holder + recovery; the recovery then lets the launch succeed', async () => {
        const listed = await request(port, 'GET', '/api/sprints');
        assert.equal(listed.status, 200);
        assert.deepEqual(listed.json.sprints, []);

        const refused = await request(port, 'POST', '/api/sprints', launchBody('R1', ['m-dead']));
        assert.equal(refused.status, 409, refused.text);
        assert.equal(refused.json.field, 'members');
        assert.match(refused.json.error, /'feat\/old-branch'/);
        assert.ok(refused.json.error.includes('POST /api/reservations/feat%2Fold-branch/force-release'), refused.json.error);
        assert.ok(refused.json.error.includes('member_reservation {"member_name":"m-dead","action":"force_release"}'), refused.json.error);
        assert.equal(reservedBy('m-dead'), 'feat/old-branch');
        assert.equal(spawned.length, 0);

        // Follow the named recovery, then relaunch.
        const released = await request(port, 'POST', '/api/reservations/feat%2Fold-branch/force-release', {});
        assert.equal(released.status, 200, released.text);
        const ok = await request(port, 'POST', '/api/sprints', launchBody('R1', ['m-dead']));
        assert.equal(ok.status, 201, ok.text);
        assert.equal(spawned.length, 1);
    });

    test('(2) force-release of a fleet-server-only branch-name holder: 200 and the member is no longer reserved', async () => {
        fleet.find((m) => m.name === 'm-free').reservedBy = 'feat/another-old-branch';
        const res = await request(port, 'POST', '/api/reservations/feat%2Fanother-old-branch/force-release', { by: 'op' });
        assert.equal(res.status, 200, res.text);
        assert.equal(res.json.status, 'force-released');
        assert.equal(res.json.sprintId, 'feat/another-old-branch');
        assert.equal(res.json.audit.serverOnly, true);
        assert.deepEqual(res.json.audit.releasedMembers, ['m-free']);
        assert.equal(reservedBy('m-free'), null);

        const ghost = await request(port, 'POST', '/api/reservations/held-nowhere/force-release', {});
        assert.equal(ghost.status, 404, ghost.text);
    });

    test('(3) a member held by a live ledger sprint is untouched and the launch gets 409 naming it', async () => {
        const first = await request(port, 'POST', '/api/sprints', launchBody('R3', ['m-live']));
        assert.equal(first.status, 201, first.text);
        const holder = first.json.sprintId;
        fleet.find((m) => m.name === 'm-live').reservedBy = holder;
        const callsBefore = releaseCalls.length;

        const refused = await request(port, 'POST', '/api/sprints', launchBody('R4', ['m-live']));
        assert.equal(refused.status, 409, refused.text);
        assert.equal(refused.json.error, `member overlap rejects launch: sprint '${holder}' already claims [m-live]`);
        assert.equal(reservedBy('m-live'), holder);
        assert.ok(ledger.get(holder));
        assert.equal(releaseCalls.length, callsBefore);
    });

    test('(4) a server-side holder the rule cannot prove dead (direct CLI sprint) is untouched and named in the 409', async () => {
        const callsBefore = releaseCalls.length;
        const refused = await request(port, 'POST', '/api/sprints', launchBody('R5', ['m-cli']));
        assert.equal(refused.status, 409, refused.text);
        assert.match(refused.json.error, /'direct-cli-sprint-7'/);
        assert.match(refused.json.error, /force-release/);
        assert.equal(reservedBy('m-cli'), 'direct-cli-sprint-7');
        assert.equal(releaseCalls.length, callsBefore);
    });
});
