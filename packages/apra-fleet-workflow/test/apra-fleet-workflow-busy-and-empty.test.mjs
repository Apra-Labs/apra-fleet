import { test, describe } from 'node:test';
import assert from 'node:assert';
import { FleetWorkflow, AgentDispatchError } from '../src/workflow/index.mjs';

// Unit tests for two dispatch-resilience behaviors added after live
// auto-sprint failures (2026-07-19 stabilization loop -- see
// packages/apra-fleet-se/auto-sprint/docs/stabilization-log.md):
//
// 1. Busy-wait: a "busy" dispatch rejection ("execute_prompt is already
//    running for <member>") is transient-but-slow -- an orphaned prior
//    session can hold the per-member lock for minutes. agent() now polls
//    (cheap re-dispatch) until the lock frees or opts.busyWaitMs runs out,
//    instead of failing the step on the first rejection.
//
// 2. Empty-response detection: the fleet server can return success whose
//    text is ONLY the display wrapper ("\u{1F4CB} Response from X:\n\n" with an
//    empty parsed result, apra-fleet-eft.14). That is a dispatch-level
//    failure and must throw a typed AgentDispatchError (reason
//    'empty_response'), never be fed to schema extraction (where it
//    misreports as "LLM returned invalid JSON") nor returned as a garbage
//    success for no-schema calls.

const MEMBER = 'fleet-mock';

function busyResult() {
    return {
        content: [{ text: `❌ execute_prompt is already running for "${MEMBER}". Wait for the current call to finish before sending another.` }],
        structuredContent: { isError: true, reason: 'busy' },
    };
}

describe('agent() busy-wait', () => {
    test('busy twice then success: resolves, with exactly 3 dispatch attempts', async () => {
        let calls = 0;
        const wf = new FleetWorkflow({
            async executePrompt() {
                calls++;
                if (calls <= 2) return busyResult();
                return { content: [{ text: 'real answer' }] };
            },
        });

        const out = await wf.agent('do the thing', {
            member_name: MEMBER,
            busyWaitMs: 5000,
            busyPollMs: 10,
        });
        assert.strictEqual(out, 'real answer');
        assert.strictEqual(calls, 3, `expected original + 2 busy polls = 3 dispatches, got ${calls}`);
    });

    test('busy past the budget: throws the busy AgentDispatchError', async () => {
        let calls = 0;
        const wf = new FleetWorkflow({
            async executePrompt() {
                calls++;
                return busyResult();
            },
        });

        await assert.rejects(
            () => wf.agent('do the thing', { member_name: MEMBER, busyWaitMs: 50, busyPollMs: 10 }),
            (err) => {
                assert.ok(err instanceof AgentDispatchError);
                assert.strictEqual(err.details.reason, 'busy');
                return true;
            }
        );
        assert.ok(calls >= 2, `expected at least one poll beyond the original dispatch, got ${calls}`);
    });

    test('busyWaitMs: 0 disables the wait entirely (immediate throw, pre-existing behavior)', async () => {
        let calls = 0;
        const wf = new FleetWorkflow({
            async executePrompt() {
                calls++;
                return busyResult();
            },
        });

        await assert.rejects(
            () => wf.agent('do the thing', { member_name: MEMBER, busyWaitMs: 0 }),
            (err) => err instanceof AgentDispatchError && err.details.reason === 'busy'
        );
        assert.strictEqual(calls, 1, `expected exactly 1 dispatch with busy-wait disabled, got ${calls}`);
    });

    test('a non-busy dispatch error is NOT polled (no busy-wait retries)', async () => {
        let calls = 0;
        const wf = new FleetWorkflow({
            async executePrompt() {
                calls++;
                return {
                    content: [{ text: 'dispatch exploded' }],
                    structuredContent: { isError: true, reason: 'dispatch_failed' },
                };
            },
        });

        await assert.rejects(
            () => wf.agent('do the thing', { member_name: MEMBER, busyWaitMs: 5000, busyPollMs: 10 }),
            (err) => err instanceof AgentDispatchError && err.details.reason === 'dispatch_failed'
        );
        assert.strictEqual(calls, 1, `expected exactly 1 dispatch for a non-busy error, got ${calls}`);
    });
});

describe('agent() empty-response detection', () => {
    test('wrapper-only response (no schema) throws AgentDispatchError reason empty_response', async () => {
        const wf = new FleetWorkflow({
            async executePrompt() {
                // The exact 29-char shape observed live (apra-fleet-eft.14).
                return { content: [{ text: `\u{1F4CB} Response from ${MEMBER}:\n\n` }] };
            },
        });

        await assert.rejects(
            () => wf.agent('review the plan', { member_name: MEMBER }),
            (err) => {
                assert.ok(err instanceof AgentDispatchError);
                assert.strictEqual(err.details.reason, 'empty_response');
                return true;
            }
        );
    });

    test('wrapper + footers but empty result still throws empty_response', async () => {
        const wf = new FleetWorkflow({
            async executePrompt() {
                return { content: [{ text: `\u{1F4CB} Response from ${MEMBER}:\n\n\nTokens: input=10 output=0\n\n---\nsession: abc-123\n` }] };
            },
        });

        await assert.rejects(
            () => wf.agent('review the plan', { member_name: MEMBER, schema: { type: 'object' } }),
            (err) => err instanceof AgentDispatchError && err.details.reason === 'empty_response'
        );
    });

    test('a real wrapped response with content is untouched', async () => {
        const wf = new FleetWorkflow({
            async executePrompt() {
                return { content: [{ text: `\u{1F4CB} Response from ${MEMBER}:\n\nHere is my analysis.\nTokens: input=10 output=20\n\n---\nsession: abc-123` }] };
            },
        });

        const out = await wf.agent('analyze', { member_name: MEMBER });
        assert.ok(out.includes('Here is my analysis.'));
    });

    test('an unwrapped plain response is untouched', async () => {
        const wf = new FleetWorkflow({
            async executePrompt() {
                return { content: [{ text: 'plain mock answer' }] };
            },
        });
        const out = await wf.agent('hello', { member_name: MEMBER });
        assert.strictEqual(out, 'plain mock answer');
    });
});
