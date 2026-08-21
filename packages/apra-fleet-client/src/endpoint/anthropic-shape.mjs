/**
 * Anthropic native shape adapter: POST /v1/messages, over the shared
 * endpoint core.
 *
 * Kept as a SIBLING of the OpenAI-compatible adapter rather than a special
 * case inside it, because Anthropic is not OpenAI-compatible in any of the
 * four places that matter:
 *   - auth is `x-api-key` plus a required `anthropic-version` header, not a
 *     bearer token;
 *   - `max_tokens` is required, not optional;
 *   - the reply is a `content` array of typed blocks, not `choices[0]`;
 *   - usage is reported as input_tokens/output_tokens.
 * Only the last one is a happy accident: it is already the spelling the
 * engine's envelope wants, so normalizeUsage() passes it straight through.
 *
 * Everything downstream of the provider's answer is shared: the same
 * buildEnvelope()/dispatchFailureFromHttp()/classifyEndpointFailure() calls
 * as the OpenAI adapter, so a caller cannot tell the two shapes apart from
 * the envelope or from the class of a failure -- only from what went over the
 * wire.
 *
 * No module-level state, no process.env, injected fetch: testable with a
 * stubbed fetch, no network and no API key.
 */

import { buildEnvelope, classifyEndpointFailure, dispatchFailureFromHttp } from './core.mjs';
import { joinUrl, postJson, requireString, resolveFetch } from './http.mjs';

/** Path appended to the configured base URL. */
export const ANTHROPIC_MESSAGES_PATH = '/v1/messages';

/**
 * Sent as the `anthropic-version` header when config does not override it.
 * The header is REQUIRED by the API -- a request without it is rejected --
 * so this default exists to make the adapter usable from minimal config, not
 * to hide the field.
 */
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

/**
 * Sent as `max_tokens` when config does not set one. Unlike the
 * OpenAI-compatible shape, omitting the field is not an option: the API
 * rejects a request without it, so the adapter must supply a value rather
 * than let the caller accidentally send an invalid request.
 */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

/**
 * @typedef {object} AnthropicEndpointConfig
 * @property {string} baseUrl - e.g. 'https://api.anthropic.com'. A trailing
 *   slash is tolerated.
 * @property {string} apiKey - sent as the `x-api-key` header.
 * @property {string} model - the model id sent on every request. A tier
 *   keyword the engine may pass per dispatch is not a model id and is not
 *   forwarded: there is no member here to resolve a tier against.
 * @property {number} [maxTokens=DEFAULT_ANTHROPIC_MAX_TOKENS]
 * @property {string} [anthropicVersion=DEFAULT_ANTHROPIC_VERSION]
 * @property {string} [system] - optional system prompt.
 * @property {Record<string,string>} [headers] - extra request headers (e.g.
 *   an `anthropic-beta` opt-in).
 * @property {Function} [fetch] - injected fetch; defaults to globalThis.fetch.
 */

/**
 * Build the executePrompt half of a FleetApi over the Anthropic native API.
 *
 * @param {AnthropicEndpointConfig} config
 * @returns {{executePrompt: (options?: {prompt?: string, signal?: AbortSignal}) => Promise<object>, url: string}}
 */
export function createAnthropicTransport(config = {}) {
    const baseUrl = requireString(config.baseUrl, 'baseUrl');
    const apiKey = requireString(config.apiKey, 'apiKey');
    const model = requireString(config.model, 'model');
    const maxTokens = config.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
    if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens) || maxTokens <= 0) {
        throw new TypeError(`[Endpoint Transport] config.maxTokens must be a positive finite number, got ${JSON.stringify(config.maxTokens)}.`);
    }

    const fetchImpl = resolveFetch(config);
    const url = joinUrl(baseUrl, ANTHROPIC_MESSAGES_PATH);
    const headers = {
        'x-api-key': apiKey,
        'anthropic-version': config.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION,
        ...(config.headers ?? {})
    };

    async function executePrompt(options = {}) {
        const prompt = requirePrompt(options.prompt);
        const body = {
            model,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: prompt }],
            ...(typeof config.system === 'string' && config.system !== '' ? { system: config.system } : {})
        };

        const res = await postJson({ fetchImpl, url, headers, body, signal: options.signal });

        if (!res.ok) {
            return dispatchFailureFromHttp({
                status: res.status,
                statusText: res.statusText,
                body: res.body,
                url: res.url,
                usage: res.isJson && res.body ? res.body.usage : undefined
            });
        }
        if (!res.isJson) {
            throw classifyEndpointFailure({
                kind: 'malformed',
                url: res.url,
                body: res.body,
                detail: 'the provider returned a 2xx response whose body is not JSON'
            });
        }

        const text = readReplyText(res.body);
        if (typeof text !== 'string') {
            throw classifyEndpointFailure({
                kind: 'malformed',
                url: res.url,
                body: res.body,
                detail: 'no assistant reply in content[]: the response carries no text block'
            });
        }
        return buildEnvelope({ text, usage: res.body.usage });
    }

    return { executePrompt, url };
}

function requirePrompt(prompt) {
    if (typeof prompt !== 'string' || prompt === '') {
        throw new TypeError(`[Endpoint Transport] executePrompt requires a non-empty prompt string, got ${prompt === null ? 'null' : typeof prompt}.`);
    }
    return prompt;
}

/**
 * Concatenate every text block in the reply, in order. A response may carry
 * several blocks (and non-text blocks alongside them), so taking content[0]
 * would silently truncate the answer. Returns undefined -- not '' -- when
 * there is no text block at all, so "the model said nothing readable" stays
 * distinguishable from "the model returned an empty string".
 */
function readReplyText(body) {
    if (!Array.isArray(body.content)) return undefined;
    const blocks = body.content.filter(
        (block) => block && block.type === 'text' && typeof block.text === 'string'
    );
    if (blocks.length === 0) return undefined;
    return blocks.map((block) => block.text).join('');
}
