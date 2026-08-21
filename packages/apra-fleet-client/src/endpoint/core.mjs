/**
 * Endpoint transport core: the transport-neutral half of an endpoint FleetApi.
 *
 * A shape adapter (OpenAI-compatible, Anthropic native, ...) owns the HTTP
 * request and the provider-native JSON that comes back. It owns nothing else:
 * the two things every adapter would otherwise have to get right on its own
 * live here, once.
 *
 * (1) THE ENGINE ENVELOPE. FleetWorkflow reads
 *     `result.structuredContent.response` in preference to scraping
 *     `result.content[0].text`, and the shape is strict -- see the agent()
 *     dispatch path in packages/apra-fleet-workflow/src/workflow/index.mjs,
 *     which indexes `result.content[0].text` and calls `.startsWith(...)` on
 *     it. Hand the engine a bare string instead of
 *     `{content:[{type,text}], structuredContent:{response, usage}}` and it
 *     fails deep inside agent() as "Cannot read properties of undefined
 *     (reading 'startsWith')", re-wrapped as a FleetTransportError that names
 *     the network rather than the real bug. Build every successful reply with
 *     buildEnvelope() and no adapter can get that wrong independently.
 *
 * (2) FAILURE CLASSIFICATION. The engine re-throws `instanceof WorkflowError`
 *     untouched and wraps everything else in FleetTransportError, so an
 *     HTTP 429, an HTTP 401, a body this transport cannot read and a socket
 *     that died must be raised as the engine's OWN error classes to stay
 *     distinguishable to the caller. classifyEndpointFailure() maps onto that
 *     existing taxonomy (../errors/workflow-errors.mjs) rather than declaring
 *     a parallel one.
 *
 *     Not every failure is a throw, though: `structuredContent.isError` with
 *     a `reason` is how execute_prompt already reports a dispatch that failed
 *     BEFORE any real LLM content was produced (busy member, non-zero exit),
 *     and the engine turns that channel into a typed AgentDispatchError by
 *     itself. A non-2xx from an endpoint is exactly that kind of failure, so
 *     dispatchFailureFromHttp() keeps it on that channel -- classified, but
 *     not thrown -- instead of every non-2xx blowing up as a raw rejection.
 *
 * NO HTTP CLIENT CODE BELONGS IN THIS MODULE. It never calls fetch, never
 * builds a header, never reads process.env, and holds no module-level state,
 * so it is testable with hand-written payloads and no network or API key.
 */

import { AgentDispatchError, AgentOutputError, FleetTransportError } from '../errors/workflow-errors.mjs';

/** Longest provider-supplied text quoted back inside an error message. */
const BODY_EXCERPT_LIMIT = 500;

/**
 * @typedef {object} EngineUsage
 * @property {number} input_tokens
 * @property {number} output_tokens
 * @property {number} total_tokens - what the engine's `hasRealUsage` check
 *   keys off (`typeof reportedUsage.total_tokens === 'number'`).
 */

/**
 * @typedef {object} EngineEnvelope
 * @property {Array<{type: string, text: string}>} content
 * @property {{response?: string, usage?: EngineUsage, isError?: boolean, reason?: string}} structuredContent
 */

function firstNumber(...candidates) {
    for (const candidate of candidates) {
        if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
    }
    return null;
}

function excerpt(value) {
    if (value === undefined || value === null) return '';
    let text;
    if (typeof value === 'string') {
        text = value;
    } else {
        try {
            text = JSON.stringify(value);
        } catch {
            text = String(value);
        }
    }
    if (typeof text !== 'string') text = String(text);
    return text.length > BODY_EXCERPT_LIMIT ? `${text.slice(0, BODY_EXCERPT_LIMIT)}...` : text;
}

/**
 * Translate a provider-native usage object into the engine's usage shape.
 *
 * Reads both spellings in use across the shapes this transport serves --
 * `input_tokens`/`output_tokens` (Anthropic native) and
 * `prompt_tokens`/`completion_tokens` (OpenAI-compatible) -- and derives
 * `total_tokens` when the provider did not report one.
 *
 * Returns null, NEVER a zero-filled object, when the provider reported no
 * token counts at all: the engine treats a usage object with a numeric
 * `total_tokens` as real spend, so fabricating one here would report a paid
 * call as free and quietly corrupt every budget and cost total downstream
 * (see the `hasRealUsage` / `_resolveCost` handling in the engine). A
 * provider that genuinely reports zeros is taken at its word.
 *
 * Idempotent: feeding it an already-normalized EngineUsage returns the same
 * values, so an adapter can pass provider JSON straight through.
 *
 * @param {unknown} raw
 * @returns {EngineUsage | null}
 */
export function normalizeUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const input = firstNumber(raw.input_tokens, raw.prompt_tokens);
    const output = firstNumber(raw.output_tokens, raw.completion_tokens);
    // Only a total, with neither side broken out, is not enough to price a
    // call; treat it as "not reported" rather than inventing the split.
    if (input === null && output === null) return null;
    const inputTokens = input === null ? 0 : input;
    const outputTokens = output === null ? 0 : output;
    const reportedTotal = firstNumber(raw.total_tokens);
    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: reportedTotal === null ? inputTokens + outputTokens : reportedTotal
    };
}

/**
 * Build the envelope the engine accepts for a successful dispatch.
 *
 * @param {{text: string, usage?: unknown}} reply - `text` is the assistant
 *   reply the adapter pulled out of the provider payload; `usage` is the
 *   provider's usage object (raw or already normalized), omitted or null when
 *   the provider reported none.
 * @returns {EngineEnvelope}
 * @throws {AgentOutputError} when `text` is not a string -- i.e. the adapter
 *   found no readable reply in the provider payload. Thrown, not returned, so
 *   a malformed body surfaces as a typed error instead of an envelope whose
 *   missing `text` crashes inside the engine.
 */
export function buildEnvelope(reply) {
    const { text, usage } = reply ?? {};
    if (typeof text !== 'string') {
        throw classifyEndpointFailure({
            kind: 'malformed',
            detail: `expected the provider reply text to be a string, got ${text === null ? 'null' : typeof text}`,
            body: reply
        });
    }
    const normalizedUsage = normalizeUsage(usage);
    return {
        content: [{ type: 'text', text }],
        structuredContent: {
            response: text,
            ...(normalizedUsage ? { usage: normalizedUsage } : {})
        }
    };
}

/**
 * Build the envelope for a dispatch that failed before any real LLM content
 * was produced. The engine reads `structuredContent.isError` first and raises
 * its own AgentDispatchError carrying `reason` and `content[0].text`, so this
 * is a classified failure that never reaches schema extraction or the repair
 * loop -- not a silent success and not a raw rejection.
 *
 * @param {{reason: string, message: string, usage?: unknown}} failure
 * @returns {EngineEnvelope}
 */
export function buildDispatchFailureEnvelope(failure) {
    const { reason, message, usage } = failure ?? {};
    const text = typeof message === 'string' && message !== '' ? message : 'endpoint dispatch failed';
    const normalizedUsage = normalizeUsage(usage);
    return {
        content: [{ type: 'text', text }],
        structuredContent: {
            isError: true,
            reason: typeof reason === 'string' && reason !== '' ? reason : 'endpoint_error',
            ...(normalizedUsage ? { usage: normalizedUsage } : {})
        }
    };
}

/**
 * Map an HTTP status onto a stable `reason` code. Codes follow the
 * convention already used by execute_prompt's structuredContent.reason
 * ('busy', 'empty_response', ...): a short snake_case string callers can
 * branch on, never a message to sniff.
 *
 * @param {number} status
 * @returns {string}
 */
export function httpFailureReason(status) {
    if (status === 401 || status === 403) return 'auth_failed';
    if (status === 408) return 'timeout';
    if (status === 429) return 'rate_limited';
    if (status >= 500 && status <= 599) return 'provider_error';
    if (status >= 400 && status <= 499) return 'invalid_request';
    return 'http_error';
}

/**
 * Classify an endpoint failure onto the engine's typed error taxonomy.
 *
 * One constructor per failure class, so a caller can tell them apart by type
 * and not by message substring:
 *   - 'network'   -> FleetTransportError  (request never got a response:
 *                    DNS/socket failure, abort, TLS error)
 *   - 'malformed' -> AgentOutputError     (a response arrived but this
 *                    transport could not read a reply out of it)
 *   - 'http'      -> AgentDispatchError   (a well-formed non-2xx: the
 *                    dispatch failed before any LLM content existed)
 *
 * @param {{kind: 'network'|'malformed'|'http', status?: number, statusText?: string,
 *   body?: unknown, detail?: string, url?: string, cause?: unknown}} failure
 * @returns {FleetTransportError|AgentOutputError|AgentDispatchError}
 */
export function classifyEndpointFailure(failure) {
    const { kind, status, statusText, body, detail, url, cause } = failure ?? {};
    const where = url ? ` to ${url}` : '';

    if (kind === 'malformed') {
        const why = detail || excerpt(body) || 'unreadable provider response';
        return new AgentOutputError(
            `[Endpoint Transport] the provider response${where} could not be read as a reply: ${why}`,
            { details: { reason: 'malformed_response', body: excerpt(body), url }, cause }
        );
    }

    if (kind === 'http') {
        const reason = httpFailureReason(typeof status === 'number' ? status : -1);
        const statusLabel = `${status}${statusText ? ` ${statusText}` : ''}`;
        return new AgentDispatchError(
            `[Endpoint Transport] the provider request${where} failed with HTTP ${statusLabel} (${reason}): ${excerpt(body)}`,
            { details: { reason, status, statusText, body: excerpt(body), url }, cause }
        );
    }

    // 'network', plus any unrecognized kind: no usable response ever arrived,
    // which is exactly what FleetTransportError means. An unrecognized kind
    // is still classified rather than thrown on, so a bad call site can never
    // turn a failure into a crash inside the classifier itself.
    const why = detail || (cause && cause.message) || 'the request failed before a response was received';
    return new FleetTransportError(
        `[Endpoint Transport] the provider request${where} failed before a response was received: ${why}`,
        { details: { reason: 'network_error', kind, url }, cause }
    );
}

/**
 * Turn a non-2xx response into the isError envelope, classified by the same
 * status -> reason mapping classifyEndpointFailure() uses, so the thrown and
 * the reported view of an HTTP failure never disagree.
 *
 * Adapters should prefer this over throwing for a non-2xx: the engine already
 * converts it into a typed AgentDispatchError with the same reason, and it
 * keeps any usage the provider still reported attached to the failure.
 *
 * @param {{status?: number, statusText?: string, body?: unknown, url?: string, usage?: unknown}} failure
 * @returns {EngineEnvelope}
 */
export function dispatchFailureFromHttp(failure) {
    const f = failure ?? {};
    const classified = classifyEndpointFailure({ ...f, kind: 'http' });
    return buildDispatchFailureEnvelope({
        reason: classified.details.reason,
        message: classified.message,
        usage: f.usage
    });
}
