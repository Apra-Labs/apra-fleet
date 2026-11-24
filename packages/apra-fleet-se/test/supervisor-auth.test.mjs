// Supervisor authentication and route authorization (docs/supervisor-auth.md).
//
// Real supervisors (createSupervisor on ephemeral loopback ports) in
// trusted-front mode, verifying ES256 assertions minted here with Node's own
// crypto against a JWKS file in a temp dir, plus unit tests of the verifier,
// the caller classifier, configuration and the audit trail.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
    createAuthenticator, verifyAssertion, parseJwks, validateAuthConfig, resolveAuthConfig, AuthConfigError,
    isLoopbackAddress, isLoopbackBindHost, sanitizeForwardedPrefix, policyFor, authorizeRoute, LOCAL_IDENTITY,
} from '../src/supervisor/auth.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { createSprintController, registerSprintRoutes } from '../src/supervisor/api.mjs';
import { createReconciler, registerReservationRoutes } from '../src/supervisor/reconcile.mjs';
import { registerDoltMutexRoutes } from '../src/supervisor/dolt-mutex.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME, HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { parseServeArgs } from '../bin/serve.mjs';
import { readJsonBody, sendJson } from '../src/supervisor/server.mjs';

const ISS = 'https://front.example.com';
const AUD = 'fleet-supervisor';

function makeKey(kid) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    return { kid, privateKey, publicKey, jwk: { ...jwk, kid, alg: 'ES256', use: 'sig' } };
}

const b64u = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

function sign(key, claims, header = { alg: 'ES256', kid: key.kid, typ: 'JWT' }) {
    const h = b64u(header);
    const p = b64u(claims);
    const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key: key.privateKey, dsaEncoding: 'ieee-p1363' });
    return `${h}.${p}.${sig.toString('base64url')}`;
}

const nowS = () => Math.floor(Date.now() / 1000);
function claims(over = {}) {
    const now = nowS();
    return { iss: ISS, aud: AUD, sub: 'user-viewer', name: 'Viewer User', email: 'viewer@example.com', roles: ['viewer'], iat: now, exp: now + 60, jti: 'req-1', ...over };
}

function writeJwks(file, keys) {
    fs.writeFileSync(file, JSON.stringify({ keys: keys.map((k) => k.jwk) }));
}

function request(port, method, urlPath, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const h = { ...headers };
        if (data) { h['content-length'] = data.length; if (!h['content-type']) h['content-type'] = 'application/json'; }
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: h }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch { /* not json */ }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on('error', reject);
        req.end(data);
    });
}

const silent = { log() {}, error() {} };

// -----------------------------------------------------------------------------
// Verifier
// -----------------------------------------------------------------------------
describe('verifyAssertion (ES256 compact JWS)', () => {
    const keyA = makeKey('key-a');
    const keyB = makeKey('key-b');
    const keys = parseJwks(JSON.stringify({ keys: [keyA.jwk] }));
    const opts = () => ({ keys, issuer: ISS, audience: AUD, nowSeconds: nowS() });

    test('a valid assertion yields the identity with known roles only', () => {
        const id = verifyAssertion(sign(keyA, claims({ roles: ['operator', 'superuser', 'viewer'] })), opts());
        assert.deepEqual(id, { sub: 'user-viewer', name: 'Viewer User', email: 'viewer@example.com', roles: ['viewer', 'operator'], jti: 'req-1' });
    });

    test('unknown roles only -> verified with no roles', () => {
        const id = verifyAssertion(sign(keyA, claims({ roles: ['superuser'] })), opts());
        assert.deepEqual(id.roles, []);
    });

    const rejected = {
        'expired': () => sign(keyA, claims({ iat: nowS() - 200, exp: nowS() - 100 })),
        'not yet valid (iat in the future past skew)': () => sign(keyA, claims({ iat: nowS() + 100, exp: nowS() + 160 })),
        'nbf in the future past skew': () => sign(keyA, claims({ nbf: nowS() + 120 })),
        'wrong iss': () => sign(keyA, claims({ iss: 'https://other.example.com' })),
        'wrong aud': () => sign(keyA, claims({ aud: 'other-audience' })),
        'wrong key (signed by an unlisted key under a listed kid)': () => sign({ ...keyB, kid: 'key-a' }, claims()),
        'unknown kid': () => sign(keyB, claims()),
        'alg none': () => `${b64u({ alg: 'none', kid: 'key-a' })}.${b64u(claims())}.`,
        'alg none with a junk signature': () => `${b64u({ alg: 'none', kid: 'key-a' })}.${b64u(claims())}.${b64u('x')}`,
        'alg HS256 with the public key as the HMAC secret': () => {
            const h = b64u({ alg: 'HS256', kid: 'key-a' });
            const p = b64u(claims());
            const secret = keyA.publicKey.export({ type: 'spki', format: 'pem' });
            return `${h}.${p}.${crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`;
        },
        'tampered payload': () => {
            const [h, , s] = sign(keyA, claims()).split('.');
            return `${h}.${b64u(claims({ roles: ['admin'] }))}.${s}`;
        },
        'missing roles': () => { const c = claims(); delete c.roles; return sign(keyA, c); },
        'roles not an array': () => sign(keyA, claims({ roles: 'admin' })),
        'empty sub': () => sign(keyA, claims({ sub: '' })),
        'missing exp': () => { const c = claims(); delete c.exp; return sign(keyA, c); },
        'lifetime over 300 s': () => sign(keyA, claims({ iat: nowS(), exp: nowS() + 301 })),
        'crit header': () => sign(keyA, claims(), { alg: 'ES256', kid: 'key-a', crit: ['exp'] }),
        'two segments': () => sign(keyA, claims()).split('.').slice(0, 2).join('.'),
        'garbage': () => 'not-a-token',
        'DER-encoded signature': () => {
            const h = b64u({ alg: 'ES256', kid: 'key-a' });
            const p = b64u(claims());
            return `${h}.${p}.${crypto.sign('sha256', Buffer.from(`${h}.${p}`), keyA.privateKey).toString('base64url')}`;
        },
    };
    for (const [name, mint] of Object.entries(rejected)) {
        test(`rejects: ${name}`, () => {
            assert.equal(verifyAssertion(mint(), opts()), null);
        });
    }

    test('30 s clock skew: just-expired (10 s) and slightly-early (10 s) assertions still verify', () => {
        assert.ok(verifyAssertion(sign(keyA, claims({ iat: nowS() - 70, exp: nowS() - 10 })), opts()));
        assert.ok(verifyAssertion(sign(keyA, claims({ iat: nowS() + 10, exp: nowS() + 70 })), opts()));
    });

    test('aud may be an array containing the audience', () => {
        assert.ok(verifyAssertion(sign(keyA, claims({ aud: ['x', AUD] })), opts()));
    });

    test('kid absent: used only when the JWKS holds exactly one key', () => {
        const token = sign(keyA, claims(), { alg: 'ES256' });
        assert.ok(verifyAssertion(token, opts()));
        const two = parseJwks(JSON.stringify({ keys: [keyA.jwk, keyB.jwk] }));
        assert.equal(verifyAssertion(token, { ...opts(), keys: two }), null);
    });

    test('parseJwks ignores non-P-256 keys and never imports a private d', () => {
        const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' });
        const priv = makeKey('with-d');
        const privJwk = { ...priv.privateKey.export({ format: 'jwk' }), kid: 'with-d' };
        const map = parseJwks(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'p384' }, privJwk] }));
        assert.deepEqual([...map.keys()], ['with-d']);
        assert.equal(map.get('with-d').type, 'public');
        assert.throws(() => parseJwks('{"keys": "nope"}'));
        assert.throws(() => parseJwks('not json'));
    });
});

// -----------------------------------------------------------------------------
// Classifier, prefix, config
// -----------------------------------------------------------------------------
describe('caller classification', () => {
    let dir; let jwksPath; const key = makeKey('k1');
    before(async () => {
        dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sup-auth-cls-'));
        jwksPath = path.join(dir, 'front.jwks.json');
        writeJwks(jwksPath, [key]);
    });
    after(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

    const fakeReq = (remoteAddress, headers = {}) => ({ headers, socket: { remoteAddress } });

    test('loopback addresses', () => {
        for (const a of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(a), true, a);
        for (const a of ['10.0.0.5', '::ffff:10.0.0.5', '192.168.1.2', '::', '0.0.0.0', '', undefined, '128.0.0.1']) assert.equal(isLoopbackAddress(a), false, String(a));
        for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]']) assert.equal(isLoopbackBindHost(h), true, h);
        for (const h of ['0.0.0.0', '::', '192.168.1.2', 'fleet.example.com']) assert.equal(isLoopbackBindHost(h), false, h);
    });

    test('trusted-front: header absent + loopback -> local operator; + non-loopback -> 401', () => {
        const a = createAuthenticator({ mode: 'trusted-front', jwksPath, issuer: ISS, logger: silent });
        const local = a.authenticate(fakeReq('127.0.0.1'));
        assert.equal(local.ok, true);
        assert.equal(local.asserted, false);
        assert.deepEqual(local.identity, LOCAL_IDENTITY);
        assert.equal(local.base, '');
        const remote = a.authenticate(fakeReq('10.1.2.3'));
        assert.deepEqual({ ok: remote.ok, status: remote.status, body: remote.body }, { ok: false, status: 401, body: { error: 'unauthenticated' } });
    });

    test('trusted-front: header present must verify, never falls back to local (even from loopback)', () => {
        const a = createAuthenticator({ mode: 'trusted-front', jwksPath, issuer: ISS, logger: silent });
        for (const value of ['', 'garbage', sign(key, claims({ iss: 'https://other.example.com' }))]) {
            const r = a.authenticate(fakeReq('127.0.0.1', { 'x-fleet-identity': value }));
            assert.equal(r.ok, false);
            assert.equal(r.status, 401);
        }
        const ok = a.authenticate(fakeReq('127.0.0.1', { 'x-fleet-identity': sign(key, claims()), 'x-forwarded-prefix': '/fleet' }));
        assert.equal(ok.ok, true);
        assert.equal(ok.asserted, true);
        assert.equal(ok.identity.sub, 'user-viewer');
        assert.equal(ok.base, '/fleet');
    });

    test('none mode: everyone is local; identity and prefix headers are ignored', () => {
        const a = createAuthenticator({ mode: 'none' });
        const r = a.authenticate(fakeReq('10.1.2.3', { 'x-fleet-identity': 'garbage', 'x-forwarded-prefix': '/fleet' }));
        assert.deepEqual({ ok: r.ok, asserted: r.asserted, sub: r.identity.sub, base: r.base }, { ok: true, asserted: false, sub: 'local', base: '' });
    });

    test('forwarded prefix: only the documented shape is honoured', () => {
        assert.equal(sanitizeForwardedPrefix('/fleet'), '/fleet');
        assert.equal(sanitizeForwardedPrefix('/a/b-c/d.e_f~g'), '/a/b-c/d.e_f~g');
        for (const bad of ['fleet', '/', '/fleet/', '//evil.example.com', '/a b', '/a/../b', '/..', '/"x', '/a?b', 'http://x', '', undefined]) {
            assert.equal(sanitizeForwardedPrefix(bad), '', String(bad));
        }
    });

    test('config: flags win over env; audience defaults', () => {
        const env = { FLEET_SUPERVISOR_AUTH: 'trusted-front', FLEET_SUPERVISOR_FRONT_JWKS: '/env/jwks.json', FLEET_SUPERVISOR_FRONT_ISSUER: 'env-iss' };
        assert.deepEqual(resolveAuthConfig({}, env), { mode: 'trusted-front', jwksPath: '/env/jwks.json', issuer: 'env-iss', audience: 'fleet-supervisor' });
        assert.deepEqual(resolveAuthConfig({ auth: 'none', frontIssuer: 'flag-iss', frontAudience: 'aud-x' }, env), { mode: 'none', jwksPath: '/env/jwks.json', issuer: 'flag-iss', audience: 'aud-x' });
        assert.deepEqual(resolveAuthConfig({}, {}), { mode: 'none', jwksPath: null, issuer: null, audience: 'fleet-supervisor' });
        const { values } = parseServeArgs(['--auth', 'trusted-front', '--front-jwks', 'x.json', '--front-issuer', ISS, '--front-audience', 'a']);
        assert.deepEqual([values.auth, values['front-jwks'], values['front-issuer'], values['front-audience']], ['trusted-front', 'x.json', ISS, 'a']);
    });

    test('config: trusted-front refuses a non-loopback bind and a missing JWKS path or issuer, naming the setting', () => {
        const full = { mode: 'trusted-front', jwksPath: 'x.json', issuer: ISS };
        assert.doesNotThrow(() => validateAuthConfig(full, '127.0.0.1'));
        assert.doesNotThrow(() => validateAuthConfig({ mode: 'none' }, '0.0.0.0'));
        assert.throws(() => validateAuthConfig(full, '0.0.0.0'), (e) => e instanceof AuthConfigError && /loopback/.test(e.message) && /0\.0\.0\.0/.test(e.message));
        assert.throws(() => validateAuthConfig({ ...full, jwksPath: null }, '127.0.0.1'), (e) => e instanceof AuthConfigError && /FLEET_SUPERVISOR_FRONT_JWKS/.test(e.message) && /--front-jwks/.test(e.message));
        assert.throws(() => validateAuthConfig({ ...full, issuer: null }, '127.0.0.1'), (e) => e instanceof AuthConfigError && /FLEET_SUPERVISOR_FRONT_ISSUER/.test(e.message) && /--front-issuer/.test(e.message));
        assert.throws(() => validateAuthConfig({ mode: 'oidc' }, '127.0.0.1'), (e) => e instanceof AuthConfigError && /unknown auth mode/.test(e.message));
    });

    test('route policy: roles are cumulative; local-only and unlisted are plain forbidden', () => {
        assert.equal(policyFor('POST', '/api/sprints/abc/stop').min, 'operator');
        assert.equal(policyFor('GET', '/api/sprints/abc').min, 'viewer');
        assert.equal(authorizeRoute({ roles: ['admin'] }, 'POST', '/api/sprints/abc/stop'), null);
        assert.deepEqual(authorizeRoute({ roles: ['viewer'] }, 'POST', '/api/sprints/abc/stop'), { status: 403, body: { error: 'forbidden', requiredRole: 'operator' } });
        assert.deepEqual(authorizeRoute({ roles: ['admin'] }, 'POST', '/api/dolt-push-mutex/s1/acquire'), { status: 403, body: { error: 'forbidden' } });
        assert.deepEqual(authorizeRoute({ roles: ['admin'] }, 'GET', '/no/such/route'), { status: 403, body: { error: 'forbidden' } });
        assert.deepEqual(authorizeRoute({ roles: [] }, 'GET', '/api/sprints'), { status: 403, body: { error: 'forbidden', requiredRole: 'viewer' } });
        assert.equal(authorizeRoute({ roles: [] }, 'GET', '/api/whoami'), null);
    });

    test('startup refusal: createSupervisor().start() rejects before binding', async () => {
        const bad = [
            [{ host: '0.0.0.0', auth: { mode: 'trusted-front', jwksPath, issuer: ISS } }, /loopback/],
            [{ auth: { mode: 'trusted-front', issuer: ISS } }, /FLEET_SUPERVISOR_FRONT_JWKS/],
            [{ auth: { mode: 'trusted-front', jwksPath } }, /FLEET_SUPERVISOR_FRONT_ISSUER/],
        ];
        for (const [deps, re] of bad) {
            const sup = createSupervisor({ port: 0, logger: silent, ...deps });
            await assert.rejects(sup.start(), (e) => e instanceof AuthConfigError && re.test(e.message));
            assert.equal(sup.server, undefined, 'never bound');
        }
    });
});

// -----------------------------------------------------------------------------
// End to end through a real supervisor
// -----------------------------------------------------------------------------
describe('trusted-front supervisor over HTTP', () => {
    let dir; let jwksPath; let supervisor; let port; let ledger; let history; let logs;
    const keyA = makeKey('key-a');
    const keyB = makeKey('key-b');
    const stops = [];
    const viewerTok = () => sign(keyA, claims());
    const operatorTok = () => sign(keyA, claims({ sub: 'user-op', name: 'Op User', email: 'op@example.com', roles: ['operator'] }));
    const adminTok = () => sign(keyA, claims({ sub: 'user-admin', name: 'Admin User', roles: ['admin'] }));
    const as = (token, extra = {}) => ({ 'x-fleet-identity': token, ...extra });

    before(async () => {
        dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sup-auth-http-'));
        jwksPath = path.join(dir, 'front.jwks.json');
        writeJwks(jwksPath, [keyA]);
        ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME) });
        await ledger.start();
        history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME) });
        await history.start();
        logs = [];
        const logger = { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
        let n = 0;
        const controller = createSprintController({
            ledger, history,
            spawner: { spawnSprint: async () => ({ pid: 40000 + n, port: 9999, logPath: path.join(dir, `s${n}.log`) }), getLiveEntry: () => ({ port: 9999 }) },
            listMembers: () => ({ members: [{ name: 'alice' }] }),
            getBacklog: () => ({ tasks: [] }),
            generateSprintId: () => `sprint-${++n}`,
            hasTerminalState: () => null,
            proxyStop: async (p) => { stops.push(p); return { ok: true }; },
            getBuildVersion: () => null,
        });
        supervisor = createSupervisor({ port: 0, logger, auth: { mode: 'trusted-front', jwksPath, issuer: ISS, audience: AUD } });
        registerSprintRoutes(supervisor, controller);
        registerReservationRoutes(supervisor, createReconciler({ ledger, history, logger }));
        registerDoltMutexRoutes(supervisor, { acquire: async () => ({ ok: true }), release: async () => ({ ok: true }), renew: async () => ({ ok: true }), status: () => ({ held: false }) }, { readJsonBody, sendJson });
        await supervisor.start();
        port = supervisor.port;
    });
    after(async () => {
        await supervisor.stop('test');
        await ledger.stop?.();
        await history.stop();
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('viewer GET is allowed', async () => {
        const r = await request(port, 'GET', '/api/sprints', { headers: as(viewerTok()) });
        assert.equal(r.status, 200);
        assert.ok(Array.isArray(r.json.sprints));
    });

    test('viewer POST stop -> 403 naming the required role; no handler side effect', async () => {
        const before = stops.length;
        const r = await request(port, 'POST', '/api/sprints/sprint-x/stop', { headers: as(viewerTok()), body: {} });
        assert.equal(r.status, 403);
        assert.deepEqual(r.json, { error: 'forbidden', requiredRole: 'operator' });
        assert.equal(stops.length, before);
    });

    test('operator reaches the launch validation path', async () => {
        const r = await request(port, 'POST', '/api/sprints', { headers: as(operatorTok()), body: {} });
        assert.equal(r.status, 400);
        assert.ok(r.json.field, 'a launch validation error names the field');
    });

    test('operator POST shutdown -> 403 requiredRole admin', async () => {
        const r = await request(port, 'POST', '/api/shutdown', { headers: as(operatorTok()), body: {} });
        assert.deepEqual([r.status, r.json], [403, { error: 'forbidden', requiredRole: 'admin' }]);
    });

    test('asserted request to a local-only route -> 403, even for admin', async () => {
        for (const [m, p] of [['POST', '/api/dolt-push-mutex/s1/acquire'], ['GET', '/api/dolt-push-mutex']]) {
            const r = await request(port, m, p, { headers: as(adminTok()), ...(m === 'POST' ? { body: {} } : {}) });
            assert.deepEqual([r.status, r.json], [403, { error: 'forbidden' }], `${m} ${p}`);
        }
    });

    test('asserted request to an unlisted route -> 403 (default deny), not 404', async () => {
        const r = await request(port, 'GET', '/api/nope', { headers: as(adminTok()) });
        assert.deepEqual([r.status, r.json], [403, { error: 'forbidden' }]);
    });

    test('every failed assertion is the same constant 401 body', async () => {
        const bad = [
            'garbage',
            sign(keyA, claims({ iat: nowS() - 400, exp: nowS() - 300 })),
            sign(keyA, claims({ aud: 'x' })),
            sign(keyB, claims()),
            `${b64u({ alg: 'none' })}.${b64u(claims({ roles: ['admin'] }))}.`,
        ];
        for (const token of bad) {
            const r = await request(port, 'GET', '/api/sprints', { headers: as(token) });
            assert.equal(r.status, 401);
            assert.equal(r.text, '{"error":"unauthenticated"}');
        }
    });

    test('unsigned loopback request is the local operator with full access', async () => {
        const who = await request(port, 'GET', '/api/whoami');
        assert.deepEqual(who.json, { sub: 'local', name: 'local', email: null, roles: ['admin'], mode: 'trusted-front' });
        const mutex = await request(port, 'GET', '/api/dolt-push-mutex');
        assert.equal(mutex.status, 200, 'local-only routes stay reachable for local callers');
    });

    test('unsigned non-loopback request -> 401 (simulated remote peer through the dispatcher)', async () => {
        const out = await new Promise((resolve) => {
            const res = {
                headersSent: false, statusCode: 0, body: '',
                writeHead(s) { this.statusCode = s; this.headersSent = true; return this; },
                setHeader() {}, once() {}, on() {},
                end(b) { this.body = String(b ?? ''); resolve(this); },
            };
            supervisor.handleRequest({ method: 'GET', url: '/api/whoami', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '10.20.30.40' }, resume() {} }, res);
        });
        assert.equal(out.statusCode, 401);
        assert.equal(out.body, '{"error":"unauthenticated"}');
    });

    test('whoami returns the asserted identity', async () => {
        const r = await request(port, 'GET', '/api/whoami', { headers: as(operatorTok()) });
        assert.deepEqual(r.json, { sub: 'user-op', name: 'Op User', email: 'op@example.com', roles: ['operator'], mode: 'trusted-front' });
    });

    test('a token with only unknown roles is authenticated but may call nothing beyond whoami', async () => {
        const tok = sign(keyA, claims({ sub: 'user-none', roles: ['superuser'] }));
        assert.equal((await request(port, 'GET', '/api/whoami', { headers: as(tok) })).json.roles.length, 0);
        assert.deepEqual((await request(port, 'GET', '/api/sprints', { headers: as(tok) })).json, { error: 'forbidden', requiredRole: 'viewer' });
    });

    test('request guard: a forwarded request with a front-side Host/Origin is admitted; unsigned ones keep the old checks', async () => {
        const fwd = { host: 'fleet.example.com', origin: 'https://fleet.example.com', 'sec-fetch-site': 'same-origin' };
        const a = await request(port, 'GET', '/api/sprints', { headers: as(viewerTok(), fwd) });
        assert.equal(a.status, 200);
        const b = await request(port, 'POST', '/api/sprints', { headers: as(operatorTok(), { ...fwd, origin: 'https://elsewhere.example.com', 'sec-fetch-site': 'cross-site' }), body: {} });
        assert.equal(b.status, 400, 'reaches the handler');
        // The content-type rule still applies to forwarded requests.
        const c = await request(port, 'POST', '/api/sprints', { headers: as(operatorTok(), { 'content-type': 'text/plain' }), body: '{}' });
        assert.equal(c.status, 415);
        // Unsigned requests: unchanged DNS-rebinding and CSRF checks.
        assert.equal((await request(port, 'GET', '/api/sprints', { headers: { host: 'fleet.example.com' } })).status, 403);
        assert.equal((await request(port, 'POST', '/api/sprints', { headers: { origin: 'http://evil.example' }, body: {} })).status, 403);
    });

    test('audit: launchedBy / stoppedBy recorded, one log line per mutating asserted request, token never logged', async () => {
        const opTok = operatorTok();
        const launched = await request(port, 'POST', '/api/sprints', { headers: as(opTok), body: { issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main' } });
        assert.equal(launched.status, 201, launched.text);
        const id = launched.json.sprintId;
        assert.deepEqual(ledger.get(id).launchedBy, { sub: 'user-op', name: 'Op User' });

        const stopped = await request(port, 'POST', `/api/sprints/${id}/stop`, { headers: as(opTok), body: {} });
        assert.equal(stopped.status, 200, stopped.text);
        assert.deepEqual(ledger.get(id).stoppedBy, { sub: 'user-op', name: 'Op User' });

        const released = await request(port, 'POST', `/api/reservations/${id}/force-release`, { headers: as(adminTok()), body: { reason: 'test' } });
        assert.equal(released.status, 200, released.text);
        const ev = history.forSprint(id).find((e) => e.event === HISTORY_EVENTS.FORCE_RELEASED);
        assert.deepEqual(ev.launchedBy, { sub: 'user-op', name: 'Op User' });
        assert.deepEqual(ev.stoppedBy, { sub: 'user-admin', name: 'Admin User' });

        // Audit lines are written on the server side's response 'close', which
        // can land just after the client has read the body: wait for the last one.
        const lastLine = `[audit] POST "/api/reservations/${id}/force-release" sub="user-admin" status=200`;
        const deadline = Date.now() + 5000;
        while (!logs.includes(lastLine) && Date.now() < deadline) await new Promise((r) => setImmediate(r));
        const audit = logs.filter((l) => l.startsWith('[audit]'));
        assert.ok(audit.includes(`[audit] POST "/api/sprints" sub="user-op" status=201`), audit.join('\n'));
        assert.ok(audit.includes(`[audit] POST "/api/sprints/${id}/stop" sub="user-op" status=200`), audit.join('\n'));
        assert.ok(audit.includes(`[audit] POST "/api/reservations/${id}/force-release" sub="user-admin" status=200`), audit.join('\n'));
        assert.ok(audit.some((l) => l.includes('status=403')), 'denied mutating requests are audited too');
        assert.ok(!audit.some((l) => l.includes('GET ')), 'GETs are not audited');
        assert.ok(!logs.some((l) => l.includes(opTok) || l.includes(opTok.split('.')[2])), 'the token never reaches the log');
    });

    test('JWKS rotation: the file is re-read on change; a broken file fails closed', async () => {
        const oldTok = viewerTok();
        const newTok = sign(keyB, claims());
        assert.equal((await request(port, 'GET', '/api/sprints', { headers: as(oldTok) })).status, 200);
        assert.equal((await request(port, 'GET', '/api/sprints', { headers: as(newTok) })).status, 401);
        const bump = () => { const t = new Date(Date.now() + 5000 + Math.floor(Math.random() * 100000)); fs.utimesSync(jwksPath, t, t); };
        writeJwks(jwksPath, [keyB]);
        bump();
        assert.equal((await request(port, 'GET', '/api/sprints', { headers: as(newTok) })).status, 200);
        assert.equal((await request(port, 'GET', '/api/sprints', { headers: as(oldTok) })).status, 401);
        fs.writeFileSync(jwksPath, '{ not json');
        bump();
        assert.equal((await request(port, 'GET', '/api/sprints', { headers: as(newTok) })).status, 401);
        writeJwks(jwksPath, [keyA, keyB]);
        bump();
        assert.equal((await request(port, 'GET', '/api/sprints', { headers: as(oldTok) })).status, 200);
        assert.equal((await request(port, 'GET', '/api/sprints', { headers: as(newTok) })).status, 200);
    });
});

describe('admin shutdown (dedicated supervisor instance)', () => {
    test('admin POST /api/shutdown is admitted and shuts that instance down', async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sup-auth-shut-'));
        const jwksPath = path.join(dir, 'front.jwks.json');
        const key = makeKey('k');
        writeJwks(jwksPath, [key]);
        const sup = createSupervisor({ port: 0, logger: silent, auth: { mode: 'trusted-front', jwksPath, issuer: ISS } });
        await sup.start();
        try {
            const r = await request(sup.port, 'POST', '/api/shutdown', { headers: { 'x-fleet-identity': sign(key, claims({ sub: 'user-admin', roles: ['admin'] })) }, body: {} });
            assert.deepEqual([r.status, r.json], [200, { status: 'shutting-down' }]);
            await sup.shutdownRequested;
            assert.equal(sup.exitCause, 'http:/api/shutdown');
        } finally {
            await sup.stop('test');
            await fsp.rm(dir, { recursive: true, force: true });
        }
    });
});

describe('none mode (default) is unchanged', () => {
    let supervisor; let port; let dir; let ledger;
    before(async () => {
        dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sup-auth-none-'));
        ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME) });
        await ledger.start();
        const controller = createSprintController({
            ledger,
            spawner: { spawnSprint: async () => ({ pid: 41000, port: 9998, logPath: path.join(dir, 'x.log') }), getLiveEntry: () => undefined },
            listMembers: () => ({ members: [{ name: 'alice' }] }),
            generateSprintId: () => 'sprint-none-1',
            getBuildVersion: () => null,
        });
        supervisor = createSupervisor({ port: 0, logger: silent });
        registerSprintRoutes(supervisor, controller);
        await supervisor.start();
        port = supervisor.port;
    });
    after(async () => {
        await supervisor.stop('test');
        await fsp.rm(dir, { recursive: true, force: true });
    });

    test('identity headers are ignored: a garbage assertion is not a 401, whoami is local', async () => {
        const r = await request(port, 'GET', '/api/whoami', { headers: { 'x-fleet-identity': 'garbage', 'x-forwarded-prefix': '/fleet' } });
        assert.deepEqual([r.status, r.json], [200, { sub: 'local', name: 'local', email: null, roles: ['admin'], mode: 'none' }]);
        assert.equal((await request(port, 'GET', '/api/sprints', { headers: { 'x-fleet-identity': 'garbage' } })).status, 200);
    });

    test('the actor is recorded as local', async () => {
        const r = await request(port, 'POST', '/api/sprints', { body: { issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main' } });
        assert.equal(r.status, 201, r.text);
        assert.deepEqual(ledger.get('sprint-none-1').launchedBy, { sub: 'local', name: 'local' });
    });

    test('a ledger entry without audit fields reads back exactly as before', async () => {
        await ledger.claim('legacy-1', { members: ['bob'], issueRoots: ['PROJ-2'] });
        assert.equal('launchedBy' in ledger.get('legacy-1'), false);
        assert.equal('stoppedBy' in ledger.get('legacy-1'), false);
    });
});
