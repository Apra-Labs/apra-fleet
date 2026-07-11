import { test, describe } from 'node:test';
import assert from 'node:assert';
import { FleetWorkflow, WorkflowError, MemberNotFoundError, AgentOutputError, CommandError, FleetTransportError } from '../src/workflow/index.mjs';

// Unit tests for the client/workflow-side typed-error normalization layer
// (apra-fleet-unw.3, findings F4/F10). Every failure path of agent()/command()
// must throw one of the typed classes below -- never return `null` -- per
// docs/structured-errors-proposal.md's client-side stopgap classification.

const KNOWN_MEMBER = 'fleet-dev';

/**
 * Builds a mock fleetApi whose behavior is driven by the `prompt`/`command`
 * text, mirroring the pattern used in test-runner.test.mjs.
 */
function createMockFleetApi({ executePromptImpl, executeCommandImpl } = {}) {
    return {
        async executePrompt(payload) {
            if (executePromptImpl) return executePromptImpl(payload);
            return { content: [{ text: `Mock response to: ${payload.prompt}` }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
        },
        async executeCommand(payload) {
            if (executeCommandImpl) return executeCommandImpl(payload);
            return { content: [{ text: payload.command }], isError: false };
        }
    };
}

describe('agent() typed error classification', () => {
    test('member-not-found response text throws MemberNotFoundError', async () => {
        const wf = new FleetWorkflow(createMockFleetApi({
            executePromptImpl: async () => ({ content: [{ text: `Member "ghost" not found.` }] })
        }));

        await assert.rejects(
            () => wf.agent('hello', { member_name: 'ghost' }),
            (err) => {
                assert.ok(err instanceof MemberNotFoundError);
                assert.ok(err instanceof WorkflowError);
                assert.strictEqual(err.code, 'MEMBER_NOT_FOUND');
                assert.ok(err.details && err.details.text.includes('not found'));
                return true;
            }
        );
    });

    test('unparseable JSON output throws AgentOutputError with cause preserved', async () => {
        const wf = new FleetWorkflow(createMockFleetApi({
            executePromptImpl: async () => ({ content: [{ text: 'not json at all {{{' }], usage: { total_tokens: 5 } })
        }));

        await assert.rejects(
            () => wf.agent('give me json', { member_name: KNOWN_MEMBER, schema: { type: 'object' } }),
            (err) => {
                assert.ok(err instanceof AgentOutputError);
                assert.strictEqual(err.code, 'AGENT_OUTPUT_INVALID');
                assert.ok(err.cause, 'expected the original parse error to be preserved on .cause');
                return true;
            }
        );
    });

    test('schema-invalid JSON output throws AgentOutputError', async () => {
        const wf = new FleetWorkflow(createMockFleetApi({
            executePromptImpl: async () => ({ content: [{ text: JSON.stringify({ wrong: true }) }], usage: { total_tokens: 5 } })
        }));

        await assert.rejects(
            () => wf.agent('give me json', {
                member_name: KNOWN_MEMBER,
                schema: { type: 'object', required: ['expected'], properties: { expected: { type: 'string' } } }
            }),
            (err) => {
                assert.ok(err instanceof AgentOutputError);
                assert.strictEqual(err.code, 'AGENT_OUTPUT_INVALID');
                return true;
            }
        );
    });

    test('empty content response throws AgentOutputError, never returns null', async () => {
        const wf = new FleetWorkflow(createMockFleetApi({
            executePromptImpl: async () => ({ content: [], usage: { total_tokens: 5 } })
        }));

        await assert.rejects(
            () => wf.agent('hello', { member_name: KNOWN_MEMBER }),
            (err) => {
                assert.ok(err instanceof AgentOutputError);
                return true;
            }
        );
    });

    test('transport rejection is wrapped as FleetTransportError with cause preserved', async () => {
        const transportFailure = new Error('ECONNRESET');
        const wf = new FleetWorkflow(createMockFleetApi({
            executePromptImpl: async () => { throw transportFailure; }
        }));

        await assert.rejects(
            () => wf.agent('hello', { member_name: KNOWN_MEMBER }),
            (err) => {
                assert.ok(err instanceof FleetTransportError);
                assert.strictEqual(err.code, 'TRANSPORT_ERROR');
                assert.strictEqual(err.cause, transportFailure);
                return true;
            }
        );
    });

    test('successful agent() call still resolves normally (no regression)', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const result = await wf.agent('hello', { member_name: KNOWN_MEMBER });
        assert.strictEqual(result, 'Mock response to: hello');
    });

    test('F6: an MCP client-side timeout (non-response) rejects with a typed FleetTransportError instead of hanging', async () => {
        // Simulates McpClient.request() giving up on a non-responding MCP
        // server: it rejects synchronously with an ETIMEDOUT-style error
        // (see packages/apra-fleet-client/src/client/api.mjs's
        // deriveTimeoutMs/timeoutMs plumbing) rather than the call ever
        // hanging indefinitely. Deliberately not code 'ABORTED' (that path
        // is reserved for cooperative requestStop() cancellation and is
        // covered separately, apra-fleet-unw.10) -- a real non-response
        // timeout must fall through to the generic transport-failure
        // classification, not silently resolve or leave the caller waiting.
        const timeoutFailure = Object.assign(new Error('Request timed out after 30000ms'), { code: 'ETIMEDOUT' });
        const wf = new FleetWorkflow(createMockFleetApi({
            executePromptImpl: async () => { throw timeoutFailure; }
        }));

        await assert.rejects(
            () => wf.agent('hello', { member_name: KNOWN_MEMBER, timeoutMs: 30000 }),
            (err) => {
                assert.ok(err instanceof FleetTransportError);
                assert.ok(err instanceof WorkflowError);
                assert.strictEqual(err.code, 'TRANSPORT_ERROR');
                assert.strictEqual(err.cause, timeoutFailure);
                assert.notStrictEqual(err.code, 'CANCELLED', 'a non-response timeout must not be misclassified as a cooperative CancelledError');
                return true;
            }
        );
    });
});

describe('command() typed error classification', () => {
    test('member-not-found response text throws MemberNotFoundError', async () => {
        const wf = new FleetWorkflow(createMockFleetApi({
            executeCommandImpl: async () => ({ content: [{ text: `Member "ghost" not found.` }] })
        }));

        await assert.rejects(
            () => wf.command('echo hi', { member_name: 'ghost' }),
            (err) => {
                assert.ok(err instanceof MemberNotFoundError);
                assert.strictEqual(err.code, 'MEMBER_NOT_FOUND');
                return true;
            }
        );
    });

    test('isError result throws CommandError', async () => {
        const wf = new FleetWorkflow(createMockFleetApi({
            executeCommandImpl: async () => ({ content: [{ text: 'boom: command not found' }], isError: true })
        }));

        await assert.rejects(
            () => wf.command('some_missing_binary', { member_name: KNOWN_MEMBER }),
            (err) => {
                assert.ok(err instanceof CommandError);
                assert.strictEqual(err.code, 'COMMAND_FAILED');
                return true;
            }
        );
    });

    test('transport rejection is wrapped as FleetTransportError with cause preserved', async () => {
        const transportFailure = new Error('socket hang up');
        const wf = new FleetWorkflow(createMockFleetApi({
            executeCommandImpl: async () => { throw transportFailure; }
        }));

        await assert.rejects(
            () => wf.command('echo hi', { member_name: KNOWN_MEMBER }),
            (err) => {
                assert.ok(err instanceof FleetTransportError);
                assert.strictEqual(err.code, 'TRANSPORT_ERROR');
                assert.strictEqual(err.cause, transportFailure);
                return true;
            }
        );
    });

    test('successful command() call still resolves normally (no regression)', async () => {
        const wf = new FleetWorkflow(createMockFleetApi());
        const result = await wf.command('echo hi', { member_name: KNOWN_MEMBER });
        assert.strictEqual(result, 'echo hi');
    });
});

describe('F10: resume defaulting at the workflow layer', () => {
    test('agent() defaults resume:false in the payload sent to executePrompt', async () => {
        let capturedPayload;
        const wf = new FleetWorkflow(createMockFleetApi({
            executePromptImpl: async (payload) => {
                capturedPayload = payload;
                return { content: [{ text: 'ok' }], usage: { total_tokens: 5 } };
            }
        }));

        await wf.agent('hello', { member_name: KNOWN_MEMBER });

        assert.strictEqual(capturedPayload.resume, false);
    });

    test('agent() honors an explicit resume:true override', async () => {
        let capturedPayload;
        const wf = new FleetWorkflow(createMockFleetApi({
            executePromptImpl: async (payload) => {
                capturedPayload = payload;
                return { content: [{ text: 'ok' }], usage: { total_tokens: 5 } };
            }
        }));

        await wf.agent('hello', { member_name: KNOWN_MEMBER, resume: true });

        assert.strictEqual(capturedPayload.resume, true);
    });
});
