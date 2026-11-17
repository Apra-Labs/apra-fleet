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
 * Recognize an aborted fetch rejection so it can be classified as a
 * cancellation rather than a network failure. Covers the two spellings seen
 * in practice: the spec `AbortError` name (browsers, Node's `fetch`), and
 * undici's `ABORT_ERR` code (Node's global fetch implementation).
 *
 * @param {unknown} cause
 * @returns {boolean}
 */
function isAbortError(cause) {
    if (!cause || typeof cause !== 'object') return false;
    return cause.name === 'AbortError' || cause.code === 'ABORT_ERR' || cause.code === 'ABORTED';
}

/**
 * Recognize the abort reason `AbortSignal.timeout()` produces, so a request
 * that hit ITS deadline can be classified as its own 'timeout' kind rather
 * than folded into 'aborted' (the CancelledError/cooperative-cancellation
 * meaning -- see classifyEndpointFailure's kind doc in core.mjs).
 * `AbortSignal.timeout()` fires with a `DOMException` whose name is
 * `'TimeoutError'`, distinct from the `'AbortError'` name/`ABORT_ERR' code an
 * explicit `controller.abort()` produces.
 *
 * @param {unknown} cause
 * @returns {boolean}
 */
function isTimeoutError(cause) {
    if (!cause || typeof cause !== 'object') return false;
    return cause.name === 'TimeoutError';
}

/**
 * Fallback request deadline (ms) applied when neither the caller
 * (`options.timeoutMs` / `options.timeout_s`) nor the transport config
 * (`config.timeoutMs`) supplies one. A stalled connection must never hang a
 * dispatch indefinitely -- see apra-fleet-5se.16 -- so this is the last
 * resort, not an opt-in.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Resolve the request deadline (ms) for a dispatch: the caller's
 * `options.timeoutMs` first, then `options.timeout_s` (seconds -> ms), then
 * the transport's own `config.timeoutMs`, then DEFAULT_REQUEST_TIMEOUT_MS.
 * Never returns undefined/0 -- a deadline is always enforced.
 *
 * @param {{timeoutMs?: number, timeout_s?: number}} [options]
 * @param {{timeoutMs?: number}} [config]
 * @returns {number}
 */
export function resolveRequestTimeoutMs(options = {}, config = {}) {
    if (typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
        return options.timeoutMs;
    }
    if (typeof options.timeout_s === 'number' && Number.isFinite(options.timeout_s) && options.timeout_s > 0) {
        return options.timeout_s * 1000;
    }
    if (typeof config.timeoutMs === 'number' && Number.isFinite(config.timeoutMs) && config.timeoutMs > 0) {
        return config.timeoutMs;
    }
    return DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * Compose the caller's signal (if any) with a deadline that fires after
 * `timeoutMs`, so either one aborting the request is honoured. `AbortSignal.any`
 * preserves whichever sub-signal's `.reason` actually fired, which is what
 * lets postJson tell a deadline expiry (`TimeoutError`) apart from a caller
 * cancellation (`AbortError`) after the fact.
 *
 * Deliberately NOT `AbortSignal.timeout()`: that helper's own internal timer
 * is unref'd (Node will not keep the process alive on its account alone), so
 * a dispatch whose only other work is a fetch with no live handle yet (DNS
 * still resolving, or a hand-written test stub) could have the process exit
 * before the deadline ever fires, silently defeating the whole point of this
 * fix. Using a plain (ref'd) `setTimeout` here means the deadline is
 * guaranteed to fire; `clearDeadline()` releases it as soon as the request
 * settles for any other reason, so a fast/successful call never holds the
 * process open for the rest of `timeoutMs`.
 *
 * @param {AbortSignal | undefined} signal
 * @param {number} timeoutMs
 * @returns {{signal: AbortSignal, clearDeadline: () => void}}
 */
function withDeadline(signal, timeoutMs) {
    const deadlineController = new AbortController();
    const timer = setTimeout(() => {
        deadlineController.abort(new DOMException('The operation timed out', 'TimeoutError'));
    }, timeoutMs);
    const clearDeadline = () => clearTimeout(timer);
    const combined = signal ? AbortSignal.any([signal, deadlineController.signal]) : deadlineController.signal;
    return { signal: combined, clearDeadline };
}

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
 * Classify a failure by the request signal's own fired state, so the reason a
 * fetch rejected or a body read failed while the caller was cancelling (or
 * the deadline expired) is the cancellation/timeout, not whatever the
 * underlying rejection happens to look like. Shared by postJson's
 * fetch-rejection catch and its body-read catch so the two call sites cannot
 * drift (see apra-fleet-5se.17/5se.18).
 *
 * @param {AbortSignal | undefined} requestSignal
 * @param {string} url
 * @returns {Error | null} the classified error to throw, or `null` when the
 *   signal never fired -- the caller should fall through to its own
 *   classification in that case.
 */
function classifyBySignalState(requestSignal, url) {
    if (!requestSignal || !requestSignal.aborted) return null;
    const kind = isTimeoutError(requestSignal.reason) ? 'timeout' : 'aborted';
    return classifyEndpointFailure({ kind, url, cause: requestSignal.reason });
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
 * Throws only for the failures that are not about the provider's answer:
 *   - the caller's signal was already, or became, aborted -> CancelledError
 *   - the request deadline (timeoutMs) expired first -> FleetTransportError
 *     with details.reason 'timeout' (its own kind, not folded into the
 *     cancellation above -- see classifyEndpointFailure's kind doc)
 *   - the request never got a response for any other reason -> FleetTransportError
 *   - a response arrived whose body could not even be read -> AgentOutputError
 * A non-2xx is NOT thrown: it comes back as `ok: false` for the adapter to
 * report on the engine's isError channel via dispatchFailureFromHttp().
 *
 * @param {{fetchImpl: Function, url: string, headers?: Record<string,string>,
 *   body: unknown, signal?: AbortSignal, timeoutMs?: number}} request -
 *   `timeoutMs`, when supplied, is enforced via a deadline composed with the
 *   caller's `signal` (see resolveRequestTimeoutMs() and withDeadline()).
 * @returns {Promise<{ok: boolean, status: number, statusText: string, url: string,
 *   body: unknown, isJson: boolean}>}
 */
export async function postJson({ fetchImpl, url, headers = {}, body, signal, timeoutMs } = {}) {
    const hasDeadline = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0;
    const deadline = hasDeadline ? withDeadline(signal, timeoutMs) : null;
    const requestSignal = deadline ? deadline.signal : signal;

    try {
        // A signal that fired before fetch was even called (requestStop() raced
        // ahead of dispatch, or the deadline was already in the past) must be
        // honoured the same way as an abort that happens mid-flight -- some fetch
        // implementations only surface this via the AbortError rejection below,
        // but not all are guaranteed to.
        const preFlightSignalFailure = classifyBySignalState(requestSignal, url);
        if (preFlightSignalFailure) throw preFlightSignalFailure;

        let response;
        try {
            response = await fetchImpl(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...headers },
                body: JSON.stringify(body),
                ...(requestSignal ? { signal: requestSignal } : {})
            });
        } catch (cause) {
            // Classify by the signal's own state first, not by sniffing the
            // rejection's name/code: FleetWorkflow.requestStop() aborts with
            // a CancelledError whose name is 'CancelledError' (WorkflowError
            // sets this.name = this.constructor.name), which isAbortError()
            // does not recognize. If the composed signal actually fired,
            // this WAS an abort (or its own deadline expiry) regardless of
            // what the rejection reason looks like; only fall through to the
            // name/code sniffing -- and then 'network' -- when the signal
            // never fired at all.
            const fetchSignalFailure = classifyBySignalState(requestSignal, url);
            if (fetchSignalFailure) throw fetchSignalFailure;
            if (isTimeoutError(cause)) {
                throw classifyEndpointFailure({ kind: 'timeout', url, cause });
            }
            if (isAbortError(cause)) {
                throw classifyEndpointFailure({ kind: 'aborted', url, cause });
            }
            throw classifyEndpointFailure({ kind: 'network', url, cause });
        }

        let text;
        try {
            text = await response.text();
        } catch (cause) {
            // Same guard as the fetch-rejection catch above: once headers have
            // arrived, a cooperative cancellation or a deadline expiry can
            // surface as a body-read failure rather than a fetch rejection
            // (undici resolves the fetch promise as soon as headers arrive).
            // Classify by the signal's own state first so that case is
            // reported as its real kind, not folded into 'malformed'.
            const bodyReadSignalFailure = classifyBySignalState(requestSignal, url);
            if (bodyReadSignalFailure) throw bodyReadSignalFailure;
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
    } finally {
        // Release the deadline timer as soon as the request settles for any
        // reason, so a fast/successful call never holds the process open for
        // the remainder of timeoutMs.
        if (deadline) deadline.clearDeadline();
    }
}
