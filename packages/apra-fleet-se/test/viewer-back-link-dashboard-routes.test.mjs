// =============================================================================
// Every dashboard route to a sprint viewer lands on a page with a
// browser-visible back-link -- with the route list DERIVED from what the
// dashboard actually renders, not hand-listed.
// =============================================================================
//
// test/i9ag5-viewer-back-link-served-routes.test.mjs pins each known viewer
// route one by one. That cannot catch the next link someone adds to the
// dashboard. This file renders the real dashboard index (renderIndexPageHtml)
// with one LIVE sprint and one FINISHED sprint, extracts every per-sprint
// href the page can hand the operator -- static anchors in the markup AND
// links its client scripts build at runtime (`x.href = ... '/sprints/' +
// encodeURIComponent(id) + '/<suffix>'`) -- and fetches each one from a
// supervisor wired the way bin/serve.mjs wires it. Any response that is an
// HTML page (status < 500) is a viewer the operator can land on, and must
// carry EXACTLY ONE back-link to that sprint's own dashboard card; a loud 5xx
// is acceptable; a linkless (or double-linked) HTML page never is. Non-HTML
// 2xx responses (the plain-text raw log) are not viewers and are only
// recorded; a 4xx means the dashboard links to a route this wiring does not
// answer, which fails so the new route gets wired in and checked (a script
// template, instantiated for every id, may 4xx for an id it never applies to
// only if the same route answered for another id).
//
// It also covers the DIRECT route: a real createDashboardViewer child started
// from the argv the serve wiring builds (bin/serve.mjs buildServeSpawnerDeps
// -> spawner -> cli.mjs --viewer-back-url), fetched on its own host:port.
//
// The anchor reader below is self-contained on purpose -- it does not import
// the supervisor's own renderedBodyAnchors(), which is code under test.
// =============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { createDashboardViewer } from '@apralabs/apra-fleet-workflow/viewer';

import { createSpawner } from '../src/supervisor/spawner.mjs';
import { buildServeSpawnerDeps } from '../bin/serve.mjs';
import { parseCliArgs, resolveViewerBackLink } from '../bin/cli.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { createLiveProxy, registerLiveRoutes } from '../src/supervisor/proxy.mjs';
import { createHistoryView, registerHistoryViewRoutes } from '../src/supervisor/history-view.mjs';
import { createLogView, registerLogViewRoutes } from '../src/supervisor/log-view.mjs';
import { renderIndexPageHtml } from '../src/supervisor/dashboard.mjs';
import { MOUNT_PATH_HEADER, mountHref } from '../src/supervisor/mount-prefix.mjs';
import { sprintCardAnchorId } from '../src/supervisor/sprint-anchor.mjs';

/** The regex the release acceptance harness runs over each `a.innerText`. */
const BACK_LINK_TEXT = /console|supervisor|dashboard|sprints/i;
const LIVE_ID = 'sprint-live-r1';
const DONE_ID = 'sprint-done-r1';
const SUPERVISOR_PORT_FOR_ARGV = 8787;
const silentLogger = { log() {}, error() {} };

/** Anchors a browser would find in the rendered body (style/script/comments dropped). */
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
            href: href ? href[1].replace(/&amp;/g, '&') : null,
            text: m[2].replace(/<[^>]*>/g, '').replace(/&larr;/g, '').replace(/\s+/g, ' ').trim(),
        });
    }
    return out;
}

function backLinksTo(html, sprintId) {
    const suffix = '#' + sprintCardAnchorId(sprintId);
    return domAnchors(html).filter((a) => typeof a.href === 'string' && a.href.endsWith(suffix));
}

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
 * Every per-sprint href the rendered dashboard can hand an operator, as
 * `{ href, sprintId, source }`. Two sources, neither hand-listed:
 *   - static: every `href="..."` attribute anywhere in the page that points
 *     at `<mount>/sprints/<id>/...` (cards, finished list, header);
 *   - script: every `<x>.href = <expr>;` assignment in the page's client
 *     scripts whose expression builds `'/sprints/' + encodeURIComponent(..)
 *     + '<suffix>'` -- instantiated for EACH known sprint id, since the
 *     script fills the id in at runtime (e.g. the restart/launch success
 *     "Open live view" link).
 */
function extractSprintHrefs(html, mountPrefix, sprintIds) {
    const found = new Map();
    const add = (href, sprintId, source) => {
        const key = href;
        if (!found.has(key)) found.set(key, { href, sprintId, source });
    };
    const sprintsBase = mountHref(mountPrefix, '/sprints/');
    const attrRe = /href="([^"]*)"/g;
    let m;
    while ((m = attrRe.exec(html)) !== null) {
        const href = m[1].replace(/&amp;/g, '&');
        if (!href.startsWith(sprintsBase)) continue;
        const rest = href.slice(sprintsBase.length);
        const slash = rest.indexOf('/');
        if (slash <= 0) continue;
        const sprintId = decodeURIComponent(rest.slice(0, slash));
        add(href.split('#')[0], sprintId, 'static');
    }
    // Script-built links: any `'/sprints/' + encodeURIComponent(<id>) +
    // '<suffix>'` expression used as an href -- either a DOM assignment
    // (`link.href = ...;`) or an `href="' + ... + '"` attribute inside a
    // client-side row template -- instantiated for every known sprint id.
    // A suffix continued by more concatenation (e.g. '/live/' + action, the
    // POST pause/resume fetch) is not a link target and is skipped.
    const tplRe = /\/sprints\/'\s*\+\s*encodeURIComponent\([^)]*\)\s*\+\s*'(\/[^']*)'(\s*\+\s*[A-Za-z_])?/g;
    while ((m = tplRe.exec(html)) !== null) {
        if (m[2]) continue;
        const before = html.slice(Math.max(0, m.index - 160), m.index);
        const hrefAt = Math.max(before.lastIndexOf('href="'), before.search(/\.href\s*=[^;]*$/));
        if (hrefAt < 0) continue;
        if (/fetch\(|EventSource\(|;/.test(before.slice(hrefAt))) continue;
        for (const sprintId of sprintIds) {
            add(sprintsBase + encodeURIComponent(sprintId) + m[1], sprintId, 'script');
        }
    }
    return [...found.values()];
}

/** `<mount>/sprints/<id>/live` -> `/live`: the route a per-sprint href targets, id removed. */
function routeShape(href, mountPrefix) {
    const rest = href.slice(mountHref(mountPrefix, '/sprints/').length);
    return rest.slice(rest.indexOf('/'));
}

/** Child argv the REAL serve wiring builds for one launch (spawn() stubbed). */
async function serveWiringArgv(sprintId) {
    const captured = [];
    const deps = buildServeSpawnerDeps({
        port: SUPERVISOR_PORT_FOR_ARGV,
        repoRoot: os.tmpdir(),
        beadsIdentity: { get: () => null },
        toolchain: {},
        history: { record: async () => {} },
        ledger: { recordExit: async () => {} },
    });
    let fd = 400;
    const spawner = createSpawner({
        ...deps,
        command: process.execPath,
        isPortAvailable: async () => true,
        dataDir: 'unused-data-dir',
        fs: { mkdirSync() {}, openSync() { return fd++; }, closeSync() {} },
        spawn: (command, args) => {
            captured.push(args);
            return { pid: 8000 + captured.length, once() { return this; }, on() { return this; }, unref() {} };
        },
    });
    await spawner.spawnSprint({ issue: 'x-1', members: 'm1', branch: 'feat/x', base: 'main', runId: sprintId });
    return captured[0].slice(1);
}

/** A real viewer child started from that argv exactly as cli.mjs would. */
async function startChild(sprintId, tmpRoot) {
    const { values } = parseCliArgs(await serveWiringArgv(sprintId));
    const backLink = resolveViewerBackLink(values['viewer-back-url']);
    const server = createDashboardViewer(new EventEmitter(), {
        port: 0,
        debouncedStatePath: path.join(tmpRoot, `${sprintId}-state.json`),
        ...(backLink ? { backLink } : {}),
    });
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    return server;
}

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

describe('dashboard-derived viewer routes all carry exactly one back-link', () => {
    let tmpRoot;
    let child;
    let supervisor;
    let supervisorPort;

    before(async () => {
        tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'vbl-routes-'));
        await fsp.mkdir(path.join(tmpRoot, 'old_runs'), { recursive: true });
        await fsp.writeFile(path.join(tmpRoot, 'old_runs', `${DONE_ID}.json`), JSON.stringify(terminalState(DONE_ID)), 'utf-8');

        child = await startChild(LIVE_ID, tmpRoot);
        const childPort = child.address().port;

        // Wired as bin/serve.mjs wires these routes: live proxy with the
        // history fallthrough, the dedicated History page, and the raw log.
        const historyView = createHistoryView({ env: { APRA_FLEET_DATA_DIR: tmpRoot }, logger: silentLogger });
        const proxy = createLiveProxy({
            resolvePort: (id) => (id === LIVE_ID ? childPort : undefined),
            renderHistory: (id, mp) => historyView.renderForSprint(id, mp),
            logger: silentLogger,
        });
        supervisor = createSupervisor({ port: 0, logger: silentLogger });
        registerLiveRoutes(supervisor, proxy);
        registerHistoryViewRoutes(supervisor, historyView);
        // Real per-sprint raw log files, so the dashboard's Raw log links
        // answer 200 (plain text, not a viewer) instead of a 404.
        const logPaths = {};
        for (const id of [LIVE_ID, DONE_ID]) {
            logPaths[id] = path.join(tmpRoot, `${id}.log`);
            await fsp.writeFile(logPaths[id], `raw log for ${id}\n`, 'utf-8');
        }
        const ledger = { get: (id) => (logPaths[id] ? { logPath: logPaths[id] } : undefined) };
        registerLogViewRoutes(supervisor, createLogView({ ledger, logger: silentLogger }));
        await supervisor.start();
        supervisorPort = supervisor.server.address().port;
    });

    after(async () => {
        if (supervisor) await supervisor.stop('test');
        if (child) await new Promise((r) => child.close(r));
        if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
    });

    for (const mountPrefix of ['', '/ext/se']) {
        const label = mountPrefix === '' ? 'serve-direct' : `embedded under ${mountPrefix}`;

        test(`every viewer-bound href in the rendered dashboard (${label}) lands on exactly one back-link, or a 5xx`, async () => {
            const liveView = {
                sprintId: LIVE_ID, branch: 'feat/x', base: 'main', goal: 'P1', status: 'running-healthy',
                issueRoots: ['x-1'], beadCount: 1, progress: null, members: [{ name: 'm1', role: null }],
                baseDrift: null, beadsPrefix: null, verdict: null, prUrl: null, reason: null,
            };
            const finishedRuns = [{ sprintId: DONE_ID, verdict: 'FAIL', prUrl: null, endedAt: '2026-09-28T10:42:00.000Z', goal: 'P1', status: 'failed', hasTerminalState: true }];
            const page = renderIndexPageHtml([liveView], undefined, undefined, { mountPrefix, finishedRuns });

            const hrefs = extractSprintHrefs(page, mountPrefix, [LIVE_ID, DONE_ID]);
            assert.ok(hrefs.length > 0, 'the dashboard rendered no per-sprint links at all');

            const viewers = [];
            const nonViewers = [];
            const unanswered = [];
            for (const { href, sprintId, source } of hrefs) {
                // The console strips its mount and forwards it as a header;
                // the supervisor itself always routes the unprefixed path.
                const requestPath = mountPrefix && href.startsWith(mountPrefix + '/') ? href.slice(mountPrefix.length) : href;
                const headers = mountPrefix ? { [MOUNT_PATH_HEADER]: mountPrefix } : undefined;
                const res = await getText(supervisorPort, requestPath, headers);
                const isHtml = /text\/html/i.test(String(res.headers['content-type'] || ''));
                if (res.status >= 500) { viewers.push({ href, status: res.status }); continue; }
                // A link the dashboard renders must lead somewhere: a 4xx
                // means it points at a route this (serve-mirroring) wiring
                // does not answer -- wire the new route in above so its
                // page is checked, rather than letting it pass unexamined.
                if (res.status >= 400) {
                    // A script template is instantiated for EVERY known id,
                    // including ones it never applies to (a finished-row
                    // History link for the live sprint) -- tolerated only if
                    // the same route answered for some other id (checked below).
                    assert.equal(source, 'script', `${href} (${source}): the dashboard links here but it answered ${res.status}: ${res.body.slice(0, 200)}`);
                    unanswered.push({ href, sprintId, status: res.status });
                    continue;
                }
                if (!isHtml) { nonViewers.push({ href, status: res.status }); continue; }
                viewers.push({ href, status: res.status });
                const what = `${href} (${source}, ${res.status})`;
                assert.equal(res.status, 200, `${what}: an HTML viewer route must be a 200 page or a loud 5xx`);
                const links = backLinksTo(res.body, sprintId);
                assert.equal(links.length, 1, `${what}: expected exactly one back-link to the sprint card; anchors: ${JSON.stringify(domAnchors(res.body))}`);
                assert.equal(links[0].href, mountHref(mountPrefix, '/#' + sprintCardAnchorId(sprintId)), `${what}: back-link must be the mount-aware card link`);
                assert.match(links[0].text, BACK_LINK_TEXT, `${what}: back-link text`);
            }
            const answered = new Set([...viewers, ...nonViewers].map((v) => routeShape(v.href, mountPrefix)));
            for (const u of unanswered) {
                assert.ok(answered.has(routeShape(u.href, mountPrefix)),
                    `${u.href} (script): this route answered ${u.status} for every sprint id -- the dashboard links to a route this wiring does not serve`);
            }
            // The healthy live child must actually be served (a 5xx is only
            // acceptable for a page that cannot carry a link, not this one --
            // e.g. a duplicated child+injected back-link answers 502).
            const liveEntry = viewers.find((v) => v.href === mountHref(mountPrefix, `/sprints/${LIVE_ID}/live`));
            assert.equal(liveEntry && liveEntry.status, 200, `healthy live child must be served 200: ${JSON.stringify(liveEntry)}`);
            // Not vacuous: the dashboard's known viewer entry points were
            // among the derived routes and were actually checked as viewers.
            const checked = viewers.map((v) => v.href);
            for (const expected of [
                mountHref(mountPrefix, `/sprints/${LIVE_ID}/live`),
                mountHref(mountPrefix, `/sprints/${DONE_ID}/history`),
                mountHref(mountPrefix, `/sprints/${DONE_ID}/live`),
            ]) {
                assert.ok(checked.includes(expected), `expected ${expected} among checked viewer routes; viewers=${JSON.stringify(viewers)} nonViewers=${JSON.stringify(nonViewers)}`);
            }
        });
    }

    test('the extractor picks up a NEW viewer link the dashboard might add (not a hand-listed route set)', () => {
        const page = '<html><body><a href="/sprints/abc/replay">Replay</a>'
            + "<script>x.href = '/sprints/' + encodeURIComponent(id) + '/timeline';"
            + "var row = '<a href=\"' + mountHref(p, '/sprints/' + encodeURIComponent(r.id) + '/diff') + '\">Diff</a>';"
            + "fetch('/sprints/' + encodeURIComponent(id) + '/live/' + action, { method: 'POST' });"
            + "fetch('/sprints/' + encodeURIComponent(id) + '/poke', { method: 'POST' });</script></body></html>";
        const hrefs = extractSprintHrefs(page, '', ['abc', 'def']).map((h) => h.href).sort();
        assert.deepEqual(hrefs, [
            '/sprints/abc/diff', '/sprints/abc/replay', '/sprints/abc/timeline',
            '/sprints/def/diff', '/sprints/def/timeline',
        ]);
    });

    test('the child viewer fetched DIRECTLY on its own host:port has exactly one browser-visible back-link', async () => {
        const res = await getText(child.address().port, '/');
        assert.equal(res.status, 200);
        const links = backLinksTo(res.body, LIVE_ID);
        assert.equal(links.length, 1, `anchors: ${JSON.stringify(domAnchors(res.body))}`);
        assert.equal(links[0].href, `http://localhost:${SUPERVISOR_PORT_FOR_ARGV}/#${sprintCardAnchorId(LIVE_ID)}`);
        assert.match(links[0].text, BACK_LINK_TEXT);
    });
});

