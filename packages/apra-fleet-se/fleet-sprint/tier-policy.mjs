// =============================================================================
// TIER POLICY -- the single source of truth for which model tier
// ('cheap' | 'standard' | 'premium') each fixed-role dispatch requests, and
// the per-sprint premium cap that governs per-bead doer tiers.
//
// Pure: no I/O, no imports. Every value it returns is frozen.
//
// PRESETS
//   balanced (the default) -- premiumCapPct 20, planner premium, escalation
//            on; the per-round reviewer is premium only when the round holds
//            a premium or escalated bead, otherwise standard.
//   economy  -- premiumCapPct 10, planner standard, escalation on; same
//            reviewer-round rule as balanced.
//   quality  -- no cap, no escalation, and every fixed role requests exactly
//            the tier the engine requested before tier policies existed
//            (planner, plan-reviewer, every reviewer round and the final
//            review premium; deployer, integ-test-runner,
//            regression-test-runner and harvester standard; streak
//            assignment cheap). quality is the rollback preset: choosing it
//            reproduces the pre-policy engine. No deviation from that rule is
//            taken here.
//
// In every preset the plan-reviewer and the final review are premium,
// deployer/integ-test-runner/regression-test-runner/harvester are standard
// and streak assignment is cheap.
//
// OVERRIDES
//   resolveTierPolicy(preset, overrides) accepts only the keys in
//   OVERRIDE_KEYS. premiumCapPct is an integer 0..100 or null (no cap).
//   Anything else throws an [Arg Contract] error naming the field and the
//   allowed values.
// =============================================================================

export const TIERS = Object.freeze(['cheap', 'standard', 'premium']);

/** The preset a sprint runs under when its launch names none. */
export const DEFAULT_TIER_POLICY = 'balanced';

/**
 * The fixed roles roleTier() answers for. 'reviewer-round' is the per-round
 * code review (its tier may depend on the round's beads); 'final-review' is
 * the once-per-sprint final verdict. streakAssignment is the engine's own
 * bead-grouping call.
 */
export const FIXED_ROLES = Object.freeze([
    'planner',
    'plan-reviewer',
    'reviewer-round',
    'final-review',
    'deployer',
    'integ-test-runner',
    'regression-test-runner',
    'harvester',
    'streakAssignment',
]);

const SHARED_ROLE_TIERS = {
    'plan-reviewer': 'premium',
    'final-review': 'premium',
    deployer: 'standard',
    'integ-test-runner': 'standard',
    'regression-test-runner': 'standard',
    harvester: 'standard',
    streakAssignment: 'cheap',
};

function freezePreset(p) {
    return Object.freeze({ ...p, roleTiers: Object.freeze({ ...p.roleTiers }) });
}

/**
 * The three presets. reviewerRound is 'fixed' (always roleTiers
 * ['reviewer-round']) or 'by-round' (premium when the round holds a premium or
 * escalated bead, else roleTiers['reviewer-round']).
 */
export const PRESETS = Object.freeze({
    balanced: freezePreset({
        name: 'balanced',
        premiumCapPct: 20,
        escalation: true,
        reviewerRound: 'by-round',
        roleTiers: { ...SHARED_ROLE_TIERS, planner: 'premium', 'reviewer-round': 'standard' },
    }),
    economy: freezePreset({
        name: 'economy',
        premiumCapPct: 10,
        escalation: true,
        reviewerRound: 'by-round',
        roleTiers: { ...SHARED_ROLE_TIERS, planner: 'standard', 'reviewer-round': 'standard' },
    }),
    quality: freezePreset({
        name: 'quality',
        premiumCapPct: null,
        escalation: false,
        reviewerRound: 'fixed',
        roleTiers: { ...SHARED_ROLE_TIERS, planner: 'premium', 'reviewer-round': 'premium' },
    }),
});

/** The override keys resolveTierPolicy() accepts. */
export const OVERRIDE_KEYS = Object.freeze(['premiumCapPct']);

function argContract(field, allowed, got) {
    let shown;
    try { shown = JSON.stringify(got); } catch { shown = String(got); }
    return new Error(`[Arg Contract] Invalid ${field}: ${shown === undefined ? 'undefined' : shown}. Allowed: ${allowed}.`);
}

/**
 * Validate a preset name plus overrides and return the frozen resolved policy.
 * preset undefined/null means DEFAULT_TIER_POLICY.
 *
 * @param {string} [preset]
 * @param {{premiumCapPct?: number|null}} [overrides]
 * @returns {Readonly<{name: string, premiumCapPct: number|null, escalation: boolean,
 *   reviewerRound: 'fixed'|'by-round', roleTiers: Readonly<Record<string,string>>}>}
 */
export function resolveTierPolicy(preset, overrides) {
    const name = preset === undefined || preset === null ? DEFAULT_TIER_POLICY : preset;
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(PRESETS, name)) {
        throw argContract('tierPolicy', Object.keys(PRESETS).join(' | '), name);
    }
    const base = PRESETS[name];
    if (overrides === undefined || overrides === null) return base;
    if (typeof overrides !== 'object' || Array.isArray(overrides)) {
        throw argContract('tierOverrides', `an object with keys ${OVERRIDE_KEYS.join(', ')}`, overrides);
    }
    for (const key of Object.keys(overrides)) {
        if (!OVERRIDE_KEYS.includes(key)) {
            throw new Error(`[Arg Contract] Invalid tierOverrides: unknown key "${key}". Allowed keys: ${OVERRIDE_KEYS.join(', ')}.`);
        }
    }
    const resolved = { ...base };
    if (Object.prototype.hasOwnProperty.call(overrides, 'premiumCapPct')) {
        const v = overrides.premiumCapPct;
        if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= 100)) {
            throw argContract('tierOverrides.premiumCapPct', 'an integer 0..100, or null for no cap', v);
        }
        resolved.premiumCapPct = v;
    }
    return Object.freeze(resolved);
}

/**
 * Parse a tier-overrides value given as an object or a JSON string. Returns
 * undefined for undefined/null/empty string. Anything unparseable throws an
 * [Arg Contract] error naming tierOverrides.
 *
 * @param {unknown} raw
 * @returns {object|undefined}
 */
export function parseTierOverrides(raw) {
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); }
    catch { throw argContract('tierOverrides', `a JSON object with keys ${OVERRIDE_KEYS.join(', ')}`, raw); }
}

/**
 * The policy a run holds for its whole life. The first call on a run context
 * stores the policy resolved from the launch args; every later call (a runner
 * resume rebuilt over the same context) returns the stored one, never one
 * re-derived from the current default or args.
 *
 * @param {object} context the run context
 * @param {ReturnType<typeof resolveTierPolicy>} resolved the launch policy
 */
export function holdTierPolicy(context, resolved) {
    return (context.tierPolicy ??= resolved);
}

/**
 * Whether the engine runs exactly as before tier policies existed: true for
 * the quality preset, and for a caller that holds no policy at all (a direct
 * phase-module caller). Every tier-policy behaviour change outside the fixed
 * role table (single-tier lanes, escalation) is gated on this being false.
 *
 * @param {ReturnType<typeof resolveTierPolicy>|null|undefined} policy
 * @returns {boolean}
 */
export function reproducesPrePolicyTiers(policy) {
    return !policy || policy.name === 'quality';
}

/** One-line description of a resolved policy for the startup log. */
export function describeTierPolicy(policy, overrides) {
    const cap = policy.premiumCapPct === null ? 'none' : `${policy.premiumCapPct}%`;
    const ov = overrides === undefined || overrides === null ? 'none' : JSON.stringify(overrides);
    return `[tier-policy] effective policy: preset=${policy.name}, premiumCap=${cap}, overrides=${ov}`;
}

/**
 * The tier a fixed-role dispatch requests under `policy`.
 *
 * @param {ReturnType<typeof resolveTierPolicy>} policy
 * @param {string} role one of FIXED_ROLES
 * @param {{hasPremiumOrEscalated?: boolean}} [context] reviewer-round only:
 *   whether the round holds a premium or escalated bead.
 * @returns {'cheap'|'standard'|'premium'}
 */
export function roleTier(policy, role, context = {}) {
    if (!policy || typeof policy !== 'object' || !policy.roleTiers) {
        throw new Error('[Arg Contract] Invalid policy: expected a policy returned by resolveTierPolicy().');
    }
    if (!FIXED_ROLES.includes(role)) {
        throw argContract('role', FIXED_ROLES.join(' | '), role);
    }
    if (role === 'reviewer-round' && policy.reviewerRound === 'by-round' && context && context.hasPremiumOrEscalated) {
        return 'premium';
    }
    return policy.roleTiers[role];
}

/**
 * The per-run FIXED_ROLE_TIER-shaped table for any policy (the dispatch
 * context's fixedRoleTier). Its one 'reviewer' key is the final review's tier;
 * a per-round review whose tier varies by round (reviewerRound 'by-round')
 * passes its round tier, roleTier(policy, 'reviewer-round', ...), with the
 * dispatch instead. For quality it equals fixedRoleTierTable(policy).
 */
export function roleTierTable(policy) {
    return Object.freeze({
        planner: roleTier(policy, 'planner'),
        'plan-reviewer': roleTier(policy, 'plan-reviewer'),
        reviewer: roleTier(policy, 'final-review'),
        deployer: roleTier(policy, 'deployer'),
        'integ-test-runner': roleTier(policy, 'integ-test-runner'),
        'regression-test-runner': roleTier(policy, 'regression-test-runner'),
        harvester: roleTier(policy, 'harvester'),
        streakAssignment: roleTier(policy, 'streakAssignment'),
    });
}

/**
 * The runner's FIXED_ROLE_TIER-shaped table (keyed by the role-policy model
 * keys: one 'reviewer' key covers both the reviewer round and the final
 * review) for a policy whose reviewer tier does not vary by round. Used by
 * the runner with the quality preset, which reproduces the pre-policy tiers.
 */
export function fixedRoleTierTable(policy) {
    if (policy.reviewerRound !== 'fixed' || roleTier(policy, 'reviewer-round') !== roleTier(policy, 'final-review')) {
        throw new Error(`[Arg Contract] Invalid policy: fixedRoleTierTable needs one reviewer tier for every round; ${policy.name} varies it.`);
    }
    return Object.freeze({
        planner: roleTier(policy, 'planner'),
        'plan-reviewer': roleTier(policy, 'plan-reviewer'),
        reviewer: roleTier(policy, 'final-review'),
        deployer: roleTier(policy, 'deployer'),
        'integ-test-runner': roleTier(policy, 'integ-test-runner'),
        'regression-test-runner': roleTier(policy, 'regression-test-runner'),
        harvester: roleTier(policy, 'harvester'),
        streakAssignment: roleTier(policy, 'streakAssignment'),
    });
}
