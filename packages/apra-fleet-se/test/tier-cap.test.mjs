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

test('count: an escalated bead stays in the total but is never premium; [test] beads riding an impl lane are excluded; a lone [test] bead is counted', () => {
    const beads = tenTasks(3);
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
    assert.deepEqual(c.premiumIds, ['impl', 't0', 't1', 't2']);
    assert.equal(c.total, 13, '10 + esc + impl + lone: the escalated bead stays in the denominator');
    assert.equal(c.allowed, 3, 'ceil(20% x 13)');
    assert.equal(c.over, true);
    assert.equal(c.mustMove, 1);
});

test('count: an escalation never shrinks the allowance -- 6 tasks, 2 premium, 20% cap stay within after one standard bead escalates', () => {
    const beads = [epic];
    for (let i = 0; i < 6; i++) beads.push(task('s' + i, i < 2 ? 'premium' : 'standard'));
    const before = countPremiumCap(beads, 20);
    assert.equal(before.allowed, 2);
    assert.equal(before.over, false);
    // The engine escalates s2 (standard -> premium): it records tierEscalatedFrom.
    beads[3] = task('s2', 'standard', { metadata: { tierEscalatedFrom: 'standard' } });
    const after = countPremiumCap(beads, 20);
    assert.equal(after.total, 6, 'the escalated bead is still counted in the total');
    assert.equal(after.allowed, 2, 'ceil(20% x 6): the allowance is unchanged');
    assert.deepEqual(after.premiumIds, ['s0', 's1']);
    assert.equal(after.over, false);
    // Even an escalated bead whose model metadata now reads premium is not the planner's premium.
    beads[3] = task('s2', 'premium', { metadata: { tierEscalatedFrom: 'standard' } });
    assert.equal(countPremiumCap(beads, 20).over, false);
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

test('count: beads already closed when the run started (the run baseline) are not counted; a baseline bead this run reopened counts again', () => {
    const beads = [epic];
    // An epic relaunched after an upgrade: 8 premium beads closed by earlier runs.
    for (let i = 0; i < 8; i++) beads.push(task('old' + i, 'premium', { status: 'closed' }));
    beads.push(task('new0', 'premium'), task('new1', 'standard'), task('new2', 'standard'));
    const closedAtStart = new Set(beads.filter((b) => b.status === 'closed').map((b) => b.id));
    const c = countPremiumCap(beads, 20, { closedAtStart });
    assert.equal(c.total, 3);
    assert.deepEqual(c.premiumIds, ['new0']);
    assert.equal(c.over, false, 'ceil(20% x 3) = 1 allows the one open premium bead');
    assert.equal(c.excludedClosedAtStart.length, 8);
    // Without the baseline the legacy beads would put the plan over its cap.
    assert.equal(countPremiumCap(beads, 20).over, true);
    // A baseline bead this run reopened is open again and counts.
    beads[1] = task('old0', 'premium');
    const reopened = countPremiumCap(beads, 20, { closedAtStart });
    assert.deepEqual(reopened.premiumIds, ['new0', 'old0']);
    assert.deepEqual(reopened.openPremiumIds, ['new0', 'old0']);
});

test('count: -tier spellings normalize; a 4-task plan with 1 premium bead is within a 20% cap', () => {
    const c = countPremiumCap([task('a', 'premium-tier'), task('b', 'standard'), task('c', 'standard'), task('d', 'standard')], 20);
    assert.deepEqual(c.premiumIds, ['a']);
    assert.equal(c.allowed, 1, 'ceil(20% x 4) = 1: a small plan may hold one premium bead');
    assert.equal(c.over, false);
    assert.equal(c.mustMove, 0);
});

test('count: 4 tasks with 2 premium are over a 20% cap and must move 1', () => {
    const c = countPremiumCap([task('a', 'premium'), task('b', 'premium'), task('c', 'standard'), task('d', 'standard')], 20);
    assert.equal(c.allowed, 1);
    assert.equal(c.over, true);
    assert.equal(c.mustMove, 1);
});

test('allowance: ceil(pct x total / 100) in integers', () => {
    assert.equal(premiumAllowance(20, 4), 1);
    assert.equal(premiumAllowance(20, 5), 1);
    assert.equal(premiumAllowance(20, 6), 2);
    assert.equal(premiumAllowance(0, 10), 0);
    assert.equal(premiumAllowance(0, 50), 0);
    assert.equal(premiumAllowance(20, 0), 0);
    assert.equal(premiumAllowance(20, 10), 2);
    assert.equal(premiumAllowance(20, 14), 3);
    assert.equal(premiumAllowance(20, 15), 3);
    assert.equal(premiumAllowance(10, 9), 1);
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
    assert.ok(d.options[1].text.includes('tierOverrides {"premiumCapPct": 21}'), d.options[1].text);
    assert.equal(capPctToFit(c), 21);
    assert.match(d.options[2].text, /--set-metadata model=standard/);
    assert.ok(d.recommendation.length > 0);
});

// --- the gate over injected seams ------------------------------------------

function gateSeams({ scopes, logs = [], calls = [] }) {
    let i = 0;
    return {
        logs, calls,
        listScope: async () => { calls.push('list'); return scopes[Math.min(i++, scopes.length - 1)]; },
        replan: async (req) => { calls.push({ replan: req.attempt, ids: req.count.premiumIds.slice(), openIds: req.count.openPremiumIds.slice(), mustMove: req.count.mustMove }); },
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

test('gate: a relaunched epic whose premium beads closed in earlier runs starts within its cap -- no re-plan', async () => {
    const beads = [epic];
    for (let i = 0; i < 8; i++) beads.push(task('old' + i, 'premium', { status: 'closed' }));
    for (let i = 0; i < 5; i++) beads.push(task('new' + i, i === 0 ? 'premium' : 'standard'));
    const s = gateSeams({ scopes: [beads] });
    const baseline = { closedIds: null };
    const out = await runPremiumCapGate({ policy: resolveTierPolicy('balanced'), sprintState: {}, cycle: 1, baseline, ...s });
    assert.equal(out.status, 'within');
    assert.equal(s.calls.filter((c) => c && (c.replan || c.decision)).length, 0);
    assert.equal(baseline.closedIds.size, 8, 'the first gate call records the run baseline');
    assert.ok(s.logs.some((l) => l.includes('run baseline') && l.includes('8 in-scope bead(s)')), JSON.stringify(s.logs));
});

test('gate: a premium bead this run closed still counts in a later cycle (cumulative), but a re-plan is only asked to move the open ones', async () => {
    const sprintState = {};
    const baseline = { closedIds: null };
    // Cycle 1: 10 tasks, 2 premium -- within the 20% cap; the baseline is empty.
    const c1 = gateSeams({ scopes: [tenTasks(2)] });
    assert.equal((await runPremiumCapGate({ policy: resolveTierPolicy('balanced'), sprintState, cycle: 1, baseline, ...c1 })).status, 'within');
    // Cycle 2: both premium beads were closed by this run, and the cycle's
    // plan added two more premium beads: 4 premium of 12 is over ceil(20% x 12) = 3.
    const later = tenTasks(2).map((b) => (b.id === 't0' || b.id === 't1' ? { ...b, status: 'closed' } : b));
    later.push(task('t10', 'premium'), task('t11', 'premium'));
    const fixed = later.map((b) => (b.id === 't11' ? task('t11', 'standard') : b));
    const c2 = gateSeams({ scopes: [later, fixed] });
    const out = await runPremiumCapGate({ policy: resolveTierPolicy('balanced'), sprintState, cycle: 2, baseline, ...c2 });
    assert.equal(out.status, 'within');
    const replans = c2.calls.filter((c) => c && c.replan);
    assert.equal(replans.length, 1, 'the closed premium beads still count, so the plan is over its cap');
    assert.deepEqual(replans[0].openIds, ['t10', 't11'], 'only the open premium beads are offered to the re-plan');
    assert.deepEqual(out.count.premiumIds, ['t0', 't1', 't10']);
});

test('gate: over the cap only through premium beads this run already closed -- no re-plan, Develop proceeds', async () => {
    const sprintState = {};
    const baseline = { closedIds: new Set() };
    const beads = tenTasks(3).map((b) => (b.id && b.id.startsWith('t') && Number(b.id.slice(1)) < 3 ? { ...b, status: 'closed' } : b));
    const s = gateSeams({ scopes: [beads] });
    const out = await runPremiumCapGate({ policy: resolveTierPolicy('balanced'), sprintState, cycle: 2, baseline, ...s });
    assert.equal(out.status, 'closed-only');
    assert.equal(s.calls.filter((c) => c && (c.replan || c.decision)).length, 0);
    assert.ok(s.logs.some((l) => l.includes('too few open premium beads are left to move')), JSON.stringify(s.logs));
    // One open premium bead left, but 3 closed premium of 11 (allowance 3) plus it must move 1: fixable -> re-plan.
    const one = [...beads, task('t10', 'premium')];
    const s2 = gateSeams({ scopes: [one, one.map((b) => (b.id === 't10' ? task('t10', 'standard') : b))] });
    assert.equal((await runPremiumCapGate({ policy: resolveTierPolicy('balanced'), sprintState: {}, cycle: 2, baseline, ...s2 })).status, 'within');
    // 4 closed premium of 11 exceed the allowance of 3 by themselves: moving the one open bead cannot help.
    const four = tenTasks(4).map((b) => (b.id && b.id.startsWith('t') && Number(b.id.slice(1)) < 4 ? { ...b, status: 'closed' } : b));
    four.push(task('t10', 'premium'));
    const s3 = gateSeams({ scopes: [four] });
    assert.equal((await runPremiumCapGate({ policy: resolveTierPolicy('balanced'), sprintState: {}, cycle: 2, baseline, ...s3 })).status, 'closed-only');
    assert.equal(s3.calls.filter((c) => c && (c.replan || c.decision)).length, 0);
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
    assert.ok(buildPlannerPrompt({ ...basePlanner, premiumCapPct: 20 }).includes('rounded up'), 'cap line says rounded up');
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
    assert.ok(p.includes('rounded up') && !p.includes('rounded down'), 'replan clause says rounded up');
    assert.ok(!p.includes('DEFECTIVE ACCEPTANCE CRITERIA'));
    const r = buildPlanReviewerPrompt({ ...baseReviewer, replanScope: ['t0', 't1', 't2'], premiumCapPct: 20, premiumCapReplan });
    assert.ok(r.includes('PREMIUM-CAP REPLAN REVIEW'));
    assert.ok(r.includes('t0, t1, t2') && r.includes('at least 1'));
    assert.ok(!r.includes('SCOPED IN-CYCLE REPLAN REVIEW'));
});
