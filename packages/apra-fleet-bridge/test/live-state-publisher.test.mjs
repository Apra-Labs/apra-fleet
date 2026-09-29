// The public blob viewer reads sprints/<id>/state.json. While a sprint runs,
// watch republishes it through this module -- rate-limited, only on change,
// the terminal state always, and never throwing into watch's poll loop.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createLiveStatePublisher, liveStateBlobName, DEFAULT_LIVE_STATE_MIN_INTERVAL_MS } from '../src/spa/live-state-publisher.mjs';
import { BridgeError } from '../src/errors.mjs';

function fakeHttp({ status = 201, throwErr = null } = {}) {
  const calls = [];
  return {
    calls,
    putBlockBlob: async (args) => {
      calls.push(args);
      if (throwErr) throw throwErr;
      return { status, errorCode: status >= 300 ? 'AuthorizationFailure' : null };
    },
  };
}

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const LIVE = (n) => ({ live: true, state: { status: 'running', tree: [{ title: `phase ${n}` }], _strings: [] } });

function make(overrides = {}) {
  const http = overrides.http || fakeHttp();
  const c = overrides.clock || clock();
  const logs = [];
  const pub = createLiveStatePublisher({
    accountUrl: 'https://acct.invalid', containerName: 'c1', sas: 'sv=x&sig=SECRET',
    http, now: c.now, log: (m) => logs.push(m), ...overrides.deps,
  });
  return { pub, http, c, logs };
}

describe('live state publisher', () => {
  test('writes the state where the blob viewer reads it', async () => {
    const { pub, http } = make();
    const r = await pub.publish('s 1', LIVE(1));
    assert.deepEqual(r, { published: true, reason: 'changed' });
    assert.equal(http.calls[0].blobName, liveStateBlobName('s 1'));
    assert.equal(http.calls[0].blobName, 'sprints/s%201/state.json');
    assert.equal(http.calls[0].contentType, 'application/json');
    assert.deepEqual(JSON.parse(http.calls[0].body), LIVE(1).state);
  });

  test('an unchanged state is never re-sent', async () => {
    const { pub, http, c } = make();
    await pub.publish('s1', LIVE(1));
    c.advance(DEFAULT_LIVE_STATE_MIN_INTERVAL_MS * 3);
    assert.equal((await pub.publish('s1', LIVE(1))).reason, 'unchanged');
    assert.equal(http.calls.length, 1);
  });

  test('a changed state waits out the interval, then goes', async () => {
    const { pub, http, c } = make();
    await pub.publish('s1', LIVE(1));
    c.advance(DEFAULT_LIVE_STATE_MIN_INTERVAL_MS - 1);
    assert.equal((await pub.publish('s1', LIVE(2))).reason, 'rate-limited');
    c.advance(1);
    assert.equal((await pub.publish('s1', LIVE(2))).published, true);
    assert.equal(http.calls.length, 2);
  });

  test('the terminal state is published at once, bypassing the interval', async () => {
    const { pub, http } = make();
    await pub.publish('s1', LIVE(1));
    const r = await pub.publish('s1', { live: false, terminal: true, state: { status: 'success', tree: [] } });
    assert.deepEqual(r, { published: true, reason: 'terminal' });
    assert.equal(http.calls.length, 2);
  });

  test('a full persisted state is leaned into the same shape the live route serves', async () => {
    const { pub, http } = make();
    await pub.publish('s1', { live: false, terminal: true, state: { status: 'success', tree: [] } });
    assert.ok(Array.isArray(JSON.parse(http.calls[0].body)._strings));
  });

  test('a failed upload is reported through health() and retried on the next tick', async () => {
    const http = fakeHttp({ status: 403 });
    const { pub, logs } = make({ http });
    assert.equal((await pub.publish('s1', LIVE(1))).reason, 'failed');
    const h = pub.health();
    assert.equal(h.healthy, false);
    assert.equal(h.consecutiveFailures, 1);
    assert.match(h.lastFailure, /403/);
    assert.ok(logs.some((l) => l.includes('failed')));
    // Not marked as published, so the very next tick tries again (no interval to wait out).
    assert.equal((await pub.publish('s1', LIVE(1))).reason, 'failed');
    assert.equal(http.calls.length, 2);
  });

  test('never throws, and never puts the SAS in a log line or health()', async () => {
    const http = fakeHttp({ throwErr: new Error('socket hang up') });
    const { pub, logs } = make({ http });
    const r = await pub.publish('s1', LIVE(1));
    assert.equal(r.reason, 'failed');
    assert.ok(!logs.join('\n').includes('SECRET'));
    assert.ok(!JSON.stringify(pub.health()).includes('SECRET'));
  });

  test('a sprint with no state yet publishes nothing', async () => {
    const { pub, http } = make();
    assert.equal((await pub.publish('s1', { live: true, state: null })).reason, 'no-state');
    assert.equal(http.calls.length, 0);
  });

  test('construction refuses a missing coordinate or http', () => {
    assert.throws(() => createLiveStatePublisher({ containerName: 'c', sas: 's', http: fakeHttp(), now: () => 0 }), BridgeError);
    assert.throws(() => createLiveStatePublisher({ accountUrl: 'a', containerName: 'c', sas: 's', now: () => 0 }), BridgeError);
  });
});
