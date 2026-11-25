// Bounded wait for the supervisor service URL (acquire / allocate only).
// Only a REFUSED connection is retried; reset and HTTP errors never are.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    createHttpDoltPushMutexClient,
    createHttpChildIdAllocatorClient,
    resolveSupervisorWaitMs,
    DEFAULT_SUPERVISOR_WAIT_MS,
} from '../fleet-sprint/coordination.mjs';
import { SupervisorUnreachableError, isSupervisorUnreachableFailure, isDoltCredentialFailure } from '../fleet-sprint/errors.mjs';
import { postDispatchSyncMessage } from '../fleet-sprint/git-sync.mjs';

const URL_ = 'http://127.0.0.1:8787';

function fetchError(code) {
    const cause = Object.assign(new Error(`connect ${code}`), { code });
    return new TypeError('fetch failed', { cause });
}
const okJson = (payload) => ({ ok: true, status: 200, json: async () => payload });

function harness(script) {
    const calls = [];
    const fetch = async (url) => {
        const step = script[Math.min(calls.length, script.length - 1)];
        calls.push(url);
        if (step instanceof Error) throw step;
        return step;
    };
    let clock = 0;
    const logs = [];
    return {
        calls, logs,
        opts: {
            serviceUrl: URL_, sprintId: 's1', fetch, log: (l) => logs.push(l),
            now: () => clock, sleep: async (ms) => { clock += ms; },
            supervisorWaitMs: 10_000, supervisorBackoffMs: 1_000,
        },
    };
}

describe('refused connection is waited out', () => {
    for (const kind of ['acquire', 'allocate']) {
        test(`${kind} succeeds after N refusals and logs N wait lines naming the URL`, async () => {
            const ok = kind === 'acquire' ? okJson({ token: 't1' }) : okJson({ childId: 'x.1', token: 'c1' });
            const h = harness([fetchError('ECONNREFUSED'), fetchError('ECONNREFUSED'), fetchError('ECONNREFUSED'), ok]);
            const client = kind === 'acquire' ? createHttpDoltPushMutexClient(h.opts) : createHttpChildIdAllocatorClient(h.opts);
            const r = kind === 'acquire' ? await client.acquire('s1') : await client.allocate('x');
            assert.equal(h.calls.length, 4);
            assert.equal(h.logs.length, 3);
            for (const l of h.logs) assert.ok(l.includes(URL_), l);
            assert.ok(r.token);
        });

        test(`${kind} that is always refused throws the typed error naming the URL, no credentials wording`, async () => {
            const h = harness([fetchError('ECONNREFUSED')]);
            const client = kind === 'acquire' ? createHttpDoltPushMutexClient(h.opts) : createHttpChildIdAllocatorClient(h.opts);
            const run = () => (kind === 'acquire' ? client.acquire('s1') : client.allocate('x'));
            await assert.rejects(run, (err) => {
                assert.ok(err instanceof SupervisorUnreachableError);
                assert.equal(err.code, 'SUPERVISOR_UNREACHABLE');
                assert.ok(err.message.includes(URL_));
                assert.ok(!/credential|remote/i.test(err.message), err.message);
                return true;
            });
        });
    }

    test('ECONNREFUSED inside an AggregateError is still a refusal', async () => {
        const agg = new AggregateError([Object.assign(new Error('x'), { code: 'ECONNREFUSED' })], 'agg');
        const h = harness([new TypeError('fetch failed', { cause: agg }), okJson({ token: 't' })]);
        await createHttpDoltPushMutexClient(h.opts).acquire('s1');
        assert.equal(h.calls.length, 2);
    });
});

describe('everything else is never retried', () => {
    for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'ETIMEDOUT']) {
        test(`${code}: one call, typed error at once`, async () => {
            const h = harness([fetchError(code), okJson({ token: 't' })]);
            await assert.rejects(createHttpDoltPushMutexClient(h.opts).acquire('s1'), (e) => e instanceof SupervisorUnreachableError && e.message.includes(URL_));
            assert.equal(h.calls.length, 1);
            assert.equal(h.logs.length, 0);
        });
    }

    test('HTTP 503: one call, plain HTTP error as before', async () => {
        const h = harness([{ ok: false, status: 503, json: async () => ({}) }, okJson({ token: 't' })]);
        await assert.rejects(createHttpDoltPushMutexClient(h.opts).acquire('s1'), (e) => !(e instanceof SupervisorUnreachableError) && /HTTP 503/.test(e.message));
        assert.equal(h.calls.length, 1);
    });

    test('release/renew stay one-attempt non-fatal (no wait)', async () => {
        const h = harness([fetchError('ECONNREFUSED')]);
        const c = createHttpDoltPushMutexClient(h.opts);
        assert.equal(await c.release('t'), false);
        assert.equal(await c.renew('t'), false);
        assert.equal(h.calls.length, 2);
    });
});

describe('budget env and error classification', () => {
    test('resolveSupervisorWaitMs defaults and clamps', () => {
        assert.equal(resolveSupervisorWaitMs({}), DEFAULT_SUPERVISOR_WAIT_MS);
        assert.equal(resolveSupervisorWaitMs({ FLEET_SPRINT_SUPERVISOR_WAIT_MS: '5' }), DEFAULT_SUPERVISOR_WAIT_MS);
        assert.equal(resolveSupervisorWaitMs({ FLEET_SPRINT_SUPERVISOR_WAIT_MS: '5000' }), 5000);
    });

    test('PostDispatchSyncError message names the supervisor, not credentials/remote', () => {
        const typed = new SupervisorUnreachableError(URL_, { detail: 'connection refused for 120s' });
        const msg = postDispatchSyncMessage('m1', new Error('wrapped', { cause: typed }));
        assert.ok(/supervisor/i.test(msg));
        assert.ok(!/credentials\/remote/.test(msg));
        assert.ok(isSupervisorUnreachableFailure(new Error('w', { cause: typed })));
        assert.ok(!isDoltCredentialFailure(typed));
        assert.ok(/credentials\/remote/.test(postDispatchSyncMessage('m1', new Error('boom'))));
    });
});
