import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createOpenAiTransport } from '../src/endpoint/openai-shape.mjs';
import { createAnthropicTransport, DEFAULT_ANTHROPIC_MAX_TOKENS, DEFAULT_ANTHROPIC_VERSION } from '../src/endpoint/anthropic-shape.mjs';
import { FleetTransportError, CancelledError } from '../src/errors/workflow-errors.mjs';

// Request/response CONTRACT for both shape adapters, over a stubbed fetch:
// what each adapter puts ON THE WIRE, and that both converge on the same
// engine envelope. buildEnvelope()'s own normalization is covered by
// endpoint-core.test.mjs and is not repeated here.

/**
 * A fetch stub that records the single call made to it and resolves with a
 * flat 2xx JSON response, matching the shape postJson() actually reads off a
 * real Response ({status, statusText, text()}).
 */
function stubFetch(responseBody) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return {
            status: 200,
            statusText: 'OK',
            text: async () => JSON.stringify(responseBody)
        };
    };
    return { fetchImpl, calls };
}

test('OpenAI message pattern - posts to /chat/completions with a bearer auth header and a one-element messages array', async () => {
    const { fetchImpl, calls } = stubFetch({ choices: [{ message: { content: 'hi there' } }] });
    const transport = createOpenAiTransport({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test-123',
        model: 'gpt-test',
        fetch: fetchImpl
    });

    await transport.executePrompt({ prompt: 'hello' });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.strictEqual(calls[0].init.headers.authorization, 'Bearer sk-test-123');
    assert.deepStrictEqual(calls[0].body.messages, [{ role: 'user', content: 'hello' }]);
    assert.strictEqual('prompt' in calls[0].body, false, 'the message pattern must not also send a bare prompt field');
});

test('OpenAI completion pattern - posts to /completions with a prompt string, not a messages array', async () => {
    const { fetchImpl, calls } = stubFetch({ choices: [{ text: 'hi there' }] });
    const transport = createOpenAiTransport({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test-123',
        model: 'gpt-test',
        pattern: 'completion',
        fetch: fetchImpl
    });

    await transport.executePrompt({ prompt: 'hello' });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://api.openai.com/v1/completions');
    assert.strictEqual(calls[0].body.prompt, 'hello');
    assert.strictEqual('messages' in calls[0].body, false, 'the completion pattern must not send a messages array');
});

test('endpoint selection follows explicit config, never the model name', async () => {
    const messageStub = stubFetch({ choices: [{ message: { content: 'ok' } }] });
    const completionStub = stubFetch({ choices: [{ text: 'ok' }] });

    // Same model on both -- only `pattern` differs.
    const messageTransport = createOpenAiTransport({
        baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'shared-model-name', fetch: messageStub.fetchImpl
    });
    const completionTransport = createOpenAiTransport({
        baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'shared-model-name', pattern: 'completion', fetch: completionStub.fetchImpl
    });

    await messageTransport.executePrompt({ prompt: 'x' });
    await completionTransport.executePrompt({ prompt: 'x' });

    assert.notStrictEqual(messageStub.calls[0].url, completionStub.calls[0].url);
    assert.strictEqual(messageStub.calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.strictEqual(completionStub.calls[0].url, 'https://api.openai.com/v1/completions');

    // An unrecognized pattern is a construction-time TypeError -- confirming
    // there is no name-sniffing fallback hiding behind an invalid value.
    assert.throws(
        () => createOpenAiTransport({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'shared-model-name', pattern: 'gpt-5-turbo' }),
        TypeError
    );
});

test('Anthropic - posts to /v1/messages with x-api-key and anthropic-version headers (no bearer token) and a max_tokens value', async () => {
    const { fetchImpl, calls } = stubFetch({ content: [{ type: 'text', text: 'hi there' }] });
    const transport = createAnthropicTransport({
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'anthropic-key-123',
        model: 'claude-test',
        fetch: fetchImpl
    });

    await transport.executePrompt({ prompt: 'hello' });

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.strictEqual(calls[0].init.headers['x-api-key'], 'anthropic-key-123');
    assert.strictEqual(calls[0].init.headers['anthropic-version'], DEFAULT_ANTHROPIC_VERSION);
    assert.strictEqual('authorization' in calls[0].init.headers, false, 'Anthropic must not send a bearer Authorization header');
    assert.strictEqual(calls[0].body.max_tokens, DEFAULT_ANTHROPIC_MAX_TOKENS);
});

test('base URL override - a non-default base URL (openrouter.ai) is honoured verbatim for the OpenAI shape', async () => {
    const { fetchImpl, calls } = stubFetch({ choices: [{ message: { content: 'ok' } }] });
    const transport = createOpenAiTransport({
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'or-key',
        model: 'openrouter/some-model',
        fetch: fetchImpl
    });

    await transport.executePrompt({ prompt: 'hello' });

    assert.strictEqual(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
});

test('convergence - an OpenAI response and an Anthropic response carrying equivalent content produce deep-equal engine envelopes', async () => {
    const openai = stubFetch({
        choices: [{ message: { content: 'hello from the provider' } }],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 }
    });
    const anthropic = stubFetch({
        content: [{ type: 'text', text: 'hello from the provider' }],
        usage: { input_tokens: 3, output_tokens: 5 }
    });

    const openaiTransport = createOpenAiTransport({
        baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-test', fetch: openai.fetchImpl
    });
    const anthropicTransport = createAnthropicTransport({
        baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-test', fetch: anthropic.fetchImpl
    });

    const openaiEnvelope = await openaiTransport.executePrompt({ prompt: 'hello' });
    const anthropicEnvelope = await anthropicTransport.executePrompt({ prompt: 'hello' });

    assert.deepStrictEqual(openaiEnvelope, anthropicEnvelope);
    assert.deepStrictEqual(openaiEnvelope, {
        content: [{ type: 'text', text: 'hello from the provider' }],
        structuredContent: {
            response: 'hello from the provider',
            usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 }
        }
    });
});

test('no process.env read - config comes only from the injected object', async () => {
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'env-openai-key-should-be-ignored';
    process.env.ANTHROPIC_API_KEY = 'env-anthropic-key-should-be-ignored';
    try {
        const openaiStub = stubFetch({ choices: [{ message: { content: 'ok' } }] });
        const anthropicStub = stubFetch({ content: [{ type: 'text', text: 'ok' }] });

        const openaiTransport = createOpenAiTransport({
            baseUrl: 'https://api.openai.com/v1', apiKey: 'injected-openai-key', model: 'gpt-test', fetch: openaiStub.fetchImpl
        });
        const anthropicTransport = createAnthropicTransport({
            baseUrl: 'https://api.anthropic.com', apiKey: 'injected-anthropic-key', model: 'claude-test', fetch: anthropicStub.fetchImpl
        });

        await openaiTransport.executePrompt({ prompt: 'x' });
        await anthropicTransport.executePrompt({ prompt: 'x' });

        assert.strictEqual(openaiStub.calls[0].init.headers.authorization, 'Bearer injected-openai-key');
        assert.strictEqual(anthropicStub.calls[0].init.headers['x-api-key'], 'injected-anthropic-key');
    } finally {
        if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalOpenAiKey;
        if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    }

    // Assert, don't just intend: neither shape module's executable source
    // (comments stripped) references process.env directly.
    for (const relPath of ['../src/endpoint/openai-shape.mjs', '../src/endpoint/anthropic-shape.mjs']) {
        const filePath = fileURLToPath(new URL(relPath, import.meta.url));
        const source = readFileSync(filePath, 'utf8');
        const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        assert.ok(!withoutComments.includes('process.env'), `${relPath} must never read process.env directly`);
    }
});

// Regression coverage for apra-fleet-5se.16: both shape adapters used to read
// only options.prompt/options.signal and ignore options.timeoutMs/timeout_s
// entirely, so a provider that accepted the connection and then stalled hung
// the dispatch indefinitely. Both adapters must now derive a request deadline
// from those options (or the transport's own config.timeoutMs) and reject
// with FleetTransportError (reason: timeout) rather than hanging forever.

/** A fetch stub whose signal never fires on its own -- only reacts to abort. */
function neverSettlingFetch() {
    return (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
            const cause = init.signal.reason;
            reject(cause instanceof Error ? cause : Object.assign(new Error(String(cause)), { name: 'AbortError' }));
        }, { once: true });
    });
}

test('OpenAI transport - a stalled provider is bounded by options.timeoutMs, not left to hang', async () => {
    const transport = createOpenAiTransport({
        baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-test', fetch: neverSettlingFetch()
    });

    await assert.rejects(
        transport.executePrompt({ prompt: 'hello', timeoutMs: 20 }),
        (err) => {
            assert.ok(err instanceof FleetTransportError, `expected FleetTransportError, got ${err.constructor.name}`);
            assert.strictEqual(err.details.reason, 'timeout');
            assert.strictEqual(err instanceof CancelledError, false);
            return true;
        }
    );
});

test('Anthropic transport - options.timeout_s (seconds) is honoured, converted to a millisecond deadline', async () => {
    const transport = createAnthropicTransport({
        baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-test', fetch: neverSettlingFetch()
    });

    await assert.rejects(
        transport.executePrompt({ prompt: 'hello', timeout_s: 0.02 }),
        (err) => {
            assert.ok(err instanceof FleetTransportError);
            assert.strictEqual(err.details.reason, 'timeout');
            return true;
        }
    );
});

test('OpenAI transport - a config-level timeoutMs default applies when the dispatch does not set one', async () => {
    const transport = createOpenAiTransport({
        baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-test', fetch: neverSettlingFetch(), timeoutMs: 20
    });

    await assert.rejects(
        transport.executePrompt({ prompt: 'hello' }),
        (err) => {
            assert.ok(err instanceof FleetTransportError);
            assert.strictEqual(err.details.reason, 'timeout');
            return true;
        }
    );
});
