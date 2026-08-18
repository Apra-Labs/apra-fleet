import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-u1qw.2.2 / PR #416 review findings 1+2: behavioural coverage for
// healMissingPermissionsOnce() -- the shared heal-and-retry helper the Deploy,
// Integration Test and Regression Test dispatch sites all call when a phase
// reports blockedReason='missing_permissions'.
//
// The heal is now DETERMINISTIC: no permissions-composer agent, no LLM in the
// grant path at all. The runner reads the failing phase's runbook from
// `origin/<base_branch>` (never from the sprint working tree, which carries
// this sprint's own doer commits), parses its `## Permissions` list entries in
// plain JavaScript, and calls the `compose_permissions` MCP tool itself.
//
// So every assertion below counts compose_permissions TOOL CALLS rather than
// composer dispatches, and several tests additionally assert that no
// permissions-composer agent is dispatched at all -- which the harness makes a
// hard failure, since no scenario here supplies a permissionsComposerHandler.
//
// Deploy is the driver phase for the count/terminality properties; the last
// two tests prove the other two sites (Integ Test and Regression Test, both
// noteField='summary') really do route through the same shared helper.
// =============================================================================

const closeAssignedDoer = async ({ opts, tempDir: td }) => {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    const closedIds = [];
    for (const id of ids) {
        await runCmd(`bd close ${id}`, td);
        closedIds.push(id);
    }
    return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds, notes: 'Closed assigned beads.' }) }] };
};

const approveReviewer = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});

const blockedDeploy = {
    content: [{
        text: JSON.stringify({
            deployed: false,
            notes: 'deploy.md step 3 needs Bash(docker compose*), which this member is not permitted to run.',
            blockedReason: 'missing_permissions',
        }),
    }],
};

/**
 * Wraps the harness's default mock callTool, recording every
 * compose_permissions invocation and letting a test script the tool's answer.
 * `composeResponse` may be a string (the tool's return text) or a function
 * (called with the grant args; may throw to simulate a tool-level fault).
 */
function recordingCallTool(calls, composeResponse) {
    const base = defaultMockCallTool();
    return async (name, toolArgs) => {
        if (name !== 'compose_permissions') return base(name, toolArgs);
        calls.push(toolArgs);
        const answer = typeof composeResponse === 'function' ? composeResponse(toolArgs) : composeResponse;
        return { content: [{ text: answer }] };
    };
}

// compose_permissions prefixes its answer with U+2705 on success and U+274C on
// every rejection; the runner keys off exactly that. Built from code points so
// this file stays ASCII.
const OK_MARK = String.fromCodePoint(0x2705);
const FAIL_MARK = String.fromCodePoint(0x274c);
const GRANT_OK = `${OK_MARK} Granted 2 permissions on "local" (claude):\n  Bash(docker compose*)\n  Bash(npm ci)`;
const GRANT_DENIED = `${FAIL_MARK} Cannot auto-grant dangerous permissions: Bash(sudo *). Escalate to user.`;

// -----------------------------------------------------------------------------
// Criterion: "Exactly one grant precedes exactly one retry of the original
// phase" -- now one compose_permissions TOOL call, no agent dispatch.
// -----------------------------------------------------------------------------
test('mock sprint: a Deploy missing_permissions triggers EXACTLY one compose_permissions tool call and EXACTLY one Deploy retry', async () => {
    await withScenarioMarkers('permheal1', async () => {
        let deployCalls = 0;
        const composeCalls = [];
        const result = await runDevelopLoopScenario('permheal1', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permissions heal happy retry scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            callTool: recordingCallTool(composeCalls, GRANT_OK),
            deployHandler: async () => {
                deployCalls++;
                // First attempt is blocked on a permission the runbook declares;
                // the retry (after the grant) succeeds.
                if (deployCalls === 1) return blockedDeploy;
                return {
                    content: [{ text: JSON.stringify({ deployed: true, notes: 'Deployed after the permission grant.' }) }],
                };
            },
        });

        check(!result.error, `Scenario should not throw on a permissions heal: ${result.error ? result.error.message : ''}`);
        check(composeCalls.length === 1, `Exactly ONE compose_permissions call must precede the retry, got ${composeCalls.length}`);
        check(deployCalls === 2, `Exactly ONE Deploy retry must follow the grant (2 dispatches total), got ${deployCalls}`);

        const call = composeCalls[0];
        check(call.role === 'deployer', `The grant must carry the FAILING phase's role so the tool applies its bounds, got ${JSON.stringify(call.role)}`);
        check(call.member_name === 'local', `The grant must target the failing member, got ${JSON.stringify(call.member_name)}`);
        // The mock runbook declares exactly these two, as LIST entries. The
        // `Bash(git:*)` in its prose preamble is an EXAMPLE, not a
        // declaration, and must never be granted.
        check(
            Array.isArray(call.grant) && call.grant.length === 2
                && call.grant.includes('Bash(docker compose*)') && call.grant.includes('Bash(npm ci)'),
            `The grant must be exactly the runbook's declared list entries, got ${JSON.stringify(call.grant)}`
        );
        check(
            !call.grant.includes('Bash(git:*)'),
            `A backticked prefix appearing in the section's PROSE is not a declaration and must never be granted: ${JSON.stringify(call.grant)}`
        );
        check(
            typeof call.grant_reason === 'string' && call.grant_reason.includes('origin/main:deploy.md'),
            `grant_reason must name the base-branch source of the grant, got ${JSON.stringify(call.grant_reason)}`
        );

        check(
            result.logs.some((m) => m.includes('Deploy: reported blockedReason=missing_permissions')
                && m.includes('origin/main')
                && m.includes('NOT the sprint working tree')
                && m.includes('retrying this phase exactly once')),
            `Expected the heal log line naming the BASE-branch source, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.logs.some((m) => m.includes('Deploy FAILED this cycle')),
            `A Deploy that succeeds on the heal-retry must NOT be recorded as a cycle deploy failure, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

// -----------------------------------------------------------------------------
// Criterion (findings 1+2, the whole point): the runbook is read from the BASE
// branch, so a prefix a doer added to the SPRINT branch's runbook is never
// granted -- and that outcome is logged distinguishably.
// -----------------------------------------------------------------------------
test('mock sprint: a prefix present only in the SPRINT working tree is NOT granted -- the base-branch copy is authoritative', async () => {
    await withScenarioMarkers('permheal8', async () => {
        let deployCalls = 0;
        const composeCalls = [];
        const result = await runDevelopLoopScenario('permheal8', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permissions heal base branch authority scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            callTool: recordingCallTool(composeCalls, GRANT_OK),
            // The base branch declares ONLY Bash(npm ci). The working-tree copy
            // the harness wrote also declares Bash(docker compose*) -- exactly
            // the "a doer widened the runbook on the sprint branch" case.
            baseBranchRunbooks: {
                'deploy.md': '# Deploy\n\n## Permissions\n\n- `Bash(npm ci)`\n',
            },
            deployHandler: async () => {
                deployCalls++;
                if (deployCalls === 1) return blockedDeploy;
                return { content: [{ text: JSON.stringify({ deployed: true, notes: 'Deployed.' }) }] };
            },
        });

        check(!result.error, `Scenario should not throw: ${result.error ? result.error.message : ''}`);
        check(composeCalls.length === 1, `Exactly one compose_permissions call, got ${composeCalls.length}`);
        check(
            composeCalls[0].grant.length === 1 && composeCalls[0].grant[0] === 'Bash(npm ci)',
            `Only the BASE branch's declared prefixes may be granted, got ${JSON.stringify(composeCalls[0].grant)}`
        );
        check(
            !composeCalls[0].grant.includes('Bash(docker compose*)'),
            `A prefix added to the runbook on the SPRINT branch must never be self-granted: ${JSON.stringify(composeCalls[0].grant)}`
        );
        check(
            result.logs.some((m) => m.includes('requested prefix not present in base-branch runbook -- not auto-granted')
                && m.includes('Bash(docker compose*)')),
            `The intentional "not in base branch" outcome must be logged distinguishably, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

// -----------------------------------------------------------------------------
// Criterion: the base-branch runbook is missing or has no parseable
// `## Permissions` list -- fail CLOSED, never improvise a prefix list.
// -----------------------------------------------------------------------------
test('mock sprint: an unreadable base-branch runbook fails CLOSED -- no grant, no retry', async () => {
    await withScenarioMarkers('permheal9', async () => {
        let deployCalls = 0;
        const composeCalls = [];
        const result = await runDevelopLoopScenario('permheal9', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permissions heal missing base runbook scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            callTool: recordingCallTool(composeCalls, GRANT_OK),
            baseBranchRunbooks: { 'deploy.md': null },
            deployHandler: async () => {
                deployCalls++;
                return blockedDeploy;
            },
        });

        check(!result.error, `A missing base runbook must surface as a phase failure, not throw: ${result.error ? result.error.message : ''}`);
        check(composeCalls.length === 0, `No grant may be attempted when the base-branch runbook cannot be read, got ${composeCalls.length}`);
        check(deployCalls === 1, `A terminal heal must NOT retry the phase (1 dispatch only), got ${deployCalls}`);
        check(
            result.logs.some((m) => m.includes('permissions heal did NOT grant') && m.includes('deploy.md could not be read from origin/main')),
            `Expected the fail-closed log line, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            result.logs.some((m) => m.includes('Deploy FAILED this cycle')),
            `The original phase failure must still surface normally, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

// -----------------------------------------------------------------------------
// Criterion: "A second consecutive missing_permissions failure in the same cycle
// does not trigger a second heal (single-retry, no loop)."
// -----------------------------------------------------------------------------
test('mock sprint: a SECOND consecutive missing_permissions in the same cycle is terminal -- no second grant, no loop', async () => {
    await withScenarioMarkers('permheal2', async () => {
        let deployCalls = 0;
        const composeCalls = [];
        const result = await runDevelopLoopScenario('permheal2', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permissions heal terminal repeat scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            callTool: recordingCallTool(composeCalls, GRANT_OK),
            deployHandler: async () => {
                deployCalls++;
                // The grant did not actually unblock it: the retry reports the
                // very same blockedReason. That must be terminal, not a loop.
                return blockedDeploy;
            },
        });

        check(!result.error, `A repeated missing_permissions must surface as a phase failure, not throw: ${result.error ? result.error.message : ''}`);
        check(composeCalls.length === 1, `The per-cycle guard must allow only ONE grant per phase per cycle, got ${composeCalls.length}`);
        check(deployCalls === 2, `The phase must be dispatched exactly twice (original + one retry), got ${deployCalls}`);
        check(
            result.logs.some((m) => m.includes('still blockedReason=missing_permissions after the permissions heal-retry') && m.includes('TERMINAL')),
            `Expected the terminal no-second-heal log line, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            result.logs.some((m) => m.includes('Deploy FAILED this cycle')),
            `An unhealed permission failure must surface through the phase's NORMAL failure path, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

// -----------------------------------------------------------------------------
// Criterion: "A NEVER_AUTO_GRANT rejection is a real terminal failure surfaced
// honestly - no retry loop, no bypass." The rejection is now the TOOL's own
// return string, inspected by the runner, not an agent's self-report.
// -----------------------------------------------------------------------------
test('mock sprint: a NEVER_AUTO_GRANT tool rejection propagates the original failure UNRETRIED', async () => {
    await withScenarioMarkers('permheal3', async () => {
        let deployCalls = 0;
        const composeCalls = [];
        const result = await runDevelopLoopScenario('permheal3', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permissions heal denylist scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            callTool: recordingCallTool(composeCalls, GRANT_DENIED),
            deployHandler: async () => {
                deployCalls++;
                return blockedDeploy;
            },
        });

        check(!result.error, `A denied grant must surface as a phase failure, not throw: ${result.error ? result.error.message : ''}`);
        check(composeCalls.length === 1, `Exactly one grant should have been attempted, got ${composeCalls.length}`);
        check(deployCalls === 1, `A terminal rejection must NOT retry the phase (1 dispatch only), got ${deployCalls}`);
        check(
            result.logs.some((m) => m.includes('permissions heal did NOT grant')
                && m.includes('compose_permissions rejected or did not confirm the grant')),
            `Expected the terminal-rejection log line, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            result.logs.some((m) => m.includes('Deploy FAILED this cycle') && m.includes('Cannot auto-grant dangerous permissions')),
            `The denial reason must be surfaced honestly on the phase failure, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

// -----------------------------------------------------------------------------
// Criterion (helper's own contract): the heal is best-effort -- a
// compose_permissions call that itself throws must leave the original failure
// in place and must never convert a phase failure into a thrown sprint abort.
// -----------------------------------------------------------------------------
test('mock sprint: a compose_permissions tool fault leaves the original missing-permissions failure in place and never aborts the sprint', async () => {
    await withScenarioMarkers('permheal4', async () => {
        let deployCalls = 0;
        const composeCalls = [];
        const result = await runDevelopLoopScenario('permheal4', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permissions heal tool fault scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            callTool: recordingCallTool(composeCalls, () => {
                throw new Error('mock MCP transport fault calling compose_permissions');
            }),
            deployHandler: async () => {
                deployCalls++;
                return blockedDeploy;
            },
        });

        check(!result.error, `A failed grant call must never abort the sprint: ${result.error ? result.error.message : ''}`);
        check(composeCalls.length === 1, `Expected exactly one grant attempt, got ${composeCalls.length}`);
        check(deployCalls === 1, `A failed grant must NOT retry the phase (1 dispatch only), got ${deployCalls}`);
        check(
            result.logs.some((m) => m.includes('compose_permissions threw') && m.includes('mock MCP transport fault')),
            `Expected the tool-fault log line, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            result.logs.some((m) => m.includes('Deploy FAILED this cycle')),
            `The original phase failure must still surface normally, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

// -----------------------------------------------------------------------------
// Criterion: "a phase with no blockedReason behaves exactly as today".
// -----------------------------------------------------------------------------
test('mock sprint: a Deploy failure with NO blockedReason takes the unchanged legacy path -- no grant at all', async () => {
    await withScenarioMarkers('permheal5', async () => {
        let deployCalls = 0;
        const composeCalls = [];
        const result = await runDevelopLoopScenario('permheal5', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permissions heal legacy path scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            callTool: recordingCallTool(composeCalls, GRANT_OK),
            deployHandler: async () => {
                deployCalls++;
                return {
                    content: [{ text: JSON.stringify({ deployed: false, notes: 'Smoke test failed: service never became healthy.' }) }],
                };
            },
        });

        check(!result.error, `An ordinary deploy failure must be unaffected by the heal helper: ${result.error ? result.error.message : ''}`);
        check(deployCalls === 1, `A deploy failure with no blockedReason must NOT be retried, got ${deployCalls} dispatches`);
        check(composeCalls.length === 0, `No grant may occur without blockedReason=missing_permissions, got ${composeCalls.length}`);
        check(
            result.logs.some((m) => m.includes('Deploy FAILED this cycle')),
            `The legacy deploy-failure path must be unchanged, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

// -----------------------------------------------------------------------------
// Criterion (finding 2 / option 2B): the permissions-composer LLM agent is GONE
// from the heal path. No scenario in this file supplies a
// permissionsComposerHandler, and the harness throws on a stray
// permissions-composer dispatch -- so this asserts by construction as well as
// by inspection of the dispatch record.
// -----------------------------------------------------------------------------
test('mock sprint: the heal dispatches NO permissions-composer agent -- the grant path has no LLM in it', async () => {
    await withScenarioMarkers('permheal10', async () => {
        let deployCalls = 0;
        const composeCalls = [];
        const result = await runDevelopLoopScenario('permheal10', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permissions heal no agent scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            callTool: recordingCallTool(composeCalls, GRANT_OK),
            deployHandler: async () => {
                deployCalls++;
                if (deployCalls === 1) return blockedDeploy;
                return { content: [{ text: JSON.stringify({ deployed: true, notes: 'Deployed.' }) }] };
            },
        });

        check(!result.error, `Scenario should not throw: ${result.error ? result.error.message : ''}`);
        check(composeCalls.length === 1, `The heal must still happen (via the tool), got ${composeCalls.length} grants`);
        check(
            !result.dispatched.some((d) => d.agent === 'permissions-composer'),
            `The dispatch record must contain no permissions-composer entry: ${JSON.stringify(result.dispatched.map((d) => d.agent))}`
        );
        check(
            !result.logs.some((m) => m.includes('dispatching permissions-composer')),
            `No composer dispatch log line may remain, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

// -----------------------------------------------------------------------------
// Criterion: "all three dispatch sites call the one helper (no copy-paste
// divergence)" -- site 2 of 3, the Integration Test runner (noteField
// 'summary', role integ-test-runner). Deploy succeeds normally here so the
// Integ phase is actually reached.
// -----------------------------------------------------------------------------
test('mock sprint: the Integ Test site heals through the SAME helper -- one grant, one integ retry', async () => {
    await withScenarioMarkers('permheal6', async () => {
        let integCalls = 0;
        const composeCalls = [];
        const result = await runDevelopLoopScenario('permheal6', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permissions heal integ site scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            callTool: recordingCallTool(composeCalls, GRANT_OK),
            integHandler: async ({ opts, tempDir: td }) => {
                integCalls++;
                if (integCalls === 1) {
                    return {
                        content: [{
                            text: JSON.stringify({
                                featuresClosed: 0,
                                issuesCreated: 0,
                                passed: false,
                                bugsFiled: [],
                                summary: 'integ-test-playbook.md Setup needs Bash(docker compose*), which this member is not permitted to run.',
                                blockedReason: 'missing_permissions',
                            }),
                        }],
                    };
                }
                // Post-grant retry: behave like the default mock (close the
                // verification-closure ids the prompt names) so the cycle can
                // complete normally off the healed result.
                const verifyMatch = opts.prompt.match(/verification-closure:\s*([^.]+)\./);
                const verifyIds = verifyMatch ? verifyMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
                for (const id of verifyIds) {
                    await runCmd(`bd close ${id} --reason "Verified against the deployed build."`, td);
                }
                return {
                    content: [{
                        text: JSON.stringify({
                            featuresClosed: verifyIds.length,
                            issuesCreated: 0,
                            passed: true,
                            bugsFiled: [],
                            summary: 'All e2e specs passed after the permission grant.',
                        }),
                    }],
                };
            },
        });

        check(!result.error, `Scenario should not throw on an integ permissions heal: ${result.error ? result.error.message : ''}`);
        check(composeCalls.length === 1, `Exactly ONE grant must precede the integ retry, got ${composeCalls.length}`);
        check(integCalls === 2, `Exactly ONE Integ Test retry must follow the grant (2 dispatches total), got ${integCalls}`);
        check(
            composeCalls[0].role === 'integ-test-runner',
            `The grant must carry the FAILING phase's role, got ${JSON.stringify(composeCalls[0].role)}`
        );
        check(
            composeCalls[0].grant_reason.includes('integ-test-playbook.md'),
            `The grant must be sourced from THIS phase's runbook, got ${JSON.stringify(composeCalls[0].grant_reason)}`
        );
        check(
            result.logs.some((m) => m.includes('Integ Test: reported blockedReason=missing_permissions') && m.includes('retrying this phase exactly once')),
            `Expected the integ-site heal log line (proving this site routes through the shared helper), logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.logs.some((m) => m.includes('Integration tests FAILED this cycle')),
            `An integ run that succeeds on the heal-retry must NOT be recorded as a test FAILURE, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

// -----------------------------------------------------------------------------
// Criterion: "all three dispatch sites call the one helper" -- site 3 of 3, the
// once-per-sprint Regression Test runner (noteField 'summary', role
// regression-test-runner, keyed on the FINAL cycle label rather than `cycle`).
// -----------------------------------------------------------------------------
test('mock sprint: the Regression Test site heals through the SAME helper -- one grant, one regression retry', async () => {
    await withScenarioMarkers('permheal7', async () => {
        let regressionCalls = 0;
        const composeCalls = [];
        const result = await runDevelopLoopScenario('permheal7', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permissions heal regression site scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            withRegressionPlaybook: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            callTool: recordingCallTool(composeCalls, GRANT_OK),
            regressionHandler: async () => {
                regressionCalls++;
                if (regressionCalls === 1) {
                    return {
                        content: [{
                            text: JSON.stringify({
                                passed: false,
                                suitePassed: false,
                                smokePassed: false,
                                bugsFiled: [],
                                summary: 'regression-test-playbook.md Setup needs Bash(docker compose*), which this member is not permitted to run.',
                                blockedReason: 'missing_permissions',
                            }),
                        }],
                    };
                }
                return {
                    content: [{
                        text: JSON.stringify({
                            passed: true,
                            suitePassed: true,
                            smokePassed: true,
                            bugsFiled: [],
                            summary: 'Full suite and sandbox smoke test both green after the permission grant.',
                        }),
                    }],
                };
            },
        });

        check(!result.error, `Scenario should not throw on a regression permissions heal: ${result.error ? result.error.message : ''}`);
        check(composeCalls.length === 1, `Exactly ONE grant must precede the regression retry, got ${composeCalls.length}`);
        check(regressionCalls === 2, `Exactly ONE Regression Test retry must follow the grant (2 dispatches total), got ${regressionCalls}`);
        check(
            composeCalls[0].role === 'regression-test-runner',
            `The grant must carry the FAILING phase's role, got ${JSON.stringify(composeCalls[0].role)}`
        );
        check(
            composeCalls[0].grant_reason.includes('regression-test-playbook.md'),
            `The grant must be sourced from THIS phase's runbook, got ${JSON.stringify(composeCalls[0].grant_reason)}`
        );
        check(
            result.logs.some((m) => m.includes('Regression Test: reported blockedReason=missing_permissions') && m.includes('retrying this phase exactly once')),
            `Expected the regression-site heal log line (proving this site routes through the shared helper), logs: ${JSON.stringify(result.logs)}`
        );
        check(
            result.logs.some((m) => m.includes('Regression pass PASSED')),
            `The healed regression retry's PASS verdict must be the one recorded, logs: ${JSON.stringify(result.logs)}`
        );
    });
});
