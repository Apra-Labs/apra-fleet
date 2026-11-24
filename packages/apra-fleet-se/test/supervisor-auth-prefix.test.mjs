// Forwarded path prefix (docs/supervisor-auth.md "Forwarded path prefix").
//
// A front that publishes the supervisor under a path sends X-Forwarded-Prefix;
// with a verified assertion every root-absolute URL in the dashboard, the
// proxied live viewer and the history view must carry it. Without an
// assertion, or with a prefix of the wrong shape, it is ignored, and with no
// prefix the pages are byte-for-byte what they were.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HTML_TEMPLATE } from '@apralabs/apra-fleet-workflow/viewer';
import { beadsExtension, kbCodeIntelExtension, decisionsExtension } from '../fleet-sprint/viewer-extensions.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { createDashboard, registerDashboardRoutes, renderIndexPageHtml } from '../src/supervisor/dashboard.mjs';
import { createBacklog, renderBacklogPanelHtml } from '../src/supervisor/backlog.mjs';
import { createLiveProxy, registerLiveRoutes, renderReadOnlyHistoryHtml, prefixHistoryPageHtml } from '../src/supervisor/proxy.mjs';
import { createHistoryView, registerHistoryViewRoutes } from '../src/supervisor/history-view.mjs';
import { prefixPageHtml, prefixRootUrls, prefixLocation } from '../src/supervisor/base-path.mjs';

const ISS = 'https://front.example.com';
const BASE = '/fleet';
const EXTENSIONS = [beadsExtension, kbCodeIntelExtension, decisionsExtension];

const silent = { log() {}, error() {} };
const b64u = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
function token(roles = ['admin'], sub = 'user-1') {
    const now = Math.floor(Date.now() / 1000);
    const h = b64u({ alg: 'ES256', kid: 'k' });
    const p = b64u({ iss: ISS, aud: 'fleet-supervisor', sub, name: 'Test User', roles, iat: now, exp: now + 60 });
    return `${h}.${p}.${crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

function get(port, urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

/** Code lines only: JS line comments are not URLs the browser requests. */
const codeOnly = (html) => html.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
/** Data scripts (window.__x = <json>) hold user text verbatim by design. */
const withoutDataScripts = (html) => html.replace(/<script>window\.__[A-Za-z0-9_]+ = [\s\S]*?<\/script>/g, '');

/** Every root-absolute URL a browser would request without the prefix. */
function unprefixedUrls(html, base) {
    const b = base.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const notBase = `(?!${b}(?:[/'"\`?#]|$))`;
    const patterns = [
        new RegExp(`(["'\`])/${notBase}(?:api|sprints|state|events|supervisor|stop|pause|resume|save_logs|extensions|activities)(?=[/?#"'\`])`, 'g'),
        new RegExp(`\\b(?:href|src|action)=["']/${notBase}`, 'g'),
        new RegExp(`\\b(?:fetch|EventSource)\\(\\s*["'\`]/${notBase}`, 'g'),
    ];
    const code = codeOnly(withoutDataScripts(html));
    const hits = [];
    for (const re of patterns) for (const m of code.matchAll(re)) hits.push(code.slice(Math.max(0, m.index - 40), m.index + 40));
    return hits;
}

const ROWS = [
    { id: 'PROJ-1', title: 'Fix "/api/sprints" leak', description: "calls fetch('/state?x') and href=\"/x\"", status: 'open', priority: 1, issue_type: 'task', created_at: '2026-01-01T00:00:00Z' },
    { id: 'PROJ-2', title: 'Second', description: '', status: 'open', priority: 2, issue_type: 'task', created_at: '2026-01-02T00:00:00Z' },
];

describe('base-path rewriter', () => {
    test('empty base is the identity', () => {
        const html = renderIndexPageHtml([], renderBacklogPanelHtml(ROWS, null));
        assert.equal(prefixPageHtml(html, ''), html);
        assert.equal(prefixRootUrls("fetch('/api/x')", ''), "fetch('/api/x')");
        assert.equal(prefixHistoryPageHtml('<a href="/">x</a>', ''), '<a href="/">x</a>');
        assert.equal(prefixLocation('/x', ''), '/x');
    });

    test('prefixes supervisor URLs once, leaves other strings alone', () => {
        assert.equal(prefixRootUrls("fetch('/api/members')", BASE), "fetch('/fleet/api/members')");
        assert.equal(prefixRootUrls('href="/sprints/a/live"', BASE), 'href="/fleet/sprints/a/live"');
        assert.equal(prefixRootUrls("new EventSource('/events')", BASE), "new EventSource('/fleet/events')");
        assert.equal(prefixRootUrls('<a href="/">', BASE), '<a href="/fleet/">');
        assert.equal(prefixRootUrls("closed + '/' + required", BASE), "closed + '/' + required");
        assert.equal(prefixRootUrls("'/apiary'", BASE), "'/apiary'");
        assert.equal(prefixRootUrls('href="//cdn.example.com/x"', BASE), 'href="//cdn.example.com/x"');
        // A base that itself looks like a supervisor path is not prefixed twice.
        assert.equal(prefixRootUrls("fetch('/api/x')", '/api'), "fetch('/api/api/x')");
        assert.equal(prefixLocation('/x', BASE), '/fleet/x');
        assert.equal(prefixLocation('https://example.com/x', BASE), 'https://example.com/x');
    });

    test('dashboard page: no unprefixed root-absolute URL; user data in data scripts is verbatim', () => {
        const view = { sprintId: 'sprint-1', status: 'running-healthy', branch: 'feat/x', base: 'main', goal: 'P1', issueRoots: ['PROJ-1'], beadCount: 2, members: [{ name: 'alice', role: 'doer' }], progress: null, baseDrift: null, beadsPrefix: 'PROJ' };
        const html = renderIndexPageHtml([view], renderBacklogPanelHtml(ROWS, null), undefined, { viewer: { sub: 'u', name: 'U', roles: ['admin'] } });
        assert.ok(unprefixedUrls(html, '').length > 10, 'the scan sees the unprefixed page');
        const out = prefixPageHtml(html, BASE);
        assert.deepEqual(unprefixedUrls(out, BASE), []);
        assert.ok(out.includes("fetch('/fleet/api/reservations/'"));
        assert.ok(out.includes("new EventSource('/fleet/events')"));
        assert.ok(out.includes('href="/fleet/sprints/sprint-1/live"'));
        assert.ok(out.includes("fetch('/fleet/api/members')"));
        assert.ok(out.includes("fetch('/fleet/api/backlog/tasks?'"));
        assert.ok(out.includes('Fix \\"/api/sprints\\" leak'), 'bead title in the backlog data script is untouched');
    });

    test('history page: frozen state is verbatim, client calls prefixed', () => {
        const state = { status: 'finished', activities: [{ id: 'a1', label: "ran fetch('/state?x') and new EventSource('/events')" }] };
        const html = HTML_TEMPLATE(EXTENSIONS, { history: true, state });
        assert.ok(unprefixedUrls(html, '').length > 0, 'the scan sees the unprefixed page');
        const out = prefixHistoryPageHtml(html, BASE);
        assert.deepEqual(unprefixedUrls(out.split('\n').filter((l) => !/^\s*renderState\(/.test(l)).join('\n'), BASE), []);
        const stateLine = out.split('\n').find((l) => /^\s*renderState\(\{/.test(l));
        assert.ok(stateLine && stateLine.includes("ran fetch('/state?x') and new EventSource('/events')"));
        assert.deepEqual(unprefixedUrls(prefixHistoryPageHtml(renderReadOnlyHistoryHtml('s1', {}), BASE), BASE), []);
    });
});

describe('forwarded prefix through a trusted-front supervisor', () => {
    let dir; let child; let childPort; let supervisor; let port;

    before(async () => {
        dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sup-auth-prefix-'));
        const jwksPath = path.join(dir, 'front.jwks.json');
        fs.writeFileSync(jwksPath, JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k' }] }));

        // A stand-in child viewer serving the real live HTML_TEMPLATE, plus a
        // root-absolute redirect so Location rewriting is observable.
        child = http.createServer((req, res) => {
            if (req.url === '/') {
                const body = HTML_TEMPLATE(EXTENSIONS);
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                res.end(body);
            } else if (req.url.startsWith('/extensions/')) {
                res.writeHead(302, { location: '/extensions/beads/detail/elsewhere' });
                res.end();
            } else {
                res.writeHead(404);
                res.end();
            }
        });
        await new Promise((r) => child.listen(0, '127.0.0.1', r));
        childPort = child.address().port;

        const ledger = { list: () => [{ sprintId: 'sprint-1', members: ['alice'], issueRoots: ['PROJ-1'], childPid: null, branch: null, base: null, goal: null }], get: () => undefined, getScopeFreshness: () => ({ lastSyncedAt: null, ageSeconds: 'never-synced' }) };
        const watchdog = { classifySprint: async (e) => ({ sprintId: e.sprintId, status: 'running-healthy', pidAlive: true, httpOk: true, childPid: null }) };
        const expandScope = async (roots) => new Set(roots);
        const backlog = createBacklog({ ledger, listAllBeads: () => ROWS, expandScope, watchdog, logger: silent });
        const dashboard = createDashboard({ ledger, watchdog, expandScope, listAllBeads: async () => ROWS, backlog, logger: silent });
        const historyView = createHistoryView({ readFile: async () => JSON.stringify({ status: 'finished', activities: [] }), logger: silent });
        const liveProxy = createLiveProxy({ resolvePort: (id) => (id === 'sprint-1' ? childPort : undefined), renderHistory: (id) => historyView.renderForSprint(id), logger: silent });

        supervisor = createSupervisor({ port: 0, logger: silent, auth: { mode: 'trusted-front', jwksPath, issuer: ISS } });
        registerDashboardRoutes(supervisor, dashboard);
        registerLiveRoutes(supervisor, liveProxy);
        registerHistoryViewRoutes(supervisor, historyView);
        await supervisor.start();
        port = supervisor.port;
    });
    after(async () => {
        await supervisor.stop('test');
        await new Promise((r) => child.close(r));
        await fsp.rm(dir, { recursive: true, force: true });
    });

    const signed = (prefix, roles) => ({ 'x-fleet-identity': token(roles), ...(prefix !== undefined ? { 'x-forwarded-prefix': prefix } : {}) });

    test('dashboard under a verified prefix: every URL prefixed, identity shown', async () => {
        const r = await get(port, '/', signed(BASE));
        assert.equal(r.status, 200);
        assert.deepEqual(unprefixedUrls(r.body, BASE), []);
        assert.ok(r.body.includes('href="/fleet/sprints/sprint-1/live"'));
        assert.ok(r.body.includes('Signed in as Test User (admin)'));
        assert.ok(r.body.includes('data-fleet-can-admin="1"'));
    });

    test('viewer role: buttons it may not use are hidden, backlog/launch withheld', async () => {
        const r = await get(port, '/', signed(undefined, ['viewer']));
        assert.ok(r.body.includes('data-fleet-can-operate="0" data-fleet-can-admin="0"'));
        assert.ok(r.body.includes('Signed in as Test User (viewer)'));
        assert.ok(!r.body.includes('id="launch-sprint-form"'));
        assert.ok(!r.body.includes('PROJ-2'), 'backlog rows are not rendered for a viewer');
        const op = await get(port, '/', signed(undefined, ['operator']));
        assert.ok(op.body.includes('data-fleet-can-operate="1" data-fleet-can-admin="0"'));
        assert.ok(op.body.includes('id="launch-sprint-form"'));
    });

    test('proxied live viewer under a verified prefix: every client call prefixed, Location re-rooted', async () => {
        const r = await get(port, '/sprints/sprint-1/live', signed(BASE));
        assert.equal(r.status, 200);
        assert.deepEqual(unprefixedUrls(r.body, BASE), []);
        assert.ok(r.body.includes("new EventSource('/fleet/sprints/sprint-1/live/events')"));
        assert.ok(r.body.includes("fetch('/fleet/sprints/sprint-1/live/stop'"));
        const redirect = await get(port, '/sprints/sprint-1/live/extensions/beads/detail/x', signed(BASE));
        assert.equal(redirect.status, 302);
        assert.equal(redirect.headers.location, '/fleet/extensions/beads/detail/elsewhere');
    });

    test('history view and live history fallthrough under a verified prefix', async () => {
        for (const p of ['/sprints/sprint-old/history', '/sprints/sprint-old/live']) {
            const r = await get(port, p, signed(BASE));
            assert.equal(r.status, 200, p);
            assert.deepEqual(unprefixedUrls(r.body, BASE), [], p);
        }
    });

    test('prefix ignored without an assertion, and with a bad shape', async () => {
        const unsigned = await get(port, '/', { 'x-forwarded-prefix': BASE });
        assert.equal(unsigned.status, 200);
        assert.ok(!unsigned.body.includes('/fleet/'));
        assert.ok(unsigned.body.includes('href="/sprints/sprint-1/live"'));
        for (const bad of ['fleet', '/fleet/', '/a/../b', '//evil.example.com', '/a b']) {
            const r = await get(port, '/', signed(bad));
            assert.equal(r.status, 200, bad);
            assert.ok(r.body.includes('href="/sprints/sprint-1/live"'), `prefix ${bad} must be ignored`);
            assert.ok(!r.body.includes('evil.example.com'), bad);
        }
        const live = await get(port, '/sprints/sprint-1/live', { 'x-forwarded-prefix': BASE });
        assert.ok(live.body.includes("new EventSource('/sprints/sprint-1/live/events')"));
    });

    test('the child viewer never receives the identity assertion or prefix header', async () => {
        let seen = null;
        const spy = http.createServer((req, res) => { seen = req.headers; res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>'); });
        await new Promise((r) => spy.listen(0, '127.0.0.1', r));
        const proxy = createLiveProxy({ resolvePort: () => spy.address().port, logger: silent });
        const sup = createSupervisor({ port: 0, logger: silent });
        registerLiveRoutes(sup, proxy);
        await sup.start();
        try {
            await get(sup.port, '/sprints/s/live', { 'x-fleet-identity': 'abc', 'x-forwarded-prefix': BASE });
            assert.ok(seen);
            assert.equal(seen['x-fleet-identity'], undefined);
            assert.equal(seen['x-forwarded-prefix'], undefined);
        } finally {
            await sup.stop('test');
            await new Promise((r) => spy.close(r));
        }
    });
});
