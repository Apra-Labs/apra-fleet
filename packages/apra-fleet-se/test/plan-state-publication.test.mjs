import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildListStatePayload, resolveStringRefs } from '@apralabs/apra-fleet-workflow/viewer/lean-state';
import { runPlanPhase } from '../fleet-sprint/phases/plan.mjs';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// fleet-bridge-implementation-plan.md Part A1 -- publishing the plan-reviewer
// verdict under state.extensions.plan. Scenarios 1-3 drive the REAL
// runner.js/phases/plan.mjs end to end (via runDevelopLoopScenario, the same
// harness mock-sprint-plan-cap-deferral.test.mjs and
// plan-reviewer-dispatch-failure.test.mjs already use), and assert on the
// 'plan'-namespace `publishState` events FleetWorkflow's 'state' listener
// records into `states` -- the exact `publishedStates.find(e => e.namespace
// === ...)` pattern used by runner-arg-contract.test.mjs. Scenario 4 calls
// runPlanPhase() directly with no `publishState` at all. Scenario 5 is the
// lean round-trip: it does not need a live sprint, just a payload shaped the
// way publishPlanState() builds one.
// =============================================================================

test('clean APPROVED plan: the final plan state is status=approved, approved=true, deferredIds=[]', async () => {
    await withScenarioMarkers('plan-state publication: clean APPROVED', async () => {
        const sc = await runDevelopLoopScenario('planstateapproved', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: plan-state approved-path work' }],
            maxCycles: 1,
            // Default planReviewerMode ('reject-then-approve') is fine here --
            // this scenario only cares about the FINAL plan state, not the
            // round count.
        });

        check(!sc.error, `expected the sprint to succeed, got: ${sc.error ? sc.error.constructor.name + ': ' + sc.error.message : 'none'}`);

        const planStates = sc.states.filter((e) => e.namespace === 'plan');
        check(planStates.length > 0, `expected at least one publishState('plan', ...) call, got states: ${JSON.stringify(sc.states.map((e) => e.namespace))}`);
        const last = planStates[planStates.length - 1].data;

        assert.equal(last.status, 'approved');
        assert.equal(last.approved, true);
        assert.deepStrictEqual(last.deferredIds, []);
        assert.equal(last.verdict, 'APPROVED');
        assert.equal(typeof last.cycle, 'number');
        assert.equal(typeof last.planningRounds, 'number');
        assert.equal(typeof last.updatedAt, 'string');
        assert.ok(!Number.isNaN(Date.parse(last.updatedAt)), `updatedAt must parse as a date, got: ${last.updatedAt}`);
    });
});

test('plan-cap deferral: the final plan state is status=deferred, approved=false, deferredIds populated', async () => {
    await withScenarioMarkers('plan-state publication: plan-cap deferral', async () => {
        // Same fixture shape as mock-sprint-plan-cap-deferral.test.mjs's
        // "confined to one bead" scenario: every plan-review round returns
        // CHANGES_NEEDED naming only the contested bead, exhausting all 3
        // rounds and routing to per-bead deferral rather than a whole-plan abort.
        const sc = await runDevelopLoopScenario('planstatedeferred', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Contested bookkeeping bead' },
                { title: 'Task: Clean feature bead' },
            ],
            planReviewerHandler: async ({ tempDir, runCmd, epicBead }) => {
                const list = JSON.parse((await runCmd(`bd list --parent ${epicBead.id} --json`, tempDir)).stdout || '[]');
                const contested = list.find((b) => b.title.includes('Contested'));
                const clean = list.find((b) => b.title.includes('Clean'));
                return {
                    content: [{
                        text: JSON.stringify({
                            verdict: 'CHANGES_NEEDED',
                            notes: `${contested.id} is missing a supersede link on its bookkeeping form -- fix that before this plan can be approved.`,
                            findings: [{ id: contested.id, kind: 'acceptance_criteria', detail: 'Missing a supersede link.' }],
                            taskAssignments: [
                                { id: contested.id, bucket: 'S', model: 'standard' },
                                { id: clean.id, bucket: 'S', model: 'standard' },
                            ],
                        }),
                    }],
                };
            },
        });

        check(!sc.error, `expected the sprint to resolve (deferral, not abort), got: ${sc.error ? sc.error.constructor.name + ': ' + sc.error.message : 'none'}`);

        const contestedId = sc.tasks.find((t) => t.title.includes('Contested')).id;

        const planStates = sc.states.filter((e) => e.namespace === 'plan');
        check(planStates.length > 0, 'expected at least one publishState(\'plan\', ...) call');
        const last = planStates[planStates.length - 1].data;

        assert.equal(last.status, 'deferred');
        assert.equal(last.approved, false);
        assert.deepStrictEqual(last.deferredIds, [contestedId]);
        assert.equal(last.verdict, 'CHANGES_NEEDED');
        assert.equal(last.planningRounds, 3);
        check(
            last.findings.some((f) => f.id === contestedId),
            `expected the terminal plan state's findings to name the contested bead ${contestedId}, got: ${JSON.stringify(last.findings)}`
        );

        // No EARLIER 'plan' write from this same run ever claimed approved:true --
        // every round in this scenario is CHANGES_NEEDED, so nothing but the
        // terminal 'deferred' write should exist.
        check(
            planStates.every((e) => e.data.approved === false),
            `expected no 'plan' state write in this run to claim approved:true, got: ${JSON.stringify(planStates.map((e) => e.data.approved))}`
        );
    });
});

test('a hard rejection (whole-plan contested) never publishes a terminal plan state claiming approved:true', async () => {
    await withScenarioMarkers('plan-state publication: hard rejection', async () => {
        // Same fixture as plan-reviewer-dispatch-failure.test.mjs's genuine-
        // rejection scenario: every round is a real (non-dispatch-failed)
        // CHANGES_NEEDED with an empty taskAssignments/findings set -- the
        // whole-plan-contested condition -- so the phase throws
        // SprintPlanRejectedError instead of ever reaching Develop.
        const sc = await runDevelopLoopScenario('planstaterejected', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: hard-rejection scenario work' }],
            maxCycles: 1,
            planReviewerHandler: async () => ({
                content: [{
                    text: JSON.stringify({
                        verdict: 'CHANGES_NEEDED',
                        notes: 'The DAG genuinely needs more decomposition.',
                        taskAssignments: [],
                    }),
                }],
            }),
        });

        check(!!sc.error, 'expected the sprint to reject when the whole plan is contested');

        const planStates = sc.states.filter((e) => e.namespace === 'plan');
        // Every 'plan' write this run ever made -- including any mid-loop
        // 'iterating' writes -- must never claim approved:true, since no
        // round in this scenario ever returns APPROVED.
        check(
            planStates.every((e) => e.data.approved !== true),
            `expected no 'plan' state write to claim approved:true on a hard rejection, got: ${JSON.stringify(planStates.map((e) => ({ status: e.data.status, approved: e.data.approved })))}`
        );
        // And specifically: no write ever reports status 'approved'.
        check(
            planStates.every((e) => e.data.status !== 'approved'),
            `expected no 'plan' state write to report status 'approved' on a hard rejection, got: ${JSON.stringify(planStates.map((e) => e.data.status))}`
        );
    });
});

test('runPlanPhase called without publishState does not throw', async () => {
    // Exercises runPlanPhase() DIRECTLY (not through the full runner.js
    // engine, which always wires a real publishState via FleetWorkflow) with
    // a minimal but real dispatchCtx that gets ONE planner + plan-reviewer
    // round to a clean APPROVED outcome -- reaching BOTH publishPlanState()
    // call sites (the round-loop 'approved' write and the terminal write) --
    // with `publishState` omitted from the params object entirely. Proves
    // the optional-dependency guard (`typeof publishState === 'function'`)
    // is real: a missing viewer must never turn into a thrown error.
    //
    // dispatchRole (fleet-sprint/dispatch-role.mjs) is imported directly by
    // plan.mjs, not injected, so this stubs dispatchCtx's own primitives
    // (agent/getMemberForRole/withGitSync/withDispatchWatchdog/budgets/
    // fixedRoleTier/schemas/log/invalidateAllBeadsCache) rather than
    // dispatchRole itself -- the same seam runner.js's own dispatchCtx fills
    // in production (see runner.js:1397).
    const fakeAgent = async (prompt, options) => {
        if (options.agentType === 'planner') return { summary: 'planned' };
        if (options.agentType === 'plan-reviewer') {
            return { verdict: 'APPROVED', notes: 'Looks good.', taskAssignments: [] };
        }
        throw new Error(`unexpected agentType in fake dispatchCtx.agent: ${options.agentType}`);
    };
    const dispatchCtx = {
        agent: fakeAgent,
        getMemberForRole: () => 'local',
        withGitSync: async (member, pushCode, invoke) => invoke(),
        withDispatchWatchdog: async (promise) => promise,
        fixedRoleTier: { planner: 'sonnet', 'plan-reviewer': 'sonnet' },
        budgets: { DISPATCH_INACTIVITY_TIMEOUT_S: 3600, DISPATCH_TIMEOUT_S: 9000 },
        schemas: { planReviewerVerdict: {} },
        log: () => {},
        invalidateAllBeadsCache: () => {},
        memberSessionGuard: { killIfAlive: async () => {} },
        isNoMutationDispatchFailure: () => false,
    };

    const result = await runPlanPhase({
        phase: () => {},
        log: () => {},
        // collectParentNotesStalenessNotes' own bd probe: parseBdJson below
        // always answers '[]' -> empty children -> the staleness probe skips
        // its history read entirely (see parent-notes-staleness.mjs), so this
        // never needs to look at what `command` actually returns.
        command: async () => '[]',
        dispatchCtx,
        cycle: 1,
        validated: { goal: 'P1/P2', requirementsFile: null },
        targetIssues: ['bd-1'],
        requirementsContent: null,
        orchestratorMember: 'local',
        getMemberForRole: () => 'local',
        sprintState: {},
        gitSync: { syncBeadsBefore: async () => {}, syncBeadsAfter: async () => {} },
        args: {},
        verifySetThisCycle: [],
        roundSessions: { resumeArgFor: () => false, record: () => {} },
        pendingRejectedNewTasks: [],
        resolveSettleShell: async () => 'bash',
        parseBdJson: () => [],
        extractContestedBeadIds: () => [],
        reconcilePendingRejectedNewTasks: (pending) => pending,
        stageCommandBodyMemberSide: async () => '/tmp/note-file',
        updateDashboard: async () => {},
        // publishState deliberately OMITTED.
    });

    assert.equal(result.planningRounds, 1, 'expected exactly one clean APPROVED round');
    assert.equal(result.lastVerdict.verdict, 'APPROVED');
    assert.deepStrictEqual(result.planCapDeferredIds, []);
});

test('lean round-trip: a publishPlanState-shaped payload survives buildListStatePayload + resolveStringRefs byte-identical', () => {
    // Mirrors exactly what publishPlanState() in phases/plan.mjs builds --
    // including a `notesSummary` and a `finding.detail` that repeat the same
    // long string (>= dedupeStrings' 24-char minimum), which is precisely the
    // collision decisions.md and the fleet-bridge plan call out as making
    // resolveStringRefs() mandatory, not defensive.
    const repeatedText = 'This finding text is long enough to trigger dedupeStrings ($ref) replacement.';
    const payload = {
        cycle: 2,
        planningRounds: 3,
        status: 'deferred',
        verdict: 'CHANGES_NEEDED',
        approved: false,
        deferredIds: ['BD-14', 'BD-22'],
        findings: [
            { id: 'BD-14', kind: 'acceptance_criteria', detail: repeatedText },
            { id: 'BD-22', kind: 'task_size', detail: repeatedText },
        ],
        notesSummary: repeatedText,
        updatedAt: '2026-09-18T00:00:00.000Z',
    };

    const state = { tree: [], extensions: { plan: payload } };
    const leanPayload = buildListStatePayload(state);
    const resolved = resolveStringRefs(leanPayload, leanPayload._strings || []);

    assert.deepStrictEqual(resolved.extensions.plan, payload, 'the plan payload must survive lean+resolve byte-identical');

    // No `summary` key appeared anywhere in the leaned (pre-resolve) payload --
    // proof that none of the HEAVY_FIELD_NAMES collapse ever fired.
    const leanJson = JSON.stringify(leanPayload);
    check(!/"summary"/.test(leanJson), `expected no 'summary' key in the leaned payload, got: ${leanJson}`);

    // No truncation ellipsis anywhere in the RESOLVED payload -- every string
    // here is well under both capText's 300-char cap and lean-state's own
    // 400-char generic cap, so truncate() must never have fired.
    const resolvedJson = JSON.stringify(resolved);
    check(!resolvedJson.includes('...'), `expected no truncation ellipsis in the resolved payload, got: ${resolvedJson}`);

    // No dropped keys: same key set at every level.
    assert.deepStrictEqual(Object.keys(resolved.extensions.plan).sort(), Object.keys(payload).sort());
    assert.deepStrictEqual(
        resolved.extensions.plan.findings.map((f) => Object.keys(f).sort()),
        payload.findings.map((f) => Object.keys(f).sort())
    );

    // Sanity: the repeated string actually DID get $ref-deduped pre-resolve
    // (proves this test would have caught a regression to inline strings
    // that never collide, rather than passing vacuously).
    check(
        JSON.stringify(leanPayload).includes('$ref'),
        'sanity: the repeated finding/notes text should have been $ref-deduped before resolveStringRefs'
    );
});

test('proxy.mjs exports upstreamRequestHeaders, downstreamResponseHeaders, proxyStream, proxyHtml, sendPlain, and HOP_BY_HOP', async () => {
    const proxy = await import('../src/supervisor/proxy.mjs');
    for (const name of ['upstreamRequestHeaders', 'downstreamResponseHeaders', 'proxyStream', 'proxyHtml', 'sendPlain', 'HOP_BY_HOP']) {
        check(name in proxy, `expected proxy.mjs to export '${name}'`);
    }
});
