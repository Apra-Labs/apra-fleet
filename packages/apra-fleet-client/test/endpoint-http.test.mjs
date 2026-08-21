import test from 'node:test';
import assert from 'node:assert';
import { postJson } from '../src/endpoint/http.mjs';
import { CancelledError, FleetTransportError } from '../src/errors/workflow-errors.mjs';

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
