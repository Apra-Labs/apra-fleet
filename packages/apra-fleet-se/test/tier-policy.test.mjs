import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
    PRESETS,
    DEFAULT_TIER_POLICY,
    resolveTierPolicy,
    roleTier,
} from '../fleet-sprint/tier-policy.mjs';

// The tiers the engine requested for each fixed role before tier policies
// existed: runner.js's FIXED_ROLE_TIER literal at the base commit, re-typed
// here ON PURPOSE (not imported from the new code) so the quality-equivalence
// test cannot pass vacuously by comparing the module with itself. That
// literal had one 'reviewer' key, used for every reviewer round (with or
// without premium beads) and for the final review alike.
const PRE_POLICY_FIXED_ROLE_TIER = Object.freeze({
    planner: 'premium',
    'plan-reviewer': 'premium',
    reviewer: 'premium',
    deployer: 'standard',
    'integ-test-runner': 'standard',
    'regression-test-runner': 'standard',
    harvester: 'standard',
    streakAssignment: 'cheap',
});

describe('tier-policy presets', () => {
    test('the default preset is balanced, and resolveTierPolicy() with no preset resolves to it', () => {
        assert.strictEqual(DEFAULT_TIER_POLICY, 'balanced');
        const p = resolveTierPolicy();
        assert.strictEqual(p.name, 'balanced');
        assert.strictEqual(p.premiumCapPct, 20);
        assert.strictEqual(roleTier(p, 'reviewer-round', { hasPremiumOrEscalated: false }), 'standard');
    });

    test('premium caps: balanced 20, economy 10, quality none', () => {
        assert.strictEqual(PRESETS.balanced.premiumCapPct, 20);
        assert.strictEqual(PRESETS.economy.premiumCapPct, 10);
        assert.strictEqual(PRESETS.quality.premiumCapPct, null);
        assert.strictEqual(resolveTierPolicy('balanced').premiumCapPct, 20);
        assert.strictEqual(resolveTierPolicy('economy').premiumCapPct, 10);
        assert.strictEqual(resolveTierPolicy('quality').premiumCapPct, null);
    });

    test('planner is premium in balanced and standard in economy', () => {
        assert.strictEqual(roleTier(resolveTierPolicy('balanced'), 'planner'), 'premium');
        assert.strictEqual(roleTier(resolveTierPolicy('economy'), 'planner'), 'standard');
    });

    for (const name of ['balanced', 'economy', 'quality']) {
        test(`${name}: plan-reviewer and final review are premium`, () => {
            const p = resolveTierPolicy(name);
            assert.strictEqual(roleTier(p, 'plan-reviewer'), 'premium');
            assert.strictEqual(roleTier(p, 'final-review'), 'premium');
        });
    }

    test('resolved policies are frozen', () => {
        assert.ok(Object.isFrozen(resolveTierPolicy('balanced')));
        assert.ok(Object.isFrozen(resolveTierPolicy('balanced', { premiumCapPct: 5 })));
        assert.ok(Object.isFrozen(resolveTierPolicy('balanced').roleTiers));
    });
});

describe('quality reproduces the pre-policy tiers exactly', () => {
    // Every fixed role, with the context the engine dispatches it under, and
    // the pre-policy FIXED_ROLE_TIER key that priced it.
    const CASES = [
        { role: 'planner', key: 'planner' },
        { role: 'plan-reviewer', key: 'plan-reviewer' },
        { role: 'reviewer-round', ctx: { hasPremiumOrEscalated: false }, key: 'reviewer', label: 'reviewer round without premium beads' },
        { role: 'reviewer-round', ctx: { hasPremiumOrEscalated: true }, key: 'reviewer', label: 'reviewer round with a premium bead' },
        { role: 'final-review', key: 'reviewer' },
        { role: 'deployer', key: 'deployer' },
        { role: 'integ-test-runner', key: 'integ-test-runner' },
        { role: 'regression-test-runner', key: 'regression-test-runner' },
        { role: 'harvester', key: 'harvester' },
        { role: 'streakAssignment', key: 'streakAssignment' },
    ];
    const quality = resolveTierPolicy('quality');
    for (const c of CASES) {
        test(`${c.label || c.role} -> ${PRE_POLICY_FIXED_ROLE_TIER[c.key]}`, () => {
            assert.strictEqual(roleTier(quality, c.role, c.ctx), PRE_POLICY_FIXED_ROLE_TIER[c.key]);
        });
    }

    test('quality does not escalate', () => {
        assert.strictEqual(quality.escalation, false);
    });
});

describe('balanced reviewer round', () => {
    const balanced = resolveTierPolicy('balanced');
    test('standard when the round holds no premium or escalated bead', () => {
        assert.strictEqual(roleTier(balanced, 'reviewer-round', { hasPremiumOrEscalated: false }), 'standard');
        assert.strictEqual(roleTier(balanced, 'reviewer-round'), 'standard');
    });
    test('premium when the round holds a premium or escalated bead', () => {
        assert.strictEqual(roleTier(balanced, 'reviewer-round', { hasPremiumOrEscalated: true }), 'premium');
    });
});

describe('resolveTierPolicy validation', () => {
    function throwsNaming(fn, field) {
        assert.throws(fn, (err) => {
            assert.match(err.message, /^\[Arg Contract\]/);
            assert.ok(err.message.includes(field), `error must name ${field}: ${err.message}`);
            return true;
        });
    }

    test('rejects an unknown preset, naming tierPolicy and the allowed values', () => {
        throwsNaming(() => resolveTierPolicy('turbo'), 'tierPolicy');
        assert.throws(() => resolveTierPolicy('turbo'), /balanced \| economy \| quality/);
    });

    test('rejects an unknown override key, naming it', () => {
        throwsNaming(() => resolveTierPolicy('balanced', { premiumCap: 5 }), 'tierOverrides');
        throwsNaming(() => resolveTierPolicy('balanced', { premiumCap: 5 }), 'premiumCap"');
    });

    for (const bad of [-1, 101, 2.5]) {
        test(`rejects premiumCapPct ${bad}, naming the field`, () => {
            throwsNaming(() => resolveTierPolicy('balanced', { premiumCapPct: bad }), 'tierOverrides.premiumCapPct');
        });
    }

    test('accepts premiumCapPct 0..100 and null', () => {
        for (let v = 0; v <= 100; v++) {
            assert.strictEqual(resolveTierPolicy('balanced', { premiumCapPct: v }).premiumCapPct, v);
        }
        assert.strictEqual(resolveTierPolicy('economy', { premiumCapPct: null }).premiumCapPct, null);
    });

    test('an override does not mutate the preset', () => {
        resolveTierPolicy('balanced', { premiumCapPct: 3 });
        assert.strictEqual(PRESETS.balanced.premiumCapPct, 20);
    });
});
