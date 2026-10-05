// =============================================================================
// The dashboard back-link reaches a supervisor-launched sprint viewer even
// when the operator opens it DIRECTLY on its own --viewer-port.
// =============================================================================
//
// The supervisor already injects a back-link when it proxies a child viewer
// (GET /sprints/:id/live). The same child is also reachable on its own
// host:port -- cli.mjs prints "Dashboard live at http://localhost:PORT" into
// the sprint's raw log -- and that page used to carry no link at all. The fix
// threads an absolute back URL from the serve wiring (buildServeSpawnerDeps)
// through the spawner (buildSprintArgv --viewer-back-url) into cli.mjs, which
// hands it to the generic viewer as opts.backLink. When proxied, the child's
// own link is replaced, so the page still has exactly ONE back-link.
//
// What this file pins:
//   1. buildSprintArgv emits --viewer-back-url only when given one.
//   2. The REAL serve wiring (buildServeSpawnerDeps -> createSpawner, spawn()
//      stubbed) puts a back URL to this sprint's card into the child argv.
//   3. That argv, parsed by cli.mjs's own parser/validator, makes a real
//      createDashboardViewer child render exactly one browser-visible
//      back-link when fetched directly.
//   4. The same child through GET /sprints/:id/live (with and without the
//      /ext/se mount) has exactly one back-link -- the mount-prefixed one.
//   5. cli.mjs given an invalid back URL exits non-zero before doing anything.
// =============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createDashboardViewer, VIEWER_BACK_LINK_ATTR } from '@apralabs/apra-fleet-workflow/viewer';

import { buildSprintArgv, createSpawner } from '../src/supervisor/spawner.mjs';
import { buildServeSpawnerDeps } from '../bin/serve.mjs';
import { parseCliArgs, resolveViewerBackLink } from '../bin/cli.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
import { createLiveProxy, registerLiveRoutes } from '../src/supervisor/proxy.mjs';
import { MOUNT_PATH_HEADER, mountHref } from '../src/supervisor/mount-prefix.mjs';
import { sprintCardAnchorId } from '../src/supervisor/sprint-anchor.mjs';
import {
    VIEWER_BACK_LINK_TEXT_PATTERN,
    CHILD_VIEWER_BACK_LINK_ATTR,
    supervisorViewerBackUrl,
} from '../src/supervisor/viewer-back-link.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'bin', 'cli.mjs');
const silentLogger = { log() {}, error() {} };

/** Self-contained browser-ish anchor reader (no import of the code under test's reader). */
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
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

/** The child argv the REAL serve wiring builds for one launch, spawn() stubbed. */
async function serveWiringArgv({ port, sprintId }) {
    const captured = [];
    const deps = buildServeSpawnerDeps({
        port,
        repoRoot: os.tmpdir(),
        beadsIdentity: { get: () => null },
        serviceToken: undefined,
        toolchain: {},
        history: { record: async () => {} },
        ledger: { recordExit: async () => {} },
    });
    let nextFd = 300;
    const spawner = createSpawner({
        ...deps,
        command: process.execPath,
        basePort: 9400,
        isPortAvailable: async () => true,
        dataDir: 'unused-data-dir',
        fs: { mkdirSync() {}, openSync() { return nextFd++; }, closeSync() {} },
        spawn: (command, args) => {
            captured.push({ command, args });
            return { pid: 7000 + captured.length, once() { return this; }, on() { return this; }, unref() {} };
        },
    });
    await spawner.spawnSprint({ issue: 'x-1', members: 'm1', branch: 'feat/x', base: 'main', runId: sprintId });
    assert.equal(captured.length, 1);
    return captured[0].args.slice(1); // drop the cli.mjs path
}

/** Start a real viewer child the way cli.mjs does, from a parsed argv. */
async function startChildFromArgv(argv) {
    const { values } = parseCliArgs(argv);
    const backLink = resolveViewerBackLink(values['viewer-back-url']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbl-direct-'));
    const server = createDashboardViewer(new EventEmitter(), {
        port: 0,
        debouncedStatePath: path.join(dir, 'state.json'),
        ...(backLink ? { backLink } : {}),
    });
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    return {
        port: server.address().port,
        async close() {
            await new Promise((r) => server.close(r));
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

describe('buildSprintArgv --viewer-back-url', () => {
    const base = { issue: 'x-1', members: 'm1', branch: 'feat/x', base: 'main', viewerPort: 9000 };

    test('with a back URL the flag and URL are emitted', () => {
        const args = buildSprintArgv({ ...base, viewerBackUrl: 'http://localhost:8787/#sprint-card-s1' });
        const i = args.indexOf('--viewer-back-url');
        assert.ok(i >= 0, JSON.stringify(args));
        assert.equal(args[i + 1], 'http://localhost:8787/#sprint-card-s1');
        assert.equal(args.filter((a) => a === '--viewer-back-url').length, 1);
    });

    test('without one no flag is emitted', () => {
        assert.ok(!buildSprintArgv(base).includes('--viewer-back-url'));
    });
});

describe('the marker attribute the proxy strips is the one the generic viewer renders', () => {
    test('CHILD_VIEWER_BACK_LINK_ATTR === VIEWER_BACK_LINK_ATTR', () => {
        assert.equal(CHILD_VIEWER_BACK_LINK_ATTR, VIEWER_BACK_LINK_ATTR);
    });
});

describe('serve wiring supplies a back URL to the launched sprint card', () => {
    test('the child argv carries --viewer-back-url = supervisor origin + / + # + card anchor', async () => {
        const sprintId = 'sprint-abc_1';
        const argv = await serveWiringArgv({ port: 8787, sprintId });
        const i = argv.indexOf('--viewer-back-url');
        assert.ok(i >= 0, `serve wiring must forward --viewer-back-url; argv: ${JSON.stringify(argv)}`);
        assert.equal(argv[i + 1], 'http://localhost:8787/#' + sprintCardAnchorId(sprintId));
        assert.equal(argv[i + 1], supervisorViewerBackUrl('http://localhost:8787', sprintId));
    });

    test('a serve-wired launch with no runId is refused, never silently linkless', async () => {
        const deps = buildServeSpawnerDeps({
            port: 8787, repoRoot: os.tmpdir(), beadsIdentity: { get: () => null }, toolchain: {},
            history: { record: async () => {} }, ledger: { recordExit: async () => {} },
        });
        let spawned = 0;
        const spawner = createSpawner({
            ...deps,
            command: process.execPath,
            isPortAvailable: async () => true,
            fs: { mkdirSync() {}, openSync() { return 1; }, closeSync() {} },
            spawn: () => { spawned += 1; return { pid: 1, once() { return this; }, on() { return this; }, unref() {} }; },
        });
        await assert.rejects(
            spawner.spawnSprint({ issue: 'x-1', members: 'm1', branch: 'feat/x', base: 'main' }),
            /viewer back URL/,
        );
        assert.equal(spawned, 0);
    });
});

describe('a child viewer started with the serve-wired argv', () => {
    test('fetched directly on its own port has exactly one browser-visible back-link to the card', async () => {
        const sprintId = 'sprint-direct-1';
        const child = await startChildFromArgv(await serveWiringArgv({ port: 8787, sprintId }));
        try {
            const res = await getText(child.port, '/');
            assert.equal(res.status, 200);
            const links = backLinksTo(res.body, sprintId);
            assert.equal(links.length, 1, `expected exactly one back-link; anchors: ${JSON.stringify(domAnchors(res.body))}`);
            assert.ok(links[0].href.endsWith('#' + sprintCardAnchorId(sprintId)));
            assert.match(links[0].text, VIEWER_BACK_LINK_TEXT_PATTERN);
            assert.equal(domAnchors(res.body).length, 1, 'no other anchors on the bare child page');
        } finally {
            await child.close();
        }
    });

    for (const mountPrefix of ['', '/ext/se']) {
        const label = mountPrefix === '' ? 'serve-direct' : `embedded under ${mountPrefix}`;
        test(`fetched through GET /sprints/:id/live (${label}) has exactly one back-link, the mount-prefixed one`, async () => {
            const sprintId = 'sprint-proxied-1';
            const child = await startChildFromArgv(await serveWiringArgv({ port: 8787, sprintId }));
            const proxy = createLiveProxy({ resolvePort: () => child.port, logger: silentLogger });
            const supervisor = createSupervisor({ port: 0, logger: silentLogger });
            registerLiveRoutes(supervisor, proxy);
            await supervisor.start();
            try {
                const headers = mountPrefix ? { [MOUNT_PATH_HEADER]: mountPrefix } : undefined;
                const res = await getText(supervisor.server.address().port, `/sprints/${sprintId}/live`, headers);
                assert.equal(res.status, 200, res.body.slice(0, 500));
                const links = backLinksTo(res.body, sprintId);
                assert.equal(links.length, 1, `expected exactly one back-link; anchors: ${JSON.stringify(domAnchors(res.body))}`);
                assert.equal(links[0].href, mountHref(mountPrefix, '/#' + sprintCardAnchorId(sprintId)));
                assert.match(links[0].text, VIEWER_BACK_LINK_TEXT_PATTERN);
                assert.ok(!res.body.includes(`<a ${VIEWER_BACK_LINK_ATTR}`), 'the child-rendered anchor is gone');
            } finally {
                await supervisor.stop('test');
                await child.close();
            }
        });
    }
});

describe('cli.mjs --viewer-back-url validation', () => {
    test('resolveViewerBackLink: absent -> undefined; http(s) -> backLink with recognisable text', () => {
        assert.equal(resolveViewerBackLink(undefined), undefined);
        const bl = resolveViewerBackLink('https://h.example/#c');
        assert.equal(bl.href, 'https://h.example/#c');
        assert.match(bl.text, VIEWER_BACK_LINK_TEXT_PATTERN);
        for (const bad of ['javascript:alert(1)', '/relative', 'not a url', 'ftp://h/x', '']) {
            assert.throws(() => resolveViewerBackLink(bad), /--viewer-back-url/);
        }
    });

    test('an invalid back URL makes cli.mjs exit non-zero before connecting to anything', () => {
        // NODE_TEST_CONTEXT would make cli.mjs's isMainModule() refuse to
        // self-execute (it treats that as "loaded as a test file").
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT;
        const r = spawnSync(process.execPath, [
            CLI_PATH, '--issue', 'x-1', '--members', 'm1', '--branch', 'feat/x', '--base', 'main',
            '--viewer-port', '1', '--viewer-back-url', 'javascript:alert(1)',
        ], { encoding: 'utf-8', timeout: 30_000, env });
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /--viewer-back-url must be an absolute http\(s\) URL/);
        assert.ok(!/Dashboard live at/.test(r.stdout), r.stdout);
    });
});
