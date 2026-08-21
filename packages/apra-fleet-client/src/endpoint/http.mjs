/**
 * Shared HTTP plumbing for the endpoint shape adapters.
 *
 * core.mjs deliberately owns no HTTP client code (see its header), and a
 * shape adapter should be nothing but "build this provider's request body"
 * plus "read the reply text out of this provider's response body". Everything
 * in between -- config validation, fetch injection, URL joining, turning a
 * dead socket or an unreadable body into the engine's typed errors -- is the
 * same for every shape, so it lives here once instead of being re-derived
 * (and re-mis-derived) per adapter.
 *
 * CONFIG IS ALWAYS INJECTED. Nothing in this module or its callers reads
 * process.env: the first consumer is an Azure Function whose config layer is
 * a deliberate single source of truth with no fallbacks, and a package that
 * reached for env behind its back would break that contract. `fetch` is
 * injected the same way, which is what makes every adapter testable with no
 * network and no API key.
 */

import { classifyEndpointFailure } from './core.mjs';

/**
 * @param {unknown} value
 * @param {string} what - the config field name, used verbatim in the error.
 * @returns {string}
 * @throws {TypeError} when the field is missing or blank. A TypeError, not a
 *   WorkflowError: this is a caller wiring mistake at construction time, not
 *   a dispatch failure the engine should classify and report as a run result.
 */
export function requireString(value, what) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(
            `[Endpoint Transport] config.${what} is required and must be a non-empty string. ` +
            'Endpoint config is injected by the caller; this package never reads it from the environment.'
        );
    }
    return value;
}

/**
 * Resolve the fetch implementation an adapter should use: the injected one
 * when supplied, otherwise the platform global (Node 22+ always has one).
 *
 * @param {{fetch?: Function}} config
 * @returns {Function}
 */
export function resolveFetch(config = {}) {
    const impl = config.fetch ?? globalThis.fetch;
    if (typeof impl !== 'function') {
        throw new TypeError(
            '[Endpoint Transport] no fetch implementation available: pass config.fetch, or run on a platform with a global fetch.'
        );
    }
    return impl;
}

/**
 * Join a configured base URL with an adapter's path, tolerating a trailing
 * slash on the base (`https://host/v1/` + `/chat/completions`).
 *
 * @param {string} baseUrl
 * @param {string} path
 * @returns {string}
 */
export function joinUrl(baseUrl, path) {
    return `${String(baseUrl).replace(/\/+$/, '')}${path}`;
}

/**
 * POST a JSON body and hand the adapter back a flat, already-read result.
 *
 * Never returns a Response: the body is consumed here so that both the
 * success path and the failure path see the same value, and so an adapter can
 * never leak an unread stream. `body` is the parsed JSON when the payload
 * parsed, otherwise the raw text (kept, not discarded, so a provider's HTML
 * error page still shows up in the classified error's excerpt).
 *
 * Throws only for the two failures that are not about the provider's answer:
 *   - the request never got a response -> FleetTransportError
 *   - a response arrived whose body could not even be read -> AgentOutputError
 * A non-2xx is NOT thrown: it comes back as `ok: false` for the adapter to
 * report on the engine's isError channel via dispatchFailureFromHttp().
 *
 * @param {{fetchImpl: Function, url: string, headers?: Record<string,string>,
 *   body: unknown, signal?: AbortSignal}} request
 * @returns {Promise<{ok: boolean, status: number, statusText: string, url: string,
 *   body: unknown, isJson: boolean}>}
 */
export async function postJson({ fetchImpl, url, headers = {}, body, signal } = {}) {
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
            ...(signal ? { signal } : {})
        });
    } catch (cause) {
        throw classifyEndpointFailure({ kind: 'network', url, cause });
    }

    let text;
    try {
        text = await response.text();
    } catch (cause) {
        throw classifyEndpointFailure({
            kind: 'malformed',
            url,
            detail: 'the response body could not be read',
            cause
        });
    }

    let parsed;
    let isJson = false;
    if (typeof text === 'string' && text !== '') {
        try {
            parsed = JSON.parse(text);
            isJson = true;
        } catch {
            // Left as raw text on purpose -- see the doc comment above.
        }
    }

    const status = typeof response.status === 'number' ? response.status : -1;
    return {
        // Derived from the status rather than read off `response.ok`, so a
        // hand-written stub in a test only has to supply what a real provider
        // reply actually carries.
        ok: status >= 200 && status <= 299,
        status,
        statusText: typeof response.statusText === 'string' ? response.statusText : '',
        url,
        body: isJson ? parsed : text,
        isJson
    };
}
