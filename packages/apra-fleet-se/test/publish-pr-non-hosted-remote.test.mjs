import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-eft.64.2: pin apra-fleet-eft.64/64.1's fix -- a non-hosted
// (`file://`) git 'origin' remote must never route the Publish PR step
// through `gh pr create` (which would hard-fail on 'gh auth login required'
// in exactly the sandbox integ-test-playbook.md wires up: a bare file://
// mirror with no gh auth/GH_TOKEN provisioned). Instead the target issue is
// closed directly once the sprint's own final verdict is PASS, and the
// sprint reaches a successful terminal state with no gh dependency at all.
//
// A companion scenario pins the opposite: a hosted GitHub remote (the
// default `originUrl` in mock-sprint-harness.mjs) must still route through
// `gh pr create` unchanged -- this guards against a regression that
// over-corrects and skips PR creation unconditionally.
// =============================================================================

test('mock sprint: non-hosted (file://) origin remote skips PR creation and closes the target issue directly', async () => {
    await withScenarioMarkers('filehosted', async () => {
        console.log('Running mock sprint scenario (non-hosted file:// origin remote)...');
        const fileRemoteUrl = 'file:///tmp/apra-fleet-eft64-bare-mirror.git';
        const run = await runDevelopLoopScenario('filehosted', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: eft.64.2 file:// remote fixture' }],
            maxCycles: 1,
            originUrl: fileRemoteUrl,
        });

        check(!run.error, `Scenario against a non-hosted file:// remote should not throw: ${run.error ? `${run.error.constructor.name}: ${run.error.message}` : ''}`);
        check(
            run.result && run.result.status === 'success',
            `Sprint should reach a successful terminal state against a non-hosted remote, got: ${JSON.stringify(run.result)}`
        );

        // The classification probe still runs (it is what decides the remote
        // is non-hosted in the first place)...
        check(
            run.commandLog.includes('git remote get-url origin'),
            `Expected the origin-remote classification probe to be dispatched, commandLog: ${JSON.stringify(run.commandLog)}`
        );
        // ...but no `gh` command of ANY kind is ever dispatched -- proof this
        // path has no dependency on gh auth / GH_TOKEN.
        check(
            !run.commandLog.some((c) => /^gh\s/.test(c)),
            `Expected NO 'gh' command to be dispatched against a non-hosted remote, commandLog: ${JSON.stringify(run.commandLog)}`
        );

        // The target/canary issue (the sprint's epic bead, target_issue) is
        // closed DIRECTLY (no PR gate) once the final verdict is PASS.
        check(
            run.commandLog.includes(`bd close ${run.epicBeadId}`),
            `Expected the target issue to be closed directly via 'bd close ${run.epicBeadId}', commandLog: ${JSON.stringify(run.commandLog)}`
        );
        const epicBead = run.finalBeadsById.get(run.epicBeadId);
        check(
            !!epicBead && epicBead.status === 'closed',
            `Expected the target/epic bead to be closed at end of sprint, got: ${JSON.stringify(epicBead)}`
        );

        check(
            run.logs.some((m) => m.includes('is not a gh-hostable GitHub remote') && m.includes('skipping PR creation entirely')),
            `Expected a logged message noting PR creation was skipped for the non-hosted remote, logs: ${JSON.stringify(run.logs)}`
        );
        check(
            run.logs.some((m) => m.includes(`closed target issue '${run.epicBeadId}' directly`)),
            `Expected a logged message noting the target issue was closed directly, logs: ${JSON.stringify(run.logs)}`
        );
    });
});

test('mock sprint: hosted GitHub origin remote still routes through PR creation (companion to the non-hosted fixture)', async () => {
    await withScenarioMarkers('hostedremote', async () => {
        console.log('Running mock sprint scenario (hosted GitHub origin remote)...');
        // No `originUrl` override -- mock-sprint-harness.mjs's default is a
        // hosted 'https://github.com/...' URL (see buildMockFleetApi's
        // `originUrl` option comment).
        const run = await runDevelopLoopScenario('hostedremote', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: eft.64.2 hosted-remote fixture' }],
            maxCycles: 1,
        });

        check(!run.error, `Scenario against a hosted GitHub remote should not throw: ${run.error ? `${run.error.constructor.name}: ${run.error.message}` : ''}`);
        check(
            run.result && run.result.status === 'success',
            `Sprint should reach a successful terminal state against a hosted remote, got: ${JSON.stringify(run.result)}`
        );

        check(
            run.commandLog.includes('git remote get-url origin'),
            `Expected the origin-remote classification probe to be dispatched, commandLog: ${JSON.stringify(run.commandLog)}`
        );
        check(
            run.commandLog.some((c) => c.startsWith('gh pr create') && c.includes(`--head "${run.branch}"`)),
            `Expected 'gh pr create' to still be dispatched for the hosted remote, commandLog: ${JSON.stringify(run.commandLog)}`
        );

        // The target/epic bead must NOT be closed directly (the only `bd
        // close <id>` call in runner.js's Publish PR step is on the
        // non-hosted path) -- closure on the hosted path is gated on a human
        // merging the PR, not this direct-close shortcut.
        check(
            !run.commandLog.includes(`bd close ${run.epicBeadId}`),
            `Did not expect the target issue to be closed directly on the hosted-remote path, commandLog: ${JSON.stringify(run.commandLog)}`
        );
    });
});
