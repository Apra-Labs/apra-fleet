import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, runRejectedPlanScenario } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// apra-fleet-x8r.5: runRejectedPlanScenario() and runDevelopLoopScenario()
// each print a `=== END scenario: <tag> (PASS/FAIL) ===` marker (apra-fleet-
// 20i.1.4.1) meant to reflect the run's real outcome. Previously both set
// `passed = true` unconditionally after their inner try/catch swallowed the
// run's error into a returned `error` value, so the marker printed PASS for
// every completed run regardless of outcome -- the FAIL branch was
// effectively dead for any failure surfaced via a returned error rather than
// an uncaught throw. This test captures the real console.log output and
// pins that a scenario whose run actually errors emits the FAIL marker, and
// a scenario whose run succeeds still emits the PASS marker.
test('apra-fleet-x8r.5: a deliberately failing runDevelopLoopScenario run emits the (FAIL) marker', async () => {
    const lines = [];
    const realLog = console.log;
    console.log = (...args) => {
        lines.push(args.map(String).join(' '));
        realLog(...args);
    };
    let result;
    try {
        // Same shape as mock-sprint-stall-contract-violation.test.mjs's
        // 'contractviolation' scenario (a reviewer that always returns a
        // self-contradictory CHANGES_NEEDED verdict, which aborts the sprint
        // with a distinct, real error -- engine.executeFile() rejects), but
        // under its OWN unique tag: reusing that scenario's tag/branch name
        // here would collide (SprintLockHeldError) when both tests' runs
        // overlap under the suite's parallel --test-concurrency.
        result = await runDevelopLoopScenario('markerverdict', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Closes fine but reviewer contradicts itself' }],
            maxCycles: 3,
            reviewerHandler: async () => ({
                content: [{
                    text: JSON.stringify({
                        verdict: 'CHANGES_NEEDED',
                        notes: 'Contradictory: nothing to reopen, nothing new to create, yet not approved.',
                        reopenIds: [],
                        newTasks: [],
                    })
                }]
            }),
        });
    } finally {
        console.log = realLog;
    }
    check(!!result.error, 'Expected this scenario to actually error (that is the property under test)');
    const marker = lines.find((l) => l.includes('=== END scenario: markerverdict ('));
    check(!!marker, `Expected an END scenario marker line, got: ${JSON.stringify(lines)}`);
    check(marker.includes('(FAIL)'), `Expected the marker to report FAIL for a run that actually errored, got: ${marker}`);
});

test('apra-fleet-x8r.5: a rejected-plan run (its own success contract) still emits the (PASS) marker', async () => {
    const lines = [];
    const realLog = console.log;
    console.log = (...args) => {
        lines.push(args.map(String).join(' '));
        realLog(...args);
    };
    let result;
    try {
        // Own unique tag (distinct from mock-sprint-plan-contracts.test.mjs's
        // 'rejected' scenario) for the same collision reason as above.
        result = await runRejectedPlanScenario('markerverdictrej');
    } finally {
        console.log = realLog;
    }
    check(!!result.error, 'Expected the plan to have been rejected (this scenario is always-reject-free-text)');
    const marker = lines.find((l) => l.includes('=== END scenario: markerverdictrej-rejected ('));
    check(!!marker, `Expected an END scenario marker line, got: ${JSON.stringify(lines)}`);
    check(marker.includes('(PASS)'), `Expected the marker to report PASS since a rejection is this scenario's success contract, got: ${marker}`);
});
