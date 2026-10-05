import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { renderKbCodeIntelHtml, kbCodeIntelExtension } from '../fleet-sprint/viewer-extensions.mjs';
import { DISPATCH_TOOL_CALLS_STATE_NAMESPACE, UNKNOWN_COUNT } from '../fleet-sprint/dispatch-accounting.mjs';

// The Knowledge and Code Intel viewer tab: per-member and per-dispatch kb_* and
// code_* call counts from dispatch-accounting.mjs's published records. Pinned
// against the pure renderer AND against the copy embedded into the browser
// script via .toString() (run here in a vm with a minimal fake document), so the
// browser copy is proven to behave the same.

const DATA = {
    dispatches: [
        { index: 1, member: 'alpha', role: 'doer', label: 'Doer C1', kb: 3, code: 2, reason: null },
        { index: 2, member: 'beta', role: 'reviewer', label: null, kb: UNKNOWN_COUNT, code: UNKNOWN_COUNT, reason: 'after-snapshot read failed' },
        { index: 3, member: 'alpha', role: 'doer', label: null, kb: 0, code: 1, reason: null },
    ],
};

/** The cell texts of every <tr> in the table marked with `attr`. */
function rows(html, attr) {
    const m = new RegExp('<table ' + attr + '="true"[^>]*>(.*?)</table>').exec(html);
    assert.ok(m, `table ${attr} not found in: ${html}`);
    return [...m[1].matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].slice(1)
        .map((r) => [...r[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((c) => c[1]));
}

/** Run the extension's browser script against a fake document; return the render function. */
function browserCopy() {
    const listeners = {};
    const container = { innerHTML: '' };
    const document = {
        getElementById: (id) => (id === 'extension-kb-code-intel' ? container : null),
        addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    };
    vm.runInNewContext(kbCodeIntelExtension.js, { document });
    return {
        container,
        dispatch(type, detail) { for (const fn of listeners[type] || []) fn({ detail }); },
        listeners,
    };
}

describe('renderKbCodeIntelHtml', () => {
    test('renders per-dispatch kb and code counts with member and role', () => {
        const html = renderKbCodeIntelHtml(DATA);
        assert.match(html, /data-kb-code-intel="true"/);
        assert.deepEqual(rows(html, 'data-kb-panel-dispatches'), [
            ['1', 'alpha', 'doer', 'Doer C1', '3', '2'],
            ['2', 'beta', 'reviewer', '-', 'unknown', 'unknown'],
            ['3', 'alpha', 'doer', '-', '0', '1'],
        ]);
    });

    test('renders per-member totals; a member with any unknown dispatch has an unknown total', () => {
        assert.deepEqual(rows(renderKbCodeIntelHtml(DATA), 'data-kb-panel-members'), [
            ['alpha', '2', '3', '3'],
            ['beta', '1', 'unknown', 'unknown'],
        ]);
    });

    test('an unknown count renders as unknown, never 0 -- including missing and malformed values', () => {
        const html = renderKbCodeIntelHtml({ dispatches: [
            { index: 1, member: 'm', role: 'doer', kb: UNKNOWN_COUNT, code: undefined },
            { index: 2, member: 'n', role: 'doer', kb: -1, code: 'seven' },
        ] });
        const r = rows(html, 'data-kb-panel-dispatches');
        assert.deepEqual(r.map((x) => x.slice(4)), [['unknown', 'unknown'], ['unknown', 'unknown']]);
        assert.deepEqual(rows(html, 'data-kb-panel-members').map((x) => x.slice(2)), [['unknown', 'unknown'], ['unknown', 'unknown']]);
        assert.doesNotMatch(html, />0</, 'no unknown may be rendered as 0');
        assert.match(html, /title="after-snapshot read failed"|data-kb-panel-unknown="true"/);
    });

    test('the unknown reason is surfaced as a tooltip', () => {
        assert.match(renderKbCodeIntelHtml(DATA), /data-kb-panel-unknown="true"[^>]*title="after-snapshot read failed"/);
    });

    test('member names and every other value are HTML-escaped', () => {
        const html = renderKbCodeIntelHtml({ dispatches: [
            { index: 1, member: '<img src=x onerror=alert(1)>', role: '<b>doer</b>', label: '"q" & <l>', kb: 1, code: 1, reason: null },
            { index: 2, member: 'ok', role: 'doer', kb: UNKNOWN_COUNT, code: 1, reason: '<script>x</script>' },
        ] });
        assert.doesNotMatch(html, /<img/);
        assert.doesNotMatch(html, /<b>doer/);
        assert.doesNotMatch(html, /<script>/);
        assert.doesNotMatch(html, /<l>/);
        assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
        assert.match(html, /&lt;b&gt;doer&lt;\/b&gt;/);
    });

    test('empty, absent and malformed input never throws', () => {
        assert.match(renderKbCodeIntelHtml({ dispatches: [] }), /no dispatches recorded yet/);
        assert.match(renderKbCodeIntelHtml(null), /no dispatches recorded yet/);
        assert.match(renderKbCodeIntelHtml({ dispatches: 'nope' }), /no dispatches recorded yet/);
        assert.match(renderKbCodeIntelHtml({ dispatches: [null, 7] }), /no dispatches recorded yet/);
    });
});

describe('kbCodeIntelExtension (browser copy)', () => {
    test('is its own tab, subscribed to the dispatch accounting namespace', () => {
        assert.equal(kbCodeIntelExtension.id, 'kb-code-intel');
        assert.match(kbCodeIntelExtension.title, /Knowledge/);
        const b = browserCopy();
        assert.ok(b.listeners['workflow:state:' + DISPATCH_TOOL_CALLS_STATE_NAMESPACE], 'listens on the published namespace');
    });

    test('renders the same numbers as the server-side renderer, unknown as unknown', () => {
        const b = browserCopy();
        b.dispatch('workflow:state:' + DISPATCH_TOOL_CALLS_STATE_NAMESPACE, DATA);
        assert.equal(b.container.innerHTML, renderKbCodeIntelHtml(DATA));
        assert.deepEqual(rows(b.container.innerHTML, 'data-kb-panel-dispatches')[1].slice(4), ['unknown', 'unknown']);
    });

    test('escapes a member name containing < in the browser copy too', () => {
        const b = browserCopy();
        b.dispatch('workflow:state:' + DISPATCH_TOOL_CALLS_STATE_NAMESPACE, { dispatches: [{ index: 1, member: 'a<b', role: 'doer', kb: 1, code: 0 }] });
        assert.match(b.container.innerHTML, /a&lt;b/);
        assert.doesNotMatch(b.container.innerHTML, /a<b/);
    });
});
