import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CancelledError } from '@apralabs/apra-fleet-workflow';

import { createUsageLimitPauseController } from '../fleet-sprint/usage-limit-controller.mjs';

// A stop during (or before) the usage-limit wait ends the wait at once with a
// CancelledError: no probe, no requestResume, no second requestPause. The
// injected sleep never resolves, so only the pause-end handle can end the wait.
// Reverting the stop handling in the controller leaves the wait pending forever
// (the test then fails on its bounded race below).

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 1);
const SIGNAL = { resumeAt: new Date(NOW + HOUR_MS).toISOString(), resumeAtSource: 'parsed' };
const BOUND_MS = 2000;

function build({ ended }) {
    const calls = { pause: 0, resume: 0, probe: 0, sleeps: 0 };
    const logs = [];
    const onUsageLimit = createUsageLimitPauseController({
        requestPause: () => { calls.pause += 1; return { ended }; },
        requestResume: async () => { calls.resume += 1; },
        agent: async () => { calls.probe += 1; return 'ok'; },
        log: (m) => logs.push(m),
        now: () => NOW,
        sleep: () => { calls.sleeps += 1; return new Promise(() => {}); },
    });
    return { onUsageLimit, calls, logs };
}

async function boundedOutcome(promise) {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), BOUND_MS); });
    try {
        return await Promise.race([promise.then((v) => ({ value: v }), (e) => ({ error: e })), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

test('a stop during the wait rejects with CancelledError promptly; no probe, no resume, no second pause', async () => {
    let settle;
    const ended = new Promise((r) => { settle = r; });
    const { onUsageLimit, calls, logs } = build({ ended });
    const run = onUsageLimit({ member: 'm', roleLabel: 'doer', signal: SIGNAL });
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.pause, 1);
    settle({ outcome: 'stop', reason: 'Stop requested via dashboard /stop endpoint' });
    const out = await boundedOutcome(run);
    assert.ok(!out.timedOut, 'the wait did not end on a stop');
    assert.ok(out.error instanceof CancelledError, `got ${out.error && out.error.message}`);
    assert.deepEqual({ pause: calls.pause, resume: calls.resume, probe: calls.probe }, { pause: 1, resume: 0, probe: 0 });
    const stopLines = logs.filter((m) => m.includes('ended by a stop'));
    assert.equal(stopLines.length, 1, JSON.stringify(logs));
    assert.ok(stopLines[0].includes('Stop requested via dashboard /stop endpoint'));
});

test('a stop that happened before the wait starts is honoured the same way', async () => {
    const ended = Promise.resolve({ outcome: 'stop', reason: 'run already stopped' });
    const { onUsageLimit, calls, logs } = build({ ended });
    const out = await boundedOutcome(onUsageLimit({ member: 'm', roleLabel: 'doer', signal: SIGNAL }));
    assert.ok(!out.timedOut);
    assert.ok(out.error instanceof CancelledError);
    assert.deepEqual({ pause: calls.pause, resume: calls.resume, probe: calls.probe }, { pause: 1, resume: 0, probe: 0 });
    assert.equal(logs.filter((m) => m.includes('ended by a stop')).length, 1);
});
