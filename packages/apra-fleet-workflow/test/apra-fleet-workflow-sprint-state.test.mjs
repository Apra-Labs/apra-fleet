import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { WorkflowEngine } from '../src/workflow/engine.mjs';
import { createDashboardViewer } from '../src/viewer/index.mjs';
import {
    getRunningSprintStatePath,
    getOldSprintStatePath
} from '../src/viewer/sprint-state-paths.mjs';

// Tests for apra-fleet-eft.2.2 ("persist on every activity/phase/state event
// and enrich the state file") and apra-fleet-eft.2.3 ("running/ ->
// old_sprints/ layout under the service data dir, keyed by sprint id").

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);

const KNOWN_MEMBERS = new Set(['fleet-dev']);

function createMockFleetApi() {
    return {
        async executePrompt(payload) {
            const memberKey = payload.member_name || payload.member_id;
            if (!KNOWN_MEMBERS.has(memberKey)) {
                return { content: [{ text: `Member "${memberKey}" not found.` }] };
            }
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

// A mock fleetApi whose executePrompt() resolves after a short artificial
// delay rather than instantly. The plain mock above resolves synchronously
// enough that a fast fixture's entire run (start -> broadcast -> debounced
// write -> end -> move-to-old_sprints) can complete within a single
// microtask flush, before a test ever gets to observe the intermediate
// running/<sprintId>.json file. This delayed variant gives "mid-sprint"
// assertions a real window (well past the 200ms debounce floor) in which to
// read the live file before the run terminates.
function createDelayedFleetApi(delayMs = 600) {
    return {
        async executePrompt(payload) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
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

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('waitFor() timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
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
    // createDashboardViewer() already calls server.listen(port, cb)
    // synchronously before returning the server to us, so the 'listening'
    // event can (and, when a second server is created back-to-back --
    // see the concurrent-sprints test below -- reliably does) fire and get
    // consumed by that internal callback before we ever get a chance to
    // attach our own listener here. EventEmitter never replays a past
    // event to a listener added after the fact, so attaching
    // .once('listening', ...) unconditionally raced this and hung forever
    // (until --test-timeout) whenever the event had already fired.
    // server.listening is the documented idempotent guard for exactly this
    // race: only wait for the event if it hasn't already happened.
    if (!server.listening) {
        await new Promise((resolve, reject) => {
            server.once('listening', resolve);
            server.once('error', reject);
        });
    }
    try {
        return await fn(server.address().port);
    } finally {
        // Belt-and-suspenders: server.close()'s callback only fires once
        // every connection is gone. The http.get() calls above ride the
        // global keep-alive agent, which can in principle leave an idle
        // socket open -- closeAllConnections() forces both active and idle
        // sockets shut so close() always resolves promptly rather than
        // potentially hanging on a leftover connection.
        await new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
        });
    }
}

// Guard: give every test its own cwd AND its own service data dir, distinct
// from one another, so we can positively assert the running/old_sprints
// layout never lands in the repo checkout / process.cwd().
let tempCwd;
let originalCwd;
let dataDir;
beforeEach(() => {
    tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sprint-state-cwd-'));
    originalCwd = process.cwd();
    process.chdir(tempCwd);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sprint-state-data-'));
});
afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempCwd, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('apra-fleet-eft.2.3: running/ -> old_sprints/ layout under the service data dir', () => {
    test('live state is written to running/<sprintId>.json outside the repo checkout, then moved (not copied) to old_sprints/<sprintId>.json on completion', async () => {
        const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
        const sprintId = 'sprint-eft-2-3-a';

        const wf = new FleetWorkflow(createDelayedFleetApi());
        const engine = new WorkflowEngine(wf);
        const server = createDashboardViewer(wf, {
            port: 0,
            name: 'Sprint State Test',
            env,
            sprintId,
            debounceMs: 200,
            launchArgs: ['--track', 'eft-service']
        });

        const runningPath = getRunningSprintStatePath(sprintId, env);
        const oldPath = getOldSprintStatePath(sprintId, env);

        await withServer(server, async (port) => {
            const runPromise = engine.executeFile(fixture('test-end-event-verdict.mjs'), {});

            // Mid-sprint: the live file must exist under running/, must be
            // keyed by sprintId (not an HHMMSS clock key), and must live
            // under the service data dir, NOT the repo checkout (tempCwd).
            await waitFor(() => fs.existsSync(runningPath));
            assert.ok(
                runningPath.startsWith(dataDir),
                `running state path ${runningPath} must live under the service data dir ${dataDir}`
            );
            assert.ok(
                !runningPath.startsWith(tempCwd),
                'running state path must never be written into the repo checkout / cwd'
            );

            const midSprint = JSON.parse(fs.readFileSync(runningPath, 'utf-8'));
            assert.strictEqual(midSprint.status, 'running', 'mid-sprint read must show in-progress state, not terminal state');
            assert.strictEqual(midSprint.sprintId, sprintId);
            assert.strictEqual(midSprint.endedAt, null);

            await runPromise;

            // Terminal: running/<id>.json must be GONE (moved, not copied)
            // and old_sprints/<id>.json must now exist.
            await waitFor(() => fs.existsSync(oldPath));
            assert.strictEqual(fs.existsSync(runningPath), false, 'the live file must be moved, not copied, out of running/');

            const finalState = JSON.parse(fs.readFileSync(oldPath, 'utf-8'));
            assert.strictEqual(finalState.status, 'success');
            assert.strictEqual(finalState.sprintId, sprintId);

            const liveState = JSON.parse(await httpGet(port, '/state'));
            assert.strictEqual(liveState.status, 'success', 'no SSE/polling regression: /state still reflects the terminal status');
        });
    });

    test('two sprints started concurrently get distinct default sprintIds and distinct running/ files (no HHMMSS-style collision)', async () => {
        const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };

        const wf1 = new FleetWorkflow(createMockFleetApi());
        const wf2 = new FleetWorkflow(createMockFleetApi());
        const server1 = createDashboardViewer(wf1, { port: 0, name: 'Sprint A', env, debounceMs: 200 });
        const server2 = createDashboardViewer(wf2, { port: 0, name: 'Sprint B', env, debounceMs: 200 });

        await withServer(server1, async () => {
            await withServer(server2, async () => {
                const s1 = JSON.parse(await httpGet(server1.address().port, '/state'));
                const s2 = JSON.parse(await httpGet(server2.address().port, '/state'));

                assert.ok(s1.sprintId, 'sprint 1 must have a generated sprintId');
                assert.ok(s2.sprintId, 'sprint 2 must have a generated sprintId');
                assert.notStrictEqual(s1.sprintId, s2.sprintId, 'two sprints must never collide on sprintId');

                const path1 = getRunningSprintStatePath(s1.sprintId, env);
                const path2 = getRunningSprintStatePath(s2.sprintId, env);
                assert.notStrictEqual(path1, path2);
            });
        });
    });

    test('sprint-logs/ still lands in the repo checkout as before, unaffected by the running/old_sprints move', async () => {
        const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
        const wf = new FleetWorkflow(createMockFleetApi());
        const engine = new WorkflowEngine(wf);
        const server = createDashboardViewer(wf, { port: 0, name: 'Sprint Logs Untouched Test', env, debounceMs: 200 });

        await withServer(server, async () => {
            await engine.executeFile(fixture('test-end-event-success.mjs'), {});

            const sprintLogsDir = path.join(tempCwd, 'sprint-logs');
            const files = fs.readdirSync(sprintLogsDir).filter((f) => /^sprint_\d{6}\.json$/.test(f));
            assert.strictEqual(files.length, 1, 'sprint-logs/ crash-safety net must still write exactly one file, untouched by this change');
        });
    });
});

describe('apra-fleet-eft.2.2: persist on every activity/phase/state event and enrich the state file', () => {
    test('the persisted file is enriched with sprintId, args, verdict, prUrl, startedAt/updatedAt/endedAt, terminalReason', async () => {
        const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
        const sprintId = 'sprint-eft-2-2-a';
        const launchArgs = ['--foo', 'bar'];

        const wf = new FleetWorkflow(createDelayedFleetApi());
        const engine = new WorkflowEngine(wf);
        const server = createDashboardViewer(wf, {
            port: 0,
            name: 'Enrichment Test',
            env,
            sprintId,
            launchArgs,
            debounceMs: 200
        });

        const runningPath = getRunningSprintStatePath(sprintId, env);
        const oldPath = getOldSprintStatePath(sprintId, env);

        await withServer(server, async () => {
            const runPromise = engine.executeFile(fixture('test-end-event-verdict.mjs'), {});

            await waitFor(() => fs.existsSync(runningPath));
            const midSprint = JSON.parse(fs.readFileSync(runningPath, 'utf-8'));
            assert.strictEqual(midSprint.sprintId, sprintId);
            assert.deepStrictEqual(midSprint.args, launchArgs);
            assert.strictEqual(midSprint.verdict, null, 'verdict is not yet known mid-sprint');
            assert.strictEqual(midSprint.prUrl, null);
            assert.ok(midSprint.startedAt, 'startedAt must be populated from construction');
            assert.ok(midSprint.updatedAt, 'updatedAt must be populated on every persisted event');
            assert.strictEqual(midSprint.endedAt, null, 'endedAt must stay null until the sprint terminates');
            assert.strictEqual(midSprint.terminalReason, null);

            await runPromise;
            await waitFor(() => fs.existsSync(oldPath));

            const finalState = JSON.parse(fs.readFileSync(oldPath, 'utf-8'));
            assert.strictEqual(finalState.sprintId, sprintId);
            assert.deepStrictEqual(finalState.args, launchArgs);
            assert.strictEqual(finalState.verdict, 'MERGED', 'verdict must be picked up from the workflow script\'s own return value');
            assert.strictEqual(finalState.prUrl, 'https://github.com/example/repo/pull/42');
            assert.ok(finalState.endedAt, 'endedAt must be populated on completion');
            assert.strictEqual(finalState.terminalReason, 'success');
            assert.ok(
                new Date(finalState.updatedAt).getTime() >= new Date(finalState.startedAt).getTime(),
                'updatedAt must never be older than startedAt'
            );
        });
    });

    test('every SSE-broadcasting event (group:start/phase/activity/log/state) also schedules a debounced write, not just run-end', async () => {
        const env = { ...process.env, APRA_FLEET_DATA_DIR: dataDir };
        const sprintId = 'sprint-eft-2-2-b';

        const wf = new FleetWorkflow(createDelayedFleetApi());
        const engine = new WorkflowEngine(wf);
        const server = createDashboardViewer(wf, {
            port: 0,
            name: 'Every Event Persists Test',
            env,
            sprintId,
            debounceMs: 200
        });

        const runningPath = getRunningSprintStatePath(sprintId, env);

        const activityStarts = [];
        wf.on('activity:start', (meta) => activityStarts.push(meta));

        await withServer(server, async () => {
            const runPromise = engine.executeFile(fixture('test-end-event-verdict.mjs'), {});
            runPromise.catch(() => {});

            await waitFor(() => activityStarts.length > 0);
            // The debounced writer only flushes on its timer or an explicit
            // flush -- wait past one debounce window to observe the
            // scheduled (not run-end) write actually landing on disk.
            await waitFor(() => fs.existsSync(runningPath), { timeoutMs: 2000 });
            const midSprint = JSON.parse(fs.readFileSync(runningPath, 'utf-8'));
            assert.strictEqual(midSprint.status, 'running', 'a write must have happened from the activity:start broadcast, well before run-end');

            await runPromise;
        });
    });
});
