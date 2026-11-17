import test from 'node:test';
import assert from 'node:assert';
import { postJson, resolveRequestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS } from '../src/endpoint/http.mjs';
import { AgentOutputError, CancelledError, FleetTransportError } from '../src/errors/workflow-errors.mjs';

// Regression coverage for apra-fleet-5se.13: postJson() used to funnel EVERY
// fetch rejection -- including an aborted request -- into
// classifyEndpointFailure({kind:'network'}), which yields FleetTransportError.
// That collapsed cooperative cancellation (FleetWorkflow.requestStop()) into
// an indistinguishable-from-a-real-network-failure error. postJson must now
// recognize an abort (mid-flight or already-fired before fetch is even
// called) and raise CancelledError instead, while a genuine socket failure
// still yields FleetTransportError so the two stay distinguishable.

function makeAbortError() {
    return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}

/** A fetch stub that never resolves on its own -- only rejects if/when its signal aborts. */
function pendingUntilAbortedFetch() {
    return (url, init) => new Promise((resolve, reject) => {
        const signal = init && init.signal;
        if (!signal) return; // would hang forever; tests always pass a signal
        if (signal.aborted) {
            reject(makeAbortError());
            return;
        }
        signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
    });
}

test('postJson - an abort mid-flight (fetch rejects with AbortError) raises CancelledError, not FleetTransportError', async () => {
    const controller = new AbortController();
    const fetchImpl = pendingUntilAbortedFetch();

    const pending = postJson({ fetchImpl, url: 'https://example.test/v1/chat/completions', body: {}, signal: controller.signal });
    controller.abort();

    await assert.rejects(pending, (err) => {
        assert.ok(err instanceof CancelledError, `expected CancelledError, got ${err.constructor.name}`);
        assert.strictEqual(err.code, 'CANCELLED');
        assert.strictEqual(err instanceof FleetTransportError, false);
        return true;
    });
});

test('postJson - a signal that is already aborted before fetch is called raises CancelledError without invoking fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    let fetchCalled = false;
    const fetchImpl = () => { fetchCalled = true; return Promise.reject(new Error('should not be called')); };

    await assert.rejects(
        postJson({ fetchImpl, url: 'https://example.test/v1/chat/completions', body: {}, signal: controller.signal }),
        (err) => {
            assert.ok(err instanceof CancelledError);
            return true;
        }
    );
    assert.strictEqual(fetchCalled, false, 'fetch must not be invoked once the signal is already aborted');
});

test('postJson - a mid-flight abort with a CancelledError-shaped reason (real requestStop() shape) raises CancelledError, not FleetTransportError', async () => {
    // Regression coverage for apra-fleet-5se.17: FleetWorkflow.requestStop()
    // aborts with controller.abort(new CancelledError(...)), and real fetch
    // rejects with that reason object verbatim -- whose name is
    // 'CancelledError', not 'AbortError'/ABORT_ERR/ABORTED. isAbortError()
    // never matches that shape, so postJson must classify by the signal's
    // own aborted state instead of sniffing the rejection's name/code.
    const controller = new AbortController();
    const fetchImpl = (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });

    const pending = postJson({ fetchImpl, url: 'https://example.test/v1/chat/completions', body: {}, signal: controller.signal });
    controller.abort(new CancelledError('run stopped'));

    await assert.rejects(pending, (err) => {
        assert.ok(err instanceof CancelledError, `expected CancelledError, got ${err.constructor.name}`);
        assert.strictEqual(err.code, 'CANCELLED');
        assert.strictEqual(err instanceof FleetTransportError, false);
        return true;
    });
});

test('postJson - a genuine socket failure (no abort involved) still raises FleetTransportError', async () => {
    const controller = new AbortController();
    const socketFailure = new Error('socket hang up');
    const fetchImpl = () => Promise.reject(socketFailure);

    await assert.rejects(
        postJson({ fetchImpl, url: 'https://example.test/v1/chat/completions', body: {}, signal: controller.signal }),
        (err) => {
            assert.ok(err instanceof FleetTransportError, `expected FleetTransportError, got ${err.constructor.name}`);
            assert.strictEqual(err.code, 'TRANSPORT_ERROR');
            assert.strictEqual(err.cause, socketFailure);
            assert.strictEqual(err instanceof CancelledError, false);
            return true;
        }
    );
});

test('postJson - a genuine socket failure with no signal at all still raises FleetTransportError (no regression)', async () => {
    const socketFailure = new Error('ECONNRESET');
    const fetchImpl = () => Promise.reject(socketFailure);

    await assert.rejects(
        postJson({ fetchImpl, url: 'https://example.test/v1/chat/completions', body: {} }),
        (err) => {
            assert.ok(err instanceof FleetTransportError);
            assert.strictEqual(err.cause, socketFailure);
            return true;
        }
    );
});

// Regression coverage for apra-fleet-5se.16: postJson() used to forward only
// the caller's signal to fetch and enforced no deadline of its own, so a
// provider that accepted the connection and then stalled hung the dispatch
// indefinitely. postJson must now compose a `timeoutMs` deadline with the
// caller's signal and classify a deadline expiry as its own 'timeout' kind --
// FleetTransportError, NOT CancelledError (that stays reserved for a
// deliberate FleetWorkflow.requestStop() cancellation).

/** A fetch stub that never resolves or rejects on its own -- only reacts to its signal aborting. */
function neverSettlingFetch() {
    return (url, init) => new Promise((resolve, reject) => {
        const signal = init && init.signal;
        if (!signal) return; // would hang forever; tests always pass timeoutMs
        if (signal.aborted) {
            reject(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }));
            return;
        }
        signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }));
        }, { once: true });
    });
}

test('postJson - a request that never settles raises FleetTransportError (reason: timeout) once timeoutMs expires, not CancelledError', async () => {
    const fetchImpl = neverSettlingFetch();

    await assert.rejects(
        postJson({ fetchImpl, url: 'https://example.test/v1/chat/completions', body: {}, timeoutMs: 20 }),
        (err) => {
            assert.ok(err instanceof FleetTransportError, `expected FleetTransportError, got ${err.constructor.name}: ${err.message}`);
            assert.strictEqual(err.code, 'TRANSPORT_ERROR');
            assert.strictEqual(err.details.reason, 'timeout');
            assert.strictEqual(err instanceof CancelledError, false);
            return true;
        }
    );
});

test('postJson - timeoutMs and a caller signal are composed: caller cancellation still raises CancelledError, not a timeout', async () => {
    const controller = new AbortController();
    const fetchImpl = (url, init) => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        }, { once: true });
    });

    const pending = postJson({
        fetchImpl,
        url: 'https://example.test/v1/chat/completions',
        body: {},
        signal: controller.signal,
        timeoutMs: 60_000
    });
    controller.abort();

    await assert.rejects(pending, (err) => {
        assert.ok(err instanceof CancelledError, `expected CancelledError, got ${err.constructor.name}`);
        assert.strictEqual(err instanceof FleetTransportError, false);
        return true;
    });
});

test('postJson - a caller signal that is already aborted with a TimeoutError reason is classified as timeout, not aborted, without invoking fetch', async () => {
    // A caller can hand postJson an already-composed signal of its own (e.g.
    // a caller-side deadline) whose reason happens to be a TimeoutError --
    // the pre-check must classify by the reason's shape, same as the
    // mid-flight path, and not just default every pre-aborted signal to
    // 'aborted'.
    const controller = new AbortController();
    controller.abort(new DOMException('deadline exceeded', 'TimeoutError'));
    let fetchCalled = false;
    const fetchImpl = () => { fetchCalled = true; return Promise.reject(new Error('should not be called')); };

    await assert.rejects(
        postJson({ fetchImpl, url: 'https://example.test/v1/chat/completions', body: {}, signal: controller.signal }),
        (err) => {
            assert.ok(err instanceof FleetTransportError, `expected FleetTransportError, got ${err.constructor.name}`);
            assert.strictEqual(err.details.reason, 'timeout');
            assert.strictEqual(err instanceof CancelledError, false);
            return true;
        }
    );
    assert.strictEqual(fetchCalled, false, 'fetch must not be invoked once the signal is already aborted');
});

// Regression coverage for apra-fleet-5se.18: once a response's headers have
// arrived, undici resolves the fetch promise -- so a cooperative cancellation
// or a deadline expiry that happens WHILE the body is still being read
// surfaces as a rejection from response.text(), not from fetch itself. The
// body-read catch used to classify every such failure as kind 'malformed'
// (AgentOutputError), losing the cancellation/timeout taxonomy. It must now
// apply the same signal-state guard as the fetch-rejection catch above.

/** A fetch stub whose response resolves immediately, but response.text() rejects with `reason` once the given signal aborts. */
function respondsThenStallsBodyFetch() {
    return (url, init) => Promise.resolve({
        status: 200,
        statusText: 'OK',
        text: () => new Promise((resolve, reject) => {
            const signal = init && init.signal;
            if (!signal) return; // would hang forever; tests always pass a signal
            if (signal.aborted) {
                reject(signal.reason);
                return;
            }
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    });
}

test('postJson - a deadline expiry during the body read raises FleetTransportError (reason: timeout), not AgentOutputError', async () => {
    const fetchImpl = respondsThenStallsBodyFetch();

    await assert.rejects(
        postJson({ fetchImpl, url: 'https://example.test/v1/chat/completions', body: {}, timeoutMs: 20 }),
        (err) => {
            assert.ok(err instanceof FleetTransportError, `expected FleetTransportError, got ${err.constructor.name}: ${err.message}`);
            assert.strictEqual(err.details.reason, 'timeout');
            assert.strictEqual(err instanceof CancelledError, false);
            return true;
        }
    );
});

test('postJson - a requestStop abort during the body read raises CancelledError (reason: cancelled), not AgentOutputError', async () => {
    const controller = new AbortController();
    const fetchImpl = respondsThenStallsBodyFetch();

    const pending = postJson({ fetchImpl, url: 'https://example.test/v1/chat/completions', body: {}, signal: controller.signal });
    controller.abort(new CancelledError('run stopped'));

    await assert.rejects(pending, (err) => {
        assert.ok(err instanceof CancelledError, `expected CancelledError, got ${err.constructor.name}`);
        assert.strictEqual(err.details.reason, 'cancelled');
        assert.strictEqual(err instanceof FleetTransportError, false);
        return true;
    });
});

test('postJson - a body-read failure with no aborted signal still raises AgentOutputError (reason: malformed_response)', async () => {
    const readFailure = new Error('premature close');
    const fetchImpl = () => Promise.resolve({
        status: 200,
        statusText: 'OK',
        text: () => Promise.reject(readFailure)
    });

    await assert.rejects(
        postJson({ fetchImpl, url: 'https://example.test/v1/chat/completions', body: {} }),
        (err) => {
            assert.ok(err instanceof AgentOutputError, `expected AgentOutputError, got ${err.constructor.name}`);
            assert.strictEqual(err.details.reason, 'malformed_response');
            assert.strictEqual(err.cause, readFailure);
            assert.strictEqual(err instanceof CancelledError, false);
            assert.strictEqual(err instanceof FleetTransportError, false);
            return true;
        }
    );
});

test('resolveRequestTimeoutMs - prefers options.timeoutMs, then options.timeout_s, then config.timeoutMs, then the default', () => {
    assert.strictEqual(resolveRequestTimeoutMs({ timeoutMs: 5000, timeout_s: 60 }, { timeoutMs: 9000 }), 5000);
    assert.strictEqual(resolveRequestTimeoutMs({ timeout_s: 30 }, { timeoutMs: 9000 }), 30 * 1000);
    assert.strictEqual(resolveRequestTimeoutMs({}, { timeoutMs: 9000 }), 9000);
    assert.strictEqual(resolveRequestTimeoutMs({}, {}), DEFAULT_REQUEST_TIMEOUT_MS);
    assert.strictEqual(resolveRequestTimeoutMs(), DEFAULT_REQUEST_TIMEOUT_MS);
});

test('resolveRequestTimeoutMs - ignores non-positive/non-finite hints and falls through to the next source', () => {
    assert.strictEqual(resolveRequestTimeoutMs({ timeoutMs: -1, timeout_s: 10 }, {}), 10 * 1000);
    assert.strictEqual(resolveRequestTimeoutMs({ timeoutMs: NaN }, { timeoutMs: 8000 }), 8000);
    assert.strictEqual(resolveRequestTimeoutMs({ timeout_s: 0 }, {}), DEFAULT_REQUEST_TIMEOUT_MS);
});
