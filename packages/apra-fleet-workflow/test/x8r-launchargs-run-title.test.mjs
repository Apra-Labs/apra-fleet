import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { createDashboardViewer } from '../src/viewer/index.mjs';
import { buildRunTitle } from '../src/viewer/run-title.mjs';

// apra-fleet-x8r.9: end-to-end coverage that a fleet-sprint-shaped
// `launchArgs` object, passed into createDashboardViewer(), actually
// produces a populated header run-title sentence -- pinning the FULL chain
// (opts.launchArgs -> state.args -> buildRunTitle(state)) in one test,
// rather than trusting apra-fleet-workflow-sprint-state.test.mjs (which
// only pins state.args === launchArgs) and viewer-run-title.test.mjs (which
// only pins buildRunTitle's own rendering) to compose correctly together.
//
// This was previously only verified by hand (apra-fleet-dm5.2's close
// note): boot the viewer, fetch GET /state, confirm buildRunTitle(state)
// renders 'win-dev1 working apra-fleet-x8r, apra-fleet-dm5 (P1/P2/P3)'.

function createMockFleetApi() {
    return {
        async executePrompt(payload) {
            return { content: [{ text: `echo: ${payload.prompt}` }] };
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
    // See apra-fleet-workflow-sprint-state.test.mjs's withServer() for why
    // the .listening guard is needed: createDashboardViewer() already calls
    // server.listen() synchronously, so the 'listening' event can fire
    // before we get a chance to attach our own listener.
    if (!server.listening) {
        await new Promise((resolve, reject) => {
            server.once('listening', resolve);
            server.once('error', reject);
        });
    }
    try {
        return await fn(server.address().port);
    } finally {
        await new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
        });
    }
}

test('apra-fleet-x8r.9: a fleet-sprint-shaped launchArgs object produces a fully populated header run-title sentence', async () => {
    const wf = new FleetWorkflow(createMockFleetApi());
    // Listen on port 0 -- never a fixed port -- so this test cannot collide
    // with other tests/servers under parallel test concurrency.
    const server = createDashboardViewer(wf, {
        port: 0,
        name: 'x8r.9 launchArgs Test',
        launchArgs: {
            members: ['win-dev1'],
            targetIssues: ['apra-fleet-x8r', 'apra-fleet-dm5'],
            goal: 'P1/P2/P3'
        }
    });

    await withServer(server, async (port) => {
        const state = JSON.parse(await httpGet(port, '/state'));

        assert.deepStrictEqual(
            state.args,
            {
                members: ['win-dev1'],
                targetIssues: ['apra-fleet-x8r', 'apra-fleet-dm5'],
                goal: 'P1/P2/P3'
            },
            'GET /state must carry opts.launchArgs through unchanged as state.args'
        );

        const title = buildRunTitle(state);
        assert.equal(
            title,
            'win-dev1 working apra-fleet-x8r, apra-fleet-dm5 (P1/P2/P3)',
            'buildRunTitle(state) must render the full sentence: member name, both bead ids, and the goal band'
        );
    });
});

test('apra-fleet-x8r.9: no launchArgs falls back to the plain workflow name, with no "undefined", empty parens, or dangling separators', async () => {
    const wf = new FleetWorkflow(createMockFleetApi());
    const server = createDashboardViewer(wf, {
        port: 0,
        name: 'x8r.9 No LaunchArgs Test'
        // launchArgs deliberately omitted
    });

    await withServer(server, async (port) => {
        const state = JSON.parse(await httpGet(port, '/state'));

        assert.strictEqual(state.args, null, 'state.args must be null when no launchArgs was passed');

        const title = buildRunTitle(state);
        assert.equal(title, 'x8r.9 No LaunchArgs Test', 'must fall back to the plain workflow name');
        assert.ok(!title.includes('undefined'), `title must never contain "undefined", got: ${title}`);
        assert.ok(!/\(\s*\)/.test(title), `title must never contain an empty parenthetical, got: ${title}`);
        assert.ok(!/(,\s*$|,\s*\(|working\s*$|working\s*\()/.test(title), `title must never contain a dangling separator, got: ${title}`);
    });
});
