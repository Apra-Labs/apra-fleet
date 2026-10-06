import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';
import { SprintPlanRejectedError, MemberPermissionDeniedError } from '../fleet-sprint/errors.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

// =============================================================================
// A plan-reviewer whose bd calls were refused ("This command requires
// approval": the member's composed permission config is missing, e.g. after a
// re-clone) used to come back as an ordinary CHANGES_NEEDED verdict whose notes
// were the refusal text, so the plan was "rejected" three times and the sprint
// died with SprintPlanRejectedError. execute_prompt now reports the refusal as
// reason 'permission_denied'; the dispatch engine heals it via
// compose_permissions (progressively, within the member's composed policy)
// and retries, and the refusal never counts as a plan round.
// =============================================================================

const DENIED_BLOCK = (rootId) => ({
    actions: ['Bash'],
    denials: [{ action: 'Bash', target: `bd show ${rootId}` }],
    suggestedGrants: ['Bash(bd:*)', `Bash(bd show ${rootId})`],
    hint: `claude refused Bash "bd show ${rootId}" for lack of a permission grant.`,
    signals: ['result_json'],
});

// The execute_prompt result the real server returns for a Claude result with
// a non-empty permission_denials (src/tools/execute-prompt.ts).
function permissionDeniedResult(rootId) {
    const block = DENIED_BLOCK(rootId);
    return {
        content: [{ text: `[FAIL] execute_prompt on "local": permission denied -- ${block.hint}\n[partial response]\nbd show was refused: This command requires approval. Verdict: CHANGES_NEEDED` }],
        structuredContent: {
            isError: true,
            reason: 'permission_denied',
            permissionDenied: block,
            response: 'bd show was refused: This command requires approval. Verdict: CHANGES_NEEDED',
        },
    };
}

const APPROVED = { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Plan covers implementation and tests.', taskAssignments: [] }) }] };

// Wraps the harness default callTool, recording compose_permissions calls and
// answering them with `composeResult`.
// A dry_run (the heal reading the member's composed policy) is answered with
// the doer base profile's bd rule unless `composeResult` is a failure.
function composeSpy(composeResult) {
    const composeCalls = [];
    const factory = (executeCommand) => {
        const base = defaultMockCallTool({ executeCommand });
        return async (name, args) => {
            if (name === 'compose_permissions') {
                composeCalls.push(args);
                if (args.dry_run && !composeResult.isError) {
                    return { content: [{ text: JSON.stringify({ dry_run: true, mode: args.role, stacks: [], allow: ['Read', 'Bash(git:*)', 'Bash(bd:*)', 'Bash(bd *)'] }) }] };
                }
                return composeResult;
            }
            return base(name, args);
        };
    };
    return { composeCalls, factory };
}

test('mock sprint: a plan-reviewer permission refusal is healed by compose_permissions and retried -- no plan round is charged', { timeout: scaledTimeout(120000) }, async () => {
    await withScenarioMarkers('planreviewpermheal', async () => {
        let plannerCalls = 0;
        const reviewerRounds = [];
        let reviewerCalls = 0;
        const { composeCalls, factory } = composeSpy({ content: [{ text: 'Permissions composed for local' }] });
        const scenario = await runDevelopLoopScenario('planreviewpermheal', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: plan-review permission heal scenario work' }],
            maxCycles: 1,
            callToolFactory: factory,
            plannerHandler: async () => {
                plannerCalls += 1;
                return { content: [{ text: 'Plan is in place.' }] };
            },
            planReviewerHandler: async ({ epicBead, planRound }) => {
                reviewerCalls += 1;
                reviewerRounds.push(planRound);
                return reviewerCalls === 1 ? permissionDeniedResult(epicBead.id) : APPROVED;
            },
        });

        assert.ok(!(scenario.error instanceof SprintPlanRejectedError), `the refusal must never become a plan rejection: ${scenario.error && scenario.error.message}`);
        assert.ok(!(scenario.error instanceof MemberPermissionDeniedError), `the healed retry must succeed: ${scenario.error && scenario.error.message}`);

        // Exactly one compose_permissions heal, for that member. The member
        // also serves doer in this single-member sprint, so it is composed as
        // doer -- never narrowed to reviewer -- and the first in-policy
        // suggestion (checked against the composed list from dry_run) is
        // granted in a second call, recorded in the member's ledger folder.
        assert.equal(composeCalls.filter((c) => c.dry_run).length, 1);
        const recompose = composeCalls.filter((c) => !c.grant && !c.dry_run);
        assert.equal(recompose.length, 1, `expected one re-compose, got ${JSON.stringify(composeCalls)}`);
        assert.equal(recompose[0].member_name, 'local');
        assert.equal(recompose[0].role, 'doer');
        assert.match(String(recompose[0].project_folder), /permission-ledgers[\\/]local$/);
        const grants = composeCalls.filter((c) => c.grant);
        assert.equal(grants.length, 1);
        assert.deepEqual(grants[0].grant, ['Bash(bd:*)']);
        assert.equal(grants[0].project_folder, recompose[0].project_folder);

        // The plan-review rejection counter is unchanged by the denial: one
        // planner round, and both plan-reviewer dispatches (refused, then
        // healed) belong to that same round 1.
        assert.equal(plannerCalls, 1, `the refusal must not trigger a second plan round (planner dispatched ${plannerCalls}x)`);
        assert.equal(reviewerCalls, 2);
        assert.ok(!scenario.logs.some((m) => /Plan C1 R2/.test(m)), 'no second plan round may start');
        assert.ok(!scenario.logs.some((m) => /Plan reviewer.*degrading|requires approval.*CHANGES_NEEDED/i.test(m) && /degrad/.test(m)),
            'the refusal must never be degraded into a verdict');
        assert.ok(scenario.logs.some((m) => /granted Bash\(bd:\*\) -- retrying/.test(m)), `expected the heal log line, logs: ${JSON.stringify(scenario.logs.filter((m) => /perm/i.test(m)))}`);

        // The sprint proceeded past planning to the doer.
        assert.ok(scenario.dispatched.some((d) => d.agent === 'doer' || (d.opts && d.opts.agent === 'doer')),
            `expected the sprint to reach a doer dispatch, got ${JSON.stringify(scenario.dispatched.map((d) => d.agent || (d.opts && d.opts.agent)))}`);
    });
});

test('mock sprint: a failing compose_permissions heal ends the sprint naming member, denied actions and fix -- not SprintPlanRejectedError', { timeout: scaledTimeout(120000) }, async () => {
    await withScenarioMarkers('planreviewpermhealfail', async () => {
        let plannerCalls = 0;
        let reviewerCalls = 0;
        const { composeCalls, factory } = composeSpy({ isError: true, content: [{ text: '[FAIL] compose_permissions could not reach member "local"' }] });
        const scenario = await runDevelopLoopScenario('planreviewpermhealfail', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: plan-review permission heal failure scenario work' }],
            maxCycles: 1,
            callToolFactory: factory,
            plannerHandler: async () => {
                plannerCalls += 1;
                return { content: [{ text: 'Plan is in place.' }] };
            },
            planReviewerHandler: async ({ epicBead }) => {
                reviewerCalls += 1;
                return permissionDeniedResult(epicBead.id);
            },
        });

        assert.ok(scenario.error, 'the sprint must end with an error');
        assert.ok(!(scenario.error instanceof SprintPlanRejectedError), 'SprintPlanRejectedError must NOT be the failure');
        assert.ok(scenario.error instanceof MemberPermissionDeniedError, `expected MemberPermissionDeniedError, got ${scenario.error && scenario.error.name}: ${scenario.error && scenario.error.message}`);
        const msg = scenario.error.message;
        assert.match(msg, /member 'local'/);
        assert.match(msg, new RegExp(`Bash "bd show ${scenario.epicBeadId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
        assert.match(msg, /To fix: run compose_permissions for member 'local' with role doer/);
        assert.match(msg, /could not reach member/);
        assert.equal(composeCalls.length, 1, 'one heal attempt only');
        assert.equal(reviewerCalls, 1, 'no retry after a failed heal');
        assert.equal(plannerCalls, 1, 'no plan-rejection rounds consumed');
    });
});
