import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { validateVerdict, FALLBACK_SCHEMAS } from '../fleet-sprint/contracts.mjs';
import {
    applyPlannerDecision, parsePlannerReport, decisionSetAsideEntries, onlyDecisionSetAsideFindings, NEEDS_DECISION_KIND,
} from '../fleet-sprint/decisions.mjs';
import { createDecisionWait } from '../fleet-sprint/decision-wait.mjs';
import { buildPlanReviewerPrompt } from '../fleet-sprint/prompts.mjs';

// =============================================================================
// A planner finding only an operator can settle comes back as the optional
// `decision` of its result (planner-output.json, same shape as the doer and
// reviewer NEEDS-DECISION). The engine routes it through recordPendingDecision
// exactly like theirs: a separate decision bead, the work bead set aside and
// never labelled human, and the decision wait has something to wait on. A
// planner result without a decision changes nothing.
// =============================================================================

const check = (cond, msg) => assert.ok(cond, msg);

const QUESTION = 'The bug can only be fixed by upgrading the vendored parser (a new major) or by patching it locally; ' +
    'nothing in the bead, its parent or the code says which is acceptable. Which should the plan take?';
const OPTIONS = [
    { id: 'a', text: 'Upgrade the parser to the next major and adapt the callers.' },
    { id: 'b', text: 'Keep the current major and carry a local patch.' },
];
const RECOMMENDATION = 'a, because the patch would have to be carried forever.';
const decisionFor = (beadId) => ({ beadId, question: QUESTION, options: OPTIONS, recommendation: RECOMMENDATION });

// --- contract ----------------------------------------------------------------

test('contract: planner output with a valid decision validates (vendored and fallback schemas)', () => {
    const ajv = new Ajv({ strict: false });
    const fallback = ajv.compile(FALLBACK_SCHEMAS.plannerReport);
    const report = { status: 'OK', notes: 'Planned; one finding needs an operator.', taskIds: ['x-2'], decision: decisionFor('x-1') };
    const result = validateVerdict('plannerReport', report);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.equal(fallback(report), true, JSON.stringify(fallback.errors));
    // No decision: unchanged.
    assert.equal(validateVerdict('plannerReport', { status: 'OK', notes: 'Planned.' }).valid, true);
    assert.equal(validateVerdict('plannerReport', { status: 'BLOCKED', notes: 'No scope.' }).valid, true);
});

test('contract: a malformed planner decision is rejected with the same rules as the doer decision', () => {
    const ajv = new Ajv({ strict: false });
    const fallback = ajv.compile(FALLBACK_SCHEMAS.plannerReport);
    const { options: _omit, ...noOptions } = decisionFor('x-1');
    const bad = [
        noOptions,
        { ...decisionFor('x-1'), options: [OPTIONS[0]] },
        { ...decisionFor('x-1'), options: [{ id: 'a' }, { id: 'b', text: 'B' }] },
        { ...decisionFor('x-1'), question: '' },
        { ...decisionFor('x-1'), recommendation: '' },
        { question: QUESTION, options: OPTIONS, recommendation: RECOMMENDATION },
        'pick one',
    ];
    for (const decision of bad) {
        const planner = { status: 'OK', notes: 'n', decision };
        const doer = { status: 'NEEDS-DECISION', closedIds: [], notes: 'n', decision };
        assert.equal(validateVerdict('doerReport', doer).valid, false, `doer rejects ${JSON.stringify(decision)}`);
        assert.equal(validateVerdict('plannerReport', planner).valid, false, `planner rejects ${JSON.stringify(decision)}`);
        assert.equal(fallback(planner), false, `fallback planner rejects ${JSON.stringify(decision)}`);
    }
});

// --- parsing -----------------------------------------------------------------

test('unit: parsePlannerReport finds the JSON result in reply text, fenced or bare, and tolerates prose', () => {
    const report = { status: 'OK', notes: 'braces {in} "strings" are fine', decision: decisionFor('x-1') };
    const fenced = `Planned the DAG.\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
    assert.deepEqual(parsePlannerReport(fenced), report);
    assert.deepEqual(parsePlannerReport(`text {not json} then ${JSON.stringify(report)}`), report);
    assert.deepEqual(parsePlannerReport(report), report, 'an already-parsed object is taken as is');
    assert.deepEqual(parsePlannerReport('{"status":"OK","notes":"n"}'), { status: 'OK', notes: 'n' });
    assert.equal(parsePlannerReport('Analyzed the epic. Ensured tasks exist.'), null);
    assert.equal(parsePlannerReport(undefined), null);
});

// --- routing -----------------------------------------------------------------

function fakeBd({ createdId = 'x-dec' } = {}) {
    const commands = [];
    const command = async (cmd) => {
        commands.push(cmd);
        if (cmd.includes('rmSync')) return '';
        if (cmd.startsWith('node -e')) return `/tmp/staged-${commands.length}.txt`;
        if (cmd.startsWith('bd list')) return '[]';
        if (cmd.startsWith('bd create')) return `${createdId}\n`;
        return '';
    };
    return { commands, command };
}

const SCOPE = [
    { id: 'x-1', status: 'open', priority: 1, dependencies: [] },
    { id: 'x-2', status: 'open', dependencies: [{ depends_on_id: 'x-1', type: 'blocks' }] },
    { id: 'x-3', status: 'closed', dependencies: [] },
];
const bdListScoped = async () => SCOPE.map((b) => ({ ...b }));

test('unit: a planner decision files a separate decision bead, sets the work bead aside (no human label) and gives the decision wait something to wait on', async () => {
    const { commands, command } = fakeBd();
    const sprintState = {};
    const logs = [];
    const reply = `Created 2 tasks.\n${JSON.stringify({ status: 'OK', notes: 'One finding needs an operator.', decision: decisionFor('x-1') })}`;
    const rec = await applyPlannerDecision({
        value: reply, sprintState, command, member: 'm', bdListScoped, cycle: 1, round: 2, site: 'Plan C1 R2', log: (m) => logs.push(m),
    });
    check(rec, `recorded: ${logs.join(' | ')}`);
    assert.equal(rec.beadId, 'x-1');
    assert.equal(rec.decisionBeadId, 'x-dec');
    assert.equal(rec.question, QUESTION);
    check(rec.raisedBy.startsWith('planner (Plan C1 R2)'), rec.raisedBy);

    const create = commands.find((c) => c.startsWith('bd create'));
    check(create && / -l human /.test(create) && / -t decision /.test(create), `a separate human decision bead: ${create}`);
    check(create.includes('--deps "discovered-from:x-1"'), 'linked to the work bead, not the work bead itself');
    check(commands.some((c) => c.startsWith('bd note x-1 --file')), 'the request is appended to the work bead notes');
    check(!commands.some((c) => /^bd (update|label)\b.*\bx-1\b.*human/.test(c) || /^bd label add x-1\b/.test(c)),
        `the work bead is never labelled human: ${commands.join(' | ')}`);
    check(!commands.some((c) => /^bd human respond\b/.test(c)), 'nothing answers the decision');

    assert.equal(sprintState.doctorBlockedIds.get('x-1').kind, NEEDS_DECISION_KIND);
    assert.equal(sprintState.doctorBlockedIds.get('x-2').kind, 'dependent', 'its blocks dependent is held too');
    assert.deepEqual([...decisionSetAsideEntries(sprintState).keys()].sort(), ['x-1', 'x-2']);

    const wait = createDecisionWait({
        sprintState, requestPause: () => {}, requestResume: async () => {}, command, member: 'm', pollIntervalMs: 60_000,
    });
    assert.equal(wait.hasPending(), true, 'the run has a pending decision to pause on');
});

test('unit: planner output without a decision (text or JSON) issues no bd call and changes no state', async () => {
    for (const value of [
        'Analyzed the epic. Ensured tasks exist for implementation and tests.',
        JSON.stringify({ status: 'OK', notes: 'Planned.', taskIds: ['x-1'] }),
        undefined,
        null,
    ]) {
        const { commands, command } = fakeBd();
        const sprintState = {};
        let listed = 0;
        const rec = await applyPlannerDecision({
            value, sprintState, command, member: 'm', bdListScoped: async () => { listed++; return SCOPE; }, cycle: 1, round: 1, site: 'Plan C1 R1',
        });
        assert.equal(rec, null);
        assert.equal(commands.length, 0, `no bd call for ${JSON.stringify(value)}`);
        assert.equal(listed, 0, 'not even a scope read');
        assert.deepEqual(sprintState, {}, 'no state touched');
    }
});

test('unit: an unusable planner decision (malformed, out of scope, or on a closed bead) sets nothing aside', async () => {
    const cases = [
        [{ status: 'OK', notes: 'n', decision: { ...decisionFor('x-1'), options: [OPTIONS[0]] } }, 'output contract'],
        [{ status: 'OK', notes: 'n', decision: { ...decisionFor('x-1'), options: [OPTIONS[0], OPTIONS[0]] } }, 'unusable decision'],
        [{ status: 'OK', notes: 'n', decision: decisionFor('zz-9') }, 'not in the sprint scope'],
        [{ status: 'OK', notes: 'n', decision: decisionFor('x-3') }, 'closed bead'],
    ];
    for (const [report, expected] of cases) {
        const { commands, command } = fakeBd();
        const sprintState = {};
        const logs = [];
        const rec = await applyPlannerDecision({
            value: JSON.stringify(report), sprintState, command, member: 'm', bdListScoped, cycle: 1, round: 1, site: 'Plan C1 R1', log: (m) => logs.push(m),
        });
        assert.equal(rec, null);
        assert.equal(commands.length, 0, `no bd write for ${expected}`);
        assert.equal(decisionSetAsideEntries(sprintState).size, 0);
        check(logs.some((m) => m.includes(expected)), `logged '${expected}': ${logs.join(' | ')}`);
    }
});

// --- plan-review gate ---------------------------------------------------------

test('unit: the plan-reviewer prompt names decision-held beads as non-blocking only when some are held', () => {
    const base = { targetIssues: ['x-0'], goal: 'P2' };
    const plain = buildPlanReviewerPrompt(base);
    assert.equal(buildPlanReviewerPrompt({ ...base, decisionSetAside: [] }), plain, 'no held bead: prompt unchanged');
    check(!plain.includes('SET ASIDE FOR AN OPERATOR DECISION'), 'absent by default');
    const held = buildPlanReviewerPrompt({ ...base, decisionSetAside: [{ id: 'x-1', decisionBeadId: 'x-dec' }, { id: 'x-2' }] });
    check(held.includes('SET ASIDE FOR AN OPERATOR DECISION'), 'clause present');
    check(held.includes('x-1 (decision bead x-dec)') && held.includes('x-2'), 'names the held beads');
    check(/NON-BLOCKING/.test(held), 'states they are non-blocking');
});

test('unit: a CHANGES_NEEDED is waived when its structured findings name only held beads, whatever prose its notes carry', () => {
    const sprintState = { doctorBlockedIds: new Map([['x-1', { kind: NEEDS_DECISION_KIND, decisionId: 'd1' }]]) };
    const extract = () => [];
    const finding = { id: 'x-1', kind: 'coverage', detail: 'x-1 has no task children.' };
    const task = (id) => ({ id, bucket: 'S', model: 'm' });
    const waived = (v) => onlyDecisionSetAsideFindings({ verdict: 'CHANGES_NEEDED', taskAssignments: [], ...v }, sprintState, extract);

    check(waived({ notes: 'x-1 has no task children: decompose it.', findings: [finding] }), 'one sentence on the held bead');
    check(waived({ notes: 'x-1 is held for a decision. Otherwise the plan looks good.', findings: [finding] }), 'multi-sentence narration');
    check(waived({ notes: 'x-1: no children; non-blocking per decision hold.', findings: [finding] }), 'clause-separated narration');
    check(waived({ notes: 'Plan is solid. x-1 awaits the operator.', findings: [finding], taskAssignments: [task('x-10'), task('x-1.2')] }),
        'assigned ids that only extend the held id are not named');
    check(!waived({ notes: 'x-1 has no task children; x-3 is too large.', findings: [finding], taskAssignments: [task('x-3')] }),
        'notes naming a non-held assigned task');
    check(!waived({ notes: 'x-1.2 is too large.', findings: [finding], taskAssignments: [task('x-1.2')] }), 'a dotted child of the held id is another task');
    check(!waived({ notes: 'x-1 has no task children.' }), 'a legacy verdict without findings');
    check(!waived({ notes: 'x-1 has no task children.', findings: [finding, { id: 'x-2', kind: 'coverage', detail: 'd' }] }), 'a finding on a non-held bead');
    check(!waived({ notes: 'x-1 is held. The plan lacks a test task.', findings: [finding, { id: 'plan', kind: 'missing_test_task', detail: 'd' }] }),
        'a finding with a plan-level id');
    check(!waived({ notes: 'The plan is incomplete.', findings: [] }), 'a plan-wide (empty findings) verdict');
});
