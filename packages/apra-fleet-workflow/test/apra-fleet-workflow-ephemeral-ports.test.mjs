import { test, describe } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { createDashboardViewer } from '../src/viewer/index.mjs';

// Tests for apra-fleet-eft.13.4 (part 1 of 2 -- see
// apra-fleet-workflow-viewer-lifecycle.test.mjs's sibling coverage for part
// 2, the dispatch-exception process-tree-kill path, which lives in the main
// package's tests/execute-prompt.test.ts instead since that is where
// dispatch-exception retry itself is implemented).
//
// Regression coverage for the EADDRINUSE cascade fixed by apra-fleet-eft.13
// (f5c03428) and completed by apra-fleet-eft.13.1/13.2: createDashboardViewer
// test/manual callers used to bind hardcoded fixed ports (18080-18098 in
// test-runner.test.mjs / apra-fleet-workflow-viewer-lifecycle.test.mjs,
// 18099-18101 in apra-fleet-workflow-debounced-writer.test.mjs). An orphaned
// server left over from a prior, abandoned run (e.g. a doer's own
// backgrounded test-server process surviving a dispatch-exception retry,
// apra-fleet-02s.1) would still be holding one of those ports, so any
// back-to-back or overlapping retry of the same test file collided with
// EADDRINUSE -- and the retry itself then timed out again, cascading into
// the sprint-wide MCP transport timeout apra-fleet-eft.13 exists to fix.
//
// These tests recreate the collision precondition directly: occupy every one
// of the exact former fixed ports with plain listeners (simulating the
// orphan), then prove createDashboardViewer({ port: 0 }) never tries to bind
// any of them -- across back-to-back, overlapping, and repeated runs of what
// used to be a fixed-port test file. If the ephemeral-port fix ever
// regressed (e.g. someone reintroduced a fixed port, or `opts.port || 8080`
// silently coerced `0` back to a default), one of these servers would either
// fail to start (EADDRINUSE, since the "orphan" already holds that port) or
// collide with its sibling -- both of which fail the assertions below.

const FORMER_FIXED_PORTS = Array.from({ length: 18101 - 18080 + 1 }, (_, i) => 18080 + i); // 18080-18101 inclusive

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

function waitListening(server) {
    return new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
}

async function closeServer(server) {
    await new Promise((resolve) => server.close(resolve));
}

/** Bind a plain listener on every historically-fixed-port, simulating the orphaned leftover servers that used to cause EADDRINUSE. */
async function occupyFormerFixedPorts() {
    const servers = [];
    for (const port of FORMER_FIXED_PORTS) {
        const server = http.createServer((_req, res) => res.end('orphan'));
        server.listen(port, '127.0.0.1');
        await waitListening(server);
        servers.push(server);
    }
    return {
        async release() {
            await Promise.all(servers.map(closeServer));
        }
    };
}

describe('apra-fleet-eft.13.4: EADDRINUSE regression -- ephemeral viewer ports survive orphaned former-fixed-port holders', () => {
    test('back-to-back runs of a formerly-fixed-port test file each bind a distinct ephemeral port with no EADDRINUSE, even while every old fixed port (18080-18101) is held by an orphan', async () => {
        const occupied = await occupyFormerFixedPorts();
        try {
            const wf1 = new FleetWorkflow(createMockFleetApi());
            const server1 = createDashboardViewer(wf1, { port: 0, name: 'Back-to-back Run 1' });
            await waitListening(server1);
            const port1 = server1.address().port;
            assert.ok(!FORMER_FIXED_PORTS.includes(port1), `run 1 must not bind a former fixed port, got ${port1}`);
            await closeServer(server1);

            const wf2 = new FleetWorkflow(createMockFleetApi());
            const server2 = createDashboardViewer(wf2, { port: 0, name: 'Back-to-back Run 2' });
            await waitListening(server2);
            const port2 = server2.address().port;
            assert.ok(!FORMER_FIXED_PORTS.includes(port2), `run 2 must not bind a former fixed port, got ${port2}`);
            await closeServer(server2);
        } finally {
            await occupied.release();
        }
    });

    test('overlapping runs (both servers live simultaneously) bind two distinct ephemeral ports, colliding with neither each other nor an orphaned former fixed port', async () => {
        const occupied = await occupyFormerFixedPorts();
        try {
            const wf1 = new FleetWorkflow(createMockFleetApi());
            const wf2 = new FleetWorkflow(createMockFleetApi());
            const server1 = createDashboardViewer(wf1, { port: 0, name: 'Overlap Run A' });
            const server2 = createDashboardViewer(wf2, { port: 0, name: 'Overlap Run B' });

            await Promise.all([waitListening(server1), waitListening(server2)]);

            const port1 = server1.address().port;
            const port2 = server2.address().port;

            assert.notStrictEqual(port1, port2, 'two concurrently-live viewer servers must bind distinct ephemeral ports');
            assert.ok(!FORMER_FIXED_PORTS.includes(port1), `overlap run A must not bind a former fixed port, got ${port1}`);
            assert.ok(!FORMER_FIXED_PORTS.includes(port2), `overlap run B must not bind a former fixed port, got ${port2}`);

            await Promise.all([closeServer(server1), closeServer(server2)]);
        } finally {
            await occupied.release();
        }
    });

    test('repeated runs (5x) of the same formerly-fixed-port test file never collide with each other or with an orphaned former fixed port', async () => {
        const occupied = await occupyFormerFixedPorts();
        try {
            const ports = [];
            for (let i = 0; i < 5; i++) {
                const wf = new FleetWorkflow(createMockFleetApi());
                const server = createDashboardViewer(wf, { port: 0, name: `Repeat Run ${i}` });
                await waitListening(server);
                ports.push(server.address().port);
                await closeServer(server);
            }
            assert.strictEqual(ports.length, 5);
            for (const p of ports) {
                assert.ok(!FORMER_FIXED_PORTS.includes(p), `repeated run must not bind a former fixed port, got ${p}`);
            }
        } finally {
            await occupied.release();
        }
    });
});
