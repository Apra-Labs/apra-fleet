import { test, describe } from 'node:test';
import assert from 'node:assert';
import { FleetWorkflow, AgentDispatchError } from '../src/workflow/index.mjs';

// Unit tests for two dispatch-resilience behaviors added after live
// auto-sprint failures (2026-07-19 stabilization loop -- see
// packages/apra-fleet-se/fleet-sprint/docs/stabilization-log.md):
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

describe('agent() top-level isError (server-side throw marshalled by the MCP SDK)', () => {
    // apra-fleet-c98q.6 regression: when execute_prompt throws server-side
    // (e.g. an SSH channel drop inside writePromptFile, before any
    // structuredContent envelope exists), the MCP SDK marshals the
    // exception into a plain CallToolResult with a TOP-LEVEL `isError: true`
    // and NO structuredContent -- whose only text is the raw exception
    // message. This must be classified as a dispatch failure, exactly like
    // the structured-isError branch above, and must never be handed to the
    // schema/JSON extractor (which would misreport it as an "LLM returned
    // invalid JSON" failure and burn a schema-repair attempt re-asking a
    // member whose lock may already be wedged).
    //
    // The literal wording of the stubbed text ("No response from server") is
    // test input only, not the assertion mechanism -- these tests check the
    // dispatch-failure CLASSIFICATION (isError -> AgentDispatchError with a
    // generic transport/dispatch_failed reason, zero repair attempts),
    // never a string match on that text.

    function topLevelIsErrorResult() {
        return {
            isError: true,
            content: [{ type: 'text', text: 'No response from server' }],
            // Deliberately no structuredContent -- this is exactly the shape
            // the MCP SDK produces for a server-side throw.
        };
    }

    test('no output schema: rejects with AgentDispatchError, generic reason, zero repair attempts', async () => {
        let calls = 0;
        const wf = new FleetWorkflow({
            async executePrompt() {
                calls++;
                return topLevelIsErrorResult();
            },
        });

        const starts = [];
        const ends = [];
        wf.on('activity:start', (meta) => starts.push(meta));
        wf.on('activity:end', (meta) => ends.push(meta));

        await assert.rejects(
            () => wf.agent('do the thing', { member_name: MEMBER }),
            (err) => {
                assert.ok(err instanceof AgentDispatchError);
                // Never mistaken for a JSON-parse/schema failure: only the
                // two generic dispatch-failure reasons are acceptable here.
                assert.ok(
                    err.details.reason === 'transport' || err.details.reason === 'dispatch_failed',
                    `expected reason 'transport' or 'dispatch_failed', got ${err.details.reason}`
                );
                return true;
            }
        );

        // Exactly one dispatch attempt -- the schema-repair loop never ran
        // (there is no schema here, but the assertion below also covers the
        // "never charged a repair attempt" requirement generically).
        assert.strictEqual(calls, 1, `expected exactly 1 dispatch, got ${calls}`);

        // The activity record for the failed attempt is success:false with
        // the error text preserved, and repairAttempt stayed at 0 (no
        // schema-repair round was ever started).
        assert.strictEqual(starts.length, 1, 'expected exactly one activity:start (no repair attempts)');
        assert.strictEqual(starts[0].repairAttempt, 0);
        assert.strictEqual(ends.length, 1, 'expected exactly one activity:end (no repair attempts)');
        assert.strictEqual(ends[0].success, false);
        assert.ok(ends[0].error, 'expected the activity:end record to preserve the error text');
    });

    test('with an output schema: still a dispatch failure, still zero repair attempts', async () => {
        let calls = 0;
        const wf = new FleetWorkflow({
            async executePrompt() {
                calls++;
                return topLevelIsErrorResult();
            },
        });

        const starts = [];
        wf.on('activity:start', (meta) => starts.push(meta));

        await assert.rejects(
            () => wf.agent('review the plan', { member_name: MEMBER, schema: { type: 'object' } }),
            (err) => {
                assert.ok(err instanceof AgentDispatchError);
                assert.ok(
                    err.details.reason === 'transport' || err.details.reason === 'dispatch_failed',
                    `expected reason 'transport' or 'dispatch_failed', got ${err.details.reason}`
                );
                return true;
            }
        );

        // A schema is present (maxRepairs would be 2), yet the dispatch
        // failure must short-circuit the repair loop entirely: exactly one
        // dispatch, exactly one activity:start at repairAttempt 0.
        assert.strictEqual(calls, 1, `expected exactly 1 dispatch (no schema-repair rounds), got ${calls}`);
        assert.strictEqual(starts.length, 1, 'expected exactly one activity:start (no repair attempts)');
        assert.strictEqual(starts[0].repairAttempt, 0);
    });

    test('control: a normal successful result with structuredContent still parses and succeeds', async () => {
        const wf = new FleetWorkflow({
            async executePrompt() {
                return {
                    content: [{ text: '{"ok":true}' }],
                    structuredContent: { ok: true },
                };
            },
        });

        const out = await wf.agent('do the thing', { member_name: MEMBER, schema: { type: 'object' } });
        assert.deepStrictEqual(out, { ok: true });
    });

    test('control: an existing structuredContent.isError busy result still classifies as busy', async () => {
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
        assert.strictEqual(calls, 1);
    });
});
