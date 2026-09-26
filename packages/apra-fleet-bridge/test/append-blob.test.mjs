// Tests for src/sinks/append-blob-http.mjs and src/sinks/append-blob.mjs.
// Fake http, fake clock -- no real timers or network anywhere in this file.
//
// Part 1 exercises append-blob-http.mjs directly against a fake `fetch`
// (URL/header construction, response parsing).
// Part 2 exercises append-blob.mjs's batching/retry/roll policy against a
// hand-rolled fake `http` (appendBlock/getProperties/createAppendBlob/
// putBlockBlob), matching the task's "fake http, fake clock" instruction --
// the REST layer's own correctness is Part 1's job, not Part 2's.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createAppendBlobHttp } from '../src/sinks/append-blob-http.mjs';
import {
  createAppendBlobSink,
  blobNameForPart,
  manifestBlobNameFor,
  MAX_RETRY_ATTEMPTS,
} from '../src/sinks/append-blob.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';

const ACCOUNT_URL = 'https://fakeacct.blob.core.windows.net';
const CONTAINER = 'fleet-bridge';
const SAS = 'sv=2025-01-01&ss=b&srt=co&sp=rwl&sig=totally-secret-signature';
const SPRINT_ID = 'sprint-42';

// -- Part 1 fakes: a fake fetch -----------------------------------------------

/** A Response-like object matching what append-blob-http.mjs reads: status, headers.get(), text(). */
function fakeResponse(status, headers = {}, body = '') {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    headers: { get: (name) => (lower.has(name.toLowerCase()) ? lower.get(name.toLowerCase()) : null) },
    text: async () => body,
  };
}

function makeFakeFetch(handler) {
  const calls = [];
  async function fetchImpl(url, init) {
    calls.push({ url, init });
    return handler(url, init);
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

// -- Part 2 fakes: a fake http + a fake clock ---------------------------------

/**
 * A controllable fake clock: `now()` reads the current virtual time;
 * `setTimeout`/`clearTimeout` schedule/cancel callbacks against it, never a
 * real timer. `drain()` repeatedly fires the earliest pending timer
 * (jumping the clock forward to it) until none remain -- used to let a
 * backoff delay or a periodic tick proceed deterministically. Bounded so a
 * genuine bug (an ever-rearming timer) fails the test instead of hanging
 * the process.
 */
function makeFakeClock(startMs = 0) {
  let current = startMs;
  let nextId = 1;
  const timers = new Map();

  return {
    now: () => current,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fireAt: current + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    pendingCount() {
      return timers.size;
    },
    /** Fire every timer due at or before `current` (no time advance). Returns how many fired. */
    async fireDueNow() {
      let fired = 0;
      const due = [...timers.entries()].filter(([, t]) => t.fireAt <= current).sort((a, b) => a[1].fireAt - b[1].fireAt);
      for (const [id, t] of due) {
        if (!timers.has(id)) continue; // may have been cleared by a prior callback in this batch
        timers.delete(id);
        await t.fn();
        fired += 1;
      }
      return fired;
    },
    /**
     * Advance the clock by `ms` and fire exactly the timers that are due as
     * of that new time -- a SINGLE pass, snapshotted up front, so a callback
     * that reschedules itself (the periodic flush loop always does) does not
     * cause this to recurse. Use this for a self-rescheduling timer; use
     * `drain()` (below) only for a bounded chain that is expected to end.
     */
    async advance(ms) {
      current += ms;
      await this.fireDueNow();
    },
    /**
     * Jump straight to the EARLIEST pending timer's fire time and fire
     * whatever is due there, doing nothing if nothing is pending.
     * `fireDueNow()` alone never advances the clock, so a `delay(ms)`
     * (ms > 0) built on `setTimeout` would never become due -- this is
     * what actually lets a backoff wait elapse in a test.
     * @returns {Promise<boolean>} whether a timer was pending to advance to.
     */
    async advanceToNext() {
      if (timers.size === 0) return false;
      let earliest = Infinity;
      for (const t of timers.values()) earliest = Math.min(earliest, t.fireAt);
      current = Math.max(current, earliest);
      await this.fireDueNow();
      return true;
    },
    /** Drain all pending timers to completion, advancing the clock to each one's fire time in turn. Bounded to avoid a hang on a real bug. */
    async drain(maxIterations = 50) {
      for (let i = 0; i < maxIterations; i += 1) {
        if (timers.size === 0) return;
        const [id, t] = [...timers.entries()].sort((a, b) => a[1].fireAt - b[1].fireAt)[0];
        current = Math.max(current, t.fireAt);
        timers.delete(id);
        await t.fn();
      }
      if (timers.size === 0) return;
      throw new Error(`fake clock drain() exceeded ${maxIterations} iterations -- likely an ever-rearming timer`);
    },
  };
}

/** Yield to the macrotask queue so every already-scheduled microtask (promise chain) gets a chance to run first. */
function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Wait for `promise` to settle, but a promise built on `sink.flushNow()`
 * under a bounded-retry/backoff path only progresses when the fake clock's
 * pending timer is fired -- and that timer is not necessarily registered
 * yet at the instant `flushNow()` returns (it is registered from inside a
 * chain of internal awaits). Racing a single `drain()` call against that
 * registration is exactly the kind of ordering bug this helper avoids: it
 * alternates "let pending microtasks run" (via a macrotask boundary) with
 * "fire whatever timer is now due", repeating until `promise` settles or a
 * bounded number of ticks elapses (a real hang then fails loudly instead of
 * timing out the whole suite).
 * @param {Promise<any>} promise
 * @param {ReturnType<typeof makeFakeClock>} clock
 */
async function pumpUntilSettled(promise, clock, { maxTicks = 50 } = {}) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < maxTicks && !settled; i += 1) {
    await flushMicrotasks();
    if (settled) break;
    if (clock.pendingCount() > 0) {
      await clock.advanceToNext();
    }
  }
  if (!settled) {
    throw new Error(`pumpUntilSettled: promise did not settle within ${maxTicks} ticks`);
  }
  return promise;
}

/**
 * A fake `http` (the append-blob-http.mjs interface) whose four methods are
 * individually swappable per test via `handlers`. Records every call for
 * assertions. Defaults are the "everything succeeds" happy path.
 */
function makeFakeHttp(handlers = {}) {
  const calls = { createAppendBlob: [], appendBlock: [], getProperties: [], putBlockBlob: [] };
  const blobs = new Map(); // blobName -> string content, for the "matches the mirror" restart test
  const blockCounts = new Map(); // blobName -> committed-block-count, mirroring Azure's real per-blob counter

  const defaults = {
    async createAppendBlob(args) {
      blobs.set(args.blobName, '');
      blockCounts.set(args.blobName, 0);
      return { status: 201 };
    },
    // Real Azure semantics: the append is honored ONLY when appendPos
    // matches the blob's current byte length -- otherwise 412. This is
    // what makes the "restart from a persisted cursor" scenario exercise
    // the real 412-absorption path rather than a fake that always accepts.
    async appendBlock(args) {
      const existing = blobs.get(args.blobName) ?? '';
      const existingBytes = Buffer.byteLength(existing, 'utf8');
      if (typeof args.appendPos === 'number' && args.appendPos !== existingBytes) {
        return { status: 412 };
      }
      blobs.set(args.blobName, existing + args.body);
      const nextCount = (blockCounts.get(args.blobName) ?? 0) + 1;
      blockCounts.set(args.blobName, nextCount);
      return { status: 201, appendOffset: existingBytes, committedBlockCount: nextCount };
    },
    async getProperties(args) {
      const existing = blobs.get(args.blobName) ?? '';
      return { status: 200, contentLength: Buffer.byteLength(existing, 'utf8'), committedBlockCount: blockCounts.get(args.blobName) ?? 0 };
    },
    async putBlockBlob() {
      return { status: 201 };
    },
  };

  const http = {
    blobs,
    blockCounts,
    calls,
    async createAppendBlob(args) {
      calls.createAppendBlob.push(args);
      return (handlers.createAppendBlob ?? defaults.createAppendBlob)(args);
    },
    async appendBlock(args) {
      calls.appendBlock.push(args);
      return (handlers.appendBlock ?? defaults.appendBlock)(args);
    },
    async getProperties(args) {
      calls.getProperties.push(args);
      return (handlers.getProperties ?? defaults.getProperties)(args);
    },
    async putBlockBlob(args) {
      calls.putBlockBlob.push(args);
      return (handlers.putBlockBlob ?? defaults.putBlockBlob)(args);
    },
  };
  return http;
}

function makeLog() {
  const lines = [];
  return {
    lines,
    info: (m) => lines.push(`INFO: ${m}`),
    warn: (m) => lines.push(`WARN: ${m}`),
    error: (m) => lines.push(`ERROR: ${m}`),
  };
}

function baseOpts(overrides = {}) {
  return {
    accountUrl: ACCOUNT_URL,
    containerName: CONTAINER,
    sas: SAS,
    sprintId: SPRINT_ID,
    redact: (r) => r,
    ...overrides,
  };
}

// =============================================================================
// Part 1 -- append-blob-http.mjs
// =============================================================================

describe('createAppendBlobHttp construction', () => {
  test('throws CONFIG_MISSING when fetch is not injected', () => {
    assert.throws(() => createAppendBlobHttp({}), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
  });
});

describe('createAppendBlobHttp requests', () => {
  test('createAppendBlob PUTs with x-ms-blob-type: AppendBlob and no comp query param', async () => {
    const fetchImpl = makeFakeFetch(() => fakeResponse(201));
    const http = createAppendBlobHttp({ fetch: fetchImpl });
    await http.createAppendBlob({ accountUrl: ACCOUNT_URL, containerName: CONTAINER, blobName: 'x.jsonl', sas: SAS });

    assert.strictEqual(fetchImpl.calls.length, 1);
    const { url, init } = fetchImpl.calls[0];
    assert.strictEqual(init.method, 'PUT');
    assert.strictEqual(init.headers['x-ms-blob-type'], 'AppendBlob');
    assert.ok(!url.includes('comp='));
    assert.ok(url.startsWith(`${ACCOUNT_URL}/${CONTAINER}/x.jsonl?`));
    assert.ok(url.includes(SAS));
  });

  test('appendBlock PUTs with comp=appendblock and sends x-ms-blob-condition-appendpos', async () => {
    const fetchImpl = makeFakeFetch(() => fakeResponse(201, { 'x-ms-blob-append-offset': '10', 'x-ms-blob-committed-block-count': '2' }));
    const http = createAppendBlobHttp({ fetch: fetchImpl });
    const result = await http.appendBlock({
      accountUrl: ACCOUNT_URL, containerName: CONTAINER, blobName: 'x.jsonl', sas: SAS, body: 'hello', appendPos: 10,
    });

    const { url, init } = fetchImpl.calls[0];
    assert.ok(url.includes('comp=appendblock'));
    assert.strictEqual(init.headers['x-ms-blob-condition-appendpos'], '10');
    assert.strictEqual(init.body, 'hello');
    assert.strictEqual(result.status, 201);
    assert.strictEqual(result.appendOffset, 10);
    assert.strictEqual(result.committedBlockCount, 2);
  });

  test('appendBlock omits the condition header when appendPos is null/undefined', async () => {
    const fetchImpl = makeFakeFetch(() => fakeResponse(201));
    const http = createAppendBlobHttp({ fetch: fetchImpl });
    await http.appendBlock({ accountUrl: ACCOUNT_URL, containerName: CONTAINER, blobName: 'x.jsonl', sas: SAS, body: 'hi', appendPos: null });

    assert.strictEqual(fetchImpl.calls[0].init.headers['x-ms-blob-condition-appendpos'], undefined);
  });

  test('appendBlock sends appendPos 0 (falsy but valid)', async () => {
    const fetchImpl = makeFakeFetch(() => fakeResponse(201));
    const http = createAppendBlobHttp({ fetch: fetchImpl });
    await http.appendBlock({ accountUrl: ACCOUNT_URL, containerName: CONTAINER, blobName: 'x.jsonl', sas: SAS, body: 'hi', appendPos: 0 });

    assert.strictEqual(fetchImpl.calls[0].init.headers['x-ms-blob-condition-appendpos'], '0');
  });

  test('a 412 response is returned as data, not thrown', async () => {
    const fetchImpl = makeFakeFetch(() => fakeResponse(412, { 'x-ms-error-code': 'AppendPositionConditionNotMet' }));
    const http = createAppendBlobHttp({ fetch: fetchImpl });
    const result = await http.appendBlock({ accountUrl: ACCOUNT_URL, containerName: CONTAINER, blobName: 'x.jsonl', sas: SAS, body: 'hi', appendPos: 5 });

    assert.strictEqual(result.status, 412);
    assert.strictEqual(result.errorCode, 'AppendPositionConditionNotMet');
  });

  test('getProperties issues a HEAD and parses content-length / committed-block-count', async () => {
    const fetchImpl = makeFakeFetch(() => fakeResponse(200, { 'content-length': '123', 'x-ms-blob-committed-block-count': '4' }));
    const http = createAppendBlobHttp({ fetch: fetchImpl });
    const result = await http.getProperties({ accountUrl: ACCOUNT_URL, containerName: CONTAINER, blobName: 'x.jsonl', sas: SAS });

    assert.strictEqual(fetchImpl.calls[0].init.method, 'HEAD');
    assert.strictEqual(result.contentLength, 123);
    assert.strictEqual(result.committedBlockCount, 4);
  });

  test('putBlockBlob PUTs with x-ms-blob-type: BlockBlob and a JSON content-type by default', async () => {
    const fetchImpl = makeFakeFetch(() => fakeResponse(201));
    const http = createAppendBlobHttp({ fetch: fetchImpl });
    await http.putBlockBlob({ accountUrl: ACCOUNT_URL, containerName: CONTAINER, blobName: 'x.manifest.json', sas: SAS, body: '{}' });

    const { init } = fetchImpl.calls[0];
    assert.strictEqual(init.headers['x-ms-blob-type'], 'BlockBlob');
    assert.strictEqual(init.headers['Content-Type'], 'application/json');
  });

  test('a rejected fetch (genuine network failure) propagates, not swallowed', async () => {
    const fetchImpl = makeFakeFetch(() => { throw new Error('ECONNRESET'); });
    const http = createAppendBlobHttp({ fetch: fetchImpl });
    await assert.rejects(
      () => http.appendBlock({ accountUrl: ACCOUNT_URL, containerName: CONTAINER, blobName: 'x.jsonl', sas: SAS, body: 'hi', appendPos: 0 }),
      /ECONNRESET/,
    );
  });

  test('the SAS never appears in a parsed result', async () => {
    const fetchImpl = makeFakeFetch(() => fakeResponse(201, {}, 'some body text'));
    const http = createAppendBlobHttp({ fetch: fetchImpl });
    const result = await http.appendBlock({ accountUrl: ACCOUNT_URL, containerName: CONTAINER, blobName: 'x.jsonl', sas: SAS, body: 'hi', appendPos: 0 });

    assert.ok(!JSON.stringify(result).includes(SAS));
  });
});

// =============================================================================
// Part 2 -- append-blob.mjs (createAppendBlobSink)
// =============================================================================

describe('createAppendBlobSink construction', () => {
  test('throws CONFIG_MISSING for each missing required string field', () => {
    for (const field of ['accountUrl', 'containerName', 'sas', 'sprintId']) {
      const opts = baseOpts({ http: makeFakeHttp(), clock: makeFakeClock() });
      delete opts[field];
      assert.throws(() => createAppendBlobSink(opts), (err) => {
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
        return true;
      }, `expected CONFIG_MISSING for missing ${field}`);
    }
  });

  test('throws CONFIG_MISSING when http is missing a required method', () => {
    const http = makeFakeHttp();
    delete http.appendBlock;
    assert.throws(() => createAppendBlobSink(baseOpts({ http, clock: makeFakeClock() })), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
  });

  test('throws CONFIG_MISSING when clock lacks setTimeout/clearTimeout', () => {
    assert.throws(() => createAppendBlobSink(baseOpts({ http: makeFakeHttp(), clock: { now: () => 0 } })), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
  });

  test('throws CONFIG_MISSING when redact is provided but not a function', () => {
    const opts = baseOpts({ http: makeFakeHttp(), clock: makeFakeClock(), redact: 'nope' });
    assert.throws(() => createAppendBlobSink(opts), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
  });

  test('defaults to a safe redactor (log-safe.mjs) when redact is omitted entirely', async () => {
    const opts = baseOpts({ http: makeFakeHttp(), clock: makeFakeClock() });
    delete opts.redact;
    const sink = createAppendBlobSink(opts);
    sink.emit({ token: 'super-secret-value' });
    await sink.flushNow();
    const sentBody = opts.http.calls.appendBlock[0].body;
    assert.ok(!sentBody.includes('super-secret-value'), 'the default redactor must mask a secret-named key');
    assert.ok(sentBody.includes('[REDACTED]'));
    await sink.stop();
  });

  test('throws CONFIG_INVALID for a non-positive flushIntervalMs/rollAtBlockCount/maxBlockBytes', () => {
    for (const field of ['flushIntervalMs', 'rollAtBlockCount', 'maxBlockBytes']) {
      assert.throws(
        () => createAppendBlobSink(baseOpts({ http: makeFakeHttp(), clock: makeFakeClock(), [field]: 0 })),
        (err) => { assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID); return true; },
        `expected CONFIG_INVALID for ${field}`,
      );
    }
  });

  test('throws CONFIG_INVALID when cursor is provided but not a plain object', () => {
    assert.throws(
      () => createAppendBlobSink(baseOpts({ http: makeFakeHttp(), clock: makeFakeClock(), cursor: 'nope' })),
      (err) => { assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID); return true; },
    );
  });
});

describe('createAppendBlobSink batching', () => {
  test('N emits produce ONE append, not N', async () => {
    const http = makeFakeHttp();
    const clock = makeFakeClock();
    const sink = createAppendBlobSink(baseOpts({ http, clock }));

    for (let i = 0; i < 25; i += 1) sink.emit({ i });
    assert.strictEqual(http.calls.appendBlock.length, 0, 'emit() must not append synchronously');

    await sink.flushNow();

    assert.strictEqual(http.calls.appendBlock.length, 1);
    const sentBody = http.calls.appendBlock[0].body;
    assert.strictEqual(sentBody.trim().split('\n').length, 25);
    await sink.stop();
  });

  test('emit() returns synchronously and buffers even before start()/flushNow()', async () => {
    const http = makeFakeHttp();
    const clock = makeFakeClock();
    const sink = createAppendBlobSink(baseOpts({ http, clock }));
    const result = sink.emit({ hello: 'world' });
    assert.strictEqual(result, undefined); // synchronous, no promise returned to await
    await sink.stop(); // settle the auto-started init/timer work this test's emit() kicked off
  });

  test('a second flushNow() with nothing new buffered performs no extra append', async () => {
    const http = makeFakeHttp();
    const clock = makeFakeClock();
    const sink = createAppendBlobSink(baseOpts({ http, clock }));
    sink.emit({ a: 1 });
    await sink.flushNow();
    assert.strictEqual(http.calls.appendBlock.length, 1);
    await sink.flushNow();
    assert.strictEqual(http.calls.appendBlock.length, 1);
    await sink.stop();
  });

  test('emits after stop() are dropped, not thrown, and do not trigger a further append', async () => {
    const http = makeFakeHttp();
    const clock = makeFakeClock();
    const sink = createAppendBlobSink(baseOpts({ http, clock }));
    sink.emit({ a: 1 });
    await sink.stop();
    const before = http.calls.appendBlock.length;
    sink.emit({ b: 2 });
    await sink.flushNow();
    assert.strictEqual(http.calls.appendBlock.length, before);
  });

  test('a fresh sprint creates the append blob and writes the manifest before the first append', async () => {
    const http = makeFakeHttp();
    const clock = makeFakeClock();
    const sink = createAppendBlobSink(baseOpts({ http, clock }));
    sink.emit({ a: 1 });
    await sink.flushNow();

    assert.strictEqual(http.calls.createAppendBlob.length, 1);
    assert.strictEqual(http.calls.createAppendBlob[0].blobName, blobNameForPart(SPRINT_ID, 1));
    assert.strictEqual(http.calls.putBlockBlob.length, 1);
    assert.strictEqual(http.calls.putBlockBlob[0].blobName, manifestBlobNameFor(SPRINT_ID));
    const manifest = JSON.parse(http.calls.putBlockBlob[0].body);
    // Pinned shape (fleet-bridge-build-log.md): parts is an array of
    // { part, blob, bytes, blocks, sealed } objects, not bare blob-name
    // strings -- the D1 archive SPA Range-GETs parts using bytes/blocks.
    assert.deepStrictEqual(manifest.parts, [
      { part: 1, blob: blobNameForPart(SPRINT_ID, 1), bytes: 0, blocks: 0, sealed: false },
    ]);
    await sink.stop();
  });

  test('a resumed cursor never recreates the blob', async () => {
    const http = makeFakeHttp();
    const clock = makeFakeClock();
    const cursor = { version: 1, sprintId: SPRINT_ID, blobName: `${SPRINT_ID}.jsonl`, partNumber: 1, appendPos: 0, committedBlockCount: 0, parts: [`${SPRINT_ID}.jsonl`] };
    const sink = createAppendBlobSink(baseOpts({ http, clock, cursor }));
    sink.emit({ a: 1 });
    await sink.flushNow();

    assert.strictEqual(http.calls.createAppendBlob.length, 0);
    assert.strictEqual(http.calls.appendBlock.length, 1);
    await sink.stop();
  });

  test('a resumed cursor carrying sealed-part metadata (the pinned shape) round-trips it into the next manifest write', async () => {
    const http = makeFakeHttp();
    const clock = makeFakeClock();
    const sealedPart1 = { part: 1, blob: blobNameForPart(SPRINT_ID, 1), bytes: 4321, blocks: 9, sealed: true };
    const cursor = {
      version: 1,
      sprintId: SPRINT_ID,
      blobName: blobNameForPart(SPRINT_ID, 2),
      partNumber: 2,
      appendPos: 0,
      committedBlockCount: 0,
      parts: [sealedPart1],
    };
    const sink = createAppendBlobSink(baseOpts({ http, clock, cursor, rollAtBlockCount: 2 }));
    sink.emit({ n: 1 });
    await sink.flushNow(); // committedBlockCount -> 1 on part2, no roll yet
    sink.emit({ n: 2 });
    await sink.flushNow(); // committedBlockCount -> 2, rolls to part3

    const lastManifestCall = http.calls.putBlockBlob[http.calls.putBlockBlob.length - 1];
    const manifest = JSON.parse(lastManifestCall.body);
    // The resumed sealed part1 entry survives verbatim, part2 is now sealed
    // with its own byte/block counts, and part3 is the new active part.
    assert.deepStrictEqual(manifest.parts[0], sealedPart1);
    assert.strictEqual(manifest.parts[1].part, 2);
    assert.strictEqual(manifest.parts[1].sealed, true);
    assert.strictEqual(manifest.parts[2].part, 3);
    assert.strictEqual(manifest.parts[2].sealed, false);
    await sink.stop();
  });
});

describe('createAppendBlobSink appendpos', () => {
  test('appendpos is sent on every append and advances by the bytes actually sent', async () => {
    const http = makeFakeHttp();
    const clock = makeFakeClock();
    const sink = createAppendBlobSink(baseOpts({ http, clock }));

    sink.emit({ n: 1 });
    await sink.flushNow();
    const firstBody = http.calls.appendBlock[0].body;
    assert.strictEqual(http.calls.appendBlock[0].appendPos, 0);
    assert.strictEqual(sink.cursor.appendPos, Buffer.byteLength(firstBody, 'utf8'));

    sink.emit({ n: 2 });
    await sink.flushNow();
    assert.strictEqual(http.calls.appendBlock[1].appendPos, Buffer.byteLength(firstBody, 'utf8'));
    await sink.stop();
  });
});

describe('createAppendBlobSink 412 handling', () => {
  test('412 is absorbed as success: properties are re-read, the buffered chunk is dropped, and it is logged at info', async () => {
    const log = makeLog();
    const clock = makeFakeClock();
    const http = makeFakeHttp({
      appendBlock: async () => ({ status: 412 }),
      getProperties: async () => ({ status: 200, contentLength: 999, committedBlockCount: 7 }),
    });
    const sink = createAppendBlobSink(baseOpts({ http, clock, logger: log }));

    sink.emit({ a: 1 });
    await sink.flushNow();

    assert.strictEqual(http.calls.getProperties.length, 1);
    assert.strictEqual(sink.cursor.appendPos, 999);
    assert.strictEqual(sink.cursor.committedBlockCount, 7);
    assert.ok(log.lines.some((l) => l.startsWith('INFO:') && /412/.test(l)));
    await sink.stop();
  });

  test('restart from a persisted cursor replays a flush that returns 412 without duplicating -- final content matches the local mirror', async () => {
    const clock1 = makeFakeClock();
    const http = makeFakeHttp(); // shared stateful fake blob store across both sink instances
    const redact = (r) => r;

    // First "process": flush two records successfully.
    const sinkA = createAppendBlobSink(baseOpts({ http, clock: clock1, redact }));
    sinkA.emit({ seq: 1 });
    sinkA.emit({ seq: 2 });
    await sinkA.flushNow();
    const cursorAfterA = sinkA.cursor;
    await sinkA.stop();

    // The local JSONL mirror would have these two lines (jsonl-file.mjs stamps
    // the same way -- see stampAndSerialize's cross-sink consistency note).
    const mirrorContent = http.blobs.get(cursorAfterA.blobName);
    assert.ok(mirrorContent.length > 0);

    // "Restart": a fresh sink resumes from the persisted cursor and re-emits
    // the SAME two records (as a daemon would, having not yet advanced its
    // own durable read-cursor past them before it crashed) using appendPos
    // pointing BEFORE they were written -- forcing the server (fake) to 412.
    const staleCursor = { ...cursorAfterA, appendPos: 0, committedBlockCount: 0 };
    const clock2 = makeFakeClock();
    const sinkB = createAppendBlobSink(baseOpts({ http, clock: clock2, redact, cursor: staleCursor }));
    sinkB.emit({ seq: 1 });
    sinkB.emit({ seq: 2 });
    await sinkB.flushNow();

    assert.strictEqual(http.calls.appendBlock.length, 2, 'exactly one append attempt per sink instance');
    const finalContent = http.blobs.get(cursorAfterA.blobName);
    assert.strictEqual(finalContent, mirrorContent, 'no duplicate bytes landed on replay');
    assert.strictEqual(sinkB.cursor.appendPos, Buffer.byteLength(mirrorContent, 'utf8'));
    await sinkB.stop();
  });
});

describe('createAppendBlobSink rolling', () => {
  test('rollAtBlockCount: 2 rolls to part2 and rewrites the manifest', async () => {
    const http = makeFakeHttp();
    const clock = makeFakeClock();
    const sink = createAppendBlobSink(baseOpts({ http, clock, rollAtBlockCount: 2 }));

    sink.emit({ n: 1 });
    await sink.flushNow(); // committedBlockCount -> 1 (fake increments by 1 per successful append)
    assert.strictEqual(sink.cursor.blobName, blobNameForPart(SPRINT_ID, 1));

    sink.emit({ n: 2 });
    await sink.flushNow(); // committedBlockCount -> 2, hits threshold, rolls
    assert.strictEqual(sink.cursor.blobName, blobNameForPart(SPRINT_ID, 2));
    assert.strictEqual(sink.cursor.partNumber, 2);
    assert.strictEqual(sink.cursor.appendPos, 0);

    // Manifest was rewritten listing both parts, in the pinned
    // { part, blob, bytes, blocks, sealed } shape: part 1 sealed with its
    // final byte/block counts captured at roll time, part 2 the new active
    // (unsealed) part starting fresh.
    const lastManifestCall = http.calls.putBlockBlob[http.calls.putBlockBlob.length - 1];
    const manifest = JSON.parse(lastManifestCall.body);
    assert.strictEqual(manifest.parts.length, 2);
    const part1BytesOnDisk = Buffer.byteLength(http.blobs.get(blobNameForPart(SPRINT_ID, 1)), 'utf8');
    assert.deepStrictEqual(manifest.parts[0], {
      part: 1, blob: blobNameForPart(SPRINT_ID, 1), bytes: part1BytesOnDisk, blocks: 2, sealed: true,
    });
    assert.deepStrictEqual(manifest.parts[1], {
      part: 2, blob: blobNameForPart(SPRINT_ID, 2), bytes: 0, blocks: 0, sealed: false,
    });

    // A new blob was actually created for part 2 before anything was appended to it.
    assert.ok(http.calls.createAppendBlob.some((c) => c.blobName === blobNameForPart(SPRINT_ID, 2)));

    // The next emit lands on part2, starting at offset 0.
    sink.emit({ n: 3 });
    await sink.flushNow();
    assert.strictEqual(http.calls.appendBlock[http.calls.appendBlock.length - 1].blobName, blobNameForPart(SPRINT_ID, 2));
    assert.strictEqual(http.calls.appendBlock[http.calls.appendBlock.length - 1].appendPos, 0);

    await sink.stop();
  });

  test('a real-world rollAtBlockCount (45000) never rolls in an ordinary short test run', async () => {
    const http = makeFakeHttp();
    const clock = makeFakeClock();
    const sink = createAppendBlobSink(baseOpts({ http, clock }));
    sink.emit({ n: 1 });
    await sink.flushNow();
    assert.strictEqual(sink.cursor.partNumber, 1);
    await sink.stop();
  });
});

describe('createAppendBlobSink 413 handling', () => {
  test('413 splits the buffer and retries each half', async () => {
    const oversizedBlobName = blobNameForPart(SPRINT_ID, 1);
    let calls = 0;
    const http = makeFakeHttp({
      appendBlock: async (args) => {
        calls += 1;
        // Reject anything with more than one JSON line in the body as "too big";
        // succeed once it has been split down to a single record.
        const lineCount = args.body.trim().split('\n').length;
        if (lineCount > 1) return { status: 413 };
        return { status: 201, committedBlockCount: calls };
      },
    });
    const clock = makeFakeClock();
    const sink = createAppendBlobSink(baseOpts({ http, clock }));

    sink.emit({ n: 1 });
    sink.emit({ n: 2 });
    sink.emit({ n: 3 });
    sink.emit({ n: 4 });
    await sink.flushNow();

    // 1 rejected attempt (all 4) + 2 rejected half-attempts (2 each) + 4 accepted single-line attempts = 7.
    assert.strictEqual(oversizedBlobName, sink.cursor.blobName);
    assert.ok(http.calls.appendBlock.length >= 7, `expected several split attempts, got ${http.calls.appendBlock.length}`);
    // Final state: all 4 records eventually landed, each as its own append.
    const singleLineAppends = http.calls.appendBlock.filter((c) => c.body.trim().split('\n').length === 1);
    assert.strictEqual(singleLineAppends.length, 4);
    await sink.stop();
  });

  test('a single record that alone exceeds the limit is dropped with a logged error, not retried forever', async () => {
    const log = makeLog();
    const http = makeFakeHttp({ appendBlock: async () => ({ status: 413 }) });
    const clock = makeFakeClock();
    const sink = createAppendBlobSink(baseOpts({ http, clock, logger: log }));

    sink.emit({ huge: 'x'.repeat(100) });
    await sink.flushNow();

    assert.ok(log.lines.some((l) => l.startsWith('ERROR:') && /exceeds/.test(l)));
    assert.deepStrictEqual(sink.cursor.appendPos, 0); // nothing was ever confirmed landed
    await sink.stop();
  });
});

describe('createAppendBlobSink 5xx/network handling', () => {
  test('a persistent 5xx retains the buffer, backs off, and leaves the cursor unchanged', async () => {
    const clock = makeFakeClock();
    const http = makeFakeHttp({ appendBlock: async () => ({ status: 503 }) });
    // A large flushIntervalMs keeps the auto-started periodic timer (see
    // emit()'s ensureStarted()) from ever becoming due during this test's
    // bounded backoff-retry sequence -- this test is only about flushNow()'s
    // own retry/backoff behavior, not the periodic loop.
    const sink = createAppendBlobSink(baseOpts({ http, clock, flushIntervalMs: 3_600_000 }));

    sink.emit({ n: 1 });
    const flushPromise = sink.flushNow();
    await pumpUntilSettled(flushPromise, clock);

    assert.strictEqual(http.calls.appendBlock.length, MAX_RETRY_ATTEMPTS);
    assert.strictEqual(sink.cursor.appendPos, 0, 'cursor must not advance on a failed append');

    // The buffered record is still there -- a later successful flush sends it.
    http.appendBlock = async (args) => { http.calls.appendBlock.push(args); return { status: 201, committedBlockCount: 1 }; };
    await sink.flushNow();
    assert.strictEqual(sink.cursor.appendPos > 0, true);
    await sink.stop();
  });

  test('a network error (rejected appendBlock) is treated the same as a 5xx: retried with backoff, buffer retained', async () => {
    const clock = makeFakeClock();
    const http = makeFakeHttp({ appendBlock: async () => { throw new Error('ETIMEDOUT'); } });
    const sink = createAppendBlobSink(baseOpts({ http, clock, flushIntervalMs: 3_600_000 }));

    sink.emit({ n: 1 });
    const flushPromise = sink.flushNow();
    await pumpUntilSettled(flushPromise, clock);

    assert.strictEqual(http.calls.appendBlock.length, MAX_RETRY_ATTEMPTS);
    assert.strictEqual(sink.cursor.appendPos, 0);
    // The fake endpoint never recovers, so stop()'s own best-effort final
    // flush will retry-and-fail again -- pump it too, or its backoff delay
    // never gets a chance to elapse and the test hangs.
    await pumpUntilSettled(sink.stop(), clock);
  });

  test('a transient 5xx that then succeeds on retry advances the cursor and stops retrying', async () => {
    const clock = makeFakeClock();
    let attempts = 0;
    const http = makeFakeHttp({
      appendBlock: async (args) => {
        attempts += 1;
        if (attempts < 2) return { status: 503 };
        return { status: 201, committedBlockCount: 1 };
      },
    });
    const sink = createAppendBlobSink(baseOpts({ http, clock, flushIntervalMs: 3_600_000 }));

    sink.emit({ n: 1 });
    const flushPromise = sink.flushNow();
    await pumpUntilSettled(flushPromise, clock);

    assert.strictEqual(attempts, 2);
    assert.ok(sink.cursor.appendPos > 0);
    await sink.stop();
  });
});

describe('createAppendBlobSink periodic flush', () => {
  test('start() schedules a flush on the timer without needing an explicit flushNow()', async () => {
    const http = makeFakeHttp();
    const clock = makeFakeClock();
    const sink = createAppendBlobSink(baseOpts({ http, clock, flushIntervalMs: 10_000 }));

    sink.start();
    sink.emit({ n: 1 });
    assert.strictEqual(http.calls.appendBlock.length, 0);
    assert.strictEqual(clock.pendingCount(), 1, 'start() must synchronously register the periodic timer');

    // The periodic loop reschedules itself on every tick, so it never
    // "finishes" -- advance() fires exactly what is due at the new time in
    // one pass rather than draining recursively (see its doc comment).
    await clock.advance(10_000);

    assert.strictEqual(http.calls.appendBlock.length, 1);
    await sink.stop();
  });

  test('stop() cancels the pending timer and performs one final flush', async () => {
    const http = makeFakeHttp();
    const clock = makeFakeClock();
    const sink = createAppendBlobSink(baseOpts({ http, clock, flushIntervalMs: 10_000 }));

    sink.start();
    sink.emit({ n: 1 });
    await sink.stop();

    assert.strictEqual(http.calls.appendBlock.length, 1);
    assert.strictEqual(clock.pendingCount(), 0);
  });
});

describe('createAppendBlobSink secret hygiene', () => {
  test('the SAS appears in no buffered record, no log line, and no cursor field', async () => {
    const log = makeLog();
    const clock = makeFakeClock();
    const http = makeFakeHttp({
      appendBlock: async () => ({ status: 412 }), // exercises the 412 log path too
      getProperties: async () => ({ status: 200, contentLength: 0, committedBlockCount: 0 }),
    });
    const sink = createAppendBlobSink(baseOpts({ http, clock, logger: log, rollAtBlockCount: 2 }));

    sink.emit({ note: 'ordinary record' });
    await sink.flushNow();

    assert.ok(!JSON.stringify(sink.cursor).includes(SAS));
    assert.ok(!log.lines.some((l) => l.includes(SAS)));
    for (const call of [...http.calls.appendBlock, ...http.calls.createAppendBlob, ...http.calls.putBlockBlob]) {
      assert.ok(!(call.body ?? '').includes(SAS));
    }
    await sink.stop();
  });

  test('redact() is applied to every record before it is buffered', async () => {
    const http = makeFakeHttp();
    const clock = makeFakeClock();
    const redacted = [];
    const redact = (r) => { const safe = { ...r, secret: '[redacted]' }; redacted.push(safe); return safe; };
    const sink = createAppendBlobSink(baseOpts({ http, clock, redact }));

    sink.emit({ secret: 'top-secret-value' });
    await sink.flushNow();

    const sentBody = http.calls.appendBlock[0].body;
    assert.ok(!sentBody.includes('top-secret-value'));
    assert.ok(sentBody.includes('[redacted]'));
    await sink.stop();
  });
});

describe('createAppendBlobSink cross-sink consistency (receivedAt stamping)', () => {
  test('a buffered line is stamped with receivedAt from clock.now(), same convention as jsonl-file.mjs', async () => {
    const http = makeFakeHttp();
    const clock = makeFakeClock(12345);
    const sink = createAppendBlobSink(baseOpts({ http, clock }));

    sink.emit({ hello: 'world' });
    await sink.flushNow();

    const line = http.calls.appendBlock[0].body.trim();
    const parsed = JSON.parse(line);
    assert.strictEqual(parsed.receivedAt, 12345);
    assert.strictEqual(parsed.hello, 'world');
    await sink.stop();
  });

  test('a non-object redacted result is wrapped under { data: ... }, same as jsonl-file.mjs', async () => {
    const http = makeFakeHttp();
    const clock = makeFakeClock(1);
    const sink = createAppendBlobSink(baseOpts({ http, clock, redact: () => 'a bare string' }));

    sink.emit('anything');
    await sink.flushNow();

    const parsed = JSON.parse(http.calls.appendBlock[0].body.trim());
    assert.deepStrictEqual(parsed, { receivedAt: 1, data: 'a bare string' });
    await sink.stop();
  });
});

describe('createAppendBlobSink 409 fallback', () => {
  test('an unexpected 409 forces a roll and retries the same chunk on the new blob', async () => {
    const http = makeFakeHttp({
      appendBlock: async (args) => {
        if (args.blobName === blobNameForPart(SPRINT_ID, 1)) return { status: 409 };
        return { status: 201, committedBlockCount: 1 };
      },
    });
    const clock = makeFakeClock();
    const sink = createAppendBlobSink(baseOpts({ http, clock }));

    sink.emit({ n: 1 });
    await sink.flushNow();

    assert.strictEqual(sink.cursor.blobName, blobNameForPart(SPRINT_ID, 2));
    assert.ok(sink.cursor.appendPos > 0);
    await sink.stop();
  });
});


// =============================================================================
// Part 3 -- health(): the sink says whether its writes are actually landing.
//
// WHY THIS MATTERS MORE THAN IT LOOKS: emit() only buffers, and every flush
// path in this sink is deliberately non-throwing, so from outside -- and in
// particular from sinks/index.mjs's fan stats() -- a sink whose every append
// is failing is indistinguishable from one that is working. health() is the
// only surface that can tell them apart, and sinks/health.mjs escalates on
// it. These tests are what stop it silently regressing to "always healthy".
// =============================================================================

// A flush interval far beyond any backoff delay these tests produce. The
// fake clock fires the EARLIEST pending timer, and firing the periodic
// flush timer while a flush is mid-backoff would deadlock the chain (the
// periodic callback awaits the very flush that is waiting on the timer the
// clock has not reached yet). Production is unaffected: real time advances
// on its own.
const HEALTH_TEST_FLUSH_MS = 60 * 60 * 1000;

describe('createAppendBlobSink health()', () => {
  test('a brand-new sink reports healthy with nothing pending', () => {
    const sink = createAppendBlobSink(baseOpts({ http: makeFakeHttp(), clock: makeFakeClock(), flushIntervalMs: HEALTH_TEST_FLUSH_MS }));
    const h = sink.health();
    assert.equal(h.healthy, true);
    assert.equal(h.consecutiveFailures, 0);
    assert.equal(h.pendingRecords, 0);
    assert.equal(h.name, 'append-blob');
  });

  test('a flush that lands clears the failure count and records a success', async () => {
    const clock = makeFakeClock();
    const sink = createAppendBlobSink(baseOpts({ http: makeFakeHttp(), clock, flushIntervalMs: HEALTH_TEST_FLUSH_MS }));
    sink.emit({ n: 1 });
    await sink.flushNow();
    const h = sink.health();
    assert.equal(h.healthy, true);
    assert.equal(h.successfulFlushes, 1);
    assert.equal(h.pendingRecords, 0);
    await pumpUntilSettled(sink.stop(), clock);
  });

  test('repeated 5xx failures accumulate, and the stranded records are reported', async () => {
    const http = makeFakeHttp({ appendBlock: async () => ({ status: 503 }) });
    const clock = makeFakeClock();
    const sink = createAppendBlobSink(baseOpts({ http, clock, flushIntervalMs: HEALTH_TEST_FLUSH_MS }));

    for (let i = 0; i < 3; i += 1) {
      sink.emit({ n: i });
      // eslint-disable-next-line no-await-in-loop
      await pumpUntilSettled(sink.flushNow(), clock);
    }

    const h = sink.health();
    assert.equal(h.healthy, false, 'a sink whose every append 503s must not report healthy');
    assert.equal(h.consecutiveFailures, 3);
    assert.equal(h.pendingRecords, 3, 'every record is still in memory and has reached no blob');
    assert.match(String(h.lastFailure), /retained for the next flush/);
    assert.equal(h.target, `${CONTAINER}/${blobNameForPart(SPRINT_ID, 1)}`);
    await pumpUntilSettled(sink.stop(), clock);
  });

  test('health() never carries the SAS -- not in target, not in lastFailure', async () => {
    // A transport error whose message quotes the signed URL is the realistic
    // leak path: nothing in this sink authored that string.
    const http = makeFakeHttp({
      appendBlock: async (args) => {
        throw new Error(`connect ECONNREFUSED https://acct.invalid/c/b?comp=appendblock&${args.sas}`);
      },
    });
    const clock = makeFakeClock();
    const sink = createAppendBlobSink(baseOpts({ http, clock, redact: undefined, flushIntervalMs: HEALTH_TEST_FLUSH_MS }));
    sink.emit({ n: 1 });
    await pumpUntilSettled(sink.flushNow(), clock);

    const serialized = JSON.stringify(sink.health());
    assert.ok(!serialized.includes('totally-secret-signature'), `health() leaked the SAS signature: ${serialized}`);
    await pumpUntilSettled(sink.stop(), clock);
  });

  test('a logger never receives the SAS either, even when the transport error quotes the signed URL', async () => {
    const lines = [];
    const http = makeFakeHttp({
      appendBlock: async (args) => {
        throw new Error(`socket hang up for https://acct.invalid/c/b?comp=appendblock&${args.sas}`);
      },
    });
    const clock = makeFakeClock();
    const sink = createAppendBlobSink(baseOpts({
      http,
      clock,
      redact: undefined,
      flushIntervalMs: HEALTH_TEST_FLUSH_MS,
      logger: { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) },
    }));
    sink.emit({ n: 1 });
    await pumpUntilSettled(sink.flushNow(), clock);

    assert.ok(lines.length > 0, 'expected at least one log line from a failing flush');
    for (const line of lines) {
      assert.ok(!String(line).includes('totally-secret-signature'), `a log line leaked the SAS: ${line}`);
    }
    await pumpUntilSettled(sink.stop(), clock);
  });

  test('a recovered flush resets the streak, so recovery is observable', async () => {
    let fail = true;
    const http = makeFakeHttp({
      appendBlock: async () => (fail ? { status: 503 } : { status: 201, committedBlockCount: 1 }),
    });
    const clock = makeFakeClock();
    const sink = createAppendBlobSink(baseOpts({ http, clock, flushIntervalMs: HEALTH_TEST_FLUSH_MS }));

    sink.emit({ n: 1 });
    await pumpUntilSettled(sink.flushNow(), clock);
    assert.equal(sink.health().healthy, false);

    fail = false;
    await pumpUntilSettled(sink.flushNow(), clock);
    const h = sink.health();
    assert.equal(h.healthy, true);
    assert.equal(h.consecutiveFailures, 0);
    assert.equal(h.pendingRecords, 0, 'the retained record must have been sent on recovery');
    await pumpUntilSettled(sink.stop(), clock);
  });
});
