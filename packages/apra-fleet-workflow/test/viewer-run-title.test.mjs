// apra-fleet-dm5.1: unit coverage for buildRunTitle() (src/viewer/run-title.mjs).
//
// buildRunTitle() builds a short human-readable header sentence for the
// workflow viewer -- e.g. "win-dev1 working apra-fleet-x8r, apra-fleet-dm5
// (P1/P2/P3)" for a fleet-sprint run -- and must degrade cleanly to the
// plain workflow name (never 'undefined', an empty parenthetical, or a
// trailing separator) whenever `state`/`state.args` is missing or only
// partially populated. This pins the acceptance criteria directly: the
// function is exported/pure/total (never throws on partial/empty state),
// and every user-supplied piece (member names, bead ids, the goal string)
// comes back HTML-escaped, never interpolated raw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunTitle } from '../src/viewer/run-title.mjs';
import { HTML_TEMPLATE } from '../src/viewer/index.mjs';

test('null/undefined state falls back to the plain default title, never throws', () => {
    assert.equal(buildRunTitle(null), 'Apra Fleet Workflow');
    assert.equal(buildRunTitle(undefined), 'Apra Fleet Workflow');
});

test('a non-object state (e.g. a string/number) still falls back cleanly', () => {
    assert.equal(buildRunTitle('not an object'), 'Apra Fleet Workflow');
    assert.equal(buildRunTitle(42), 'Apra Fleet Workflow');
});

test('state with a workflowName but no args falls back to the workflow name', () => {
    assert.equal(buildRunTitle({ workflowName: 'my-workflow' }), 'my-workflow');
});

test('state with no workflowName and no args falls back to the default title', () => {
    assert.equal(buildRunTitle({}), 'Apra Fleet Workflow');
});

test('an empty-string workflowName is treated as absent (falls back to the default title)', () => {
    assert.equal(buildRunTitle({ workflowName: '' }), 'Apra Fleet Workflow');
});

test('args present but partial (members only, no goal/targetIssues) degrades to the fallback, not a broken sentence', () => {
    const state = { workflowName: 'wf', args: { members: ['win-dev1'] } };
    assert.equal(buildRunTitle(state), 'wf');
});

test('args present but missing only targetIssues degrades to the fallback', () => {
    const state = { workflowName: 'wf', args: { members: ['win-dev1'], goal: 'P1/P2' } };
    assert.equal(buildRunTitle(state), 'wf');
});

test('args present but missing only goal degrades to the fallback', () => {
    const state = { workflowName: 'wf', args: { members: ['win-dev1'], targetIssues: ['apra-fleet-x8r'] } };
    assert.equal(buildRunTitle(state), 'wf');
});

test('non-array members/targetIssues are treated as empty (fallback), not a crash', () => {
    const state = {
        workflowName: 'wf',
        args: { members: 'win-dev1', targetIssues: 'apra-fleet-x8r', goal: 'P1/P2' }
    };
    assert.equal(buildRunTitle(state), 'wf');
});

test('a full, well-formed args set renders the complete sentence', () => {
    const state = {
        workflowName: 'wf',
        args: {
            members: ['win-dev1'],
            targetIssues: ['apra-fleet-x8r', 'apra-fleet-dm5'],
            goal: 'P1/P2/P3'
        }
    };
    assert.equal(buildRunTitle(state), 'win-dev1 working apra-fleet-x8r, apra-fleet-dm5 (P1/P2/P3)');
});

test('multiple members render joined with ", "', () => {
    const state = {
        args: {
            members: ['win-dev1', 'win-dev2'],
            targetIssues: ['apra-fleet-x8r'],
            goal: 'P1'
        }
    };
    assert.equal(buildRunTitle(state), 'win-dev1, win-dev2 working apra-fleet-x8r (P1)');
});

test('a member name containing "<script>" comes back HTML-escaped, never interpolated raw', () => {
    const state = {
        args: {
            members: ['<script>x'],
            targetIssues: ['apra-fleet-x8r'],
            goal: 'P1'
        }
    };
    const title = buildRunTitle(state);
    assert.ok(!title.includes('<script>'), `Expected no raw <script> tag in the title, got: ${title}`);
    assert.equal(title, '&lt;script&gt;x working apra-fleet-x8r (P1)');
});

test('a goal string containing unescaped HTML-significant characters is escaped too', () => {
    const state = {
        args: {
            members: ['win-dev1'],
            targetIssues: ['apra-fleet-x8r'],
            goal: 'P1 & "P2" <P3>'
        }
    };
    const title = buildRunTitle(state);
    assert.ok(!title.includes('<P3>'), `Expected the goal to be escaped, got: ${title}`);
    assert.equal(title, 'win-dev1 working apra-fleet-x8r (P1 &amp; &quot;P2&quot; &lt;P3&gt;)');
});

test('a target-issue id containing HTML-significant characters is escaped too', () => {
    const state = {
        args: {
            members: ['win-dev1'],
            targetIssues: ['<b>apra-fleet-x8r</b>'],
            goal: 'P1'
        }
    };
    const title = buildRunTitle(state);
    assert.ok(!title.includes('<b>'), `Expected the target issue id to be escaped, got: ${title}`);
    assert.equal(title, 'win-dev1 working &lt;b&gt;apra-fleet-x8r&lt;/b&gt; (P1)');
});

test('empty-string entries inside members/targetIssues arrays are filtered out, not rendered as blanks', () => {
    const state = {
        args: {
            members: ['win-dev1', ''],
            targetIssues: ['apra-fleet-x8r', ''],
            goal: 'P1'
        }
    };
    assert.equal(buildRunTitle(state), 'win-dev1 working apra-fleet-x8r (P1)');
});

test('args that is not an object (e.g. a string) is treated as absent, falls back cleanly', () => {
    assert.equal(buildRunTitle({ workflowName: 'wf', args: 'not-an-object' }), 'wf');
});

// apra-fleet-dm5.3: the header must actually render the sentence in the
// browser, not just compute it. HTML_TEMPLATE() emits the client-side
// <script> that (a) embeds buildRunTitle's own source via .toString() and
// (b) assigns its result into the #run-title element's innerHTML on every
// render (see src/viewer/index.mjs "const runTitleEl = ..."). This extracts
// that ACTUAL render block out of the template (same technique as
// viewer-phase-duration-dom.test.mjs) so a regression that removes the
// title sentence from the header -- either by dropping the #run-title
// element, or by dropping the runTitleEl.innerHTML assignment -- fails this
// test rather than only a hand-written reimplementation.
test('HTML_TEMPLATE emits a #run-title element in the header markup', () => {
    const html = HTML_TEMPLATE([]);
    assert.match(html, /id=["']run-title["']/, 'header markup must contain a #run-title element for the title sentence to render into');
});

test('HTML_TEMPLATE emits the buildRunTitle source and wires it into #run-title.innerHTML on render', () => {
    const html = HTML_TEMPLATE([]);

    assert.match(html, /function buildRunTitle\(/, 'buildRunTitle source must be embedded in the client script');

    const wireIdx = html.indexOf("document.getElementById('run-title')");
    assert.ok(wireIdx !== -1, 'must wire up the #run-title element by id');
    const wireBlock = html.slice(wireIdx, wireIdx + 200);
    assert.match(wireBlock, /\.innerHTML\s*=\s*buildRunTitle\(state\)/, 'the header render path must assign buildRunTitle(state) into #run-title.innerHTML');
});

test('the rendered header HTML actually contains the built sentence for a full fleet-sprint state', () => {
    const html = HTML_TEMPLATE([]);

    const ftStart = html.indexOf('function escapeHtml(');
    assert.ok(ftStart !== -1, 'template must define escapeHtml');
    const brtStart = html.indexOf('function buildRunTitle(');
    assert.ok(brtStart !== -1, 'template must define buildRunTitle');
    const brtEnd = html.indexOf('function resolveStringRefs(', brtStart);
    assert.ok(brtEnd !== -1, 'must find the end of the buildRunTitle block');
    const helpers = html.slice(ftStart, brtEnd);

    // eslint-disable-next-line no-new-func
    const extractedBuildRunTitle = new Function(`${helpers}\nreturn buildRunTitle;`)();

    const state = {
        workflowName: 'wf',
        args: {
            members: ['win-dev1'],
            targetIssues: ['apra-fleet-x8r', 'apra-fleet-dm5'],
            goal: 'P1/P2/P3'
        }
    };

    const runTitleEl = { innerHTML: '' };
    runTitleEl.innerHTML = extractedBuildRunTitle(state);

    assert.equal(runTitleEl.innerHTML, 'win-dev1 working apra-fleet-x8r, apra-fleet-dm5 (P1/P2/P3)');
    assert.ok(runTitleEl.innerHTML.length > 0, 'rendered header HTML must contain the title sentence');
});
