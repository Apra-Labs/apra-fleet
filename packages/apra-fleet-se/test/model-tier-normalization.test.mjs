import { test, describe } from 'node:test';
import assert from 'node:assert';
import { normalizeTierToken } from '../auto-sprint/runner.js';

// Stabilization log Issue 29: bead model metadata written outside the
// planner pin (out-of-band injections, older sprints) kept using the
// '-tier'-suffixed tier names. Unnormalized, such a token reaches
// execute_prompt verbatim, misses the server's cheap/standard/premium tier
// map, and is treated as a LITERAL provider model name -- observed live as
// `claude --model standard-tier` -> provider 404, losing the whole doer
// streak. These tests pin the normalization contract: the three known
// aliases (any case, padded) map to the bare tier names; EVERYTHING else --
// explicit model ids especially -- passes through byte-identical.

describe('normalizeTierToken', () => {
    test('maps the three -tier aliases to bare tier names', () => {
        assert.strictEqual(normalizeTierToken('cheap-tier'), 'cheap');
        assert.strictEqual(normalizeTierToken('standard-tier'), 'standard');
        assert.strictEqual(normalizeTierToken('premium-tier'), 'premium');
    });

    test('bare tier names pass through unchanged', () => {
        assert.strictEqual(normalizeTierToken('cheap'), 'cheap');
        assert.strictEqual(normalizeTierToken('standard'), 'standard');
        assert.strictEqual(normalizeTierToken('premium'), 'premium');
    });

    test('containment: any casing/shape holding exactly one tier word normalizes', () => {
        assert.strictEqual(normalizeTierToken(' Standard-Tier '), 'standard');
        assert.strictEqual(normalizeTierToken('PREMIUM'), 'premium');
        assert.strictEqual(normalizeTierToken('  cheap  '), 'cheap');
        assert.strictEqual(normalizeTierToken('tier-standard'), 'standard');
        assert.strictEqual(normalizeTierToken('Standard (default)'), 'standard');
    });

    test('explicit model ids pass through byte-identical (deliberate passthrough)', () => {
        assert.strictEqual(normalizeTierToken('claude-sonnet-5'), 'claude-sonnet-5');
        assert.strictEqual(normalizeTierToken('claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001');
    });

    test('zero or multiple tier words pass through unchanged', () => {
        // no tier word at all
        assert.strictEqual(normalizeTierToken('turbo-tier'), 'turbo-tier');
        // ambiguous: two tier words -- never guess
        assert.strictEqual(normalizeTierToken('standard-or-premium'), 'standard-or-premium');
    });

    test('non-string values pass through unchanged', () => {
        assert.strictEqual(normalizeTierToken(undefined), undefined);
        assert.strictEqual(normalizeTierToken(null), null);
        assert.strictEqual(normalizeTierToken(3), 3);
    });
});
