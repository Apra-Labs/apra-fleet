// GET /api/sprints/:id returns the sprint analysis and result of a terminal
// sprint, both while the ledger reservation holds and after its release (the
// history branch). Real supervisor HTTP server + controller + ledger + history;
// the persisted terminal run state is a real file under a temp data dir that
// the DEFAULT terminal-state reader resolves via APRA_FLEET_DATA_DIR.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSupervisor } from '../src/supervisor/server.mjs';
import { createSprintController, registerSprintRoutes } from '../src/supervisor/api.mjs';
import { defaultHasTerminalState } from '../src/supervisor/watchdog.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const SPRINT_ID = 'analysis-1';
const NO_NS_ID = 'analysis-none';
const ANALYSIS = { text: '# Sprint analysis\n\nAll cycles passed.', generatedAt: '2026-07-18T01:02:03.000Z' };
const RESULT = { status: 'success', verdict: 'PASS', notes: 'Final review: approved' };

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

describe('terminal sprint analysis and result over the supervisor API', () => {
    let tmpDir; let supervisor; let port; let ledger;

    before(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-analysis-api-'));
        const env = { ...process.env, APRA_FLEET_DATA_DIR: tmpDir };
        const oldRuns = path.join(tmpDir, 'old_runs');
        fs.mkdirSync(oldRuns, { recursive: true });
        fs.writeFileSync(path.join(oldRuns, `${SPRINT_ID}.json`), JSON.stringify({
            terminalReason: 'SPRINT_COMPLETE', result: RESULT,
            extensions: { 'sprint-analysis': ANALYSIS, terminal: { verdict: 'PASS' } },
        }));
        fs.writeFileSync(path.join(oldRuns, `${NO_NS_ID}.json`), JSON.stringify({
            terminalReason: 'SPRINT_COMPLETE', result: RESULT, extensions: { terminal: { verdict: 'PASS' } },
        }));
        ledger = createLedger({ filePath: path.join(tmpDir, LEDGER_FILENAME) });
        await ledger.start();
        const history = createHistory({ filePath: path.join(tmpDir, HISTORY_FILENAME) });
        await history.start();
        for (const id of [SPRINT_ID, NO_NS_ID]) {
            await ledger.claim(id, { members: [`m-${id}`], issueRoots: ['R'], childPid: 4242, branch: `feat/${id}`, base: 'main' });
            await history.record({ sprintId: id, event: 'finished', resultStatus: 'success' });
        }
        const controller = createSprintController({
            ledger, history,
            spawner: { spawnSprint: async () => { throw new Error('no spawn in this test'); } },
            listMembers: () => ({ members: [] }), getBacklog: () => ({}),
            hasTerminalState: (id, branch) => defaultHasTerminalState(id, branch, env),
            resolvePort: () => undefined,
            getBuildVersion: () => null,
        });
        supervisor = createSupervisor({ port: 0, host: '127.0.0.1', logger: { log() {}, error() {} } });
        registerSprintRoutes(supervisor, controller);
        await supervisor.start();
        port = supervisor.port;
    });

    after(async () => {
        if (supervisor) await supervisor.stop();
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('analysis and result are returned while the reservation holds and again after release, identically', async () => {
        const held = await getJson(port, `/api/sprints/${SPRINT_ID}`);
        assert.equal(held.status, 200, JSON.stringify(held.json));
        assert.equal(held.json.terminal, true);
        assert.equal(held.json.analysis.text, ANALYSIS.text);
        assert.equal(held.json.analysis.generatedAt, ANALYSIS.generatedAt);
        assert.deepEqual(held.json.result, RESULT);

        await ledger.release(SPRINT_ID);
        const released = await getJson(port, `/api/sprints/${SPRINT_ID}`);
        assert.equal(released.status, 200, JSON.stringify(released.json));
        assert.equal(released.json.live, false);
        assert.ok(Array.isArray(released.json.history), 'history branch');
        assert.equal(released.json.analysis.text, held.json.analysis.text);
        assert.deepEqual(released.json.result, held.json.result);
    });

    test('a terminal state without the namespace returns analysis null and still 200, held and released', async () => {
        const held = await getJson(port, `/api/sprints/${NO_NS_ID}`);
        assert.equal(held.status, 200);
        assert.equal(held.json.analysis, null);
        assert.deepEqual(held.json.result, RESULT);
        await ledger.release(NO_NS_ID);
        const released = await getJson(port, `/api/sprints/${NO_NS_ID}`);
        assert.equal(released.status, 200);
        assert.equal(released.json.analysis, null);
        assert.deepEqual(released.json.result, RESULT);
    });

    test('both docs files document analysis and result', () => {
        for (const f of ['supervisor-api.md', 'supervisor-openapi.yaml']) {
            const text = fs.readFileSync(path.join(DOCS, f), 'utf8');
            assert.match(text, /analysis/, `${f} mentions analysis`);
            assert.match(text, /\bresult\b/, `${f} mentions result`);
        }
    });
});
