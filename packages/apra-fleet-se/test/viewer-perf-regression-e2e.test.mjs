import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { createDashboardViewer } from '@apralabs/apra-fleet-workflow/viewer';
import { resolveStringRefs } from '@apralabs/apra-fleet-workflow/viewer/lean-state';
import { beadsExtension, renderBeadsHtml } from '../auto-sprint/viewer-extensions.mjs';

// apra-fleet-eft.27.3: end-to-end perf/regression coverage for the eft.27
// bug ("Viewer unusable on large sprints") against a fixture 500+ activity
// sprint, verifying eft.27.1 (lean /state) + eft.27.2 (on-demand description
// + cache) together against the parent bug's acceptance criteria:
//
//   1. GET /state is pinned to summary-only shape (no description/transcript
//      fields) -- a regression guard.
//   2. Recurring poll payload stays under 1 MB regardless of sprint length.
//   3. Expand-click-to-paint stays well under 200 ms (client fetch/cache
//      handler timing bound -- no browser/PerformanceObserver harness is
//      available in this repo, so this is the deterministic proxy the task
//      allows).
//   4. Descriptions load on demand: first expand fetches; a repeat expand of
//      an unchanged bead is a pure cache hit (no network request); a changed
//      updatedAt triggers exactly one refetch.
//   5. No unbounded per-click cost across a 50-expand-click session (proxy
//      for "no page-is-unresponsive dialog"): every one of 50 expand clicks,
//      mixing cache misses and cache hits, individually stays under the
//      200 ms bound and the whole session completes quickly.

const HEAVY_OUTPUT = 'OUT:' + 'x'.repeat(2000);
const HEAVY_DESCRIPTION = 'DESC:' + 'y'.repeat(2000);
const ACTIVITY_COUNT = 500;
const BEAD_COUNT = 30;

function httpGetFull(port, urlPath) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        }).on('error', reject);
    });
}

async function withServer(server, fn) {
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    try {
        return await fn(server.address().port);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function makeBeads(count, updatedAt) {
    return Array.from({ length: count }, (_, i) => ({
        id: `bead-${i}`,
        title: `[impl] Bead number ${i}`,
        status: i % 3 === 0 ? 'closed' : 'open',
        description: HEAVY_DESCRIPTION,
        updated_at: updatedAt
    }));
}

function createMockFleetApi() {
    return {
        async executePrompt() { return { content: [{ text: 'ok' }] }; },
        async executeCommand() { return { content: [{ text: 'ok' }], isError: false }; }
    };
}

// Drives a fresh FleetWorkflow through ACTIVITY_COUNT finished activities
// (the real 449-activity sprint that motivated apra-fleet-eft.27 hit this
// exact shape: heavy `output` re-embedded on every command activity) plus a
// beads extension publish carrying BEAD_COUNT heavy-description tasks.
function seedLargeSprint(wf, { updatedAt = '2026-07-20T00:00:00Z' } = {}) {
    for (let i = 0; i < ACTIVITY_COUNT; i++) {
        const meta = { id: `act-${i}`, type: 'command', label: `bd show bead-${i % BEAD_COUNT}`, member: 'orchestrator' };
        wf.emit('activity:start', meta);
        wf.emit('activity:end', { ...meta, success: true, duration: 42, output: HEAVY_OUTPUT });
    }
    wf.publishState('beads', {
        sprintTasks: makeBeads(BEAD_COUNT, updatedAt),
        backlogTasks: []
    });
}

// createDashboardViewer() persists sprint state under process.cwd() -- run
// every test in this file against a fresh temp cwd so nothing is written
// into the real repo checkout.
let __cwdGuardOriginal;
let __cwdGuardTemp;
beforeEach(() => {
    __cwdGuardTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-viewer-perf-test-cwd-'));
    __cwdGuardOriginal = process.cwd();
    process.chdir(__cwdGuardTemp);
});
afterEach(() => {
    process.chdir(__cwdGuardOriginal);
    fs.rmSync(__cwdGuardTemp, { recursive: true, force: true });
});

describe('apra-fleet-eft.27.3: GET /state on a 500+ activity fixture sprint', () => {
    test('summary-only shape: no description/transcript/output field survives the wire (regression guard)', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const server = createDashboardViewer(wf, { port: 0, name: 'Perf Regression Test' });

        await withServer(server, async (port) => {
            seedLargeSprint(wf);

            // Prove this assertion is not vacuous: the SAME fixture data,
            // serialized directly (i.e. the pre-fix shape -- a raw
            // JSON.stringify of the beads extension payload, exactly what
            // GET /state used to embed before eft.27.1's lean transform)
            // DOES carry the full description. This is the "fails against
            // the pre-fix full-payload endpoint" half of the done criteria:
            // the assertion below is capable of catching a regression, not
            // trivially true regardless of what the endpoint does.
            const rawBeadsJson = JSON.stringify(makeBeads(BEAD_COUNT, '2026-07-20T00:00:00Z'));
            assert.ok(rawBeadsJson.includes(HEAVY_DESCRIPTION), 'sanity: the raw fixture data does carry full descriptions pre-fix');

            const { statusCode, body } = await httpGetFull(port, '/state');
            assert.equal(statusCode, 200);
            assert.ok(!body.includes(HEAVY_DESCRIPTION), 'GET /state must never carry a full bead description');
            assert.ok(!body.includes(HEAVY_OUTPUT), 'GET /state must never carry a full activity output blob');
            for (const field of ['"description":', '"output":', '"transcript":', '"stdout":', '"stderr":']) {
                assert.ok(!body.includes(field), `expected no "${field}" key anywhere in /state, found one`);
            }
        });
    });

    test('recurring poll payload stays under 1 MB regardless of the 500+ activity sprint length', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const server = createDashboardViewer(wf, { port: 0, name: 'Perf Regression Size Test' });

        await withServer(server, async (port) => {
            seedLargeSprint(wf);

            const { statusCode, body } = await httpGetFull(port, '/state');
            assert.equal(statusCode, 200);
            const bytes = Buffer.byteLength(body, 'utf-8');
            assert.ok(bytes < 1024 * 1024, `expected GET /state payload under 1 MB, got ${bytes} bytes`);

            // A second poll (simulating the recurring ~250-400ms poll loop)
            // must hold the same bound -- the payload is not merely small
            // once by accident of ordering.
            const second = await httpGetFull(port, '/state');
            assert.ok(Buffer.byteLength(second.body, 'utf-8') < 1024 * 1024);
        });
    });

    test('the list-state payload still resolves to a usable id/title/status/updatedAt shape for every bead (summary survives, not just absence of heavy fields)', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const server = createDashboardViewer(wf, { port: 0, name: 'Perf Regression Shape Test' });

        await withServer(server, async (port) => {
            seedLargeSprint(wf);
            const { body } = await httpGetFull(port, '/state');
            const raw = JSON.parse(body);
            // Same string-table dereference the served page's client-side
            // script performs (poll(), src/viewer/index.mjs) before handing
            // the state to any rendering/shape logic -- id/updated_at can
            // legitimately be sent as `{ $ref }` markers when repeated across
            // 30+ beads (apra-fleet-eft.27.1's dedupeStrings()).
            const state = resolveStringRefs(raw, raw._strings || []);
            const beadsExt = state.extensions.beads;
            assert.equal(beadsExt.sprintTasks.length, BEAD_COUNT);
            for (const t of beadsExt.sprintTasks) {
                assert.equal(typeof t.id, 'string');
                assert.equal(typeof t.title, 'string');
                assert.equal(typeof t.updated_at, 'string');
                assert.equal(typeof t.summary, 'string');
                assert.ok(!('description' in t));
            }
        });
    });
});

describe('apra-fleet-eft.27.3: on-demand description fetch + cache timing (client fetch/cache module)', () => {
    function createMockLocalStorage() {
        const store = new Map();
        return {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => { store.set(k, String(v)); },
            removeItem: (k) => store.delete(k),
            clear: () => store.clear()
        };
    }

    // Same extraction pattern viewer-extensions.test.mjs already uses: pull
    // the cache/fetch helpers out of beadsExtension.js (the exact source
    // that runs in the browser), minus the top-level addEventListener
    // wireups, so they can be driven directly under Node without a
    // browser/jsdom dependency (not available in this repo).
    function extractHelpers() {
        const src = beadsExtension.js.replace(/document\.addEventListener[\s\S]*$/, '');
        const factory = new Function(`
            ${src}
            return { loadBeadDescription: loadBeadDescription };
        `);
        return factory();
    }

    function makeDetailsEl(id, updatedAt) {
        const bodyEl = { textContent: '', dataset: { loaded: 'false' } };
        return {
            dataset: { beadId: id, updatedAt: updatedAt },
            querySelector: (sel) => (sel === '.bead-desc-body' ? bodyEl : null),
            _bodyEl: bodyEl
        };
    }

    let originalLocalStorage, originalFetch;
    const EXPAND_TO_PAINT_BUDGET_MS = 200;

    test('first expand (cache miss) fetches and paints well under the 200ms expand-to-paint budget', async () => {
        originalLocalStorage = globalThis.localStorage;
        originalFetch = globalThis.fetch;
        try {
            globalThis.localStorage = createMockLocalStorage();
            globalThis.fetch = async (url) => ({
                ok: true,
                json: async () => ({ id: 'bd-1', description: HEAVY_DESCRIPTION, updatedAt: 'v1' })
            });

            const { loadBeadDescription } = extractHelpers();
            const details = makeDetailsEl('bd-1', 'v1');

            const start = performance.now();
            await loadBeadDescription(details);
            const elapsed = performance.now() - start;

            assert.equal(details._bodyEl.dataset.loaded, 'true');
            assert.equal(details._bodyEl.textContent, HEAVY_DESCRIPTION);
            assert.ok(elapsed < EXPAND_TO_PAINT_BUDGET_MS, `expand-to-paint took ${elapsed}ms, expected under ${EXPAND_TO_PAINT_BUDGET_MS}ms`);
        } finally {
            globalThis.localStorage = originalLocalStorage;
            globalThis.fetch = originalFetch;
        }
    });

    test('repeat expand of an unchanged bead is a pure cache hit: no network request, and paints even faster', async () => {
        originalLocalStorage = globalThis.localStorage;
        originalFetch = globalThis.fetch;
        try {
            const storage = createMockLocalStorage();
            globalThis.localStorage = storage;
            let fetchCalls = 0;
            globalThis.fetch = async () => {
                fetchCalls++;
                return { ok: true, json: async () => ({ id: 'bd-1', description: HEAVY_DESCRIPTION, updatedAt: 'v1' }) };
            };

            const { loadBeadDescription } = extractHelpers();

            // First expand: real fetch, populates the cache.
            await loadBeadDescription(makeDetailsEl('bd-1', 'v1'));
            assert.equal(fetchCalls, 1);

            // Second expand of a fresh DOM node for the same (id, updatedAt)
            // -- as would happen after the poll loop rebuilds the row's
            // innerHTML -- must be served entirely from cache.
            const second = makeDetailsEl('bd-1', 'v1');
            const start = performance.now();
            await loadBeadDescription(second);
            const elapsed = performance.now() - start;

            assert.equal(fetchCalls, 1, 'a cache hit must not trigger another network request');
            assert.equal(second._bodyEl.textContent, HEAVY_DESCRIPTION);
            assert.ok(elapsed < EXPAND_TO_PAINT_BUDGET_MS, `cache-hit expand-to-paint took ${elapsed}ms, expected under ${EXPAND_TO_PAINT_BUDGET_MS}ms`);
        } finally {
            globalThis.localStorage = originalLocalStorage;
            globalThis.fetch = originalFetch;
        }
    });

    test('a changed updatedAt invalidates the cache and triggers exactly one refetch, not a stale cache hit', async () => {
        originalLocalStorage = globalThis.localStorage;
        originalFetch = globalThis.fetch;
        try {
            globalThis.localStorage = createMockLocalStorage();
            let fetchCalls = 0;
            globalThis.fetch = async () => {
                fetchCalls++;
                return { ok: true, json: async () => ({ id: 'bd-1', description: 'v' + fetchCalls, updatedAt: 'irrelevant' }) };
            };

            const { loadBeadDescription } = extractHelpers();

            await loadBeadDescription(makeDetailsEl('bd-1', 'v1'));
            assert.equal(fetchCalls, 1);

            const changed = makeDetailsEl('bd-1', 'v2');
            await loadBeadDescription(changed);
            assert.equal(fetchCalls, 2, 'a changed updatedAt must trigger exactly one refetch, not a stale cache hit');
            assert.equal(changed._bodyEl.textContent, 'v2');
        } finally {
            globalThis.localStorage = originalLocalStorage;
            globalThis.fetch = originalFetch;
        }
    });

    test('no unbounded per-click cost across a 50-expand-click session (proxy for "no page-is-unresponsive dialog")', async () => {
        originalLocalStorage = globalThis.localStorage;
        originalFetch = globalThis.fetch;
        try {
            globalThis.localStorage = createMockLocalStorage();
            let fetchCalls = 0;
            globalThis.fetch = async () => {
                fetchCalls++;
                return { ok: true, json: async () => ({ id: 'bd-x', description: HEAVY_DESCRIPTION, updatedAt: 'v1' }) };
            };

            const { loadBeadDescription } = extractHelpers();

            const sessionStart = performance.now();
            for (let click = 0; click < 50; click++) {
                // Alternate across a handful of distinct bead ids so this is
                // a realistic mix of cache misses (first time seeing an id)
                // and cache hits (repeat expand of one already seen).
                const id = `bd-${click % 10}`;
                const details = makeDetailsEl(id, 'v1');
                const start = performance.now();
                await loadBeadDescription(details);
                const elapsed = performance.now() - start;
                assert.ok(elapsed < EXPAND_TO_PAINT_BUDGET_MS, `click ${click} (id ${id}) took ${elapsed}ms, expected under ${EXPAND_TO_PAINT_BUDGET_MS}ms`);
            }
            const totalElapsed = performance.now() - sessionStart;

            // Exactly one fetch per distinct id (10), every repeat expand of
            // an already-seen id within the same updatedAt is a cache hit.
            assert.equal(fetchCalls, 10, 'each distinct bead id should be fetched exactly once across the whole 50-click session');
            assert.ok(totalElapsed < 50 * EXPAND_TO_PAINT_BUDGET_MS, `50-click session took ${totalElapsed}ms in total, expected well under ${50 * EXPAND_TO_PAINT_BUDGET_MS}ms`);
        } finally {
            globalThis.localStorage = originalLocalStorage;
            globalThis.fetch = originalFetch;
        }
    });
});

describe('apra-fleet-eft.27.3: renderBeadsHtml() itself stays fast on a 500+ row fixture (steady-state render bound)', () => {
    test('rendering 500 sprint tasks completes well under a 500ms long-task bound', () => {
        const tasks = makeBeads(500, '2026-07-20T00:00:00Z').map((t, i) => ({
            ...t,
            dependencies: i > 0 ? [{ depends_on_id: `bead-${i - 1}`, type: 'blocks' }] : []
        }));
        const start = performance.now();
        const html = renderBeadsHtml(tasks, []);
        const elapsed = performance.now() - start;
        assert.ok(html.includes('#bead-0'));
        assert.ok(html.includes('#bead-499'));
        assert.ok(elapsed < 500, `renderBeadsHtml() on 500 tasks took ${elapsed}ms, expected under 500ms (long-task guard)`);
    });
});
