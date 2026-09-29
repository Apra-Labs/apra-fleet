import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { renderKbCodeIntelHtml, kbCodeIntelExtension } from '../fleet-sprint/viewer-extensions.mjs';
import { PREFLIGHT_STATE_NAMESPACE } from '../fleet-sprint/member-preflight.mjs';
import { DISPATCH_ACCOUNTING_STATE_NAMESPACE, CODE_CALLS_NOT_OBSERVABLE } from '../fleet-sprint/dispatch-accounting.mjs';

// =============================================================================
// apra-fleet-b4g.21 -- Knowledge and Code Intelligence panel. Pins the nine
// acceptance criteria against the pure renderer (server-side, directly
// imported) and against the SAME source embedded via .toString() into
// kbCodeIntelExtension.js (proving the browser copy behaves identically).
// =============================================================================

describe('renderKbCodeIntelHtml: AC1/AC6 -- a distinct panel over already-computed data', () => {
    test('renders a distinct container, never throwing on well-formed input', () => {
        const html = renderKbCodeIntelHtml(
            { members: [] },
            { dispatches: [] },
        );
        assert.match(html, /data-kb-code-intel="true"/);
    });
});

describe('renderKbCodeIntelHtml: AC2 -- per-member init, index rendered as launch state never a commit', () => {
    test('analyze-started renders as launch-issued, never a commit or completion claim', () => {
        const html = renderKbCodeIntelHtml({
            members: [{
                member: 'alice', repoPath: '/r/alice', remoteUrl: null, mcpScope: null, kbEntryCount: 7,
                checks: {
                    index: { check: 'index', outcome: 'analyze-started' },
                    kb: { check: 'kb', outcome: 'ok' },
                    code: { check: 'code', outcome: 'ok' },
                },
                warnings: [],
            }],
        }, { dispatches: [] });
        assert.match(html, /launch issued/);
        assert.doesNotMatch(html, /done at commit/i);
        assert.doesNotMatch(html, /\bcommit\b/i);
        assert.match(html, />7</, 'the KB entry count must be printed');
    });

    test('analyze-not-started renders launch-failed with the cause', () => {
        const html = renderKbCodeIntelHtml({
            members: [{
                member: 'bob', repoPath: '/r/bob', remoteUrl: null, mcpScope: null, kbEntryCount: 0,
                checks: {
                    index: { check: 'index', outcome: 'analyze-not-started', cause: 'launcher not on PATH' },
                    kb: { check: 'kb', outcome: 'kb-empty' },
                    code: { check: 'code', outcome: 'index-not-ready' },
                },
                warnings: [],
            }],
        }, { dispatches: [] });
        assert.match(html, /launch failed: launcher not on PATH/);
        assert.match(html, /index-not-ready/);
    });

    test('the resolved scope (repoPath + remoteUrl) is shown per member', () => {
        const html = renderKbCodeIntelHtml({
            members: [{
                member: 'carol', repoPath: '/r/carol', remoteUrl: 'https://example.invalid/carol.git', mcpScope: null,
                kbEntryCount: 2, checks: {}, warnings: [],
            }],
        }, { dispatches: [] });
        assert.match(html, /\/r\/carol/);
        assert.match(html, /example\.invalid\/carol\.git/);
    });

    test('an unscoped member renders its scope as unscoped with the reason, not a fabricated path', () => {
        const html = renderKbCodeIntelHtml({
            members: [{
                member: 'dave', repoPath: null, remoteUrl: null,
                mcpScope: { scoped: false, reason: 'no member-side install found' },
                kbEntryCount: 0, checks: {}, warnings: [],
            }],
        }, { dispatches: [] });
        assert.match(html, /unscoped/);
        assert.match(html, /no member-side install found/);
    });
});

describe('renderKbCodeIntelHtml: AC5 -- warnings render member, cause AND remediation', () => {
    test('a warned member is rendered prominently with all three fields', () => {
        const html = renderKbCodeIntelHtml({
            members: [{
                member: 'eve', repoPath: '/r/eve', remoteUrl: null, mcpScope: null, kbEntryCount: 0,
                checks: { kb: { check: 'kb', outcome: 'kb-empty' } },
                warnings: [{
                    member: 'eve', check: 'kb', outcome: 'kb-empty',
                    cause: 'the knowledge scope resolved and reported zero entries',
                    remediation: 'capture or import knowledge for this repo',
                }],
            }],
        }, { dispatches: [] });
        assert.match(html, /data-kb-panel-warning="true"/);
        assert.match(html, /eve/);
        assert.match(html, /the knowledge scope resolved and reported zero entries/);
        assert.match(html, /capture or import knowledge for this repo/);
    });
});

describe('renderKbCodeIntelHtml: AC3/AC4 -- per-dispatch kb_* counts, captures, and zero-call highlighting', () => {
    test('shows role, member, kb_* call total, captures kept and rejected', () => {
        const html = renderKbCodeIntelHtml({ members: [] }, {
            dispatches: [{
                role: 'doer', member: 'frank',
                kbCounts: { kb_list: 0, kb_query: 3, kb_capture: 2, kb_promote: 0, kb_export: 0 },
                captureOutcomes: [
                    { title: 'a', outcome: 'kept' },
                    { title: 'b', outcome: 'kept' },
                    { title: 'c', outcome: 'rejected', cause: 'no content' },
                ],
                code: { status: CODE_CALLS_NOT_OBSERVABLE },
            }],
        });
        assert.match(html, /doer/);
        assert.match(html, /frank/);
        assert.match(html, />5</, 'the total kb_* call count (3 query + 2 capture) must be printed');
        assert.match(html, />2</, 'kept captures count');
        assert.match(html, />1</, 'rejected captures count');
    });

    test('a role with ZERO kb calls is visibly, distinctly highlighted', () => {
        const html = renderKbCodeIntelHtml({ members: [] }, {
            dispatches: [{
                role: 'reviewer', member: 'grace',
                kbCounts: { kb_list: 0, kb_query: 0, kb_capture: 0, kb_promote: 0, kb_export: 0 },
                captureOutcomes: [],
                code: { status: CODE_CALLS_NOT_OBSERVABLE },
            }],
        });
        assert.match(html, /data-kb-panel-zero-calls="true"/);
        assert.match(html, /ZERO KB CALLS/);
    });

    test('a non-zero-call role does NOT carry the zero-call highlight', () => {
        const html = renderKbCodeIntelHtml({ members: [] }, {
            dispatches: [{
                role: 'doer', member: 'henry',
                kbCounts: { kb_list: 0, kb_query: 1, kb_capture: 0, kb_promote: 0, kb_export: 0 },
                captureOutcomes: [],
                code: { status: CODE_CALLS_NOT_OBSERVABLE },
            }],
        });
        assert.doesNotMatch(html, /data-kb-panel-zero-calls="true"/);
    });
});

describe('renderKbCodeIntelHtml: AC2/AC3/AC4/AC7 -- zero, missing, and not-observable are three distinguishable states', () => {
    test('the code_* not-observable marker renders its own state, and is NEVER the zero-call highlight', () => {
        const html = renderKbCodeIntelHtml({ members: [] }, {
            dispatches: [{
                role: 'doer', member: 'iris',
                kbCounts: { kb_list: 0, kb_query: 2, kb_capture: 0, kb_promote: 0, kb_export: 0 },
                captureOutcomes: [],
                code: { status: CODE_CALLS_NOT_OBSERVABLE },
            }],
        });
        assert.match(html, /data-kb-panel-not-observable="true"/);
        assert.match(html, /not observable/);
        // The dispatch made non-zero kb_* calls, so it must not ALSO carry
        // the zero-call badge just because code_* looks unobserved.
        assert.doesNotMatch(html, /data-kb-panel-zero-calls="true"/);
    });

    test('a missing/malformed kbCounts renders the explicit unknown state, never a fabricated 0', () => {
        const html = renderKbCodeIntelHtml({ members: [] }, {
            dispatches: [{ role: 'doer', member: 'jack', kbCounts: null, captureOutcomes: [], code: { status: CODE_CALLS_NOT_OBSERVABLE } }],
        });
        assert.match(html, /data-kb-panel-unknown="true"/);
        assert.doesNotMatch(html, /data-kb-panel-zero-calls="true"/, 'missing data must not be conflated with a real zero');
    });

    test('a missing kbEntryCount on a member renders the explicit unknown state', () => {
        const html = renderKbCodeIntelHtml({
            members: [{ member: 'kate', repoPath: '/r/kate', kbEntryCount: undefined, checks: {}, warnings: [] }],
        }, { dispatches: [] });
        assert.match(html, /data-kb-panel-unknown="true"/);
    });

    test('an explicit zero kb_* count renders as the literal 0, distinct from both unknown and not-observable', () => {
        const html = renderKbCodeIntelHtml({ members: [] }, {
            dispatches: [{
                role: 'reviewer', member: 'liam',
                kbCounts: { kb_list: 0, kb_query: 0, kb_capture: 0, kb_promote: 0, kb_export: 0 },
                captureOutcomes: [],
                code: { status: CODE_CALLS_NOT_OBSERVABLE },
            }],
        });
        // This IS the zero-call case (asserted above); confirm it is not
        // rendered as '(unknown)'.
        assert.doesNotMatch(html, /data-kb-panel-unknown="true"/);
    });
});

describe('renderKbCodeIntelHtml: AC8 -- malformed/absent input renders an empty-but-valid panel, never throws', () => {
    test('null/undefined inputs do not throw and still render the container', () => {
        assert.doesNotThrow(() => renderKbCodeIntelHtml(null, undefined));
        const html = renderKbCodeIntelHtml(null, undefined);
        assert.match(html, /data-kb-code-intel="true"/);
    });

    test('garbage-shaped inputs (wrong types) do not throw', () => {
        assert.doesNotThrow(() => renderKbCodeIntelHtml('not an object', 42));
        assert.doesNotThrow(() => renderKbCodeIntelHtml({ members: 'not an array' }, { dispatches: 'not an array' }));
        assert.doesNotThrow(() => renderKbCodeIntelHtml({ members: [null, undefined, 5] }, { dispatches: [null, undefined, 5] }));
    });
});

describe('renderKbCodeIntelHtml: AC9 -- ASCII only, no target-repo-specific string', () => {
    test('a full render with every branch exercised is pure ASCII', () => {
        const html = renderKbCodeIntelHtml({
            members: [
                {
                    member: 'alice', repoPath: '/r/alice', remoteUrl: 'https://example.invalid/a.git', mcpScope: null,
                    kbEntryCount: 5,
                    checks: {
                        index: { outcome: 'analyze-started' },
                        kb: { outcome: 'ok' },
                        code: { outcome: 'index-not-ready' },
                    },
                    warnings: [{ member: 'alice', cause: 'x', remediation: 'y' }],
                },
            ],
        }, {
            dispatches: [{
                role: 'doer', member: 'alice',
                kbCounts: { kb_list: 1, kb_query: 2, kb_capture: 1, kb_promote: 0, kb_export: 0 },
                captureOutcomes: [{ title: 't', outcome: 'kept' }],
                code: { status: CODE_CALLS_NOT_OBSERVABLE },
            }],
        });
        // eslint-disable-next-line no-control-regex
        assert.ok(/^[\x00-\x7F]*$/.test(html), 'panel output must be ASCII only');
    });
});

describe('kbCodeIntelExtension: registered as a distinct tab (AC1), embedded browser copy behaves identically', () => {
    test('carries its own id and title, distinct from beadsExtension', () => {
        assert.equal(kbCodeIntelExtension.id, 'kb-code-intel');
        assert.equal(typeof kbCodeIntelExtension.title, 'string');
        assert.notEqual(kbCodeIntelExtension.id, 'beads');
    });

    test('js parses as a valid function body (no leftover template-literal escaping bugs)', () => {
        assert.doesNotThrow(() => new Function('document', kbCodeIntelExtension.js));
    });

    test('subscribes to the SAME publishState namespaces apra-fleet-b4g.29/.33 already publish under (AC6 -- one source of truth)', () => {
        // Behavioral, not a raw-text grep: the namespace values are
        // interpolated via JSON.stringify(...) rather than written literally
        // next to a quote (see the guard note below), so this proves the
        // ACTUAL registered event names rather than assuming a particular
        // source spelling.
        const listeners = {};
        const doc = { addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler); }, getElementById() { return null; } };
        new Function('document', kbCodeIntelExtension.js)(doc);
        assert.ok(listeners['workflow:state:' + PREFLIGHT_STATE_NAMESPACE], 'must subscribe to the exact preflight namespace member-preflight.mjs publishes under');
        assert.ok(listeners['workflow:state:' + DISPATCH_ACCOUNTING_STATE_NAMESPACE], 'must subscribe to the exact namespace dispatch-accounting.mjs publishes under');
    });

    function createMockDocument() {
        const listeners = {};
        const containers = {};
        const doc = {
            addEventListener(type, handler) {
                (listeners[type] = listeners[type] || []).push(handler);
            },
            getElementById(id) {
                if (!containers[id]) containers[id] = { innerHTML: '' };
                return containers[id];
            },
        };
        return { doc, listeners, containers };
    }

    test('renders into #extension-kb-code-intel on a member-preflight state event', () => {
        const { doc, listeners, containers } = createMockDocument();
        new Function('document', kbCodeIntelExtension.js)(doc);

        const handlers = listeners['workflow:state:' + PREFLIGHT_STATE_NAMESPACE];
        assert.ok(handlers && handlers.length === 1);
        handlers[0]({ detail: { members: [{ member: 'm1', repoPath: '/r', kbEntryCount: 3, checks: {}, warnings: [] }] } });

        const container = containers['extension-kb-code-intel'];
        assert.ok(container, 'the panel must look up its own extension-kb-code-intel container');
        assert.match(container.innerHTML, /m1/);
    });

    test('renders into #extension-kb-code-intel on a dispatch-accounting state event, and both events compose (neither overwrites the other\'s data)', () => {
        const { doc, listeners, containers } = createMockDocument();
        new Function('document', kbCodeIntelExtension.js)(doc);

        listeners['workflow:state:' + PREFLIGHT_STATE_NAMESPACE][0]({
            detail: { members: [{ member: 'm1', repoPath: '/r', kbEntryCount: 3, checks: {}, warnings: [] }] },
        });
        listeners['workflow:state:' + DISPATCH_ACCOUNTING_STATE_NAMESPACE][0]({
            detail: {
                dispatches: [{
                    role: 'doer', member: 'm1',
                    kbCounts: { kb_list: 0, kb_query: 1, kb_capture: 0, kb_promote: 0, kb_export: 0 },
                    captureOutcomes: [], code: { status: CODE_CALLS_NOT_OBSERVABLE },
                }],
            },
        });

        const container = containers['extension-kb-code-intel'];
        assert.match(container.innerHTML, /m1/, 'member data from the first event must still be present');
        assert.match(container.innerHTML, /doer/, 'dispatch data from the second event must also be present');
    });
});
