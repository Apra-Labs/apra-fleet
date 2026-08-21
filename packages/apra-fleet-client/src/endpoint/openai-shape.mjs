/**
 * OpenAI-compatible shape adapter: the message pattern (/chat/completions)
 * and the completion pattern (/completions), over the shared endpoint core.
 *
 * Base URL is configuration, which is the whole point: the same adapter
 * serves api.openai.com, openrouter.ai, Groq, Together or any other
 * OpenAI-compatible gateway without a second adapter and without this package
 * depending on one vendor.
 *
 * WHICH PATTERN IS USED IS EXPLICIT CONFIG, NEVER SNIFFED. `pattern:
 * 'message'` posts a one-element `messages` array to /chat/completions;
 * `pattern: 'completion'` posts the prompt string to the legacy /completions.
 * Guessing from the model name would silently switch call shapes when a
 * caller changes models, so an unrecognized value is a construction-time
 * TypeError instead.
 *
 * The engine hands a transport a single prompt string, so the message pattern
 * renders it into one user message; the completion pattern passes it through
 * untouched. Structured output needs nothing from this adapter: the engine's
 * own agent() already enforces the caller's JSON schema client-side and runs
 * a repair loop when the answer does not validate, so there is deliberately
 * no second schema-enforcement layer (and no provider-native tool-calling)
 * here.
 *
 * No module-level state, no process.env, no default API key: everything the
 * adapter needs arrives through createOpenAiTransport(config), which is what
 * makes both patterns testable against a stubbed fetch with no network.
 */

import { buildEnvelope, classifyEndpointFailure, dispatchFailureFromHttp } from './core.mjs';
import { joinUrl, postJson, requireString, resolveFetch, resolveRequestTimeoutMs } from './http.mjs';

/** Call pattern -> path appended to the configured base URL. */
export const OPENAI_PATTERNS = Object.freeze({
    message: '/chat/completions',
    completion: '/completions'
});

/**
 * @typedef {object} OpenAiEndpointConfig
 * @property {string} baseUrl - e.g. 'https://api.openai.com/v1' or
 *   'https://openrouter.ai/api/v1'. A trailing slash is tolerated.
 * @property {string} apiKey - sent as a bearer token.
 * @property {string} model - the model id sent on every request. A tier
 *   keyword the engine may pass per dispatch ('cheap'/'standard'/'premium')
 *   is NOT a model id and is not forwarded: there is no member here to
 *   resolve a tier against, so this transport speaks to exactly the one model
 *   it was configured with.
 * @property {'message'|'completion'} [pattern='message']
 * @property {number} [maxTokens] - optional; omitted from the request when
 *   unset, since it is optional for this shape.
 * @property {Record<string,string>} [headers] - extra request headers (e.g.
 *   openrouter.ai's HTTP-Referer / X-Title attribution headers).
 * @property {Function} [fetch] - injected fetch; defaults to globalThis.fetch.
 * @property {number} [timeoutMs] - default request deadline (ms) used when a
 *   dispatch's own options.timeoutMs/timeout_s is not set; falls back to
 *   DEFAULT_REQUEST_TIMEOUT_MS (see http.mjs) when neither is set. A stalled
 *   connection never hangs a dispatch indefinitely (apra-fleet-5se.16).
 */

/**
 * Build the executePrompt half of a FleetApi over an OpenAI-compatible
 * endpoint.
 *
 * @param {OpenAiEndpointConfig} config
 * @returns {{executePrompt: (options?: {prompt?: string, signal?: AbortSignal, timeoutMs?: number, timeout_s?: number}) => Promise<object>, url: string, pattern: string}}
 */
export function createOpenAiTransport(config = {}) {
    const baseUrl = requireString(config.baseUrl, 'baseUrl');
    const apiKey = requireString(config.apiKey, 'apiKey');
    const model = requireString(config.model, 'model');
    const pattern = config.pattern ?? 'message';
    if (!Object.prototype.hasOwnProperty.call(OPENAI_PATTERNS, pattern)) {
        throw new TypeError(
            `[Endpoint Transport] config.pattern must be 'message' (${OPENAI_PATTERNS.message}) or ` +
            `'completion' (${OPENAI_PATTERNS.completion}), got ${JSON.stringify(pattern)}. ` +
            'The endpoint is explicit configuration; it is never inferred from the model name.'
        );
    }
    if (config.maxTokens !== undefined && (typeof config.maxTokens !== 'number' || !Number.isFinite(config.maxTokens))) {
        throw new TypeError(`[Endpoint Transport] config.maxTokens must be a finite number when set, got ${JSON.stringify(config.maxTokens)}.`);
    }

    const fetchImpl = resolveFetch(config);
    const url = joinUrl(baseUrl, OPENAI_PATTERNS[pattern]);
    const headers = {
        authorization: `Bearer ${apiKey}`,
        ...(config.headers ?? {})
    };

    async function executePrompt(options = {}) {
        const prompt = requirePrompt(options.prompt);
        const body = pattern === 'message'
            ? { model, messages: [{ role: 'user', content: prompt }] }
            : { model, prompt };
        if (typeof config.maxTokens === 'number') body.max_tokens = config.maxTokens;

        const timeoutMs = resolveRequestTimeoutMs(options, config);
        const res = await postJson({ fetchImpl, url, headers, body, signal: options.signal, timeoutMs });

        // A non-2xx is a dispatch that failed before any LLM content existed,
        // which is exactly the engine's isError channel -- reported, not
        // thrown, and carrying any usage the provider still billed us for.
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

        const where = pattern === 'message' ? 'choices[0].message.content' : 'choices[0].text';
        const text = readReplyText(res.body, pattern);
        if (typeof text !== 'string') {
            throw classifyEndpointFailure({
                kind: 'malformed',
                url: res.url,
                body: res.body,
                detail: `no assistant reply at ${where}`
            });
        }
        // normalizeUsage() inside buildEnvelope reads this shape's
        // prompt_tokens/completion_tokens spelling, and omits usage entirely
        // when the provider reported none rather than zero-filling it.
        return buildEnvelope({ text, usage: res.body.usage });
    }

    return { executePrompt, url, pattern };
}

function requirePrompt(prompt) {
    if (typeof prompt !== 'string' || prompt === '') {
        throw new TypeError(`[Endpoint Transport] executePrompt requires a non-empty prompt string, got ${prompt === null ? 'null' : typeof prompt}.`);
    }
    return prompt;
}

function readReplyText(body, pattern) {
    const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
    if (!choice || typeof choice !== 'object') return undefined;
    return pattern === 'message'
        ? (choice.message && choice.message.content)
        : choice.text;
}
