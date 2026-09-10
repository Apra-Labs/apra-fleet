import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';

import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';

import {
    setup,
    teardown,
    buildMockFleetApi,
    defaultMockCallTool,
    uniqueMockBranch,
    withScenarioMarkers,
} from './helpers/mock-sprint-harness.mjs';
import { GUARDED_MODULES } from '../fleet-sprint/guarded-modules.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNNER_PATH = path.join(__dirname, '../fleet-sprint/runner.js');

// =============================================================================
// apra-fleet-3swo.6.2 -- PHASE ORDER PIN for the runSprintCycle -> phases/*
// slice.
//
// runSprintCycle is being decomposed one phase() boundary at a time. Each
// slice moves a block of code out of runner.js into its own module under
// fleet-sprint/phases/, and every slice is supposed to be MOVE-ONLY. The
// failure mode that decomposition invites is not a crash -- it is a REORDER:
// a phase that runs a little earlier or later than it used to, or one that
// stops running at all because its extracted call site landed on the wrong
// side of a conditional. Either one leaves a sprint that still completes and
// still passes every per-unit test, while doing its work in the wrong order.
//
// This test closes that hole the only way that actually proves it: it drives
// ONE full deterministic mock sprint (the same harness every mock-sprint test
// in this package uses) and records the ORDERED sequence of phase() labels the
// run emits, then compares it to EXPECTED_PHASE_SEQUENCE below -- the sequence
// recorded from the PRE-SLICE runner.js, before any phase module existed.
//
// HOW THE BASELINE WAS TAKEN (and how to re-take it honestly): the expected
// sequence below was captured by running this exact test against the runner
// with the slice reverted (`git stash push -- fleet-sprint/`), so it is a
// record of the old inline behaviour, not a transcription of the new one. A
// future slice in this epic that changes this list is either (a) a genuine
// reorder, which is a bug in that slice, or (b) not move-only. There is no
// third case, so do not "update the expectation" to make a red run green
// without first proving the phase order genuinely had to change.
//
// WHY NOT JUST RELY ON THE GOLDEN TRANSCRIPT: golden-transcript.test.mjs pins
// the ordered command()/agent() DISPATCH stream, which is strictly finer than
// this. But it is also silent about phases that emit no dispatch at all, and
// its failure output points at a prompt/command diff rather than at "the Plan
// phase moved". The two are complementary; this one names the actual defect.
//
// EVENT SOURCE: FleetWorkflow.phase() emits 'phase' with the bare title
// string (packages/apra-fleet-workflow/src/workflow/index.mjs -- the payload
// is deliberately a string, not an object, for the dashboard viewer). So this
// listener sees exactly what the runner asked for, with no re-derivation from
// source text and no scanning of runner.js -- which is what lets it keep
// working unchanged as the remaining phases move out of runner.js.
// =============================================================================

/**
 * The ordered phase() labels one full `reject-then-approve` mock sprint emits.
 * Captured from the PRE-SLICE runner.js (see this file's header).
 *
 * Reading it: the sprint runs a single cycle (C1). The plan loop runs twice
 * because the mock plan-reviewer rejects once and then approves -- R1, R2 --
 * and the develop/review loop likewise runs twice because the mock reviewer
 * reopens a bead on its first round and approves on its second. 'Ensure
 * Sprint Branch' is the only label with no cycle suffix; every other one is
 * templated with the cycle (and, for the in-cycle loops, the round).
 *
 * 'Regression Test C1' is deliberately ABSENT: that phase is gated on the
 * target repo actually having a regression-test playbook, and this mock
 * scenario stages none. Its absence is part of the recorded pre-slice
 * behaviour, not an oversight -- a slice that somehow made it start running
 * would be exactly the kind of change this pin exists to catch.
 */
const EXPECTED_PHASE_SEQUENCE = [
    'Ensure Sprint Branch',
    'Plan C1 R1',
    'Plan C1 R2',
    'Develop C1 R1',
    'Review C1 R1',
    'Develop C1 R2',
    'Review C1 R2',
    'Deploy C1',
    'Integ Test C1',
    'Final Review C1',
    'Harvest C1',
    'Publish PR C1',
];

/** Runs one full mock sprint, returning the ordered phase() labels it emitted. */
async function recordPhaseSequence(tag) {
    const { tempDir, epicBead } = await setup(tag);
    try {
        const mockFleetApi = buildMockFleetApi(tempDir, epicBead, [], [], {
            planReviewerMode: 'reject-then-approve',
        });
        const workflow = new FleetWorkflow(mockFleetApi, { targetRepo: tempDir }, `[${tag}] `);

        const phaseLog = [];
        workflow.on('phase', (title) => { phaseLog.push(title); });

        const engine = new WorkflowEngine(workflow);
        await engine.executeFile(RUNNER_PATH, {
            target_issue: epicBead.id,
            members: ['local'],
            branch: uniqueMockBranch(tag),
            base_branch: 'main',
            goal: 'P1/P2',
            max_cycles: 5,
            callTool: defaultMockCallTool(),
        }, true);

        return phaseLog;
    } finally {
        await teardown(tempDir);
    }
}

test('a full simulated cycle emits the pre-slice phase() sequence, in order', async () => {
    await withScenarioMarkers('phase-sequence-order', async () => {
        const phases = await recordPhaseSequence('phase-sequence-order');

        assert.deepEqual(
            phases,
            EXPECTED_PHASE_SEQUENCE,
            'the phase() execution order changed. Slicing runSprintCycle into phases/* is MOVE-ONLY: a phase may ' +
            'not start running earlier, later, more often, or not at all. Do not update EXPECTED_PHASE_SEQUENCE ' +
            'to match a red run -- find the slice that moved a call site across a boundary.\n' +
            `expected: ${JSON.stringify(EXPECTED_PHASE_SEQUENCE, null, 2)}\n` +
            `actual:   ${JSON.stringify(phases, null, 2)}`
        );
    });
});

// -----------------------------------------------------------------------------
// The two properties above that a passing run must not be allowed to satisfy
// vacuously. Both are pure assertions over the recorded constant -- no second
// sprint run -- so they cost nothing and they fail loudly if someone ever
// "fixes" a red phase-order run by emptying or truncating the expectation.
// -----------------------------------------------------------------------------

test('the phase-order expectation is non-vacuous: it covers both sliced phases and the ones still inline', () => {
    assert.ok(
        EXPECTED_PHASE_SEQUENCE.length >= 10,
        `a truncated expectation would make the order pin meaningless, got ${EXPECTED_PHASE_SEQUENCE.length} label(s)`
    );

    // The two phases THIS bead sliced out must both still appear -- an
    // extraction that silently stopped calling its phase() would otherwise
    // read as a legitimate sequence change.
    assert.ok(
        EXPECTED_PHASE_SEQUENCE.includes('Ensure Sprint Branch'),
        'the Ensure Sprint Branch phase must still emit its label from phases/ensure-sprint-branch.mjs'
    );
    assert.ok(
        EXPECTED_PHASE_SEQUENCE.some((p) => /^Plan C\d+ R\d+$/.test(p)),
        'the Plan phase must still emit its per-round label from phases/plan.mjs'
    );

    // ...and so must phases that are still INLINE in runner.js, which is what
    // makes this a slice-boundary pin rather than a two-module pin.
    for (const stillInline of ['Develop C1 R1', 'Review C1 R1', 'Final Review C1', 'Publish PR C1']) {
        assert.ok(
            EXPECTED_PHASE_SEQUENCE.includes(stillInline),
            `${stillInline} is still inline in runner.js and must stay covered by this pin`
        );
    }

    // Ensure Sprint Branch precedes the first Plan round: the ordering
    // relationship the slice most plausibly breaks, stated directly rather
    // than left implicit in the array literal.
    assert.ok(
        EXPECTED_PHASE_SEQUENCE.indexOf('Ensure Sprint Branch') < EXPECTED_PHASE_SEQUENCE.findIndex((p) => p.startsWith('Plan C')),
        'Ensure Sprint Branch must run before the first Plan round'
    );
});

test('both sliced phase modules are registered for mechanical guard coverage', () => {
    // Paired with the order pin deliberately: an extracted phase module that
    // works correctly but is unregistered loses all five mechanical guards
    // SILENTLY while they keep reporting green (see guarded-modules.mjs's
    // header). The order pin above would not notice that at all.
    for (const mod of ['phases/ensure-sprint-branch.mjs', 'phases/plan.mjs']) {
        assert.ok(
            GUARDED_MODULES.includes(mod),
            `${mod} must be registered in GUARDED_MODULES -- registering a newly extracted module is part of the extraction itself`
        );
    }
});
