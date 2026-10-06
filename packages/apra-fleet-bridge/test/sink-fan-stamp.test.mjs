// The remote blob and the local JSONL mirror must hold the same bytes for the
// same record stream -- the guarantee append-blob.mjs's header calls
// load-bearing. Observed live (the first run against real Azure storage): the
// two differed only in `receivedAt`, by one millisecond, because each sink
// stamped every record from its OWN clock. The fan now stamps once and hands
// every sink the same timestamp. Real sinks here, fake I/O only.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSinkFan } from '../src/sinks/index.mjs';
import { createJsonlFileSink } from '../src/sinks/jsonl-file.mjs';
import { createAppendBlobSink } from '../src/sinks/append-blob.mjs';
import { stampAndSerialize } from '../src/sinks/record.mjs';

/** A clock whose now() is different on every call -- the worst case for two sinks each stamping. */
function driftingClock(start, step) {
  let t = start;
  return {
    now: () => { t += step; return t; },
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
}

function fakeStream() {
  const chunks = [];
  return { chunks, write: (c) => { chunks.push(String(c)); return true; }, end: (cb) => { if (cb) cb(); }, on: () => {} };
}

function fakeBlobHttp() {
  const appended = [];
  let offset = 0;
  let blocks = 0;
  const ok = (status, extra = {}) => ({ status, appendOffset: offset, committedBlockCount: blocks, contentLength: offset, errorCode: null, body: '', ...extra });
  return {
    appended,
    createAppendBlob: async () => ok(201),
    putBlockBlob: async () => ok(201),
    getProperties: async () => ok(200),
    appendBlock: async ({ body }) => {
      appended.push(String(body));
      offset += Buffer.byteLength(String(body));
      blocks += 1;
      return ok(201);
    },
  };
}

test('the blob and the local mirror hold identical bytes even when the sinks\' own clocks disagree', async () => {
  const stream = fakeStream();
  const http = fakeBlobHttp();
  const identity = (r) => r;

  const local = createJsonlFileSink({ path: 'x.jsonl', openAppendStream: () => stream, redact: identity, clock: driftingClock(1_000, 1) });
  const blob = createAppendBlobSink({
    accountUrl: 'https://acct.invalid', containerName: 'c', sas: 'sv=x', sprintId: 's1',
    http, clock: driftingClock(5_000, 7), redact: identity,
  });

  let fanNow = 90_000;
  const fan = createSinkFan({
    sinks: [{ name: 'jsonl-file', sink: local }, { name: 'append-blob', sink: blob }],
    now: () => { fanNow += 3; return fanNow; },
    log: () => {},
  });

  await fan.emit({ phase: 'Plan', cycle: 1 });
  await fan.emit({ phase: 'Develop', cycle: 1 });
  await fan.emit({ phase: 'Integ Test', cycle: 1 });
  await fan.flushNow();
  await fan.stop();

  const localBytes = stream.chunks.join('');
  const blobBytes = http.appended.join('');
  assert.ok(localBytes.length > 0, 'the local mirror received the records');
  assert.equal(blobBytes, localBytes);
  // And the shared stamp is the fan's, not either sink's own clock.
  assert.deepEqual(localBytes.trim().split('\n').map((l) => JSON.parse(l).receivedAt), [90_003, 90_006, 90_009]);
});

test('stampAndSerialize uses the supplied receivedAt, and falls back to the clock without one', () => {
  const clock = { now: () => 42 };
  assert.equal(JSON.parse(stampAndSerialize({ a: 1 }, (r) => r, clock, 7)).receivedAt, 7);
  assert.equal(JSON.parse(stampAndSerialize({ a: 1 }, (r) => r, clock)).receivedAt, 42);
});
