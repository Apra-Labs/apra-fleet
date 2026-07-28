import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-unw2.9 (N11) acceptance criterion 1: re-running finalization
// against the SAME branch (simulating a re-run of a sprint that already
// published a PR) must NOT throw. `prExistsState` is a Set shared across
// both scenario runs and `branchOverride` pins both runs to the exact
// same branch name -- the second run's `gh pr create` sees that branch
// already recorded and mock-fails with an "already exists" message,
// which runner.js's Publish PR step must swallow (not throw).
//
// idempr1 and idempr2 MUST run in this order, in this same file/process --
// they share a `prExistsState` Set and a fixed branch name (this is the
// point of the scenario), so they are driven sequentially inside one
// test() rather than as two independent node:test cases that node's
// default per-file sequential execution could not otherwise be relied on
// to order relative to each other.
// =============================================================================
test('mock sprint: re-running finalization against the same branch is idempotent (no throw on existing PR)', async () => {
    console.log('Running mock sprint scenario (idempotent PR creation: re-run same branch)...');
    const idempotentPrState = new Set();
    const idempotentBranch = 'auto-sprint/mock-idempotent-pr-rerun';

    const idemPrRun1 = await withScenarioMarkers('idempr1', () => runDevelopLoopScenario('idempr1', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: Idempotent PR creation run 1' }],
        maxCycles: 1,
        prExistsState: idempotentPrState,
        branchOverride: idempotentBranch,
    }));
    check(!idemPrRun1.error, `Idempotent-PR run1 (first publish, no prior PR) should not throw: ${idemPrRun1.error ? idemPrRun1.error.message : ''}`);
    check(
        idemPrRun1.result && idemPrRun1.result.status === 'success',
        `Idempotent-PR run1 should succeed, got: ${JSON.stringify(idemPrRun1.result)}`
    );
    check(
        idemPrRun1.commandLog.some((c) => c.startsWith('gh pr create') && c.includes(`--head "${idempotentBranch}"`)),
        `Expected run1 to dispatch 'gh pr create' for '${idempotentBranch}', commandLog: ${JSON.stringify(idemPrRun1.commandLog)}`
    );

    const idemPrRun2 = await withScenarioMarkers('idempr2', () => runDevelopLoopScenario('idempr2', {
        members: ['local'],
        taskSpecs: [{ title: 'Task: Idempotent PR creation run 2 (re-run)' }],
        maxCycles: 1,
        prExistsState: idempotentPrState,
        branchOverride: idempotentBranch,
    }));
    check(
        !idemPrRun2.error,
        `SECOND run against the same branch (simulating a re-run) must NOT throw in finalization, got error: ${idemPrRun2.error ? `${idemPrRun2.error.constructor.name}: ${idemPrRun2.error.message}` : ''}`
    );
    check(
        idemPrRun2.result && idemPrRun2.result.status === 'success',
        `Idempotent-PR run2 (re-run against a branch with an existing PR) should still resolve to success, got: ${JSON.stringify(idemPrRun2.result)}`
    );
    check(
        idemPrRun2.commandLog.some((c) => c.startsWith('gh pr create') && c.includes(`--head "${idempotentBranch}"`)),
        `Expected run2 to still dispatch 'gh pr create' (idempotently) for '${idempotentBranch}', commandLog: ${JSON.stringify(idemPrRun2.commandLog)}`
    );
    check(
        idemPrRun2.logs.some((m) => m.includes('already exists') && m.includes('idempotent success')),
        `Expected a logged message noting the PR already exists and was treated as an idempotent success, logs: ${JSON.stringify(idemPrRun2.logs)}`
    );

    // apra-fleet-unw2.9 (N11) acceptance criterion 2: the PR title/body must
    // include the final verdict, for both PASS and FAIL outcomes. Per
    // plan.md's already-decided rule (not re-litigated here), a FAIL verdict
    // still publishes the PR -- the verdict is stated plainly in the body,
    // not suppressed. PASS side is covered by run1's PR-raise assertion in
    // mock-sprint-happy-path.test.mjs; FAIL side is covered by the
    // explicitFail scenario's PR assertions in
    // mock-sprint-exit-explicit-fail.test.mjs (apra-fleet-fih.2;
    // formerly dedicated 'prverdictpass' / 'prverdictfail' scenarios here).
});
