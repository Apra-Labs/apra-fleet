import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
    GOAL_OPTIONS,
    FORM_ROLE_OPTIONS,
    buildLaunchRequestBody,
    formatLaunchError,
    classifyLaunchWatch,
    renderLaunchFormHtml,
} from '../src/supervisor/launch-form.mjs';
import { renderIndexPageHtml } from '../src/supervisor/dashboard.mjs';
import { sanitizeMountPrefix } from '../src/supervisor/mount-prefix.mjs';

// apra-fleet-eft.6.3 -- Launch Sprint form: issue multi-select (click-to-toggle
// on the Backlog tree), member/role assignment, a goal selector offering
// exactly P1/P1-P2/P1-P2-P3 (slash-joined, see GOAL_OPTIONS), and branch/
// base-branch inputs. Submitting builds
// a POST /api/sprints body the server (eft.4.4, src/supervisor/api.mjs)
// accepts; 409 member-overlap conflicts and 400 field errors are surfaced
// legibly, never as a generic error.

describe('launch-form -- GOAL_OPTIONS', () => {
    // Slash-separated, not '+'-joined -- must match runner.js's GOAL_PATTERN
    // (/^P[1-3](\/P[1-3]){0,2}$/, fleet-sprint/runner.js:249), which api.mjs
    // forwards this value into verbatim with no reformatting. A '+'-joined
    // value here fails the launched child's own Arg Contract check.
    test('offers exactly P1, P1/P2, P1/P2/P3', () => {
        assert.deepEqual(GOAL_OPTIONS, ['P1', 'P1/P2', 'P1/P2/P3']);
    });

    test('every option matches runner.js\'s GOAL_PATTERN', () => {
        const GOAL_PATTERN = /^P[1-3](\/P[1-3]){0,2}$/;
        for (const g of GOAL_OPTIONS) {
            assert.ok(GOAL_PATTERN.test(g), `${g} must match GOAL_PATTERN`);
        }
    });
});

describe('launch-form -- FORM_ROLE_OPTIONS', () => {
    test('includes the canonical sprint roles plus the backlog pseudo-role (not the deprecated orchestrator alias)', () => {
        assert.ok(FORM_ROLE_OPTIONS.includes('doer'));
        assert.ok(FORM_ROLE_OPTIONS.includes('planner'));
        assert.ok(FORM_ROLE_OPTIONS.includes('backlog'));
        assert.ok(!FORM_ROLE_OPTIONS.includes('orchestrator'));
    });
});

describe('launch-form -- buildLaunchRequestBody', () => {
    const base = {
        selectedRoots: ['apra-fleet-eft.9'],
        members: ['alice', 'bob'],
        roleMap: { doer: ['alice'] },
        goal: 'P1/P2',
        branch: 'feat/x',
        base: 'main',
    };

    test('valid input produces a body the server accepts (issue/members/branch/base/goal/roleMap)', () => {
        const result = buildLaunchRequestBody(base);
        assert.equal(result.ok, true);
        assert.deepEqual(result.body, {
            issue: 'apra-fleet-eft.9',
            members: ['alice', 'bob'],
            branch: 'feat/x',
            base: 'main',
            goal: 'P1/P2',
            roleMap: { doer: ['alice'] },
        });
    });

    test('omits roleMap when empty/absent', () => {
        const result = buildLaunchRequestBody({ ...base, roleMap: {} });
        assert.equal(result.ok, true);
        assert.ok(!('roleMap' in result.body));
    });

    test('zero selected issues -> client-side error, not a server round-trip', () => {
        const result = buildLaunchRequestBody({ ...base, selectedRoots: [] });
        assert.equal(result.ok, false);
        assert.ok(/select an issue/i.test(result.error));
    });

    test('more than one selected issue -> client-side error naming the single-root constraint', () => {
        const result = buildLaunchRequestBody({ ...base, selectedRoots: ['a', 'b'] });
        assert.equal(result.ok, false);
        assert.ok(/exactly one issue/i.test(result.error));
    });

    test('no members selected -> client-side error', () => {
        const result = buildLaunchRequestBody({ ...base, members: [] });
        assert.equal(result.ok, false);
        assert.ok(/member/i.test(result.error));
    });

    test('goal outside the exact three options -> client-side error', () => {
        const result = buildLaunchRequestBody({ ...base, goal: 'P4' });
        assert.equal(result.ok, false);
        assert.ok(result.error.includes('P1, P1/P2, P1/P2/P3'));
    });

    test('missing base -> client-side error', () => {
        assert.equal(buildLaunchRequestBody({ ...base, base: '  ' }).ok, false);
    });

    test('blank branch with >=1 member auto-generates a fleet-sprint/<member>-<xxx> branch name', () => {
        const result = buildLaunchRequestBody({ ...base, branch: '' });
        assert.equal(result.ok, true);
        assert.ok(/^fleet-sprint\/[a-z0-9-]+-[a-z0-9]{3}$/.test(result.body.branch), result.body.branch);
        assert.ok(result.body.branch.startsWith('fleet-sprint/alice-'), result.body.branch);
    });

    test('blank/whitespace-only branch also auto-generates', () => {
        const result = buildLaunchRequestBody({ ...base, branch: '   ' });
        assert.equal(result.ok, true);
        assert.ok(/^fleet-sprint\/[a-z0-9-]+-[a-z0-9]{3}$/.test(result.body.branch), result.body.branch);
    });

    test('an explicitly typed branch name is honored verbatim, byte-identical', () => {
        const result = buildLaunchRequestBody({ ...base, branch: 'feat/my-topic' });
        assert.equal(result.ok, true);
        assert.equal(result.body.branch, 'feat/my-topic');
    });

    test('blank branch with zero members still errors', () => {
        const result = buildLaunchRequestBody({ ...base, branch: '', members: [] });
        assert.equal(result.ok, false);
        assert.ok(/member/i.test(result.error));
    });

    // apra-fleet-ky2l.3.1 (DQ-11): sync is emitted only when the checkbox is
    // checked (opts.sync === true) -- absent/false stays absent, matching the
    // server's (api.mjs validateLaunchRequest) treatment of an absent field
    // as "no --sync forwarded".
    test('sync is emitted only when the checkbox is checked', () => {
        const checked = buildLaunchRequestBody({ ...base, sync: true });
        assert.equal(checked.ok, true);
        assert.equal(checked.body.sync, true);
    });

    test('sync is omitted (not false) when the checkbox is unchecked or absent', () => {
        const unchecked = buildLaunchRequestBody({ ...base, sync: false });
        assert.equal(unchecked.ok, true);
        assert.ok(!('sync' in unchecked.body));

        const absent = buildLaunchRequestBody(base);
        assert.equal(absent.ok, true);
        assert.ok(!('sync' in absent.body));
    });
});

describe('launch-form -- formatLaunchError', () => {
    test('409 member-overlap conflict is passed through verbatim -- names the sprint and overlapping members', () => {
        const msg = formatLaunchError(409, {
            error: "member overlap rejects launch: sprint 's-active' already claims [alice, bob]",
            field: 'members',
        });
        assert.ok(msg.includes('s-active'));
        assert.ok(msg.includes('alice'));
        assert.ok(msg.includes('bob'));
        assert.ok(!/^(error|failed)$/i.test(msg.trim()), 'must not degrade to a generic error string');
    });

    test('400 field error names the field and shows the server message verbatim', () => {
        const msg = formatLaunchError(400, {
            error: '[Arg Contract] Invalid branch "bad branch~name": must match /^[A-Za-z0-9._/-]+$/',
            field: 'branch',
        });
        assert.ok(msg.startsWith('Invalid branch:'));
        assert.ok(msg.includes('[Arg Contract] Invalid branch "bad branch~name"'));
    });

    test('missing/malformed error body still renders a message, never throws', () => {
        assert.doesNotThrow(() => formatLaunchError(500, null));
        assert.doesNotThrow(() => formatLaunchError(500, undefined));
        assert.ok(formatLaunchError(500, {}).length > 0);
    });
});

describe('launch-form -- renderLaunchFormHtml', () => {
    test('renders a goal <select> with exactly the three GOAL_OPTIONS', () => {
        const html = renderLaunchFormHtml();
        for (const g of GOAL_OPTIONS) {
            assert.ok(html.includes('<option value="' + g + '">' + g + '</option>'), `missing goal option: ${g}`);
        }
        const optionCount = (html.match(/<option value="P/g) || []).length;
        assert.equal(optionCount, GOAL_OPTIONS.length);
    });

    test('renders branch and base-branch inputs, a submit form, and a result area', () => {
        const html = renderLaunchFormHtml();
        assert.ok(html.includes('id="launch-branch"'));
        assert.ok(html.includes('id="launch-base"'));
        assert.ok(html.includes('id="launch-sprint-form"'));
        assert.ok(html.includes('id="launch-result"'));
        assert.ok(html.includes('id="launch-members"'));
        assert.ok(html.includes('id="launch-selected-issues"'));
    });

    test('embeds a client-side handler that reads Backlog rows and posts to /api/sprints', () => {
        const html = renderLaunchFormHtml();
        assert.ok(html.includes('<script>'));
        assert.ok(html.includes("data-bead-id"));
        assert.ok(html.includes("fetch('/api/sprints'"));
        assert.ok(html.includes("fetch('/api/members')"));
        assert.ok(html.includes('buildLaunchRequestBody'));
        assert.ok(html.includes('formatLaunchError'));
    });

    test('never throws', () => {
        assert.doesNotThrow(() => renderLaunchFormHtml());
    });

    // apra-fleet-ky2l.3.1 (DQ-11): the form gains a Synced topology (--sync)
    // checkbox alongside the existing override-relaunch-gate checkbox.
    test('renders a checkbox input for sync', () => {
        const html = renderLaunchFormHtml();
        assert.ok(html.includes('id="launch-sync"'));
        assert.ok(/<input id="launch-sync" type="checkbox"/.test(html));
    });
});

describe('launch-form -- attaches to the index page in the Backlog tab', () => {
    // supervisor-viewer-parity (quick-tasks follow-up): Launch Sprint now
    // shares the Backlog tab (launching starts from picking rows out of the
    // Backlog), rendered after the backlog table -- not after the sprint
    // stack/Sprints tab anymore. `id="sprint-stack"` still precedes
    // `id="backlog"` in raw document order regardless (see
    // supervisor-backlog.test.mjs), which is the ordering that still matters.
    test('renderIndexPageHtml places the Launch Sprint form after the Backlog section, in the Backlog tab', () => {
        const html = renderIndexPageHtml([], '<p>no backlog</p>');
        const backlogIdx = html.indexOf('id="backlog"');
        const launchIdx = html.indexOf('id="launch-form"');
        assert.ok(backlogIdx !== -1 && launchIdx !== -1);
        assert.ok(launchIdx > backlogIdx, 'Launch Sprint form must come after the Backlog section');
        assert.ok(html.includes('id="launch-sprint-form"'));
    });

    test('an explicit launchFormHtml override is honored verbatim', () => {
        const html = renderIndexPageHtml([], '<p>no backlog</p>', '<p data-marker="custom-launch-form"/>');
        assert.ok(html.includes('data-marker="custom-launch-form"'));
    });
});

// apra-fleet-i9ag.3.2: the form's two fetch targets must survive being served
// under the console's /ext/<id> mount. Inside that iframe a root-relative
// '/api/members' resolves against the CONSOLE origin -- the member checklist
// never loads and a submit 404s -- so a launch from the embedded form is
// impossible until both targets carry the mount prefix dashboard.mjs threads in.
describe('launch-form -- mount-aware fetch targets (apra-fleet-i9ag.3.2)', () => {
    test('no prefix: both targets are byte-identical to what they always were', () => {
        const direct = renderLaunchFormHtml();
        assert.ok(direct.includes("fetch('/api/members')"));
        assert.ok(direct.includes("fetch('/api/sprints'"));
        // Omitted, '' and a non-string are all the one serve-direct behaviour.
        assert.strictEqual(renderLaunchFormHtml(''), direct);
        assert.strictEqual(renderLaunchFormHtml(null), direct);
        assert.strictEqual(renderLaunchFormHtml(undefined), direct);
        assert.ok(!direct.includes('undefined/'), 'a missing prefix must never leak into a fetch target');
    });

    test('with a prefix: both targets are prefixed exactly once and none stays rooted at /', () => {
        const html = renderLaunchFormHtml('/ext/se');
        assert.ok(html.includes("fetch('/ext/se/api/members')"), html);
        assert.ok(html.includes("fetch('/ext/se/api/sprints'"), html);
        assert.ok(!html.includes("fetch('/api/"), 'no fetch target may stay rooted at the console root');
        assert.ok(!html.includes('/ext/se/ext/se'), 'the prefix must be applied exactly once');
    });

    test('the index page threads its own resolved prefix into the form it renders', () => {
        // The form is rendered BY renderIndexPageHtml() (no caller passes a
        // launchFormHtml override in production), so this is the path that
        // actually matters for the embedded console page.
        const html = renderIndexPageHtml([], '<p>no backlog</p>', undefined, { mountPrefix: '/ext/se' });
        assert.ok(html.includes("fetch('/ext/se/api/members')"), 'form members fetch must be mounted');
        assert.ok(html.includes("fetch('/ext/se/api/sprints'"), 'form submit fetch must be mounted');
    });

    test('a hostile prefix never reaches the page -- it is rejected before rendering', () => {
        // renderLaunchFormHtml() interpolates its prefix into a single-quoted JS
        // literal, which is only safe because mount-prefix.mjs fails a value
        // like this closed to '' (resolveMountPrefix(), called in
        // registerDashboardRoutes()). Asserting the rejection HERE too documents
        // that this module's safety depends on that validation and nothing else.
        const hostile = "/ext/se'+alert(1)+'";
        assert.strictEqual(sanitizeMountPrefix(hostile), '');
        const html = renderIndexPageHtml([], '<p>no backlog</p>', undefined, { mountPrefix: sanitizeMountPrefix(hostile) });
        assert.ok(!html.includes('alert(1)'), html.slice(0, 200));
        assert.ok(html.includes("fetch('/api/members')"), 'a rejected prefix falls back to serve-direct paths');
    });
});

// =============================================================================
// apra-fleet-i9ag.18.1: the selection-hint (#launch-selected-issues) must
// track selection state and never silently stop updating. There is no jsdom/
// browser dependency in this repo -- same technique as 4yr-stop-modal.test.mjs
// and supervisor-dashboard-live-refresh.test.mjs: extract the ACTUAL client
// script verbatim out of renderLaunchFormHtml()'s emitted <script> tag and
// execute it against a minimal hand-rolled DOM stub, rather than
// reimplementing the selection logic here (which would drift out of sync with
// the real client code and stop catching regressions like a reintroduced
// #backlog-scoped listener or the old "below" wording).
// =============================================================================

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

function makeLaunchFormContainer(id) {
    return {
        id,
        textContent: '',
        innerHTML: '',
        style: {},
        querySelector: () => null,
        querySelectorAll: () => [],
        appendChild: () => {},
    };
}

/** A Backlog-row-style checkbox (class bead-select-checkbox) plus its <tr>. */
function makeCheckboxRow({ beadId, depthPx = 8, checked = false }) {
    const checkbox = {
        checked,
        classList: makeClassList(['bead-select-checkbox']),
        getAttribute: (name) => (name === 'data-bead-id' ? beadId : null),
    };
    const row = {
        nextElementSibling: null,
        matches: (sel) => sel === 'tr[data-bead-id]',
        classList: makeClassList(),
        querySelector: (sel) => {
            if (sel === 'td') return { style: { paddingLeft: `${depthPx}px` } };
            if (sel === '.bead-select-checkbox') return checkbox;
            return null;
        },
    };
    checkbox.closest = (sel) => (sel === 'tr[data-bead-id]' ? row : null);
    return { checkbox, row };
}

/**
 * Extracts the ACTUAL client script from renderLaunchFormHtml()'s emitted
 * HTML and executes it against a minimal hand-rolled DOM stub -- exercising
 * the exact code shipped to the browser, never a re-implementation of it.
 * Deliberately never registers a '#backlog' element anywhere: the whole point
 * of apra-fleet-i9ag.18.1 is that selection must keep updating the hint with
 * no #backlog element resolvable at script-execution time at all (the prior
 * #backlog-scoped listener silently never fired in that case).
 */
function buildLaunchFormSandbox({ includeHintEl = true, includeForm = false, memberCheckboxes = [], documentRows = [] } = {}) {
    const html = renderLaunchFormHtml();
    const scriptStart = html.indexOf('<script>') + '<script>'.length;
    const scriptEnd = html.indexOf('</script>', scriptStart);
    assert.ok(scriptStart > -1 && scriptEnd > -1, 'renderLaunchFormHtml must emit a <script> block');
    const script = html.slice(scriptStart, scriptEnd);

    const changeHandlers = [];
    const membersContainer = makeLaunchFormContainer('launch-members');
    membersContainer.querySelectorAll = (sel) => (sel === '.launch-member-checkbox' ? memberCheckboxes : []);

    const elementsById = {
        'launch-members': membersContainer,
        'launch-result': makeLaunchFormContainer('launch-result'),
    };
    if (includeHintEl) {
        elementsById['launch-selected-issues'] = makeLaunchFormContainer('launch-selected-issues');
    }

    let submitHandler = null;
    if (includeForm) {
        elementsById['launch-sprint-form'] = {
            addEventListener: (type, handler) => { if (type === 'submit') submitHandler = handler; },
        };
        elementsById['launch-goal'] = { value: 'P1' };
        elementsById['launch-branch'] = { value: 'feat/x' };
        elementsById['launch-base'] = { value: 'main' };
    }

    const fetchCalls = [];
    const fetchStub = async (url) => {
        fetchCalls.push({ url });
        if (url === '/api/sprints') {
            return { status: 201, json: async () => ({ sprintId: 's-1' }) };
        }
        return { json: async () => ({ members: [] }) };
    };

    // apra-fleet-i9ag.18: the post-launch reset (clearSelection()) queries
    // the DOCUMENT -- not '#backlog' -- for '.bead-select-checkbox' and
    // 'tr.bead-row-selected'. `documentRows` (makeCheckboxRow() results)
    // registers rows this stub answers those two selectors from, so the
    // reset's REAL effect on the DOM is observable. Deliberately still no
    // '#backlog' element anywhere: a reset scoped to it (the prior shape)
    // must not be able to pass this file.
    const mockDocument = {
        getElementById: (id) => elementsById[id] || null,
        addEventListener: (type, handler) => { if (type === 'change') changeHandlers.push(handler); },
        querySelectorAll: (sel) => {
            if (sel === '.bead-select-checkbox') return documentRows.map((r) => r.checkbox);
            if (sel === 'tr.bead-row-selected') return documentRows.map((r) => r.row).filter((tr) => tr.classList.contains('bead-row-selected'));
            return [];
        },
    };

    // eslint-disable-next-line no-new-func
    const fn = new Function('document', 'fetch', 'window', script);
    fn(mockDocument, fetchStub, {});

    return {
        hintEl: elementsById['launch-selected-issues'] || null,
        fetchCalls,
        fireChange(target) {
            for (const h of changeHandlers) h({ target });
        },
        submit() {
            assert.ok(submitHandler, 'submit handler must be wired when the form element is present');
            submitHandler({ preventDefault() {} });
        },
    };
}

describe('launch-form -- client-side selection-hint binding (apra-fleet-i9ag.18.1)', () => {
    test('a bead-select-checkbox change delivered at DOCUMENT level updates the hint; unchecking restores the no-selection text', () => {
        const sandbox = buildLaunchFormSandbox();
        assert.equal(sandbox.hintEl.textContent, 'No issue selected -- check a Backlog row above to select one.');

        const { checkbox } = makeCheckboxRow({ beadId: 'apra-fleet-x.1', checked: true });
        sandbox.fireChange(checkbox);
        assert.equal(sandbox.hintEl.textContent, 'Selected issue(s): apra-fleet-x.1');

        checkbox.checked = false;
        sandbox.fireChange(checkbox);
        assert.equal(sandbox.hintEl.textContent, 'No issue selected -- check a Backlog row above to select one.');
    });

    test('with no #backlog element present in the stub at all, selection still updates the hint (regression: the old #backlog-scoped listener never fired)', () => {
        // No entry named 'backlog' is ever added to elementsById in
        // buildLaunchFormSandbox() -- this is the exact regression case.
        const sandbox = buildLaunchFormSandbox();
        const { checkbox } = makeCheckboxRow({ beadId: 'apra-fleet-y.1', checked: true });
        sandbox.fireChange(checkbox);
        assert.equal(sandbox.hintEl.textContent, 'Selected issue(s): apra-fleet-y.1');
    });

    test('a launch-member-checkbox change (not bead-select-checkbox) does not alter the hint', () => {
        const sandbox = buildLaunchFormSandbox();
        const memberCheckbox = {
            checked: true,
            classList: makeClassList(['launch-member-checkbox']),
            getAttribute: () => null,
        };
        sandbox.fireChange(memberCheckbox);
        assert.equal(sandbox.hintEl.textContent, 'No issue selected -- check a Backlog row above to select one.');
    });

    test('neither the static intro paragraph nor the dynamic hint text says "below"; both say "above"', () => {
        const html = renderLaunchFormHtml();
        const introMatch = html.match(/<p[^>]*>([^<]*)<\/p>/);
        assert.ok(introMatch, 'intro paragraph must exist');
        assert.ok(!/below/i.test(introMatch[1]), 'intro paragraph must not say "below"');
        assert.ok(/above/i.test(introMatch[1]), 'intro paragraph must say "above"');

        const sandbox = buildLaunchFormSandbox();
        assert.ok(!/below/i.test(sandbox.hintEl.textContent));
        assert.ok(/above/i.test(sandbox.hintEl.textContent));

        const { checkbox } = makeCheckboxRow({ beadId: 'apra-fleet-z.1', checked: true });
        sandbox.fireChange(checkbox);
        assert.ok(!/below/i.test(sandbox.hintEl.textContent));
    });

    test('a missing #launch-selected-issues element logs a console.error at script init, not a silent no-op', () => {
        const originalError = console.error;
        const calls = [];
        console.error = (...args) => { calls.push(args.join(' ')); };
        try {
            buildLaunchFormSandbox({ includeHintEl: false });
        } finally {
            console.error = originalError;
        }
        assert.ok(calls.length >= 1, 'expected at least one console.error call when the hint element is missing');
        assert.ok(calls.some((c) => /launch-selected-issues/.test(c)), 'console.error must name the missing element id');
    });

    test('descendant-row cascade selection updates the hint for every cascaded row', () => {
        const sandbox = buildLaunchFormSandbox();
        const { checkbox: parentCb, row: parentRow } = makeCheckboxRow({ beadId: 'parent-1', depthPx: 8, checked: true });
        const { checkbox: childCb, row: childRow } = makeCheckboxRow({ beadId: 'child-1', depthPx: 28, checked: false });
        parentRow.nextElementSibling = childRow;

        sandbox.fireChange(parentCb);

        assert.equal(childCb.checked, true, 'cascade must check the descendant checkbox');
        assert.ok(sandbox.hintEl.textContent.includes('parent-1'));
        assert.ok(sandbox.hintEl.textContent.includes('child-1'), 'the cascaded child selection must also be reflected in the hint');
    });

    test('the post-launch reset (after a successful submit) clears the hint back to the no-selection text', async (t) => {
        // apra-fleet-i9ag.16.4: a successful submit now also starts the
        // post-launch watch (watchLaunch()), which schedules a REAL
        // setInterval unless timers are mocked here -- mirrors every
        // sprintStackLiveScript() test in supervisor-dashboard-live-refresh
        // .test.mjs, which mocks timers for the exact same reason (never
        // leak a live background interval past the end of a test).
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            const memberCheckbox = { checked: true, value: 'alice' };
            const sandbox = buildLaunchFormSandbox({ includeForm: true, memberCheckboxes: [memberCheckbox] });

            const { checkbox } = makeCheckboxRow({ beadId: 'apra-fleet-reset.1', checked: true });
            sandbox.fireChange(checkbox);
            assert.equal(sandbox.hintEl.textContent, 'Selected issue(s): apra-fleet-reset.1');

            sandbox.submit();
            // Flush the fetch(...).then().then() microtask chain the submit
            // handler kicks off (never a raw sleep -- just enough ticks for
            // promises already scheduled to settle).
            for (let i = 0; i < 10; i += 1) {
                // eslint-disable-next-line no-await-in-loop
                await Promise.resolve();
            }

            assert.ok(sandbox.fetchCalls.some((c) => c.url === '/api/sprints'), 'submit must POST /api/sprints');
            assert.equal(sandbox.hintEl.textContent, 'No issue selected -- check a Backlog row above to select one.');
        } finally {
            t.mock.timers.reset();
        }
    });

    // apra-fleet-i9ag.18: the reset above cleared only selectedRoots, and
    // dropped the row highlight through a '#backlog'-scoped query. Every
    // .bead-select-checkbox stayed CHECKED, so the page showed checked rows
    // under a "No issue selected" hint -- and re-clicking such a row did
    // nothing at all, because the checkbox was already checked and no
    // 'change' event ever fired. The reset is now document-level and
    // unchecks the checkboxes too.
    test('the post-launch reset also unchecks every .bead-select-checkbox and drops bead-row-selected, document-wide, so a row can be re-selected immediately', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            // The form launches exactly one root, so only `selected` is
            // checked through the listener. `stale` is a second row left
            // CHECKED in the DOM without going through this script -- what
            // backlog.mjs's own re-render does when it restores a row's
            // checked state from window.__fleetSeLaunch.isSelected(). The
            // reset must clear it too: "every checked .bead-select-checkbox",
            // not just the ones this closure knows about.
            const selected = makeCheckboxRow({ beadId: 'apra-fleet-reset.2', checked: true });
            const stale = makeCheckboxRow({ beadId: 'apra-fleet-reset.3', checked: true });
            stale.row.classList.add('bead-row-selected');
            const sandbox = buildLaunchFormSandbox({
                includeForm: true,
                memberCheckboxes: [{ checked: true, value: 'alice' }],
                documentRows: [selected, stale],
            });

            sandbox.fireChange(selected.checkbox);
            assert.equal(sandbox.hintEl.textContent, 'Selected issue(s): apra-fleet-reset.2');
            assert.ok(selected.row.classList.contains('bead-row-selected'));

            sandbox.submit();
            for (let i = 0; i < 10; i += 1) {
                // eslint-disable-next-line no-await-in-loop
                await Promise.resolve();
            }

            assert.ok(sandbox.fetchCalls.some((c) => c.url === '/api/sprints'), 'submit must POST /api/sprints');
            assert.equal(selected.checkbox.checked, false, 'the reset must UNCHECK the row checkbox, not just clear the hint');
            assert.equal(stale.checkbox.checked, false, 'EVERY checked .bead-select-checkbox must be unchecked, not only the one this script selected');
            assert.equal(selected.row.classList.contains('bead-row-selected'), false, 'the row highlight must be dropped with no #backlog element present at all');
            assert.equal(stale.row.classList.contains('bead-row-selected'), false);
            assert.equal(sandbox.hintEl.textContent, 'No issue selected -- check a Backlog row above to select one.');

            // The point of unchecking: the row is genuinely re-selectable. A
            // real browser only fires 'change' on a state transition, so a
            // still-checked checkbox could never be re-selected at all.
            selected.checkbox.checked = true;
            sandbox.fireChange(selected.checkbox);
            assert.equal(sandbox.hintEl.textContent, 'Selected issue(s): apra-fleet-reset.2');
            assert.ok(selected.row.classList.contains('bead-row-selected'));
        } finally {
            t.mock.timers.reset();
        }
    });
});

// =============================================================================
// apra-fleet-i9ag.16.4: after a 201, the form watches the newly launched
// sprint's GET /api/sprints/:id for its first seconds instead of trusting the
// green "Launched sprint <id>." line forever. classifyLaunchWatch() (the
// pure failed/live/unknown decision, no DOM) is unit-tested directly below;
// the scheduling/DOM-update loop around it (watchLaunch(), embedded in
// clientScriptSource() via .toString()) is exercised by driving the REAL
// extracted client script with a fake fetch and node:test's virtual clock --
// the same technique supervisor-dashboard-live-refresh.test.mjs uses for
// sprintStackLiveScript().
// =============================================================================

describe('launch-form -- classifyLaunchWatch (apra-fleet-i9ag.16.4, pure, no DOM)', () => {
    test('a launch-failed latest event classifies failed, with its reason', () => {
        const result = classifyLaunchWatch({
            sprintId: 's-1', live: false, history: [],
            latest: { event: 'launch-failed', reason: 'spawn ENOENT' },
        });
        assert.deepEqual(result, { status: 'failed', reason: 'spawn ENOENT' });
    });

    test('a launch-failed latest event with no reason still classifies failed, with a fallback reason', () => {
        const result = classifyLaunchWatch({ sprintId: 's-1', live: false, latest: { event: 'launch-failed' } });
        assert.equal(result.status, 'failed');
        assert.ok(result.reason.length > 0);
    });

    test('a child-exited history event with a non-zero exit code classifies failed', () => {
        const result = classifyLaunchWatch({
            sprintId: 's-1', live: false, latest: { event: 'child-exited' },
            history: [{ event: 'child-exited', exitCode: 1, signal: null }],
        });
        assert.equal(result.status, 'failed');
        assert.ok(/1/.test(result.reason), result.reason);
    });

    test('a child-exited history event with a signal (no exit code) classifies failed', () => {
        const result = classifyLaunchWatch({
            sprintId: 's-1', live: false, latest: { event: 'child-exited' },
            history: [{ event: 'child-exited', exitCode: null, signal: 'SIGKILL' }],
        });
        assert.equal(result.status, 'failed');
        assert.ok(/SIGKILL/.test(result.reason), result.reason);
    });

    test('a child-exited history event with exitCode 0 and no signal (clean exit) is never classified failed', () => {
        const result = classifyLaunchWatch({
            sprintId: 's-1', live: false, latest: { event: 'child-exited' },
            history: [{ event: 'child-exited', exitCode: 0, signal: null }],
        });
        assert.notEqual(result.status, 'failed');
    });

    test('live with no terminal event classifies live', () => {
        assert.deepEqual(classifyLaunchWatch({ sprintId: 's-1', live: true, state: {} }), { status: 'live' });
    });

    test('a 404 / empty / garbage body classifies unknown -- never a failure', () => {
        assert.equal(classifyLaunchWatch(null).status, 'unknown');
        assert.equal(classifyLaunchWatch(undefined).status, 'unknown');
        assert.equal(classifyLaunchWatch({}).status, 'unknown');
        assert.equal(classifyLaunchWatch('not an object').status, 'unknown');
        assert.equal(classifyLaunchWatch({ sprintId: 's-1', live: false, history: [] }).status, 'unknown');
    });
});

/**
 * Drives the REAL extracted launch-form client script (the same
 * clientScriptSource() the page ships, sliced out of renderLaunchFormHtml()'s
 * emitted HTML) through a submit -> 201 -> watchLaunch() sequence, against a
 * configurable fetch stub and a hand-rolled DOM stub with a real-enough
 * createElement() to inspect the raw-log anchor watchLaunch() appends on
 * failure. `pollResponder(url)` answers every GET poll to
 * /api/sprints/<id>; the launch POST itself always succeeds with `sprintId`
 * (or `launchSprintId(callIndex)` when a test needs a DIFFERENT id per
 * submit, e.g. the "second submit cancels the first watch" case).
 */
function buildLaunchWatchSandbox({ pollResponder, launchSprintId }) {
    const html = renderLaunchFormHtml();
    const scriptStart = html.indexOf('<script>') + '<script>'.length;
    const scriptEnd = html.indexOf('</script>', scriptStart);
    assert.ok(scriptStart > -1 && scriptEnd > -1, 'renderLaunchFormHtml must emit a <script> block');
    const script = html.slice(scriptStart, scriptEnd);

    const resultEl = {
        style: {},
        textContent: '',
        children: [],
        appendChild(el) { this.children.push(el); },
    };
    const membersContainer = makeLaunchFormContainer('launch-members');
    membersContainer.querySelectorAll = () => [{ checked: true, value: 'alice' }];
    let submitHandler = null;
    let changeHandler = null;
    const elementsById = {
        'launch-members': membersContainer,
        'launch-selected-issues': makeLaunchFormContainer('launch-selected-issues'),
        'launch-result': resultEl,
        'launch-sprint-form': { addEventListener: (type, handler) => { if (type === 'submit') submitHandler = handler; } },
        'launch-goal': { value: 'P1' },
        'launch-branch': { value: 'feat/x' },
        'launch-base': { value: 'main' },
    };

    const fetchCalls = [];
    let launchCallCount = 0;
    const fetchImpl = async (url, opts) => {
        fetchCalls.push(url);
        if (opts && opts.method === 'POST') {
            const sprintId = typeof launchSprintId === 'function' ? launchSprintId(launchCallCount) : (launchSprintId ?? 's-1');
            launchCallCount += 1;
            return { status: 201, json: async () => ({ sprintId }) };
        }
        // A GET poll (watchLaunch()'s GET /api/sprints/:id).
        return pollResponder(url);
    };

    const mockDocument = {
        getElementById: (id) => elementsById[id] || null,
        addEventListener: (type, handler) => { if (type === 'change') changeHandler = handler; },
        querySelectorAll: () => [],
        createElement: () => ({ style: {}, textContent: '' }),
    };

    // eslint-disable-next-line no-new-func
    const fn = new Function('document', 'fetch', 'window', script);
    fn(mockDocument, fetchImpl, {});

    return {
        resultEl,
        fetchCalls,
        selectIssue(id) {
            assert.ok(changeHandler, 'the document-level change listener must be wired');
            changeHandler({
                target: {
                    classList: { contains: (c) => c === 'bead-select-checkbox' },
                    getAttribute: (name) => (name === 'data-bead-id' ? id : null),
                    checked: true,
                    closest: () => null,
                },
            });
        },
        submit() {
            assert.ok(submitHandler, 'submit handler must be wired');
            submitHandler({ preventDefault() {} });
        },
    };
}

/** Lets any already-settled promise chains (fetch/.json() awaits) drain. */
function flushLaunchWatchMicrotasks() {
    return new Promise((resolve) => setImmediate(resolve));
}

describe('launch-form -- post-launch watch drives the REAL extracted client script (apra-fleet-i9ag.16.4)', () => {
    test('a 201 followed by a launch-failed poll response flips the result line to the failure text (with reason), renders a raw-log anchor, and stops polling', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            const sandbox = buildLaunchWatchSandbox({
                pollResponder: async () => ({
                    ok: true,
                    json: async () => ({
                        sprintId: 's-1', live: false, history: [],
                        latest: { event: 'launch-failed', reason: 'spawn ENOENT' },
                    }),
                }),
            });
            sandbox.selectIssue('apra-fleet-watch.1');
            sandbox.submit();
            await flushLaunchWatchMicrotasks();
            assert.equal(sandbox.resultEl.textContent, 'Launched sprint s-1.', 'the initial 201 success line renders first');

            // The watchdog's own classification cadence is ~5s; this form
            // polls every 2s -- the first tick fires at t=2000ms.
            t.mock.timers.tick(2000);
            await flushLaunchWatchMicrotasks();

            assert.ok(sandbox.resultEl.textContent.includes('s-1'), sandbox.resultEl.textContent);
            assert.ok(sandbox.resultEl.textContent.includes('spawn ENOENT'), sandbox.resultEl.textContent);
            assert.equal(sandbox.resultEl.style.color, '#ef4444');
            assert.equal(sandbox.resultEl.children.length, 1, 'a raw-log anchor must be appended');
            assert.equal(sandbox.resultEl.children[0].href, '/sprints/s-1/log');
            assert.equal(sandbox.resultEl.children[0].textContent, 'Raw log');

            const pollCallsSoFar = sandbox.fetchCalls.filter((u) => u === '/api/sprints/s-1').length;
            assert.equal(pollCallsSoFar, 1, 'exactly one poll before the failure was observed');

            // Polling must have stopped: no further poll after another tick.
            t.mock.timers.tick(2000);
            await flushLaunchWatchMicrotasks();
            assert.equal(sandbox.fetchCalls.filter((u) => u === '/api/sprints/s-1').length, 1, 'no poll after a failure was already classified');
        } finally {
            t.mock.timers.reset();
        }
    });

    test('a 201 followed by only live responses leaves the success line green and stops polling', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            const sandbox = buildLaunchWatchSandbox({
                pollResponder: async () => ({ ok: true, json: async () => ({ sprintId: 's-1', live: true, state: {} }) }),
            });
            sandbox.selectIssue('apra-fleet-watch.2');
            sandbox.submit();
            await flushLaunchWatchMicrotasks();
            const successText = sandbox.resultEl.textContent;
            assert.equal(successText, 'Launched sprint s-1.');

            t.mock.timers.tick(2000);
            await flushLaunchWatchMicrotasks();
            assert.equal(sandbox.resultEl.textContent, successText, 'the success line is untouched by a live classification');
            assert.equal(sandbox.resultEl.style.color, '#22c55e');
            assert.equal(sandbox.fetchCalls.filter((u) => u === '/api/sprints/s-1').length, 1);

            // No further polling once live was observed.
            t.mock.timers.tick(30000);
            await flushLaunchWatchMicrotasks();
            assert.equal(sandbox.fetchCalls.filter((u) => u === '/api/sprints/s-1').length, 1, 'watch must stop polling once the run is confirmed live');
        } finally {
            t.mock.timers.reset();
        }
    });

    test('inconclusive responses for the entire window leave the success line untouched and stop polling when the window closes', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            const sandbox = buildLaunchWatchSandbox({
                // A 404-shaped response every time: not .ok, so the client's
                // own `(r && r.ok) ? r.json() : null` guard yields null ->
                // classifyLaunchWatch(null) -> unknown.
                pollResponder: async () => ({ ok: false, json: async () => ({}) }),
            });
            sandbox.selectIssue('apra-fleet-watch.3');
            sandbox.submit();
            await flushLaunchWatchMicrotasks();
            const successText = sandbox.resultEl.textContent;

            // 30s window / 2s interval = 15 ticks total.
            for (let i = 0; i < 15; i += 1) {
                t.mock.timers.tick(2000);
                // eslint-disable-next-line no-await-in-loop
                await flushLaunchWatchMicrotasks();
            }

            assert.equal(sandbox.resultEl.textContent, successText, 'an all-inconclusive window must never invent a failure');
            assert.equal(sandbox.resultEl.style.color, '#22c55e');
            assert.equal(sandbox.fetchCalls.filter((u) => u === '/api/sprints/s-1').length, 15, 'exactly one poll per tick across the full window');

            // No unbounded polling: nothing further after the window closed.
            t.mock.timers.tick(10000);
            await flushLaunchWatchMicrotasks();
            assert.equal(sandbox.fetchCalls.filter((u) => u === '/api/sprints/s-1').length, 15, 'polling must stop once the window closes, never continue indefinitely');
        } finally {
            t.mock.timers.reset();
        }
    });

    test('a second submit cancels the first watch -- at most one watch in flight', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            let callIndex = 0;
            const sandbox = buildLaunchWatchSandbox({
                launchSprintId: () => (callIndex++ === 0 ? 's-1' : 's-2'),
                pollResponder: async () => ({ ok: true, json: async () => ({ live: true, state: {} }) }),
            });
            sandbox.selectIssue('apra-fleet-watch.4');
            sandbox.submit();
            await flushLaunchWatchMicrotasks();
            assert.equal(sandbox.resultEl.textContent, 'Launched sprint s-1.');

            // A second launch, before the first watch's own first tick fires.
            sandbox.selectIssue('apra-fleet-watch.4b');
            sandbox.submit();
            await flushLaunchWatchMicrotasks();
            assert.equal(sandbox.resultEl.textContent, 'Launched sprint s-2.');

            t.mock.timers.tick(2000);
            await flushLaunchWatchMicrotasks();

            assert.equal(sandbox.fetchCalls.filter((u) => u === '/api/sprints/s-1').length, 0, 'the superseded first watch must never poll');
            assert.equal(sandbox.fetchCalls.filter((u) => u === '/api/sprints/s-2').length, 1, 'only the second (current) watch polls');

            // And it stays a single in-flight watch going forward.
            t.mock.timers.tick(2000);
            await flushLaunchWatchMicrotasks();
            assert.equal(sandbox.fetchCalls.filter((u) => u === '/api/sprints/s-1').length, 0);
        } finally {
            t.mock.timers.reset();
        }
    });

    test('a 400/409 launch error never starts a watch -- no poll is ever scheduled', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
        try {
            const html = renderLaunchFormHtml();
            const scriptStart = html.indexOf('<script>') + '<script>'.length;
            const scriptEnd = html.indexOf('</script>', scriptStart);
            const script = html.slice(scriptStart, scriptEnd);

            const resultEl = { style: {}, textContent: '', appendChild() {} };
            const membersContainer = makeLaunchFormContainer('launch-members');
            membersContainer.querySelectorAll = () => [{ checked: true, value: 'alice' }];
            let submitHandler = null;
            let changeHandler = null;
            const elementsById = {
                'launch-members': membersContainer,
                'launch-selected-issues': makeLaunchFormContainer('launch-selected-issues'),
                'launch-result': resultEl,
                'launch-sprint-form': { addEventListener: (type, handler) => { if (type === 'submit') submitHandler = handler; } },
                'launch-goal': { value: 'P1' },
                'launch-branch': { value: 'feat/x' },
                'launch-base': { value: 'main' },
            };
            const fetchCalls = [];
            const fetchImpl = async (url, opts) => {
                fetchCalls.push(url);
                if (opts && opts.method === 'POST') {
                    return { status: 409, json: async () => ({ error: "member overlap rejects launch: sprint 's-active' already claims [alice]", field: 'members' }) };
                }
                if (url.startsWith('/api/sprints/')) {
                    throw new Error('no poll should ever be issued when the launch itself failed');
                }
                return { json: async () => ({ members: [] }) }; // the unrelated GET /api/members load on script init
            };
            const mockDocument = {
                getElementById: (id) => elementsById[id] || null,
                addEventListener: (type, handler) => { if (type === 'change') changeHandler = handler; },
                querySelectorAll: () => [],
                createElement: () => ({ style: {}, textContent: '' }),
            };
            // eslint-disable-next-line no-new-func
            const fn = new Function('document', 'fetch', 'window', script);
            fn(mockDocument, fetchImpl, {});

            changeHandler({
                target: {
                    classList: { contains: (c) => c === 'bead-select-checkbox' },
                    getAttribute: (name) => (name === 'data-bead-id' ? 'apra-fleet-watch.5' : null),
                    checked: true,
                    closest: () => null,
                },
            });
            assert.ok(submitHandler, 'submit handler must be wired');
            submitHandler({ preventDefault() {} });
            await flushLaunchWatchMicrotasks();

            assert.ok(resultEl.textContent.includes('s-active'), resultEl.textContent);
            assert.ok(resultEl.textContent.includes('alice'), resultEl.textContent);

            // No watch was started -- ticking the clock must never call fetch again.
            // (The member-list load on script init also hits fetch once, at
            // '/api/members' -- irrelevant to this assertion, which only cares
            // that no /api/sprints/:id poll was ever issued.)
            t.mock.timers.tick(30000);
            await flushLaunchWatchMicrotasks();
            assert.equal(fetchCalls.filter((u) => u.startsWith('/api/sprints/')).length, 0, 'a failed launch must never schedule a post-launch watch');
        } finally {
            t.mock.timers.reset();
        }
    });
});
