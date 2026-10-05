// Integration-level coverage for the beads-tree refresh fix on BOTH views
// that share renderBeadsHtml():
//   - the fleet-sprint Tasks view (beadsExtension.js, viewer-extensions.mjs)
//   - the fleet-supervisor Backlog tab (backlogPanelClientScript(), backlog.mjs,
//     activated through dashboard.mjs's DASHBOARD_TAB_SCRIPT switchTab()).
//
// Same technique as supervisor-dashboard-live-refresh.test.mjs: no jsdom in
// this repo, so the ACTUAL client scripts are extracted verbatim and executed
// against a minimal hand-rolled DOM stub, stubbed fetch/localStorage and
// node:test's virtual clock. Nothing touches the filesystem, so the test
// leaves no artifacts behind.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { beadsExtension } from '../fleet-sprint/viewer-extensions.mjs';
import { renderBacklogPanelHtml } from '../src/supervisor/backlog.mjs';
import { renderIndexPageHtml } from '../src/supervisor/dashboard.mjs';

const DESC_OPEN_RE = (id) => new RegExp('<details class="bead-desc" data-bead-id="' + id + '"[^>]*\\sopen>');

// ---------------------------------------------------------------------------
// Tasks view (beadsExtension.js)
// ---------------------------------------------------------------------------

/**
 * #extension-beads stand-in: counts innerHTML writes and answers
 * querySelectorAll('details.bead-desc[open]') from the markup it holds, handing
 * back one element per open description whose body text the script can
 * restore -- the post-rebuild cache-restore path runs for real.
 */
function makeBeadsContainer() {
    let html = '';
    let writes = 0;
    let openEls = [];
    return {
        get innerHTML() { return html; },
        set innerHTML(v) {
            html = v;
            writes++;
            openEls = [];
            const re = /<details class="bead-desc" data-bead-id="([^"]*)" data-updated-at="([^"]*)" open>.*?<div class="bead-desc-body" data-loaded="(true|false)"[^>]*>([^<]*)<\/div>/g;
            let m;
            while ((m = re.exec(v)) !== null) {
                const body = { textContent: m[4], dataset: { loaded: m[3] } };
                openEls.push({ dataset: { beadId: m[1], updatedAt: m[2] }, querySelector: (sel) => (sel === '.bead-desc-body' ? body : null), body });
            }
        },
        querySelectorAll(sel) {
            if (sel !== 'details.bead-desc[open]') throw new Error('unsupported selector: ' + sel);
            return openEls.slice();
        },
        writes: () => writes,
        openBody: (id) => {
            const el = openEls.find((e) => e.dataset.beadId === id);
            return el ? el.body : null;
        },
    };
}

function bootTasksView() {
    const listeners = {};
    const container = makeBeadsContainer();
    const others = {};
    const document = {
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        getElementById(id) {
            if (id === 'extension-beads') return container;
            if (!others[id]) others[id] = { innerHTML: '' };
            return others[id];
        },
    };
    const store = new Map();
    const localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
    };
    const fetchCalls = [];
    const detailText = {};
    const fetch = async (url) => {
        fetchCalls.push(url);
        const id = decodeURIComponent(url.split('/').pop());
        return { ok: true, json: async () => ({ text: detailText[id] }) };
    };
    // localStorage/fetch passed as parameters so they shadow the globals --
    // the script reads them as free identifiers, exactly as in a browser.
    new Function('document', 'localStorage', 'fetch', beadsExtension.js)(document, localStorage, fetch);

    const push = (sprintTasks) => listeners['workflow:state:beads'][0]({ detail: { sprintTasks, backlogTasks: [] } });
    const toggleDesc = (id, open) => {
        const body = { textContent: '', dataset: { loaded: 'false' } };
        const m = new RegExp('data-bead-id="' + id + '" data-updated-at="([^"]*)"').exec(container.innerHTML);
        const el = {
            tagName: 'DETAILS', open, dataset: { beadId: id, updatedAt: m ? m[1] : '' },
            classList: { contains: (c) => c === 'bead-desc' },
            querySelector: (sel) => (sel === '.bead-desc-body' ? body : null),
        };
        listeners['toggle'].forEach((fn) => fn({ target: el }));
    };
    const foldRow = (id) => listeners['click'][0]({ target: { closest: (sel) => (sel === '.tree-toggle' ? { dataset: { toggleId: id } } : null) } });
    return { container, push, toggleDesc, foldRow, fetchCalls, detailText };
}

// Lean GET /state shape: a short `summary`, no full `description`.
function tasksPayload(xTitle, xUpdatedAt) {
    return [
        { id: 'X', title: xTitle, summary: 'x short', status: 'open', updated_at: xUpdatedAt },
        { id: 'Y', title: 'y title', summary: 'y short', status: 'open', updated_at: '1' },
        { id: 'P', title: 'p parent', summary: 'p short', status: 'open', updated_at: '1' },
        { id: 'P.1', parent: 'P', title: 'p child', summary: 'p child short', status: 'open', updated_at: '1' },
    ];
}

const BEADS_RENDER_MIN_INTERVAL_MS = 15000;

describe('Tasks view: beads tree keeps expanded and collapsed state across a refresh', () => {
    test('an expanded description stays open with the updated content, a never-expanded sibling stays closed, a collapsed row stays collapsed', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
        const v = bootTasksView();
        v.detailText.X = 'x full text v1';
        v.push(tasksPayload('x title v1', 'u1'));
        assert.ok(v.container.innerHTML.includes('#P.1</td>'), 'P.1 visible before folding');

        v.toggleDesc('X', true);
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        assert.equal(v.fetchCalls.length, 1, 'first expand fetches the full text once');
        v.foldRow('P');
        assert.ok(!v.container.innerHTML.includes('#P.1</td>'));
        assert.ok(DESC_OPEN_RE('X').test(v.container.innerHTML), 'X stays open across the fold rebuild');
        assert.equal(v.fetchCalls.length, 1, 'the fold rebuild restores X from the cache, no refetch');
        assert.equal(v.container.openBody('X').textContent, 'x full text v1');

        // One full refresh cycle: past the min-render interval, a payload with
        // a new title and updatedAt for X.
        t.mock.timers.tick(BEADS_RENDER_MIN_INTERVAL_MS);
        v.detailText.X = 'x full text v2';
        v.push(tasksPayload('x title v2', 'u2'));
        assert.ok(v.container.innerHTML.includes('x title v2'), 'the new title renders');
        assert.ok(DESC_OPEN_RE('X').test(v.container.innerHTML), 'X is still open');
        assert.ok(!DESC_OPEN_RE('Y').test(v.container.innerHTML), 'Y, never expanded, is still closed');
        assert.ok(!v.container.innerHTML.includes('#P.1</td>'), 'P is still collapsed');
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
        assert.equal(v.fetchCalls.length, 2, 'a changed updatedAt refetches exactly once');
        assert.equal(v.container.openBody('X').textContent, 'x full text v2', 'X shows the updated full text');

        // Same updatedAt again, different unrelated content -> cache hit, no fetch.
        t.mock.timers.tick(BEADS_RENDER_MIN_INTERVAL_MS);
        const again = tasksPayload('x title v2', 'u2');
        again[1] = { ...again[1], title: 'y title changed' };
        v.push(again);
        assert.equal(v.fetchCalls.length, 2, 'unchanged updatedAt is served from the cache');
        assert.equal(v.container.openBody('X').textContent, 'x full text v2');
    });

    test('identical payloads dispatched N times cause zero extra innerHTML writes', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
        const v = bootTasksView();
        v.push(tasksPayload('x title v1', 'u1'));
        const base = v.container.writes();
        for (let i = 0; i < 25; i++) {
            v.push(tasksPayload('x title v1', 'u1'));
            t.mock.timers.tick(400); // core's SSE-coalesced poll cadence
        }
        t.mock.timers.tick(7000 * 5); // and several heartbeat polls' worth of time
        v.push(tasksPayload('x title v1', 'u1'));
        assert.equal(v.container.writes(), base);
    });

    test('changed payloads inside the window cause exactly one trailing write carrying the latest payload', (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
        const v = bootTasksView();
        v.push(tasksPayload('x title v1', 'u1'));
        const base = v.container.writes();
        for (let i = 2; i <= 9; i++) {
            t.mock.timers.tick(400);
            v.push(tasksPayload('x title v' + i, 'u' + i));
        }
        assert.equal(v.container.writes(), base, 'nothing renders inside the window');
        t.mock.timers.tick(BEADS_RENDER_MIN_INTERVAL_MS);
        assert.equal(v.container.writes(), base + 1, 'exactly one trailing write');
        assert.ok(v.container.innerHTML.includes('x title v9'));
        assert.ok(!v.container.innerHTML.includes('x title v8'));
        t.mock.timers.tick(BEADS_RENDER_MIN_INTERVAL_MS * 4);
        assert.equal(v.container.writes(), base + 1);
    });
});

// ---------------------------------------------------------------------------
// Backlog tab (backlogPanelClientScript + DASHBOARD_TAB_SCRIPT switchTab)
// ---------------------------------------------------------------------------

class MockClassList {
    constructor() { this.set = new Set(); }
    add(c) { this.set.add(c); }
    remove(c) { this.set.delete(c); }
    contains(c) { return this.set.has(c); }
}

function extractTabScript() {
    const html = renderIndexPageHtml([]);
    const start = html.indexOf('var TAB_ACTIVATION_STALE_MS');
    assert.ok(start !== -1, 'renderIndexPageHtml() must embed DASHBOARD_TAB_SCRIPT');
    return html.slice(start, html.indexOf('</script>', start));
}

function bootBacklogTab(initialTasks) {
    const panelHtml = renderBacklogPanelHtml(initialTasks, { type: [], status: [], priority: [], model: [] });
    const script = panelHtml.slice(panelHtml.lastIndexOf('<script>') + '<script>'.length, panelHtml.lastIndexOf('</script>'));
    const tableStart = panelHtml.indexOf('<div id="backlog-table">') + '<div id="backlog-table">'.length;

    const listeners = {};
    const table = {
        innerHTML: panelHtml.slice(tableStart, panelHtml.indexOf('</div><script>', tableStart)),
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        querySelectorAll: () => [],
    };
    const tabBtns = { sprints: { classList: new MockClassList() }, backlog: { classList: new MockClassList() } };
    const tabPanels = { sprints: { classList: new MockClassList() }, backlog: { classList: new MockClassList() } };
    const document = {
        getElementById(id) {
            if (id === 'backlog-table') return table;
            if (id === 'tab-sprints') return tabPanels.sprints;
            if (id === 'tab-backlog') return tabPanels.backlog;
            return null;
        },
        querySelectorAll(sel) {
            if (sel === '.tab-btn') return Object.values(tabBtns);
            if (sel === '.tab-content') return Object.values(tabPanels);
            return [];
        },
    };
    const window = { __backlogTasks: initialTasks.slice() };
    let nextTasks = initialTasks;
    const fetchCalls = [];
    const fetch = (url) => {
        fetchCalls.push(url);
        const tasks = nextTasks;
        return Promise.resolve({ json: () => Promise.resolve({ tasks, total: tasks.length }) });
    };
    new Function('document', 'window', 'fetch', script)(document, window, fetch);

    const event = { currentTarget: null };
    const location = { reload() { throw new Error('a tab switch must never reload the page'); } };
    const switchTab = new Function('document', 'window', 'event', 'location', extractTabScript() + '\n;return switchTab;')(document, window, event, location);
    const activate = (id) => { event.currentTarget = tabBtns[id]; switchTab(id); };

    const toggleDesc = (id, open) => (listeners.toggle || []).forEach((fn) => fn({
        target: { tagName: 'DETAILS', open, dataset: { beadId: id }, classList: { contains: (c) => c === 'bead-desc' } },
    }));
    const foldRow = (id) => listeners.click.forEach((fn) => fn({ target: { closest: () => ({ dataset: { toggleId: id } }) } }));
    return { table, fetchCalls, activate, toggleDesc, foldRow, setNextTasks: (t) => { nextTasks = t; } };
}

const settle = () => new Promise((r) => setImmediate(r));
const BACKLOG_THRESHOLD_MS = 30000;

const backlogV1 = [
    { id: 'X', title: 'x title v1', description: 'x body v1', status: 'open', priority: 1 },
    { id: 'Y', title: 'y title', description: 'y body', status: 'open', priority: 1 },
    { id: 'R', title: 'r parent', description: 'r body', status: 'open', priority: 2 },
    { id: 'R.1', parent: 'R', title: 'r child', description: 'r child body', status: 'open', priority: 2 },
];
const backlogV2 = backlogV1.map((t) => (t.id === 'X' ? { ...t, title: 'x title v2', description: 'x body v2' } : t));

describe('Backlog tab: beads tree keeps expanded and folded state across a refetch', () => {
    test('a tab activation past the threshold refetches once; X stays open with the new content and R stays folded', async (t) => {
        t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
        const b = bootBacklogTab(backlogV1);
        assert.ok(b.table.innerHTML.includes('#R.1</td>'), 'R.1 visible before folding');
        b.toggleDesc('X', true);
        b.foldRow('R');
        assert.ok(!b.table.innerHTML.includes('#R.1</td>'));

        b.setNextTasks(backlogV2);
        t.mock.timers.tick(BACKLOG_THRESHOLD_MS);
        b.activate('backlog');
        assert.equal(b.fetchCalls.length, 1, 'exactly one GET /api/backlog/tasks past the threshold');
        assert.ok(b.fetchCalls[0].startsWith('/api/backlog/tasks?'));
        await settle();

        assert.ok(b.table.innerHTML.includes('x title v2') && b.table.innerHTML.includes('x body v2'), 'the new content renders');
        assert.ok(DESC_OPEN_RE('X').test(b.table.innerHTML), 'X is still open');
        assert.ok(!DESC_OPEN_RE('Y').test(b.table.innerHTML), 'Y, never opened, is still closed');
        assert.ok(!b.table.innerHTML.includes('#R.1</td>'), 'R is still folded');
    });

    test('a tab activation inside the threshold issues no fetch; the Sprints tab threshold is still 3000 ms', (t) => {
        t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
        const b = bootBacklogTab(backlogV1);
        b.activate('backlog');
        t.mock.timers.tick(3000); // the old shared threshold -- no longer enough
        b.activate('backlog');
        t.mock.timers.tick(BACKLOG_THRESHOLD_MS - 3000 - 1);
        b.activate('backlog');
        assert.equal(b.fetchCalls.length, 0, 'no fetch inside the Backlog threshold');
        t.mock.timers.tick(1);
        b.activate('backlog');
        assert.equal(b.fetchCalls.length, 1);
        assert.ok(extractTabScript().includes('var TAB_ACTIVATION_STALE_MS = 3000;'));
    });
});
