import test from 'node:test';
import assert from 'node:assert';

// Cross-package regression coverage for apra-fleet-5se.13, reproducing the
// exact scenario from the bug report: build an OpenAI-compatible endpoint
// transport whose injected fetch rejects with an AbortError when its signal
// fires, dispatch through the real engine (FleetWorkflow.agent()), and abort
// mid-dispatch. Before the fix, agent() rejected with FleetTransportError
// (code TRANSPORT_ERROR); it must now reject with CancelledError (code
// CANCELLED) so a deliberate stop stays distinguishable from a real network
// failure -- see isNoMutationDispatchFailure() in fleet-sprint/runner.js and
// softFail()'s deliberate CancelledError re-throw in the engine, both of
// which depend on that distinction.
//
// Imported through the package names (not relative paths), same as
// endpoint-factory.test.mjs, proving this works from a real consumer's PoV.
import { makeEndpointApi } from '@apralabs/apra-fleet-client/endpoint';
import { FleetWorkflow, CancelledError, FleetTransportError } from '@apralabs/apra-fleet-workflow';

function makeAbortError() {
    return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}

/** A fetch stub that never resolves on its own -- only rejects if/when its signal aborts. */
function pendingUntilAbortedFetch() {
    return (url, init) => new Promise((resolve, reject) => {
        const signal = init && init.signal;
        if (!signal) return;
        if (signal.aborted) {
            reject(makeAbortError());
            return;
        }
        signal.addEventListener('abort', () => reject(makeAbortError()), { once: true });
    });
}

test('endpoint transport + engine: an aborted dispatch rejects agent() with CancelledError, not FleetTransportError', async () => {
    const api = makeEndpointApi({
        provider: 'openai',
        baseUrl: 'https://api.openai.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        fetch: pendingUntilAbortedFetch()
    });
    const wf = new FleetWorkflow(api);
    const controller = new AbortController();

    const pending = wf.agent('hello', { member_name: 'endpoint', signal: controller.signal });
    controller.abort();

    await assert.rejects(pending, (err) => {
        assert.ok(err instanceof CancelledError, `expected CancelledError, got ${err.constructor.name}: ${err.message}`);
        assert.strictEqual(err.code, 'CANCELLED');
        assert.strictEqual(err instanceof FleetTransportError, false);
        return true;
    });
});

test('endpoint transport + engine: a genuine transport failure still rejects agent() with FleetTransportError (stays distinguishable)', async () => {
    const socketFailure = new Error('socket hang up');
    const api = makeEndpointApi({
        provider: 'openai',
        baseUrl: 'https://api.openai.test/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
        fetch: () => Promise.reject(socketFailure)
    });
    const wf = new FleetWorkflow(api);
    const controller = new AbortController();

    await assert.rejects(
        wf.agent('hello', { member_name: 'endpoint', signal: controller.signal }),
        (err) => {
            assert.ok(err instanceof FleetTransportError, `expected FleetTransportError, got ${err.constructor.name}: ${err.message}`);
            assert.strictEqual(err.code, 'TRANSPORT_ERROR');
            assert.strictEqual(err instanceof CancelledError, false);
            return true;
        }
    );
});
