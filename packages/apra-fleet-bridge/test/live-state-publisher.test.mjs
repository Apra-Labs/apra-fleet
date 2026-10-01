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

  // Per-item files: without them, 'more...' and bead descriptions on a
  // running sprint 404ed in the public viewer until finalize wrote them.
  function stateWith({ activities = [], beads = [] } = {}) {
    return {
      live: true,
      state: {
        status: 'running',
        _strings: [],
        tree: [{ title: 'g', phases: [{ title: 'p', events: activities.map((a) => ({ type: 'activity', id: a.id, data: a.data })) }] }],
        extensions: { beads: { sprintTasks: beads } },
      },
    };
  }

  function detailPublisher(overrides = {}) {
    const fetched = { activities: [], details: [] };
    const http = overrides.http || fakeHttp();
    const pub = createLiveStatePublisher({
      accountUrl: 'https://acct.invalid', containerName: 'c1', sas: 'sv=x&sig=SECRET', http, now: () => 0,
      fetchActivityOutput: async (sid, id) => { fetched.activities.push(id); return { id, output: `full ${id}` }; },
      fetchExtensionDetail: async (sid, ext, id) => { fetched.details.push(`${ext}/${id}`); return { id, text: `desc ${id}`, updatedAt: 't' }; },
      minIntervalMs: 0,
      ...overrides.deps,
    });
    return { pub, http, fetched };
  }

  test('a finished, truncated activity is uploaded once; running or untruncated ones are not', async () => {
    const { pub, http, fetched } = detailPublisher();
    const sprint = stateWith({ activities: [
      { id: 'a-done', data: { isRunning: false, outputTruncated: true } },
      { id: 'a-running', data: { isRunning: true, outputTruncated: true } },
      { id: 'a-short', data: { isRunning: false } },
    ] });
    await pub.publish('s1', sprint);
    await pub.publish('s1', sprint);
    assert.deepEqual(fetched.activities, ['a-done'], 'fetched once, and only the finished truncated one');
    const put = http.calls.find((c) => c.blobName === 'sprints/s1/activities/a-done.json');
    assert.ok(put, 'uploaded beside state.json');
    assert.deepEqual(JSON.parse(put.body), { id: 'a-done', output: 'full a-done' });
  });

  test('a bead detail is uploaded, and re-uploaded only when its updatedAt changes', async () => {
    const { pub, fetched } = detailPublisher();
    await pub.publish('s1', stateWith({ beads: [{ id: 'b1', updatedAt: '1' }] }));
    await pub.publish('s1', stateWith({ beads: [{ id: 'b1', updatedAt: '1' }] }));
    await pub.publish('s1', stateWith({ beads: [{ id: 'b1', updatedAt: '2' }] }));
    assert.deepEqual(fetched.details, ['beads/b1', 'beads/b1']);
  });

  test('uploads per tick are capped, and the rest follow on later ticks', async () => {
    const beads = Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, updatedAt: '1' }));
    const { pub, fetched } = detailPublisher({ deps: { maxDetailUploadsPerTick: 2 } });
    await pub.publish('s1', stateWith({ beads }));
    assert.equal(fetched.details.length, 2);
    await pub.publish('s1', stateWith({ beads }));
    await pub.publish('s1', stateWith({ beads }));
    assert.equal(fetched.details.length, 5);
  });

  test('detail uploads failing every tick escalate health even while state.json succeeds', async () => {
    const http = {
      calls: [],
      putBlockBlob: async (args) => { http.calls.push(args); return { status: args.blobName.endsWith('state.json') ? 201 : 403 }; },
    };
    const { pub } = detailPublisher({ http });
    for (let i = 0; i < 3; i += 1) {
      await pub.publish('s1', stateWith({ beads: [{ id: 'b1', updatedAt: String(i) }] }));
    }
    const h = pub.health();
    assert.equal(h.healthy, false);
    assert.equal(h.consecutiveFailures, 3);
    assert.match(h.lastFailure, /403/);
  });

  test('without the fetchers only state.json is published', async () => {
    const { pub, http } = make();
    await pub.publish('s1', stateWith({ activities: [{ id: 'a', data: { isRunning: false, outputTruncated: true } }], beads: [{ id: 'b', updatedAt: '1' }] }));
    assert.deepEqual(http.calls.map((c) => c.blobName), ['sprints/s1/state.json']);
  });

  test('construction refuses a missing coordinate or http', () => {
    assert.throws(() => createLiveStatePublisher({ containerName: 'c', sas: 's', http: fakeHttp(), now: () => 0 }), BridgeError);
    assert.throws(() => createLiveStatePublisher({ accountUrl: 'a', containerName: 'c', sas: 's', now: () => 0 }), BridgeError);
  });
});
