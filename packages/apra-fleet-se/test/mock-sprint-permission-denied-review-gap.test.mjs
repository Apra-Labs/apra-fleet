import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';

// =============================================================================
// A doer streak whose final turn had a tool call refused AFTER the doer
// closed its bead (seen live: a chained, backgrounded command was refused,
// the doer had already committed and closed, and returned a complete
// report). The streak still fails (permission_denied is a failed dispatch),
// but:
//   (a) when every refused call maps to no permission grant, the failure
//       text says no grant can allow the call and gives no compose_permissions
//       or rerun advice (no grant could ever make a rerun pass);
//   (b) the bead that failed streak closed is in that round's Review scope,
//       so it never reaches Integration Test unreviewed;
//   (c) control: a refusal with a suggested grant (here outside the member's
//       composed policy) still gets the compose_permissions remedy.
//
// Reverting the dispatch-role.mjs change (the no-grant failure text) makes
// (a) fail; reverting the phases/develop.mjs change (recording a doer ladder
// ended by MemberPermissionDeniedError as a failed-streak outcome) makes (b)
// fail -- the streak then vanishes from the round's outcomes and its closed
// bead is never reviewed.
// =============================================================================

const resetSyncMemo = () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
};
const assignedIds = (opts) => {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const reviewScopeIds = (d) => {
    const match = d.prompt.match(/Review the work just done for the following bead id\(s\):\s*(.+)\./);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const developReviews = (scenario) => scenario.dispatched.filter((d) => d.agent === 'reviewer' && d.label !== 'Final Review');
const approve = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});

const CHAINED = 'npm test > /tmp/doer-test.log 2>&1 &';

// The execute_prompt result the server returns when the member CLI refused
// tool calls (src/tools/execute-prompt.ts): a failure with reason
// permission_denied, the doer's own (complete) report as the partial response.
function permissionDeniedResult(block, closedId) {
    const reply = JSON.stringify({ status: 'VERIFY', closedIds: [closedId], notes: 'Done; background test run was refused.' });
    return {
        content: [{ text: `[FAIL] execute_prompt on "local": permission denied -- ${block.hint}\n[partial response]\n${reply}` }],
        structuredContent: { isError: true, reason: 'permission_denied', permissionDenied: block, response: reply },
    };
}

// compose_permissions stand-in: a dry_run answers with the doer's composed
// allow list; anything else succeeds.
function composeFactory() {
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

// Runs one doer streak that closes its bead and then reports `block` as
// refused; returns the scenario plus the bead id.
async function refusedAfterClose(tag, block, title) {
    const { composeCalls, factory } = composeFactory();
    let doerCalls = 0;
    const scenario = await runDevelopLoopScenario(tag, {
        members: ['local'],
        taskSpecs: [{ title }],
        maxCycles: 1,
        callToolFactory: factory,
        doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
            doerCalls += 1;
            const ids = assignedIds(opts);
            for (const id of ids) await rc(`bd close ${id}`, td);
            return permissionDeniedResult(block, ids[0]);
        },
        reviewerHandler: approve,
    });
    const id = scenario.tasks.find((t) => t.title === title).id;
    return { scenario, id, composeCalls, doerCalls };
}

// The failure text, wherever the run logged it.
const failureLine = (scenario, id) => scenario.logs.find((l) => l.includes(`Doer streak [${id}] dispatch on member 'local' was refused tool calls`));

test('(a)+(b) every refused call maps to no grant: no compose_permissions/rerun advice, and the closed bead is still reviewed', { timeout: scaledTimeout(180000) }, async () => {
    resetSyncMemo();
    await withScenarioMarkers('perm-denied review gap unmappable', async () => {
        const block = {
            actions: ['Bash'],
            denials: [{ action: 'Bash', target: CHAINED, suggestedGrants: [] }],
            suggestedGrants: [],
            hint: `claude refused Bash "${CHAINED}".`,
            signals: ['result_json'],
        };
        const { scenario, id, doerCalls } = await refusedAfterClose('pdrg-unmappable', block, 'Task: refused after closing');
        // No grant was added, so the heal never re-dispatches; the doer's one
        // same-session resume after an unmappable refusal is the only second
        // call, and it is refused again.
        assert.equal(doerCalls, 2, 'exactly one resume after the unmappable refusal, no heal re-dispatch');

        // (a) the failure text.
        const line = failureLine(scenario, id);
        assert.ok(line, `expected the refused-call failure line, logs: ${JSON.stringify(scenario.logs.filter((l) => /refused/.test(l)))}`);
        assert.ok(line.includes(`no permission grant can allow: Bash "${CHAINED}"`), line);
        assert.ok(!/compose_permissions/.test(line), `no compose_permissions advice: ${line}`);
        assert.ok(!/rerun|re-run/i.test(line), `no rerun advice: ${line}`);

        // (b) the bead that failed streak closed is reviewed in that round.
        assert.equal(scenario.finalBeadsById.get(id).status, 'closed');
        const reviews = developReviews(scenario);
        assert.ok(reviews.length >= 1, `the round must dispatch a Review: ${JSON.stringify(scenario.dispatched.map((d) => [d.agent, d.label]))}`);
        assert.deepEqual(reviewScopeIds(reviews[0]), [id], 'the closed bead of the failed streak is in Review C1 R1');
    });
});

test('(c) control: a refusal with a suggested grant still gets the compose_permissions remedy', { timeout: scaledTimeout(180000) }, async () => {
    resetSyncMemo();
    await withScenarioMarkers('perm-denied review gap mappable', async () => {
        // The suggested grant is outside the member's composed policy, so the
        // heal stops (no_progress, rejected grant) and names it for an operator.
        const block = {
            actions: ['Bash'],
            denials: [{ action: 'Bash', target: 'docker ps', suggestedGrants: ['Bash(docker:*)'] }],
            suggestedGrants: ['Bash(docker:*)'],
            hint: 'claude refused Bash "docker ps" for lack of a permission grant.',
            signals: ['result_json'],
        };
        const { scenario, id, composeCalls } = await refusedAfterClose('pdrg-mappable', block, 'Task: refused a grantable call');
        const line = failureLine(scenario, id);
        assert.ok(line, `expected the refused-call failure line, logs: ${JSON.stringify(scenario.logs.filter((l) => /refused/.test(l)))}`);
        assert.ok(line.includes("To fix: run compose_permissions for member 'local'"), line);
        assert.ok(line.includes('Bash(docker:*)'), line);
        assert.ok(!line.includes('no permission grant can allow'), line);
        assert.ok(composeCalls.some((c) => c.dry_run), 'the heal read the composed policy');
        assert.ok(!composeCalls.some((c) => c.grant), 'an out-of-policy grant is never sent');
    });
});
