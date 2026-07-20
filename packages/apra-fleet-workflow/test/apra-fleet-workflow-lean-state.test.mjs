import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    truncate,
    leanifyState,
    dedupeStrings,
    resolveStringRefs,
    buildListStatePayload,
    HEAVY_FIELD_NAMES,
    DEFAULT_SUMMARY_MAX_CHARS
} from '../src/viewer/lean-state.mjs';

// apra-fleet-eft.27.1: lean list-state /state endpoint.
//
// Regression context (apra-fleet-eft.27): a real 449-activity sprint's
// GET /state measured a 116 MB payload (85 MB pure duplication -- the same
// bead descriptions and command outputs re-embedded by every `bd` command
// activity). These tests pin the shape and size contract the fix must hold:
// heavy fields never survive into list state, and repeated strings are sent
// once with references.

function makeHeavyActivity(id, overrides = {}) {
    return {
        type: 'activity',
        id,
        data: {
            id,
            type: 'command',
            label: 'bd show ' + id,
            member: 'orchestrator',
            isRunning: false,
            success: true,
            duration: 120,
            // The exact shape the real bug reported: a long bead description
            // re-embedded verbatim in every command's output.
            output: 'BEAD DESCRIPTION: '.padEnd(250, 'x'),
            ...overrides
        }
    };
}

describe('truncate()', () => {
    test('passes short strings through unchanged', () => {
        assert.equal(truncate('hello', 10), 'hello');
    });

    test('cuts long strings and appends an ellipsis marker', () => {
        const long = 'a'.repeat(500);
        const out = truncate(long, 200);
        assert.equal(out.length, 203);
        assert.ok(out.endsWith('...'));
        assert.equal(out.slice(0, 200), 'a'.repeat(200));
    });

    test('non-string input passes through unchanged', () => {
        assert.equal(truncate(null, 10), null);
        assert.equal(truncate(undefined, 10), undefined);
        assert.equal(truncate(42, 10), 42);
    });
});

describe('leanifyState()', () => {
    test('merges every HEAVY_FIELD_NAMES field on an activity into a single short `summary`, deleting the originals', () => {
        const state = {
            status: 'running',
            tree: [{ title: 'g', phases: [{ title: 'p', events: [makeHeavyActivity('a1')] }] }],
            extensions: {}
        };
        const lean = leanifyState(state);
        const data = lean.tree[0].phases[0].events[0].data;
        for (const field of HEAVY_FIELD_NAMES) {
            assert.ok(!(field in data), `expected "${field}" to be removed from list state`);
        }
        assert.equal(typeof data.summary, 'string');
        assert.ok(data.summary.length <= DEFAULT_SUMMARY_MAX_CHARS + 3, 'summary must be capped, not the full blob');
        // Small, non-heavy identifying fields are preserved untouched.
        assert.equal(data.id, 'a1');
        assert.equal(data.type, 'command');
        assert.equal(data.label, 'bd show a1');
        assert.equal(data.success, true);
        assert.equal(data.duration, 120);
    });

    test('when both error and output are present, error wins the summary (most diagnostically useful)', () => {
        const state = {
            tree: [{ title: 'g', phases: [{ title: 'p', events: [makeHeavyActivity('a1', {
                error: 'THE REAL ERROR',
                output: 'noisy stdout noise'
            })] }] }],
            extensions: {}
        };
        const lean = leanifyState(state);
        const data = lean.tree[0].phases[0].events[0].data;
        assert.equal(data.summary, 'THE REAL ERROR');
    });

    test('never embeds a bead description anywhere in extensions -- generic across arbitrary nesting, not beads-specific field/namespace knowledge', () => {
        const bigDescription = 'D'.repeat(5000);
        const state = {
            tree: [],
            extensions: {
                beads: {
                    sprintTasks: [{ id: 't1', title: 'Task 1', status: 'open', description: bigDescription, updated_at: '2026-07-20T00:00:00Z' }],
                    backlogTasks: [{ id: 't2', title: 'Task 2', status: 'open', description: bigDescription }]
                }
            }
        };
        const lean = leanifyState(state);
        const json = JSON.stringify(lean);
        assert.ok(!json.includes(bigDescription), 'the full description string must never appear in list state');
        assert.ok(!('description' in lean.extensions.beads.sprintTasks[0]));
        assert.ok(!('description' in lean.extensions.beads.backlogTasks[0]));
        assert.equal(typeof lean.extensions.beads.sprintTasks[0].summary, 'string');
        // id/title/updatedAt (here updated_at, bd's own field name) survive --
        // eft.27.2's on-demand cache validation depends on this.
        assert.equal(lean.extensions.beads.sprintTasks[0].id, 't1');
        assert.equal(lean.extensions.beads.sprintTasks[0].title, 'Task 1');
        assert.equal(lean.extensions.beads.sprintTasks[0].updated_at, '2026-07-20T00:00:00Z');
    });

    test('generic safety net: caps ANY long string regardless of field name (e.g. a huge log message)', () => {
        const hugeMsg = 'M'.repeat(10000);
        const state = { tree: [{ title: 'g', phases: [{ title: 'p', events: [{ type: 'log', time: 1, msg: hugeMsg }] }] }], extensions: {} };
        const lean = leanifyState(state);
        const msg = lean.tree[0].phases[0].events[0].msg;
        assert.ok(msg.length < hugeMsg.length, 'an oversized log message must be capped even though "msg" is not a HEAVY_FIELD_NAMES entry');
    });

    test('non-heavy, already-short fields (member/model/label) pass through unchanged', () => {
        const state = { tree: [{ title: 'g', phases: [{ title: 'p', events: [makeHeavyActivity('a1', { model: 'standard' })] }] }], extensions: {} };
        const lean = leanifyState(state);
        const data = lean.tree[0].phases[0].events[0].data;
        assert.equal(data.member, 'orchestrator');
        assert.equal(data.model, 'standard');
    });

    test('top-level control fields (status, stats, sprintId) pass through untouched', () => {
        const state = { status: 'success', sprintId: 'abc-123', stats: { activitiesCount: 3, totalCost: 1.5 }, tree: [], extensions: {} };
        const lean = leanifyState(state);
        assert.equal(lean.status, 'success');
        assert.equal(lean.sprintId, 'abc-123');
        assert.deepEqual(lean.stats, { activitiesCount: 3, totalCost: 1.5 });
    });
});

describe('dedupeStrings() / resolveStringRefs()', () => {
    test('replaces a string repeated 2+ times with $ref markers into a shared table; leaves singletons inline', () => {
        const repeated = 'this exact string repeats many times';
        const unique = 'this one appears only once, ever';
        const value = { a: repeated, b: { c: repeated, d: [repeated] }, e: unique };
        const { value: deduped, table } = dedupeStrings(value, { minLength: 5 });

        assert.equal(table.length, 1, 'the repeated string must appear exactly once in the table');
        assert.equal(table[0], repeated);
        assert.deepEqual(deduped.a, { $ref: 0 });
        assert.deepEqual(deduped.b.c, { $ref: 0 });
        assert.deepEqual(deduped.b.d[0], { $ref: 0 });
        assert.equal(deduped.e, unique, 'a string that only appears once stays inline, not referenced');
    });

    test('strings shorter than minLength are never referenced even when repeated', () => {
        const value = { a: 'hi', b: 'hi', c: 'hi' };
        const { value: deduped, table } = dedupeStrings(value, { minLength: 10 });
        assert.equal(table.length, 0);
        assert.deepEqual(deduped, { a: 'hi', b: 'hi', c: 'hi' });
    });

    test('resolveStringRefs() is the exact inverse of dedupeStrings()', () => {
        const original = {
            tree: [{ label: 'same label', out: 'same label' }, { label: 'same label', out: 'different' }]
        };
        const { value: deduped, table } = dedupeStrings(original, { minLength: 5 });
        const resolved = resolveStringRefs(deduped, table);
        assert.deepEqual(resolved, original);
    });

    test('resolveStringRefs() is a safe no-op pass-through on data with no $ref markers (e.g. a frozen History-view state)', () => {
        const plain = { workflowName: 'x', status: 'success', tree: [{ a: 1, b: 'text' }] };
        assert.deepEqual(resolveStringRefs(plain, []), plain);
    });
});

describe('buildListStatePayload() -- end-to-end shape and size contract', () => {
    function buildFixtureState(activityCount) {
        const bigOutput = 'OUT:' + 'x'.repeat(2000);
        const bigDescription = 'DESC:' + 'y'.repeat(2000);
        const events = [];
        for (let i = 0; i < activityCount; i++) {
            events.push(makeHeavyActivity(`act-${i}`, { output: bigOutput, label: `bd show bead-${i % 5}` }));
        }
        return {
            workflowName: 'Fixture Sprint',
            status: 'running',
            sprintId: 'fixture-sprint-1',
            stats: { activitiesCount: activityCount, totalTokens: 1000, totalCost: 1.23, startTime: Date.now(), durationMs: 0 },
            tree: [{ title: 'Workflow', phases: [{ title: 'Work', events }] }],
            extensions: {
                beads: {
                    sprintTasks: Array.from({ length: 20 }, (_, i) => ({
                        id: `bead-${i}`, title: `Bead ${i}`, status: 'open', description: bigDescription, updated_at: '2026-07-20T00:00:00Z'
                    })),
                    backlogTasks: []
                }
            }
        };
    }

    test('a 500+ activity fixture stays under 1 MB (real regression measured 116 MB)', () => {
        const state = buildFixtureState(500);
        const payload = buildListStatePayload(state);
        const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf-8');
        assert.ok(bytes < 1024 * 1024, `expected payload under 1 MB, got ${bytes} bytes`);
    });

    test('no description/transcript-family field survives anywhere in the payload', () => {
        const state = buildFixtureState(50);
        const payload = buildListStatePayload(state);
        const json = JSON.stringify(payload);
        for (const field of HEAVY_FIELD_NAMES) {
            assert.ok(!json.includes(`"${field}":`), `expected no "${field}" key anywhere in list state, found one`);
        }
    });

    test('carries a `_strings` dedup table when strings repeat', () => {
        const state = buildFixtureState(50);
        const payload = buildListStatePayload(state);
        assert.ok(Array.isArray(payload._strings));
        assert.ok(payload._strings.length > 0, 'the repeated bead-title labels across activities must have produced at least one shared table entry');
    });

    test('the payload round-trips through resolveStringRefs() back to a plain, dereferenced object', () => {
        const state = buildFixtureState(30);
        const payload = buildListStatePayload(state);
        const resolved = resolveStringRefs(payload, payload._strings);
        assert.equal(resolved.tree[0].phases[0].events[0].data.id, 'act-0');
        assert.equal(typeof resolved.tree[0].phases[0].events[0].data.summary, 'string');
    });

    test('is a pure function: never mutates the input state object', () => {
        const state = buildFixtureState(5);
        const before = JSON.stringify(state);
        buildListStatePayload(state);
        assert.equal(JSON.stringify(state), before, 'the source state object must be unchanged after building list state');
    });
});
