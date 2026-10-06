import { test, describe } from 'node:test';
import assert from 'node:assert';

import { createSupervisor, RETIRED_TOKEN_GRACE_MS } from '../src/supervisor/server.mjs';
import { deriveDashboardCookie } from '../src/supervisor/auth.mjs';
import { PACKAGE_ID } from '../src/registration/manifest.mjs';
import { deriveUpstreamCredential } from '@apralabs/apra-fleet-client/auth/local-token';

// apra-fleet-hwxd.1 -- the supervisor's /api guard follows a token PROVIDER
// (deps.resolveToken) instead of pinning the token it booted with, so a
// supervisor started on the private/token fallback converges on fleet.key
// once it appears, without being recreated. Drives the REAL handleRequest
// guard with mock req/res (no socket).

const PRIVATE_TOKEN = 'p'.repeat(64);
const FLEET_KEY = 'f'.repeat(64);
const WRONG = 'w'.repeat(64);

function mockReq(method, url, headers = {}) {
    return { method, url, headers, on() { return this; } };
}
function mockRes() {
    return {
        statusCode: undefined,
        body: undefined,
        headersSent: false,
        writeHead(status) { this.statusCode = status; this.headersSent = true; },
        end(body) { this.body = body; },
    };
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });

/** A provider whose answer the test switches; counts calls. */
function switchableProvider(initial) {
    const p = {
        current: initial,
        calls: 0,
        throws: null,
        resolve: () => { p.calls += 1; if (p.throws) throw p.throws; return p.current; },
    };
    return p;
}

function capturingLogger() {
    const lines = [];
    return {
        lines,
        log: (...a) => lines.push(a.map(String).join(' ')),
        error: (...a) => lines.push(a.map(String).join(' ')),
    };
}

function build(provider, extra = {}) {
    const logger = capturingLogger();
    const supervisor = createSupervisor({ port: 0, resolveToken: provider.resolve, logger, ...extra });
    supervisor.route('GET', '/api/probe', async (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
    });
    const get = async (headers) => {
        const res = mockRes();
        await supervisor.handleRequest(mockReq('GET', '/api/probe', headers), res);
        return res.statusCode;
    };
    return { supervisor, logger, get };
}

const privateSource = { token: PRIVATE_TOKEN, source: 'private-token', path: '/tmp/x/private/token' };
const fleetSource = { token: FLEET_KEY, source: 'fleet-key', path: '/tmp/home/.apra-fleet/fleet.key' };

describe('supervisor api guard re-resolves its token provider (apra-fleet-hwxd)', () => {
    test('private-token bearer accepted before the switch; fleet-key bearers accepted after it without recreating the supervisor', async () => {
        const provider = switchableProvider(privateSource);
        const { supervisor, get } = build(provider);

        assert.equal(await get(bearer(PRIVATE_TOKEN)), 200, 'private-token bearer before the switch');
        assert.equal(await get(bearer(deriveUpstreamCredential(FLEET_KEY, PACKAGE_ID))), 401,
            'fleet-key-derived bearer is rejected while fleet.key does not exist');

        provider.current = fleetSource; // fleet.key appears
        assert.equal(await get(bearer(deriveUpstreamCredential(FLEET_KEY, PACKAGE_ID))), 200,
            'fleet-key-derived bearer (the console /ext/se hop credential) after the switch');
        assert.equal(await get(bearer(FLEET_KEY)), 200, 'raw fleet key as bearer after the switch');
        assert.equal(await get({ cookie: `se_token=${deriveDashboardCookie(FLEET_KEY)}` }), 200,
            'dashboard cookie follows the current token');
        assert.equal(supervisor.token, FLEET_KEY, 'exported token getter returns the current token');
    });

    test('a wrong bearer is still 401 after re-resolution (no fail-open)', async () => {
        const provider = switchableProvider(privateSource);
        const { get } = build(provider);
        provider.current = fleetSource;
        const before = provider.calls;
        assert.equal(await get(bearer(WRONG)), 401);
        assert.ok(provider.calls > before, 'the failed check re-resolved the provider');
        assert.equal(await get({}), 401, 'no credential at all is 401');
        assert.equal(await get(bearer(deriveUpstreamCredential(WRONG, PACKAGE_ID))), 401);
    });

    test('steady state does not consult the provider on an authorized request', async () => {
        const provider = switchableProvider(privateSource);
        const { get } = build(provider);
        const before = provider.calls;
        assert.equal(await get(bearer(PRIVATE_TOKEN)), 200);
        assert.equal(await get(bearer(PRIVATE_TOKEN)), 200);
        assert.equal(provider.calls, before, 'no provider read per authorized request');
    });

    test('the retired private token is honoured only within the bounded grace window', async () => {
        let now = 1_000_000;
        const provider = switchableProvider(privateSource);
        const { get } = build(provider, { nowMs: () => now, retiredTokenGraceMs: 60_000 });
        provider.current = fleetSource;
        assert.equal(await get(bearer(FLEET_KEY)), 200); // triggers the switch
        now += 59_000;
        assert.equal(await get(bearer(PRIVATE_TOKEN)), 200, 'old credential still accepted inside the grace window');
        now += 2_000;
        assert.equal(await get(bearer(PRIVATE_TOKEN)), 401, 'old credential rejected once the grace window passed');
        assert.equal(await get(bearer(PRIVATE_TOKEN)), 401, 'and stays rejected');
        assert.ok(RETIRED_TOKEN_GRACE_MS > 0 && Number.isFinite(RETIRED_TOKEN_GRACE_MS), 'default grace is bounded');
    });

    test('a provider with no token yet fails closed, then converges when one appears', async () => {
        const provider = switchableProvider(null);
        const { get } = build(provider);
        assert.equal(await get(bearer(FLEET_KEY)), 401);
        assert.equal(await get({}), 401);
        provider.current = fleetSource;
        assert.equal(await get(bearer(FLEET_KEY)), 200);
    });

    test('a throwing provider keeps the current token and fails closed for others', async () => {
        const provider = switchableProvider(privateSource);
        const { get, logger } = build(provider);
        provider.throws = new Error('boom');
        assert.equal(await get(bearer(PRIVATE_TOKEN)), 200);
        assert.equal(await get(bearer(FLEET_KEY)), 401);
        assert.ok(logger.lines.some((l) => l.includes('re-resolution failed: boom')));
    });

    test('log lines name the source/path only, never a token value', async () => {
        const provider = switchableProvider(privateSource);
        const { get, logger } = build(provider);
        provider.current = fleetSource;
        assert.equal(await get(bearer(FLEET_KEY)), 200);
        assert.ok(logger.lines.some((l) => l.includes('fleet-key') && l.includes(fleetSource.path)),
            `expected a source-switch log line, got ${JSON.stringify(logger.lines)}`);
        for (const line of logger.lines) {
            assert.ok(!line.includes(FLEET_KEY), 'fleet key value must not be logged');
            assert.ok(!line.includes(PRIVATE_TOKEN), 'private token value must not be logged');
            assert.ok(!line.includes(deriveUpstreamCredential(FLEET_KEY, PACKAGE_ID)), 'derived credential must not be logged');
        }
    });
});
