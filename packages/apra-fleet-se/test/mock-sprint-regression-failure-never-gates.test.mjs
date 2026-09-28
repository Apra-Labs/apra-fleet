import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// apra-fleet-3swo.6.6: the Regression Test phase cannot change the sprint
// verdict -- proved by RUNNING it, not by reading the source.
//
// regression-phase-never-gates.test.mjs already pins the ordering structurally
// (Final Review's call site precedes the Regression Test banner, which precedes
// Harvest) and pins the 'regression-test-runner' policy row's catch-all degrade
// against the real dispatch engine. Both are source/unit-level, and neither
// would notice a slice that preserved the textual ordering while letting the
// regression result reach the verdict some other way -- for instance a phase
// module that returned a value runner.js folded into `finalVerdictResult`, or a
// Publish PR step that re-derived status from `regressionResult.passed`.
//
// This file closes that hole the only way that actually proves it: two full
// deterministic mock sprints whose configuration differs in EXACTLY ONE way --
// the regression runner reports passed:true in one and passed:false (with a
// carry-over bug filed) in the other -- and the sprint's returned verdict,
// status and notes must be byte-identical across the pair.
//
// WHY A/B RATHER THAN ONE FAILING RUN: asserting "a failing regression still
// returns PASS" alone would also pass if the scenario silently stopped
// dispatching the regression runner at all. The A/B shape plus the explicit
// non-vacuity checks below (the regression runner really dispatched, it really
// reported a failure, and it really ran AFTER the final reviewer) make that
// impossible.
//
// The phase only dispatches when regression-test-playbook.md exists, hence
// withRegressionPlaybook: true -- the real probeFileExists() in runner.js skips
// the phase entirely otherwise.
// =============================================================================

const SCENARIO = {
    members: ['local'],
    taskSpecs: [{ title: 'Task: regression-never-gates scenario work' }],
    maxCycles: 1,
    withRegressionPlaybook: true,
};

const PASSING_REGRESSION = () => ({
    content: [{
        text: JSON.stringify({
            passed: true,
            suitePassed: true,
            smokePassed: true,
            bugsFiled: [],
            summary: 'Mock regression pass: full suite and sandbox smoke test both green.',
        }),
    }],
});

const FAILING_REGRESSION = () => ({
    content: [{
        text: JSON.stringify({
            passed: false,
            suitePassed: false,
            smokePassed: false,
            bugsFiled: ['carry-over-1'],
            summary: 'Mock regression FAILURE: the functional suite and the sandbox smoke test both failed.',
        }),
    }],
});

/** Index of the first dispatch of `agent` in the recorded dispatch stream. */
const firstDispatchIndex = (dispatched, agent) => dispatched.findIndex((d) => d.agent === agent);

test('mock sprint: a FAILING regression pass leaves the sprint verdict byte-identical to a passing one', { timeout: 300000 }, async () => {
    const green = await withScenarioMarkers('regressiongreen', async () => runDevelopLoopScenario('regressiongreen', {
        ...SCENARIO,
        regressionHandler: PASSING_REGRESSION,
    }));
    const red = await withScenarioMarkers('regressionred', async () => runDevelopLoopScenario('regressionred', {
        ...SCENARIO,
        regressionHandler: FAILING_REGRESSION,
    }));

    // --- both sprints completed normally (no typed abort escaped the phase) ---
    for (const [name, sc] of [['green', green], ['red', red]]) {
        assert.ok(!sc.error, `the ${name} sprint must not abort: ${sc.error && sc.error.message}`);
        assert.ok(sc.result, `the ${name} sprint must return a result rather than throw`);
    }

    // --- non-vacuity: the regression phase really ran in BOTH sprints ---
    for (const [name, sc] of [['green', green], ['red', red]]) {
        assert.ok(
            sc.dispatched.some((d) => d.agent === 'regression-test-runner'),
            `the ${name} sprint must actually have dispatched the regression runner (withRegressionPlaybook), ` +
            `otherwise this test proves nothing; dispatched: ${JSON.stringify(sc.dispatched.map((d) => d.agent))}`,
        );
    }
    // ...and the red one really reported a FAILURE, which the runner really saw.
    assert.ok(
        red.logs.some((l) => l.includes('Regression pass reported FAILURES')),
        `the red sprint's runner must have logged the regression FAILURE it was handed, got: ${JSON.stringify(red.logs.filter((l) => l.includes('Regression pass')))}`,
    );
    assert.ok(
        green.logs.some((l) => l.includes('Regression pass PASSED')),
        `the green sprint's runner must have logged the regression PASS it was handed, got: ${JSON.stringify(green.logs.filter((l) => l.includes('Regression pass')))}`,
    );

    // --- the ordering that IS the guarantee, observed at runtime ---
    // Final Review is dispatched under the 'reviewer' agent type (it is the
    // reviewer persona over the whole sprint), so the meaningful runtime
    // ordering claim is that the regression runner is dispatched AFTER the LAST
    // reviewer dispatch of the sprint -- i.e. after the final verdict exists.
    for (const [name, sc] of [['green', green], ['red', red]]) {
        const lastReviewerIdx = sc.dispatched.map((d) => d.agent).lastIndexOf('reviewer');
        const regressionIdx = firstDispatchIndex(sc.dispatched, 'regression-test-runner');
        assert.ok(lastReviewerIdx >= 0, `the ${name} sprint must have dispatched a reviewer at all`);
        assert.ok(
            lastReviewerIdx < regressionIdx,
            `in the ${name} sprint the regression runner must be dispatched AFTER the final reviewer -- that ordering, ` +
            `not a flag, is what makes a regression failure unable to perturb the verdict; got reviewer@${lastReviewerIdx}, ` +
            `regression@${regressionIdx} in ${JSON.stringify(sc.dispatched.map((d) => d.agent))}`,
        );
    }

    // --- THE POINT: the verdict is unchanged ---
    assert.equal(
        red.result.verdict, green.result.verdict,
        `a FAILING regression pass changed the sprint verdict (${green.result.verdict} -> ${red.result.verdict}). ` +
        'The Regression Test phase is informational and runs only after finalVerdictResult is computed; if this fails, ' +
        'something now feeds the regression result back into the verdict.',
    );
    assert.equal(
        red.result.status, green.result.status,
        `a FAILING regression pass changed the sprint status (${green.result.status} -> ${red.result.status})`,
    );
    assert.equal(
        red.result.notes, green.result.notes,
        'a FAILING regression pass changed the sprint notes -- the final reviewer\'s own words must reach the caller unedited',
    );
    // Stated absolutely as well as relatively, so a pair that both degraded to
    // FAIL for some unrelated reason cannot satisfy the equalities above.
    assert.equal(
        green.result.verdict, 'PASS',
        `sanity: the green control sprint must genuinely PASS, got: ${JSON.stringify(green.result)}`,
    );
    assert.equal(
        red.result.verdict, 'PASS',
        `a sprint whose work was approved must still PASS with a failing regression pass, got: ${JSON.stringify(red.result)}`,
    );
    assert.notEqual(
        red.result.verdict, 'ABORTED',
        'a regression failure must never reach the terminal ABORTED path',
    );
});

// -----------------------------------------------------------------------------
// The regression phase's PRE-DISPATCH step -- provisioning the Permissions
// section of regression-test-playbook.md onto the runner's member -- fails
// loudly when compose_permissions refuses an entry. That loud failure must not
// become a terminal ABORTED: the verdict is already decided, and Harvest and
// Publish PR must still run. Driven through the real runner and the real
// provisioner; only compose_permissions is faked, to refuse one entry.
// -----------------------------------------------------------------------------
const REFUSED_ENTRY = 'Bash(kill:*)';
const FAIL_MARK = String.fromCodePoint(0x274c);

test('mock sprint: a refused regression-playbook permission degrades the regression pass and still reaches Harvest', { timeout: 300000 }, async () => {
    const composeCalls = [];
    const sc = await withScenarioMarkers('regressionperms', async () => runDevelopLoopScenario('regressionperms', {
        ...SCENARIO,
        regressionHandler: PASSING_REGRESSION,
        beforeSprint: async ({ tempDir }) => {
            await fs.writeFile(path.join(tempDir, 'regression-test-playbook.md'), [
                '# Regression',
                '',
                '## Permissions',
                '',
                `- \`${REFUSED_ENTRY}\` -- stop steps.`,
                '',
                '## Run',
                'Run the full suite, then the sandbox smoke test, then Teardown.',
            ].join('\n'));
        },
        callToolFactory: (executeCommand) => {
            const base = defaultMockCallTool({ executeCommand });
            return async (name, toolArgs) => {
                if (name === 'compose_permissions') {
                    composeCalls.push(toolArgs);
                    return { content: [{ type: 'text', text: `${FAIL_MARK} Refused to auto-grant ${REFUSED_ENTRY}: matches the never-auto-grant list` }] };
                }
                return base(name, toolArgs);
            };
        },
    }));

    // Non-vacuity: the real provisioner really read the playbook and really asked for the entry.
    assert.ok(
        composeCalls.some((a) => Array.isArray(a.grant) && a.grant.includes(REFUSED_ENTRY)),
        `the provisioner must have asked compose_permissions for ${REFUSED_ENTRY}; calls: ${JSON.stringify(composeCalls)}`,
    );
    // Loud: the failure is logged, naming the runbook and the entry.
    assert.ok(
        sc.logs.some((l) => l.includes('Regression pass reported FAILURES') && l.includes('regression-test-playbook.md') && l.includes(REFUSED_ENTRY)),
        `the regression provisioning failure must be logged naming runbook and entry; got: ${JSON.stringify(sc.logs.filter((l) => l.includes('Regression')))}`,
    );
    // The runner was not dispatched onto a member missing its grants.
    assert.ok(!sc.dispatched.some((d) => d.agent === 'regression-test-runner'),
        `the regression runner must not be dispatched; dispatched: ${JSON.stringify(sc.dispatched.map((d) => d.agent))}`);
    // Not an abort: the sprint completed, reached Harvest, and kept its verdict.
    assert.ok(!sc.error, `the sprint must not abort: ${sc.error && sc.error.message}`);
    assert.ok(sc.dispatched.some((d) => d.agent === 'harvester'),
        `Harvest must still run; dispatched: ${JSON.stringify(sc.dispatched.map((d) => d.agent))}`);
    assert.ok(sc.commandLog.some((c) => c.startsWith('curl -sS -X POST') && c.includes('/pulls')),
        'Publish PR must still run (its create-pull-request command must be issued)');
    assert.equal(sc.result.verdict, 'PASS', `the already-decided verdict must stand, got: ${JSON.stringify(sc.result)}`);
});
