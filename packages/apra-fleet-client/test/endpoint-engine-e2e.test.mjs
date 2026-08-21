import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';

// End-to-end proof that the endpoint transport drives the REAL FleetWorkflow
// engine (apra-fleet-5se.6). The per-module unit tests around this one all
// stop at the transport's own boundary; this file is the only place where a
// real `new FleetWorkflow(makeEndpointApi(config))` runs an actual workflow
// script through `runWithContext()`, so the engine's own agent() dispatch
// path, its client-side schema enforcement and repair loop, and its pricing
// path are exercised against the transport rather than against a hand-written
// mock FleetApi that only *looks* like one.
//
// Modelled on the consumer-side smoke test that already exists for the
// vendored engine (egts-agentic-intelligence's
// egts-functions/src/chat/vendorSmoke.test.ts), which proves the same
// properties from the other side of the package boundary.
//
// Both endpoint shapes are covered, and so are the three negative paths a
// hand-written adapter typically gets wrong -- a malformed provider body, a
// non-2xx status, and an aborted request -- each of which must surface at the
// engine boundary as its own typed error.
//
// NO NETWORK, NO API KEY: every transport is constructed with an injected
// `fetch`, `globalThis.fetch` is replaced with a thrower for the lifetime of
// this file (so an accidental real request fails loudly instead of dialling
// out), and the provider API-key environment variables are unset -- the only
// credential in play is the one passed through config.
import { makeEndpointApi } from '@apralabs/apra-fleet-client/endpoint';
import {
    AgentDispatchError,
    AgentOutputError,
    CancelledError,
    FleetWorkflow
} from '@apralabs/apra-fleet-workflow';

const API_KEY = 'config-injected-key';
const KEY_ENV_VARS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL'];
const savedEnv = new Map();
let savedFetch;

before(() => {
    for (const name of KEY_ENV_VARS) {
        savedEnv.set(name, process.env[name]);
        delete process.env[name];
    }
    savedFetch = globalThis.fetch;
    globalThis.fetch = () => {
        throw new Error('[test] globalThis.fetch must never be called: this suite runs with no network access');
    };
});

after(() => {
    for (const [name, value] of savedEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    globalThis.fetch = savedFetch;
});

/** A minimal stand-in for the parts of `Response` that postJson actually reads. */
function httpResponse({ status = 200, statusText = 'OK', body }) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { status, statusText, async text() { return text; } };
}

/**
 * A fetch stub that records every request and replies from a queue of
 * per-call handlers (the last one repeats, so a single handler serves any
 * number of calls).
 */
function recordingFetch(...handlers) {
    const calls = [];
    const impl = async (url, init) => {
        const handler = handlers[Math.min(calls.length, handlers.length - 1)];
        calls.push({ url, headers: init.headers, body: JSON.parse(init.body), signal: init.signal });
        return handler(calls.length);
    };
    impl.calls = calls;
    return impl;
}

// The two shapes, described declaratively so every case below runs identically
// against both without the assertions drifting apart.
const SHAPES = [
    {
        name: 'OpenAI-compatible',
        provider: 'openai',
        baseUrl: 'https://api.openai.test/v1',
        model: 'gpt-test',
        url: 'https://api.openai.test/v1/chat/completions',
        reply: (text, usage) => ({
            choices: [{ index: 0, message: { role: 'assistant', content: text } }],
            ...(usage ? { usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output } } : {})
        }),
        noReplyBody: { choices: [] },
        promptOf: (body) => body.messages[0].content,
        authHeaderOf: (headers) => headers.authorization,
        expectedAuth: `Bearer ${API_KEY}`
    },
    {
        name: 'Anthropic native',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.test',
        model: 'claude-test',
        url: 'https://api.anthropic.test/v1/messages',
        reply: (text, usage) => ({
            content: [{ type: 'text', text }],
            ...(usage ? { usage: { input_tokens: usage.input, output_tokens: usage.output } } : {})
        }),
        noReplyBody: { content: [] },
        promptOf: (body) => body.messages[0].content,
        authHeaderOf: (headers) => headers['x-api-key'],
        expectedAuth: API_KEY
    }
];

function apiFor(shape, fetchImpl, extra = {}) {
    return makeEndpointApi({
        provider: shape.provider,
        baseUrl: shape.baseUrl,
        apiKey: API_KEY,
        model: shape.model,
        fetch: fetchImpl,
        ...extra
    });
}

for (const shape of SHAPES) {
    describe(`endpoint transport + real FleetWorkflow engine (${shape.name})`, () => {
        test('a workflow script run through runWithContext() receives the provider reply unmodified, and the dispatch is priced for real', async () => {
            // Deliberately awkward: prose, blank lines, stray braces and
            // trailing whitespace. Anything the engine or the transport
            // "helpfully" trims or reformats shows up as an inequality here.
            const REPLY = 'Line one.\n\n  Indented { brace } line.\nTrailing spaces:   \n';
            const fetchImpl = recordingFetch(() => httpResponse({
                body: shape.reply(REPLY, { input: 1000, output: 500 })
            }));
            const wf = new FleetWorkflow(apiFor(shape, fetchImpl, {
                pricing: { promptPrice: 3, completionPrice: 15 }
            }));

            const outcome = await wf.runWithContext({ topic: 'transports' }, async (context) => {
                const reply = await context.agent(`Summarize ${context.args.topic}.`, {
                    member_name: 'endpoint',
                    model: 'premium'
                });
                return { reply, spent: context.budget.spent(), pricing: context.budget.pricingSummary() };
            });

            assert.strictEqual(outcome.reply, REPLY, 'the provider reply must reach the workflow script byte-for-byte');

            // The request the transport actually sent, from config alone.
            assert.strictEqual(fetchImpl.calls.length, 1);
            const [call] = fetchImpl.calls;
            assert.strictEqual(call.url, shape.url);
            assert.strictEqual(shape.promptOf(call.body), 'Summarize transports.');
            assert.strictEqual(call.body.model, shape.model, 'the configured model is sent, never the engine tier keyword');
            assert.strictEqual(shape.authHeaderOf(call.headers), shape.expectedAuth);

            // The engine's pricing path ran for real against the transport's
            // memberless getMemberModelPricing: 1000 prompt tokens at $3/1M
            // plus 500 completion tokens at $15/1M.
            assert.ok(Math.abs(outcome.spent - 0.0105) < 1e-9, `expected 0.0105 spent, got ${outcome.spent}`);
            assert.deepStrictEqual(outcome.pricing, { real: 1, fallback: 0 });
        });

        test('a schema-constrained agent() dispatch resolves against a stubbed structured response', async () => {
            const schema = {
                type: 'object',
                required: ['status', 'notes'],
                properties: { status: { type: 'string' }, notes: { type: 'string' } }
            };
            const answer = { status: 'VERIFY', notes: 'all good' };
            const fetchImpl = recordingFetch(() => httpResponse({
                body: shape.reply(
                    `Here is the result you asked for:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`\n`,
                    { input: 40, output: 20 }
                )
            }));
            const wf = new FleetWorkflow(apiFor(shape, fetchImpl));

            const parsed = await wf.runWithContext({}, (context) => context.agent('Report status.', {
                member_name: 'endpoint',
                schema
            }));

            assert.deepStrictEqual(parsed, answer);
            assert.strictEqual(fetchImpl.calls.length, 1, 'a schema-valid first reply must not trigger a repair dispatch');
        });

        test('a malformed provider body surfaces as AgentOutputError', async () => {
            const fetchImpl = recordingFetch(() => httpResponse({ body: shape.noReplyBody }));
            const wf = new FleetWorkflow(apiFor(shape, fetchImpl));

            await assert.rejects(
                wf.runWithContext({}, (context) => context.agent('anything', { member_name: 'endpoint' })),
                (err) => {
                    assert.ok(err instanceof AgentOutputError, `expected AgentOutputError, got ${err.constructor.name}: ${err.message}`);
                    assert.strictEqual(err.details.reason, 'malformed_response');
                    return true;
                }
            );
        });

        test('a 2xx body that is not JSON at all also surfaces as AgentOutputError', async () => {
            const fetchImpl = recordingFetch(() => httpResponse({ body: '<html><body>502 from the gateway</body></html>' }));
            const wf = new FleetWorkflow(apiFor(shape, fetchImpl));

            await assert.rejects(
                wf.runWithContext({}, (context) => context.agent('anything', { member_name: 'endpoint' })),
                (err) => {
                    assert.ok(err instanceof AgentOutputError, `expected AgentOutputError, got ${err.constructor.name}: ${err.message}`);
                    assert.strictEqual(err.details.reason, 'malformed_response');
                    return true;
                }
            );
        });

        test('a non-2xx status surfaces as AgentDispatchError classified by status', async () => {
            const fetchImpl = recordingFetch(() => httpResponse({
                status: 429,
                statusText: 'Too Many Requests',
                body: { error: { message: 'rate limit exceeded' } }
            }));
            const wf = new FleetWorkflow(apiFor(shape, fetchImpl));

            await assert.rejects(
                wf.runWithContext({}, (context) => context.agent('anything', {
                    member_name: 'endpoint',
                    // Do not sit in the engine's busy-wait poll: this failure
                    // is not 'busy', but keep the test honest about timing.
                    busyWaitMs: 0
                })),
                (err) => {
                    assert.ok(err instanceof AgentDispatchError, `expected AgentDispatchError, got ${err.constructor.name}: ${err.message}`);
                    assert.strictEqual(err.details.reason, 'rate_limited');
                    assert.match(err.message, /rate limit exceeded/);
                    return true;
                }
            );
        });

        test('requestStop() during an in-flight dispatch surfaces as CancelledError, not a transport failure', async () => {
            let requestStarted;
            const started = new Promise((resolve) => { requestStarted = resolve; });
            let seenSignal;
            // Settles only when its signal aborts, exactly as a real fetch
            // does: the run's own cooperative-cancellation signal is the only
            // thing that ends this request.
            const fetchImpl = (url, init) => new Promise((resolve, reject) => {
                seenSignal = init.signal;
                const fail = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
                if (init.signal.aborted) {
                    fail();
                    return;
                }
                init.signal.addEventListener('abort', fail, { once: true });
                requestStarted();
            });
            const wf = new FleetWorkflow(apiFor(shape, fetchImpl));

            const run = wf.runWithContext({}, (context) => context.agent('anything', { member_name: 'endpoint' }));
            await started;
            wf.requestStop();

            await assert.rejects(run, (err) => {
                assert.ok(err instanceof CancelledError, `expected CancelledError, got ${err.constructor.name}: ${err.message}`);
                assert.strictEqual(err.code, 'CANCELLED');
                return true;
            });
            assert.ok(seenSignal && seenSignal.aborted, 'the run\'s cooperative-cancellation signal must reach fetch, and must have fired');
        });
    });
}

describe('endpoint transport + real FleetWorkflow engine: the schema-repair loop runs against the transport', () => {
    test('one schema-invalid reply then a valid one resolves after exactly two provider requests', async () => {
        const shape = SHAPES[0];
        const schema = {
            type: 'object',
            required: ['value'],
            properties: { value: { type: 'string' } }
        };
        const fetchImpl = recordingFetch(
            () => httpResponse({ body: shape.reply('sorry, no json here at all {{{', { input: 10, output: 5 }) }),
            () => httpResponse({ body: shape.reply(JSON.stringify({ value: 'fixed-on-repair' }), { input: 10, output: 5 }) })
        );
        const wf = new FleetWorkflow(apiFor(shape, fetchImpl));

        const parsed = await wf.runWithContext({}, (context) => context.agent('Give me the value.', {
            member_name: 'endpoint',
            schema
        }));

        assert.deepStrictEqual(parsed, { value: 'fixed-on-repair' });
        assert.strictEqual(fetchImpl.calls.length, 2, 'exactly one repair re-ask must have gone out over the transport');
        // The repair re-ask is self-contained: it carries the original prompt
        // back to the provider, so it is answerable with no session state.
        assert.match(shape.promptOf(fetchImpl.calls[1].body), /Give me the value\./);
    });
});
