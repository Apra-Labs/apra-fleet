import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FleetWorkflow } from '../src/workflow/index.mjs';
import { createDashboardViewer } from '../src/viewer/index.mjs';

// apra-fleet-i9ag.15.9: regression coverage for the SILENT PORT HIJACK that
// made viewer routes answer an intermittent, load-dependent 404 under a full
// concurrent test run (observed on GET /beads/:id/description, which the
// handler answers with an unconditional 302 -- so the 404 provably did not
// come from the viewer at all).
//
// Root cause: createDashboardViewer() used to call `server.listen(port, cb)`
// with no host, binding the OS WILDCARD address. A wildcard bind does not
// give the process exclusive ownership of `127.0.0.1:<port>`. Another
// process can bind that same port on the loopback address specifically, the
// bind succeeds (both sockets carry SO_REUSEADDR), and the kernel's
// most-specific-match routing then hands the newcomer EVERY loopback
// connection aimed at the dashboard. Nothing errors on either side: the
// viewer stays "listening" on a port it no longer serves, and the client
// silently gets the impostor's responses.
//
// This is a listener-level defect, not a per-route one -- which is why these
// tests assert the bind contract itself (exclusive loopback ownership)
// rather than re-asserting one route's status code: the contract covers the
// generic /extensions/:extId/detail/:itemId route, the /beads/:id/description
// BOUNDARY-COMPAT alias, /activities/:id/output, /state and every future
// route at once.

function createMockFleetApi() {
    return {
        async executePrompt() { return { content: [{ text: 'ok' }] }; },
        async executeCommand() { return { content: [{ text: 'ok' }], isError: false }; }
    };
}

function httpGetFull(port, urlPath, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        http.get({ host, port, path: urlPath }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: data }));
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

/** Attempt a competing bind; resolves the error code, or null if the bind succeeded. */
function tryBind(opts) {
    return new Promise((resolve) => {
        const rival = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
        rival.once('error', (err) => resolve({ code: err.code, close: async () => {} }));
        rival.listen(opts, () => resolve({
            code: null,
            close: () => new Promise((done) => rival.close(done))
        }));
    });
}

// createDashboardViewer() persists sprint state under process.cwd() -- keep
// every test in this file against a fresh temp cwd.
async function inTempCwd(fn) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-viewer-bind-test-'));
    const original = process.cwd();
    process.chdir(temp);
    try {
        return await fn();
    } finally {
        process.chdir(original);
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

describe('apra-fleet-i9ag.15.9: the viewer owns its loopback port exclusively', () => {
    test('a second listener cannot take the viewer\'s loopback port -- it fails loudly with EADDRINUSE instead of silently splitting traffic', async () => {
        await inTempCwd(async () => {
            const wf = new FleetWorkflow(createMockFleetApi());
            const server = createDashboardViewer(wf, { port: 0, name: 'Bind Exclusivity Test' });

            await withServer(server, async (port) => {
                const rival = await tryBind({ port, host: '127.0.0.1' });
                try {
                    assert.equal(
                        rival.code,
                        'EADDRINUSE',
                        'a competing loopback bind on the live viewer\'s port must be REFUSED. If it succeeds, the ' +
                        'viewer is bound to the wildcard address again and every loopback request to it can be ' +
                        'silently answered by the impostor instead (the intermittent-404 bug this covers).'
                    );
                } finally {
                    await rival.close();
                }
            });
        });
    });

    test('even when a wildcard listener does grab the same port, the viewer still answers every loopback request itself', async () => {
        await inTempCwd(async () => {
            const wf = new FleetWorkflow(createMockFleetApi());
            const server = createDashboardViewer(wf, { port: 0, name: 'Bind Precedence Test' });

            await withServer(server, async (port) => {
                // A wildcard bind on an already-loopback-bound port is
                // allowed by the OS; what matters is that the more specific
                // (loopback) socket -- ours -- keeps winning loopback
                // traffic. Skipped if the platform refuses the bind outright,
                // which is an even stronger guarantee.
                const rival = await tryBind({ port });
                try {
                    // A route the viewer answers unconditionally, and that
                    // the rival would answer 404 -- exactly the reported
                    // symptom (404 where 302 was expected).
                    const alias = await httpGetFull(port, '/beads/bd-1/description');
                    assert.equal(alias.statusCode, 302, 'the viewer, not the rival wildcard listener, must answer loopback requests');
                    assert.equal(alias.headers.location, '/extensions/beads/detail/bd-1');

                    // Same guarantee for the generic on-demand-detail route,
                    // whose 404 is a legitimate answer and would therefore
                    // hide a hijack entirely.
                    const generic = await httpGetFull(port, '/state');
                    assert.equal(generic.statusCode, 200, 'GET /state must be answered by the viewer too');
                } finally {
                    await rival.close();
                }
            });
        });
    });

    test('the bind address is explicit and overridable via opts.host, and the dashboard is reachable at localhost as advertised', async () => {
        await inTempCwd(async () => {
            const wf = new FleetWorkflow(createMockFleetApi());
            const server = createDashboardViewer(wf, { port: 0, host: '127.0.0.1', name: 'Bind Host Option Test' });

            await withServer(server, async (port) => {
                const addr = server.address();
                assert.equal(addr.address, '127.0.0.1', 'an explicit opts.host must be the address actually bound');

                const viaName = await httpGetFull(port, '/beads/bd-1/description', 'localhost');
                assert.equal(viaName.statusCode, 302, 'the http://localhost:<port> URL the viewer logs must still resolve to it');
            });
        });
    });

    test('with no opts.host at all, the viewer defaults to loopback rather than the wildcard address', async () => {
        await inTempCwd(async () => {
            const wf = new FleetWorkflow(createMockFleetApi());
            const server = createDashboardViewer(wf, { port: 0, name: 'Bind Default Host Test' });

            await withServer(server, async () => {
                const addr = server.address();
                assert.equal(
                    addr.address,
                    '127.0.0.1',
                    'default bind must be loopback. "::" or "0.0.0.0" here means the wildcard bind is back, which both ' +
                    'reopens the silent port-hijack race and exposes an unauthenticated per-sprint dashboard on every interface.'
                );
            });
        });
    });
});
