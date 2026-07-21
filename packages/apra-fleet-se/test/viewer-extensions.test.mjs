import { test, describe } from 'node:test';
import assert from 'node:assert';
import { beadsExtension, renderBeadsHtml, renderResultExtrasHtml } from '../auto-sprint/viewer-extensions.mjs';

// Unit tests for apra-fleet-unw.10 (F9/A7-viewer): the beads dashboard
// extension used to inject `node.title`/`node.description` into `innerHTML`
// unescaped (XSS risk -- bead titles/descriptions are LLM-authored, and the
// dashboard page also exposes the /stop capability). `renderBeadsHtml()` is
// a pure string-builder (no `document` access), so its escaping behavior
// can be verified directly under Node without a browser/DOM/jsdom.

describe('renderBeadsHtml: XSS escaping', () => {
    test('a malicious bead title is rendered inert (no live <script> tag survives)', () => {
        const malicious = [{ id: 1, title: '<script>alert(1)</script>', status: 'open' }];
        const html = renderBeadsHtml(malicious);

        assert.ok(!html.includes('<script>alert(1)</script>'), 'the raw payload must not survive verbatim');
        assert.ok(!/<script>/i.test(html), 'no live <script> tag may appear in the rendered output');
        assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the payload must appear HTML-escaped');
    });

    test('a malicious bead description is rendered inert', () => {
        const malicious = [{ id: 2, title: 'normal title', description: '<img src=x onerror=alert(2)>', status: 'open' }];
        const html = renderBeadsHtml(malicious);

        assert.ok(!/<img[^>]*onerror=/i.test(html), 'no live onerror-bearing tag may appear in the rendered output');
        assert.ok(html.includes('&lt;img src=x onerror=alert(2)&gt;'));
    });

    test('a malicious bead id and status are also escaped', () => {
        const malicious = [{ id: '"><script>alert(3)</script>', title: 't', status: '<b>weird</b>' }];
        const html = renderBeadsHtml(malicious);

        assert.ok(!/<script>/i.test(html));
        assert.ok(!html.includes('<b>weird</b>'));
        // Unknown statuses fall back to an uppercased, escaped label --
        // uppercasing happens BEFORE escaping (not after), so HTML entities
        // stay valid (&lt; not &LT;, which browsers would not decode).
        assert.ok(html.includes('&lt;B&gt;WEIRD&lt;/B&gt;'));
    });

    test('benign tasks still render their id/title/status as plain text', () => {
        const html = renderBeadsHtml([{ id: 'BD-1', title: 'Fix the thing', status: 'closed' }]);
        assert.ok(html.includes('#BD-1'));
        assert.ok(html.includes('Fix the thing'));
        // Known statuses render as an uppercased badge label, not the raw
        // lowercase string -- see the STATUS_BADGES map.
        assert.ok(html.includes('CLOSED'));
    });

    test('handles an empty/undefined task list without throwing', () => {
        assert.doesNotThrow(() => renderBeadsHtml([]));
        assert.doesNotThrow(() => renderBeadsHtml(undefined));
    });

    test('nested (parent/child) tasks are all escaped, not just roots', () => {
        const tasks = [
            { id: 'root', title: 'root <script>alert(4)</script>', status: 'open' },
            { id: 'child', parent: 'root', title: 'child <script>alert(5)</script>', status: 'open' }
        ];
        const html = renderBeadsHtml(tasks);
        assert.ok(!/<script>/i.test(html));
        assert.ok(html.includes('&lt;script&gt;alert(4)&lt;/script&gt;'));
        assert.ok(html.includes('&lt;script&gt;alert(5)&lt;/script&gt;'));
    });
});

// apra-fleet-eft.42: the tree used to nest by `blocks`-type dependency edges;
// it now nests by bd's real `parent` (containment) field instead, with
// `blocks` edges preserved as an inline "blocked by" annotation on the row
// rather than tree placement. The expectations below replace/repurpose the
// old blocks-based-nesting assertions, which are now inverted -- see the
// module doc-comment in auto-sprint/viewer-extensions.mjs.
describe('renderBeadsHtml: containment tree (parent-based nesting, blocks-deps as annotations)', () => {
    // A row's id cell is `prefix + '#' + id` where `prefix` is this two-glyph
    // marker (only present at depth > 0) -- built via fromCharCode, not a
    // literal non-ASCII character, per this repo's ASCII-only file convention.
    const childPrefix = String.fromCharCode(0x2514, 0x2500) + ' ';

    test('nests children under their parent (containment); the parent is not left as a childless sibling', () => {
        const tasks = [
            { id: '41', title: '[bug] parent epic', status: 'open' },
            { id: '41.1', parent: '41', title: '[impl] child one', status: 'closed' },
            { id: '41.2', parent: '41', title: '[test] child two', status: 'open' },
            { id: '41.4', parent: '41', title: '[test] child four', status: 'open', dependencies: [{ depends_on_id: '41.1', type: 'blocks' }] },
        ];
        const html = renderBeadsHtml(tasks);

        // Root row has no depth-prefix.
        assert.ok(html.includes('>#41</td>'), '41 must render as a root row');
        // Every child renders WITH the depth-prefix, i.e. nested under 41 --
        // not as a second, unprefixed (root-level) row of its own.
        assert.ok(html.includes(childPrefix + '#41.1</td>'), '41.1 must nest under its parent 41');
        assert.ok(html.includes(childPrefix + '#41.2</td>'), '41.2 must nest under its parent 41');
        assert.ok(html.includes(childPrefix + '#41.4</td>'), '41.4 must nest under its parent 41');
        assert.ok(!html.includes('>#41.1</td>'), '41.1 must not also render as an unnested root-level row');
        assert.ok(!html.includes('>#41.2</td>'), '41.2 must not also render as an unnested root-level row');
        assert.ok(!html.includes('>#41.4</td>'), '41.4 must not also render as an unnested root-level row');
        // 41 must actually precede its children in the output.
        assert.ok(html.indexOf('>#41</td>') < html.indexOf(childPrefix + '#41.1</td>'));
        assert.ok(html.indexOf('>#41</td>') < html.indexOf(childPrefix + '#41.2</td>'));
        assert.ok(html.indexOf('>#41</td>') < html.indexOf(childPrefix + '#41.4</td>'));
    });

    test('a "blocks" dependency renders as an inline "blocked by" annotation, not as tree nesting under the blocker', () => {
        const tasks = [
            { id: 'P1', title: '[bug] parent one', status: 'open' },
            { id: 'X', parent: 'P1', title: '[impl] child of P1, blocked by Y', status: 'open', dependencies: [{ depends_on_id: 'Y', type: 'blocks' }] },
            { id: 'P2', title: '[bug] parent two', status: 'open' },
            { id: 'Y', parent: 'P2', title: '[impl] child of P2 (the blocker)', status: 'closed' },
        ];
        const html = renderBeadsHtml(tasks);

        // X nests under its own parent, P1 -- NOT under its blocker Y.
        assert.ok(html.includes(childPrefix + '#X</td>'), 'X must nest under its parent P1');
        // The blocking relationship is preserved as an inline annotation, not lost.
        assert.ok(html.includes('blocked by: #Y'), 'the blocks edge must still be surfaced as an inline annotation');
        // X (a child of P1) must render before P2 -- proving it was placed in
        // P1's subtree, not pulled into Y's subtree under the unrelated P2.
        assert.ok(html.indexOf('>#P1</td>') < html.indexOf(childPrefix + '#X</td>'));
        assert.ok(html.indexOf(childPrefix + '#X</td>') < html.indexOf('>#P2</td>'), 'X must render inside P1\'s subtree, before the unrelated P2 subtree');
    });

    test('multiple top-level roots (no parent) render as multiple top-level rows, not an error', () => {
        const tasks = [
            { id: 'ROOT1', title: '[impl] root one', status: 'open', dependencies: [] },
            { id: 'ROOT2', title: '[impl] root two', status: 'open', dependencies: [] },
        ];
        assert.doesNotThrow(() => renderBeadsHtml(tasks));
        const html = renderBeadsHtml(tasks);
        assert.ok(html.includes('#ROOT1'));
        assert.ok(html.includes('#ROOT2'));
    });

    test('a task with multiple blockers is rendered exactly once, with every blocker noted in the annotation', () => {
        const tasks = [
            { id: 'A', title: '[impl] a', status: 'closed', dependencies: [] },
            { id: 'B', title: '[impl] b', status: 'closed', dependencies: [] },
            { id: 'C', title: '[impl] c', status: 'open', dependencies: [{ depends_on_id: 'A', type: 'blocks' }, { depends_on_id: 'B', type: 'blocks' }] },
        ];
        const html = renderBeadsHtml(tasks);
        assert.strictEqual((html.match(/#C</g) || []).length, 1, 'C must appear exactly once, not once per blocker');
        assert.ok(html.includes('blocked by: #A, #B'), 'both blockers must be listed in the single annotation');
    });

    test('a `parent`-containment cycle does not crash rendering or infinite-loop (cycle-guard)', () => {
        const tasks = [
            { id: 'A', parent: 'B', title: '[impl] a' },
            { id: 'B', parent: 'A', title: '[impl] b' },
        ];
        assert.doesNotThrow(() => renderBeadsHtml(tasks));
        const html = renderBeadsHtml(tasks);
        assert.ok(html.includes('#A') && html.includes('#B'), 'both nodes in the cycle must still render via the safety-net sweep');
        assert.strictEqual((html.match(/#A</g) || []).length, 1, 'A must not be rendered twice despite the cycle');
        assert.strictEqual((html.match(/#B</g) || []).length, 1, 'B must not be rendered twice despite the cycle');
    });

    test('status badges are unchanged for closed/open/in_progress/blocked rows, even when nested by parent', () => {
        const tasks = [
            { id: 'EPIC', title: '[bug] epic', status: 'in_progress' },
            { id: 'EPIC.1', parent: 'EPIC', title: '[impl] done work', status: 'closed' },
            { id: 'EPIC.2', parent: 'EPIC', title: '[impl] open work', status: 'open' },
            { id: 'EPIC.3', parent: 'EPIC', title: '[impl] not ready', status: 'open', ready: false },
        ];
        const html = renderBeadsHtml(tasks);
        assert.ok(html.includes('IN PROGRESS'));
        assert.ok(html.includes('CLOSED'));
        assert.ok(html.includes('>OPEN<'));
        assert.ok(html.includes('BLOCKED'));
    });

    test('renderBeadsHtml is a pure synchronous function returning a string (no fetch/await in the render path)', () => {
        assert.notStrictEqual(renderBeadsHtml.constructor.name, 'AsyncFunction', 'must not be declared async');
        const result = renderBeadsHtml([{ id: 1, title: 't', status: 'open' }]);
        assert.strictEqual(typeof result, 'string');
        assert.ok(!(result instanceof Promise), 'must return a string directly, never a Promise');
        assert.strictEqual(typeof result.then, 'undefined', 'a plain string has no .then -- confirms this is not a thenable/Promise');
    });
});

describe('renderBeadsHtml: status/type badges are defensive (never blank, never throw)', () => {
    test('in_progress (bd\'s real status string, underscore) gets its accent-colored badge, not the generic fallback', () => {
        const html = renderBeadsHtml([{ id: 1, title: '[impl] active work', status: 'in_progress', dependencies: [] }]);
        assert.ok(html.includes('IN PROGRESS'));
    });

    test('an unrecognized status still renders a visible fallback label, not blank', () => {
        const html = renderBeadsHtml([{ id: 1, title: 't', status: 'some_future_status', dependencies: [] }]);
        assert.ok(html.includes('SOME_FUTURE_STATUS'));
    });

    test('a missing status renders UNKNOWN rather than throwing or rendering blank', () => {
        assert.doesNotThrow(() => renderBeadsHtml([{ id: 1, title: 't', dependencies: [] }]));
        const html = renderBeadsHtml([{ id: 1, title: 't', dependencies: [] }]);
        assert.ok(html.includes('UNKNOWN'));
    });

    test('a recognized [type] title prefix gets its specific badge', () => {
        const html = renderBeadsHtml([{ id: 1, title: '[bug] something broke', status: 'open', dependencies: [] }]);
        assert.ok(html.includes('>BUG<'));
    });

    test('an unrecognized or missing [type] prefix falls back to a visible MISC label, never blank or throwing', () => {
        const withUnknownBracket = renderBeadsHtml([{ id: 1, title: '[frobnicate] something', status: 'open', dependencies: [] }]);
        assert.ok(withUnknownBracket.includes('FROBNICATE'));

        assert.doesNotThrow(() => renderBeadsHtml([{ id: 1, title: 'no bracket prefix at all', status: 'open', dependencies: [] }]));
        const withoutBracket = renderBeadsHtml([{ id: 1, title: 'no bracket prefix at all', status: 'open', dependencies: [] }]);
        assert.ok(withoutBracket.includes('MISC'));
    });

    test('apra-fleet-xbu.C6: issue_type is read first for its own dedicated badge, even with no matching title prefix', () => {
        const html = renderBeadsHtml([{ id: 1, title: 'fix the auth bug', status: 'open', issue_type: 'bug', dependencies: [] }]);
        assert.ok(html.includes('>BUG<'), 'a bug-typed bead must badge as BUG from issue_type alone, not fall through to MISC');
    });

    test('apra-fleet-xbu.C6: a task/feature issue_type (no dedicated badge) still falls back to its [prefix] title convention', () => {
        const html = renderBeadsHtml([{ id: 1, title: '[test] verify the fix', status: 'open', issue_type: 'task', dependencies: [] }]);
        assert.ok(html.includes('>TEST<'), 'issue_type=task has no dedicated badge, so the [test] title prefix must still win, not a bare TASK badge');
    });

    test('apra-fleet-xbu.C6: an open bead explicitly marked not-ready renders BLOCKED, not OPEN', () => {
        const html = renderBeadsHtml([{ id: 1, title: 'deadlocked task', status: 'open', ready: false, dependencies: [] }]);
        assert.ok(html.includes('BLOCKED'), 'ready:false must render a distinct BLOCKED badge');
        assert.ok(!html.includes('>OPEN<'), 'must not also render the plain OPEN badge for the same bead');
    });

    test('apra-fleet-xbu.C6: an open bead with no ready field at all (e.g. backlog) still renders plain OPEN, unchanged', () => {
        const html = renderBeadsHtml([{ id: 1, title: 'plain open task', status: 'open', dependencies: [] }]);
        assert.ok(html.includes('>OPEN<'), 'absence of the ready field must not be misread as blocked');
    });

    test('priority and model metadata render with safe fallbacks when present or absent', () => {
        const withBoth = renderBeadsHtml([{ id: 1, title: 't', status: 'open', priority: 1, metadata: { model: 'premium' }, dependencies: [] }]);
        assert.ok(withBoth.includes('P1'));
        assert.ok(withBoth.includes('premium'));

        assert.doesNotThrow(() => renderBeadsHtml([{ id: 1, title: 't', status: 'open', dependencies: [] }]));
        const withNeither = renderBeadsHtml([{ id: 1, title: 't', status: 'open', dependencies: [] }]);
        assert.ok(withNeither.includes('P?'));
        assert.ok(withNeither.includes('n/a'));
    });
});

describe('renderBeadsHtml: Sprint / Backlog two-section layout', () => {
    test('always renders both a Sprint and a Backlog section header, even when both are empty', () => {
        assert.doesNotThrow(() => renderBeadsHtml());
        const html = renderBeadsHtml();
        assert.ok(html.includes('Sprint'));
        assert.ok(html.includes('Backlog'));
        assert.ok(html.includes('No sprint tasks.'));
        assert.ok(html.includes('No backlog items.'));
    });

    test('backlog items render flat (no indentation-based nesting) and sorted by priority then id', () => {
        const sprintTasks = [{ id: 'S1', title: '[impl] in the sprint', status: 'open', dependencies: [] }];
        const backlogTasks = [
            { id: 'B-low', title: '[bug] low priority backlog item', status: 'open', priority: 4 },
            { id: 'B-high', title: '[bug] high priority backlog item', status: 'deferred', priority: 1 },
        ];
        const html = renderBeadsHtml(sprintTasks, backlogTasks);
        assert.ok(html.includes('#S1'));
        assert.ok(html.includes('#B-low'));
        assert.ok(html.includes('#B-high'));
        assert.ok(html.indexOf('#B-high') < html.indexOf('#B-low'), 'P1 backlog item must sort before P4');
    });

    test('backlog rendering never throws even with minimal/missing fields on backlog items', () => {
        const backlogTasks = [{ id: 'X', title: 'no status, no priority, no metadata, no dependencies' }];
        assert.doesNotThrow(() => renderBeadsHtml([], backlogTasks));
    });
});

describe('apra-fleet-eft.27.2: renderBeadsHtml on-demand description markup', () => {
    test('a lean (summary-only) bead renders an expandable row carrying its id/updatedAt for the client-side fetch, marked NOT loaded', () => {
        const html = renderBeadsHtml([{ id: 'bd-1', title: 'A task', status: 'open', summary: 'short preview...', updated_at: '2026-07-20T00:00:00Z', dependencies: [] }]);
        assert.ok(html.includes('class="bead-desc"'));
        assert.ok(html.includes('data-bead-id="bd-1"'));
        assert.ok(html.includes('data-updated-at="2026-07-20T00:00:00Z"'));
        assert.ok(html.includes('data-loaded="false"'), 'a summary-only bead has no full text yet -- must be marked not-loaded so the client fetches it on expand');
        assert.ok(html.includes('short preview...'));
    });

    test('a bead with the full description inline (e.g. a History-view snapshot) is marked already-loaded -- no fetch needed', () => {
        const html = renderBeadsHtml([{ id: 'bd-2', title: 'A task', status: 'open', description: 'the full text', updated_at: '2026-07-20T00:00:00Z', dependencies: [] }]);
        assert.ok(html.includes('data-loaded="true"'));
        assert.ok(html.includes('the full text'));
    });

    test('a bead with neither description nor summary renders its plain title with no expandable markup', () => {
        const html = renderBeadsHtml([{ id: 'bd-3', title: 'Bare task', status: 'open', dependencies: [] }]);
        assert.ok(!html.includes('bead-desc'));
        assert.ok(html.includes('Bare task'));
    });
});

describe('apra-fleet-eft.27.2: browser-side fetch + localStorage cache (embedded script)', () => {
    function createMockLocalStorage() {
        const store = new Map();
        return {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => { store.set(k, String(v)); },
            removeItem: (k) => store.delete(k),
            clear: () => store.clear()
        };
    }

    // Extracts the cache/fetch helpers embedded in beadsExtension.js (the
    // same source that runs in the browser) exactly as the real page would
    // load them, minus the two top-level addEventListener() wireups (which
    // would otherwise register real listeners against the test's mocked
    // `document`) -- mirrors the extraction pattern the existing
    // "embeds a working renderBeadsHtml()" test above already uses.
    function extractHelpers() {
        const src = beadsExtension.js.replace(/document\.addEventListener[\s\S]*$/, '');
        const factory = new Function(`
            ${src}
            return { loadBeadDescription: loadBeadDescription, readBeadDescCache: readBeadDescCache, writeBeadDescCache: writeBeadDescCache };
        `);
        return factory();
    }

    function makeDetailsEl(id, updatedAt, initialText) {
        const bodyEl = { textContent: initialText, dataset: { loaded: 'false' } };
        return {
            dataset: { beadId: id, updatedAt: updatedAt },
            querySelector: (sel) => (sel === '.bead-desc-body' ? bodyEl : null),
            _bodyEl: bodyEl
        };
    }

    // Globals are saved/restored per-test explicitly (try/finally inside
    // each test body below) rather than via a file-wide beforeEach/afterEach,
    // since only this describe block touches globalThis.localStorage/fetch.
    let originalLocalStorage, originalFetch;

    test('cache miss: fetches from GET /beads/:id/description exactly once, then caches the result', async () => {
        originalLocalStorage = globalThis.localStorage;
        originalFetch = globalThis.fetch;
        try {
            globalThis.localStorage = createMockLocalStorage();
            let fetchCalls = 0;
            globalThis.fetch = async (url) => {
                fetchCalls++;
                assert.ok(url.includes('/beads/bd-1/description'));
                return { ok: true, json: async () => ({ id: 'bd-1', description: 'the full text', updatedAt: 'v1' }) };
            };

            const { loadBeadDescription } = extractHelpers();
            const details = makeDetailsEl('bd-1', 'v1', 'short preview');
            await loadBeadDescription(details);

            assert.equal(fetchCalls, 1);
            assert.equal(details._bodyEl.textContent, 'the full text');
            assert.equal(details._bodyEl.dataset.loaded, 'true');
        } finally {
            globalThis.localStorage = originalLocalStorage;
            globalThis.fetch = originalFetch;
        }
    });

    test('cache hit: a second expand of an unchanged bead (same updatedAt) causes NO network request', async () => {
        originalLocalStorage = globalThis.localStorage;
        originalFetch = globalThis.fetch;
        try {
            const storage = createMockLocalStorage();
            globalThis.localStorage = storage;
            let fetchCalls = 0;
            globalThis.fetch = async () => {
                fetchCalls++;
                return { ok: true, json: async () => ({ id: 'bd-1', description: 'the full text', updatedAt: 'v1' }) };
            };

            const { loadBeadDescription } = extractHelpers();

            // First expand: populates the cache via a real fetch.
            await loadBeadDescription(makeDetailsEl('bd-1', 'v1', 'preview'));
            assert.equal(fetchCalls, 1);

            // Second expand of a FRESH element (simulating the full-innerHTML
            // rebuild a poll tick performs) with the SAME updatedAt: must be
            // served entirely from localStorage, no additional fetch.
            const second = makeDetailsEl('bd-1', 'v1', 'preview');
            await loadBeadDescription(second);
            assert.equal(fetchCalls, 1, 'a cache hit must not trigger another network request');
            assert.equal(second._bodyEl.textContent, 'the full text');
        } finally {
            globalThis.localStorage = originalLocalStorage;
            globalThis.fetch = originalFetch;
        }
    });

    test('a changed updatedAt invalidates the cache and triggers exactly one refetch', async () => {
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

            await loadBeadDescription(makeDetailsEl('bd-1', 'v1', 'preview'));
            assert.equal(fetchCalls, 1);

            // Bead changed server-side -- next poll reports a new updatedAt.
            const changed = makeDetailsEl('bd-1', 'v2', 'preview');
            await loadBeadDescription(changed);
            assert.equal(fetchCalls, 2, 'a changed updatedAt must trigger exactly one refetch, not a stale cache hit');
        } finally {
            globalThis.localStorage = originalLocalStorage;
            globalThis.fetch = originalFetch;
        }
    });

    test('a fetch failure (network error) is handled gracefully, never throwing', async () => {
        originalLocalStorage = globalThis.localStorage;
        originalFetch = globalThis.fetch;
        try {
            globalThis.localStorage = createMockLocalStorage();
            globalThis.fetch = async () => { throw new Error('network down'); };

            const { loadBeadDescription } = extractHelpers();
            const details = makeDetailsEl('bd-1', 'v1', 'preview');
            await assert.doesNotReject(loadBeadDescription(details));
            assert.equal(details._bodyEl.textContent, '(failed to load description)');
        } finally {
            globalThis.localStorage = originalLocalStorage;
            globalThis.fetch = originalFetch;
        }
    });

    test('a 404 response is handled gracefully, never throwing', async () => {
        originalLocalStorage = globalThis.localStorage;
        originalFetch = globalThis.fetch;
        try {
            globalThis.localStorage = createMockLocalStorage();
            globalThis.fetch = async () => ({ ok: false });

            const { loadBeadDescription } = extractHelpers();
            const details = makeDetailsEl('bd-1', 'v1', 'preview');
            await assert.doesNotReject(loadBeadDescription(details));
            assert.equal(details._bodyEl.textContent, '(description unavailable)');
        } finally {
            globalThis.localStorage = originalLocalStorage;
            globalThis.fetch = originalFetch;
        }
    });
});

// apra-fleet-eft.37.3: renderResultExtrasHtml() is the se-owned piece that
// moved OUT of core (which used to mint state.verdict/state.prUrl by name)
// -- it reads the SAME generic state.result object the core Result strip
// reads, but knows the two auto-sprint-specific keys worth coloring/
// link-ifying. Pure string-builder, same testing pattern as renderBeadsHtml.
describe('renderResultExtrasHtml: auto-sprint verdict badge + PR link', () => {
    test('returns an empty string when result has neither verdict nor prUrl', () => {
        assert.strictEqual(renderResultExtrasHtml(null), '');
        assert.strictEqual(renderResultExtrasHtml(undefined), '');
        assert.strictEqual(renderResultExtrasHtml({}), '');
        assert.strictEqual(renderResultExtrasHtml({ notes: 'no verdict here' }), '');
    });

    test('a PASS-family verdict renders in the success color', () => {
        for (const verdict of ['PASS', 'MERGED', 'APPROVED']) {
            const html = renderResultExtrasHtml({ verdict });
            assert.ok(html.includes('var(--success)'), `${verdict} must render success-colored`);
            assert.ok(html.includes(verdict));
        }
    });

    test('a FAIL-family verdict renders in the danger color', () => {
        for (const verdict of ['FAIL', 'CHANGES_NEEDED', 'ABORTED']) {
            const html = renderResultExtrasHtml({ verdict });
            assert.ok(html.includes('var(--danger)'), `${verdict} must render danger-colored`);
        }
    });

    test('an unrecognized verdict still renders (neutral grey), never dropped', () => {
        const html = renderResultExtrasHtml({ verdict: 'SOMETHING_NEW' });
        assert.ok(html.includes('SOMETHING_NEW'));
        assert.ok(html.includes('#a1a1aa'));
    });

    test('a malicious verdict/prUrl is escaped, never a live tag/attribute break-out', () => {
        const html = renderResultExtrasHtml({
            verdict: '<script>alert(1)</script>',
            prUrl: '"><script>alert(2)</script>',
        });
        assert.ok(!/<script>alert/i.test(html));
        assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    });

    test('prUrl renders as a safe, new-tab link when present', () => {
        const html = renderResultExtrasHtml({ verdict: 'PASS', prUrl: 'https://github.com/example/repo/pull/1' });
        assert.ok(html.includes('href="https://github.com/example/repo/pull/1"'));
        assert.ok(html.includes('target="_blank"'));
        assert.ok(html.includes('rel="noopener noreferrer"'));
    });

    test('a null/absent prUrl renders no link at all, but the verdict badge still shows', () => {
        const html = renderResultExtrasHtml({ verdict: 'PASS', prUrl: null });
        assert.ok(!html.includes('<a '));
        assert.ok(html.includes('PASS'));
    });
});

describe('beadsExtension.js: embedded browser script is syntactically valid and self-contained', () => {
    test('parses as a valid function body (no leftover template-literal escaping bugs)', () => {
        assert.doesNotThrow(() => new Function('document', beadsExtension.js));
    });

    test('embeds a working renderBeadsHtml() that escapes malicious input when invoked as a plain function', () => {
        // Extract and invoke renderBeadsHtml exactly as the browser would --
        // proves the .toString()-embedded copy behaves identically to the
        // directly-imported one tested above.
        const factory = new Function(`
            ${beadsExtension.js.replace(/document\.addEventListener[\s\S]*$/, '')}
            return renderBeadsHtml;
        `);
        const embeddedRenderBeadsHtml = factory();
        const html = embeddedRenderBeadsHtml([{ id: 1, title: '<script>alert(1)</script>', status: 'open' }]);
        assert.ok(!/<script>/i.test(html));
        assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    });
});
