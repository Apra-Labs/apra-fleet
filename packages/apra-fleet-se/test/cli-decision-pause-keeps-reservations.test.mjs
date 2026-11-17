// Reservation handling across a cooperative pause, by pause source
// (bin/cli.mjs wirePauseReservations): a paused-awaiting-decision pause
// (source 'needs_decision') keeps every member reservation and its resume
// re-acquires/resyncs nothing; any other pause (usage limit, operator) still
// hands the reservations back and its resume re-acquires them once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { wirePauseReservations } from '../bin/cli.mjs';
import { DECISION_PAUSE_SOURCE } from '../fleet-sprint/decision-wait.mjs';

function wired() {
    const wf = new FleetWorkflow({});
    const calls = { releases: 0, reReserves: 0 };
    wirePauseReservations({
        workflow: wf,
        releaseForPause: async () => { calls.releases += 1; },
        reReserve: async () => { calls.reReserves += 1; return { reacquired: ['a'] }; },
    });
    return { wf, calls };
}

test('a needs_decision pause keeps every reservation and its resume re-acquires and resyncs nothing', async () => {
    const { wf, calls } = wired();
    wf.requestPause('awaiting operator decision(s)', { source: DECISION_PAUSE_SOURCE });
    assert.equal(wf._paused, true, 'the pause engaged (idle engine)');
    await wf.requestResume('answered');
    assert.deepEqual(calls, { releases: 0, reReserves: 0 });
});

test('a usage-limit or operator pause still releases on paused and re-reserves once on resume', async () => {
    const { wf, calls } = wired();
    wf.requestPause('usage limit', { source: 'usage_limit' });
    await wf.requestResume('reset');
    assert.deepEqual(calls, { releases: 1, reReserves: 1 });
    wf.requestPause('operator pause');
    await wf.requestResume('operator resume');
    assert.deepEqual(calls, { releases: 2, reReserves: 2 });
});

test('the source is per pause: a decision pause after a usage-limit pause keeps its reservations', async () => {
    const { wf, calls } = wired();
    wf.requestPause('usage limit', { source: 'usage_limit' });
    await wf.requestResume('reset');
    wf.requestPause('awaiting operator decision(s)', { source: DECISION_PAUSE_SOURCE });
    await wf.requestResume('answered');
    assert.deepEqual(calls, { releases: 1, reReserves: 1 });
});

test('a failed re-reserve leaves the run paused and is retried on the next resume', async () => {
    const wf = new FleetWorkflow({});
    let attempts = 0;
    wirePauseReservations({
        workflow: wf,
        releaseForPause: async () => {},
        reReserve: async () => { attempts += 1; if (attempts === 1) throw new Error('member b reserved by another sprint'); return {}; },
    });
    wf.requestPause('operator pause');
    await assert.rejects(() => wf.requestResume('first try'), /member b reserved/);
    assert.equal(wf._paused, true, 'still paused after the failed re-reserve');
    await wf.requestResume('second try');
    assert.equal(attempts, 2);
    assert.equal(wf._paused, false);
});
