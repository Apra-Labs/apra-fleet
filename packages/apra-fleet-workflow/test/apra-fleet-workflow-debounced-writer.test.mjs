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
    DebouncedStateWriter,
    MIN_DEBOUNCE_MS,
    MAX_DEBOUNCE_MS,
    DEFAULT_DEBOUNCE_MS
} from '../src/viewer/debounced-writer.mjs';

// Tests for apra-fleet-eft.2.1: debounced sprint-state writer with
// flush-on-exit, additive to the existing write-once-on-end persistState()
// (sprint-logs/sprint_<HHMMSS>.json), which must remain byte-for-byte
// unchanged.

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

function httpPost(port, urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.request(`http://127.0.0.1:${port}${urlPath}`, { method: 'POST' }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.end();
    });
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('waitFor() timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
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

async function withTempCwd(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-debounced-writer-'));
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
        return await fn(dir);
    } finally {
        process.chdir(originalCwd);
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function readSprintLogFiles(dir) {
    const sprintLogsDir = path.join(dir, 'sprint-logs');
    if (!fs.existsSync(sprintLogsDir)) return [];
    return fs.readdirSync(sprintLogsDir).filter((f) => /^sprint_\d{6}\.json$/.test(f));
}

describe('apra-fleet-eft.2.1: DebouncedStateWriter unit behavior', () => {
    let tmpDir;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-debounced-writer-unit-'));
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('default debounce window is within the required 200-500ms range', () => {
        assert.ok(DEFAULT_DEBOUNCE_MS >= 200 && DEFAULT_DEBOUNCE_MS <= 500,
            `DEFAULT_DEBOUNCE_MS (${DEFAULT_DEBOUNCE_MS}) must be within 200-500ms`);
        assert.strictEqual(MIN_DEBOUNCE_MS, 200);
        assert.strictEqual(MAX_DEBOUNCE_MS, 500);
    });

    test('debounceMs is configurable within range and rejected outside it', () => {
        const filePath = path.join(tmpDir, 'state.json');
        const writer = new DebouncedStateWriter({ getState: () => ({}), filePath, debounceMs: 250 });
        assert.strictEqual(writer.debounceMs, 250);

        assert.throws(() => new DebouncedStateWriter({ getState: () => ({}), filePath, debounceMs: 199 }), RangeError);
        assert.throws(() => new DebouncedStateWriter({ getState: () => ({}), filePath, debounceMs: 501 }), RangeError);
    });

    test('coalesces N rapid schedule() calls into exactly 1 write within the window', async () => {
        const filePath = path.join(tmpDir, 'state.json');
        let counter = 0;
        const writer = new DebouncedStateWriter({ getState: () => ({ counter }), filePath, debounceMs: 200 });

        for (let i = 0; i < 20; i++) {
            counter = i;
            writer.schedule();
        }

        assert.strictEqual(writer.writeCount, 0, 'must not write synchronously on schedule()');
        assert.ok(!fs.existsSync(filePath), 'file must not exist before the debounce window elapses');

        await waitFor(() => writer.writeCount === 1, { timeoutMs: 1000 });

        assert.strictEqual(writer.writeCount, 1, 'exactly one write for a burst of 20 rapid schedule() calls');
        const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        assert.strictEqual(saved.counter, 19, 'the single write must reflect the latest state, not an intermediate one');
    });

    test('flushSync() writes synchronously and cancels any pending timer', () => {
        const filePath = path.join(tmpDir, 'state.json');
        const writer = new DebouncedStateWriter({ getState: () => ({ v: 1 }), filePath, debounceMs: 300 });

        writer.schedule();
        writer.flushSync();

        assert.strictEqual(writer.writeCount, 1);
        assert.ok(fs.existsSync(filePath));
        const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        assert.strictEqual(saved.v, 1);
    });

    test('flushSync() is a no-op when nothing is dirty', () => {
        const filePath = path.join(tmpDir, 'state.json');
        const writer = new DebouncedStateWriter({ getState: () => ({ v: 1 }), filePath, debounceMs: 300 });

        writer.flushSync();
        assert.strictEqual(writer.writeCount, 0);
        assert.ok(!fs.existsSync(filePath));
    });

    test('a second flushSync() after a fresh schedule() writes again (not idempotent-forever)', () => {
        const filePath = path.join(tmpDir, 'state.json');
        let v = 1;
        const writer = new DebouncedStateWriter({ getState: () => ({ v }), filePath, debounceMs: 300 });

        writer.schedule();
        writer.flushSync();
        assert.strictEqual(writer.writeCount, 1);

        v = 2;
        writer.schedule();
        writer.flushSync();
        assert.strictEqual(writer.writeCount, 2);
        const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        assert.strictEqual(saved.v, 2);
    });
});

describe('apra-fleet-eft.2.1: viewer wiring -- flush-on-exit and sprint-logs/ regression', () => {
    // NOTE: these tests exercise the debounced writer's flush-on-exit wiring
    // in isolation, so they pass an explicit opts.debouncedStatePath (a fixed
    // location under the test's own temp cwd) rather than relying on the
    // default running/<sprintId>.json-under-the-service-data-dir layout --
    // that default path resolution is apra-fleet-eft.2.3's concern and is
    // covered by its own dedicated suite (apra-fleet-workflow-sprint-state.test.mjs).
    test('a normal "end" event flushes the debounced writer AND leaves sprint-logs/ byte-for-byte as before', async () => {
        await withTempCwd(async (dir) => {
            const wf = new FleetWorkflow(createMockFleetApi());
            const engine = new WorkflowEngine(wf);
            const debouncedStatePath = path.join(dir, 'sprint-logs', '.debounced-state.json');
            const server = createDashboardViewer(wf, { port: 0, name: 'Debounced Writer End Test', debounceMs: 200, debouncedStatePath });

            await withServer(server, async (port) => {
                const result = await engine.executeFile(fixture('test-end-event-success.mjs'), {});
                assert.deepStrictEqual(result, { result: 'echo: hello' });

                // Existing sprint-logs/ crash-safety net must be untouched:
                // exactly one sprint_HHMMSS.json, 2-space indented, matching /state.
                const files = readSprintLogFiles(dir);
                assert.strictEqual(files.length, 1, `expected exactly one sprint_HHMMSS.json file, found: ${JSON.stringify(files)}`);
                const savedContent = fs.readFileSync(path.join(dir, 'sprint-logs', files[0]), 'utf-8');
                const saved = JSON.parse(savedContent);
                const liveState = JSON.parse(await httpGet(port, '/state'));
                assert.deepStrictEqual(saved, liveState, 'saved sprint-logs/ file must still match the in-memory state served at /state');
                assert.ok(savedContent.includes('\n  "workflowName"'), 'sprint-logs/ formatting must remain 2-space indented JSON');

                // New: the debounced writer's own file must exist and be flushed
                // synchronously by the time 'end' handling completes.
                assert.ok(fs.existsSync(debouncedStatePath), 'debounced writer must have flushed a file on the "end" event');
                const debouncedSaved = JSON.parse(fs.readFileSync(debouncedStatePath, 'utf-8'));
                assert.strictEqual(debouncedSaved.status, 'success');
            });
        });
    });

    test('a SIGINT delivered mid-run flushes the debounced writer synchronously before process.exit (mocked)', async () => {
        await withTempCwd(async (dir) => {
            const hang = (payload) => new Promise((resolve, reject) => {
                const signal = payload && payload.signal;
                if (!signal) return;
                if (signal.aborted) { reject(new Error('aborted')); return; }
                signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
            const wf = new FleetWorkflow({ executePrompt: hang, executeCommand: hang });
            const engine = new WorkflowEngine(wf);

            const activityStarts = [];
            wf.on('activity:start', (meta) => activityStarts.push(meta));

            const debouncedStatePath = path.join(dir, 'sprint-logs', '.debounced-state.json');
            const server = createDashboardViewer(wf, { port: 0, name: 'Debounced Writer SIGINT Test', debounceMs: 200, debouncedStatePath });

            const originalExit = process.exit;
            let exitCode = null;
            process.exit = (code) => { exitCode = code; };

            try {
                await withServer(server, async (port) => {
                    const runPromise = engine.executeFile(fixture('test-stop-pending-agent.mjs'), {});
                    runPromise.catch(() => {});

                    await waitFor(() => activityStarts.length > 0);

                    process.emit('SIGINT');

                    assert.ok(fs.existsSync(debouncedStatePath), 'SIGINT must synchronously flush the debounced writer even mid-run');
                    assert.strictEqual(exitCode, 130);

                    wf.requestStop('test cleanup');
                    await assert.rejects(runPromise, () => true);
                });
            } finally {
                process.exit = originalExit;
            }
        });
    });

    test('a /stop-triggered cancellation also flushes the debounced writer', async () => {
        await withTempCwd(async (dir) => {
            const hang = (payload) => new Promise((resolve, reject) => {
                const signal = payload.signal;
                if (!signal) return;
                if (signal.aborted) { reject(new Error('aborted')); return; }
                signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
            const wf = new FleetWorkflow({ executePrompt: hang, executeCommand: hang });
            const engine = new WorkflowEngine(wf);

            const activityStarts = [];
            wf.on('activity:start', (meta) => activityStarts.push(meta));

            const debouncedStatePath = path.join(dir, 'sprint-logs', '.debounced-state.json');
            const server = createDashboardViewer(wf, { port: 0, name: 'Debounced Writer Stop Test', debounceMs: 200, debouncedStatePath });

            await withServer(server, async (port) => {
                const runPromise = engine.executeFile(fixture('test-stop-pending-agent.mjs'), {});
                runPromise.catch(() => {});

                await waitFor(() => activityStarts.length > 0);

                const { statusCode } = await httpPost(port, '/stop');
                assert.strictEqual(statusCode, 200);

                assert.ok(fs.existsSync(debouncedStatePath), '/stop must flush the debounced writer');

                await assert.rejects(runPromise, () => true);
            });
        });
    });
});
