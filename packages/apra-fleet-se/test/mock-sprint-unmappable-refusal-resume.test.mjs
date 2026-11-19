// End-to-end mock sprints for the doer's one same-session resume after a
// refusal no permission grant can allow (dispatch-role.mjs,
// retry.unmappableRefusalResume on the doer row). execute_prompt is mocked to
// answer permission_denied (with the refused session id) carrying only
// unmappable denials:
//   1. the resumed call returns a schema-valid doer report -> the streak
//      succeeds with it: exactly two doer calls, the second resuming the same
//      session id, and the resume prompt names the refused call;
//   2. the resume is refused again -> the streak fails with the unmappable
//      remedy text, which gives no compose_permissions or rerun advice;
//   3. a grant-mappable refusal -> no resume; the progressive heal runs as
//      before.
//
// Reverting the resume (dispatch-role.mjs) makes scenario 1 fail: the streak
// fails on the first refusal and the doer is never called a second time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import {
    invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures,
} from '../fleet-sprint/dolt-sync.mjs';

const resetSyncMemo = () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
};
const assignedIds = (prompt) => {
    const match = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const approve = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});
const doerCalls = (scenario) => scenario.dispatched.filter((d) => d.agent === 'doer');

const CHAINED = 'npm test > /tmp/doer-test.log 2>&1 &';
const UNMAPPABLE = Object.freeze({
    actions: ['Bash'],
    denials: [{ action: 'Bash', target: CHAINED, suggestedGrants: [] }],
    suggestedGrants: [],
    hint: `claude refused Bash "${CHAINED}".`,
    signals: ['result_json'],
});
const MAPPABLE = Object.freeze({
    actions: ['Bash'],
    denials: [{ action: 'Bash', target: 'docker ps', suggestedGrants: ['Bash(docker:*)'] }],
    suggestedGrants: ['Bash(docker:*)'],
    hint: 'claude refused Bash "docker ps" for lack of a permission grant.',
    signals: ['result_json'],
});

// The session id the harness stamps on every reply (and recognises on a
// resumed dispatch).
const MOCK_SESSION_ID = 'mock-sprint-session-0001';

// The execute_prompt result the server returns when the member CLI refused
// tool calls: a failure with reason permission_denied, the refused session's
// id, and the (never used) partial reply.
function permissionDenied(block, sessionId = MOCK_SESSION_ID) {
    const reply = JSON.stringify({ status: 'VERIFY', closedIds: [], notes: 'Refused reply -- must never be used.' });
    return {
        content: [{ text: `[FAIL] execute_prompt on "local": permission denied -- ${block.hint}\n[partial response]\n${reply}` }],
        structuredContent: { isError: true, reason: 'permission_denied', permissionDenied: block, response: reply, sessionId },
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

const failureLine = (scenario, id) => scenario.logs.find((l) => l.includes(`Doer streak [${id}] dispatch on member 'local' was refused tool calls`)
    && l.includes('failed on refused tool calls'));

test('1. resume succeeds: the resumed schema-valid report is the streak result, two doer calls on the same session', { timeout: scaledTimeout(180000) }, async () => {
    resetSyncMemo();
    await withScenarioMarkers('unmappable refusal resume ok', async () => {
        const { factory } = composeFactory();
        let calls = 0;
        const scenario = await runDevelopLoopScenario('urr-ok', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: refused then resumed' }],
            maxCycles: 1,
            callToolFactory: factory,
            doerHandler: async ({ opts, runCmd: rc, tempDir: td }) => {
                calls += 1;
                if (calls === 1) return permissionDenied(UNMAPPABLE);
                // The resume: finish with plain commands and report cleanly.
                const ids = assignedIds(opts.prompt).length ? assignedIds(opts.prompt) : [];
                const list = JSON.parse((await rc('bd list --json', td)).stdout || '[]');
                const open = list.filter((b) => b.title === 'Task: refused then resumed').map((b) => b.id);
                for (const id of (ids.length ? ids : open)) await rc(`bd close ${id}`, td);
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids.length ? ids : open, notes: 'Finished with plain commands.' }) }] };
            },
            reviewerHandler: approve,
        });
        const id = scenario.tasks[0].id;
        const doers = doerCalls(scenario);
        assert.equal(doers.length, 2, `exactly two doer calls: ${JSON.stringify(doers.map((d) => d.resume))}`);
        assert.notEqual(doers[0].resume, MOCK_SESSION_ID, 'the first call is the streak dispatch, not a resume');
        assert.equal(doers[1].resume, MOCK_SESSION_ID, 'the second call resumes the refused session by its id');
        assert.ok(doers[1].prompt.includes(`Bash "${CHAINED}"`), `the resume prompt names the refused call: ${doers[1].prompt}`);
        assert.match(doers[1].prompt, /no permission grant\s+can ever allow them/);
        assert.equal(scenario.finalBeadsById.get(id).status, 'closed');
        assert.ok(!failureLine(scenario, id), 'the streak must not fail');
        assert.ok(scenario.logs.some((l) => l.includes(`Doer streak attribution [${id}]: closed=[${id}] failed=[]`)), 'the streak succeeds with the resumed report');
        assert.ok(!scenario.error, `no error expected: ${scenario.error && scenario.error.message}`);
    });
});

test('2. resume refused again: the streak fails with the unmappable remedy text, no compose_permissions or rerun advice', { timeout: scaledTimeout(180000) }, async () => {
    resetSyncMemo();
    await withScenarioMarkers('unmappable refusal resume refused again', async () => {
        const { factory } = composeFactory();
        let calls = 0;
        const scenario = await runDevelopLoopScenario('urr-again', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: refused twice' }],
            maxCycles: 1,
            callToolFactory: factory,
            doerHandler: async () => {
                calls += 1;
                return permissionDenied(UNMAPPABLE);
            },
            reviewerHandler: approve,
        });
        const id = scenario.tasks[0].id;
        const doers = doerCalls(scenario);
        assert.ok(doers.length >= 2, 'the refused dispatch was resumed once');
        assert.notEqual(doers[0].resume, MOCK_SESSION_ID);
        assert.equal(doers[1].resume, MOCK_SESSION_ID);
        const line = scenario.logs.find((l) => l.includes(`Doer streak [${id}] dispatch on member 'local' was refused tool calls that no permission grant can allow`)
            && l.includes('failed on refused tool calls'));
        assert.ok(line, `expected the unmappable failure line: ${JSON.stringify(scenario.logs.filter((l) => /refused/.test(l)))}`);
        assert.ok(!/compose_permissions/.test(line), line);
        assert.ok(!/rerun|re-run/i.test(line), line);
        // Each refused streak dispatch is resumed exactly once, never twice:
        // every resumed call directly follows a fresh streak dispatch.
        const resumed = doers.map((d) => d.resume === MOCK_SESSION_ID);
        assert.equal(resumed.filter(Boolean).length, resumed.filter((r) => !r).length, `one resume per streak dispatch: ${JSON.stringify(resumed)}`);
        resumed.forEach((r, i) => { if (r) assert.equal(resumed[i - 1], false, `resume ${i} must follow a streak dispatch: ${JSON.stringify(resumed)}`); });
    });
});

test('3. a grant-mappable refusal is not resumed; the progressive heal runs as before', { timeout: scaledTimeout(180000) }, async () => {
    resetSyncMemo();
    await withScenarioMarkers('unmappable refusal resume mappable control', async () => {
        const { composeCalls, factory } = composeFactory();
        const scenario = await runDevelopLoopScenario('urr-mappable', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: refused a grantable call' }],
            maxCycles: 1,
            callToolFactory: factory,
            doerHandler: async () => permissionDenied(MAPPABLE),
            reviewerHandler: approve,
        });
        const id = scenario.tasks[0].id;
        const doers = doerCalls(scenario);
        assert.ok(doers.length >= 1);
        assert.ok(!doers.some((d) => d.resume === MOCK_SESSION_ID), 'a mappable refusal is never resumed');
        assert.ok(!scenario.logs.some((l) => l.includes('its reply is NOT used; resuming session')), 'no unmappable resume');
        const line = failureLine(scenario, id);
        assert.ok(line, `expected the refused-call failure line: ${JSON.stringify(scenario.logs.filter((l) => /refused/.test(l)))}`);
        assert.ok(line.includes("To fix: run compose_permissions for member 'local'"), line);
        assert.ok(composeCalls.some((c) => c.dry_run), 'the heal read the composed policy');
    });
});
