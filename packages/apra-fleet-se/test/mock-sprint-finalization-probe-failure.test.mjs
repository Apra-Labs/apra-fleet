import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-unw.17 (A4) acceptance criterion 5: a probe failure SKIPS
// the dependent phase instead of throwing/killing the sprint
// =============================================================================
test('mock sprint: a deploy.md probe failure skips Deploy/Integ without throwing', async () => {
    await withScenarioMarkers('probefailure', async () => {
        console.log('Running mock sprint scenario (deploy.md probe command fails -> phase skipped, no throw)...');
        const probeFailure = await runDevelopLoopScenario('probefailure', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: Probe-failure scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            // Fail only the deploy.md existence probe; the integ-test-playbook.md
            // probe (and every other command) runs normally.
            commandFailurePattern: /node -e .*deploy\.md/,
        });
        check(!probeFailure.error, `Probe-failure scenario should not throw/kill the sprint: ${probeFailure.error ? probeFailure.error.message : ''}`);
        check(
            !probeFailure.dispatched.some((d) => d.agent === 'deployer'),
            `Expected the Deploy phase to be skipped after the probe failure (no deployer dispatch), got: ${JSON.stringify(probeFailure.dispatched.map((d) => d.agent))}`
        );
        check(
            !probeFailure.dispatched.some((d) => d.agent === 'integ-test-runner'),
            `Expected the Integ Test phase to also be skipped (deploy never ran), got: ${JSON.stringify(probeFailure.dispatched.map((d) => d.agent))}`
        );
        check(
            probeFailure.logs.some((m) => m.includes("Probe for 'deploy.md' failed")),
            `Expected a logged warning naming the failed probe, logs: ${JSON.stringify(probeFailure.logs)}`
        );
    });
});
