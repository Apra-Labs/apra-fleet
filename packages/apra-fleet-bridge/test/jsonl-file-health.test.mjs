// Tests for the LOCAL mirror's failure path: src/sinks/jsonl-file.mjs's
// stream-error handling, its health() surface, and stop()'s bounded flush
// wait -- plus bin/runtime.mjs's openAppendStream, which is where the
// 'error' listener actually gets attached to a real fs stream.
//
// THE FAILURE BEING GUARDED AGAINST: a WriteStream reports ENOSPC/EACCES/
// EBADF as an 'error' EVENT on a later tick. It is never thrown from
// write(), so neither the sink's own try/catch nor the fan's per-sink
// isolation (src/sinks/index.mjs) can see one -- and an 'error' event with
// no listener is re-thrown by Node as an uncaught exception, with no
// process-level handler anywhere in this package. A full disk would
// therefore kill a two-day sprint over its LOG file, which is exactly what
// src/sinks/health.mjs's own contract says must never happen.
//
// Second, subtler failure: even once the error is caught, a local mirror
// with no health() surface reports nothing, so a daemon could be writing
// NOTHING anywhere while every log line said it was fine.
//
// A separate test file from sinks.test.mjs on purpose: this one needs a
// hand-rolled EventEmitter-shaped stream (to fire 'error' at an exact
// moment, and to build a stream that NEVER finishes), which the fakes
// there deliberately do not provide.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createJsonlFileSink } from '../src/sinks/jsonl-file.mjs';
import { createSinkFan } from '../src/sinks/index.mjs';
import { createSinkHealthMonitor, DEFAULT_UNHEALTHY_AFTER } from '../src/sinks/health.mjs';
import { openAppendStream } from '../bin/runtime.mjs';

// -- fakes --------------------------------------------------------------------

function makeClock(startMs = 1_758_000_000_000) {
  let t = startMs;
  return { now: () => new Date(t++).toISOString() };
}

/** The plain, non-EventEmitter fake sinks.test.mjs uses -- an opener that can only report errors via its callback. */
function makePlainStream() {
  const chunks = [];
  let ended = false;
  return {
    chunks,
    get ended() { return ended; },
    write(chunk) { chunks.push(chunk); return true; },
    end() { ended = true; },
  };
}

/**
 * A minimal EventEmitter-shaped stream fake.
 * `endBehaviour`: 'finish-sync' (default), 'finish-async' (flushes 20ms
 * later, like a real stream with buffered data), or 'never' (wedged: no
 * 'finish', no callback, ever).
 */
function makeEmitterStream({ endBehaviour = 'finish-sync' } = {}) {
  const chunks = [];
  const listeners = new Map();
  let ended = false;
  const fire = (event, arg) => { for (const fn of [...(listeners.get(event) || [])]) fn(arg); };
  return {
    chunks,
    get ended() { return ended; },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return this;
    },
    write(chunk) { chunks.push(chunk); return true; },
    end(cb) {
      ended = true;
      if (endBehaviour === 'never') return;
      if (endBehaviour === 'finish-async') {
        setTimeout(() => { chunks.push('[flushed]\n'); if (cb) cb(); fire('finish'); }, 20);
        return;
      }
      if (cb) cb();
      fire('finish');
    },
    failWith(err) { fire('error', err); },
  };
}

function makeSink(overrides = {}) {
  return createJsonlFileSink({
    path: '/fake/progress.jsonl',
    redact: (r) => r,
    clock: makeClock(),
    ...overrides,
  });
}

// -- the error event ------------------------------------------------------------

describe('createJsonlFileSink stream failure', () => {
  test('an error event degrades the sink instead of killing anything, and health() reports it', () => {
    const stream = makeEmitterStream();
    const sink = makeSink({ openAppendStream: () => stream });

    sink.emit({ n: 1 });
    assert.equal(sink.health().healthy, true);

    // The whole point: this must not propagate to anyone.
    assert.doesNotThrow(() => stream.failWith(new Error('ENOSPC: no space left on device, write')));

    const h = sink.health();
    assert.equal(h.name, 'jsonl-file');
    assert.equal(h.healthy, false);
    assert.equal(h.terminal, true, 'a dead file descriptor cannot self-heal');
    assert.equal(h.consecutiveFailures, 1);
    assert.equal(h.successfulFlushes, 1);
    assert.equal(h.pendingRecords, 0);
    assert.match(h.lastFailure, /ENOSPC/);
    assert.equal(h.target, '/fake/progress.jsonl');
    assert.ok(h.lastFailureAt, 'the failure must be stamped');
  });

  test('records emitted after the failure are dropped and COUNTED, never thrown', () => {
    const stream = makeEmitterStream();
    const sink = makeSink({ openAppendStream: () => stream });
    sink.emit({ n: 1 });
    stream.failWith(new Error('EACCES: permission denied'));

    assert.doesNotThrow(() => { sink.emit({ n: 2 }); sink.emit({ n: 3 }); });
    assert.equal(stream.chunks.length, 1, 'nothing is written to a dead stream');
    assert.equal(sink.health().droppedRecords, 2);
  });

  test('a stream that can only report errors through the opener callback is still handled', () => {
    // No on() at all -- the contract bin/runtime.mjs's
    // openAppendStream(path, onError) provides. This is the wiring seam, so
    // it gets its own test.
    let onError = null;
    const sink = makeSink({ openAppendStream: (_p, cb) => { onError = cb; return makePlainStream(); } });
    sink.start();
    assert.equal(typeof onError, 'function', 'the sink must hand its error handler to the opener');
    onError(new Error('EBADF: bad file descriptor'));
    assert.equal(sink.health().healthy, false);
    assert.match(sink.health().lastFailure, /EBADF/);
  });

  test('the same error arriving by both routes is counted once', () => {
    let onError = null;
    const stream = makeEmitterStream();
    const sink = makeSink({ openAppendStream: (_p, cb) => { onError = cb; return stream; } });
    sink.start();
    const err = new Error('ENOSPC');
    onError(err);
    stream.failWith(err);
    assert.equal(sink.health().consecutiveFailures, 1);
  });

  test('a synchronous write() throw is the same terminal failure, not an exception', () => {
    const sink = makeSink({ openAppendStream: () => ({ write() { throw new Error('write after end'); }, end() {} }) });
    assert.doesNotThrow(() => sink.emit({ n: 1 }));
    assert.equal(sink.health().healthy, false);
    assert.equal(sink.health().droppedRecords, 1);
  });

  test('the health surface goes through the same redactor the records do', () => {
    const sasPath = 'https://acct.blob.core.windows.net/logs/s.jsonl?sv=2022-11-02&sig=TOPSECRETSIGVALUE';
    const stream = makeEmitterStream();
    // No `redact` override: the real log-safe redactor, as production wires it.
    const sink = createJsonlFileSink({ path: sasPath, openAppendStream: () => stream, clock: makeClock() });
    sink.start();
    stream.failWith(new Error(`EACCES writing ${sasPath}`));
    const h = sink.health();
    assert.ok(!h.lastFailure.includes('TOPSECRETSIGVALUE'), 'a secret must never reach the health surface');
    assert.ok(!h.target.includes('TOPSECRETSIGVALUE'), 'nor the reported target');
  });

  test('health() before any failure reports a clean sink and is a pure getter', () => {
    const sink = makeSink({ openAppendStream: () => makeEmitterStream() });
    const before = sink.health();
    const after = sink.health();
    assert.deepEqual(before, after, 'calling health() must change nothing');
    assert.equal(before.healthy, true);
    assert.equal(before.terminal, false);
    assert.equal(before.consecutiveFailures, 0);
    assert.equal(before.droppedRecords, 0);
  });

  test('a degraded jsonl sink does not break the fan, which keeps feeding every other sink', async () => {
    const stream = makeEmitterStream();
    const jsonlSink = makeSink({ openAppendStream: () => stream });
    const received = [];
    const other = { async emit(r) { received.push(r); } };
    const fan = createSinkFan({ sinks: [{ name: 'jsonl-file', sink: jsonlSink }, { name: 'other', sink: other }], log: () => {} });
    await fan.emit({ n: 1 });
    stream.failWith(new Error('ENOSPC'));
    await assert.doesNotReject(() => fan.emit({ n: 2 }));
    assert.equal(received.length, 2);
    assert.equal(jsonlSink.health().healthy, false);
  });
});

// -- stop() ---------------------------------------------------------------------

describe('createJsonlFileSink stop() flush', () => {
  test('stop() waits for the stream to finish flushing rather than returning immediately', async () => {
    const stream = makeEmitterStream({ endBehaviour: 'finish-async' });
    const sink = makeSink({ openAppendStream: () => stream });
    sink.emit({ n: 1 });

    const pending = sink.stop();
    assert.equal(typeof pending.then, 'function', 'stop() must be awaitable');
    assert.equal(stream.chunks.length, 1, 'the flush has not happened yet');
    await pending;
    assert.equal(stream.chunks.length, 2, 'stop() must not resolve before the stream has flushed');
    assert.equal(sink.health().healthy, true);
  });

  test('a stream that never finishes cannot hang shutdown -- the wait is bounded', async () => {
    const stream = makeEmitterStream({ endBehaviour: 'never' });
    const sink = makeSink({ openAppendStream: () => stream, stopTimeoutMs: 25 });
    sink.emit({ n: 1 });
    const startedAt = Date.now();
    await sink.stop();
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 1000, `stop() must return on its own bound, took ${elapsed}ms`);
    const h = sink.health();
    assert.equal(h.healthy, false, 'a stop that timed out must not claim the tail was written');
    assert.match(h.lastFailure, /did not finish within 25ms/);
  });

  test('the bound is scheduled on the injected clock when it provides timers', async () => {
    let scheduledMs = null;
    const stream = makeEmitterStream({ endBehaviour: 'never' });
    const clock = {
      now: makeClock().now,
      setTimeout: (fn, ms) => { scheduledMs = ms; return setTimeout(fn, 0); },
      clearTimeout: (id) => clearTimeout(id),
    };
    const sink = createJsonlFileSink({ path: '/fake/p.jsonl', openAppendStream: () => stream, redact: (r) => r, clock, stopTimeoutMs: 9999 });
    sink.emit({ n: 1 });
    await sink.stop();
    assert.equal(scheduledMs, 9999, 'the bound must be scheduled on the injected clock, not a real timer');
  });

  test('stop() still ends the stream synchronously, so a caller that does not await it still closes the file', () => {
    const stream = makeEmitterStream();
    const sink = makeSink({ openAppendStream: () => stream });
    sink.emit({ n: 1 });
    void sink.stop();
    assert.equal(stream.ended, true);
  });

  test('stop() never rejects, even when end() throws', async () => {
    const sink = makeSink({ openAppendStream: () => ({ write() {}, end() { throw new Error('end blew up'); } }) });
    sink.emit({ n: 1 });
    await assert.doesNotReject(() => sink.stop());
    assert.equal(sink.health().healthy, false);
  });

  test('a plain synchronous fake stream does not make stop() wait out the whole bound', async () => {
    const stream = makePlainStream();
    const sink = makeSink({ openAppendStream: () => stream, stopTimeoutMs: 60_000 });
    sink.emit({ n: 1 });
    const startedAt = Date.now();
    await sink.stop();
    assert.ok(Date.now() - startedAt < 1000, 'nothing to wait on means resolve now, not at the bound');
    assert.equal(stream.ended, true);
  });
});

// -- the health monitor's view of a dead local mirror ----------------------------

describe('createSinkHealthMonitor escalates a failed local sink', () => {
  function makeHarness() {
    const logs = [];
    const alerts = [];
    let t = 0;
    const monitor = createSinkHealthMonitor({
      log: (m) => logs.push(String(m)),
      now: () => t,
      alert: async (m) => { alerts.push(String(m)); },
    });
    return { monitor, logs, alerts, advance(ms) { t += ms; } };
  }

  test('a terminal local failure escalates on the FIRST check, not after unhealthyAfter', async () => {
    const stream = makeEmitterStream();
    const sink = makeSink({ openAppendStream: () => stream });
    sink.emit({ n: 1 });
    stream.failWith(new Error('ENOSPC: no space left on device'));
    sink.emit({ n: 2 });

    const { monitor, logs, alerts } = makeHarness();
    await monitor.check([{ name: 'jsonl-file', sink }, { name: 'append-blob', sink: { emit() {} } }]);

    assert.ok(sink.health().consecutiveFailures < DEFAULT_UNHEALTHY_AFTER,
      'the premise: one stream error is below the transient-failure threshold');
    assert.match(logs.join('\n'), /PROGRESS SINK DEGRADED: jsonl-file/);
    assert.match(logs.join('\n'), /FAILED PERMANENTLY/);
    assert.match(logs.join('\n'), /Records DROPPED and unrecoverable since the failure: 1/);
    assert.match(logs.join('\n'), /ENOSPC/);
    assert.equal(alerts.length, 1, 'the operator channel must fire too');
    assert.match(alerts[0], /jsonl-file/);
    assert.deepEqual(monitor.degradedNames(), ['jsonl-file']);
  });

  test('finalReport names a local mirror that ended dead', async () => {
    const stream = makeEmitterStream();
    const sink = makeSink({ openAppendStream: () => stream });
    sink.emit({ n: 1 });
    stream.failWith(new Error('EACCES: permission denied'));

    const { monitor, logs } = makeHarness();
    monitor.finalReport([{ name: 'jsonl-file', sink }]);
    assert.match(logs.join('\n'), /PROGRESS SINK ENDED DEGRADED: jsonl-file/);
    assert.match(logs.join('\n'), /INCOMPLETE/);
  });

  test('a healthy local mirror is never escalated', async () => {
    const sink = makeSink({ openAppendStream: () => makeEmitterStream() });
    sink.emit({ n: 1 });
    const { monitor, logs, alerts } = makeHarness();
    await monitor.check([{ name: 'jsonl-file', sink }]);
    assert.equal(logs.length, 0);
    assert.equal(alerts.length, 0);
  });

  test('a NON-terminal sink still waits for unhealthyAfter -- the transient-failure rule is untouched', async () => {
    const entry = {
      name: 'append-blob',
      sink: { emit() {}, health: () => ({ name: 'append-blob', healthy: false, consecutiveFailures: 1, pendingRecords: 3, lastFailure: 'status 503' }) },
    };
    const { monitor, logs } = makeHarness();
    await monitor.check([entry]);
    assert.equal(logs.length, 0, 'one transient 503 must not raise a banner');
  });
});

// -- bin/runtime.mjs: the real fs seam ------------------------------------------

describe('openAppendStream error handling (bin/runtime.mjs)', () => {
  const tmpDirs = [];
  after(() => { for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true }); });
  function makeTmpDir() {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-bridge-jsonl-health-'));
    tmpDirs.push(dir);
    return dir;
  }

  test('a real stream error reaches onError and does NOT become an uncaught exception', async () => {
    // A path whose parent directory does not exist: fs emits ENOENT on the
    // 'error' event, asynchronously. Without a listener Node re-throws it
    // and the process dies -- which is the bug this guards.
    const badPath = join(makeTmpDir(), 'no-such-dir', 'out.jsonl');
    const seen = await new Promise((resolve) => {
      openAppendStream(badPath, resolve);
      setTimeout(() => resolve(null), 2000);
    });
    assert.ok(seen, 'onError must be called with the stream error');
    assert.match(String(seen.code || seen.message), /ENOENT/);
  });

  test('a stream error with no onError given is still handled (the listener is unconditional)', async () => {
    const badPath = join(makeTmpDir(), 'also-missing', 'out.jsonl');
    openAppendStream(badPath);
    // If the listener were conditional on onError, this tick is where the
    // uncaught exception would take the process down.
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    assert.ok(true, 'the process is still alive');
  });

  test('the real stream, driven through the sink, degrades it rather than crashing', async () => {
    const badPath = join(makeTmpDir(), 'missing-parent', 'out.jsonl');
    const sink = createJsonlFileSink({ path: badPath, openAppendStream, clock: makeClock() });
    sink.emit({ n: 1 });
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    const h = sink.health();
    assert.equal(h.healthy, false);
    assert.match(h.lastFailure, /ENOENT/);
    await sink.stop();
  });
});
