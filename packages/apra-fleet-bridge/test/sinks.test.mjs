// Tests for src/sinks/index.mjs (the fan-out) and src/sinks/jsonl-file.mjs.
// Fakes throughout: an in-memory "stream", an injected clock, no real fs.
// Covers: a sink that throws does not stop the fan or the other sinks, and
// the failure is logged once (not per record); jsonl records are one JSON
// object per line and are redacted before they reach the stream.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createSinkFan } from '../src/sinks/index.mjs';
import { createJsonlFileSink } from '../src/sinks/jsonl-file.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';

// -- fakes --------------------------------------------------------------------

function makeLog() {
  const lines = [];
  const log = (msg) => lines.push(msg);
  log.lines = lines;
  return log;
}

/** A sink that records every record it was given, verbatim. */
function makeRecordingSink(name = 'recording') {
  const received = [];
  return {
    name,
    received,
    started: 0,
    stopped: 0,
    flushed: 0,
    start() { this.started += 1; },
    async emit(record) { received.push(record); },
    async flushNow() { this.flushed += 1; },
    async stop() { this.stopped += 1; },
  };
}

/** A sink whose emit() always throws synchronously. */
function makeThrowingSink(message = 'boom') {
  return {
    calls: 0,
    emit() {
      this.calls += 1;
      throw new Error(message);
    },
  };
}

/** A sink whose emit() always rejects. */
function makeRejectingSink(message = 'async boom') {
  return {
    calls: 0,
    async emit() {
      this.calls += 1;
      throw new Error(message);
    },
  };
}

/** An in-memory append "stream" -- write()/end(), like fs.createWriteStream. */
function makeFakeStream() {
  const chunks = [];
  let ended = false;
  return {
    chunks,
    get ended() { return ended; },
    write(chunk) { chunks.push(chunk); return true; },
    end() { ended = true; },
  };
}

function makeClock(startMs = 1_758_000_000_000) {
  let t = startMs;
  return { now: () => new Date(t++).toISOString() };
}

// -- createSinkFan: construction ------------------------------------------------

describe('createSinkFan construction', () => {
  test('throws CONFIG_MISSING when sinks is missing or empty', () => {
    assert.throws(() => createSinkFan({}), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
    assert.throws(() => createSinkFan({ sinks: [] }), (err) => err instanceof BridgeError);
  });

  test('throws CONFIG_INVALID for an entry missing a name or an emit()', () => {
    assert.throws(() => createSinkFan({ sinks: [{ sink: { emit() {} } }] }), (err) => {
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      return true;
    });
    assert.throws(() => createSinkFan({ sinks: [{ name: 'x', sink: {} }] }), (err) => err.code === BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('throws CONFIG_INVALID for duplicate sink names', () => {
    const a = makeRecordingSink('dup');
    const b = makeRecordingSink('dup');
    assert.throws(() => createSinkFan({ sinks: [{ name: 'dup', sink: a }, { name: 'dup', sink: b }] }), (err) => err.code === BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('calls start() on every sink that defines one', () => {
    const a = makeRecordingSink('a');
    const b = { emit: async () => {} }; // no start() at all -- must not throw
    createSinkFan({ sinks: [{ name: 'a', sink: a }, { name: 'b', sink: b }] });
    assert.equal(a.started, 1);
  });

  test('a throwing start() is isolated and logged, and does not prevent construction', () => {
    const log = makeLog();
    const bad = { start() { throw new Error('start failed'); }, async emit() {} };
    const good = makeRecordingSink('good');
    const fan = createSinkFan({ sinks: [{ name: 'bad', sink: bad }, { name: 'good', sink: good }], log });
    assert.equal(log.lines.length, 1);
    assert.match(log.lines[0], /bad/);
    assert.ok(fan); // construction still succeeded
  });
});

// -- createSinkFan: emit isolation ----------------------------------------------

describe('createSinkFan emit isolation', () => {
  test('a sink that throws synchronously does not stop the fan or the other sinks', async () => {
    const log = makeLog();
    const throwing = makeThrowingSink();
    const good = makeRecordingSink('good');
    const fan = createSinkFan({ sinks: [{ name: 'throwing', sink: throwing }, { name: 'good', sink: good }], log });

    await assert.doesNotReject(() => fan.emit({ n: 1 }));
    assert.deepEqual(good.received, [{ n: 1 }], 'the healthy sink still received the record');
    assert.equal(throwing.calls, 1);
  });

  test('a sink whose emit() rejects (async) is isolated the same way', async () => {
    const rejecting = makeRejectingSink();
    const good = makeRecordingSink('good');
    const fan = createSinkFan({ sinks: [{ name: 'rejecting', sink: rejecting }, { name: 'good', sink: good }] });

    await fan.emit({ n: 1 });
    assert.deepEqual(good.received, [{ n: 1 }]);
  });

  test('a persistently-failing sink is logged ONCE, not once per record', async () => {
    const log = makeLog();
    const throwing = makeThrowingSink();
    const fan = createSinkFan({ sinks: [{ name: 'throwing', sink: throwing }], log });

    await fan.emit({ n: 1 });
    await fan.emit({ n: 2 });
    await fan.emit({ n: 3 });

    assert.equal(throwing.calls, 3, 'the sink is still tried on every emit');
    const emitFailureLogs = log.lines.filter((l) => /failed on emit/.test(l));
    assert.equal(emitFailureLogs.length, 1, 'exactly one log line for this sink\'s emit failures');
  });

  test('stats() counts success and failure per sink independently', async () => {
    const throwing = makeThrowingSink();
    const good = makeRecordingSink('good');
    const fan = createSinkFan({ sinks: [{ name: 'throwing', sink: throwing }, { name: 'good', sink: good }] });

    await fan.emit({ n: 1 });
    await fan.emit({ n: 2 });

    const stats = fan.stats();
    assert.deepEqual(stats.throwing, { success: 0, failure: 2 });
    assert.deepEqual(stats.good, { success: 2, failure: 0 });
  });

  test('every sink receives every record, in order', async () => {
    const a = makeRecordingSink('a');
    const b = makeRecordingSink('b');
    const fan = createSinkFan({ sinks: [{ name: 'a', sink: a }, { name: 'b', sink: b }] });

    await fan.emit({ n: 1 });
    await fan.emit({ n: 2 });

    assert.deepEqual(a.received, [{ n: 1 }, { n: 2 }]);
    assert.deepEqual(b.received, [{ n: 1 }, { n: 2 }]);
  });
});

// -- createSinkFan: flushNow / stop ----------------------------------------------

describe('createSinkFan flushNow/stop', () => {
  test('flushNow() calls every sink defining one, isolating a throw', async () => {
    const log = makeLog();
    const good = makeRecordingSink('good');
    const bad = { async emit() {}, async flushNow() { throw new Error('flush failed'); } };
    const fan = createSinkFan({ sinks: [{ name: 'good', sink: good }, { name: 'bad', sink: bad }], log });

    await assert.doesNotReject(() => fan.flushNow());
    assert.equal(good.flushed, 1);
    assert.ok(log.lines.some((l) => /failed to flush/.test(l)));
  });

  test('stop() calls every sink defining one, isolating a throw', async () => {
    const log = makeLog();
    const good = makeRecordingSink('good');
    const bad = { async emit() {}, async stop() { throw new Error('stop failed'); } };
    const fan = createSinkFan({ sinks: [{ name: 'good', sink: good }, { name: 'bad', sink: bad }], log });

    await assert.doesNotReject(() => fan.stop());
    assert.equal(good.stopped, 1);
    assert.ok(log.lines.some((l) => /failed to stop/.test(l)));
  });

  test('a sink without flushNow/stop is simply skipped, not an error', async () => {
    const minimal = { async emit() {} };
    const fan = createSinkFan({ sinks: [{ name: 'minimal', sink: minimal }] });
    await assert.doesNotReject(() => fan.flushNow());
    await assert.doesNotReject(() => fan.stop());
  });
});

// -- createJsonlFileSink: construction --------------------------------------------

describe('createJsonlFileSink construction', () => {
  test('throws CONFIG_MISSING for each missing required dependency (path, openAppendStream, clock)', () => {
    const openAppendStream = () => makeFakeStream();
    const redact = (r) => r;
    const clock = makeClock();

    assert.throws(() => createJsonlFileSink({ openAppendStream, redact, clock }), (err) => err.code === BRIDGE_ERROR_CODES.CONFIG_MISSING);
    assert.throws(() => createJsonlFileSink({ path: 'p', redact, clock }), (err) => err.code === BRIDGE_ERROR_CODES.CONFIG_MISSING);
    assert.throws(() => createJsonlFileSink({ path: 'p', openAppendStream, redact }), (err) => err.code === BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });

  test('throws CONFIG_MISSING when redact is provided but not a function', () => {
    const openAppendStream = () => makeFakeStream();
    const clock = makeClock();
    assert.throws(
      () => createJsonlFileSink({ path: 'p', openAppendStream, clock, redact: 'nope' }),
      (err) => err.code === BRIDGE_ERROR_CODES.CONFIG_MISSING,
    );
  });

  test('defaults to a safe redactor (log-safe.mjs) when redact is omitted entirely', () => {
    const stream = makeFakeStream();
    const sink = createJsonlFileSink({
      path: 'p',
      openAppendStream: () => stream,
      clock: makeClock(),
    });
    sink.emit({ token: 'super-secret-value' });
    const written = stream.chunks.join('');
    assert.ok(!written.includes('super-secret-value'), 'the default redactor must mask a secret-named key');
    assert.ok(written.includes('[REDACTED]'));
  });
});

// -- createJsonlFileSink: emit ----------------------------------------------------

describe('createJsonlFileSink emit', () => {
  function makeSink({ redact = (r) => r } = {}) {
    const stream = makeFakeStream();
    const sink = createJsonlFileSink({
      path: '/fake/progress.jsonl',
      openAppendStream: () => stream,
      redact,
      clock: makeClock(),
    });
    return { sink, stream };
  }

  test('writes one JSON object per line', () => {
    const { sink, stream } = makeSink();
    sink.emit({ phase: 'Plan C1 R1', cycle: 1 });
    sink.emit({ phase: 'Develop C1 R1', cycle: 1 });

    assert.equal(stream.chunks.length, 2);
    for (const chunk of stream.chunks) {
      assert.ok(chunk.endsWith('\n'));
      assert.equal(chunk.split('\n').filter(Boolean).length, 1, 'exactly one JSON object per write');
      assert.doesNotThrow(() => JSON.parse(chunk));
    }
    const first = JSON.parse(stream.chunks[0]);
    assert.equal(first.phase, 'Plan C1 R1');
    assert.equal(first.cycle, 1);
    assert.equal(typeof first.receivedAt, 'string');
  });

  test('every record passes through redact() before it is written -- a planted secret never reaches the stream', () => {
    const redact = (record) => {
      const copy = { ...record };
      delete copy.secretToken;
      copy.secretToken = '[REDACTED]';
      return copy;
    };
    const { sink, stream } = makeSink({ redact });

    sink.emit({ phase: 'Plan C1 R1', secretToken: 'sk-super-secret-value-12345' });

    const written = stream.chunks.join('');
    assert.ok(!written.includes('sk-super-secret-value-12345'), 'the planted secret must never reach the stream');
    assert.ok(written.includes('[REDACTED]'));
  });

  test('auto-starts the stream on first emit if start() was never called', () => {
    let opened = 0;
    const sink = createJsonlFileSink({
      path: '/fake/progress.jsonl',
      openAppendStream: () => { opened += 1; return makeFakeStream(); },
      redact: (r) => r,
      clock: makeClock(),
    });
    assert.equal(opened, 0);
    sink.emit({ n: 1 });
    assert.equal(opened, 1);
    sink.emit({ n: 2 });
    assert.equal(opened, 1, 'the stream is opened only once');
  });

  test('start() is idempotent', () => {
    let opened = 0;
    const sink = createJsonlFileSink({
      path: '/fake/progress.jsonl',
      openAppendStream: () => { opened += 1; return makeFakeStream(); },
      redact: (r) => r,
      clock: makeClock(),
    });
    sink.start();
    sink.start();
    assert.equal(opened, 1);
  });

  test('stop() ends the stream and further emits are dropped, not thrown', () => {
    const { sink, stream } = makeSink();
    sink.emit({ n: 1 });
    sink.stop();
    assert.equal(stream.ended, true);

    assert.doesNotThrow(() => sink.emit({ n: 2 }));
    assert.equal(stream.chunks.length, 1, 'the record emitted after stop() is dropped, not written');
  });

  test('stop() is idempotent', () => {
    const { sink, stream } = makeSink();
    sink.start();
    sink.stop();
    assert.doesNotThrow(() => sink.stop());
    assert.equal(stream.ended, true);
  });

  test('a non-object redacted result is still written as one well-formed JSON line', () => {
    const { sink, stream } = makeSink({ redact: () => 'not-an-object' });
    sink.emit({ n: 1 });
    const parsed = JSON.parse(stream.chunks[0]);
    assert.equal(parsed.data, 'not-an-object');
    assert.equal(typeof parsed.receivedAt, 'string');
  });
});

// -- end-to-end: fan + jsonl-file sink together -----------------------------------

describe('createSinkFan wired to a real createJsonlFileSink', () => {
  test('records emitted through the fan land in the jsonl sink, redacted, one per line', async () => {
    const stream = makeFakeStream();
    const redact = (r) => ({ ...r, token: undefined });
    const jsonlSink = createJsonlFileSink({
      path: '/fake/progress.jsonl',
      openAppendStream: () => stream,
      redact,
      clock: makeClock(),
    });
    const throwingSink = makeThrowingSink();
    const log = makeLog();

    const fan = createSinkFan({
      sinks: [
        { name: 'jsonl-file', sink: jsonlSink },
        { name: 'throwing', sink: throwingSink },
      ],
      log,
    });

    await fan.emit({ phase: 'Plan C1 R1', token: 'super-secret-token-value' });
    await fan.emit({ phase: 'Develop C1 R1', token: 'super-secret-token-value' });

    assert.equal(stream.chunks.length, 2);
    const written = stream.chunks.join('');
    assert.ok(!written.includes('super-secret-token-value'));

    const stats = fan.stats();
    assert.equal(stats['jsonl-file'].success, 2);
    assert.equal(stats.throwing.failure, 2);
    assert.equal(log.lines.filter((l) => /throwing/.test(l)).length, 1, 'logged once despite two failures');

    await fan.stop();
    assert.equal(stream.ended, true);
  });
});
