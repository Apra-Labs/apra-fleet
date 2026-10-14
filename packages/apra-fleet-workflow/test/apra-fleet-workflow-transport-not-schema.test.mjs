import { test, describe } from 'node:test';
import assert from 'node:assert';
import { FleetWorkflow, AgentDispatchError, AgentOutputError } from '../src/workflow/index.mjs';
import { fleetToolFailureOf } from '@apralabs/apra-fleet-client';

// A fleet transport/tool failure is not model output. When a tool handler
// THROWS on the server (e.g. the SSH channel to a remote member cannot be
// opened), the MCP server returns {content:[{text: err.message}], isError:
// true} with no structuredContent. agent() must classify that as a dispatch
// failure BEFORE schema extraction and never issue a schema-repair re-ask for
// it; a genuinely malformed LLM reply must still go through schema repair.

const MEMBER = 'remote-member';
const SCHEMA = {
    type: 'object',
    required: ['value'],
    properties: { value: { type: 'string' } },
};
const SSH_FAILURE = '(SSH) Channel open failure: open failed';

function wfWith(executePromptImpl) {
    const calls = [];
    const wf = new FleetWorkflow({
        async executePrompt(payload) {
            calls.push(payload);
            return executePromptImpl(payload, calls.length);
        },
        async executeCommand() {
            return { content: [{ text: '' }] };
        },
    });
    return { wf, calls };
}

describe('transport failure is classified before schema parsing', () => {
    test('MCP isError result with a bare SSH channel failure -> AgentDispatchError(transport_failure), zero repair dispatches, message names the member', async () => {
        const { wf, calls } = wfWith(async () => ({ content: [{ type: 'text', text: SSH_FAILURE }], isError: true }));
        const repairEvents = [];
        wf.on('activity:start', (m) => { if (m.repairAttempt > 0) repairEvents.push(m); });

        await assert.rejects(
            wf.agent('give me json', { member_name: MEMBER, schema: SCHEMA }),
            (err) => {
                assert.ok(err instanceof AgentDispatchError, `expected AgentDispatchError, got ${err && err.constructor.name}`);
                assert.ok(!(err instanceof AgentOutputError));
                assert.strictEqual(err.details.reason, 'transport_failure');
                assert.strictEqual(err.details.signal, 'isError');
                assert.strictEqual(err.details.member, MEMBER);
                assert.match(err.message, new RegExp(`member '${MEMBER}'`));
                assert.ok(err.message.includes(SSH_FAILURE), err.message);
                assert.doesNotMatch(err.message, /parseable JSON|Schema-invalid/);
                return true;
            }
        );
        assert.strictEqual(calls.length, 1, 'a transport failure must never trigger a schema-repair dispatch');
        assert.strictEqual(repairEvents.length, 0);
    });

    test('text fallback: unflagged "Failed to execute command on" shape with no structured response is a transport failure', async () => {
        const text = `Failed to execute command on "${MEMBER}": ${SSH_FAILURE}`;
        const { wf, calls } = wfWith(async () => ({ content: [{ text }] }));
        await assert.rejects(
            wf.agent('give me json', { member_name: MEMBER, schema: SCHEMA }),
            (err) => err instanceof AgentDispatchError && err.details.reason === 'transport_failure' && err.details.signal === 'text'
        );
        assert.strictEqual(calls.length, 1);
    });

    test('no-schema call also surfaces the transport failure instead of returning the error text as output', async () => {
        const { wf } = wfWith(async () => ({ content: [{ text: SSH_FAILURE }], isError: true }));
        await assert.rejects(
            wf.agent('free text please', { member_name: MEMBER }),
            (err) => err instanceof AgentDispatchError && err.details.reason === 'transport_failure'
        );
    });

    test('a structured execute_prompt failure keeps its own classified reason (unchanged path)', async () => {
        const { wf } = wfWith(async () => ({
            content: [{ text: 'boom' }],
            structuredContent: { isError: true, reason: 'dispatch_failed' },
        }));
        await assert.rejects(
            wf.agent('give me json', { member_name: MEMBER, schema: SCHEMA }),
            (err) => err instanceof AgentDispatchError && err.details.reason === 'dispatch_failed'
        );
    });

    test('no regression: a genuine malformed LLM reply (mentioning connection refused mid-body) still goes through schema repair', async () => {
        const { wf, calls } = wfWith(async (_payload, n) => (n === 1
            ? { content: [{ text: 'I tried but saw connection refused / ECONNREFUSED earlier; here is no JSON at all.' }], structuredContent: { response: 'I tried but saw connection refused / ECONNREFUSED earlier; here is no JSON at all.' } }
            : { content: [{ text: '{"value": "ok"}' }], structuredContent: { response: '{"value": "ok"}' } }));
        const result = await wf.agent('give me json', { member_name: MEMBER, schema: SCHEMA });
        assert.deepStrictEqual(result, { value: 'ok' });
        assert.strictEqual(calls.length, 2, 'exactly one schema-repair re-ask for a malformed model reply');
    });

    test('no regression: an unwrapped malformed reply that starts with prose (no structured response) still repairs', async () => {
        const { wf, calls } = wfWith(async (_payload, n) => (n === 1
            ? { content: [{ text: 'Sorry, the SSH step failed so I cannot answer.' }] }
            : { content: [{ text: '{"value": "ok"}' }] }));
        const result = await wf.agent('give me json', { member_name: MEMBER, schema: SCHEMA });
        assert.deepStrictEqual(result, { value: 'ok' });
        assert.strictEqual(calls.length, 2);
    });
});

describe('fleetToolFailureOf', () => {
    test('classifies isError and anchored text shapes; ignores genuine replies and structured failures', () => {
        assert.deepStrictEqual(fleetToolFailureOf({ content: [{ text: SSH_FAILURE }], isError: true }), { source: 'isError', text: SSH_FAILURE });
        assert.strictEqual(fleetToolFailureOf({ content: [{ text: SSH_FAILURE }] })?.source, 'text');
        assert.strictEqual(fleetToolFailureOf({ content: [{ text: 'connect ECONNREFUSED 10.0.0.1:22' }] })?.source, 'text');
        assert.strictEqual(fleetToolFailureOf({ content: [{ text: '[FAIL] Failed to execute prompt on "m": x' }] })?.source, 'text');
        assert.strictEqual(fleetToolFailureOf({ content: [{ text: SSH_FAILURE }], structuredContent: { response: SSH_FAILURE } }), null);
        assert.strictEqual(fleetToolFailureOf({ content: [{ text: 'x' }], isError: true, structuredContent: { isError: true, reason: 'busy' } }), null);
        assert.strictEqual(fleetToolFailureOf({ content: [{ text: 'all good, but (SSH) was mentioned' }] }), null);
        assert.strictEqual(fleetToolFailureOf(null), null);
    });
});
