import { test, describe } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import path from 'path';
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

describe('apra-fleet-unw.10: no process.exit in the /stop handler (source grep)', () => {
    test('src/viewer/index.mjs contains no live process.exit() call', async () => {
        const fs = await import('fs/promises');
        const source = await fs.readFile(path.join(__dirname, '../src/viewer/index.mjs'), 'utf-8');
        // Filter out comment lines that merely reference process.exit for
        // documentation purposes; only a real call site (i.e. `process.exit(`
        // outside of a `//` comment) should fail this.
        const liveCalls = source
            .split('\n')
            .filter((line) => !line.trim().startsWith('//'))
            .filter((line) => /process\.exit\s*\(/.test(line));
        assert.deepStrictEqual(liveCalls, [], `expected no live process.exit() calls, found: ${JSON.stringify(liveCalls)}`);
    });
});
