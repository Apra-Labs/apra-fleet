import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    countPremiumCap, premiumAllowance, runPremiumCapGate, buildPremiumCapDecision, capPctToFit,
    MAX_PREMIUM_CAP_REPLANS,
} from '../fleet-sprint/tier-cap.mjs';
import { resolveTierPolicy } from '../fleet-sprint/tier-policy.mjs';
import { buildPlannerPrompt, buildPlanReviewerPrompt } from '../fleet-sprint/prompts.mjs';

// =============================================================================
// The premium-cap gate (fleet-sprint/tier-cap.mjs): pure counting, the
// bounded re-plan / decision flow over injected seams, and the cap text in
// the planner and plan-reviewer prompts. The end-to-end flow through the
// runner is in mock-sprint-premium-cap.test.mjs.
// =============================================================================

const task = (id, model, { metadata = {}, ...extra } = {}) => ({
    id, title: `Task ${id}`, issue_type: 'task', status: 'open', parent: 'epic',
    ...extra, metadata: { model, ...metadata },
});
const epic = { id: 'epic', title: 'Epic', issue_type: 'epic', status: 'open' };

function tenTasks(premiumCount) {
    const beads = [epic];
    for (let i = 0; i < 10; i++) beads.push(task('t' + i, i < premiumCount ? 'premium' : 'standard'));
    return beads;
}

// --- counting ---------------------------------------------------------------

test('count: 10 tasks with 2 premium are within a 20% cap', () => {
    const c = countPremiumCap(tenTasks(2), 20);
    assert.equal(c.total, 10);
    assert.equal(c.allowed, 2);
    assert.deepEqual(c.premiumIds, ['t0', 't1']);
    assert.equal(c.over, false);
    assert.equal(c.mustMove, 0);
});

test('count: 10 tasks with 3 premium are over a 20% cap and name exactly those 3 beads', () => {
    const c = countPremiumCap(tenTasks(3), 20);
    assert.equal(c.over, true);
    assert.deepEqual(c.premiumIds, ['t0', 't1', 't2']);
    assert.equal(c.mustMove, 1);
});

test('count: escalated beads and [test] beads riding an impl lane are excluded; a lone [test] bead is counted', () => {
    const beads = tenTasks(2);
    // Escalated: premium because the engine escalated it, not the planner.
    beads.push(task('esc', 'premium', { metadata: { tierEscalatedFrom: 'standard' } }));
    // Impl + riding [test] on the same streak, both premium.
    beads.push(task('impl', 'premium', { metadata: { streak: 'lane-x' } }));
    beads.push(task('ride', 'premium', { title: '[test] covers impl', metadata: { streak: 'lane-x' } }));
    // A [test] bead on a streak with no impl bead is its own tier choice.
    beads.push(task('lone', 'standard', { title: '[test] lone', metadata: { streak: 'lane-y' } }));
    const c = countPremiumCap(beads, 20);
    assert.deepEqual(c.excludedEscalated, ['esc']);
    assert.deepEqual(c.excludedRidingTests, ['ride']);
    assert.deepEqual(c.premiumIds, ['impl', 't0', 't1']);
    assert.equal(c.total, 12, '10 + impl + lone');
    assert.equal(c.allowed, 2);
    assert.equal(c.over, true);
});

test('count: closed tasks count (the count persists across re-plans); containers, non-task, deferred and decision beads do not', () => {
    const beads = [
        epic,
        task('closedP', 'premium', { status: 'closed' }),
        task('open1', 'standard'),
        task('container', 'premium'),
        task('child', 'standard', { parent: 'container' }),
        task('deferredP', 'premium', { status: 'deferred' }),
        { id: 'dec', title: 'Decision needed for x', issue_type: 'decision', status: 'deferred', metadata: { model: 'premium' } },
        { id: 'feat', title: 'Feature', issue_type: 'feature', status: 'open', metadata: { model: 'premium' } },
    ];
    const c = countPremiumCap(beads, 50);
    assert.deepEqual(c.premiumIds, ['closedP']);
    assert.equal(c.total, 3, 'closedP, open1, child');
});

test('count: -tier spellings normalize; rounding is floor and stated in integers', () => {
    const c = countPremiumCap([task('a', 'premium-tier'), task('b', 'standard'), task('c', 'standard'), task('d', 'standard')], 20);
    assert.deepEqual(c.premiumIds, ['a']);
    assert.equal(c.allowed, 0, 'floor(20% x 4) = 0: a small plan may hold no premium bead');
    assert.equal(c.over, true);
    assert.equal(premiumAllowance(20, 10), 2);
    assert.equal(premiumAllowance(20, 14), 2);
    assert.equal(premiumAllowance(20, 15), 3);
    assert.equal(premiumAllowance(10, 9), 0);
    assert.equal(premiumAllowance(0, 50), 0);
    assert.equal(premiumAllowance(100, 7), 7);
});

test('count: no cap (null) is never over', () => {
    const c = countPremiumCap(tenTasks(10), null);
    assert.equal(c.over, false);
    assert.equal(c.allowed, null);
});

test('decision: names every premium bead, the cap and the three fixes', () => {
    const c = countPremiumCap(tenTasks(3), 20);
    const d = buildPremiumCapDecision(c, { replans: 2 });
    assert.equal(d.beadId, 't0');
    for (const id of c.premiumIds) assert.ok(d.question.includes(id), `question names ${id}`);
    assert.ok(d.question.includes('cap 20%'), d.question);
    assert.deepEqual(d.options.map((o) => o.id), ['a', 'b', 'c']);
    assert.match(d.options[0].text, /^Accept/);
    assert.ok(d.options[1].text.includes('tierOverrides {"premiumCapPct": 30}'), d.options[1].text);
    assert.equal(capPctToFit(c), 30);
    assert.match(d.options[2].text, /--set-metadata model=standard/);
    assert.ok(d.recommendation.length > 0);
});

// --- the gate over injected seams ------------------------------------------

function gateSeams({ scopes, logs = [], calls = [] }) {
    let i = 0;
    return {
        logs, calls,
        listScope: async () => { calls.push('list'); return scopes[Math.min(i++, scopes.length - 1)]; },
        replan: async (req) => { calls.push({ replan: req.attempt, ids: req.count.premiumIds.slice(), mustMove: req.count.mustMove }); },
        raiseDecision: async (req) => { calls.push({ decision: req.decision }); return { decisionId: 'decision-1-t0', beadId: req.decision.beadId }; },
        awaitDecision: async () => { calls.push('await'); },
        log: (l) => logs.push(l),
    };
}

test('gate: an over-cap plan that never gets fixed runs exactly 2 scoped re-plans, then raises one decision and waits on it', async () => {
    const over = tenTasks(3);
    const s = gateSeams({ scopes: [over] });
    const sprintState = {};
    const out = await runPremiumCapGate({ policy: resolveTierPolicy('balanced'), sprintState, cycle: 1, ...s });
    assert.equal(out.status, 'decision');
    const replans = s.calls.filter((c) => c && c.replan);
    assert.equal(replans.length, MAX_PREMIUM_CAP_REPLANS);
    assert.equal(MAX_PREMIUM_CAP_REPLANS, 2);
    for (const r of replans) {
        assert.deepEqual(r.ids, ['t0', 't1', 't2']);
        assert.equal(r.mustMove, 1);
    }
    const decisionIdx = s.calls.findIndex((c) => c && c.decision);
    assert.ok(decisionIdx > s.calls.lastIndexOf(replans[1]), 'the decision follows the last re-plan');
    assert.equal(s.calls[decisionIdx + 1], 'await', 'the gate waits on the decision right after raising it');
    assert.deepEqual(sprintState.premiumCap, { replans: 2, decisionRaised: true, decisionId: 'decision-1-t0' });
    assert.ok(s.logs.some((l) => l.includes('t0, t1, t2') && l.includes('tierOverrides')), 'the decision log names the beads and the fix');

    // A later cycle, still over: no third re-plan, no second decision.
    const s2 = gateSeams({ scopes: [over] });
    const out2 = await runPremiumCapGate({ policy: resolveTierPolicy('balanced'), sprintState, cycle: 2, ...s2 });
    assert.equal(out2.status, 'already-raised');
    assert.equal(s2.calls.filter((c) => c && (c.replan || c.decision)).length, 0);
    assert.ok(s2.logs.some((l) => l.includes('t0, t1, t2') && l.includes('not raised twice')));
});

test('gate: the re-plan budget is per sprint -- a cycle 2 over-cap plan gets only the re-plan cycle 1 left', async () => {
    const sprintState = {};
    const within = tenTasks(2);
    const over = tenTasks(3);
    const s1 = gateSeams({ scopes: [over, within] });
    assert.equal((await runPremiumCapGate({ policy: resolveTierPolicy('balanced'), sprintState, cycle: 1, ...s1 })).status, 'within');
    assert.equal(sprintState.premiumCap.replans, 1);
    const s2 = gateSeams({ scopes: [over] });
    assert.equal((await runPremiumCapGate({ policy: resolveTierPolicy('balanced'), sprintState, cycle: 2, ...s2 })).status, 'decision');
    assert.equal(s2.calls.filter((c) => c && c.replan).length, 1);
    assert.equal(sprintState.premiumCap.replans, 2);
});

test('gate: a re-plan that fixes the cap lets Develop start with no decision', async () => {
    const s = gateSeams({ scopes: [tenTasks(3), tenTasks(2)] });
    const out = await runPremiumCapGate({ policy: resolveTierPolicy('balanced'), sprintState: {}, cycle: 1, ...s });
    assert.equal(out.status, 'within');
    assert.equal(s.calls.filter((c) => c && c.replan).length, 1);
    assert.equal(s.calls.filter((c) => c && c.decision).length, 0);
    assert.ok(!s.calls.includes('await'));
});

test('gate: quality (no cap) is a no-op -- no listing, no re-plan, no decision, no log line', async () => {
    const s = gateSeams({ scopes: [tenTasks(10)] });
    const sprintState = {};
    const out = await runPremiumCapGate({ policy: resolveTierPolicy('quality'), sprintState, cycle: 1, ...s });
    assert.equal(out.status, 'no-cap');
    assert.deepEqual(s.calls, []);
    assert.deepEqual(s.logs, []);
    assert.equal(sprintState.premiumCap, undefined);
});

test('gate: an overridden cap of null is also a no-op; economy uses its own 10% cap', async () => {
    const s = gateSeams({ scopes: [tenTasks(10)] });
    assert.equal((await runPremiumCapGate({ policy: resolveTierPolicy('balanced', { premiumCapPct: null }), sprintState: {}, cycle: 1, ...s })).status, 'no-cap');
    const e = gateSeams({ scopes: [tenTasks(2), tenTasks(1)] });
    const out = await runPremiumCapGate({ policy: resolveTierPolicy('economy'), sprintState: {}, cycle: 1, ...e });
    assert.equal(out.status, 'within');
    assert.equal(e.calls.filter((c) => c && c.replan).length, 1, '2 of 10 is over a 10% cap');
});

test('gate: the engine never writes a bead -- the count is read-only over the listed beads', async () => {
    const beads = tenTasks(3);
    const snapshot = JSON.stringify(beads);
    const s = gateSeams({ scopes: [beads] });
    await runPremiumCapGate({ policy: resolveTierPolicy('balanced'), sprintState: {}, cycle: 1, ...s });
    assert.equal(JSON.stringify(beads), snapshot);
});

// --- prompts ------------------------------------------------------------------

const basePlanner = { isDeltaCycle: false, targetIssues: ['epic'], goal: 'P1/P2', requirementsFile: undefined, requirementsContent: null, feedback: null };
const baseReviewer = { targetIssues: ['epic'], goal: 'P1/P2' };

test('prompts: planner and plan-reviewer carry the cap percentage under balanced and economy, and no cap under quality', () => {
    for (const [preset, pct] of [['balanced', 20], ['economy', 10]]) {
        const cap = resolveTierPolicy(preset).premiumCapPct;
        assert.equal(cap, pct);
        const p = buildPlannerPrompt({ ...basePlanner, premiumCapPct: cap });
        const r = buildPlanReviewerPrompt({ ...baseReviewer, premiumCapPct: cap });
        assert.ok(p.includes(`PREMIUM CAP -- this sprint's tier policy allows at most ${pct}% `), `planner (${preset})`);
        assert.ok(r.includes(`PREMIUM CAP -- this sprint's tier policy allows at most ${pct}% `), `plan-reviewer (${preset})`);
    }
    const q = resolveTierPolicy('quality').premiumCapPct;
    assert.equal(q, null);
    const p = buildPlannerPrompt({ ...basePlanner, premiumCapPct: q });
    const r = buildPlanReviewerPrompt({ ...baseReviewer, premiumCapPct: q });
    assert.ok(!/PREMIUM.CAP/.test(p) && !/premium cap/i.test(p), 'no cap text in the quality planner prompt');
    assert.ok(!/PREMIUM.CAP/.test(r) && !/premium cap/i.test(r), 'no cap text in the quality plan-reviewer prompt');
    assert.equal(p, buildPlannerPrompt(basePlanner), 'quality planner prompt is byte-identical to a no-policy prompt');
    assert.equal(r, buildPlanReviewerPrompt(baseReviewer), 'quality plan-reviewer prompt is byte-identical to a no-policy prompt');
});

test('prompts: the premium-cap re-plan names the premium beads and how many must move, without the defective-criteria framing', () => {
    const premiumCapReplan = { premiumIds: ['t0', 't1', 't2'], mustMove: 1, capPct: 20, allowed: 2, total: 10 };
    const p = buildPlannerPrompt({ ...basePlanner, isDeltaCycle: true, replanScope: ['t0', 't1', 't2'], premiumCapPct: 20, premiumCapReplan });
    assert.ok(p.startsWith('PREMIUM-CAP REPLAN'), p.slice(0, 80));
    assert.ok(p.includes('t0, t1, t2'));
    assert.ok(p.includes('Move at least 1 of them to a lower tier'));
    assert.ok(p.includes('at most 2 of 10'));
    assert.ok(!p.includes('DEFECTIVE ACCEPTANCE CRITERIA'));
    const r = buildPlanReviewerPrompt({ ...baseReviewer, replanScope: ['t0', 't1', 't2'], premiumCapPct: 20, premiumCapReplan });
    assert.ok(r.includes('PREMIUM-CAP REPLAN REVIEW'));
    assert.ok(r.includes('t0, t1, t2') && r.includes('at least 1'));
    assert.ok(!r.includes('SCOPED IN-CYCLE REPLAN REVIEW'));
});
