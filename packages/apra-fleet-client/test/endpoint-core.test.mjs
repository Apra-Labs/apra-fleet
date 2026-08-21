import test from 'node:test';
import assert from 'node:assert';
import {
    buildEnvelope,
    buildDispatchFailureEnvelope,
    classifyEndpointFailure,
    dispatchFailureFromHttp,
    normalizeUsage
} from '../src/endpoint/core.mjs';
import {
    AgentDispatchError,
    AgentOutputError,
    CancelledError,
    FleetTransportError
} from '../src/errors/workflow-errors.mjs';

test('buildEnvelope - well-formed reply normalizes to the exact engine envelope shape', () => {
    const envelope = buildEnvelope({ text: 'hello from the provider', usage: { input_tokens: 10, output_tokens: 5 } });

    assert.deepStrictEqual(envelope, {
        content: [{ type: 'text', text: 'hello from the provider' }],
        structuredContent: {
            response: 'hello from the provider',
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
        }
    });
});

test('buildEnvelope - usage is populated when the provider reported token counts', () => {
    const envelope = buildEnvelope({ text: 'ok', usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 } });

    assert.deepStrictEqual(envelope.structuredContent.usage, {
        input_tokens: 3,
        output_tokens: 7,
        total_tokens: 10
    });
});

test('buildEnvelope - usage key is absent (never zero-filled) when the provider reported none', () => {
    const envelope = buildEnvelope({ text: 'ok, no usage here' });

    assert.strictEqual('usage' in envelope.structuredContent, false);
    assert.deepStrictEqual(envelope.structuredContent, { response: 'ok, no usage here' });
});

test('buildEnvelope - usage key is absent when the provider payload has no token fields at all', () => {
    const envelope = buildEnvelope({ text: 'ok', usage: { model: 'gpt-x' } });

    assert.strictEqual('usage' in envelope.structuredContent, false);
});

test('normalizeUsage - returns null (not zero-filled) for a payload with no token fields', () => {
    assert.strictEqual(normalizeUsage(undefined), null);
    assert.strictEqual(normalizeUsage(null), null);
    assert.strictEqual(normalizeUsage({}), null);
    assert.strictEqual(normalizeUsage({ model: 'gpt-x' }), null);
});

test('normalizeUsage - a total_tokens-only payload is not enough to price a call', () => {
    // Neither side broken out: treat as "not reported", per the module's own
    // documented contract, rather than inventing an input/output split.
    assert.strictEqual(normalizeUsage({ total_tokens: 42 }), null);
});

test('buildEnvelope - malformed body (non-string text) throws AgentOutputError, not a bare-string envelope', () => {
    assert.throws(
        () => buildEnvelope({ text: undefined }),
        AgentOutputError
    );

    let thrown;
    try {
        buildEnvelope({});
    } catch (err) {
        thrown = err;
    }
    assert.ok(thrown instanceof AgentOutputError);
    assert.strictEqual(thrown instanceof AgentDispatchError, false);
    assert.strictEqual(thrown instanceof FleetTransportError, false);
});

test('classifyEndpointFailure - malformed body classifies to AgentOutputError', () => {
    const err = classifyEndpointFailure({ kind: 'malformed', detail: 'body had no text field', body: { weird: true } });
    assert.ok(err instanceof AgentOutputError);
    assert.strictEqual(err.code, 'AGENT_OUTPUT_INVALID');
});

test('classifyEndpointFailure - non-2xx status classifies to AgentDispatchError', () => {
    const err = classifyEndpointFailure({ kind: 'http', status: 429, statusText: 'Too Many Requests', body: 'rate limited' });
    assert.ok(err instanceof AgentDispatchError);
    assert.strictEqual(err.code, 'AGENT_DISPATCH_FAILED');
    assert.strictEqual(err.details.reason, 'rate_limited');
});

test('classifyEndpointFailure - network drop classifies to FleetTransportError', () => {
    const cause = new Error('socket hang up');
    const err = classifyEndpointFailure({ kind: 'network', cause });
    assert.ok(err instanceof FleetTransportError);
    assert.strictEqual(err.code, 'TRANSPORT_ERROR');
    assert.strictEqual(err.cause, cause);
});

test('classifyEndpointFailure - the three failure kinds are distinct constructors, not the same class', () => {
    const malformed = classifyEndpointFailure({ kind: 'malformed', detail: 'bad body' });
    const http = classifyEndpointFailure({ kind: 'http', status: 500 });
    const network = classifyEndpointFailure({ kind: 'network', detail: 'connection reset' });

    assert.notStrictEqual(malformed.constructor, http.constructor);
    assert.notStrictEqual(http.constructor, network.constructor);
    assert.notStrictEqual(malformed.constructor, network.constructor);
});

test('classifyEndpointFailure - an aborted request classifies to CancelledError, not FleetTransportError (apra-fleet-5se.13)', () => {
    const cause = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const err = classifyEndpointFailure({ kind: 'aborted', cause });
    assert.ok(err instanceof CancelledError);
    assert.strictEqual(err.code, 'CANCELLED');
    assert.strictEqual(err.cause, cause);
    assert.strictEqual(err instanceof FleetTransportError, false);
});

test('classifyEndpointFailure - aborted is a distinct constructor from the other three kinds', () => {
    const aborted = classifyEndpointFailure({ kind: 'aborted', detail: 'cancelled' });
    const malformed = classifyEndpointFailure({ kind: 'malformed', detail: 'bad body' });
    const http = classifyEndpointFailure({ kind: 'http', status: 500 });
    const network = classifyEndpointFailure({ kind: 'network', detail: 'connection reset' });

    assert.notStrictEqual(aborted.constructor, malformed.constructor);
    assert.notStrictEqual(aborted.constructor, http.constructor);
    assert.notStrictEqual(aborted.constructor, network.constructor);
});

test('dispatchFailureFromHttp - a non-2xx becomes a classified isError envelope, not a thrown error', () => {
    const envelope = dispatchFailureFromHttp({ status: 401, statusText: 'Unauthorized', body: 'bad api key' });

    assert.strictEqual(envelope.structuredContent.isError, true);
    assert.strictEqual(envelope.structuredContent.reason, 'auth_failed');
    assert.strictEqual('usage' in envelope.structuredContent, false);
    assert.ok(Array.isArray(envelope.content));
    assert.strictEqual(envelope.content[0].type, 'text');
    assert.ok(envelope.content[0].text.includes('HTTP 401'));
});

test('dispatchFailureFromHttp - keeps any usage the provider still reported on the failure', () => {
    const envelope = dispatchFailureFromHttp({
        status: 500,
        statusText: 'Internal Server Error',
        body: 'boom',
        usage: { input_tokens: 4, output_tokens: 0 }
    });

    assert.deepStrictEqual(envelope.structuredContent.usage, {
        input_tokens: 4,
        output_tokens: 0,
        total_tokens: 4
    });
    assert.strictEqual(envelope.structuredContent.reason, 'provider_error');
});

test('buildEnvelope/buildDispatchFailureEnvelope/classifyEndpointFailure/dispatchFailureFromHttp - an explicit null argument is classified, not a raw TypeError', () => {
    assert.throws(() => buildEnvelope(null), AgentOutputError);

    const dispatchEnvelope = buildDispatchFailureEnvelope(null);
    assert.deepStrictEqual(dispatchEnvelope, {
        content: [{ type: 'text', text: 'endpoint dispatch failed' }],
        structuredContent: { isError: true, reason: 'endpoint_error' }
    });

    const classified = classifyEndpointFailure(null);
    assert.ok(classified instanceof FleetTransportError);

    const httpEnvelope = dispatchFailureFromHttp(null);
    assert.strictEqual(httpEnvelope.structuredContent.isError, true);
    assert.strictEqual(httpEnvelope.structuredContent.reason, 'http_error');
});

test('buildDispatchFailureEnvelope - structuredContent.isError/reason carries a pre-content dispatch failure', () => {
    const envelope = buildDispatchFailureEnvelope({ reason: 'busy', message: 'member is busy' });

    assert.deepStrictEqual(envelope, {
        content: [{ type: 'text', text: 'member is busy' }],
        structuredContent: {
            isError: true,
            reason: 'busy'
        }
    });
});
