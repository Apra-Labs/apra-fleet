import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
    PRESETS,
    DEFAULT_TIER_POLICY,
    resolveTierPolicy,
    roleTier,
    roleTierTable,
    OVERRIDE_KEYS,
} from '../fleet-sprint/tier-policy.mjs';
import { policyFor } from '../fleet-sprint/role-policies.mjs';

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

describe('tierOverrides: per-role tiers, doerDefault, doerCeiling and premiumCapPct', () => {
    test('OVERRIDE_KEYS are every fixed role plus doerDefault, doerCeiling and premiumCapPct', () => {
        assert.deepStrictEqual([...OVERRIDE_KEYS].sort(), [
            'deployer', 'doerCeiling', 'doerDefault', 'final-review', 'harvester', 'integ-test-runner',
            'plan-reviewer', 'planner', 'premiumCapPct', 're-planner', 'regression-test-runner',
            'reviewer-round', 'streakAssignment',
        ]);
    });

    test('a role override pins that role and leaves the others at the preset tier', () => {
        const p = resolveTierPolicy('balanced', { planner: 'standard', harvester: 'cheap', 'final-review': 'standard' });
        assert.strictEqual(roleTier(p, 'planner'), 'standard');
        assert.strictEqual(roleTier(p, 'harvester'), 'cheap');
        assert.strictEqual(roleTier(p, 'final-review'), 'standard');
        assert.strictEqual(roleTier(p, 're-planner'), 'premium', 'the re-planner keeps its own key');
        assert.strictEqual(roleTier(p, 'plan-reviewer'), 'premium');
        const t = roleTierTable(p);
        assert.strictEqual(t.planner, 'standard');
        assert.strictEqual(t['re-planner'], 'premium');
        assert.strictEqual(t.reviewer, 'standard', 'the final review reads the reviewer key');
        assert.strictEqual(PRESETS.balanced.roleTiers.planner, 'premium', 'the preset is not mutated');
    });

    test('the re-planner has its own key: it follows the planner in every preset and can be pinned apart from it', () => {
        for (const name of ['balanced', 'economy', 'quality']) {
            const p = resolveTierPolicy(name);
            assert.strictEqual(roleTier(p, 're-planner'), roleTier(p, 'planner'), name);
        }
        const p = resolveTierPolicy('economy', { 're-planner': 'premium' });
        assert.strictEqual(roleTier(p, 'planner'), 'standard');
        assert.strictEqual(roleTierTable(p)['re-planner'], 'premium');
        assert.strictEqual(policyFor('scoped-replan-planner').model.key, 're-planner');
    });

    test('a pinned reviewer-round runs at that tier for every round, premium beads or not', () => {
        const p = resolveTierPolicy('balanced', { 'reviewer-round': 'standard' });
        assert.strictEqual(roleTier(p, 'reviewer-round', { hasPremiumOrEscalated: true }), 'standard');
        const q = resolveTierPolicy('balanced', { 'reviewer-round': 'premium' });
        assert.strictEqual(roleTier(q, 'reviewer-round', { hasPremiumOrEscalated: false }), 'premium');
    });

    test('doerDefault and doerCeiling: presets leave doerDefault unset and the ceiling at premium; overrides set them', () => {
        for (const name of ['balanced', 'economy', 'quality']) {
            assert.strictEqual(resolveTierPolicy(name).doerDefault, null);
            assert.strictEqual(resolveTierPolicy(name).doerCeiling, 'premium');
        }
        const p = resolveTierPolicy('balanced', { doerDefault: 'cheap', doerCeiling: 'standard' });
        assert.strictEqual(p.doerDefault, 'cheap');
        assert.strictEqual(p.doerCeiling, 'standard');
    });

    for (const [key, bad] of [['planner', 'opus'], ['re-planner', 5], ['reviewer-round', null], ['doerDefault', 'high'], ['doerCeiling', '']]) {
        test(`rejects ${key}=${JSON.stringify(bad)}, naming tierOverrides.${key} and the allowed tiers`, () => {
            assert.throws(() => resolveTierPolicy('balanced', { [key]: bad }), (err) => {
                assert.match(err.message, /^\[Arg Contract\]/);
                assert.ok(err.message.includes(`tierOverrides.${key}`), err.message);
                assert.ok(err.message.includes('cheap | standard | premium'), err.message);
                return true;
            });
        });
    }

    test('an unknown key error lists every allowed key', () => {
        assert.throws(() => resolveTierPolicy('balanced', { reviewer: 'standard' }), (err) => {
            for (const k of OVERRIDE_KEYS) assert.ok(err.message.includes(k), `names ${k}: ${err.message}`);
            return true;
        });
    });
});
