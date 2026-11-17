import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import {
    SPRINT_STATE_CLIENT_CONSTRUCTED_LOG,
    SPRINT_STATE_SETTLE_SHELL_LOG_PREFIX,
} from '../fleet-sprint/sprint-state.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-3swo.6.1 -- the whole-sprint half of the client-hoist assertion.
//
// test/sprint-state.test.mjs pins the property in isolation (with a counting
// construction seam). This file pins it where it actually matters: across a
// REAL simulated sprint cycle driven through WorkflowEngine.executeFile(),
// where the settle-shell path is reached from several unrelated phases (the
// preflight settle, the post-plan settle, the doer streak's
// verifyDoerStreakClosed, the per-dispatch withGitSync teardown's
// syncMemberAfterOrdered, the cycle-eval settle and the final-review settle).
//
// Before this bead every one of those built its own `new ApraFleet({ callTool
// })`. The observable is a pair of counts taken from the run's own logs:
//
//   constructions == 1  AND  resolutions >= 2
//
// Both halves are load-bearing, which is what makes this falsifiable in BOTH
// directions:
//   - re-introduce the per-call construction inside sprint-state and the
//     construction count rises above 1;
//   - revert runner.js's resolveSettleShell to build its own client (bypassing
//     sprint state entirely) and the resolution lines vanish, so the
//     resolutions >= 2 half fails.
// A one-sided "at most one construction" assertion would be vacuously
// satisfied by zero, which is exactly what a bypass produces.
// =============================================================================

test('mock sprint: the settle-shell path builds ONE fleet client for the whole sprint while serving many resolutions', { timeout: 180000 }, async () => {
    await withScenarioMarkers('3swo.6.1 sprint-state client hoist', async () => {
        // No callTool override: the harness's defaultMockCallTool is wired as
        // args.callTool (one function identity for the whole sprint, exactly
        // like bin/cli.mjs's live mcpClient.callTool), which is what makes the
        // settle-shell path active at all.
        const scenario = await runDevelopLoopScenario('3swo61sprintstate', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: exercise the sprint-scoped fleet client hoist' }],
            maxCycles: 1,
        });

        check(!scenario.error, `the scenario must complete cleanly; got: ${scenario.error && scenario.error.message}`);

        const constructions = scenario.logs.filter((l) => l.includes(SPRINT_STATE_CLIENT_CONSTRUCTED_LOG));
        const resolutions = scenario.logs.filter((l) => l.includes(SPRINT_STATE_SETTLE_SHELL_LOG_PREFIX));

        // Half 1 -- the hoist: one client for the whole sprint.
        check(
            constructions.length === 1,
            `expected exactly ONE sprint-scoped fleet-client construction across the whole cycle, got ${constructions.length}. ` +
            `settle-shell resolutions seen: ${resolutions.length}.`,
        );

        // Half 2 -- non-vacuity: the path was genuinely exercised more than
        // once, so "one construction" is a saving and not an unused code path.
        check(
            resolutions.length >= 2,
            `expected the settle-shell path to be exercised at least twice through sprint state (it is reached from several phases), got ${resolutions.length}: ${JSON.stringify(resolutions)}`,
        );

        // The resolved value stays in the documented set for every resolution
        // -- '' here, since the harness's member_detail carries no `os`
        // (and therefore also exercises the UNCACHED degrade end to end).
        check(
            resolutions.every((l) => /resolved to '(gitbash|pwsh7|powershell5|)'/.test(l)),
            `every resolution must report a shell from the documented set (gitbash|pwsh7|powershell5|''), got: ${JSON.stringify(resolutions)}`,
        );
    });
});
