import { test, describe } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { WorkflowEngine } from '../src/workflow/engine.mjs';
import { createDashboardViewer } from '../src/viewer/index.mjs';

// This file replaces the old test-runner.mjs, which:
//   - imported a nonexistent `startViewer` export (src/viewer/index.mjs only
//     exports `createDashboardViewer`) and called nonexistent
//     viewer.markComplete()/viewer.stop() methods, and
//   - required a live MCP server on 127.0.0.1:7523 via StreamableHttpTransport.
// It now runs entirely in-process against a mock fleetApi (no network, no
// live MCP server) and asserts on actual results instead of console logging.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KNOWN_MEMBERS = new Set(['fleet-dev', 'apra-pm']);

/**
 * A minimal in-process stand-in for `ApraFleet` (see
 * ../src/fleet-client/api.mjs) that FleetWorkflow talks to via
 * executePrompt()/executeCommand(). No network or external process involved.
 */
function createMockFleetApi() {
    // apra-fleet-02s.3: a schema-repair re-ask now FORCES resume:true and
    // sends a lean reminder prompt (validation errors only), no longer a
    // self-contained echo of the original prompt -- so the prompt-prefix
    // matches below cannot classify a repair round's dispatch. Stick to
    // whichever branch the last FRESH (non-repair) call matched, mirroring
    // what a real resumed session actually is: the same logical exchange.
    let lastFreshBranch = null;
    return {
        async executePrompt(payload) {
            const memberKey = payload.member_name || payload.member_id;
            if (!KNOWN_MEMBERS.has(memberKey)) {
                return { content: [{ text: `Member "${memberKey}" not found.` }] };
            }

            const usage = { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 };
            const prompt = payload.prompt || '';

            let branch;
            if (payload.resume === true && lastFreshBranch) {
                branch = lastFreshBranch;
            } else if (prompt.includes('DO NOT OUTPUT VALID JSON')) {
                branch = 'garbage';
            } else if (prompt.startsWith('Output exactly {"test": 1}')) {
                branch = 'schema-post';
            } else if (prompt.includes('Give me a JSON object with a test parameter')) {
                branch = 'ok-value';
            } else {
                branch = 'default';
            }
            if (payload.resume !== true) lastFreshBranch = branch;

            if (branch === 'garbage') {
                return { content: [{ text: '{{{ [[[ "test": garbage ,,,' }], usage };
            }
            if (branch === 'schema-post') {
                return { content: [{ text: '{"test": 1}' }], usage };
            }
            if (branch === 'ok-value') {
                return { content: [{ text: JSON.stringify({ test: 'ok-value' }) }], usage };
            }

            return { content: [{ text: `Mock response to: ${prompt.slice(0, 60)}` }], usage };
        },

        async executeCommand(payload) {
            const memberKey = payload.member_name || payload.member_id;
            if (!KNOWN_MEMBERS.has(memberKey)) {
                return { content: [{ text: `Member "${memberKey}" not found.` }] };
            }

            if (payload.command && payload.command.includes('some_non_existent_binary_12345')) {
                return {
                    content: [{ text: `bash: ${payload.command}: command not found` }],
                    isError: true
                };
            }

            return { content: [{ text: payload.command }], isError: false };
        }
    };
}

function createEngine() {
    const wf = new FleetWorkflow(createMockFleetApi());
    return { wf, engine: new WorkflowEngine(wf) };
}

const fixture = (name) => path.join(__dirname, name);

describe('WorkflowEngine executing fixture scripts against a mock fleet API', () => {
    test('vetting warns but never blocks a risky script by default (advisory only, apra-fleet-unw.7)', async () => {
        const { engine } = createEngine();
        const originalWarn = console.warn;
        const warnings = [];
        console.warn = (...args) => warnings.push(args.join(' '));
        try {
            const result = await engine.executeFile(fixture('test-vetting.js'));
            assert.strictEqual(result.status, 'success');
        } finally {
            console.warn = originalWarn;
        }
        assert.ok(warnings.some((w) => w.includes('VettingEngine') && w.includes('flagged')), 'expected a VettingEngine warning to be logged even though execution proceeded');
    });

    test('vetting still runs and does not block when the legacy boolean forceOverrideRisk arg is passed', async () => {
        const { engine } = createEngine();
        await assert.doesNotReject(
            () => engine.executeFile(fixture('test-vetting.js'), {}, true)
        );
    });

    test('strict mode ({ strictVetting: true }) blocks a script flagged above the risk threshold', async () => {
        const { engine } = createEngine();
        await assert.rejects(
            () => engine.executeFile(fixture('test-vetting.js'), {}, { strictVetting: true }),
            /rejected by VettingEngine in strict mode/
        );
    });

    test('sequential() with continueOnError isolates a failing item', async () => {
        const { engine } = createEngine();
        const result = await engine.executeFile(fixture('test-edge-sequential.js'));
        assert.deepStrictEqual(result, { status: 'success' });
    });

    test('agent() throws when member_name/member_id is missing', async () => {
        const { engine } = createEngine();
        await assert.rejects(
            () => engine.executeFile(fixture('test-edge-agent-args.js')),
            /requires either member_name or member_id/
        );
    });

    test('command() failure propagates as a thrown error', async () => {
        const { engine } = createEngine();
        await assert.rejects(
            () => engine.executeFile(fixture('test-edge-command-fail.js')),
            /Command Failed/
        );
    });

    test('missing member throws a typed MemberNotFoundError (agent/command never return null)', async () => {
        const { engine } = createEngine();
        await assert.rejects(
            () => engine.executeFile(fixture('test-edge-missing-member.js')),
            /Member ".*" not found\./
        );
    });

    test('command + schema-driven agent + sequential + transform workflow', async () => {
        const { engine } = createEngine();
        const result = await engine.executeFile(fixture('test-command.js'));

        assert.strictEqual(result.status, 'success');
        assert.strictEqual(result.command, 'echo "Hello Apra User from Workflow Engine!"');
        assert.deepStrictEqual(result.agent, { test: 'ok-value' });
        assert.deepStrictEqual(result.sequential, ['Processed: apra', 'Processed: fleet']);
        assert.strictEqual(result.transform, 'APRA');
    });

    test('an invalid JSON Schema is rejected before dispatch', async () => {
        const { engine } = createEngine();
        await assert.rejects(
            () => engine.executeFile(fixture('test-schema-pre.js')),
            /Invalid JSON Schema/
        );
    });

    test('a schema-compliant-shape but out-of-range response fails post-validation', async () => {
        const { engine } = createEngine();
        await assert.rejects(
            () => engine.executeFile(fixture('test-schema-post.js')),
            /non-compliant JSON/
        );
    });

    test('unparseable LLM output fails JSON parsing', async () => {
        const { engine } = createEngine();
        await assert.rejects(
            () => engine.executeFile(fixture('test-schema-garbage.js')),
            /parseable JSON/
        );
    });
});

describe('createDashboardViewer', () => {
    test('serves the dashboard and reflects workflow activity over loopback only', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        // NOTE: createDashboardViewer uses `opts.port || 8080`, so port: 0 would
        // silently fall back to the default port rather than an OS-assigned
        // ephemeral one. Use a fixed high port on loopback instead; nothing
        // external is involved.
        const server = createDashboardViewer(wf, { port: 18080, name: 'Test Dashboard' });

        try {
            await new Promise((resolve, reject) => {
                server.once('listening', resolve);
                server.once('error', reject);
            });
            const { port } = server.address();

            wf.phase('Test Phase');
            wf.emit('activity:start', { id: 'a1', type: 'agent', label: 'test activity', startTime: Date.now() });
            wf.emit('activity:end', { id: 'a1', duration: 5, success: true });

            const indexBody = await httpGet(port, '/');
            assert.ok(indexBody.includes('Workflow Dashboard'));

            const stateBody = await httpGet(port, '/state');
            const state = JSON.parse(stateBody);
            assert.strictEqual(state.workflowName, 'Test Dashboard');
            assert.strictEqual(state.status, 'running');
            assert.ok(state.stats.activitiesCount >= 1);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});

function httpGet(port, urlPath) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}
