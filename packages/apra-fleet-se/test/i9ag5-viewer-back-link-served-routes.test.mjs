// =============================================================================
// apra-fleet-i9ag.5 -- the viewer back-link, asserted on the SERVED ROUTES.
//
// WHY THIS FILE EXISTS ALONGSIDE i9ag53-console-dashboard-viewer-xlink.test.mjs
// ---------------------------------------------------------------------------
// That file round-trips the PURE renderers (dashboard.mjs's anchor id <->
// proxy.mjs's back-link href) against a hand-written two-tag stand-in for the
// child viewer's HTML. It passed the entire time the shipped product served
// linkless viewer pages, because the defect was never in the renderers: the
// generic viewer template (@apralabs/apra-fleet-workflow's HTML_TEMPLATE) has an
// explanatory CSS comment in its `<head>` `<style>` block containing the literal
// text `<body>`, ~12.5KB BEFORE the document's real `<body data-view="..">` tag.
// A first-match `/<body[^>]*>/` splice therefore buried the whole
// `<p><a ..></a></p>` inside CSS, where a browser parses it as style text and it
// never enters the DOM -- `document.querySelectorAll('a')` returned `[]` on both
// the live viewer and the History page in the M1 Windows acceptance run.
//
// So this file asserts the way the acceptance harness does, and over the routes
// an operator actually reaches:
//   * `GET /sprints/:id/live` proxied to a child serving the REAL HTML_TEMPLATE,
//   * `GET /sprints/:id/live` after the sprint finished (history fallthrough,
//     wired exactly as bin/serve.mjs wires it: history-view's renderForSprint),
//   * `GET /sprints/:id/live`'s own compact default renderer (proxy.mjs),
//   * `GET /sprints/:id/history`, the Finished Sprints card's History link,
// each under no mount prefix AND under `/ext/se`, and it reads the response the
// way a DOM does -- comment/`<style>`/`<script>` regions removed first, anchors
// taken from the body only. Deliberately self-contained: it shares no helper
// with the code under test, so it cannot be satisfied by a change that only
// moves the bug behind a shared reader.
// =============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { HTML_TEMPLATE } from '@apralabs/apra-fleet-workflow/viewer';

import { createSupervisor } from '../src/supervisor/server.mjs';
import { createLiveProxy, registerLiveRoutes } from '../src/supervisor/proxy.mjs';
import { createHistoryView, registerHistoryViewRoutes } from '../src/supervisor/history-view.mjs';
import { MOUNT_PATH_HEADER } from '../src/supervisor/mount-prefix.mjs';
import { mountHref } from '../src/supervisor/mount-prefix.mjs';
import { sprintCardAnchorId } from '../src/supervisor/sprint-anchor.mjs';

/** The regex the release acceptance harness runs over each `a.innerText`. */
const BACK_LINK_TEXT = /console|supervisor|dashboard|sprints/i;

const silentLogger = { log() {}, error() {} };

/** GET a supervisor path, resolving the full body once the response ends. */
function getText(port, urlPath, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * The anchors a BROWSER would find in this document's rendered body. Comment,
 * `<style>` and `<script>` regions are dropped FIRST -- their contents are text,
 * not markup -- which is the whole point: an `<a>` that only exists inside one
 * of them is not an anchor in the DOM, and `<body>` inside one of them is not
 * the body tag. Then anchors are read out of whatever follows the real `<body>`
 * start tag, with `innerText`-ish text (nested markup and the arrow entity
 * stripped).
 * @param {string} html
 * @returns {Array<{ href: string|null, text: string }>}
 */
function domAnchors(html) {
    const inert = String(html)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const bodyTag = /<body\b[^>]*>/i.exec(inert);
    const body = bodyTag ? inert.slice(bodyTag.index + bodyTag[0].length) : '';
    const out = [];
    const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
        const href = /href\s*=\s*"([^"]*)"/i.exec(m[1]);
        out.push({
            href: href ? href[1] : null,
            text: m[2].replace(/<[^>]*>/g, '').replace(/&larr;/g, '').replace(/\s+/g, ' ').trim(),
        });
    }
    return out;
}

/**
 * The one assertion every case below shares: this served page hands the
 * operator back to THIS sprint's dashboard card, mount-prefix-aware, with text
 * the acceptance harness recognises.
 */
function assertBackToDashboard(html, { mountPrefix, sprintId, what }) {
    const expected = mountHref(mountPrefix, '/#' + sprintCardAnchorId(sprintId));
    const anchors = domAnchors(html);
    assert.ok(anchors.length > 0, `${what}: the rendered page has NO anchors at all (operator is stranded); got ${JSON.stringify(anchors)}`);
    const hit = anchors.find((a) => a.href === expected);
    assert.ok(hit, `${what}: expected an anchor href="${expected}" in the rendered body; got ${JSON.stringify(anchors)}`);
    assert.match(hit.text, BACK_LINK_TEXT, `${what}: back-link text must be recognisable as a way back; got ${JSON.stringify(hit.text)}`);
    if (mountPrefix) {
        assert.ok(hit.href.startsWith(mountPrefix + '/'), `${what}: mounted back-link must stay under ${mountPrefix}; got ${hit.href}`);
    }
}

/** Headers for one of the two cases: serve-direct, or embedded under /ext/se. */
function headersFor(mountPrefix) {
    return mountPrefix ? { [MOUNT_PATH_HEADER]: mountPrefix } : undefined;
}

/** A finished run's terminal state, as old_runs/<sprintId>.json holds it. */
function terminalState(sprintId) {
    return {
        workflowName: 'fleet-sprint',
        runId: sprintId,
        status: 'failed',
        terminalReason: 'SPRINT_FAILED',
        startedAt: '2026-09-28T10:00:00.000Z',
        endedAt: '2026-09-28T10:42:00.000Z',
        stats: { activitiesCount: 1, totalTokens: 10, totalCost: 0.01, unknownCostCount: 0, startTime: 0, durationMs: 1000 },
        tree: [],
        result: { verdict: 'FAIL', prUrl: null },
    };
}

for (const mountPrefix of ['', '/ext/se']) {
    const label = mountPrefix === '' ? 'serve-direct' : `embedded under ${mountPrefix}`;

    describe(`apra-fleet-i9ag.5: GET /sprints/:id/live carries a dashboard back-link (${label})`, () => {
        test('the live-proxied child viewer page has a back-link a BROWSER can see', async () => {
            const sprintId = 'sprint-live-1';
            // The real generic viewer template -- including the `<style>` block
            // whose CSS comment contains the literal text '<body>'. A stand-in
            // with a bare '<body>' would not reproduce the defect at all.
            const childHtml = HTML_TEMPLATE([], { history: false });
            assert.ok(/<style\b[\s\S]*<body>[\s\S]*<\/style>/i.test(childHtml),
                'precondition: the generic viewer template still contains the literal text <body> inside its <style> block');
            assert.deepEqual(domAnchors(childHtml), [],
                'precondition: the child viewer serves no anchors of its own, so the back-link is the ONLY way back');

            const child = http.createServer((req, res) => {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                res.end(childHtml);
            });
            await new Promise((r) => child.listen(0, '127.0.0.1', r));
            const childPort = child.address().port;

            const proxy = createLiveProxy({ resolvePort: () => childPort, logger: silentLogger });
            const supervisor = createSupervisor({ port: 0, logger: silentLogger });
            registerLiveRoutes(supervisor, proxy);
            await supervisor.start();
            try {
                const res = await getText(supervisor.server.address().port, `/sprints/${sprintId}/live`, headersFor(mountPrefix));
                assert.equal(res.status, 200);
                assertBackToDashboard(res.body, { mountPrefix, sprintId, what: 'live-proxied viewer' });
            } finally {
                await supervisor.stop('test');
                await new Promise((r) => child.close(r));
            }
        });

        test('the finished-sprint fallthrough at the SAME url has one too (wired as bin/serve.mjs wires it)', async () => {
            const sprintId = 'sprint-finished-1';
            const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'i9ag5-live-'));
            try {
                await fsp.mkdir(path.join(dataDir, 'old_runs'), { recursive: true });
                await fsp.writeFile(
                    path.join(dataDir, 'old_runs', `${sprintId}.json`),
                    JSON.stringify(terminalState(sprintId)),
                    'utf-8',
                );
                const historyView = createHistoryView({ env: { APRA_FLEET_DATA_DIR: dataDir }, logger: silentLogger });
                const proxy = createLiveProxy({
                    resolvePort: () => undefined,
                    renderHistory: (id, mp) => historyView.renderForSprint(id, mp),
                    logger: silentLogger,
                });
                const supervisor = createSupervisor({ port: 0, logger: silentLogger });
                registerLiveRoutes(supervisor, proxy);
                await supervisor.start();
                try {
                    const res = await getText(supervisor.server.address().port, `/sprints/${sprintId}/live`, headersFor(mountPrefix));
                    assert.equal(res.status, 200);
                    assertBackToDashboard(res.body, { mountPrefix, sprintId, what: 'live-url history fallthrough' });
                } finally {
                    await supervisor.stop('test');
                }
            } finally {
                await fsp.rm(dataDir, { recursive: true, force: true });
            }
        });

        test("the proxy's own compact default history renderer links to the sprint card, not just the dashboard root", async () => {
            const sprintId = 'sprint-compact-1';
            const proxy = createLiveProxy({
                resolvePort: () => undefined,
                readFile: async () => JSON.stringify({ status: 'success' }),
                logger: silentLogger,
            });
            const supervisor = createSupervisor({ port: 0, logger: silentLogger });
            registerLiveRoutes(supervisor, proxy);
            await supervisor.start();
            try {
                const res = await getText(supervisor.server.address().port, `/sprints/${sprintId}/live`, headersFor(mountPrefix));
                assert.equal(res.status, 200);
                assertBackToDashboard(res.body, { mountPrefix, sprintId, what: 'compact default history page' });
            } finally {
                await supervisor.stop('test');
            }
        });
    });

    describe(`apra-fleet-i9ag.5: GET /sprints/:id/history carries a dashboard back-link (${label})`, () => {
        test('the Finished Sprints card History link lands on a page with a back-link a BROWSER can see', async () => {
            const sprintId = 'sprint-history-1';
            const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'i9ag5-hist-'));
            try {
                await fsp.mkdir(path.join(dataDir, 'old_runs'), { recursive: true });
                await fsp.writeFile(
                    path.join(dataDir, 'old_runs', `${sprintId}.json`),
                    JSON.stringify(terminalState(sprintId)),
                    'utf-8',
                );
                const historyView = createHistoryView({ env: { APRA_FLEET_DATA_DIR: dataDir }, logger: silentLogger });
                const supervisor = createSupervisor({ port: 0, logger: silentLogger });
                registerHistoryViewRoutes(supervisor, historyView);
                await supervisor.start();
                try {
                    const res = await getText(supervisor.server.address().port, `/sprints/${sprintId}/history`, headersFor(mountPrefix));
                    assert.equal(res.status, 200);
                    // The page really is the full rendered viewer (a terminal
                    // state exists), not the plain-text 404 branch.
                    assert.match(res.body, /data-view="history"/);
                    assertBackToDashboard(res.body, { mountPrefix, sprintId, what: 'dedicated History page' });
                } finally {
                    await supervisor.stop('test');
                }
            } finally {
                await fsp.rm(dataDir, { recursive: true, force: true });
            }
        });
    });
}

describe('apra-fleet-i9ag.5: a viewer page that cannot carry a back-link fails LOUD', () => {
    test('a child serving a non-HTML body yields 5xx, never a 200 with no way back', async () => {
        const child = http.createServer((req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"not":"html"}');
        });
        await new Promise((r) => child.listen(0, '127.0.0.1', r));
        const childPort = child.address().port;

        const proxy = createLiveProxy({ resolvePort: () => childPort, logger: silentLogger });
        const supervisor = createSupervisor({ port: 0, logger: silentLogger });
        registerLiveRoutes(supervisor, proxy);
        await supervisor.start();
        try {
            const res = await getText(supervisor.server.address().port, '/sprints/sprint-nonhtml/live');
            assert.ok(res.status >= 500, `expected a loud 5xx, got ${res.status} with body ${JSON.stringify(res.body)}`);
            assert.match(res.body, /back-link/i);
        } finally {
            await supervisor.stop('test');
            await new Promise((r) => child.close(r));
        }
    });

    test('a history renderer that drops the back-link yields 5xx, never a 200 with no way back', async () => {
        const proxy = createLiveProxy({
            resolvePort: () => undefined,
            // A seam that renders a perfectly valid HTML page -- with no link.
            renderHistory: () => '<!DOCTYPE html><html><head><title>x</title></head><body><h1>done</h1></body></html>',
            logger: silentLogger,
        });
        const supervisor = createSupervisor({ port: 0, logger: silentLogger });
        registerLiveRoutes(supervisor, proxy);
        await supervisor.start();
        try {
            const res = await getText(supervisor.server.address().port, '/sprints/sprint-linkless/live');
            assert.ok(res.status >= 500, `expected a loud 5xx, got ${res.status} with body ${JSON.stringify(res.body)}`);
            assert.match(res.body, /back-link/i);
        } finally {
            await supervisor.stop('test');
        }
    });
});
