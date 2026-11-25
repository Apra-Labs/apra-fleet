import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { createSprintController, registerSprintRoutes } from '../src/supervisor/api.mjs';
import { SPRINT_SUMMARY_FIELDS, parsePhaseTitle } from '../src/supervisor/sprint-summary.mjs';

// GET /api/sprints/:id and GET /api/sprints carry a stable, documented
// top-level summary; the default response has no lean ref marker or string
// table; ?full=1 returns the child's state tree resolved.

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');

const dirs = [];
after(async () => { await Promise.all(dirs.map((d) => fsp.rm(d, { recursive: true, force: true }))); });

function mockReq(method, url) {
    return { method, url, headers: {}, on(ev, cb) { if (ev === 'end') cb(); return this; } };
}
function mockRes() {
    return {
        statusCode: undefined, body: undefined, headersSent: false,
        writeHead(status) { this.statusCode = status; this.headersSent = true; },
        end(body) { this.body = body; },
    };
}

/** Deep scan: every `{ $ref }` marker object and every `_strings` key, with its path. */
function findLeanMarkers(value, at = '$') {
    const hits = [];
    if (Array.isArray(value)) value.forEach((v, i) => hits.push(...findLeanMarkers(v, `${at}[${i}]`)));
    else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            if (k === '_strings') hits.push(`${at}._strings`);
            if (k === '$ref') hits.push(`${at}.$ref`);
            hits.push(...findLeanMarkers(v, `${at}.${k}`));
        }
    }
    return hits;
}

// A live mock sprint: the child's summary (never leaned) and its leaned /state
// payload, exactly the two shapes the child viewer serves.
const STARTED_AT = '2026-11-25T10:00:00.000Z';
const CHILD_SUMMARY = {
    summaryVersion: 1, runId: 'sup-1', status: 'running', startedAt: STARTED_AT, elapsedMs: 4200, durationMs: 4200,
    phase: 'Develop C1 R2', terminalReason: null, updatedAt: STARTED_AT, endedAt: null,
    pause: { status: 'none', reason: null, since: null, phase: null, group: null, resumeAt: null },
    stats: { totalCost: 0.75, totalTokens: 1234 },
    extensions: { decisions: { publishedAt: STARTED_AT, state: 'running', pending: [] } },
};
const LONG = 'a repeated label long enough to be deduplicated';
const CHILD_LEAN_STATE = {
    status: 'running',
    startedAt: { $ref: 1 },
    tree: [{ title: { $ref: 0 }, phases: [{ title: { $ref: 0 } }] }],
    _strings: [LONG, STARTED_AT],
    summary: CHILD_SUMMARY,
};

async function build() {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sprint-summary-'));
    dirs.push(dir);
    const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => STARTED_AT });
    await ledger.start();
    const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => STARTED_AT });
    await history.start();
    let seq = 0;
    const controller = createSprintController({
        ledger, history,
        spawner: { spawnSprint: async () => ({ pid: 4242, port: 9900 }) },
        listMembers: () => ({ members: [] }),
        getBacklog: () => ({}),
        resolveRoleMap: async (raw) => (raw ? JSON.parse(raw) : undefined),
        generateSprintId: () => `sup-${++seq}`,
        hasTerminalState: () => null,
        resolvePort: (pid) => (pid === 4242 ? 9900 : undefined),
        proxySummary: async (port) => { assert.equal(port, 9900); return structuredClone(CHILD_SUMMARY); },
        proxyState: async (port) => { assert.equal(port, 9900); return structuredClone(CHILD_LEAN_STATE); },
        getBuildVersion: () => null,
    });
    const supervisor = createSupervisor({ port: 0, logger: { log() {}, error() {} } });
    registerSprintRoutes(supervisor, controller);
    const launched = await controller.launch({ issue: 'R1', members: ['alice'], branch: 'feat/summary', base: 'main', maxCycles: 3 });
    const get = async (url) => {
        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', url), res);
        return { status: res.statusCode, json: JSON.parse(res.body) };
    };
    return { controller, get, sprintId: launched.sprintId };
}

describe('GET /api/sprints/:id stable summary shape', () => {
    test('a live mock sprint reports status, phase, cycle, maxCycles, round, startedAt, elapsedMs, cost and PR branches at the top level', async () => {
        const { get, sprintId } = await build();
        const { status, json } = await get(`/api/sprints/${sprintId}`);
        assert.equal(status, 200);
        for (const f of SPRINT_SUMMARY_FIELDS) assert.ok(f in json, `missing top-level field ${f}`);
        assert.equal(json.sprintId, sprintId);
        assert.equal(json.live, true);
        assert.equal(json.status, 'running');
        assert.equal(json.phase, 'Develop C1 R2');
        assert.equal(json.phaseKind, 'develop');
        assert.equal(json.cycle, 1);
        assert.equal(json.round, 2);
        assert.equal(json.maxCycles, 3);
        assert.equal(typeof json.startedAt, 'string');
        assert.equal(new Date(json.startedAt).toISOString(), json.startedAt);
        assert.ok(json.elapsedMs > 0);
        assert.equal(json.cost, 0.75);
        assert.equal(json.tokens, 1234);
        assert.equal(json.pause.status, 'none');
        assert.equal(json.prSourceBranch, 'feat/summary');
        assert.equal(json.prTargetBranch, 'main');
        // Pre-existing fields keep their meaning.
        assert.deepEqual(json.pendingDecisions, []);
        assert.equal(json.decisionState, 'running');
    });

    test('the default response has no ref marker and no _strings anywhere; ?full=1 returns the resolved tree', async () => {
        const { get, sprintId } = await build();
        const def = await get(`/api/sprints/${sprintId}`);
        assert.deepEqual(findLeanMarkers(def.json), []);
        assert.equal('state' in def.json, false);

        const full = await get(`/api/sprints/${sprintId}?full=1`);
        assert.equal(full.status, 200);
        assert.deepEqual(findLeanMarkers(full.json), []);
        assert.equal(full.json.state.startedAt, STARTED_AT);
        assert.equal(full.json.state.tree[0].title, LONG);
        assert.equal(full.json.state.tree[0].phases[0].title, LONG);
        // The summary fields are still there alongside the tree.
        assert.equal(full.json.cycle, 1);
    });

    test('GET /api/sprints rows carry the same summary fields', async () => {
        const { get, sprintId } = await build();
        const { status, json } = await get('/api/sprints');
        assert.equal(status, 200);
        assert.equal(json.sprints.length, 1);
        const row = json.sprints[0];
        for (const f of SPRINT_SUMMARY_FIELDS) assert.ok(f in row, `row missing ${f}`);
        assert.equal(row.sprintId, sprintId);
        assert.equal(row.live, true);
        assert.equal(row.phase, 'Develop C1 R2');
        assert.equal(row.cycle, 1);
        assert.equal(row.round, 2);
        assert.equal(row.maxCycles, 3);
        assert.equal(row.startedAt, STARTED_AT);
        assert.equal(row.prSourceBranch, 'feat/summary');
        assert.equal(row.prTargetBranch, 'main');
        // Pre-existing row fields are unchanged.
        assert.deepEqual(row.members, ['alice']);
        assert.deepEqual(row.issueRoots, ['R1']);
        assert.equal(row.childPid, 4242);
        assert.equal(row.port, 9900);
        assert.deepEqual(findLeanMarkers(json), []);
    });

    test('parsePhaseTitle covers the fleet-sprint title grammar', () => {
        assert.deepEqual(parsePhaseTitle('Develop C1 R2'), { phaseKind: 'develop', cycle: 1, round: 2 });
        assert.deepEqual(parsePhaseTitle('Final Review C3'), { phaseKind: 'final-review', cycle: 3, round: null });
        assert.deepEqual(parsePhaseTitle('Replan C2 premium-cap 1'), { phaseKind: 'replan', cycle: 2, round: null });
        assert.deepEqual(parsePhaseTitle('Ensure Sprint Branch'), { phaseKind: 'ensure-sprint-branch', cycle: null, round: null });
        assert.deepEqual(parsePhaseTitle(null), { phaseKind: null, cycle: null, round: null });
    });

    test('docs/supervisor-api.md and docs/supervisor-openapi.yaml name every summary field', () => {
        const md = fs.readFileSync(path.join(DOCS, 'supervisor-api.md'), 'utf8');
        const yaml = fs.readFileSync(path.join(DOCS, 'supervisor-openapi.yaml'), 'utf8');
        const section = md.slice(md.indexOf('## GET /api/sprints/:id: the summary shape'));
        assert.ok(section.length > 0);
        const schema = yaml.slice(yaml.indexOf('    SprintSummary:'));
        for (const f of SPRINT_SUMMARY_FIELDS) {
            assert.ok(section.includes(`\`${f}\``), `supervisor-api.md summary section does not document ${f}`);
            assert.ok(new RegExp(`\\n {8}${f}:`).test(schema), `supervisor-openapi.yaml SprintSummary does not document ${f}`);
        }
    });
});
