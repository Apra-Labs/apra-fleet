// =============================================================================
// The dashboard credential cannot be harvested from an unauthenticated GET.
// =============================================================================
//
// apra-fleet-50j6.11 (test for apra-fleet-50j6.6). The open, read-only pages
// -- GET /, every extraIndexPaths entry (the Sprints nav path), and the /ui
// project page -- used to answer an UNAUTHENTICATED request with
// `Set-Cookie: se_token=<service token>`, so any process able to reach the
// loopback port could read the token (which may be the shared fleet key).
//
// Everything below runs against a REAL listening supervisor built through
// the shared harness, with the PRODUCTION route registrations
// (registerDashboardRoutes, registerUiRoutes + createProjectsPageHandler) and
// the production guard -- isAuthorized() is never mocked. Only the dashboard
// view model is a stub (its HTML content is irrelevant to the credential
// behaviour under test), and the live-stop route is a stand-in whose handler
// only runs if the guard let the request through.
// =============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { createTestSupervisor } from './helpers/supervisor-harness.mjs';
import { sendJson } from '../src/supervisor/server.mjs';
import { registerDashboardRoutes } from '../src/supervisor/dashboard.mjs';
import { registerUiRoutes } from '../src/registration/ui-placeholder.mjs';
import { createProjectsPageHandler } from '../src/registration/project-page.mjs';
import { SPRINTS_UI_PATH, PROJECTS_UI_PATH } from '../src/registration/manifest.mjs';

const silentLogger = { log() {}, warn() {}, error() {} };

function request(port, method, urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf-8') }));
        });
        req.on('error', reject);
        req.end();
    });
}

/** Node returns `set-cookie` as an array; normalise to a list of cookie pairs ("name=value"). */
function cookiePairs(setCookie) {
    const list = Array.isArray(setCookie) ? setCookie : (typeof setCookie === 'string' ? [setCookie] : []);
    return list.map((c) => c.split(';')[0].trim()).filter(Boolean);
}

/** The value of the se_token cookie in a Set-Cookie header, or null. */
function seTokenFrom(setCookie) {
    for (const pair of cookiePairs(setCookie)) {
        const eq = pair.indexOf('=');
        if (pair.slice(0, eq) === 'se_token') return pair.slice(eq + 1);
    }
    return null;
}

describe('dashboard credential cannot be harvested from an unauthenticated GET', () => {
    let tmpRoot;
    let port;
    let token;
    let supervisor;
    let liveStopCalls = 0;

    before(async () => {
        tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'se-cookie-harvest-'));
        const dataDir = path.join(tmpRoot, 'data');
        const home = path.join(tmpRoot, 'home');
        await fsp.mkdir(dataDir, { recursive: true });
        await fsp.mkdir(home, { recursive: true });
        const built = await createTestSupervisor({ dataDir, home, port: 0, logger: silentLogger });
        supervisor = built.supervisor;
        token = built.token;
        const stubDashboard = {
            renderIndexPage: async () => '<!DOCTYPE html>\n<html><head><title>t</title></head>\n<body>\n<h1>index</h1>\n</body></html>\n',
            buildSprintViews: async () => [],
            onChange: () => () => {},
        };
        registerDashboardRoutes(supervisor, stubDashboard, { extraIndexPaths: [SPRINTS_UI_PATH] });
        registerUiRoutes(supervisor, { staticHandler: createProjectsPageHandler({ token: supervisor.token }) });
        supervisor.route('POST', '/sprints/:id/live/stop', async (req, res) => {
            liveStopCalls += 1;
            sendJson(res, 200, { stopped: true });
        });
        ({ port } = await supervisor.start());
    });

    after(async () => {
        if (supervisor) await supervisor.stop('test');
        if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
    });

    test('harvest attempt: unauthenticated GET of every open page sets no cookie, and nothing it returned authorizes /api/health', async () => {
        for (const page of ['/', SPRINTS_UI_PATH, PROJECTS_UI_PATH]) {
            // eslint-disable-next-line no-await-in-loop
            const res = await request(port, 'GET', page);
            assert.equal(res.status, 200, `${page} must stay open`);
            assert.equal(res.headers['set-cookie'], undefined, `${page} must not set any cookie on an unauthenticated GET`);
            assert.ok(!res.text.includes(token), `${page} must not embed the token in its body`);
            // Replay whatever cookie it DID hand out (none expected) -- it must
            // not open a guarded route.
            const replayed = cookiePairs(res.headers['set-cookie']).join('; ');
            // eslint-disable-next-line no-await-in-loop
            const health = await request(port, 'GET', '/api/health', replayed ? { cookie: replayed } : {});
            assert.equal(health.status, 401, `replaying ${page}'s cookies must not authorize /api/health`);
        }
    });

    test('exchange: the correct token 302s token-free with a derived cookie that authorizes guarded routes', async () => {
        const ex = await request(port, 'GET', `/?token=${encodeURIComponent(token)}`);
        assert.equal(ex.status, 302);
        assert.ok(typeof ex.headers.location === 'string', 'expected a Location header');
        assert.ok(!ex.headers.location.includes(token), 'the redirect target must not carry the token');
        assert.ok(!ex.headers.location.includes('token='), 'the redirect target must drop the token parameter');
        const cookie = seTokenFrom(ex.headers['set-cookie']);
        assert.ok(cookie, 'the exchange must set the se_token cookie');
        assert.notEqual(cookie, token, 'the cookie must not be the raw token');

        const health = await request(port, 'GET', '/api/health', { cookie: `se_token=${cookie}` });
        assert.equal(health.status, 200, 'the derived cookie must authorize GET /api/health');

        const before = liveStopCalls;
        const stop = await request(port, 'POST', '/sprints/x/live/stop', { cookie: `se_token=${cookie}` });
        assert.notEqual(stop.status, 401, 'the derived cookie must pass the guard on POST /sprints/x/live/stop');
        assert.equal(liveStopCalls, before + 1, 'the guarded handler must actually run');
    });

    test('exchange: a wrong token sets no cookie', async () => {
        const wrong = await request(port, 'GET', `/?token=${'0'.repeat(token.length)}`);
        assert.notEqual(wrong.status, 302);
        assert.equal(wrong.headers['set-cookie'], undefined);
        const empty = await request(port, 'GET', '/?token=');
        assert.equal(empty.headers['set-cookie'], undefined);
    });

    test('raw token as the se_token cookie -> 401; raw token as Bearer -> 200', async () => {
        const rawCookie = await request(port, 'GET', '/api/health', { cookie: `se_token=${token}` });
        assert.equal(rawCookie.status, 401, 'the raw token must not be accepted on the cookie path');
        const bearer = await request(port, 'GET', '/api/health', { authorization: `Bearer ${token}` });
        assert.equal(bearer.status, 200, 'the raw token must keep working as a bearer');
    });
});
