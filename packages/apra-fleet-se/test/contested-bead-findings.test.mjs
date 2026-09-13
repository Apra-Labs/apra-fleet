import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractContestedBeadIds } from '../fleet-sprint/newtask-text.mjs';

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
