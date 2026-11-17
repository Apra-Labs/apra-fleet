import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractContestedBeadIds } from '../fleet-sprint/newtask-text.mjs';
import { validateVerdict } from '../fleet-sprint/contracts.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const NEWTASK_TEXT_PATH = path.join(__dirname, '../fleet-sprint/newtask-text.mjs');
const PLAN_PHASE_PATH = path.join(__dirname, '../fleet-sprint/phases/plan.mjs');
const PLAN_REVIEWER_MD_PATH = path.join(__dirname, '../apra-pm/agents/plan-reviewer.md');
const PLAN_REVIEWER_SCHEMA_PATH = path.join(__dirname, '../apra-pm/agents/schemas/plan-reviewer-output.json');

// =============================================================================
// The contested-bead set is read from the plan-reviewer verdict's STRUCTURED
// `findings` array; the free-text `notes` scan survives only as a deprecated
// fallback for a verdict that carries no `findings` key at all.
//
// These tests drive the real production function (imported from its owning
// module, not re-derived here). The central equivalence test below is what
// proves the input channel moved WITHOUT moving the routing decision: the same
// plan, expressed once as findings and once as prose, must yield the identical
// contested set.
//
// The three whole-plan-contested conditions the plan phase derives from this
// return value (no task ids / empty contested set / contested set at least as
// large as the task set) are asserted here as the SET the phase sees, since
// that set is this function's entire contribution to the routing decision.
// =============================================================================

const TASKS = [
    { id: 'BD-14', bucket: 'M', model: 'standard' },
    { id: 'BD-22', bucket: 'S', model: 'cheap' },
    { id: 'BD-7', bucket: 'L', model: 'premium' },
];

test('findings-bearing and equivalent notes-only verdicts produce the same contested set', () => {
    const structured = extractContestedBeadIds({
        verdict: 'CHANGES_NEEDED',
        notes: 'Narration only -- the machine-readable objections are in findings.',
        findings: [
            { id: 'BD-14', kind: 'acceptance_criteria', detail: 'Criteria are unfalsifiable.' },
            { id: 'BD-7', kind: 'task_size', detail: 'Too large to review in one pass.' },
        ],
        taskAssignments: TASKS,
    });

    const prose = extractContestedBeadIds({
        verdict: 'CHANGES_NEEDED',
        notes: 'BD-14 has unfalsifiable criteria, and BD-7 is too large to review in one pass.',
        taskAssignments: TASKS,
    });

    assert.deepStrictEqual(structured, ['BD-14', 'BD-7']);
    assert.deepStrictEqual(
        structured,
        prose,
        'the structured findings channel and the deprecated prose scan must agree on the contested set'
    );
});

test('findings wins over notes: notes are not scanned when findings is present', () => {
    // The prose names BD-22 as well; findings does not. If the notes scan were
    // still running (or unioned in), BD-22 would leak into the contested set
    // and the plan phase would defer a bead the reviewer never contested.
    const contested = extractContestedBeadIds({
        verdict: 'CHANGES_NEEDED',
        notes: 'BD-14, BD-22 and BD-7 were all discussed at length in this round.',
        findings: [{ id: 'BD-14', kind: 'coverage', detail: 'No test task covers it.' }],
        taskAssignments: TASKS,
    });

    assert.deepStrictEqual(contested, ['BD-14']);
});

test('an EMPTY findings array is the explicit plan-wide signal, not a fallback trigger', () => {
    // Per the contract, [] means "the objection is genuinely plan-wide and
    // names no individual bead". It must NOT fall through to the notes scan,
    // which here would wrongly confine the objection to BD-14.
    const contested = extractContestedBeadIds({
        verdict: 'CHANGES_NEEDED',
        notes: 'The whole plan is mis-sequenced; BD-14 is merely where it first shows.',
        findings: [],
        taskAssignments: TASKS,
    });

    assert.deepStrictEqual(contested, [], 'empty findings must yield an empty (whole-plan) contested set');
});

test('findings ids are intersected with taskAssignments and keep taskAssignments order', () => {
    const contested = extractContestedBeadIds({
        verdict: 'CHANGES_NEEDED',
        notes: '',
        findings: [
            // Declared out of order, plus one id that is not in scope at all.
            { id: 'BD-7', kind: 'scope_creep', detail: 'Grew past its lane.' },
            { id: 'BD-999', kind: 'other', detail: 'Not part of this plan at all.' },
            { id: 'BD-14', kind: 'dependency_wiring', detail: 'Blocks edge points the wrong way.' },
        ],
        taskAssignments: TASKS,
    });

    assert.deepStrictEqual(
        contested,
        ['BD-14', 'BD-7'],
        'the contested set stays a subset of taskAssignments, in taskAssignments order'
    );
});

test('a contested set spanning every task id is preserved through the structured channel', () => {
    // The plan phase treats contestedIds.length >= allTaskIds.length as
    // whole-plan contested; this is the shape that must keep reaching it.
    const contested = extractContestedBeadIds({
        verdict: 'CHANGES_NEEDED',
        notes: 'irrelevant',
        findings: TASKS.map((t) => ({ id: t.id, kind: 'feasibility', detail: 'Not feasible as written.' })),
        taskAssignments: TASKS,
    });

    assert.deepStrictEqual(contested, ['BD-14', 'BD-22', 'BD-7']);
    assert.equal(contested.length, TASKS.length, 'whole-plan contested must remain detectable by length');
});

test('malformed findings entries are ignored rather than throwing', () => {
    const contested = extractContestedBeadIds({
        verdict: 'CHANGES_NEEDED',
        notes: 'BD-22 is the real problem here.',
        findings: [null, {}, { id: '' }, { id: 'BD-22', kind: 'ready_work', detail: 'Nothing ready after it.' }],
        taskAssignments: TASKS,
    });

    assert.deepStrictEqual(contested, ['BD-22']);
});

test('the deprecated notes fallback keeps its non-identifier boundary rule', () => {
    // A shorter id must not false-positive inside a longer one that merely
    // extends it -- the property the prose scan was written for, preserved
    // verbatim so a pre-findings verdict routes exactly as it used to.
    const tasks = [{ id: 'BD-7' }, { id: 'BD-70' }];

    assert.deepStrictEqual(
        extractContestedBeadIds({ notes: 'BD-70 needs rework.', taskAssignments: tasks }),
        ['BD-70'],
        'BD-7 must not match inside BD-70'
    );
    assert.deepStrictEqual(
        extractContestedBeadIds({ notes: 'BD-7 needs rework.', taskAssignments: tasks }),
        ['BD-7']
    );
});

test('a verdict with neither findings nor usable notes yields an empty contested set', () => {
    assert.deepStrictEqual(extractContestedBeadIds(null), []);
    assert.deepStrictEqual(extractContestedBeadIds({}), []);
    assert.deepStrictEqual(extractContestedBeadIds({ notes: 'BD-14 is wrong.' }), [],
        'no taskAssignments means nothing is in scope to contest');
    assert.deepStrictEqual(extractContestedBeadIds({ taskAssignments: TASKS }), [],
        'no findings key and no notes string falls back to an empty set, as before');
    assert.deepStrictEqual(
        extractContestedBeadIds({ notes: 'BD-14 is wrong.', findings: 'not-an-array', taskAssignments: TASKS }),
        ['BD-14'],
        'a non-array findings value is not the structured channel -- it falls back to the prose scan'
    );
});

// =============================================================================
// Criterion 1: a findings array naming a STRICT SUBSET of taskAssignments
// routes to per-bead deferral, never whole-plan handling. The wholePlanContested
// formula below is quoted verbatim from fleet-sprint/phases/plan.mjs (and its
// continued presence there is checked, not assumed) -- extractContestedBeadIds
// itself contributes only the contested-set HALF of that decision, so proving
// "not wholly contested" means evaluating the same three-term OR the phase
// itself evaluates.
// =============================================================================
const PLAN_PHASE_SOURCE = fs.readFileSync(PLAN_PHASE_PATH, 'utf8');
const wholePlanContested = (allTaskIds, contestedIds) =>
    allTaskIds.length === 0 || contestedIds.length === 0 || contestedIds.length >= allTaskIds.length;

test('sanity: plan.mjs still expresses whole-plan-contested as this same three-term OR', () => {
    assert.match(
        PLAN_PHASE_SOURCE,
        /allTaskIds\.length === 0\s*\n\s*\|\| contestedIds\.length === 0\s*\n\s*\|\| contestedIds\.length >= allTaskIds\.length/,
        'wholePlanContested() below must keep mirroring plan.mjs\'s actual routing formula, not a stale copy of it'
    );
});

test('a findings-named strict subset defers just that subset, never the whole plan', () => {
    const allTaskIds = TASKS.map((t) => t.id);
    const contested = extractContestedBeadIds({
        verdict: 'CHANGES_NEEDED',
        // The prose ALSO names the same bead, a realistic shape (a reviewer's
        // narration usually agrees with their own structured findings) --
        // deliberately not a channel-distinguishing case; see the
        // falsification test below for why that matters.
        notes: 'BD-14 needs rework before this can be approved; the rest of the plan is fine.',
        findings: [{ id: 'BD-14', kind: 'acceptance_criteria', detail: 'Criteria are unfalsifiable.' }],
        taskAssignments: TASKS,
    });

    assert.deepStrictEqual(contested, ['BD-14'], 'exactly the named bead, and only it, is contested');
    assert.notEqual(contested.length, 0, 'sanity: a strict subset is never the empty-set whole-plan condition');
    assert.ok(contested.length < allTaskIds.length, 'sanity: a strict subset is smaller than the full task set');
    assert.strictEqual(
        wholePlanContested(allTaskIds, contested),
        false,
        'a strict subset must NOT route to whole-plan handling'
    );
});

// =============================================================================
// Criterion 3: each of the three whole-plan-contested conditions, asserted
// independently against the SAME formula pinned above.
// =============================================================================
test('whole-plan condition 1 of 3: zero task ids', () => {
    const contested = extractContestedBeadIds({
        verdict: 'CHANGES_NEEDED',
        notes: 'irrelevant',
        findings: [],
        taskAssignments: [],
    });
    assert.deepStrictEqual(contested, []);
    assert.strictEqual(wholePlanContested([], contested), true, 'zero in-scope task ids must route to whole-plan handling');
});

test('whole-plan condition 2 of 3: an empty contested set (findings explicitly plan-wide)', () => {
    const allTaskIds = TASKS.map((t) => t.id);
    const contested = extractContestedBeadIds({
        verdict: 'CHANGES_NEEDED',
        notes: 'The whole plan is mis-sequenced.',
        findings: [],
        taskAssignments: TASKS,
    });
    assert.deepStrictEqual(contested, []);
    assert.strictEqual(
        wholePlanContested(allTaskIds, contested),
        true,
        'an empty contested set (with a non-empty task set) must route to whole-plan handling'
    );
});

test('whole-plan condition 3 of 3: a contested set at least as large as the task set', () => {
    const allTaskIds = TASKS.map((t) => t.id);
    const contested = extractContestedBeadIds({
        verdict: 'CHANGES_NEEDED',
        notes: 'irrelevant',
        findings: TASKS.map((t) => ({ id: t.id, kind: 'feasibility', detail: 'Not feasible as written.' })),
        taskAssignments: TASKS,
    });
    assert.deepStrictEqual(contested, allTaskIds);
    assert.strictEqual(
        wholePlanContested(allTaskIds, contested),
        true,
        'a contested set covering every task id must route to whole-plan handling'
    );
});

// =============================================================================
// Criterion 5: a findings-less verdict still validates against the
// plan-reviewer output schema, and the deprecated notes-scan fallback carries
// a named removal release in a comment a test can read.
// =============================================================================
test('a verdict that omits findings still validates against the plan-reviewer schema', () => {
    const { valid, errors } = validateVerdict('planReviewerVerdict', {
        verdict: 'CHANGES_NEEDED',
        notes: 'BD-14 needs rework.',
        taskAssignments: [{ id: 'BD-14', bucket: 'S', model: 'standard' }],
        // No `findings` key at all -- the pre-contract shape.
    });
    assert.strictEqual(valid, true, `a findings-less verdict must still validate: ${JSON.stringify(errors)}`);
});

test('a verdict WITH findings also validates, including an empty findings array', () => {
    const withFindings = validateVerdict('planReviewerVerdict', {
        verdict: 'CHANGES_NEEDED',
        notes: 'BD-14 needs rework.',
        findings: [{ id: 'BD-14', kind: 'acceptance_criteria', detail: 'Criteria are unfalsifiable.' }],
        taskAssignments: [{ id: 'BD-14', bucket: 'S', model: 'standard' }],
    });
    assert.strictEqual(withFindings.valid, true, `findings-bearing verdict must validate: ${JSON.stringify(withFindings.errors)}`);

    const emptyFindings = validateVerdict('planReviewerVerdict', {
        verdict: 'CHANGES_NEEDED',
        notes: 'The whole plan is mis-sequenced.',
        findings: [],
        taskAssignments: [{ id: 'BD-14', bucket: 'S', model: 'standard' }],
    });
    assert.strictEqual(
        emptyFindings.valid, true,
        `an empty findings array (the explicit plan-wide signal) must validate: ${JSON.stringify(emptyFindings.errors)}`
    );
});

const NEWTASK_TEXT_SOURCE = fs.readFileSync(NEWTASK_TEXT_PATH, 'utf8');
const DEPRECATION_MARKER_RE = /@deprecated since the structured plan-reviewer findings field; removal[\s\S]{0,10}release: v[\d.]+/;

test('the deprecated notes-scan fallback carries a named removal release in a comment', () => {
    assert.match(
        NEWTASK_TEXT_SOURCE,
        DEPRECATION_MARKER_RE,
        'contestedBeadIdsFromNotesProse must carry an @deprecated comment naming a removal release version'
    );
});

// =============================================================================
// Criterion 6: no CONCRETE apra-fleet bead id (this repo's own tracker id
// shape, e.g. "apra-fleet-3swo.7.10") appears in the plan-reviewer contract
// prose or its schema descriptions -- those strings reach an LLM at dispatch
// time, per this repo's CLAUDE.md rule. The example ids used throughout both
// files ("BD-14", "BD-22", ...) are a deliberately fictional, generic
// placeholder shape that does not match this repo's own tracker id pattern,
// and are exactly what this check must NOT flag.
// =============================================================================
const APRA_FLEET_BEAD_ID_RE = /apra-fleet-[a-z0-9]+(?:\.[0-9]+)*/i;

test('no concrete apra-fleet bead id appears in the plan-reviewer contract or schema', () => {
    const contractText = fs.readFileSync(PLAN_REVIEWER_MD_PATH, 'utf8');
    const schemaText = fs.readFileSync(PLAN_REVIEWER_SCHEMA_PATH, 'utf8');

    assert.doesNotMatch(
        contractText, APRA_FLEET_BEAD_ID_RE,
        'plan-reviewer.md must not cite a concrete apra-fleet-XXXX bead id -- that text is LLM-facing at dispatch time'
    );
    assert.doesNotMatch(
        schemaText, APRA_FLEET_BEAD_ID_RE,
        'plan-reviewer-output.json descriptions must not cite a concrete apra-fleet-XXXX bead id'
    );
    // Sanity: the generic "BD-14"-style placeholder IS present (proves this
    // check is discriminating real ids from the fictional example shape, not
    // just finding an empty file).
    assert.match(contractText, /BD-\d+/, 'sanity: the contract\'s own fictional example id shape must still be present');
});

// Criterion 7 (falsification) is NOT expressed as an automated test here: it
// would require rewriting fleet-sprint/newtask-text.mjs -- a real, tracked,
// shared source file every other concurrently-running test file may also
// import -- on disk mid-suite. Under this package's own test-concurrency (see
// package.json's `--test-concurrency=8`), that risks a torn read of the file
// by an unrelated test, or leaving the file corrupted on disk if the process
// is killed between the write and the restore. Both violate this bead's own
// "no artifacts left outside the test sandbox" criterion far more seriously
// than skipping an in-repo falsification test would. The falsification was
// instead performed manually once, outside the committed suite, with the
// result recorded in this bead's closing report: see that report for the
// exact revert applied and the observed pass/fail outcome of each check.
