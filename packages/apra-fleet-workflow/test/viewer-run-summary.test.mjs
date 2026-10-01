import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';
import { createDashboardViewer, HTML_TEMPLATE } from '../src/viewer/index.mjs';
import { resolveStringRefs } from '../src/viewer/lean-state.mjs';

// Unit coverage for the generic once-per-publish summary hook and the
// GET /state?summary=1 route (src/viewer/run-summary.mjs + the 'state'
// handler and /state routing in src/viewer/index.mjs). Uses only a generic
// fake extension -- core must never name a concrete extension.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEBOUNCE_MS = 200;
const PINNED_KEYS = ['summaryVersion', 'runId', 'status', 'phase', 'pause', 'terminalReason', 'updatedAt', 'endedAt', 'stats', 'extensions'].sort();

let tmpDir;
let origCwd;
beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-viewer-run-summary-'));
    origCwd = process.cwd();
    process.chdir(tmpDir);
});
afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function httpGetJson(port, urlPath) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
                } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function withViewer(extensions, fn) {
    const wf = new EventEmitter();
    const server = createDashboardViewer(wf, {
        port: 0,
        runId: 'run-summary-test',
        dashboardExtensions: extensions,
        debouncedStatePath: path.join(tmpDir, 'state.json'),
        debounceMs: DEBOUNCE_MS,
        stateSnapshotDir: path.join(tmpDir, 'snapshots')
    });
    await new Promise((r) => server.listening ? r() : server.once('listening', r));
    try {
        return await fn(wf, server.address().port);
    } finally {
        await new Promise((r) => server.close(() => r()));
        // Let any pending debounced state write land before afterEach
        // removes the temp dir, so nothing is recreated after cleanup.
        await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 150));
    }
}

function fakeExtension(impl) {
    const calls = [];
    return {
        calls,
        ext: {
            id: 'x',
            title: 'X',
            html: '',
            js: '',
            summarize(data) {
                calls.push(data);
                return impl ? impl(data) : { count: data.items.length };
            }
        }
    };
}

describe('viewer run summary (GET /state?summary=1)', () => {
    test('summarize runs once per publish of its own namespace, never per request', async () => {
        const { ext, calls } = fakeExtension();
        await withViewer([ext], async (wf, port) => {
            wf.emit('state', { namespace: 'x', data: { items: [1, 2, 3] } });
            for (let i = 0; i < 5; i++) {
                const r = await httpGetJson(port, '/state?summary=1');
                assert.strictEqual(r.status, 200);
                assert.match(r.headers['content-type'], /application\/json/);
                assert.match(r.headers['cache-control'], /no-store/);
                assert.strictEqual(r.body.extensions.x.count, 3);
            }
            assert.strictEqual(calls.length, 1);
            wf.emit('state', { namespace: 'x', data: { items: [1] } });
            const r = await httpGetJson(port, '/state?summary=1&_t=123');
            assert.strictEqual(r.body.extensions.x.count, 1);
            assert.ok(!Number.isNaN(Date.parse(r.body.extensions.x.publishedAt)));
            assert.strictEqual(calls.length, 2);
        });
    });

    test('a namespace with no matching extension adds no entry and calls no summarize', async () => {
        const { ext, calls } = fakeExtension();
        const noHook = { id: 'y', title: 'Y', html: '', js: '' };
        await withViewer([ext, noHook], async (wf, port) => {
            wf.emit('state', { namespace: 'xIdentity', data: { items: [1] } });
            wf.emit('state', { namespace: 'y', data: { items: [1] } });
            const r = await httpGetJson(port, '/state?summary=1');
            assert.deepStrictEqual(r.body.extensions, {});
            assert.strictEqual(calls.length, 0);
        });
    });

    test('body has exactly the pinned keys; plain /state keeps the lean payload', async () => {
        const { ext } = fakeExtension();
        await withViewer([ext], async (wf, port) => {
            wf.emit('state', { namespace: 'x', data: { items: [1, 2] } });
            const s = await httpGetJson(port, '/state?summary=1');
            assert.deepStrictEqual(Object.keys(s.body).sort(), PINNED_KEYS);
            assert.strictEqual(s.body.summaryVersion, 1);
            assert.strictEqual(s.body.runId, 'run-summary-test');
            assert.strictEqual(s.body.status, 'running');
            assert.strictEqual(s.body.phase, 'Initialization');
            assert.deepStrictEqual(s.body.pause, { status: 'none', reason: null, since: null, phase: null, group: null, resumeAt: null });
            assert.strictEqual(s.body.endedAt, null);
            assert.deepStrictEqual(s.body.stats, { totalCost: 0, totalTokens: 0 });
            assert.ok(!('tree' in s.body) && !('_strings' in s.body));
            assert.deepStrictEqual(Object.keys(s.body.extensions), ['x']);
            assert.deepStrictEqual(Object.keys(s.body.extensions.x).sort(), ['count', 'publishedAt']);

            for (const url of ['/state?_t=1', '/state']) {
                const lean = await httpGetJson(port, url);
                assert.ok(Array.isArray(lean.body._strings), `${url} has _strings`);
                assert.ok(Array.isArray(lean.body.tree), `${url} has tree`);
                // The top-level summary rides the lean payload unmangled,
                // and does not turn the plain top-level fields into $refs.
                assert.strictEqual(lean.body.runId, 'run-summary-test');
                assert.deepStrictEqual(lean.body.summary, s.body);
                const resolved = resolveStringRefs(lean.body, lean.body._strings);
                assert.deepStrictEqual(resolved.summary, s.body);
            }
        });
    });

    test('core fields follow phase, pause and end with no new publish and no summarize call', async () => {
        const { ext, calls } = fakeExtension();
        await withViewer([ext], async (wf, port) => {
            wf.emit('state', { namespace: 'x', data: { items: [1] } });
            assert.strictEqual(calls.length, 1);

            wf.emit('phase', 'Build');
            let r = await httpGetJson(port, '/state?summary=1');
            assert.strictEqual(r.body.phase, 'Build');

            wf.emit('pause:requested', { reason: 'operator', phase: 'Build', group: null });
            r = await httpGetJson(port, '/state?summary=1');
            assert.strictEqual(r.body.pause.status, 'pausing');
            assert.strictEqual(r.body.pause.reason, 'operator');

            wf.emit('paused', {});
            r = await httpGetJson(port, '/state?summary=1');
            assert.strictEqual(r.body.pause.status, 'paused');
            assert.ok(r.body.pause.since);

            wf.emit('resumed');
            r = await httpGetJson(port, '/state?summary=1');
            assert.strictEqual(r.body.pause.status, 'none');

            wf.emit('activity:end', { id: 'a1', type: 'agent', usage: { total_tokens: 42 }, cost: 0.5 });
            r = await httpGetJson(port, '/state?summary=1');
            assert.deepStrictEqual(r.body.stats, { totalCost: 0.5, totalTokens: 42 });

            wf.emit('end', { status: 'success' });
            r = await httpGetJson(port, '/state?summary=1');
            assert.strictEqual(r.body.status, 'success');
            assert.strictEqual(r.body.terminalReason, 'success');
            assert.ok(r.body.endedAt && !Number.isNaN(Date.parse(r.body.endedAt)));
            assert.ok(Date.parse(r.body.updatedAt) >= Date.parse(r.body.extensions.x.publishedAt));

            assert.strictEqual(calls.length, 1, 'core refreshes never call summarize()');
        });
    });

    test('a throwing summarize() does not break the publish; previous summary is kept', async () => {
        let shouldThrow = false;
        const { ext, calls } = fakeExtension((data) => {
            if (shouldThrow) throw new Error('boom');
            return { count: data.items.length };
        });
        const origWarn = console.warn;
        const warnings = [];
        console.warn = (...a) => { warnings.push(a.join(' ')); };
        try {
            await withViewer([ext], async (wf, port) => {
                wf.emit('state', { namespace: 'x', data: { items: [1, 2] } });
                // The SSE response headers are only flushed on the first
                // broadcast, so subscribe without awaiting the response.
                let req;
                const got = new Promise((resolve, reject) => {
                    req = http.get(`http://127.0.0.1:${port}/events`, (res) => {
                        let buf = '';
                        res.on('data', (c) => {
                            buf += c;
                            if (buf.includes('"type":"state"')) resolve(buf);
                        });
                    });
                    req.on('error', reject);
                });
                // Give the server a moment to register the SSE client.
                await new Promise((r) => setTimeout(r, 100));
                shouldThrow = true;
                assert.doesNotThrow(() => wf.emit('state', { namespace: 'x', data: { items: [1, 2, 3, 4] } }));
                const buf = await got;
                assert.match(buf, /"namespace":"x"/);
                req.destroy();

                const r = await httpGetJson(port, '/state?summary=1');
                assert.strictEqual(r.body.extensions.x.count, 2, 'previous summary kept');
                assert.strictEqual(calls.length, 2);
                // The raw published data still landed in state.extensions.
                const lean = await httpGetJson(port, '/state?_t=1');
                const resolved = resolveStringRefs(lean.body, lean.body._strings);
                assert.strictEqual(resolved.extensions.x.items.length, 4);
            });
        } finally {
            console.warn = origWarn;
        }
        assert.ok(warnings.some((w) => /summarize\(\) for namespace 'x' threw: boom/.test(w)));
    });

    test('client renderState dispatches workflow:summary:NS (null when absent) before workflow:state:NS', () => {
        const html = HTML_TEMPLATE([]);
        const start = html.indexOf('// Generic per-namespace summary hand-off');
        assert.ok(start !== -1, 'template must contain the summary hand-off block');
        const end = html.indexOf('if (isAutoScrolling)', start);
        assert.ok(end !== -1);
        const block = html.slice(start, end);
        const events = [];
        const doc = { dispatchEvent(e) { events.push([e.type, e.detail]); } };
        class FakeCustomEvent { constructor(type, init) { this.type = type; this.detail = init.detail; } }
        const run = new Function('state', 'document', 'CustomEvent', block);
        run({
            extensions: { a: { raw: 1 }, b: { raw: 2 } },
            summary: { extensions: { a: { publishedAt: 't', n: 5 } } }
        }, doc, FakeCustomEvent);
        assert.deepStrictEqual(events, [
            ['workflow:summary:a', { publishedAt: 't', n: 5 }],
            ['workflow:summary:b', null],
            ['workflow:state:a', { raw: 1 }],
            ['workflow:state:b', { raw: 2 }]
        ]);
        // A frozen state with no summary at all (e.g. an older persisted
        // run) dispatches null summaries and does not throw.
        events.length = 0;
        run({ extensions: { a: {} } }, doc, FakeCustomEvent);
        assert.deepStrictEqual(events, [['workflow:summary:a', null], ['workflow:state:a', {}]]);
    });

    test('core summary code names no extension', () => {
        const src = fs.readFileSync(path.join(__dirname, '../src/viewer/run-summary.mjs'), 'utf8');
        for (const word of ['beads', 'sprint', 'computeSprintProgress', 'closed', 'required', 'goalMax']) {
            assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(src), `run-summary.mjs must not mention '${word}'`);
        }
    });
});
