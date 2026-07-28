// apra-fleet-eft.69.2: test coverage for the generic agent/command/other row
// model apra-fleet-eft.69.1 implemented in src/viewer/index.mjs.
//
// apra-fleet-eft.69's HARD CONSTRAINT (acceptance-level, from the user) is
// that the viewer must implement GENERIC concepts only -- how to render an
// agent call, a command call, and other/log rows -- and must NEVER
// special-case auto-sprint's own role/phase names (Planner, Reviewer, Plan
// Reviewer, Streak Assignment, Doer, Deployer, Integ Test Runner, Final
// Verdict, Harvester) in viewer code. This file covers both halves of
// apra-fleet-eft.69.2's acceptance criteria for the VIEWER side:
//   1. a grep-style scan (with a mutation self-check proving it has teeth)
//      that fails if viewer source ever special-cases one of those names;
//   2. a render-equivalence test proving a Streak Assignment agent-row
//      fixture renders through the EXACT SAME generic code path as any other
//      agent dispatch (e.g. Planner) -- swap only the label/member and the
//      rendered HTML differs in nothing else.
//
// The runner.js half (no duplicate raw-JSON log() dump reappearing after a
// dispatch) is covered separately in
// packages/apra-fleet-se/test/mock-sprint-streak-assignment-no-duplicate-row.test.mjs,
// since that is where every other runner.js/mock-sprint regression for this
// codepath already lives.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HTML_TEMPLATE } from '../src/viewer/index.mjs';
import { escapeHtml } from '../src/viewer/html-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWER_DIR = path.join(__dirname, '..', 'src', 'viewer');

// The exact auto-sprint role/phase names apra-fleet-eft.69's HARD CONSTRAINT
// forbids the viewer from special-casing (the full dispatch roster named in
// apra-fleet-eft.69.1's commit message).
const ROLE_PHASE_NAMES = [
    'Reviewer',
    'Planner',
    'Plan Reviewer',
    'Streak Assignment',
    'Doer',
    'Deployer',
    'Integ Test Runner',
    'Final Verdict',
    'Harvester',
];

// "Special-casing" means viewer CODE branches/keys behavior on one of these
// names as a string literal -- e.g. `act.label === 'Streak Assignment'`,
// `.includes('Doer')`, or a `case 'Planner':` -- not merely that the word
// appears somewhere (a comment explaining the generic rule in prose, like
// "the same as agent()'s label", is fine and expected). Scanning for the
// name immediately following one of these branching operators catches the
// actual special-casing shape without needing a full comment-stripping
// tokenizer.
const SPECIAL_CASE_OPERATOR = '(?:===|==|!==|!=|\\.includes\\(|\\.startsWith\\(|\\.endsWith\\(|case\\s+)\\s*';

function buildSpecialCaseRegex(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${SPECIAL_CASE_OPERATOR}['"\`]${escaped}['"\`]`);
}

function listViewerSrcFiles() {
    return fs.readdirSync(VIEWER_DIR, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.mjs$/.test(e.name))
        .map((e) => path.join(VIEWER_DIR, e.name));
}

function scanForSpecialCasing(contents) {
    const hits = [];
    for (const [file, content] of Object.entries(contents)) {
        for (const name of ROLE_PHASE_NAMES) {
            const re = buildSpecialCaseRegex(name);
            const m = content.match(re);
            if (m) {
                hits.push(`${file}: matched "${m[0]}" (role/phase name "${name}")`);
            }
        }
    }
    return hits;
}

function loadViewerContents() {
    const contents = {};
    for (const file of listViewerSrcFiles()) {
        contents[path.relative(VIEWER_DIR, file)] = fs.readFileSync(file, 'utf8');
    }
    return contents;
}

test('viewer source never special-cases an auto-sprint role/phase name (apra-fleet-eft.69 HARD CONSTRAINT)', () => {
    const contents = loadViewerContents();
    const hits = scanForSpecialCasing(contents);
    assert.deepStrictEqual(
        hits,
        [],
        `viewer source special-cases a role/phase name (a wrong fix per apra-fleet-eft.69's HARD CONSTRAINT):\n${hits.join('\n')}`
    );
});

test('scanner catches a seeded role/phase special-case (mutation self-check)', () => {
    // Proves the scanner above would actually fail if a special case were
    // introduced -- exercised against a synthetic mutated copy, never
    // written to the real file on disk.
    const contents = loadViewerContents();
    const cleanRelPath = 'index.mjs';
    const clean = contents[cleanRelPath];
    assert.ok(clean, `fixture file ${cleanRelPath} missing`);
    assert.deepStrictEqual(scanForSpecialCasing({ [cleanRelPath]: clean }), []);

    const seeded = `${clean}\nif (act.label === 'Streak Assignment') { renderSpecialStreakRow(act); }\n`;
    const hits = scanForSpecialCasing({ [cleanRelPath]: seeded });
    assert.ok(
        hits.some((h) => h.includes('Streak Assignment')),
        `expected the scanner to catch a seeded 'act.label === \\'Streak Assignment\\'' special case, got: ${JSON.stringify(hits)}`
    );
});

// Pulls the ACTUAL activity-row-building logic (title + badge + body) out of
// the template's emitted client script, rather than re-implementing it here,
// so a real future regression (e.g. a role-keyed branch reintroduced into
// this exact block) is exercised as-is -- same extraction technique as
// apra-fleet-workflow-viewer-more-output-button.test.mjs's
// extractChildrenHtmlBuilder().
function extractActivityRowBuilder() {
    const html = HTML_TEMPLATE([]);
    const startMarker = '// Update contents every tick to catch status changes';
    const start = html.indexOf(startMarker);
    assert.ok(start !== -1, 'expected to find the activity-row render block start marker');
    const endMarker = "if (!act.isRunning) evEl.dataset.rendered = 'done';";
    const endIdx = html.indexOf(endMarker, start);
    assert.ok(endIdx !== -1, 'expected to find the activity-row render block end marker');
    const body = html.slice(start, endIdx);
    const formatTimeSrc = extractHelperFn(html, 'formatTime');
    const formatUptimeSrc = extractHelperFn(html, 'formatUptime');
    // eslint-disable-next-line no-new-func
    const factory = new Function(`
        ${formatTimeSrc}
        ${formatUptimeSrc}
        return { formatTime, formatUptime };
    `);
    const { formatTime, formatUptime } = factory();
    // eslint-disable-next-line no-new-func
    const fn = new Function('act', 'escapeHtml', 'formatTime', 'formatUptime', `
        const evEl = { dataset: {} };
        ${body}
        return evEl.innerHTML;
    `);
    return (act) => fn(act, escapeHtml, formatTime, formatUptime);
}

// Extracted verbatim from the same client script (formatTime/formatUptime
// are defined once, near the top of HTML_TEMPLATE, and used by the
// activity-row block above) -- not reimplemented, so a future change to
// either stays in sync with what this test actually exercises.
function extractHelperFn(html, name) {
    const marker = `function ${name}(`;
    const start = html.indexOf(marker);
    assert.ok(start !== -1, `expected to find ${name}() in the template`);
    const end = html.indexOf('\n    }', start);
    assert.ok(end !== -1, `expected to find the end of ${name}()`);
    return html.slice(start, end + '\n    }'.length);
}

test('a Streak Assignment agent activity renders through the EXACT SAME generic path as any other agent dispatch', () => {
    // apra-fleet-eft.69 bug item 2: "Apply the same AGENT-row logic to EVERY
    // agent call uniformly -- including Streak Assignment, which currently
    // renders differently from other agent dispatches for no clear reason."
    // Build the Streak Assignment fixture in its REAL shape: an 'agent'
    // activity whose output is the streakAssignment schema's own
    // JSON-stringified shape ({streaks: string[][]}), dispatched via the
    // 'planner' member per runner.js's buildStreakAssignmentPrompt() site
    // (see runner.js ~line 5905).
    const build = extractActivityRowBuilder();
    const base = {
        id: 'act-1',
        type: 'agent',
        model: 'standard',
        isRunning: false,
        success: true,
        duration: 4210,
        startTime: Date.now(),
        output: JSON.stringify({ streaks: [['bead-1', 'bead-2']] }),
    };
    const streakAssignmentAct = { ...base, label: 'Streak Assignment', member: 'planner-member' };
    const plannerAct = { ...base, label: 'Planner', member: 'planner-member' };

    const streakHtml = build(streakAssignmentAct);
    const plannerHtml = build(plannerAct);

    // Both rows carry the standard AGENT title prefix and the standard
    // output body wrapper -- proving Streak Assignment is not routed through
    // any distinct/legacy rendering.
    for (const html of [streakHtml, plannerHtml]) {
        assert.ok(html.includes('<strong>AGENT</strong>:'), 'must render through the generic AGENT title prefix');
        assert.ok(html.includes('class="activity-body"'), 'must render the standard activity-body wrapper');
        assert.ok(html.includes('class="activity-child output"'), 'must render the standard generic output body block');
    }

    // Structural equivalence: substituting the label back in for its own
    // placeholder makes the two HTML strings byte-for-byte identical -- i.e.
    // the ONLY difference between the Streak Assignment row and the Planner
    // row is the label text itself, never a distinct code path/markup shape.
    const normalize = (html, act) => html.split(escapeHtml(act.label)).join('<<LABEL>>');
    assert.equal(
        normalize(streakHtml, streakAssignmentAct),
        normalize(plannerHtml, plannerAct),
        'Streak Assignment and Planner activities must render through byte-identical markup once their labels are normalized -- any structural diff means Streak Assignment is on its own code path'
    );
});

test('a completed agent activity with no output/error at all renders title-only, uniformly (no role-specific fallback body)', () => {
    const build = extractActivityRowBuilder();
    const act = {
        id: 'act-2',
        type: 'agent',
        label: 'Streak Assignment',
        member: 'planner-member',
        model: 'standard',
        isRunning: false,
        success: true,
        duration: 100,
        startTime: Date.now(),
    };
    const html = build(act);
    assert.ok(!html.includes('class="activity-body"'), 'no output/error field at all must render no body -- the same uniform rule every other activity type follows');
});
