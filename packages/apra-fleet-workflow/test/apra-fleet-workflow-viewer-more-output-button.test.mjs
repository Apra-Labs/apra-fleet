// Tests for apra-fleet-eft.38: surfacing GET /activities/:id/output (added
// in apra-fleet-eft.27.4 but never wired up client-side until now) as a
// 'more...' button on the individual activity widget.
//
// apra-fleet-eft.27.4 caps a `command` activity's stored output/error to a
// head+tail excerpt and marks the capped field via `${field}Truncated` (plus
// the true `${field}ByteLength`) -- see command-output-cap.mjs. Per the
// eft.27.4 USER FEEDBACK addendum this scope covers: the button lives ONLY
// on the individual activity widget's body (never the summary/header, which
// stays a plain expand/collapse toggle), and only one activity's full output
// is ever held expanded in the DOM at a time.
//
// REOPENED (still apra-fleet-eft.38): the first pass keyed the 'more...'
// button on act.output/act.error being truthy. A REAL capped activity (a
// live /state read: a `command` activity with 19 truncated activities in one
// sprint) never carries that field at all -- only markers
// (<field>Truncated + <field>ByteLength) and a short `summary` string. That
// shipped 0 buttons in the whole DOM. The unit test that "verified" the first
// pass fabricated an activity with BOTH `output` and `outputTruncated` -- a
// shape the pipeline never produces. This file now builds activities in the
// REAL shape (markers + summary, no inline field) and, since there's no
// jsdom in this repo, extracts and executes the actual childrenHtml-building
// source out of HTML_TEMPLATE()'s emitted client script (not a
// reimplementation of it) against real `act` objects -- so a regression back
// to gating on act.output/act.error truthiness fails these tests the same
// way it failed in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HTML_TEMPLATE, createDashboardViewer } from '../src/viewer/index.mjs';
import { escapeHtml } from '../src/viewer/html-utils.mjs';

// Pulls the exact childrenHtml-building logic (hasField/fieldBlock + the
// error/output branches) out of the template's emitted client script and
// wraps it as a callable `(act) => childrenHtml` function. Extracting from
// the ACTUAL rendered template (rather than duplicating the logic here)
// means any future change to that logic is exercised by these tests as-is.
function extractChildrenHtmlBuilder() {
    const html = HTML_TEMPLATE([]);
    const start = html.indexOf("let childrenHtml = '';");
    assert.ok(start !== -1, 'template must define childrenHtml');
    const end = html.indexOf('// Token count and model tier', start);
    assert.ok(end !== -1, 'must find the end marker after the childrenHtml block');
    const body = html.slice(start, end);
    // eslint-disable-next-line no-new-func
    const fn = new Function('act', 'escapeHtml', `${body}\nreturn childrenHtml;`);
    return (act) => fn(act, escapeHtml);
}

// The REAL shape a capped `command` activity ships in state.tree /
// GET /state -- e.g. a 1421947-byte captured stdout excerpted by
// command-output-cap.mjs, then further leaned by lean-state.mjs. Note: NO
// `output` key at all, and NO `error` key.
function realCappedCommandActivity(overrides = {}) {
    return {
        id: 'act-1',
        type: 'command',
        phase: 'Test Phase',
        runId: 'run-1',
        label: 'bd list --all --limit 0 --json',
        member: 'orchestrator',
        command: 'bd list --all --limit 0 --json',
        startTime: Date.now(),
        failSoft: false,
        isRunning: false,
        duration: 842,
        success: true,
        outputTruncated: true,
        outputByteLength: 1421947,
        summary: 'BEAD DESCRIPTION: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx...',
        ...overrides
    };
}

test('a REAL capped activity (markers + summary, no inline output field) renders the more-btn', () => {
    const build = extractChildrenHtmlBuilder();
    const act = realCappedCommandActivity();
    const childrenHtml = build(act);

    assert.ok(childrenHtml.includes('class="more-btn"'), 'a real capped activity (no inline output field) must still render the more-btn');
    assert.ok(childrenHtml.includes('data-activity-id="act-1"'), 'more-btn must carry the activity id');
    assert.ok(childrenHtml.includes('data-field="output"'), 'more-btn must carry the capped field name');
    assert.ok(
        childrenHtml.includes(`more... (${(1421947).toLocaleString()} bytes total)`),
        'button label must report the TRUE original byte count'
    );
    // The preview shown is the leaned summary, not an empty/missing value.
    assert.ok(childrenHtml.includes('BEAD DESCRIPTION:'), 'preview text must fall back to act.summary when no inline field is present');
});

test('a non-truncated activity (no markers, no heavy field) renders no more-btn', () => {
    const build = extractChildrenHtmlBuilder();
    const act = realCappedCommandActivity({ outputTruncated: false, outputByteLength: undefined, summary: undefined, output: 'short output' });
    const childrenHtml = build(act);
    assert.ok(childrenHtml.includes('short output'), 'inline text must still render as the preview');
    assert.ok(!childrenHtml.includes('more-btn'), 'an activity with nothing capped must not render a more-btn');
});

test('an activity with neither inline field nor markers renders no output block at all', () => {
    const build = extractChildrenHtmlBuilder();
    const act = realCappedCommandActivity({ outputTruncated: false, outputByteLength: undefined, summary: undefined });
    const childrenHtml = build(act);
    assert.equal(childrenHtml, '', 'nothing to show -- must not render an empty activity-child block');
});

test('an agent activity whose response was leaned into summary+markers also renders the more-btn', () => {
    // apra-fleet-eft.38 (reopened) EXTENDED scope: lean-state.mjs's
    // summarizeHeavyFields() now stamps <field>Truncated/<field>ByteLength on
    // ANY heavy field it strips, not just a `command` activity's
    // already-capped output -- most notably an `agent` activity's full LLM
    // response, which command-output-cap.mjs never touches at storage time.
    const build = extractChildrenHtmlBuilder();
    const act = {
        id: 'agent-1',
        type: 'agent',
        label: 'Plan the sprint',
        member: 'orchestrator',
        model: 'premium',
        isRunning: false,
        success: true,
        duration: 4210,
        outputTruncated: true,
        outputByteLength: 58213,
        summary: 'Here is the plan: 1) ...'
    };
    const childrenHtml = build(act);
    assert.ok(childrenHtml.includes('class="more-btn"'), 'a leaned agent activity must also render the more-btn');
    assert.ok(childrenHtml.includes('data-activity-id="agent-1"'));
    assert.ok(childrenHtml.includes('data-field="output"'));
    assert.ok(childrenHtml.includes(`more... (${(58213).toLocaleString()} bytes total)`));
});

test('an error activity with a real capped error renders the error field block, gated the same way', () => {
    const build = extractChildrenHtmlBuilder();
    const act = realCappedCommandActivity({
        success: false,
        outputTruncated: false,
        outputByteLength: undefined,
        errorTruncated: true,
        errorByteLength: 99999,
        summary: 'exit code 1: something failed'
    });
    const childrenHtml = build(act);
    assert.ok(childrenHtml.includes('activity-child error'));
    assert.ok(childrenHtml.includes('data-field="error"'));
    assert.ok(childrenHtml.includes(`more... (${(99999).toLocaleString()} bytes total)`));
});

test('template still defines more-btn markup, gated on the <field>Truncated/<field>ByteLength markers', () => {
    const html = HTML_TEMPLATE([]);

    assert.ok(html.includes("class=\"more-btn\""), 'template must define more-btn markup');
    assert.ok(html.includes("data-activity-id="), 'more-btn must carry the activity id so the click handler knows what to fetch');
    assert.ok(html.includes("data-field=\""), 'more-btn must carry which field (output/error) it expands');
    assert.ok(
        html.includes("act[field + 'Truncated']") || html.includes('act[field + "Truncated"]'),
        'hasField()/fieldBlock() must be gated on <field>Truncated'
    );
    assert.ok(
        html.includes("act[field + 'ByteLength'] !== undefined") || html.includes('act[field + "ByteLength"] !== undefined'),
        'hasField() must also key on <field>ByteLength -- a real capped activity may carry only the markers, never an inline field'
    );

    // The summary/header block (activity-header) must not itself become a
    // fetch trigger -- it stays the plain <details> toggle it always was.
    const summaryMatch = html.match(/<summary class="activity-header">[\s\S]*?<\/summary>/);
    assert.ok(summaryMatch, 'template must still render the activity summary/header');
    assert.ok(!summaryMatch[0].includes('more-btn'), 'the more-btn must never live inside the activity summary/header');
});

test('clicking more fetches GET /activities/:id/output, scoped to the .more-btn element only', () => {
    const html = HTML_TEMPLATE([]);
    assert.ok(html.includes("e.target.closest('.more-btn')"), 'click handling must be scoped to .more-btn, not any click in the activity widget');
    assert.ok(html.includes("fetch('/activities/' + encodeURIComponent(activityId) + '/output')"), 'must fetch the on-demand full-output endpoint by activity id');
    assert.ok(html.includes('data[field]'), 'must read the response field matching the button that was clicked (output vs error)');
});

test('only one activity full-output block is ever held expanded at a time', () => {
    const html = HTML_TEMPLATE([]);
    assert.ok(html.includes('let expandedMoreBtn = null;'), 'must track a single globally-expanded more-btn');
    assert.ok(
        html.includes('if (expandedMoreBtn && expandedMoreBtn !== btn) {') &&
        html.includes('collapseMoreBtn(expandedMoreBtn);'),
        'expanding a new block must collapse whichever block was previously expanded'
    );
});

test('a second expansion collapses the first: collapseMoreBtn restores the capped preview and resets button state', () => {
    const html = HTML_TEMPLATE([]);
    // collapseMoreBtn() (invoked for the previously-expanded button whenever
    // a second more-btn is clicked -- see the previous test) must restore
    // the span's ORIGINAL (capped) preview text from data-truncated-text,
    // and reset the button back to its clickable, non-expanded state.
    const fnMatch = html.match(/function collapseMoreBtn\(btn\) \{[\s\S]*?\n {4}\}/);
    assert.ok(fnMatch, 'template must define collapseMoreBtn()');
    const body = fnMatch[0];
    assert.ok(body.includes('span.dataset.truncatedText'), 'must restore the span from its stashed truncated-text preview');
    assert.ok(body.includes("btn.dataset.state = '';"), 'must reset the button state back to collapsed');
    assert.ok(body.includes('btn.disabled = false;'), 'a collapsed button must be clickable again');
    assert.ok(body.includes("btn.textContent = btn.dataset.label || 'more...';"), 'must restore the original more...-with-byte-count label');
});

test('a collapsed/failed fetch never leaves the DOM in a stuck loading state', () => {
    const html = HTML_TEMPLATE([]);
    // Loading state is guarded against double-dispatch, and the catch path
    // always resets state/disabled so a failed fetch remains clickable again.
    assert.ok(html.includes("if (btn.dataset.state === 'loading') return;"), 'must not double-dispatch a fetch already in flight');
    assert.ok(html.includes('btn.dataset.state = \'\';') && html.includes('btn.disabled = false;'), 'a failed fetch must reset the button back to a clickable state');
});

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

// apra-fleet-eft.38 (reopened) EXTENDED scope, server side: an `agent`
// activity's full LLM response is never routed through
// command-output-cap.mjs's fullOutputById store (that module only caps
// `type: 'command'` activities) -- but it also never gets deleted from the
// LIVE `state` object either (only GET /state's lean-state.mjs trims it down
// to `summary` for the wire). GET /activities/:id/output must therefore fall
// back to reading the complete text straight out of the live state.tree for
// any id command-output-cap.mjs has nothing for -- see findActivityById() in
// src/viewer/index.mjs.
test('GET /activities/:id/output falls back to the live in-memory state.tree for an agent activity (never capped by command-output-cap.mjs)', async () => {
    const cwdTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-more-output-btn-test-cwd-'));
    const cwdOriginal = process.cwd();
    process.chdir(cwdTemp);
    try {
        const wf = new EventEmitter();
        const runningStatePath = path.join(cwdTemp, 'running-state.json');
        const server = createDashboardViewer(wf, {
            port: 0,
            name: 'Agent Output Fallback Test',
            debouncedStatePath: runningStatePath
        });

        await withServer(server, async (port) => {
            const fullResponse = 'AGENT RESPONSE: ' + 'r'.repeat(60000);
            const meta = { id: 'agent-act-1', type: 'agent', label: 'Plan the sprint', member: 'orchestrator', model: 'premium' };
            wf.emit('activity:start', meta);
            wf.emit('activity:end', { ...meta, success: true, duration: 100, output: fullResponse });

            // GET /state (the leaned wire payload) must never carry the full
            // response -- only the summary + markers.
            const state = await httpGetFull(port, '/state');
            assert.equal(state.statusCode, 200);
            assert.ok(!state.body.includes(fullResponse), 'GET /state must never embed the full agent response');
            const parsedState = JSON.parse(state.body);
            const act = parsedState.tree[0].phases[0].events.find((e) => e.data && e.data.id === 'agent-act-1').data;
            assert.equal(act.outputTruncated, true, 'a leaned agent response must be marked outputTruncated');
            assert.equal(act.outputByteLength, Buffer.byteLength(fullResponse, 'utf8'), 'must report the TRUE original byte length');
            assert.equal(typeof act.summary, 'string');

            // GET /activities/:id/output must still serve the complete text,
            // even though command-output-cap.mjs never capped this activity.
            const full = await httpGetFull(port, '/activities/agent-act-1/output');
            assert.equal(full.statusCode, 200);
            const parsedFull = JSON.parse(full.body);
            assert.equal(parsedFull.output, fullResponse, 'full agent response must round-trip byte-for-byte');
        });
    } finally {
        process.chdir(cwdOriginal);
        fs.rmSync(cwdTemp, { recursive: true, force: true });
    }
});

test('history view (no live process) still renders the more-btn markup unconditionally with the rest of the template', () => {
    // The button's presence is data-driven client-side (act.outputTruncated/
    // errorTruncated / *ByteLength), not server-render-mode-driven -- both
    // live and history views share the exact same HTML_TEMPLATE script.
    const live = HTML_TEMPLATE([]);
    const history = HTML_TEMPLATE([], { history: true, state: { workflowName: 'x', status: 'success', stats: {}, tree: [] } });
    assert.ok(live.includes('class="more-btn"'));
    assert.ok(history.includes('class="more-btn"'));
});
