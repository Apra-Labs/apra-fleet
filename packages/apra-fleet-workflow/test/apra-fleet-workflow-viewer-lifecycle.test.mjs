import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { FleetWorkflow, CancelledError, WorkflowError } from '../src/workflow/index.mjs';
import { WorkflowEngine } from '../src/workflow/engine.mjs';
import { createDashboardViewer } from '../src/viewer/index.mjs';
import { escapeHtml } from '../src/viewer/html-utils.mjs';

// Tests for apra-fleet-unw.10 (F9, A7-viewer): viewer lifecycle.
//
//   1. WorkflowEngine.executeFile() now emits an 'end' event (from a
//      finally block wrapping script execution, carrying the per-run
//      runId) on BOTH the success and failure/throw paths -- the dashboard
//      viewer subscribed to this event already (src/viewer/index.mjs), but
//      FleetWorkflow never actually emitted it, so the dashboard stayed in
//      a perpetual "LIVE" state and the auto-close path was dead code.
//   2. The viewer's POST /stop handler is now cooperative: it calls
//      FleetWorkflow.requestStop(), which aborts the active run's
//      AbortController -- threaded (apra-fleet-unw.5) into every in-flight
//      and future agent()/command() call for that run -- instead of calling
//      process.exit(1) (no state flush, mid-dispatch agents orphaned).
//   3. escapeHtml() (src/viewer/html-utils.mjs) is unit-tested directly.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(__dirname, 'fixtures', name);

// File-wide cwd guard: createDashboardViewer() now persists sprint state to
// sprint-logs/ under process.cwd() (see "server-side sprint-state
// persistence" below) whenever a workflow's 'end' event fires -- which
// several tests in THIS file trigger (e.g. the pre-existing "engine end
// event" and "cooperative /stop" suites above), not just the ones written
// specifically to exercise persistence. Without this, those tests would
// write real sprint_HHMMSS.json files into this package's actual checkout
// directory. Every test in this file runs against a fresh temp cwd instead.
let __fileCwdGuardOriginal;
let __fileCwdGuardTemp;
beforeEach(() => {
    __fileCwdGuardTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-viewer-test-cwd-'));
    __fileCwdGuardOriginal = process.cwd();
    process.chdir(__fileCwdGuardTemp);
});
afterEach(() => {
    process.chdir(__fileCwdGuardOriginal);
    fs.rmSync(__fileCwdGuardTemp, { recursive: true, force: true });
});

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

/**
 * A mock fleetApi whose executePrompt()/executeCommand() never resolve on
 * their own -- they only settle by REJECTING once the caller's AbortSignal
 * (payload.signal) fires, mirroring how packages/apra-fleet-client's
 * McpClient.request() reacts to an aborted signal (an error with
 * `.code === 'ABORTED'`). Simulates a dispatch that is genuinely "in
 * flight" (accepted, not yet replied to) when a stop is requested.
 */
function createHangingFleetApi() {
    const makeAbortError = () => {
        const err = new Error('Request aborted before a response was received.');
        err.code = 'ABORTED';
        return err;
    };
    const hang = (payload) => new Promise((resolve, reject) => {
        const signal = payload.signal;
        if (!signal) return; // never resolves -- test always supplies a signal via the run context
        if (signal.aborted) {
            reject(makeAbortError());
            return;
        }
        signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
    });
    return {
        executePrompt: hang,
        executeCommand: hang
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

// Runs `fn` with process.cwd() pointed at a fresh temp directory, so tests
// that exercise the sprint-logs/ auto-save feature never write into the real
// repo checkout. Always restores the original cwd and removes the temp dir,
// even if `fn` throws.
async function withTempCwd(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-viewer-persist-'));
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

describe('apra-fleet-unw.10: engine end event', () => {
    test('a completed (successful) run emits "end" with status success, and the viewer /state reflects it (no perpetual LIVE)', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const engine = new WorkflowEngine(wf);

        const endEvents = [];
        wf.on('end', (res) => endEvents.push(res));

        const server = createDashboardViewer(wf, { port: 18091, name: 'Lifecycle Success Test' });
        await withServer(server, async (port) => {
            const before = JSON.parse(await httpGet(port, '/state'));
            assert.strictEqual(before.status, 'running', 'dashboard must start in the running/LIVE state');

            const result = await engine.executeFile(fixture('test-end-event-success.mjs'), {});
            assert.deepStrictEqual(result, { result: 'echo: hello' });

            assert.strictEqual(endEvents.length, 1, 'expected exactly one end event');
            assert.strictEqual(endEvents[0].status, 'success');
            assert.ok(endEvents[0].runId, 'end event must carry the run\'s runId');

            const after = JSON.parse(await httpGet(port, '/state'));
            assert.strictEqual(after.status, 'success', 'dashboard must leave the perpetual LIVE state once the run ends');
            assert.strictEqual(typeof after.stats.durationMs, 'number');
            assert.ok(after.stats.durationMs >= 0);
        });
    });

    test('a failing run also emits "end" (status failed) from the same finally block -- not just the success path', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const engine = new WorkflowEngine(wf);

        const endEvents = [];
        wf.on('end', (res) => endEvents.push(res));

        const server = createDashboardViewer(wf, { port: 18092, name: 'Lifecycle Failure Test' });
        await withServer(server, async (port) => {
            await assert.rejects(() => engine.executeFile(fixture('test-end-event-failure.mjs'), {}));

            assert.strictEqual(endEvents.length, 1, 'expected exactly one end event on the failure path too');
            assert.strictEqual(endEvents[0].status, 'failed');
            assert.ok(endEvents[0].error && endEvents[0].error.message, 'end event must carry error info on failure');
            assert.ok(endEvents[0].runId);

            const after = JSON.parse(await httpGet(port, '/state'));
            assert.strictEqual(after.status, 'failed');
            assert.strictEqual(typeof after.stats.durationMs, 'number');
        });
    });
});

describe('apra-fleet-unw.10: cooperative /stop', () => {
    test('POST /stop while a mock dispatch is pending rejects that dispatch via the abort signal, ends the workflow as cancelled, and never calls process.exit', async () => {
        const wf = new FleetWorkflow(createHangingFleetApi());
        const engine = new WorkflowEngine(wf);

        const activityStarts = [];
        wf.on('activity:start', (meta) => activityStarts.push(meta));
        const endEvents = [];
        wf.on('end', (res) => endEvents.push(res));

        const server = createDashboardViewer(wf, { port: 18093, name: 'Stop Test' });

        const originalExit = process.exit;
        let exitCalled = false;
        process.exit = () => {
            exitCalled = true;
            throw new Error('process.exit must never be called by the /stop handler');
        };

        try {
            await withServer(server, async (port) => {
                const runPromise = engine.executeFile(fixture('test-stop-pending-agent.mjs'), {});
                // Attach a no-op handler immediately: runPromise may settle
                // (reject) during the `await`s below, before the
                // `assert.rejects(runPromise, ...)` call further down has a
                // chance to attach its own handler -- without this, Node's
                // unhandledRejection detection flags the test as failed even
                // though the rejection IS handled a few lines later.
                runPromise.catch(() => {});

                // Wait until the dispatch has actually started (activity:start
                // fired) before asking the run to stop, so we're genuinely
                // testing cancellation of an IN-FLIGHT dispatch.
                await waitFor(() => activityStarts.length > 0);

                const { statusCode } = await httpPost(port, '/stop');
                assert.strictEqual(statusCode, 200);

                await assert.rejects(runPromise, (err) => {
                    assert.ok(err instanceof CancelledError, `expected a CancelledError, got ${err.constructor.name}: ${err.message}`);
                    assert.ok(err instanceof WorkflowError);
                    assert.strictEqual(err.code, 'CANCELLED');
                    return true;
                });

                assert.strictEqual(endEvents.length, 1);
                assert.strictEqual(endEvents[0].status, 'cancelled');

                const state = JSON.parse(await httpGet(port, '/state'));
                assert.strictEqual(state.status, 'cancelled');
                assert.strictEqual(typeof state.stats.durationMs, 'number');
            });

            assert.strictEqual(exitCalled, false, 'process.exit must never be called by /stop');
            // Reaching this line at all -- inside the very Node process that
            // served the /stop request -- is itself proof the process is
            // still alive (a real process.exit() would have terminated the
            // whole node --test run instead of letting execution continue).
        } finally {
            process.exit = originalExit;
        }
    });
});

describe('apra-fleet-unw.10: html-utils.escapeHtml', () => {
    test('escapes the five HTML-significant characters', () => {
        assert.strictEqual(escapeHtml(`<script>alert('x') & "y"</script>`), '&lt;script&gt;alert(&#039;x&#039;) &amp; &quot;y&quot;&lt;/script&gt;');
    });

    test('a malicious bead title renders inert (no live <script> tag survives)', () => {
        const malicious = `<script>alert(1)</script>`;
        const escaped = escapeHtml(malicious);
        assert.ok(!escaped.includes('<script>'), 'escaped output must not contain a live <script> tag');
        assert.strictEqual(escaped, '&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    test('handles null/undefined/non-string input without throwing', () => {
        assert.strictEqual(escapeHtml(null), '');
        assert.strictEqual(escapeHtml(undefined), '');
        assert.strictEqual(escapeHtml(42), '42');
    });
});

describe('apra-fleet-unw.19: poll error path terminal state check', () => {
    test('poll error handler treats cancelled as a terminal state (does not fall through to OFFLINE)', async () => {
        // The poll error path in the viewer (index.mjs:359) checks if globalState
        // has a terminal status before rendering OFFLINE. This test verifies that
        // 'cancelled' is included in that terminal state check alongside 'success'
        // and 'failed'. If a cancelled run encounters a network error, it should
        // display CANCELLED, not OFFLINE. Since the terminal-state check lives
        // inside an HTML_TEMPLATE string (client-side code), we read the actual
        // source file and assert it contains the full terminal state check.
        const fs = await import('fs/promises');
        const source = await fs.readFile(path.join(__dirname, '../src/viewer/index.mjs'), 'utf-8');

        // Find the terminal state check line in the poll error handler (catch block
        // of the poll() function, which checks globalState.status for terminal states
        // before rendering OFFLINE). The real check must include 'cancelled' alongside
        // 'success' and 'failed', and must NOT incorrectly mark 'running' as terminal.
        const terminalStateCheckPattern = /globalState\.status\s*===\s*['"]success['"]\s*\|\|\s*globalState\.status\s*===\s*['"]failed['"]\s*\|\|\s*globalState\.status\s*===\s*['"]cancelled['"]/;
        const hasTerminalStateCheck = terminalStateCheckPattern.test(source);
        assert.ok(hasTerminalStateCheck,
            'Expected to find terminal state check that includes success, failed, AND cancelled. ' +
            'The check ensures cancelled runs render CANCELLED (not OFFLINE) after a poll error.'
        );

        // Verify cancelled is explicitly mentioned in the check (not just assumed)
        const cancelledInTerminalCheck = /globalState\.status\s*===\s*['"]cancelled['"]/.test(source);
        assert.ok(cancelledInTerminalCheck,
            'Expected the poll error handler to explicitly check for cancelled status'
        );
    });
});

describe('apra-fleet-unw.10: no process.exit in the /stop handler (source grep)', () => {
    test('the /stop request handler itself contains no live process.exit() call', async () => {
        const fs = await import('fs/promises');
        const source = await fs.readFile(path.join(__dirname, '../src/viewer/index.mjs'), 'utf-8');
        // Scope the check to the /stop branch of the request handler only
        // (from "req.url === '/stop'" up to the next "} else if"/"} else").
        // The file as a whole now legitimately calls process.exit() elsewhere
        // (the SIGINT/SIGTERM handlers added for server-side sprint-state
        // persistence, which must still terminate the process per their own
        // contract) -- this test's job is only to guard the /stop handler's
        // own cooperative-cancellation contract, not the whole module.
        const stopBranchMatch = source.match(/req\.url === '\/stop'[\s\S]*?\n\s*\} else if/);
        assert.ok(stopBranchMatch, 'could not locate the /stop handler branch in src/viewer/index.mjs');
        const stopBranchSource = stopBranchMatch[0];

        const liveCalls = stopBranchSource
            .split('\n')
            .filter((line) => !line.trim().startsWith('//'))
            .filter((line) => /process\.exit\s*\(/.test(line));
        assert.deepStrictEqual(liveCalls, [], `expected no live process.exit() calls in the /stop handler, found: ${JSON.stringify(liveCalls)}`);
    });
});

describe('server-side sprint-state persistence (auto-save on finish, stop, or exit)', () => {
    test('a normal "end" event writes sprint-logs/sprint_HHMMSS.json whose content matches /state', async () => {
        await withTempCwd(async (dir) => {
            const wf = new FleetWorkflow(createMockFleetApi());
            const engine = new WorkflowEngine(wf);
            const server = createDashboardViewer(wf, { port: 18094, name: 'Persist Success Test' });

            await withServer(server, async (port) => {
                const result = await engine.executeFile(fixture('test-end-event-success.mjs'), {});
                assert.deepStrictEqual(result, { result: 'echo: hello' });

                const files = readSprintLogFiles(dir);
                assert.strictEqual(files.length, 1, `expected exactly one sprint_HHMMSS.json file, found: ${JSON.stringify(files)}`);
                assert.match(files[0], /^sprint_\d{6}\.json$/);

                const savedContent = fs.readFileSync(path.join(dir, 'sprint-logs', files[0]), 'utf-8');
                const saved = JSON.parse(savedContent);

                const liveState = JSON.parse(await httpGet(port, '/state'));
                assert.deepStrictEqual(saved, liveState, 'saved file must match the in-memory state served at /state');
                assert.strictEqual(saved.status, 'success');

                // Formatting must match the client-side saveState()'s own
                // JSON.stringify(globalState, null, 2) -- 2-space indent.
                assert.ok(savedContent.includes('\n  "workflowName"'), 'saved JSON must be 2-space indented like the client-side Save button');
            });
        });
    });

    test('a /stop-triggered cancellation also results in a saved sprint-logs/ file', async () => {
        await withTempCwd(async (dir) => {
            const wf = new FleetWorkflow(createHangingFleetApi());
            const engine = new WorkflowEngine(wf);

            const activityStarts = [];
            wf.on('activity:start', (meta) => activityStarts.push(meta));

            const server = createDashboardViewer(wf, { port: 18095, name: 'Persist Stop Test' });

            await withServer(server, async (port) => {
                const runPromise = engine.executeFile(fixture('test-stop-pending-agent.mjs'), {});
                runPromise.catch(() => {});

                await waitFor(() => activityStarts.length > 0);

                const { statusCode } = await httpPost(port, '/stop');
                assert.strictEqual(statusCode, 200);

                await assert.rejects(runPromise, () => true);

                await waitFor(() => readSprintLogFiles(dir).length > 0);

                const files = readSprintLogFiles(dir);
                assert.strictEqual(files.length, 1);
                const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sprint-logs', files[0]), 'utf-8'));
                assert.strictEqual(saved.status, 'cancelled');
            });
        });
    });

    test('a SIGINT delivered before "end" fires also results in a saved file (process.exit mocked)', async () => {
        await withTempCwd(async (dir) => {
            const wf = new FleetWorkflow(createHangingFleetApi());
            const engine = new WorkflowEngine(wf);

            const activityStarts = [];
            wf.on('activity:start', (meta) => activityStarts.push(meta));

            const server = createDashboardViewer(wf, { port: 18096, name: 'Persist SIGINT Test' });

            const originalExit = process.exit;
            let exitCode = null;
            process.exit = (code) => { exitCode = code; };

            try {
                await withServer(server, async (port) => {
                    const runPromise = engine.executeFile(fixture('test-stop-pending-agent.mjs'), {});
                    runPromise.catch(() => {});

                    await waitFor(() => activityStarts.length > 0);

                    // Simulate Ctrl-C arriving while the run is still live --
                    // i.e. before the workflow's own 'end' event would fire.
                    process.emit('SIGINT');

                    const files = readSprintLogFiles(dir);
                    assert.strictEqual(files.length, 1, 'SIGINT must trigger a best-effort save even mid-run');
                    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sprint-logs', files[0]), 'utf-8'));
                    assert.strictEqual(saved.status, 'running', 'state was saved before the workflow had a chance to end');
                    assert.strictEqual(exitCode, 130, 'SIGINT handler must still terminate the process (conventional 128+SIGINT code)');

                    // The mocked process.exit() above is a no-op, so (unlike a
                    // real SIGINT) the process keeps running past this point
                    // and the hanging dispatch is still in flight. It would
                    // never settle on its own (createHangingFleetApi() only
                    // rejects when its AbortSignal fires) -- request a
                    // cooperative stop so runPromise actually resolves and the
                    // test process has no dangling pending work left over.
                    wf.requestStop('test cleanup');
                    await assert.rejects(runPromise, () => true);
                });
            } finally {
                process.exit = originalExit;
            }
        });
    });

    test('POST /save_logs triggers the same save on demand (manual/scriptable trigger)', async () => {
        await withTempCwd(async (dir) => {
            const wf = new FleetWorkflow(createMockFleetApi());
            const engine = new WorkflowEngine(wf);
            const server = createDashboardViewer(wf, { port: 18098, name: 'Persist Manual Endpoint Test' });

            await withServer(server, async (port) => {
                // No 'end' yet -- run is still "running". A manual /save_logs
                // call must still produce a file (on-demand, not just at
                // finish/stop/exit).
                const runPromise = engine.executeFile(fixture('test-end-event-success.mjs'), {});

                assert.strictEqual(readSprintLogFiles(dir).length, 0, 'no file should exist before /save_logs or end');

                const { statusCode } = await httpPost(port, '/save_logs');
                assert.strictEqual(statusCode, 200);

                const files = readSprintLogFiles(dir);
                assert.strictEqual(files.length, 1, 'expected exactly one file after POST /save_logs');
                const saved = JSON.parse(fs.readFileSync(path.join(dir, 'sprint-logs', files[0]), 'utf-8'));
                assert.strictEqual(typeof saved.workflowName, 'string');

                await runPromise;

                // The run's own 'end' event fires after /save_logs already
                // persisted -- shares the idempotency guard, so still exactly
                // one file (no duplicate write for the same run).
                assert.deepStrictEqual(readSprintLogFiles(dir), files);
            });
        });
    });

    test('no double-write when both "end" and a subsequent SIGINT occur for the same run', async () => {
        await withTempCwd(async (dir) => {
            const wf = new FleetWorkflow(createMockFleetApi());
            const engine = new WorkflowEngine(wf);
            const server = createDashboardViewer(wf, { port: 18097, name: 'Persist Idempotency Test' });

            const originalExit = process.exit;
            let exitCalled = false;
            process.exit = () => { exitCalled = true; };

            try {
                await withServer(server, async (port) => {
                    await engine.executeFile(fixture('test-end-event-success.mjs'), {});

                    const filesAfterEnd = readSprintLogFiles(dir);
                    assert.strictEqual(filesAfterEnd.length, 1);

                    // Mimic bin/cli.mjs's failure-grace-window race: a SIGINT
                    // arriving moments after 'end' already fired for this run.
                    process.emit('SIGINT');

                    const filesAfterSignal = readSprintLogFiles(dir);
                    assert.deepStrictEqual(filesAfterSignal, filesAfterEnd, 'must not write a second file for the same run');
                    assert.ok(exitCalled, 'the SIGINT handler must still run (and attempt to exit) even when the save itself was skipped');
                });
            } finally {
                process.exit = originalExit;
            }
        });
    });
});
