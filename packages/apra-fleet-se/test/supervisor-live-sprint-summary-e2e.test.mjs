import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

import { createDashboardViewer } from '@apralabs/apra-fleet-workflow/viewer';
import { beadsExtension, kbCodeIntelExtension, decisionsExtension } from '../fleet-sprint/viewer-extensions.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { createSprintController, registerSprintRoutes } from '../src/supervisor/api.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { SPRINT_SUMMARY_FIELDS } from '../src/supervisor/sprint-summary.mjs';

// End to end: a REAL child viewer (createDashboardViewer with the fleet-sprint
// dashboard extensions the CLI wires) driven through phase transitions, and a
// REAL supervisor (createSupervisor on an ephemeral port + createSprintController
// over a real ledger) pointed at it through resolvePort. The ledger claim
// carries branch/base/maxCycles. GET /api/sprints/:id and GET /api/sprints are
// read over HTTP.

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const SPRINT_ID = 'sup-live-1';
const CHILD_PID = 31337;
// A label long enough (and repeated) for the child's lean /state to dedupe it.
const LONG_LABEL = 'dispatch doer on the shared member for bead summary work';

function getJson(port, urlPath) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                try { resolve({ status: res.statusCode, json: JSON.parse(text) }); } catch (err) { reject(new Error(`${urlPath}: ${err.message}: ${text.slice(0, 200)}`)); }
            });
        }).on('error', reject);
    });
}

/** Deep scan for lean `{ $ref }` markers and `_strings` keys. */
function findLeanMarkers(value, at = '$') {
    const hits = [];
    if (Array.isArray(value)) value.forEach((v, i) => hits.push(...findLeanMarkers(v, `${at}[${i}]`)));
    else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            if (k === '_strings' || k === '$ref') hits.push(`${at}.${k}`);
            hits.push(...findLeanMarkers(v, `${at}.${k}`));
        }
    }
    return hits;
}

describe('live mock sprint status over the supervisor API', () => {
    let tmpDir; let wf; let viewer; let childPort; let supervisor; let port;

    before(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-sprint-summary-'));
        wf = new EventEmitter();
        wf.requestStop = () => {};
        wf.requestPause = () => {};
        viewer = createDashboardViewer(wf, {
            port: 0, runId: SPRINT_ID, name: 'Fleet-Sprint',
            dashboardExtensions: [beadsExtension, kbCodeIntelExtension, decisionsExtension],
            debouncedStatePath: path.join(tmpDir, 'running.json'), debounceMs: 200, stateSnapshotDir: path.join(tmpDir, 'snaps'),
        });
        if (!viewer.listening) await new Promise((r, j) => { viewer.once('listening', r); viewer.once('error', j); });
        childPort = viewer.address().port;

        // A few phase transitions, ending in Develop C1 R2, with repeated
        // activity labels so the child's lean /state carries a string table.
        wf.emit('phase', 'Ensure Sprint Branch');
        wf.emit('phase', 'Plan C1 R1');
        wf.emit('phase', 'Develop C1 R1');
        wf.emit('activity:start', { id: 'a1', label: LONG_LABEL, type: 'agent' });
        wf.emit('activity:end', { id: 'a1', label: LONG_LABEL, type: 'agent', success: true });
        wf.emit('phase', 'Review C1 R1');
        wf.emit('phase', 'Develop C1 R2');
        wf.emit('activity:start', { id: 'a2', label: LONG_LABEL, type: 'agent' });

        const ledger = createLedger({ filePath: path.join(tmpDir, LEDGER_FILENAME) });
        await ledger.start();
        const history = createHistory({ filePath: path.join(tmpDir, HISTORY_FILENAME) });
        await history.start();
        await ledger.claim(SPRINT_ID, {
            members: ['alice'], issueRoots: ['R1'], childPid: CHILD_PID,
            branch: 'feat/live-summary', base: 'main', maxCycles: 4,
        });
        const controller = createSprintController({
            ledger, history,
            spawner: { spawnSprint: async () => { throw new Error('no spawn in this test'); } },
            listMembers: () => ({ members: [] }), getBacklog: () => ({}),
            hasTerminalState: () => null,
            resolvePort: (pid) => (pid === CHILD_PID ? childPort : undefined),
            getBuildVersion: () => null,
        });
        supervisor = createSupervisor({ port: 0, host: '127.0.0.1', logger: { log() {}, error() {} } });
        registerSprintRoutes(supervisor, controller);
        await supervisor.start();
        port = supervisor.port;
    });

    after(async () => {
        if (supervisor) await supervisor.stop();
        if (viewer) await new Promise((resolve) => viewer.close(resolve));
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('reports cycle 1, round 2, the phase title, maxCycles, ISO startedAt, growing elapsedMs and the ledger PR branches', async () => {
        const first = await getJson(port, `/api/sprints/${SPRINT_ID}`);
        assert.equal(first.status, 200, JSON.stringify(first.json));
        const s = first.json;
        for (const f of SPRINT_SUMMARY_FIELDS) assert.ok(f in s, `missing ${f}`);
        assert.equal(s.live, true);
        assert.equal(s.status, 'running');
        assert.equal(s.phase, 'Develop C1 R2');
        assert.equal(s.phaseKind, 'develop');
        assert.equal(s.cycle, 1);
        assert.equal(s.round, 2);
        assert.equal(s.maxCycles, 4);
        assert.equal(typeof s.startedAt, 'string');
        assert.equal(new Date(s.startedAt).toISOString(), s.startedAt);
        assert.ok(s.elapsedMs > 0, `elapsedMs ${s.elapsedMs}`);
        assert.equal(s.prSourceBranch, 'feat/live-summary');
        assert.equal(s.prTargetBranch, 'main');

        await new Promise((r) => setTimeout(r, 25));
        const second = await getJson(port, `/api/sprints/${SPRINT_ID}`);
        assert.ok(second.json.elapsedMs > s.elapsedMs, `elapsedMs did not grow: ${s.elapsedMs} -> ${second.json.elapsedMs}`);
    });

    test('the default JSON has no ref marker and no _strings; GET /api/sprints rows agree', async () => {
        // Precondition: the child's own /state really is lean-encoded, so a
        // raw proxy of it would leak markers.
        const raw = await getJson(childPort, '/state');
        assert.ok(Array.isArray(raw.json._strings) && raw.json._strings.length > 0, 'child /state carries a string table');

        const one = await getJson(port, `/api/sprints/${SPRINT_ID}`);
        assert.deepEqual(findLeanMarkers(one.json), []);
        // `state` stays in the default response, resolved to usable values.
        assert.equal(typeof one.json.state.startedAt, 'string');
        assert.equal(one.json.state.startedAt, one.json.startedAt);

        const list = await getJson(port, '/api/sprints');
        assert.equal(list.status, 200);
        assert.deepEqual(findLeanMarkers(list.json), []);
        const row = list.json.sprints.find((r) => r.sprintId === SPRINT_ID);
        assert.ok(row);
        assert.equal(row.cycle, 1);
        assert.equal(row.round, 2);
        assert.equal(row.phase, 'Develop C1 R2');
        assert.equal(row.maxCycles, 4);
        assert.equal(row.prSourceBranch, 'feat/live-summary');
        assert.equal(row.prTargetBranch, 'main');
    });

    test('?full=1 returns the resolved tree (plain startedAt string, no ref markers)', async () => {
        const full = await getJson(port, `/api/sprints/${SPRINT_ID}?full=1`);
        assert.equal(full.status, 200);
        assert.deepEqual(findLeanMarkers(full.json), []);
        assert.equal(typeof full.json.state.startedAt, 'string');
        assert.equal(full.json.state.startedAt, full.json.startedAt);
        const titles = full.json.state.tree.flatMap((g) => g.phases.map((p) => p.title));
        assert.ok(titles.includes('Develop C1 R2'), titles.join(', '));
        const labels = full.json.state.tree.flatMap((g) => g.phases.flatMap((p) => p.events.map((e) => e.data && e.data.label)));
        assert.ok(labels.filter((l) => l === LONG_LABEL).length >= 2, 'repeated labels come back as plain strings');
    });

    test('every documented summary field is named in supervisor-api.md and supervisor-openapi.yaml', () => {
        const md = fs.readFileSync(path.join(DOCS, 'supervisor-api.md'), 'utf8');
        const yaml = fs.readFileSync(path.join(DOCS, 'supervisor-openapi.yaml'), 'utf8');
        const section = md.slice(md.indexOf('## GET /api/sprints/:id: the summary shape'));
        const schema = yaml.slice(yaml.indexOf('    SprintSummary:'));
        for (const f of SPRINT_SUMMARY_FIELDS) {
            assert.ok(section.includes(`| \`${f}\` |`), `supervisor-api.md table lacks ${f}`);
            assert.ok(new RegExp(`\\n {8}${f}:`).test(schema), `supervisor-openapi.yaml SprintSummary lacks ${f}`);
        }
    });
});
