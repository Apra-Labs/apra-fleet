import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, MOCK_BRANCH_TIPS } from './helpers/mock-sprint-harness.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';
import {
    planEscalations, isVerifyFailureOutcome, holdTierEscalations, effectiveBeadTier,
    roundHasPremiumOrEscalated, escalatedTier, ESCALATION_REASONS,
} from '../fleet-sprint/tier-escalation.mjs';
import { resolveTierPolicy, roleTier, roleTierTable, fixedRoleTierTable } from '../fleet-sprint/tier-policy.mjs';
import { FIXED_ROLE_TIER } from '../fleet-sprint/runner.js';

// =============================================================================
// One-step tier escalation (fleet-sprint/tier-escalation.mjs, wired in
// phases/review.mjs and phases/develop.mjs) and policy-driven role tiers
// (tier-policy.mjs roleTierTable / roleTier 'reviewer-round').
//
// balanced unless stated: a reviewer reopen or a verify failure redoes the
// bead one tier up, once per bead per sprint, recorded on the bead as
// tierEscalatedFrom; dispatch failures never escalate. The reviewer round is
// premium only when it holds a premium or escalated bead; final review and
// plan-reviewer are premium; the planner is premium in balanced and standard
// in economy. quality never escalates and reviews every round at premium.
// =============================================================================

const resetSyncMemo = () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
};
const report = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });
const approveVerdict = () => report({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] });
const assignedIds = (prompt) => {
    const match = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const closeAll = async ({ opts, runCmd: rc, tempDir: td }) => {
    const ids = assignedIds(opts.prompt);
    for (const id of ids) await rc(`bd close ${id}`, td);
    return report({ status: 'VERIFY', closedIds: ids, notes: 'Done.' });
};
const doerModels = (scenario) => scenario.dispatched.filter((d) => d.agent === 'doer').map((d) => d.model);
const roundReviews = (scenario) => scenario.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
const finalReview = (scenario) => scenario.dispatched.find((d) => d.agent === 'reviewer' && d.label === 'Final Review');

/** A one-bead sprint whose bead declares `model`, driven by the given handlers. */
async function oneBead(tag, title, model, handlers, { tierPolicy, onWorkflow } = {}) {
    const seen = { id: null };
    const scenario = await runDevelopLoopScenario(tag, {
        members: ['local'],
        taskSpecs: [{ title }],
        ...(tierPolicy ? { tierPolicy } : {}),
        ...(onWorkflow ? { onWorkflow } : {}),
        beforeSprint: async ({ runCmd: rc, tempDir: td, tasks }) => {
            seen.id = tasks[0].id;
            await rc(`bd update ${seen.id} --set-metadata streak=lane-1 --set-metadata streakOrder=1 --set-metadata model=${model}`, td);
        },
        ...(typeof handlers === 'function' ? handlers(seen) : handlers),
    });
    assert.equal(scenario.error, null, `the run completes: ${scenario.error && scenario.error.message}`);
    return { scenario, id: seen.id, bead: scenario.finalBeadsById.get(seen.id) };
}

/** A reviewer that reopens the scenario's bead (seen.id) `times` times, then approves. */
function reopeningReviewer(times, seen) {
    let reviews = 0;
    return async () => {
        reviews += 1;
        const id = seen.id;
        if (reviews <= times) {
            return report({ verdict: 'CHANGES_NEEDED', notes: `Redo ${id}: criteria not met.`, reopenIds: [id], newTasks: [] });
        }
        return approveVerdict();
    };
}

// --- unit --------------------------------------------------------------------

const bead = (id, model, extra = {}) => ({ id, title: `[impl] ${id}`, metadata: { model, ...extra } });

test('unit: one step up, premium stays premium, and only once per bead', () => {
    assert.equal(escalatedTier('cheap'), 'standard');
    assert.equal(escalatedTier('standard'), 'premium');
    assert.equal(escalatedTier('premium'), 'premium');
    const policy = resolveTierPolicy('balanced');
    const escalations = new Map();
    const first = planEscalations({ beads: [bead('a', 'cheap'), bead('p', 'premium')], policy, escalations, reason: ESCALATION_REASONS.REOPEN });
    assert.deepEqual(first.escalate, [{ id: 'a', from: 'cheap', to: 'standard', reason: ESCALATION_REASONS.REOPEN }]);
    assert.ok(first.skipped.some((s) => s.id === 'p' && s.why.includes('premium stays premium')));
    escalations.set('a', { from: 'cheap', to: 'standard', reason: ESCALATION_REASONS.REOPEN });
    const second = planEscalations({ beads: [bead('a', 'cheap')], policy, escalations, reason: ESCALATION_REASONS.REOPEN });
    assert.deepEqual(second.escalate, [], 'a second reopen does not escalate again');
    assert.equal(effectiveBeadTier(bead('a', 'cheap'), escalations), 'standard');
});

test('unit: tierOverrides.doerCeiling stops escalation at the ceiling (tier.escalation_at_ceiling); cheap still rises to it', () => {
    const policy = resolveTierPolicy('balanced', { doerCeiling: 'standard' });
    const out = planEscalations({
        beads: [bead('s', 'standard'), bead('c', 'cheap'), bead('p', 'premium')],
        policy, escalations: new Map(), reason: ESCALATION_REASONS.REOPEN,
    });
    assert.deepEqual(out.escalate, [{ id: 'c', from: 'cheap', to: 'standard', reason: ESCALATION_REASONS.REOPEN }]);
    const s = out.skipped.find((x) => x.id === 's');
    assert.ok(s && s.why.includes('doer ceiling standard') && s.why.includes('tier.escalation_at_ceiling'), JSON.stringify(out.skipped));
    assert.ok(out.skipped.some((x) => x.id === 'p' && x.why.includes('tier.escalation_at_ceiling')));
    // A cheap ceiling stops every escalation.
    const none = planEscalations({ beads: [bead('c', 'cheap')], policy: resolveTierPolicy('balanced', { doerCeiling: 'cheap' }), escalations: new Map(), reason: ESCALATION_REASONS.REOPEN });
    assert.deepEqual(none.escalate, []);
});

test('unit: a runner resume does not escalate again -- the run context holds the escalations, and a bead carrying tierEscalatedFrom is never escalated twice', () => {
    const context = {};
    const held = holdTierEscalations(context);
    held.set('a', { from: 'cheap', to: 'standard', reason: ESCALATION_REASONS.REOPEN });
    assert.equal(holdTierEscalations(context), held, 'a resume over the same context reads the same escalations');
    // A fresh run state (nothing held) still reads the bead record.
    const recorded = bead('a', 'cheap', { tierEscalatedFrom: 'cheap' });
    const policy = resolveTierPolicy('balanced');
    assert.deepEqual(planEscalations({ beads: [recorded], policy, escalations: new Map(), reason: ESCALATION_REASONS.REOPEN }).escalate, []);
    assert.equal(effectiveBeadTier(recorded, new Map()), 'standard', 'the recorded escalation keeps its tier');
});

test('unit: only a verify failure escalates -- usage-limit, empty_response, inactivity, sync failure, BLOCKED and NEEDS-DECISION outcomes never do', () => {
    assert.equal(isVerifyFailureOutcome({ outcome: 'failed', failureReason: 'left-open', unclosedIds: ['a'] }), true);
    const never = [
        { outcome: 'failed', failureReason: 'usage_limit', error: 'usage limit reached' },
        { outcome: 'failed', failureReason: 'empty_response', error: 'empty result' },
        { outcome: 'failed', failureReason: 'dispatch_failed', error: 'killed after inactivity timeout' },
        { outcome: 'failed', failureReason: 'dispatch-error', error: 'push failed', postDispatchSyncFailed: true },
        { outcome: 'failed', failureReason: 'left-open', error: 'post-dispatch sync failed', postDispatchSyncFailed: true },
        { outcome: 'failed', failureReason: 'blocked' },
        { outcome: 'failed', failureReason: 'needs-decision' },
        { outcome: 'success' },
    ];
    for (const o of never) assert.equal(isVerifyFailureOutcome(o), false, JSON.stringify(o));
});

test('unit: quality never escalates; role tiers follow the policy', () => {
    const quality = resolveTierPolicy('quality');
    assert.deepEqual(planEscalations({ beads: [bead('a', 'cheap')], policy: quality, escalations: new Map(), reason: ESCALATION_REASONS.REOPEN }).escalate, []);
    assert.deepEqual(roleTierTable(quality), FIXED_ROLE_TIER, 'quality reproduces the fixed pre-policy table');
    assert.deepEqual(roleTierTable(quality), fixedRoleTierTable(quality));
    const balanced = resolveTierPolicy('balanced');
    const economy = resolveTierPolicy('economy');
    assert.equal(roleTierTable(balanced).planner, 'premium');
    assert.equal(roleTierTable(economy).planner, 'standard');
    for (const p of [balanced, economy, quality]) {
        assert.equal(roleTierTable(p).reviewer, 'premium', `${p.name}: final review premium`);
        assert.equal(roleTierTable(p)['plan-reviewer'], 'premium', `${p.name}: plan-reviewer premium`);
    }
    const esc = new Map();
    const tierFor = (p, beads) => roleTier(p, 'reviewer-round', { hasPremiumOrEscalated: roundHasPremiumOrEscalated(beads, esc) });
    assert.equal(tierFor(balanced, [bead('s1', 'standard'), bead('s2', 'standard')]), 'standard');
    assert.equal(tierFor(balanced, [bead('s1', 'standard'), bead('p1', 'premium')]), 'premium');
    assert.equal(tierFor(balanced, [bead('e1', 'cheap', { tierEscalatedFrom: 'cheap' })]), 'premium');
    assert.equal(tierFor(quality, [bead('s1', 'standard')]), 'premium');
});

// --- mock sprints ------------------------------------------------------------

test('mock sprint (balanced): a reopened cheap bead is redone at standard, carries tierEscalatedFrom=cheap, and a second reopen does not escalate again', async () => {
    resetSyncMemo();
    await withScenarioMarkers('tier escalation reopen', async () => {
        const { scenario, id, bead: final } = await oneBead('tesc-reopen', '[impl] esc reopen cheap', 'cheap', (seen) => ({
            doerHandler: closeAll,
            reviewerHandler: reopeningReviewer(2, seen),
        }));
        assert.deepEqual(doerModels(scenario), ['cheap', 'standard', 'standard']);
        assert.equal(final.status, 'closed');
        assert.equal(final.metadata.tierEscalatedFrom, 'cheap');
        assert.equal(final.metadata.model, 'cheap', "the planner's tier stays on the bead");
        assert.equal(scenario.logs.filter((l) => l.includes(`[tier-escalation] bead ${id} escalated cheap -> standard`)).length, 1);
        assert.ok(scenario.logs.some((l) => l.includes(`bead ${id} not escalated`) && l.includes('no second escalation')));
        // Reviewer rounds: the cheap round is standard, the escalated rounds premium.
        assert.deepEqual(roundReviews(scenario).map((d) => d.model), ['standard', 'premium', 'premium']);
        // Planner and plan-reviewer premium in balanced; final review premium.
        for (const d of scenario.dispatched.filter((x) => x.agent === 'planner' || x.agent === 'plan-reviewer')) {
            assert.equal(d.model, 'premium', `${d.agent} premium in balanced`);
        }
        assert.equal(finalReview(scenario).model, 'premium');
    });
});

test('mock sprint (balanced): a real verify failure on a standard bead is redone at premium', async () => {
    resetSyncMemo();
    await withScenarioMarkers('tier escalation verify failure', async () => {
        let calls = 0;
        const { scenario, id, bead: final } = await oneBead('tesc-verify', '[impl] esc verify standard', 'standard', {
            doerHandler: async (ctx) => {
                calls += 1;
                if (calls === 1) {
                    // The doer committed work but its verification failed: the bead stays open.
                    MOCK_BRANCH_TIPS.set(ctx.opts.member_name || '(none)', 'b'.repeat(40));
                    return report({ status: 'VERIFY', closedIds: [], notes: 'tests still failing' });
                }
                return closeAll(ctx);
            },
            reviewerHandler: async () => approveVerdict(),
        });
        MOCK_BRANCH_TIPS.clear();
        assert.deepEqual(doerModels(scenario), ['standard', 'premium']);
        assert.equal(final.metadata.tierEscalatedFrom, 'standard');
        assert.ok(scenario.logs.some((l) => l.includes(`[tier-escalation] bead ${id} escalated standard -> premium (verify failure)`)));
        // The round reviewing the escalated bead is premium.
        assert.deepEqual(roundReviews(scenario).map((d) => d.model), ['premium']);
    });
});

for (const [tag, label, failure] of [
    ['tesc-empty', 'empty_response', { content: [{ text: 'exited 0 but produced no parseable output (empty result)' }], structuredContent: { isError: true, reason: 'empty_response' } }],
    ['tesc-inactive', 'inactivity timeout', { content: [{ text: 'command killed after inactivity timeout (no output)' }], structuredContent: { isError: true, reason: 'dispatch_failed' } }],
]) {
    test(`mock sprint (balanced): a doer ${label} is redone at the original tier with no tierEscalatedFrom`, async () => {
        resetSyncMemo();
        await withScenarioMarkers(`tier escalation never on ${label}`, async () => {
            let currentPhase = '';
            const { scenario, bead: final } = await oneBead(tag, `[impl] esc infra ${label}`, 'cheap', {
                // Every doer dispatch of the first Develop round fails for an
                // infrastructure reason; the next round closes the bead.
                doerHandler: async (ctx) => (currentPhase === 'Develop C1 R1' ? failure : closeAll(ctx)),
                reviewerHandler: async () => approveVerdict(),
            }, { onWorkflow: (wf) => wf.on('phase', (title) => { currentPhase = title; }) });
            const models = doerModels(scenario);
            assert.ok(models.length >= 2, `the bead was redone: ${JSON.stringify(models)}`);
            assert.deepEqual([...new Set(models)], ['cheap'], 'every dispatch, the redo included, stays cheap');
            assert.equal(final.status, 'closed');
            assert.equal(final.metadata.tierEscalatedFrom, undefined);
            assert.ok(!scenario.logs.some((l) => l.includes('[tier-escalation]')), 'no escalation is logged');
        });
    });
}

test('mock sprint (economy): the planner requests standard; a standard-only reviewer round requests standard', async () => {
    resetSyncMemo();
    await withScenarioMarkers('tier escalation economy roles', async () => {
        const { scenario } = await oneBead('tesc-economy', '[impl] esc economy standard', 'standard', {
            doerHandler: closeAll,
            reviewerHandler: async () => approveVerdict(),
        }, { tierPolicy: 'economy' });
        const planners = scenario.dispatched.filter((d) => d.agent === 'planner');
        assert.ok(planners.length > 0);
        for (const d of planners) assert.equal(d.model, 'standard', 'planner standard in economy');
        for (const d of scenario.dispatched.filter((x) => x.agent === 'plan-reviewer')) assert.equal(d.model, 'premium');
        assert.deepEqual(roundReviews(scenario).map((d) => d.model), ['standard']);
        assert.equal(finalReview(scenario).model, 'premium');
    });
});

test('mock sprint (quality): a reopen does not escalate and every reviewer round is premium', async () => {
    resetSyncMemo();
    await withScenarioMarkers('tier escalation quality', async () => {
        const { scenario, bead: final } = await oneBead('tesc-quality', '[impl] esc quality cheap', 'cheap', (seen) => ({
            doerHandler: closeAll,
            reviewerHandler: reopeningReviewer(1, seen),
        }), { tierPolicy: 'quality' });
        assert.deepEqual(doerModels(scenario), ['cheap', 'cheap']);
        assert.equal(final.metadata.tierEscalatedFrom, undefined);
        assert.ok(!scenario.logs.some((l) => l.includes('[tier-escalation]')));
        assert.deepEqual(roundReviews(scenario).map((d) => d.model), ['premium', 'premium']);
        for (const d of scenario.dispatched.filter((x) => x.agent === 'planner')) assert.equal(d.model, 'premium');
    });
});
