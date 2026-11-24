// End-to-end mock sprints for the one same-session resume after a refusal no
// permission grant can allow, on the NON-doer roles (dispatch-role.mjs,
// retry.unmappableRefusalResume on every role row; the doer's own scenarios
// live in mock-sprint-unmappable-refusal-resume.test.mjs). execute_prompt is
// mocked to answer permission_denied (with the refused session id) carrying
// only unmappable denials (a backgrounded, redirected shell command):
//   (a) the planner is refused once and resumed: exactly two planner calls, the
//       second resumes the same session id with the refusal notice naming the
//       refused call first in its prompt, and the sprint proceeds past Plan;
//   (b) the same for the deployer: one refusal, one resume, the sprint proceeds
//       to Integration Test;
//   (c) the resume is refused again: the run fails loudly with
//       MemberPermissionDeniedError naming the member and the refused call, and
//       there is no third call (planner and deployer);
//   (d) in none of these does compose_permissions run for real (no non-dry-run
//       call) or any grant get recorded for the refused call (no loop or
//       compound prefix such as Bash(for:*)).
//
// Reverting the non-doer policy rows to unmappableRefusalResume false makes
// (a) and (b) fail: the run ends on the first refusal (MemberPermissionDeniedError)
// and the planner/deployer is never called a second time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool, runCmd } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { MemberPermissionDeniedError } from '../fleet-sprint/errors.mjs';
import { unmappableRefusalResumeNotice } from '../fleet-sprint/dispatch-role.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';

const resetSyncMemo = () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
};

const CHAINED = 'npm run deploy > /tmp/deploy.log 2>&1 &';
const UNMAPPABLE = Object.freeze({
    actions: ['Bash'],
    denials: [{ action: 'Bash', target: CHAINED, suggestedGrants: [] }],
    suggestedGrants: [],
    hint: `claude refused Bash "${CHAINED}".`,
    signals: ['result_json'],
});

// The session id the harness stamps on every reply (and recognises on a resume).
const MOCK_SESSION_ID = 'mock-sprint-session-0001';

function permissionDenied(block, sessionId = MOCK_SESSION_ID) {
    const reply = 'Refused reply -- must never be used.';
    return {
        content: [{ text: `[FAIL] execute_prompt on "local": permission denied -- ${block.hint}\n[partial response]\n${reply}` }],
        structuredContent: { isError: true, reason: 'permission_denied', permissionDenied: block, response: reply, sessionId },
    };
}

// compose_permissions stand-in that RECORDS every call; a dry_run answers with
// a composed allow list, anything else succeeds.
function composeSpy() {
    const composeCalls = [];
    const factory = (executeCommand) => {
        const base = defaultMockCallTool({ executeCommand });
        return async (name, args) => {
            if (name === 'compose_permissions') {
                composeCalls.push(args);
                if (args.dry_run) {
                    return { content: [{ text: JSON.stringify({ dry_run: true, mode: args.role, stacks: [], allow: ['Read', 'Bash(git:*)', 'Bash(bd:*)', 'Bash(bd *)'] }) }] };
                }
                return { content: [{ text: 'Permissions composed for local' }] };
            }
            return base(name, args);
        };
    };
    return { composeCalls, factory };
}

// (d): no real compose, and nothing recorded that could allow the refused call.
const assertNoGrant = (composeCalls) => {
    assert.deepEqual(composeCalls.filter((c) => !c.dry_run), [], 'no compose_permissions write may come from an unmappable refusal');
    const text = JSON.stringify(composeCalls);
    assert.ok(!text.includes('Bash(for') && !text.includes(CHAINED) && !text.includes('npm run deploy'), `no grant for the refused call: ${text}`);
};

const closeAssignedDoer = async ({ opts, tempDir }) => {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    for (const id of ids) await runCmd(`bd close ${id}`, tempDir);
    return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'Closed all assigned beads.' }) }] };
};
const approve = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});
const rubberStampPass = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'PASS.' }) }],
});
const approvedPlan = { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Plan covers implementation and tests.', taskAssignments: [] }) }] };

const callsOf = (scenario, agent) => scenario.dispatched.filter((d) => d.agent === agent);

test('(a) planner refused once is resumed in the same session; the sprint proceeds past Plan', { timeout: scaledTimeout(180000) }, async () => {
    resetSyncMemo();
    await withScenarioMarkers('urr-roles planner ok', async () => {
        const { composeCalls, factory } = composeSpy();
        let plannerCalls = 0;
        const scenario = await runDevelopLoopScenario('urr-planner-ok', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: planner refused then resumed' }],
            maxCycles: 1,
            callToolFactory: factory,
            plannerHandler: async () => {
                plannerCalls += 1;
                if (plannerCalls === 1) return permissionDenied(UNMAPPABLE);
                return { content: [{ text: 'Plan is in place.' }] };
            },
            planReviewerHandler: async () => approvedPlan,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approve,
        });
        const planners = callsOf(scenario, 'planner').filter((d) => !/Streak Assignment/i.test(d.label || ''));
        assert.equal(planners.length, 2, `exactly two planner calls: ${JSON.stringify(planners.map((d) => d.resume))}`);
        assert.notEqual(planners[0].resume, MOCK_SESSION_ID, 'the first call is the main dispatch, not a resume');
        assert.equal(planners[1].resume, MOCK_SESSION_ID, 'the second call resumes the refused session by its id');
        assert.ok(planners[1].prompt.startsWith(unmappableRefusalResumeNotice([`Bash "${CHAINED}"`])), planners[1].prompt);
        assert.ok(planners[1].prompt.includes(`Bash "${CHAINED}"`));
        assert.ok(callsOf(scenario, 'doer').length >= 1, 'the sprint proceeds past Plan into Develop');
        assert.ok(!scenario.error, `no abort expected: ${scenario.error && scenario.error.message}`);
        assertNoGrant(composeCalls);
    });
});

test('(b) deployer refused once is resumed in the same session; its resumed report is used and the sprint proceeds', { timeout: scaledTimeout(180000) }, async () => {
    resetSyncMemo();
    await withScenarioMarkers('urr-roles deployer ok', async () => {
        const { composeCalls, factory } = composeSpy();
        let deployCalls = 0;
        const scenario = await runDevelopLoopScenario('urr-deployer-ok', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: deployer refused then resumed' }],
            maxCycles: 1,
            withRunbooks: true,
            callToolFactory: factory,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approve,
            deployHandler: async () => {
                deployCalls += 1;
                if (deployCalls === 1) return permissionDenied(UNMAPPABLE);
                return { content: [{ text: JSON.stringify({ deployed: true, notes: 'Deployed with plain commands after the resume.' }) }] };
            },
            finalReviewHandler: rubberStampPass,
        });
        const deployers = callsOf(scenario, 'deployer');
        assert.equal(deployers.length, 2, `exactly two deployer calls: ${JSON.stringify(deployers.map((d) => d.resume))}`);
        assert.notEqual(deployers[0].resume, MOCK_SESSION_ID);
        assert.equal(deployers[1].resume, MOCK_SESSION_ID, 'the second call resumes the refused session by its id');
        assert.ok(deployers[1].prompt.startsWith(unmappableRefusalResumeNotice([`Bash "${CHAINED}"`])), deployers[1].prompt);
        assert.ok(callsOf(scenario, 'integ-test-runner').length >= 1, 'the resumed deploy report is used: the sprint proceeds to Integration Test');
        assert.ok(!scenario.logs.some((l) => /Deploy SET ASIDE/.test(l)), 'the refused reply was not treated as a failed deploy');
        assert.ok(!scenario.error, `no abort expected: ${scenario.error && scenario.error.message}`);
        assertNoGrant(composeCalls);
    });
});

test('(c) planner resume refused again: fails loudly with MemberPermissionDeniedError naming the member and call; no third call', { timeout: scaledTimeout(180000) }, async () => {
    resetSyncMemo();
    await withScenarioMarkers('urr-roles planner again', async () => {
        const { composeCalls, factory } = composeSpy();
        const scenario = await runDevelopLoopScenario('urr-planner-again', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: planner refused twice' }],
            maxCycles: 1,
            callToolFactory: factory,
            plannerHandler: async () => permissionDenied(UNMAPPABLE),
            planReviewerHandler: async () => approvedPlan,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approve,
        });
        const planners = callsOf(scenario, 'planner').filter((d) => !/Streak Assignment/i.test(d.label || ''));
        assert.equal(planners.length, 2, `one resume, never a third call: ${JSON.stringify(planners.map((d) => d.resume))}`);
        assert.equal(planners[1].resume, MOCK_SESSION_ID);
        assert.ok(scenario.error instanceof MemberPermissionDeniedError, `expected MemberPermissionDeniedError: ${scenario.error}`);
        assert.ok(scenario.error.message.includes('local'), scenario.error.message);
        assert.ok(scenario.error.message.includes(CHAINED), scenario.error.message);
        assert.equal(callsOf(scenario, 'doer').length, 0, 'the sprint does not proceed');
        assertNoGrant(composeCalls);
    });
});

test('(c) deployer resume refused again: fails loudly with MemberPermissionDeniedError naming the member and call; no third call', { timeout: scaledTimeout(180000) }, async () => {
    resetSyncMemo();
    await withScenarioMarkers('urr-roles deployer again', async () => {
        const { composeCalls, factory } = composeSpy();
        const scenario = await runDevelopLoopScenario('urr-deployer-again', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: deployer refused twice' }],
            maxCycles: 1,
            withRunbooks: true,
            callToolFactory: factory,
            doerHandler: closeAssignedDoer,
            reviewerHandler: approve,
            deployHandler: async () => permissionDenied(UNMAPPABLE),
            finalReviewHandler: rubberStampPass,
        });
        const deployers = callsOf(scenario, 'deployer');
        assert.equal(deployers.length, 2, `one resume, never a third call: ${JSON.stringify(deployers.map((d) => d.resume))}`);
        assert.equal(deployers[1].resume, MOCK_SESSION_ID);
        assert.ok(scenario.error instanceof MemberPermissionDeniedError, `expected MemberPermissionDeniedError: ${scenario.error}`);
        assert.ok(scenario.error.message.includes('local'), scenario.error.message);
        assert.ok(scenario.error.message.includes(CHAINED), scenario.error.message);
        assert.equal(callsOf(scenario, 'integ-test-runner').length, 0, 'the sprint does not proceed to Integration Test');
        assertNoGrant(composeCalls);
    });
});
