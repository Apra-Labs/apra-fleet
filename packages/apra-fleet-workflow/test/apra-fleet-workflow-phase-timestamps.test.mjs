// Tests for apra-fleet-eft.53.1: engine-side phaseStartedAt/phaseEndedAt
// stamping at phase() transitions.
//
// Every phase entry pushed into state.tree (src/viewer/index.mjs) must carry
// phaseStartedAt on entry and phaseEndedAt (initially null, then filled in
// once that phase is exited -- either by the next phase() call or by the
// run ending). GET /state (buildListStatePayload(), lean-state.mjs) is a
// generic deep-copy/transform that never special-cases field names, so
// these two ISO-string fields pass through untouched; this suite asserts
// that end-to-end via a live HTTP GET rather than reaching into internals.
//
// "persist across a simulated reload" (acceptance criteria) is exercised by
// JSON.stringify()-then-JSON.parse()-ing the live GET /state payload -- the
// same round trip the debounced writer / terminal snapshot / History view
// all put every persisted state through -- and asserting the earlier
// "Plan" phase's timestamps survive unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { WorkflowEngine } from '../src/workflow/engine.mjs';
import { createDashboardViewer } from '../src/viewer/index.mjs';
import { resolveStringRefs } from '../src/viewer/lean-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);

function createMockFleetApi() {
    return {
        async executePrompt(payload) {
            return {
                content: [{ text: `echo: ${payload.prompt}` }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
            };
        },
        async executeCommand(payload) {
            return { content: [{ text: payload.command }], isError: false };
        }
    };
}

function httpGet(port, urlPath) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

async function withServer(server, fn) {
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    try {
        return await fn(server.address().port);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

// Runs `fn` with process.cwd() pointed at a fresh temp dir, restoring the
// original cwd afterward -- matches every other test in this suite that
// exercises the real 'end' handler (which writes a workflow-logs/
// crash-net snapshot relative to process.cwd(), see debounced-writer.mjs
// tests), so this test never leaves stray files in the repo checkout.
async function withTempCwd(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-phase-timestamps-'));
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
        return await fn(dir);
    } finally {
        process.chdir(originalCwd);
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// GET /state runs its payload through dedupeStrings() (lean-state.mjs)
// before serving it, so any string repeated 2+ times anywhere in the
// payload (here: identical phaseStartedAt/phaseEndedAt/state.updatedAt ISO
// timestamps minted in the same tick) is replaced with a `{ $ref }` marker
// into a shared `_strings` table. The real client (HTML_TEMPLATE's embedded
// script) always undoes this via resolveStringRefs() before reading fields
// -- do the same here rather than asserting against the raw wire shape.
async function getResolvedState(port) {
    const raw = JSON.parse(await httpGet(port, '/state'));
    const { _strings, ...rest } = raw;
    return resolveStringRefs(rest, _strings || []);
}

function findPhase(state, title) {
    for (const g of state.tree || []) {
        for (const p of g.phases || []) {
            if (p.title === title) return p;
        }
    }
    return null;
}

test('apra-fleet-eft.53.1: GET /state stamps phaseStartedAt for every phase, phaseEndedAt only for exited phases', async () => {
    await withTempCwd(async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const engine = new WorkflowEngine(wf);
        const server = createDashboardViewer(wf, { port: 0, name: 'Phase Timestamp Test' });

        await withServer(server, async (port) => {
            const result = await engine.executeFile(fixture('test-two-phases.mjs'), {});
            assert.deepStrictEqual(result, { result: 'done' });

            const liveState = await getResolvedState(port);

            const plan = findPhase(liveState, 'Plan');
            assert.ok(plan, 'Plan phase must be present in GET /state');
            assert.strictEqual(typeof plan.phaseStartedAt, 'string', 'Plan.phaseStartedAt must be set');
            assert.strictEqual(typeof plan.phaseEndedAt, 'string', 'Plan.phaseEndedAt must be set once Develop begins');
            assert.ok(Date.parse(plan.phaseStartedAt) <= Date.parse(plan.phaseEndedAt), 'Plan must end at or after it started');

            const develop = findPhase(liveState, 'Develop');
            assert.ok(develop, 'Develop phase must be present in GET /state');
            assert.strictEqual(typeof develop.phaseStartedAt, 'string', 'Develop.phaseStartedAt must be set');
            // The run has already ended by the time we poll /state, so the final
            // phase must also have been closed out (by the 'end' handler) rather
            // than left with a dangling null.
            assert.strictEqual(typeof develop.phaseEndedAt, 'string', 'Develop.phaseEndedAt must be stamped once the run ends');

            // "persist across a simulated reload": round-trip the payload through
            // JSON exactly as the debounced writer / terminal snapshot / History
            // view do, and confirm the earlier phase's timestamps survive.
            const reloaded = JSON.parse(JSON.stringify(liveState));
            const reloadedPlan = findPhase(reloaded, 'Plan');
            assert.strictEqual(reloadedPlan.phaseStartedAt, plan.phaseStartedAt, 'phaseStartedAt must survive a reload');
            assert.strictEqual(reloadedPlan.phaseEndedAt, plan.phaseEndedAt, 'phaseEndedAt must survive a reload');
        });
    });
});

test('apra-fleet-eft.53.1: the initial phase before any phase() call is stamped on entry', async () => {
    await withTempCwd(async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const engine = new WorkflowEngine(wf);
        const server = createDashboardViewer(wf, { port: 0, name: 'Initial Phase Timestamp Test' });

        await withServer(server, async (port) => {
            await engine.executeFile(fixture('test-end-event-success.mjs'), {});
            const liveState = await getResolvedState(port);
            const init = findPhase(liveState, 'Initialization');
            assert.ok(init, 'Initialization phase must be present');
            assert.strictEqual(typeof init.phaseStartedAt, 'string', 'Initialization.phaseStartedAt must be set from construction');
            assert.strictEqual(typeof init.phaseEndedAt, 'string', 'Initialization.phaseEndedAt must be stamped once the run ends (no phase() call ever fired)');
        });
    });
});
