// =============================================================================
// The dashboard credential cannot be harvested from an unauthenticated GET.
// =============================================================================
//
// apra-fleet-50j6.11 (test for apra-fleet-50j6.6), extended by
// apra-fleet-50j6.12: sign-in is a same-origin POST of a paste-token form;
// a ?token= in a page URL never sets a cookie. The open, read-only pages
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

function request(port, method, urlPath, headers = {}, body = undefined) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf-8') }));
        });
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

/** POST the paste-token sign-in form the way a same-origin browser does. */
function postSignIn(port, fields, extraHeaders = {}) {
    const body = new URLSearchParams(fields).toString();
    return request(port, 'POST', '/signin', {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        origin: `http://127.0.0.1:${port}`,
        'sec-fetch-site': 'same-origin',
        ...extraHeaders,
    }, body);
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
        registerUiRoutes(supervisor, { staticHandler: createProjectsPageHandler({ token: () => supervisor.token }) });
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

    // apra-fleet-50j6.12: the token must never travel in a URL. A page
    // request carrying ?token= -- even the CORRECT token -- sets no cookie
    // and answers 400 with the sign-in form.
    test('GET <page>?token=<correct token> sets no cookie and answers 400 with the sign-in form', async () => {
        for (const page of ['/', SPRINTS_UI_PATH, PROJECTS_UI_PATH]) {
            // eslint-disable-next-line no-await-in-loop
            const res = await request(port, 'GET', `${page}?token=${encodeURIComponent(token)}`);
            assert.equal(res.status, 400, `${page}?token= must be refused`);
            assert.equal(res.headers['set-cookie'], undefined, `${page}?token= must not set a cookie`);
            assert.ok(!res.text.includes(token), `${page}?token= must not echo the token`);
            assert.match(res.text, /<form[^>]*method="post"[^>]*action="\/signin"/, `${page}?token= must offer the sign-in form`);
        }
        const empty = await request(port, 'GET', '/?token=');
        assert.equal(empty.headers['set-cookie'], undefined);
    });

    test('unauthenticated page view carries the paste-token form posting to /signin, not a ?token= instruction', async () => {
        const res = await request(port, 'GET', '/');
        assert.match(res.text, /<form[^>]*method="post"[^>]*action="\/signin"/);
        assert.match(res.text, /<input type="password" name="token"/);
        assert.ok(!res.text.includes('?token='), 'the notice must not tell the operator to put the token in a URL');
    });

    test('POST /signin: the correct token 303s back with a derived cookie that authorizes guarded routes', async () => {
        const ex = await postSignIn(port, { token, next: `${SPRINTS_UI_PATH}?token=leak&x=1` });
        assert.equal(ex.status, 303);
        assert.equal(ex.headers.location, `${SPRINTS_UI_PATH}?x=1`, 'redirects to next with any token parameter dropped');
        const cookie = seTokenFrom(ex.headers['set-cookie']);
        assert.ok(cookie, 'sign-in must set the se_token cookie');
        assert.notEqual(cookie, token, 'the cookie must not be the raw token');
        const setCookie = Array.isArray(ex.headers['set-cookie']) ? ex.headers['set-cookie'][0] : ex.headers['set-cookie'];
        assert.match(setCookie, /; SameSite=Strict/);
        assert.match(setCookie, /; HttpOnly/);

        const health = await request(port, 'GET', '/api/health', { cookie: `se_token=${cookie}` });
        assert.equal(health.status, 200, 'the derived cookie must authorize GET /api/health');

        const before = liveStopCalls;
        const stop = await request(port, 'POST', '/sprints/x/live/stop', { cookie: `se_token=${cookie}` });
        assert.notEqual(stop.status, 401, 'the derived cookie must pass the guard on POST /sprints/x/live/stop');
        assert.equal(liveStopCalls, before + 1, 'the guarded handler must actually run');
    });

    test('POST /signin: a hostile next path never redirects off-origin', async () => {
        for (const next of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', 'relative']) {
            // eslint-disable-next-line no-await-in-loop
            const ex = await postSignIn(port, { token, next });
            assert.equal(ex.status, 303);
            assert.equal(ex.headers.location, '/', `next=${next} must fall back to /`);
        }
    });

    test('POST /signin: a wrong or empty token answers 401 with no cookie', async () => {
        for (const presented of ['0'.repeat(token.length), token.slice(0, -1), '', `${token}x`]) {
            // eslint-disable-next-line no-await-in-loop
            const wrong = await postSignIn(port, { token: presented });
            assert.equal(wrong.status, 401, `token of length ${presented.length} must be rejected`);
            assert.equal(wrong.headers['set-cookie'], undefined);
        }
    });

    test('POST /signin: a cross-origin request is refused with no cookie, even with the correct token', async () => {
        const hostile = [
            { origin: 'http://evil.example' },
            { origin: `http://evil.example:${port}` },
            { origin: 'null' },
            { origin: `https://127.0.0.1:${port}` },
            { origin: `http://127.0.0.1:${port + 1}` },
            { 'sec-fetch-site': 'cross-site' },
            { 'sec-fetch-site': 'same-site' },
        ];
        for (const headers of hostile) {
            // eslint-disable-next-line no-await-in-loop
            const res = await postSignIn(port, { token }, headers);
            assert.equal(res.status, 403, `expected 403 for ${JSON.stringify(headers)}`);
            assert.equal(res.headers['set-cookie'], undefined, `no cookie for ${JSON.stringify(headers)}`);
        }
    });

    test('POST /signin: a non-form body is refused with no cookie', async () => {
        const body = JSON.stringify({ token });
        const res = await request(port, 'POST', '/signin', {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            origin: `http://127.0.0.1:${port}`,
        }, body);
        assert.equal(res.status, 415);
        assert.equal(res.headers['set-cookie'], undefined);
    });

    test('raw token as the se_token cookie -> 401; raw token as Bearer -> 200', async () => {
        const rawCookie = await request(port, 'GET', '/api/health', { cookie: `se_token=${token}` });
        assert.equal(rawCookie.status, 401, 'the raw token must not be accepted on the cookie path');
        const bearer = await request(port, 'GET', '/api/health', { authorization: `Bearer ${token}` });
        assert.equal(bearer.status, 200, 'the raw token must keep working as a bearer');
    });
});
