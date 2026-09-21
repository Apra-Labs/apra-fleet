// Tests for src/verbs/daemon.mjs. Fakes throughout: an in-memory fake spool
// (mirroring src/spool.mjs's documented API -- list/read/claim/release/patch/
// complete/fail -- but simplified, since the daemon's OWN pre-claim liveness
// check via deps.isAlive is what this suite exercises, not spool.mjs's
// internal claim() logic, which has its own dedicated spool.test.mjs), a
// fake clock/sleep (never a real timer), and bare `(handle) => Promise`
// fakes for runWatch/runFinalize -- exactly the injection seam daemon.mjs's
// file header documents.
//
// Every test relies on daemon.stop() being a full graceful drain (see
// daemon.mjs's file header, behaviour 4): `await daemon.start(); await
// daemon.stop();` is enough to deterministically observe a worker's entire
// lifecycle with no real timers and no polling.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDaemon, validateDaemonOpts, DEFAULT_SCAN_INTERVAL_MS } from '../src/verbs/daemon.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';
import { assertThrows } from './helpers.mjs';

// -- fakes --------------------------------------------------------------------

/** A clock where `sleep(ms)` advances `now()` by exactly `ms` -- no real timers. */
function makeFakeClock(startMs = 0) {
  let current = startMs;
  return {
    now: () => current,
    sleep: async (ms) => { current += ms; },
  };
}

function makeLog() {
  const lines = [];
  const log = (msg) => lines.push(msg);
  log.lines = lines;
  return log;
}

/**
 * An in-memory fake spool. Documents are plain mutable objects keyed by
 * sprintId; every method is async, matching spool.mjs's real shape.
 * `claim()` here does the one thing daemon.mjs actually depends on
 * (single-holder enforcement) without reimplementing spool.mjs's own
 * isAlive-driven takeover logic -- that is spool.test.mjs's job, and
 * daemon.mjs never calls claim() with `{ force: true }` regardless.
 */
function makeFakeSpool(initialDocs = []) {
  const docs = new Map();
  for (const doc of initialDocs) docs.set(doc.sprintId, { ...doc });

  const calls = { claim: [], release: [], patch: [], complete: [], fail: [] };

  return {
    calls,
    docs, // exposed for direct assertions in tests

    async list(filter) {
      const all = Array.from(docs.values())
        .filter((d) => d !== undefined) // corrupt entries below use `undefined`-safe access instead
        .map((d) => ({ ...d }));
      return typeof filter === 'function' ? all.filter(filter) : all;
    },

    async read(sprintId) {
      const d = docs.get(sprintId);
      return d ? { ...d } : undefined;
    },

    async claim(sprintId, claimant) {
      calls.claim.push({ sprintId, claimant });
      const d = docs.get(sprintId);
      if (!d) {
        throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, `claim() refuses: no such document "${sprintId}"`, { sprintId });
      }
      if (d.claim) return false;
      d.claim = { pid: claimant.pid, host: claimant.host };
      return true;
    },

    async release(sprintId) {
      calls.release.push(sprintId);
      const d = docs.get(sprintId);
      if (d) d.claim = null;
    },

    async patch(sprintId, mutateFn) {
      calls.patch.push(sprintId);
      const d = docs.get(sprintId) || { sprintId, state: 'unknown', claim: null };
      mutateFn(d);
      docs.set(sprintId, d);
      return { ...d };
    },

    async complete(sprintId, result) {
      calls.complete.push({ sprintId, result });
      const d = docs.get(sprintId) || { sprintId };
      d.state = 'completed';
      d.finalize = { outcome: 'completed', result };
      docs.set(sprintId, d);
    },

    async fail(sprintId, err) {
      calls.fail.push({ sprintId, err });
      const d = docs.get(sprintId) || { sprintId };
      d.state = 'failed';
      d.finalize = { outcome: 'failed', error: { message: err && err.message ? err.message : String(err) } };
      docs.set(sprintId, d);
    },
  };
}

function makeDoc(sprintId, { state = 'unknown', claim = null } = {}) {
  return {
    sprintId,
    state,
    claim,
    handle: { sprintId, startedAt: 0, request: { workItems: ['WI-1'] } },
  };
}

/** Records every call; resolves with `result` (or rejects with `result` if `shouldThrow`). */
function makeRecordingVerb(resultsBySprintId, { shouldThrow = () => false } = {}) {
  const calls = [];
  const fn = async (handle) => {
    calls.push(handle.sprintId);
    if (shouldThrow(handle.sprintId)) {
      throw new Error(`boom: ${handle.sprintId}`);
    }
    return resultsBySprintId[handle.sprintId] ?? { ok: true };
  };
  fn.calls = calls;
  return fn;
}

const BASE_OPTS = { pid: 111, host: 'runner-1' };

// -- validateDaemonOpts ---------------------------------------------------------

describe('validateDaemonOpts', () => {
  test('defaults scanIntervalMs', () => {
    const o = validateDaemonOpts({ pid: 1, host: 'h' });
    assert.equal(o.scanIntervalMs, DEFAULT_SCAN_INTERVAL_MS);
  });

  test('rejects a non-positive scanIntervalMs', () => {
    const err = assertThrows(() => validateDaemonOpts({ pid: 1, host: 'h', scanIntervalMs: 0 }));
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('requires pid', () => {
    const err = assertThrows(() => validateDaemonOpts({ host: 'h' }));
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });

  test('requires host', () => {
    const err = assertThrows(() => validateDaemonOpts({ pid: 1 }));
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });
});

describe('createDaemon construction', () => {
  test('throws CONFIG_MISSING when deps.spool is incomplete', () => {
    const err = assertThrows(() => createDaemon(BASE_OPTS, { runWatch: async () => {}, runFinalize: async () => {}, sleep: async () => {}, now: () => 0 }));
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });

  test('throws CONFIG_MISSING when deps.runWatch is missing', () => {
    const spool = makeFakeSpool();
    const err = assertThrows(() => createDaemon(BASE_OPTS, { spool, runFinalize: async () => {}, sleep: async () => {}, now: () => 0 }));
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });
});

// -- behaviour --------------------------------------------------------------------

describe('createDaemon behaviour', () => {
  test('a new handle is claimed and worked end to end', async () => {
    const spool = makeFakeSpool([makeDoc('s1')]);
    const clock = makeFakeClock();
    const runWatch = makeRecordingVerb({ s1: { phase: 'develop' } });
    const runFinalize = makeRecordingVerb({});
    // Mimic the real finalize's own step 7: it calls spool.complete() itself.
    const runFinalizeWithComplete = async (handle) => {
      const r = await runFinalize(handle);
      await spool.complete(handle.sprintId, r);
      return r;
    };

    const daemon = createDaemon(BASE_OPTS, {
      spool, runWatch, runFinalize: runFinalizeWithComplete, sleep: clock.sleep, now: clock.now, log: makeLog(),
    });

    await daemon.start();
    await daemon.stop();

    assert.deepEqual(runWatch.calls, ['s1']);
    assert.deepEqual(runFinalize.calls, ['s1']);
    assert.equal(spool.docs.get('s1').state, 'completed');
    assert.ok(spool.docs.get('s1').claim, 'claim is intentionally retained on success, like the real spool.complete()');
    assert.deepEqual(spool.docs.get('s1').progress, { phase: 'develop' });
  });

  test('a second daemon cannot claim the same sprint', async () => {
    const spool = makeFakeSpool([makeDoc('s1')]);
    const clock = makeFakeClock();
    const runWatch1 = makeRecordingVerb({});
    const runWatch2 = makeRecordingVerb({});

    const daemon1 = createDaemon({ pid: 1, host: 'a' }, {
      spool, runWatch: runWatch1, runFinalize: async () => {}, sleep: clock.sleep, now: clock.now, isAlive: () => true, log: makeLog(),
    });
    const daemon2 = createDaemon({ pid: 2, host: 'b' }, {
      spool, runWatch: runWatch2, runFinalize: async () => {}, sleep: clock.sleep, now: clock.now, isAlive: () => true, log: makeLog(),
    });

    await daemon1.start();
    await daemon2.start();

    assert.deepEqual(runWatch1.calls, ['s1']);
    assert.deepEqual(runWatch2.calls, [], 'the second daemon must never have worked the already-claimed sprint');
    assert.deepEqual(Object.keys(daemon2.tracked), []);

    await daemon1.stop();
    await daemon2.stop();

    // daemon2's own pre-claim liveness check (considerDoc) sees daemon1's
    // claim already recorded and, with isAlive() reporting it alive, never
    // even calls spool.claim() a second time -- one fewer round trip than
    // "attempt and get refused", and just as correct (see the file header's
    // behaviour 2).
    assert.equal(spool.calls.claim.length, 1, 'only the first daemon ever calls spool.claim() for this sprint');
  });

  test('one worker throwing does not stop the others', async () => {
    const spool = makeFakeSpool([makeDoc('s1'), makeDoc('s2'), makeDoc('s3')]);
    const clock = makeFakeClock();
    const runWatch = makeRecordingVerb({}, { shouldThrow: (id) => id === 's2' });
    const runFinalize = makeRecordingVerb({});

    const daemon = createDaemon(BASE_OPTS, {
      spool, runWatch, runFinalize, sleep: clock.sleep, now: clock.now, log: makeLog(),
    });

    await daemon.start();
    await daemon.stop();

    assert.deepEqual(runWatch.calls.sort(), ['s1', 's2', 's3']);
    assert.deepEqual(runFinalize.calls.sort(), ['s1', 's3'], 's2 must never reach finalize');

    // Neither s1 nor s3 had their fake runFinalize call spool.complete() (see
    // the "end to end" test above for that), so their persisted state stays
    // at the last checkpoint the daemon itself writes: 'finalizing'.
    assert.equal(spool.docs.get('s1').state, 'finalizing');
    assert.equal(spool.docs.get('s3').state, 'finalizing');
    assert.equal(spool.docs.get('s2').state, 'failed');
    assert.equal(spool.docs.get('s2').claim, null, 'the failed sprint\'s claim is released');
    assert.equal(spool.docs.get('s1').claim !== null, true, 's1 completed normally and keeps its claim');
    assert.equal(spool.docs.get('s3').claim !== null, true, 's3 completed normally and keeps its claim');
  });

  test('restart re-enters at watching (a dead claim there resumes watch then finalize)', async () => {
    const spool = makeFakeSpool([makeDoc('s1', { state: 'watching', claim: { pid: 999, host: 'ghost' } })]);
    const clock = makeFakeClock();
    const runWatch = makeRecordingVerb({});
    const runFinalize = makeRecordingVerb({});

    const daemon = createDaemon(BASE_OPTS, {
      spool, runWatch, runFinalize, sleep: clock.sleep, now: clock.now,
      isAlive: (pid) => pid !== 999, // the old claimant is dead; anyone else is alive
      log: makeLog(),
    });

    await daemon.start();
    await daemon.stop();

    assert.deepEqual(runWatch.calls, ['s1']);
    assert.deepEqual(runFinalize.calls, ['s1']);
    assert.deepEqual(spool.docs.get('s1').claim, { pid: 111, host: 'runner-1' });
  });

  test('restart re-enters at finalizing (finalize only, watch is skipped)', async () => {
    const spool = makeFakeSpool([makeDoc('s1', { state: 'finalizing', claim: { pid: 999, host: 'ghost' } })]);
    const clock = makeFakeClock();
    const runWatch = makeRecordingVerb({});
    const runFinalize = makeRecordingVerb({});

    const daemon = createDaemon(BASE_OPTS, {
      spool, runWatch, runFinalize, sleep: clock.sleep, now: clock.now,
      isAlive: (pid) => pid !== 999,
      log: makeLog(),
    });

    await daemon.start();
    await daemon.stop();

    assert.deepEqual(runWatch.calls, [], 'watch must be skipped when resuming at finalizing');
    assert.deepEqual(runFinalize.calls, ['s1']);
  });

  test('a dead claim is taken over and a live one is not', async () => {
    const spool = makeFakeSpool([
      makeDoc('dead', { state: 'watching', claim: { pid: 999, host: 'ghost' } }),
      makeDoc('live', { state: 'watching', claim: { pid: 42, host: 'other-runner' } }),
    ]);
    const clock = makeFakeClock();
    const runWatch = makeRecordingVerb({});
    const runFinalize = makeRecordingVerb({});

    const daemon = createDaemon(BASE_OPTS, {
      spool, runWatch, runFinalize, sleep: clock.sleep, now: clock.now,
      isAlive: (pid) => pid === 42, // only the "live" sprint's claimant is alive
      log: makeLog(),
    });

    await daemon.start();
    await daemon.stop();

    assert.deepEqual(runWatch.calls, ['dead']);
    assert.deepEqual(spool.docs.get('dead').claim, { pid: 111, host: 'runner-1' });
    assert.deepEqual(spool.docs.get('live').claim, { pid: 42, host: 'other-runner' }, 'a live claim must never be touched');
  });

  test('stop() persists progress and releases cleanly on a worker failure', async () => {
    const spool = makeFakeSpool([makeDoc('s1')]);
    const clock = makeFakeClock();
    const runWatch = makeRecordingVerb({ s1: { phase: 'watching', cycle: 2 } });
    const runFinalize = makeRecordingVerb({}, { shouldThrow: () => true });

    const daemon = createDaemon(BASE_OPTS, {
      spool, runWatch, runFinalize, sleep: clock.sleep, now: clock.now, log: makeLog(),
    });

    await daemon.start();
    assert.deepEqual(Object.keys(daemon.tracked), ['s1'], 'the worker is tracked while in flight');

    await daemon.stop();

    assert.deepEqual(Object.keys(daemon.tracked), [], 'nothing is tracked once stop() has drained');
    assert.equal(spool.docs.get('s1').state, 'failed');
    assert.equal(spool.docs.get('s1').claim, null, 'released cleanly after the failure');
    assert.deepEqual(spool.docs.get('s1').progress, { phase: 'watching', cycle: 2 }, 'the watch snapshot was persisted before finalize ran');
  });

  test('a corrupt handle in the spool does not stop the scan', async () => {
    const spool = makeFakeSpool([makeDoc('good')]);
    // Inject a malformed entry directly: list() will hand this back as-is,
    // and any property access on it throws -- simulating a spool
    // implementation that (unlike the real one) fails to fully insulate
    // callers from a corrupt on-disk record.
    const corrupt = new Proxy({}, {
      get() { throw new Error('corrupt handle: unreadable'); },
    });
    const realList = spool.list.bind(spool);
    spool.list = async (filter) => {
      const docs = await realList(() => true);
      docs.push(corrupt);
      return typeof filter === 'function' ? docs.filter((d) => { try { return filter(d); } catch { return true; } }) : docs;
    };

    const clock = makeFakeClock();
    const runWatch = makeRecordingVerb({});
    const runFinalize = makeRecordingVerb({});

    const daemon = createDaemon(BASE_OPTS, {
      spool, runWatch, runFinalize, sleep: clock.sleep, now: clock.now, log: makeLog(),
    });

    await daemon.start();
    await daemon.stop();

    assert.deepEqual(runWatch.calls, ['good'], 'the good entry is still worked despite the corrupt sibling');
    assert.deepEqual(runFinalize.calls, ['good']);
  });

  test('stop() signals a mid-watch worker and resolves without waiting for the sprint to terminate; finalize is skipped and the claim is retained', async () => {
    const spool = makeFakeSpool([makeDoc('s1')]);
    const clock = makeFakeClock();

    // Simulates the real runWatch's contract: checks `.aborted` up front,
    // otherwise only ever resolves once the signal actually fires -- it
    // never resolves "on its own" within this test's lifetime, which is
    // exactly what makes a plain drain-only stop() hang forever waiting for
    // it (the bug this fix addresses). Resolves with a NON-terminal
    // snapshot, matching a sprint that is genuinely still running.
    let observedSignal = null;
    const runWatch = (handle, signal) => {
      observedSignal = signal;
      const snapshot = { sprintId: handle.sprintId, phase: 'develop', health: 'running' };
      if (signal.aborted) return Promise.resolve(snapshot);
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(snapshot), { once: true });
      });
    };
    const runFinalize = makeRecordingVerb({});

    const daemon = createDaemon(BASE_OPTS, {
      spool, runWatch, runFinalize, sleep: clock.sleep, now: clock.now, log: makeLog(),
    });

    await daemon.start();

    const stopResult = await Promise.race([
      daemon.stop().then(() => 'stopped'),
      new Promise((resolve) => { setTimeout(() => resolve('timeout'), 2000); }),
    ]);

    assert.equal(stopResult, 'stopped', 'stop() must not hang waiting for the sprint to terminate');
    assert.ok(observedSignal, 'daemon must pass an AbortSignal into runWatch');
    assert.equal(observedSignal.aborted, true, 'stop() must signal the in-flight worker');

    assert.deepEqual(runFinalize.calls, [], 'an interrupted (non-terminal) watch must never reach finalize');
    assert.ok(spool.docs.get('s1').claim, 'the claim is retained -- the sprint was not actually finished, so it must resume later, not be abandoned');
    assert.equal(spool.docs.get('s1').state, 'watching', 'state stays at watching for restart recovery to resume from');
    assert.deepEqual(spool.docs.get('s1').progress, { sprintId: 's1', phase: 'develop', health: 'running' }, 'the last snapshot before the interruption was still persisted');
  });

  test('stop() releases a claim only after the worker has genuinely stopped, never before', async () => {
    // A worker resuming at finalize-only (no watch phase, no signal
    // involved -- see the file header: finalize is deliberately never
    // aborted). This proves the ordering half of the fix independently of
    // cancellation: stop() must not touch the claim while the worker's own
    // promise is still pending, no matter why it is still pending.
    const spool = makeFakeSpool([makeDoc('s1', { state: 'finalizing' })]);
    const clock = makeFakeClock();
    const runWatch = makeRecordingVerb({});

    let releaseFinalize;
    const finalizeGate = new Promise((resolve) => { releaseFinalize = resolve; });
    const runFinalize = async () => {
      await finalizeGate;
      throw new Error('boom');
    };

    const daemon = createDaemon(BASE_OPTS, {
      spool, runWatch, runFinalize, sleep: clock.sleep, now: clock.now, log: makeLog(),
    });

    await daemon.start();
    assert.ok(spool.docs.get('s1').claim, 'claim held once the worker started');

    const stopPromise = daemon.stop();

    // Give the microtask queue several turns: stop() must still be pending
    // and the claim must still be held, because the worker (stuck inside
    // finalize) has not actually stopped yet.
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
    assert.ok(spool.docs.get('s1').claim, 'claim must not be released before the worker has stopped');

    releaseFinalize();
    await stopPromise;

    assert.equal(spool.docs.get('s1').claim, null, 'claim released once the worker genuinely stopped (its failure path ran)');
    assert.equal(spool.docs.get('s1').state, 'failed');
  });

  test('start() is idempotent and stop() before start() is a safe no-op', async () => {
    const spool = makeFakeSpool([makeDoc('s1')]);
    const clock = makeFakeClock();
    const runWatch = makeRecordingVerb({});
    const runFinalize = makeRecordingVerb({});
    const daemon = createDaemon(BASE_OPTS, {
      spool, runWatch, runFinalize, sleep: clock.sleep, now: clock.now, log: makeLog(),
    });

    await daemon.stop(); // no-op, never started

    await daemon.start();
    await daemon.start(); // idempotent -- must not double-claim or re-run the worker
    await daemon.stop();

    assert.deepEqual(runWatch.calls, ['s1']);
  });
});
