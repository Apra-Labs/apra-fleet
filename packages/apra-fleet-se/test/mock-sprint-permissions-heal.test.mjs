import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-u1qw.2.2 / apra-fleet-u1qw.2: behavioural coverage for
// healMissingPermissionsOnce() -- the shared heal-and-retry helper the Deploy,
// Integration Test and Regression Test dispatch sites all call when a phase
// reports blockedReason='missing_permissions'.
//
// The parent feature's non-negotiable acceptance criteria are all about COUNTS
// and TERMINALITY, not about the happy path, so every test below asserts the
// number of composer dispatches and the number of phase dispatches -- a log
// line alone cannot distinguish "one heal" from "a heal loop".
//
// Deploy is used as the driver phase for the four count/terminality properties:
// it is the site the bead names, it has the smallest result schema, and it uses
// noteField='notes'. The last two tests then prove the OTHER two call sites
// (Integ Test and Regression Test, both noteField='summary') really do route
// through the same shared helper -- that is the bead's "all three dispatch
// sites call the one helper (no copy-paste divergence)" criterion, which a
// Deploy-only suite cannot establish.
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

// -----------------------------------------------------------------------------
// Criterion: "Exactly one permissions-composer dispatch (cheap tier) precedes
// exactly one retry of the original phase."
// -----------------------------------------------------------------------------
test('mock sprint: a Deploy missing_permissions triggers EXACTLY one cheap-tier composer dispatch and EXACTLY one Deploy retry', async () => {
    await withScenarioMarkers('permheal1', async () => {
        let deployCalls = 0;
        let composerCalls = 0;
        let composerModel = null;
        const result = await runDevelopLoopScenario('permheal1', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permissions heal happy retry scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            deployHandler: async () => {
                deployCalls++;
                // First attempt is blocked on a permission the runbook declares;
                // the retry (after the grant) succeeds.
                if (deployCalls === 1) return blockedDeploy;
                return {
                    content: [{ text: JSON.stringify({ deployed: true, notes: 'Deployed after the permission grant.' }) }],
                };
            },
            permissionsComposerHandler: async ({ opts }) => {
                composerCalls++;
                composerModel = opts.model;
                return {
                    content: [{
                        text: JSON.stringify({
                            composed: true,
                            grantedPrefixes: ['Bash(docker compose*)'],
                            terminalFailure: null,
                        }),
                    }],
                };
            },
        });

        check(!result.error, `Scenario should not throw on a permissions heal: ${result.error ? result.error.message : ''}`);
        check(composerCalls === 1, `Exactly ONE permissions-composer dispatch must precede the retry, got ${composerCalls}`);
        check(deployCalls === 2, `Exactly ONE Deploy retry must follow the grant (2 dispatches total), got ${deployCalls}`);
        check(composerModel === 'cheap', `The composer must be dispatched at the fixed CHEAP tier, got ${JSON.stringify(composerModel)}`);
        check(
            result.logs.some((m) => m.includes('Deploy: reported blockedReason=missing_permissions') && m.includes('retrying this phase exactly once')),
            `Expected the heal-dispatch log line, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.logs.some((m) => m.includes('Deploy FAILED this cycle')),
            `A Deploy that succeeds on the heal-retry must NOT be recorded as a cycle deploy failure, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

// -----------------------------------------------------------------------------
// Criterion: "A second consecutive missing_permissions failure in the same cycle
// does not trigger a second heal (single-retry, no loop)."
// -----------------------------------------------------------------------------
test('mock sprint: a SECOND consecutive missing_permissions in the same cycle is terminal -- no second composer dispatch, no loop', async () => {
    await withScenarioMarkers('permheal2', async () => {
        let deployCalls = 0;
        let composerCalls = 0;
        const result = await runDevelopLoopScenario('permheal2', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permissions heal terminal repeat scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            deployHandler: async () => {
                deployCalls++;
                // The grant did not actually unblock it: the retry reports the
                // very same blockedReason. That must be terminal, not a loop.
                return blockedDeploy;
            },
            permissionsComposerHandler: async () => {
                composerCalls++;
                return {
                    content: [{
                        text: JSON.stringify({ composed: true, grantedPrefixes: ['Bash(docker compose*)'], terminalFailure: null }),
                    }],
                };
            },
        });

        check(!result.error, `A repeated missing_permissions must surface as a phase failure, not throw: ${result.error ? result.error.message : ''}`);
        check(composerCalls === 1, `The per-cycle guard must allow only ONE composer dispatch per phase per cycle, got ${composerCalls}`);
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
// honestly - no retry loop, no bypass."
// -----------------------------------------------------------------------------
test('mock sprint: a NEVER_AUTO_GRANT composer rejection propagates the original failure UNRETRIED', async () => {
    await withScenarioMarkers('permheal3', async () => {
        let deployCalls = 0;
        let composerCalls = 0;
        const result = await runDevelopLoopScenario('permheal3', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permissions heal denylist scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            deployHandler: async () => {
                deployCalls++;
                return blockedDeploy;
            },
            permissionsComposerHandler: async () => {
                composerCalls++;
                return {
                    content: [{
                        text: JSON.stringify({
                            composed: false,
                            grantedPrefixes: [],
                            terminalFailure: 'Bash(sudo*) is NEVER_AUTO_GRANT and was rejected.',
                        }),
                    }],
                };
            },
        });

        check(!result.error, `A denied grant must surface as a phase failure, not throw: ${result.error ? result.error.message : ''}`);
        check(composerCalls === 1, `Exactly one composer dispatch should have been attempted, got ${composerCalls}`);
        check(deployCalls === 1, `A terminal composer rejection must NOT retry the phase (1 dispatch only), got ${deployCalls}`);
        check(
            result.logs.some((m) => m.includes('permissions-composer did NOT grant') && m.includes('NEVER_AUTO_GRANT rejection is never retried')),
            `Expected the terminal-rejection log line, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            result.logs.some((m) => m.includes('Deploy FAILED this cycle') && m.includes('NEVER_AUTO_GRANT')),
            `The denial reason must be surfaced honestly on the phase failure, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

// -----------------------------------------------------------------------------
// Criterion (helper's own contract): the heal is best-effort -- a composer
// dispatch that itself fails must leave the original failure in place and must
// never convert a phase failure into a thrown sprint abort.
// -----------------------------------------------------------------------------
test('mock sprint: a composer dispatch failure leaves the original missing-permissions failure in place and never aborts the sprint', async () => {
    await withScenarioMarkers('permheal4', async () => {
        let deployCalls = 0;
        let composerCalls = 0;
        const result = await runDevelopLoopScenario('permheal4', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permissions heal composer dispatch failure scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            deployHandler: async () => {
                deployCalls++;
                return blockedDeploy;
            },
            permissionsComposerHandler: async () => {
                composerCalls++;
                // Infrastructure fault on the composer dispatch itself
                // (AgentDispatchError), not a composer verdict.
                return {
                    content: [{ text: 'command killed after inactivity timeout (no output)' }],
                    structuredContent: { isError: true, reason: 'dispatch_failed' },
                };
            },
        });

        check(!result.error, `A failed composer dispatch must never abort the sprint: ${result.error ? result.error.message : ''}`);
        check(composerCalls >= 1, `Expected at least one composer dispatch attempt, got ${composerCalls}`);
        check(deployCalls === 1, `A failed composer dispatch must NOT retry the phase (1 dispatch only), got ${deployCalls}`);
        check(
            result.logs.some((m) => m.includes('permissions-composer dispatch failed') && m.includes('no retry')),
            `Expected the composer-dispatch-failure log line, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            result.logs.some((m) => m.includes('Deploy FAILED this cycle')),
            `The original phase failure must still surface normally, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

// -----------------------------------------------------------------------------
// Criterion: "a phase with no blockedReason behaves exactly as today".
// NOTE: this scenario deliberately supplies NO permissionsComposerHandler, so a
// stray composer dispatch blows up on the harness's
// "permissions-composer dispatched but this scenario supplied no
// permissionsComposerHandler" throw -- the strongest possible assertion that
// the early return holds, since it fails by construction rather than by the
// absence of a log line.
// -----------------------------------------------------------------------------
test('mock sprint: a Deploy failure with NO blockedReason takes the unchanged legacy path -- no composer dispatch at all', async () => {
    await withScenarioMarkers('permheal5', async () => {
        let deployCalls = 0;
        const result = await runDevelopLoopScenario('permheal5', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permissions heal legacy path scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
            deployHandler: async () => {
                deployCalls++;
                return {
                    content: [{ text: JSON.stringify({ deployed: false, notes: 'Smoke test failed: service never became healthy.' }) }],
                };
            },
        });

        check(!result.error, `An ordinary deploy failure must be unaffected by the heal helper: ${result.error ? result.error.message : ''}`);
        check(deployCalls === 1, `A deploy failure with no blockedReason must NOT be retried, got ${deployCalls} dispatches`);
        check(
            !result.logs.some((m) => m.includes('permissions-composer')),
            `No composer dispatch may occur without blockedReason=missing_permissions, logs: ${JSON.stringify(result.logs)}`
        );
        check(
            !result.dispatched.some((d) => d.agent === 'permissions-composer'),
            `The dispatch record itself must contain no permissions-composer entry: ${JSON.stringify(result.dispatched.map((d) => d.agent))}`
        );
        check(
            result.logs.some((m) => m.includes('Deploy FAILED this cycle')),
            `The legacy deploy-failure path must be unchanged, logs: ${JSON.stringify(result.logs)}`
        );
    });
});

// -----------------------------------------------------------------------------
// Criterion: "all three dispatch sites call the one helper (no copy-paste
// divergence)" -- site 2 of 3, the Integration Test runner (noteField
// 'summary', role integ-test-runner). Deploy succeeds normally here so the
// Integ phase is actually reached.
// -----------------------------------------------------------------------------
test('mock sprint: the Integ Test site heals through the SAME helper -- one composer dispatch, one integ retry', async () => {
    await withScenarioMarkers('permheal6', async () => {
        let integCalls = 0;
        let composerCalls = 0;
        let composerModel = null;
        let composerPrompt = '';
        const result = await runDevelopLoopScenario('permheal6', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permissions heal integ site scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
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
            permissionsComposerHandler: async ({ opts }) => {
                composerCalls++;
                composerModel = opts.model;
                composerPrompt = opts.prompt;
                return {
                    content: [{
                        text: JSON.stringify({ composed: true, grantedPrefixes: ['Bash(docker compose*)'], terminalFailure: null }),
                    }],
                };
            },
        });

        check(!result.error, `Scenario should not throw on an integ permissions heal: ${result.error ? result.error.message : ''}`);
        check(composerCalls === 1, `Exactly ONE composer dispatch must precede the integ retry, got ${composerCalls}`);
        check(integCalls === 2, `Exactly ONE Integ Test retry must follow the grant (2 dispatches total), got ${integCalls}`);
        check(composerModel === 'cheap', `The composer must be dispatched at the fixed CHEAP tier, got ${JSON.stringify(composerModel)}`);
        check(
            composerPrompt.includes('phase = integ-test-runner'),
            `The composer prompt must name the FAILING phase's role, got: ${JSON.stringify(composerPrompt.slice(0, 400))}`
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
test('mock sprint: the Regression Test site heals through the SAME helper -- one composer dispatch, one regression retry', async () => {
    await withScenarioMarkers('permheal7', async () => {
        let regressionCalls = 0;
        let composerCalls = 0;
        let composerPrompt = '';
        const result = await runDevelopLoopScenario('permheal7', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permissions heal regression site scenario work' }],
            maxCycles: 1,
            withRunbooks: true,
            withRegressionPlaybook: true,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approveReviewer,
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
            permissionsComposerHandler: async ({ opts }) => {
                composerCalls++;
                composerPrompt = opts.prompt;
                return {
                    content: [{
                        text: JSON.stringify({ composed: true, grantedPrefixes: ['Bash(docker compose*)'], terminalFailure: null }),
                    }],
                };
            },
        });

        check(!result.error, `Scenario should not throw on a regression permissions heal: ${result.error ? result.error.message : ''}`);
        check(composerCalls === 1, `Exactly ONE composer dispatch must precede the regression retry, got ${composerCalls}`);
        check(regressionCalls === 2, `Exactly ONE Regression Test retry must follow the grant (2 dispatches total), got ${regressionCalls}`);
        check(
            composerPrompt.includes('phase = regression-test-runner'),
            `The composer prompt must name the FAILING phase's role, got: ${JSON.stringify(composerPrompt.slice(0, 400))}`
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
