import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { createDashboardViewer } from '@apralabs/apra-fleet-workflow/viewer';
import { createLiveProxy, registerLiveRoutes } from '../src/supervisor/proxy.mjs';
import { deriveUpstreamCredential } from '@apralabs/apra-fleet-client/auth/local-token';
import { PACKAGE_ID } from '../src/registration/manifest.mjs';
import { createTestSupervisor } from './helpers/supervisor-harness.mjs';

// (apra-fleet-4v8r.2) A supervisor-authenticated POST /sprints/:id/live/pause
// and /stop must still drive a child viewer that guards its control POSTs with
// the service token: the proxy injects the bearer upstream. Callers use the
// harness bearer headers(), never the se_token cookie.

let cwdOriginal;
let cwdTemp;
beforeEach(() => {
    // The viewer's control handlers flush run state under process.cwd().
    cwdTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-proxy-auth-cwd-'));
    cwdOriginal = process.cwd();
    process.chdir(cwdTemp);
});
afterEach(() => {
    process.chdir(cwdOriginal);
    fs.rmSync(cwdTemp, { recursive: true, force: true });
});

function post(port, urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
    });
}

async function setup(proxyTokenMode) {
    const h = await createTestSupervisor();
    const wf = new FleetWorkflow({});
    const calls = { stop: 0, pause: 0 };
    wf.requestStop = () => { calls.stop++; };
    wf.requestPause = () => { calls.pause++; };
    const origLog = console.log;
    console.log = () => {};
    let child;
    try {
        child = createDashboardViewer(wf, { port: 0, serviceToken: h.token });
        await new Promise((resolve, reject) => { child.once('listening', resolve); child.once('error', reject); });
    } finally {
        console.log = origLog;
    }
    const childPort = child.address().port;
    const proxy = createLiveProxy({
        resolvePort: (id) => (id === 'sprint-a' ? childPort : undefined),
        token: proxyTokenMode === 'inject' ? h.token : undefined,
    });
    registerLiveRoutes(h.supervisor, proxy);
    await h.supervisor.start();
    const port = h.supervisor.server.address().port;
    const teardown = async () => {
        await h.supervisor.stop('test');
        await h.dispose();
        await new Promise((resolve) => child.close(resolve));
    };
    return { calls, port, h, teardown };
}

describe('supervisor live proxy -> token-guarded child viewer', () => {
    test('authenticated /live/pause and /live/stop reach the child (proxy injects the bearer)', async () => {
        const t = await setup('inject');
        try {
            // The supervisor accepts the derived 'se' credential as a bearer, but
            // that is NOT the child's token: the proxy must replace whatever the
            // caller sent with the supervisor's own service token.
            const hdr = {
                authorization: 'Bearer ' + deriveUpstreamCredential(t.h.token, PACKAGE_ID),
                cookie: 'se_token=something-else',
            };
            assert.strictEqual(await post(t.port, '/sprints/sprint-a/live/pause', hdr), 200);
            assert.strictEqual(await post(t.port, '/sprints/sprint-a/live/stop', hdr), 200);
            assert.strictEqual(t.calls.pause, 1);
            assert.strictEqual(t.calls.stop, 1);
        } finally {
            await t.teardown();
        }
    });

    test('control POST through a supervisor with the plain harness bearer also reaches the child', async () => {
        const t = await setup('inject');
        try {
            assert.strictEqual(await post(t.port, '/sprints/sprint-a/live/pause', t.h.headers()), 200);
            assert.strictEqual(t.calls.pause, 1);
        } finally {
            await t.teardown();
        }
    });
});
