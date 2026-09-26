import test from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { McpClient } from '../src/client/client.mjs';
import { ApraFleet, deriveTimeoutMs } from '../src/client/api.mjs';

/**
 * A transport whose send() never triggers a 'message' event -- simulates a
 * server that accepted the request and never replies without closing the
 * connection (apra-fleet-unw.5 / feedback.md F6).
 */
class BlackHoleTransport extends EventEmitter {
    async send(_message) {
        // never emits 'message'
    }
}

/**
 * A transport whose send() replies after a controllable delay, useful for
 * testing "late reply after timeout" and "normal fast response" scenarios.
 */
class DelayedTransport extends EventEmitter {
    constructor() {
        super();
        this.sent = [];
    }
    async send(message) {
        this.sent.push(message);
    }
    replyTo(id, result) {
        this.emit('message', { jsonrpc: '2.0', id, result });
    }
}

test('McpClient.request rejects with .code=TIMEOUT when the transport never replies', async () => {
    const transport = new BlackHoleTransport();
    const client = new McpClient(transport);

    const start = Date.now();
    await assert.rejects(
        client.request('never_replies', {}, { timeoutMs: 50 }),
        (err) => {
            assert.strictEqual(err.code, 'TIMEOUT');
            return true;
        }
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 50, `expected to wait at least 50ms, waited ${elapsed}ms`);
    assert.strictEqual(client.pendingRequests.size, 0);
});

test('McpClient.request default timeout is used when timeoutMs is omitted (never infinite)', async () => {
    // We can't wait 15 minutes in a unit test -- instead assert the default
    // constant is finite and sane, and that a short explicit override works
    // end-to-end (covered by the test above). This guards against a future
    // regression to `timeoutMs: undefined` meaning "wait forever".
    const mod = await import('../src/client/client.mjs');
    assert.ok(Number.isFinite(mod.DEFAULT_REQUEST_TIMEOUT_MS));
    assert.ok(mod.DEFAULT_REQUEST_TIMEOUT_MS > 0);
});

test('McpClient.request AbortSignal: aborting rejects and cleans up pendingRequests', async () => {
    const transport = new BlackHoleTransport();
    const client = new McpClient(transport);
    const controller = new AbortController();

    const pending = client.request('never_replies', {}, { timeoutMs: 60_000, signal: controller.signal });

    assert.strictEqual(client.pendingRequests.size, 1);
    controller.abort();

    await assert.rejects(pending, (err) => {
        assert.strictEqual(err.code, 'ABORTED');
        return true;
    });
    assert.strictEqual(client.pendingRequests.size, 0);
});

test('McpClient.request AbortSignal: an already-aborted signal rejects immediately', async () => {
    const transport = new BlackHoleTransport();
    const client = new McpClient(transport);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
        client.request('never_replies', {}, { signal: controller.signal }),
        (err) => {
            assert.strictEqual(err.code, 'ABORTED');
            return true;
        }
    );
    assert.strictEqual(client.pendingRequests.size, 0);
});

test('a late reply after timeout does not cause an unhandled rejection or corrupt other pending requests', async () => {
    const transport = new DelayedTransport();
    const client = new McpClient(transport);

    // Request A: will time out quickly.
    const idAPromise = client.request('slow_method', {}, { timeoutMs: 30 });
    await assert.rejects(idAPromise, (err) => {
        assert.strictEqual(err.code, 'TIMEOUT');
        return true;
    });

    const sentA = transport.sent.find(m => m.method === 'slow_method');
    assert.ok(sentA, 'expected slow_method request to have been sent');

    // Request B: still pending, must be unaffected by A's late reply.
    const idBPromise = client.request('other_method', {}, { timeoutMs: 5_000 });
    const sentB = transport.sent.find(m => m.method === 'other_method');
    assert.ok(sentB);

    // Simulate A's server reply arriving late, after A already timed out
    // client-side. This must be a silent no-op: no unhandled rejection, and
    // request B must resolve normally and independently.
    transport.replyTo(sentA.id, { content: 'too late' });

    transport.replyTo(sentB.id, { content: 'on time' });
    const resultB = await idBPromise;
    assert.deepStrictEqual(resultB, { content: 'on time' });

    assert.strictEqual(client.pendingRequests.size, 0);
});

test('normal fast responses are unaffected by the timeout/abort plumbing', async () => {
    const transport = new DelayedTransport();
    const client = new McpClient(transport);

    const resultPromise = client.callTool('my_tool', { foo: 'bar' });
    const sent = transport.sent[0] || (await new Promise(resolve => {
        // send() is async; wait a tick for it to be recorded
        setImmediate(() => resolve(transport.sent[0]));
    }));
    transport.replyTo(sent.id, { content: 'test result' });

    const result = await resultPromise;
    assert.deepStrictEqual(result, { content: 'test result' });
    assert.strictEqual(client.pendingRequests.size, 0);
});

test('deriveTimeoutMs prefers max_total_s over timeout_s and adds a grace margin', () => {
    assert.strictEqual(deriveTimeoutMs({ max_total_s: 60, timeout_s: 10 }), 60 * 1000 + 30 * 1000);
    assert.strictEqual(deriveTimeoutMs({ timeout_s: 10 }), 10 * 1000 + 30 * 1000);
    assert.strictEqual(deriveTimeoutMs({}), undefined);
    assert.strictEqual(deriveTimeoutMs(), undefined);
});

test('ApraFleet.executePrompt derives a timeoutMs from the payload and strips signal/timeoutMs before sending over the wire', async () => {
    let capturedArgs, capturedOpts;
    const mockClient = {
        async callTool(name, args, opts) {
            capturedArgs = args;
            capturedOpts = opts;
            return { content: [{ text: 'ok' }] };
        }
    };

    const fleet = new ApraFleet(mockClient);
    const controller = new AbortController();
    await fleet.executePrompt({ prompt: 'hi', max_total_s: 120, signal: controller.signal });

    assert.deepStrictEqual(capturedArgs, { prompt: 'hi', max_total_s: 120 });
    assert.strictEqual(capturedOpts.timeoutMs, 120 * 1000 + 30 * 1000);
    assert.strictEqual(capturedOpts.signal, controller.signal);
});

test('ApraFleet.executePrompt honors an explicit timeoutMs override', async () => {
    let capturedOpts;
    const mockClient = {
        async callTool(name, args, opts) {
            capturedOpts = opts;
            return { content: [{ text: 'ok' }] };
        }
    };

    const fleet = new ApraFleet(mockClient);
    await fleet.executePrompt({ prompt: 'hi', max_total_s: 120, timeoutMs: 5_000 });

    assert.strictEqual(capturedOpts.timeoutMs, 5_000);
});
