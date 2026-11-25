import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AgentDispatchError, CancelledError } from '@apralabs/apra-fleet-workflow';

import {
    createUsageLimitPauseController,
    PROBE_ERROR_LOG_MAX_CHARS,
    PROBE_ERROR_TRUNCATION_MARKER,
} from '../fleet-sprint/usage-limit-controller.mjs';
import { UsageLimitWaitExhaustedError } from '../fleet-sprint/errors.mjs';

// Every probe outcome after a usage-limit wait, with injected clock, sleep and
// agent: success, max_turns_exhausted (limit lifted), usage_limit (waits again
// until the reprobe budget is spent), transport error (inconclusive), and a
// CancelledError (propagated). Plus the single, truncated payload log.

const NOW = Date.UTC(2026, 0, 1);
const HOUR_MS = 60 * 60 * 1000;
const SIGNAL = { resumeAt: new Date(NOW + HOUR_MS).toISOString(), resumeAtSource: 'parsed' };
const MAX_REPROBES = 2;

const dispatchError = (reason, message = 'probe failed', extra = {}) =>
    new AgentDispatchError(message, { details: { reason, ...extra } });
const usageLimit = () => dispatchError('usage_limit', 'hit your usage limit', { usageLimit: { resumeAt: new Date(NOW + HOUR_MS).toISOString(), resumeAtSource: 'parsed' } });

async function run(probe) {
    const calls = { pause: 0, resume: 0, agent: 0 };
    const logs = [];
    const onUsageLimit = createUsageLimitPauseController({
        requestPause: () => { calls.pause += 1; },
        requestResume: async () => { calls.resume += 1; },
        agent: async () => { calls.agent += 1; return probe(calls.agent); },
        log: (m) => logs.push(m),
        budgets: { USAGE_LIMIT_MAX_REPROBES: MAX_REPROBES, USAGE_LIMIT_MAX_WAIT_S: 100 * 3600 },
        now: () => NOW,
        sleep: async () => {},
    });
    let value; let error;
    try { value = await onUsageLimit({ member: 'm', roleLabel: 'doer', signal: SIGNAL }); } catch (e) { error = e; }
    return { value, error, calls, logs };
}

const inconclusive = (logs) => logs.filter((m) => m.includes('was inconclusive'));

describe('usage-limit re-probe outcomes', () => {
    test('success -> resumed', async () => {
        const r = await run(() => 'ok');
        assert.deepEqual(r.value, { resumed: true });
        assert.deepEqual(r.calls, { pause: 1, resume: 1, agent: 1 });
        assert.equal(inconclusive(r.logs).length, 0);
    });

    test('max_turns_exhausted -> resumed (limit lifted), not inconclusive, no extra wait', async () => {
        const r = await run(() => { throw dispatchError('max_turns_exhausted'); });
        assert.deepEqual(r.value, { resumed: true });
        assert.deepEqual(r.calls, { pause: 1, resume: 1, agent: 1 });
        assert.equal(inconclusive(r.logs).length, 0, JSON.stringify(r.logs));
        assert.equal(r.logs.filter((m) => m.includes('proved the limit lifted')).length, 1);
    });

    test('usage_limit -> waits again and exhausts the budget after the configured reprobes', async () => {
        const r = await run(() => { throw usageLimit(); });
        assert.equal(r.value.resumed, false);
        assert.ok(r.value.error instanceof UsageLimitWaitExhaustedError);
        assert.deepEqual(r.calls, { pause: MAX_REPROBES + 1, resume: MAX_REPROBES + 1, agent: MAX_REPROBES + 1 });
    });

    test('transport error -> inconclusive, resumed', async () => {
        const r = await run(() => { throw dispatchError('transport_error', 'ECONNRESET'); });
        assert.deepEqual(r.value, { resumed: true });
        assert.deepEqual(r.calls, { pause: 1, resume: 1, agent: 1 });
        assert.equal(inconclusive(r.logs).length, 1);
    });

    test('CancelledError -> propagated', async () => {
        const r = await run(() => { throw new CancelledError('stopped'); });
        assert.ok(r.error instanceof CancelledError);
        assert.deepEqual(r.calls, { pause: 1, resume: 1, agent: 1 });
    });

    test('a 50k-character probe payload is logged at most once, truncated', async () => {
        const payload = 'PAYLOAD'.repeat(Math.ceil(50000 / 7)).slice(0, 50000);
        const r = await run(() => { throw dispatchError('transport_error', payload); });
        assert.deepEqual(r.value, { resumed: true });
        const hits = r.logs.filter((m) => m.includes('PAYLOADPAYLOAD'));
        assert.equal(hits.length, 1, `payload appears in ${hits.length} log lines`);
        assert.ok(hits[0].includes(PROBE_ERROR_TRUNCATION_MARKER));
        const payloadChars = (hits[0].match(/PAYLOAD/g) || []).length * 'PAYLOAD'.length;
        assert.ok(payloadChars <= PROBE_ERROR_LOG_MAX_CHARS, `${payloadChars} payload chars in the line`);
        assert.ok(r.logs.join('\n').length < PROBE_ERROR_LOG_MAX_CHARS + 1000, 'whole log stays bounded');
    });
});
