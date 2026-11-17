import { test, describe } from 'node:test';
import assert from 'node:assert';

import { buildLaunchRequestBody } from '../src/supervisor/launch-form.mjs';

// apra-fleet-d3r.2: dedicated verification for apra-fleet-d3r.1 ("auto-
// generate a branch name in buildLaunchRequestBody when the field is
// blank"). supervisor-launch-form.test.mjs already covers this behaviour as
// part of its broader Launch Sprint form suite; this file is the bead's own
// standalone regression pin, focused specifically on the branch-generation
// contract -- including the collision-avoidance property (two generations
// for the same member must not reliably collide) that isn't asserted
// elsewhere.
const BRANCH_PATTERN = /^fleet-sprint\/[a-z0-9-]+-[a-z0-9]{3}$/;

const base = {
    selectedRoots: ['apra-fleet-eft.9'],
    members: ['alice'],
    goal: 'P1/P2',
    branch: 'feat/x',
    base: 'main',
};

describe('d3r: launch form branch auto-generation', () => {
    test('blank branch (\'\') + one member -> no error, generated branch matches the fleet-sprint/<member>-<xxx> pattern', () => {
        const result = buildLaunchRequestBody({ ...base, branch: '' });
        assert.equal(result.ok, true, result.error);
        assert.ok(BRANCH_PATTERN.test(result.body.branch), `expected ${result.body.branch} to match ${BRANCH_PATTERN}`);
        const suffix = result.body.branch.split('-').pop();
        assert.equal(suffix.length, 3, `suffix must be exactly 3 chars, got '${suffix}' in ${result.body.branch}`);
    });

    test('whitespace-only branch (\'   \') + one member -> no error, generated branch matches the same pattern', () => {
        const result = buildLaunchRequestBody({ ...base, branch: '   ' });
        assert.equal(result.ok, true, result.error);
        assert.ok(BRANCH_PATTERN.test(result.body.branch), `expected ${result.body.branch} to match ${BRANCH_PATTERN}`);
    });

    test('two generations for the same member produce different suffixes across a small sample (collision avoidance, non-flaky)', () => {
        const seen = new Set();
        const N = 20;
        for (let i = 0; i < N; i += 1) {
            const result = buildLaunchRequestBody({ ...base, branch: '' });
            assert.equal(result.ok, true, result.error);
            assert.ok(BRANCH_PATTERN.test(result.body.branch), result.body.branch);
            seen.add(result.body.branch);
        }
        // With a 3-char [a-z0-9] suffix (36^3 = 46656 possibilities), 20 draws
        // colliding down to a single value is vanishingly unlikely -- assert
        // more than one distinct branch name was generated across the
        // sample, rather than asserting every single draw is unique (which
        // would be flaky).
        assert.ok(seen.size > 1, `expected at least 2 distinct generated branch names across ${N} draws, got: ${JSON.stringify([...seen])}`);
    });

    test('an explicitly typed branch name is returned unchanged, never overridden by generation', () => {
        const result = buildLaunchRequestBody({ ...base, branch: 'feat/my-thing' });
        assert.equal(result.ok, true, result.error);
        assert.equal(result.body.branch, 'feat/my-thing');
    });

    test('blank branch + no members selected still returns the existing validation error, not a generated branch', () => {
        const result = buildLaunchRequestBody({ ...base, branch: '', members: [] });
        assert.equal(result.ok, false);
        assert.ok(/member/i.test(result.error), result.error);
    });

    test('blank branch + a members array containing only empty strings still returns the member error (filtered to nothing usable)', () => {
        const result = buildLaunchRequestBody({ ...base, branch: '', members: ['', ''] });
        assert.equal(result.ok, false);
        assert.ok(/member/i.test(result.error), result.error);
    });
});
