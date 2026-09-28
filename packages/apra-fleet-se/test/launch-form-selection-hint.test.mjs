// apra-fleet-i9ag.18.2: regression coverage for the selection-hint fix landed
// by apra-fleet-i9ag.18.1 (parent bug apra-fleet-i9ag.18: the launch form kept
// showing "No issue selected -- click a Backlog row below" after a row was
// checked, and pointed "below" even though the Backlog panel renders ABOVE
// the Launch Sprint form in the page).
//
// There is no jsdom/browser dependency in this repo -- same technique as
// packages/apra-fleet-se/test/supervisor-dashboard-live-refresh.test.mjs and
// packages/apra-fleet-se/test/4yr-stop-modal.test.mjs: extract the ACTUAL
// client script verbatim out of renderLaunchFormHtml()'s emitted <script> tag
// and execute it against a minimal hand-rolled DOM stub, rather than
// reimplementing the selection logic here (which would drift out of sync with
// the real client code and stop catching regressions like a reintroduced
// #backlog-scoped listener or the old "below" wording).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { renderLaunchFormHtml } from '../src/supervisor/launch-form.mjs';

const NO_SELECTION_TEXT = 'No issue selected -- check a Backlog row above to select one.';

function makeClassList(initial) {
    const set = new Set(initial || []);
    return {
        add: (c) => { set.add(c); },
        remove: (c) => { set.delete(c); },
        contains: (c) => set.has(c),
        toggle: (c, force) => {
            if (force === undefined) {
                if (set.has(c)) set.delete(c); else set.add(c);
            } else if (force) {
                set.add(c);
            } else {
                set.delete(c);
            }
            return set.has(c);
        },
    };
}

/** A minimal container stub -- just enough surface for the extracted script's own getElementById() targets. */
function makeContainer(id) {
    return {
        id,
        textContent: '',
        innerHTML: '',
        style: {},
        querySelector: () => null,
        querySelectorAll: () => [],
        appendChild: () => {},
        addEventListener: () => {},
    };
}

/** A Backlog-row-style checkbox (class bead-select-checkbox), as the document-level 'change' listener would see it. */
function makeBacklogCheckbox({ beadId, checked }) {
    return {
        checked,
        classList: makeClassList(['bead-select-checkbox']),
        getAttribute: (name) => (name === 'data-bead-id' ? beadId : null),
        closest: () => null, // no enclosing <tr> in this minimal stub -- cascade-to-descendants is out of scope for this bead
    };
}

/** A member checkbox (class launch-member-checkbox) -- must NEVER be mistaken for a Backlog selection checkbox. */
function makeMemberCheckbox() {
    return {
        checked: true,
        classList: makeClassList(['launch-member-checkbox']),
        getAttribute: () => null,
    };
}

/**
 * Extracts the ACTUAL client script from renderLaunchFormHtml()'s emitted
 * HTML and executes it against a minimal hand-rolled DOM stub -- exercising
 * the exact code shipped to the browser, never a re-implementation of it.
 * Deliberately never registers a '#backlog' element anywhere in `elementsById`
 * -- the whole point of apra-fleet-i9ag.18.1/.18.2 is that selection must keep
 * updating the hint with no '#backlog' element resolvable at script-execution
 * time at all (the prior #backlog-scoped listener silently never fired in
 * that case). The document-level 'change' listener is exactly what makes that
 * work: it is registered on `document`, not on any specific container.
 */
function buildLaunchFormSandbox() {
    const html = renderLaunchFormHtml();
    const scriptStart = html.indexOf('<script>') + '<script>'.length;
    const scriptEnd = html.indexOf('</script>', scriptStart);
    assert.ok(scriptStart > -1 && scriptEnd > -1, 'renderLaunchFormHtml must emit a <script> block');
    const script = html.slice(scriptStart, scriptEnd);

    const changeHandlers = [];
    const hintEl = makeContainer('launch-selected-issues');
    const membersEl = makeContainer('launch-members');
    const resultEl = makeContainer('launch-result');
    const formEl = { addEventListener: () => {} }; // submit is out of scope for this bead

    const elementsById = {
        'launch-selected-issues': hintEl,
        'launch-members': membersEl,
        'launch-result': resultEl,
        'launch-sprint-form': formEl,
    };

    const mockDocument = {
        getElementById: (id) => elementsById[id] || null,
        addEventListener: (type, handler) => { if (type === 'change') changeHandlers.push(handler); },
        querySelectorAll: () => [],
    };

    // GET /api/members fires unconditionally on script init (membersEl
    // resolves above) -- an inert stub response is enough; member loading
    // itself is out of scope for this bead.
    const fetchStub = async () => ({ json: async () => ({ members: [] }) });

    const mockWindow = {};

    // eslint-disable-next-line no-new-func
    const fn = new Function('document', 'fetch', 'window', script);
    fn(mockDocument, fetchStub, mockWindow);

    return {
        hintEl,
        window: mockWindow,
        fireChange(target) {
            for (const h of changeHandlers) h({ target });
        },
    };
}

describe('apra-fleet-i9ag.18.2: launch form selection-hint binding (regression coverage in its own file)', () => {
    test('checking one row: hint reads "Selected issue(s): <id>"; checking a second lists both; unchecking both restores the no-selection text', () => {
        const sandbox = buildLaunchFormSandbox();
        assert.equal(sandbox.hintEl.textContent, NO_SELECTION_TEXT);

        const first = makeBacklogCheckbox({ beadId: 'apra-fleet-hint.1', checked: true });
        sandbox.fireChange(first);
        assert.equal(sandbox.hintEl.textContent, 'Selected issue(s): apra-fleet-hint.1');

        const second = makeBacklogCheckbox({ beadId: 'apra-fleet-hint.2', checked: true });
        sandbox.fireChange(second);
        assert.equal(sandbox.hintEl.textContent, 'Selected issue(s): apra-fleet-hint.1, apra-fleet-hint.2');

        first.checked = false;
        sandbox.fireChange(first);
        assert.equal(sandbox.hintEl.textContent, 'Selected issue(s): apra-fleet-hint.2');

        second.checked = false;
        sandbox.fireChange(second);
        assert.equal(sandbox.hintEl.textContent, NO_SELECTION_TEXT);
    });

    test('regression: the change event is delivered at DOCUMENT level with NO #backlog element present in the stub at all -- selection still updates the hint', () => {
        // buildLaunchFormSandbox()'s elementsById above never registers a
        // 'backlog' entry -- this is the exact regression case: the OLD
        // implementation scoped its listener to '#backlog' and silently never
        // fired when that element was not resolvable at script-execution
        // time. The document-level listener the current script uses has no
        // such dependency, so this must work unconditionally.
        const sandbox = buildLaunchFormSandbox();
        const checkbox = makeBacklogCheckbox({ beadId: 'apra-fleet-hint.3', checked: true });
        sandbox.fireChange(checkbox);
        assert.equal(sandbox.hintEl.textContent, 'Selected issue(s): apra-fleet-hint.3');
    });

    test('a member checkbox change (class launch-member-checkbox) does not alter the hint', () => {
        const sandbox = buildLaunchFormSandbox();
        const memberCheckbox = makeMemberCheckbox();
        sandbox.fireChange(memberCheckbox);
        assert.equal(sandbox.hintEl.textContent, NO_SELECTION_TEXT);

        // Also confirm a member-checkbox change never clobbers an ALREADY
        // active selection -- not just the no-selection default.
        const backlogCheckbox = makeBacklogCheckbox({ beadId: 'apra-fleet-hint.4', checked: true });
        sandbox.fireChange(backlogCheckbox);
        assert.equal(sandbox.hintEl.textContent, 'Selected issue(s): apra-fleet-hint.4');
        sandbox.fireChange(makeMemberCheckbox());
        assert.equal(sandbox.hintEl.textContent, 'Selected issue(s): apra-fleet-hint.4');
    });

    test('window.__fleetSeLaunch.isSelected() reflects the current selection after the script has processed the events', () => {
        const sandbox = buildLaunchFormSandbox();
        assert.equal(typeof sandbox.window.__fleetSeLaunch?.isSelected, 'function', 'the script must install window.__fleetSeLaunch.isSelected -- backlog.mjs depends on this hook');
        assert.equal(sandbox.window.__fleetSeLaunch.isSelected('apra-fleet-hint.5'), false);

        const checkbox = makeBacklogCheckbox({ beadId: 'apra-fleet-hint.5', checked: true });
        sandbox.fireChange(checkbox);
        assert.equal(sandbox.window.__fleetSeLaunch.isSelected('apra-fleet-hint.5'), true);
        assert.equal(sandbox.window.__fleetSeLaunch.isSelected('apra-fleet-hint.other'), false, 'isSelected must not report true for an id that was never checked');

        checkbox.checked = false;
        sandbox.fireChange(checkbox);
        assert.equal(sandbox.window.__fleetSeLaunch.isSelected('apra-fleet-hint.5'), false);
    });

    test('static-string assertions on renderLaunchFormHtml() output: "below" appears nowhere in the operator-facing text; the intro paragraph and the initial hint both say "above"', () => {
        // Scoped to the intro <p> and the dynamic hint text -- the user-facing
        // copy this bead is actually about -- not the whole raw HTML blob:
        // the embedded <script> block legitimately contains SOURCE-CODE
        // comments using "below" for code-navigation ("see X below", a
        // pre-existing, unrelated convention throughout this module), which
        // is never rendered as visible text and is not the regression this
        // bead guards against.
        const html = renderLaunchFormHtml();
        const introMatch = html.match(/<p[^>]*>([^<]*)<\/p>/);
        assert.ok(introMatch, 'the intro paragraph must exist');
        assert.ok(!/below/i.test(introMatch[1]), 'the intro paragraph must not say "below"');
        assert.ok(/above/i.test(introMatch[1]), 'the intro paragraph must say "above"');

        // The initial (no-selection) hint text is a static string emitted by
        // the SAME renderSelectedIssues() the extracted script runs at init --
        // assert it directly against the rendered sandbox too, not just the
        // static module-level constant this file declares.
        assert.ok(NO_SELECTION_TEXT.includes('above'), 'the no-selection hint text constant this test asserts against must itself say "above"');
        const sandbox = buildLaunchFormSandbox();
        assert.equal(sandbox.hintEl.textContent, NO_SELECTION_TEXT);
        assert.ok(!/below/i.test(sandbox.hintEl.textContent));
        assert.ok(/above/i.test(sandbox.hintEl.textContent));
    });
});
