// The doer report's optional `liveEvidenceIds` field: the structured way a
// doer names BLOCKED beads that need live integration evidence (see
// apra-pm/agents/doer.md and phases/develop.mjs applyLiveEvidenceMarker).
// Both the canonical schema (apra-pm/agents/schemas/doer-output.json, what
// validateVerdict('doerReport') compiles) and the hand-written fallback in
// contracts.mjs accept an array of strings and reject any other shape.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { validateVerdict, FALLBACK_SCHEMAS } from '../fleet-sprint/contracts.mjs';

const base = { status: 'BLOCKED', closedIds: [], notes: 'needs integration-phase evidence' };
const fallbackValidate = new Ajv({ strict: false }).compile(FALLBACK_SCHEMAS.doerReport);

const cases = [
    ['an array of ids', ['x-1', 'x-2'], true],
    ['an empty array', [], true],
    ['a bare string', 'x-1', false],
    ['an object', { id: 'x-1' }, false],
    ['a number entry', ['x-1', 7], false],
    ['an object entry', [{ id: 'x-1' }], false],
    ['null', null, false],
];

describe('doer report liveEvidenceIds shape', () => {
    test('omitting the field stays valid', () => {
        assert.equal(validateVerdict('doerReport', base).valid, true);
        assert.equal(fallbackValidate(base), true);
    });
    for (const [label, value, ok] of cases) {
        test(`${label} is ${ok ? 'accepted' : 'rejected'} (canonical and fallback schema)`, () => {
            const report = { ...base, liveEvidenceIds: value };
            const canonical = validateVerdict('doerReport', report);
            assert.equal(canonical.valid, ok, JSON.stringify(canonical.errors));
            if (!ok) assert.ok(canonical.errors.some((e) => String(e.instancePath).startsWith('/liveEvidenceIds')), JSON.stringify(canonical.errors));
            assert.equal(fallbackValidate(report), ok);
        });
    }
});
