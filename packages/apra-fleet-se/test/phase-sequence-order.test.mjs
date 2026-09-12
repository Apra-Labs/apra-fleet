import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
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

test('the phase-order expectation is non-vacuous: it covers every sliced phase and the ones still inline', () => {
    assert.ok(
        EXPECTED_PHASE_SEQUENCE.length >= 10,
        `a truncated expectation would make the order pin meaningless, got ${EXPECTED_PHASE_SEQUENCE.length} label(s)`
    );

    // Every phase sliced out SO FAR must still appear -- an extraction that
    // silently stopped calling its phase() would otherwise read as a
    // legitimate sequence change.
    assert.ok(
        EXPECTED_PHASE_SEQUENCE.includes('Ensure Sprint Branch'),
        'the Ensure Sprint Branch phase must still emit its label from phases/ensure-sprint-branch.mjs'
    );
    assert.ok(
        EXPECTED_PHASE_SEQUENCE.some((p) => /^Plan C\d+ R\d+$/.test(p)),
        'the Plan phase must still emit its per-round label from phases/plan.mjs'
    );
    // apra-fleet-3swo.6.7 moved Develop into phases/develop.mjs. Its label is
    // still produced twice by this scenario (the mock reviewer reopens once),
    // which is the part of the pin that would catch a sliced round phase that
    // stopped running, ran once, or ran three times.
    assert.equal(
        EXPECTED_PHASE_SEQUENCE.filter((p) => /^Develop C\d+ R\d+$/.test(p)).length,
        2,
        'the Develop phase must still emit its per-round label from phases/develop.mjs, once per develop round'
    );
    // apra-fleet-3swo.6.5 moved Review into phases/review.mjs. Like Develop it
    // is a per-ROUND phase, so the same once-per-round count is the pin that
    // would catch a sliced round phase that stopped running, ran once, or ran
    // three times.
    assert.equal(
        EXPECTED_PHASE_SEQUENCE.filter((p) => /^Review C\d+ R\d+$/.test(p)).length,
        2,
        'the Review phase must still emit its per-round label from phases/review.mjs, once per develop round'
    );
    // ...and Deploy, which is per-CYCLE, so exactly once in this single-cycle
    // scenario.
    assert.equal(
        EXPECTED_PHASE_SEQUENCE.filter((p) => /^Deploy C\d+$/.test(p)).length,
        1,
        'the Deploy phase must still emit its per-cycle label from phases/deploy.mjs, once per cycle'
    );
    // apra-fleet-3swo.6.8 moved Integ Test into phases/integ-test.mjs. Also
    // per-CYCLE, so exactly once in this single-cycle scenario. Its sibling
    // from the same slice, Re-Review, is deliberately NOT counted here: it
    // fires only when the goal-priority count reads 0 with no review having
    // run this cycle, which the reject-then-approve scenario never reaches --
    // the source-level label-ownership pin at the bottom of this file is what
    // covers that half of the slice, exactly as it does for Replan.
    assert.equal(
        EXPECTED_PHASE_SEQUENCE.filter((p) => /^Integ Test C\d+$/.test(p)).length,
        1,
        'the Integ Test phase must still emit its per-cycle label from phases/integ-test.mjs, once per cycle'
    );

    // apra-fleet-3swo.6.6 moved Final Review into phases/final-review.mjs. It
    // is once-per-SPRINT, so exactly once here. Its sibling from the same
    // slice, Regression Test, is deliberately NOT counted: it fires only when
    // regression-test-playbook.md exists, which this scenario does not provide
    // -- the source-level label-ownership pin at the bottom of this file is
    // what covers that half of the slice, exactly as it does for Replan and
    // Re-Review.
    assert.equal(
        EXPECTED_PHASE_SEQUENCE.filter((p) => /^Final Review C\d+$/.test(p)).length,
        1,
        'the Final Review phase must still emit its once-per-sprint label from phases/final-review.mjs'
    );

    // ...and so must phases that are still INLINE in runner.js, which is what
    // makes this a slice-boundary pin rather than a sliced-modules-only pin.
    for (const stillInline of ['Harvest C1', 'Publish PR C1']) {
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

test('every sliced phase module is registered for mechanical guard coverage', () => {
    // Paired with the order pin deliberately: an extracted phase module that
    // works correctly but is unregistered loses all five mechanical guards
    // SILENTLY while they keep reporting green (see guarded-modules.mjs's
    // header). The order pin above would not notice that at all.
    for (const mod of [
        'phases/ensure-sprint-branch.mjs',
        'phases/plan.mjs',
        'phases/replan.mjs',
        'phases/develop.mjs',
        'phases/review.mjs',
        'phases/deploy.mjs',
        'phases/integ-test.mjs',
        'phases/re-review.mjs',
        'phases/final-review.mjs',
        'phases/regression-test.mjs',
    ]) {
        assert.ok(
            GUARDED_MODULES.includes(mod),
            `${mod} must be registered in GUARDED_MODULES -- registering a newly extracted module is part of the extraction itself`
        );
    }
});

// -----------------------------------------------------------------------------
// apra-fleet-3swo.6.7. The order pin above is a RUNTIME record, so it can only
// speak about phases this mock scenario actually reaches. Two gaps follow from
// that, and this test closes both by reading source instead:
//
//  (a) Replan is never reached. The in-cycle scoped replan fires only when a
//      reviewer returns `replanIds`, and the 'reject-then-approve' scenario's
//      mock reviewer never does -- which is why no 'Replan C1 R1' label appears
//      in EXPECTED_PHASE_SEQUENCE above. That absence is correct, but it means
//      a Replan extraction could be half-done (or duplicated) with the runtime
//      pin still green.
//
//  (b) A label that MOVED and a label that was COPIED look identical at
//      runtime as long as only one of the two copies is on the live path.
//
// So: each sliced phase's phase() label literal must exist in exactly one
// place -- its own module -- and nowhere in runner.js.
// -----------------------------------------------------------------------------

test('each sliced phase builds its phase() label in its own module and nowhere in runner.js', () => {
    const runnerSrc = fs.readFileSync(RUNNER_PATH, 'utf8');
    const phasesDir = path.join(__dirname, '../fleet-sprint/phases');

    // label-building fragment -> the module that must own it.
    const slicedLabels = {
        "phase('Ensure Sprint Branch')": 'ensure-sprint-branch.mjs',
        'phase(`Plan C': 'plan.mjs',
        'phase(`Replan C': 'replan.mjs',
        'phase(`Develop C': 'develop.mjs',
        'phase(`Review C': 'review.mjs',
        'phase(`Deploy C': 'deploy.mjs',
        'phase(`Integ Test C': 'integ-test.mjs',
        'phase(`Re-Review C': 're-review.mjs',
        // apra-fleet-3swo.6.6. Regression Test is the Replan/Re-Review case
        // again -- the mock scenario ships no regression-test-playbook.md, so
        // the runtime pin above never sees its label and THIS entry is the
        // only thing that would catch a half-done or duplicated extraction.
        'phase(`Final Review C': 'final-review.mjs',
        'phase(`Regression Test C': 'regression-test.mjs',
    };

    for (const [fragment, ownerFile] of Object.entries(slicedLabels)) {
        const ownerSrc = fs.readFileSync(path.join(phasesDir, ownerFile), 'utf8');
        assert.ok(
            ownerSrc.includes(fragment),
            `phases/${ownerFile} must build its own phase() label (${fragment}) -- an extracted phase that left its ` +
            'phase() call behind, or dropped it, is not a move-only slice'
        );
        assert.ok(
            !runnerSrc.includes(fragment),
            `runner.js still builds ${fragment}, which belongs to phases/${ownerFile}. A label that was COPIED rather ` +
            'than MOVED passes the runtime order pin above while leaving two sources of truth for one phase.'
        );
    }

    // Non-vacuity: the fragments must be the shape the runner really uses, so
    // prove at least one phase label IS still built inline (the phases that
    // have not been sliced yet) -- otherwise a typo'd fragment would make
    // every "not in runner.js" assertion above pass for free.
    // apra-fleet-3swo.6.6 sliced Final Review and Regression Test out, so the
    // live-control label moved on again -- to Harvest, the next phase()
    // boundary runSprintCycle still builds inline. Only Publish PR is left
    // after it; once BOTH are sliced there is no inline control left, and this
    // non-vacuity check must be re-expressed (e.g. against a deliberately
    // absent fragment) rather than deleted.
    assert.ok(
        runnerSrc.includes('phase(`Harvest C'),
        'Harvest is still inline in runner.js; if this fails the label fragments above are stale and the ' +
        'runner.js half of this test is passing vacuously'
    );
    // The three Review-family labels all CONTAIN a shorter fragment from the
    // map above -- 'Re-Review C' and 'Final Review C' both contain 'Review C'
    // -- so a substring search is exactly where a slice can appear to have
    // moved a label it never touched. As of apra-fleet-3swo.6.6 all three are
    // sliced (phases/review.mjs, phases/re-review.mjs, phases/final-review.mjs),
    // so every "runner.js must not build X" assertion in the loop above now
    // rests on the map alone, which makes the cross-module exclusivity below
    // load-bearing rather than a nicety: without it, ONE module carrying all
    // three literals would satisfy the whole map.
    //
    // Note the loop above is only sound for 'phase(`Review C' because
    // 'phase(`Re-Review C' and 'phase(`Final Review C' are not substrings of
    // it (each has its own leading text before "Review C"), so a module that
    // built the wrong one could not accidentally satisfy the Review entry.
    // Pin every direction explicitly rather than relying on that.
    const reviewPhaseSrc = fs.readFileSync(path.join(phasesDir, 'review.mjs'), 'utf8');
    const reReviewPhaseSrc = fs.readFileSync(path.join(phasesDir, 're-review.mjs'), 'utf8');
    const finalReviewPhaseSrc = fs.readFileSync(path.join(phasesDir, 'final-review.mjs'), 'utf8');
    const REVIEW_FAMILY = [
        { file: 'review.mjs', src: reviewPhaseSrc, owns: 'phase(`Review C' },
        { file: 're-review.mjs', src: reReviewPhaseSrc, owns: 'phase(`Re-Review C' },
        { file: 'final-review.mjs', src: finalReviewPhaseSrc, owns: 'phase(`Final Review C' },
    ];
    for (const mine of REVIEW_FAMILY) {
        assert.ok(
            mine.src.includes(mine.owns),
            `phases/${mine.file} must build its own Review-family label (${mine.owns})`
        );
        for (const other of REVIEW_FAMILY) {
            if (other.file === mine.file) continue;
            assert.ok(
                !mine.src.includes(other.owns),
                `phases/${mine.file} must not build ${other.owns} -- that label belongs to phases/${other.file}, and ` +
                'one module carrying two Review-family literals would let the label map above be satisfied by the wrong file'
            );
        }
    }
    // Regression Test is not a Review-family label, but it is the other half
    // of this slice and the runtime pin never sees it, so pin the same
    // exclusivity for it: only phases/regression-test.mjs may build it.
    const regressionPhaseSrc = fs.readFileSync(path.join(phasesDir, 'regression-test.mjs'), 'utf8');
    for (const mine of REVIEW_FAMILY) {
        assert.ok(
            !mine.src.includes('phase(`Regression Test C'),
            `phases/${mine.file} must not build the Regression Test label -- it belongs to phases/regression-test.mjs`
        );
    }
    assert.ok(
        !regressionPhaseSrc.includes('phase(`Final Review C'),
        'phases/regression-test.mjs must not build the Final Review label -- a Regression Test module that also owned ' +
        'the verdict-producing phase would destroy the ordering guarantee the two modules exist to keep apart'
    );
});
