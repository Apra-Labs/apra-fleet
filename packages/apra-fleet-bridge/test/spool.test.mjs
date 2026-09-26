// Tests for src/spool.mjs -- an in-memory fake fs, a fake clock, and a fake
// liveness probe throughout. No real filesystem, no real timers (renameRetry
// is given `sleep: async () => {}` so a forced EPERM retry never actually
// waits).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createSpool, SPOOL_VERSION } from '../src/spool.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPOOL_SOURCE_PATH = path.join(__dirname, '..', 'src', 'spool.mjs');

// -- in-memory fake fs --------------------------------------------------------

function makeFakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));

  function normalize(p) {
    return p.replace(/\\/g, '/');
  }

  return {
    files,
    async mkdir() {
      // No real directories to track -- the fake fs is a flat path->content map.
    },
    async readFile(p) {
      const key = normalize(p);
      if (!files.has(key)) {
        const err = new Error(`ENOENT: no such file, open '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(key);
    },
    // Honours `{ flag: 'wx' }` (exclusive create), because that is the whole
    // mechanism behind the cross-process claim lock -- a fake that ignored
    // the flag would make the lock tests vacuous.
    async writeFile(p, body, encOrOpts) {
      const key = normalize(p);
      const flag = encOrOpts && typeof encOrOpts === 'object' ? encOrOpts.flag : undefined;
      if (flag === 'wx' && files.has(key)) {
        const err = new Error(`EEXIST: file already exists, open '${p}'`);
        err.code = 'EEXIST';
        throw err;
      }
      files.set(key, body);
    },
    async unlink(p) {
      const key = normalize(p);
      if (!files.has(key)) {
        const err = new Error(`ENOENT: no such file, unlink '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      files.delete(key);
    },
    async rename(src, dst) {
      const srcKey = normalize(src);
      const dstKey = normalize(dst);
      if (!files.has(srcKey)) {
        const err = new Error(`ENOENT: no such file, rename '${src}' -> '${dst}'`);
        err.code = 'ENOENT';
        throw err;
      }
      files.set(dstKey, files.get(srcKey));
      files.delete(srcKey);
    },
    async readdir(dir) {
      const prefix = `${normalize(dir).replace(/\/+$/, '')}/`;
      const names = [];
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (!rest.includes('/')) names.push(rest);
        }
      }
      return names;
    },
  };
}

function makeClock(startIso = '2026-01-01T00:00:00.000Z') {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current).toISOString(),
    advance(ms) { current += ms; },
  };
}

function makeLogger() {
  const errors = [];
  const logs = [];
  return {
    error: (...a) => errors.push(a.join(' ')),
    log: (...a) => logs.push(a.join(' ')),
    errors,
    logs,
  };
}

const SPOOL_DIR = '/spool';
const NO_REAL_WAIT = { renameRetry: { sleep: async () => {} } };

// -- write / read -------------------------------------------------------------

describe('write / read', () => {
  test('write() then read() round-trips a handle', async () => {
    const fs = makeFakeFs();
    const clock = makeClock();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: clock.now, ...NO_REAL_WAIT });

    await spool.write({ sprintId: 'sprint-1', pid: 4242, port: 51234 });
    const doc = await spool.read('sprint-1');

    assert.strictEqual(doc.version, SPOOL_VERSION);
    assert.strictEqual(doc.sprintId, 'sprint-1');
    assert.strictEqual(doc.state, 'unknown');
    assert.strictEqual(doc.claim, null);
    assert.deepStrictEqual(doc.sinkCursors, {});
    assert.strictEqual(doc.handle.pid, 4242);
  });

  test('write() creates exactly one file at <spoolDir>/<sprintId>.handle.json', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });
    await spool.write({ sprintId: 'abc' });
    assert.ok(fs.files.has(`${SPOOL_DIR}/abc.handle.json`));
  });

  test('read() of a missing sprintId returns undefined, not an error', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });
    const result = await spool.read('does-not-exist');
    assert.strictEqual(result, undefined);
  });

  test('write() throws a BridgeError (CONFIG_INVALID) without handle.sprintId', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });
    await assert.rejects(() => spool.write({}), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      return true;
    });
  });

  test('a second write() fully replaces the document (raw put, not a merge)', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });
    await spool.write({ sprintId: 's1', state: 'launched', progress: { phase: 'plan' } });
    await spool.write({ sprintId: 's1', state: 'launched' });
    const doc = await spool.read('s1');
    assert.strictEqual(doc.progress, null);
  });
});

// -- corrupt / foreign-version handling ---------------------------------------

describe('corrupt and foreign-version handles', () => {
  test('invalid JSON is quarantined (moved aside) and logged, not thrown', async () => {
    const fs = makeFakeFs({ [`${SPOOL_DIR}/bad.handle.json`]: '{ not valid json' });
    const logger = makeLogger();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', logger, ...NO_REAL_WAIT });

    const result = await spool.read('bad');
    assert.strictEqual(result, undefined);
    assert.ok(!fs.files.has(`${SPOOL_DIR}/bad.handle.json`), 'the corrupt file must be moved aside');
    const quarantined = [...fs.files.keys()].some((k) => k.startsWith(`${SPOOL_DIR}/bad.handle.json.corrupt-`));
    assert.ok(quarantined, 'a quarantine copy must exist');
    assert.ok(logger.errors.some((l) => l.includes('bad') || l.includes('quarantined')));
  });

  test('a foreign-version document is quarantined and logged, not thrown', async () => {
    const doc = { version: 999, sprintId: 'v9', state: 'unknown' };
    const fs = makeFakeFs({ [`${SPOOL_DIR}/v9.handle.json`]: JSON.stringify(doc) });
    const logger = makeLogger();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', logger, ...NO_REAL_WAIT });

    const result = await spool.read('v9');
    assert.strictEqual(result, undefined);
    assert.ok(logger.errors.length > 0);
  });

  test('one corrupt handle does not stop list() from returning the others', async () => {
    const fs = makeFakeFs({
      [`${SPOOL_DIR}/good-1.handle.json`]: JSON.stringify({ version: SPOOL_VERSION, sprintId: 'good-1', state: 'unknown', handle: null, claim: null, progress: null, sinkCursors: {}, finalize: null, updatedAt: 'now' }),
      [`${SPOOL_DIR}/bad.handle.json`]: '{{{not json',
      [`${SPOOL_DIR}/good-2.handle.json`]: JSON.stringify({ version: SPOOL_VERSION, sprintId: 'good-2', state: 'unknown', handle: null, claim: null, progress: null, sinkCursors: {}, finalize: null, updatedAt: 'now' }),
    });
    const logger = makeLogger();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', logger, ...NO_REAL_WAIT });

    const docs = await spool.list();
    const ids = docs.map((d) => d.sprintId).sort();
    assert.deepStrictEqual(ids, ['good-1', 'good-2']);
  });
});

// -- list() with a filter ------------------------------------------------------

describe('list()', () => {
  test('returns [] when the spool directory does not exist yet', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });
    const docs = await spool.list();
    assert.deepStrictEqual(docs, []);
  });

  test('a filter function narrows the returned documents', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });
    await spool.write({ sprintId: 's1', state: 'launched' });
    await spool.write({ sprintId: 's2', state: 'completed' });

    const launched = await spool.list((d) => d.state === 'launched');
    assert.deepStrictEqual(launched.map((d) => d.sprintId), ['s1']);
  });

  test('ignores .tmp and .corrupt-* siblings', async () => {
    const fs = makeFakeFs({
      [`${SPOOL_DIR}/s1.handle.json.tmp`]: 'partial-write-in-progress',
      [`${SPOOL_DIR}/s1.handle.json.corrupt-12345`]: 'quarantined-junk',
    });
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });
    const docs = await spool.list();
    assert.deepStrictEqual(docs, []);
  });
});

// -- claim() / release() -------------------------------------------------------

describe('claim()', () => {
  test('claims a fresh sprint with no prior claim (after write())', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', isAlive: () => false, ...NO_REAL_WAIT });
    await spool.write({ sprintId: 's1' });
    const ok = await spool.claim('s1', { pid: 111, host: 'box-a' });
    assert.strictEqual(ok, true);
    const doc = await spool.read('s1');
    assert.deepStrictEqual(doc.claim, { pid: 111, host: 'box-a', claimedAt: 'now' });
  });

  test('refuses to claim when an existing claim is LIVE (probe injected)', async () => {
    const fs = makeFakeFs();
    const isAliveCalls = [];
    const isAlive = (pid, host) => { isAliveCalls.push({ pid, host }); return pid === 111; };
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', isAlive, ...NO_REAL_WAIT });
    await spool.write({ sprintId: 's1' });

    assert.strictEqual(await spool.claim('s1', { pid: 111, host: 'box-a' }), true);
    const refused = await spool.claim('s1', { pid: 222, host: 'box-b' });
    assert.strictEqual(refused, false);

    const doc = await spool.read('s1');
    assert.strictEqual(doc.claim.pid, 111, 'the live claim must be left untouched');
    assert.ok(isAliveCalls.some((c) => c.pid === 111 && c.host === 'box-a'));
  });

  test('takes over a claim whose process is dead (probe injected)', async () => {
    const fs = makeFakeFs();
    const isAlive = (pid) => pid === 999; // 111 (the existing claimant) reports dead
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', isAlive, ...NO_REAL_WAIT });
    await spool.write({ sprintId: 's1' });

    await spool.claim('s1', { pid: 111, host: 'box-a' });
    const tookOver = await spool.claim('s1', { pid: 222, host: 'box-b' });
    assert.strictEqual(tookOver, true);

    const doc = await spool.read('s1');
    assert.strictEqual(doc.claim.pid, 222);
    assert.strictEqual(doc.claim.host, 'box-b');
  });

  test('release() clears the claim and leaves other fields untouched', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', isAlive: () => false, ...NO_REAL_WAIT });
    await spool.write({ sprintId: 's1', state: 'launched', progress: { phase: 'plan' } });
    await spool.claim('s1', { pid: 111, host: 'box-a' });

    await spool.release('s1');
    const doc = await spool.read('s1');
    assert.strictEqual(doc.claim, null);
    assert.strictEqual(doc.state, 'launched');
    assert.deepStrictEqual(doc.progress, { phase: 'plan' });
  });

  test('release() on an unclaimed sprint is a harmless no-op', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });
    await spool.write({ sprintId: 's1' });
    const doc = await spool.release('s1');
    assert.strictEqual(doc.claim, null);
  });

  // -- FIX 2: fail-safe default when no isAlive probe is injected -----------
  // The four required cases: no probe -> refuses; explicit force -> takes
  // over; live probe -> refuses (covered above); dead probe -> takes over
  // (covered above).

  test('FIX 2: with no isAlive injected and an existing claim, claim() REFUSES (does not steal) and logs a warning', async () => {
    const fs = makeFakeFs();
    const logger = makeLogger();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', logger, ...NO_REAL_WAIT });
    await spool.write({ sprintId: 's1' });

    assert.strictEqual(await spool.claim('s1', { pid: 111, host: 'box-a' }), true);
    const stolen = await spool.claim('s1', { pid: 222, host: 'box-b' });
    assert.strictEqual(stolen, false, 'no probe injected -- must refuse, never assume the prior claimant is dead');

    const doc = await spool.read('s1');
    assert.strictEqual(doc.claim.pid, 111, 'the existing claim must be left untouched');
    assert.ok(logger.errors.some((l) => l.includes('isAlive')));
  });

  test('FIX 2: with no isAlive injected, an explicit { force: true } takes the claim over', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });
    await spool.write({ sprintId: 's1' });

    assert.strictEqual(await spool.claim('s1', { pid: 111, host: 'box-a' }), true);
    const tookOver = await spool.claim('s1', { pid: 222, host: 'box-b', force: true });
    assert.strictEqual(tookOver, true, '{ force: true } is the only way to steal a claim with no probe injected');

    const doc = await spool.read('s1');
    assert.strictEqual(doc.claim.pid, 222);
    assert.strictEqual(doc.claim.host, 'box-b');
  });

  test('FIX 2: { force: true } is a no-op safety net when there was no existing claim at all', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });
    await spool.write({ sprintId: 's1' });
    const ok = await spool.claim('s1', { pid: 111, host: 'box-a', force: true });
    assert.strictEqual(ok, true);
  });

  // -- FIX 3: claiming a sprintId that was never write()-n -------------------

  test('FIX 3: claim() on a sprintId with no spool document throws a BridgeError, never a silent claim over nothing', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', isAlive: () => false, ...NO_REAL_WAIT });
    await assert.rejects(() => spool.claim('never-written', { pid: 111, host: 'box-a' }), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      assert.strictEqual(err.details.reason, 'no-such-document');
      return true;
    });
    const doc = await spool.read('never-written');
    assert.strictEqual(doc, undefined, 'the failed claim must not have created a document as a side effect');
  });
});

// -- complete() / fail() -------------------------------------------------------

describe('complete() / fail()', () => {
  test('complete() sets state and records the result', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => '2026-02-02T00:00:00.000Z', ...NO_REAL_WAIT });
    await spool.write({ sprintId: 's1' });
    await spool.complete('s1', { prUrl: 'https://example/pr/1' });
    const doc = await spool.read('s1');
    assert.strictEqual(doc.state, 'completed');
    assert.strictEqual(doc.finalize.outcome, 'completed');
    assert.deepStrictEqual(doc.finalize.result, { prUrl: 'https://example/pr/1' });
  });

  test('fail() sets state and normalizes the error, never persisting a raw Error object', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });
    await spool.write({ sprintId: 's1' });
    const err = new Error('boom');
    err.code = 'NOTHING_TO_DO';
    await spool.fail('s1', err);
    const doc = await spool.read('s1');
    assert.strictEqual(doc.state, 'failed');
    assert.strictEqual(doc.finalize.error.message, 'boom');
    assert.strictEqual(doc.finalize.error.code, 'NOTHING_TO_DO');
  });
});

// -- serialized per-file writer queue ------------------------------------------

describe('serialized writer queue', () => {
  test('concurrent patch() calls for the SAME sprintId never interleave (last writer wins over its own reads, none lost)', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });
    await spool.write({ sprintId: 's1', sinkCursors: {} });

    await Promise.all([
      spool.patch('s1', (draft) => { draft.sinkCursors.a = 1; }),
      spool.patch('s1', (draft) => { draft.sinkCursors.b = 2; }),
      spool.patch('s1', (draft) => { draft.sinkCursors.c = 3; }),
    ]);

    const doc = await spool.read('s1');
    assert.deepStrictEqual(doc.sinkCursors, { a: 1, b: 2, c: 3 });
  });

  test('writes for DIFFERENT sprintIds are independent and both land', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });
    await Promise.all([
      spool.write({ sprintId: 's1', state: 'launched' }),
      spool.write({ sprintId: 's2', state: 'launched' }),
    ]);
    assert.strictEqual((await spool.read('s1')).sprintId, 's1');
    assert.strictEqual((await spool.read('s2')).sprintId, 's2');
  });

  test('a failed transaction does not poison later transactions for the same sprintId', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });
    await spool.write({ sprintId: 's1' });

    await assert.rejects(() => spool.patch('s1', () => { throw new Error('mutate failed'); }));
    // The next transaction for the same sprintId must still go through.
    await spool.patch('s1', (draft) => { draft.state = 'launched'; });
    const doc = await spool.read('s1');
    assert.strictEqual(doc.state, 'launched');
  });
});

// -- atomic write uses temp-then-rename, EPERM/EBUSY retried ------------------

describe('atomic write via renameWithRetry', () => {
  test('a transient EPERM on rename is retried and the write still succeeds', async () => {
    const fs = makeFakeFs();
    let attempts = 0;
    const realRename = fs.rename.bind(fs);
    fs.rename = async (src, dst) => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      return realRename(src, dst);
    };
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', renameRetry: { sleep: async () => {}, baseDelayMs: 0 } });
    await spool.write({ sprintId: 's1' });
    assert.ok(attempts >= 3);
    const doc = await spool.read('s1');
    assert.strictEqual(doc.sprintId, 's1');
  });
});

// -- FIX 5: source-scan guard against ambient I/O sneaking into spool.mjs ----
// Equivalent to adapters.test.mjs's guard over the adapter modules. spool.mjs
// legitimately imports `node:path` (pure, no I/O), the injected-fs-only
// `renameWithRetry` helper, and `./errors.mjs` for the BridgeError taxonomy --
// those three are explicitly allowed; anything else (a real `node:fs`,
// `process.env`, a direct `fetch`, or any other new import) fails this test.

describe('source-scan guard (FIX 5)', () => {
  const ALLOWED_SPOOL_IMPORTS = [
    'node:path',
    '@apralabs/apra-fleet-se/src/supervisor/rename-with-retry.mjs',
    './errors.mjs',
  ];

  test('spool.mjs imports only from the explicit allowlist', () => {
    const src = readFileSync(SPOOL_SOURCE_PATH, 'utf-8');
    const specifiers = [...src.matchAll(/^import\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"];?\s*$/gm)].map((m) => m[1]);
    assert.ok(specifiers.length > 0, 'sanity check: the import scan must find at least one import');
    for (const spec of specifiers) {
      assert.ok(
        ALLOWED_SPOOL_IMPORTS.includes(spec),
        `spool.mjs imports an unexpected module "${spec}" -- must be one of: ${ALLOWED_SPOOL_IMPORTS.join(', ')}`
      );
    }
  });

  test('spool.mjs never reads process.env, imports a real node:fs, or calls fetch directly', () => {
    const src = readFileSync(SPOOL_SOURCE_PATH, 'utf-8');
    assert.ok(!/process\.env[.[]/.test(src), 'spool.mjs must not read process.env');
    assert.ok(
      !/from ['"]node:fs['"]/.test(src) && !/require\(['"]node:fs['"]\)/.test(src),
      'spool.mjs must not import a real node:fs'
    );
    assert.ok(
      !/globalThis\.fetch\s*\(/.test(src) && !/(?<![.\w])fetch\s*\(/.test(src),
      'spool.mjs must not call fetch directly'
    );
  });
});

// -- cross-process exclusion, unique temp names, wrapped fs errors ------------
// These three areas cover the defects found in the pre-merge review. The
// interleaving test below is the load-bearing one: a test that merely claims
// twice in sequence passes against the OLD code too, because the old code did
// refuse a claim already durable on disk. What it could not do is stop two
// processes that both read a claim-free document before either wrote. That is
// what is simulated here.

/**
 * Wrap a fake fs so the FIRST read of `gatedPath` blocks until `release()` is
 * called. This suspends one "process" precisely between its read and its
 * write, with no timers and no real concurrency.
 */
function gateFirstReadOf(fs, gatedPath) {
  let resolveGate;
  const gate = new Promise((r) => { resolveGate = r; });
  let armed = true;
  let reached;
  const reachedPromise = new Promise((r) => { reached = r; });
  const realReadFile = fs.readFile.bind(fs);
  fs.readFile = async (p, enc) => {
    if (armed && p.replace(/\\/g, '/') === gatedPath) {
      armed = false;
      reached();
      await gate;
    }
    return realReadFile(p, enc);
  };
  return { release: () => resolveGate(), reachedPromise };
}

describe('cross-process claim exclusion', () => {
  test('two processes interleaved between read and write: exactly ONE claim succeeds', async () => {
    const fs = makeFakeFs();
    // One shared filesystem, two independent spool instances -- the stand-in
    // for two `fleet-bridge daemon` processes. Distinct pids so the lock's
    // owner record identifies which one holds it.
    const setup = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', pid: 111, ...NO_REAL_WAIT });
    await setup.write({ sprintId: 's1' });

    // The lock holder (pid 111) is alive; pid 222 is the newcomer. A probe
    // saying "alive" is what makes breaking the lock illegitimate here.
    const isAlive = (p) => p === 111;
    const spoolA = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', pid: 111, isAlive, ...NO_REAL_WAIT });
    const spoolB = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', pid: 222, isAlive, ...NO_REAL_WAIT });

    const { release, reachedPromise } = gateFirstReadOf(fs, `${SPOOL_DIR}/s1.handle.json`);

    const pA = spoolA.claim('s1', { pid: 111, host: 'box-a' });
    await reachedPromise; // A is now suspended between its read and its write.
    const resultB = await spoolB.claim('s1', { pid: 222, host: 'box-b' });
    release();
    const resultA = await pA;

    assert.strictEqual(
      [resultA, resultB].filter(Boolean).length,
      1,
      'exactly one of two simultaneously-starting daemons may claim the sprint'
    );
    assert.strictEqual(resultA, true, 'the process that took the lock first wins');
    assert.strictEqual(resultB, false, 'the second process must be refused, not granted a duplicate ownership');

    const doc = await setup.read('s1');
    assert.strictEqual(doc.claim.pid, 111);
  });

  test('the claim lock is released after a successful claim, so the next claim is not wedged', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', isAlive: () => false, ...NO_REAL_WAIT });
    await spool.write({ sprintId: 's1' });
    assert.strictEqual(await spool.claim('s1', { pid: 111, host: 'box-a' }), true);
    assert.ok(
      ![...fs.files.keys()].some((k) => k.endsWith('.claimlock')),
      'no lock file may survive a completed claim'
    );
    assert.strictEqual(await spool.claim('s1', { pid: 222, host: 'box-b' }), true);
  });

  test('the claim lock is released even when the claim throws (no document)', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', isAlive: () => false, ...NO_REAL_WAIT });
    await assert.rejects(() => spool.claim('never-written', { pid: 1, host: 'h' }));
    assert.ok(![...fs.files.keys()].some((k) => k.endsWith('.claimlock')), 'a thrown claim must not leak its lock');
  });

  test('a lock file is never mistaken for a sprint by list()', async () => {
    const fs = makeFakeFs({ [`${SPOOL_DIR}/s1.handle.json.claimlock`]: '{"pid":1}' });
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });
    assert.deepStrictEqual(await spool.list(), []);
  });

  test('a stale lock is NOT broken on age -- only a probe reporting the holder dead breaks it', async () => {
    const fs = makeFakeFs();
    const setup = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', pid: 111, ...NO_REAL_WAIT });
    await setup.write({ sprintId: 's1' });
    const lockKey = `${SPOOL_DIR}/s1.handle.json.claimlock`;
    // A lock left behind by a crashed pid 111.
    fs.files.set(lockKey, JSON.stringify({ pid: 111, host: 'box-a', at: 'then' }));

    // No probe: refuse. Guessing "it looks old" would reintroduce the very
    // double-owner bug the lock exists to prevent.
    const noProbe = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', pid: 222, ...NO_REAL_WAIT });
    assert.strictEqual(await noProbe.claim('s1', { pid: 222, host: 'box-b' }), false);
    assert.ok(fs.files.has(lockKey), 'the lock must survive a refusal');

    // A probe reporting the holder ALIVE: still refuse.
    const aliveProbe = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', pid: 222, isAlive: () => true, ...NO_REAL_WAIT });
    assert.strictEqual(await aliveProbe.claim('s1', { pid: 222, host: 'box-b' }), false);

    // A probe reporting the holder DEAD: break it and proceed.
    const deadProbe = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', pid: 222, isAlive: (p) => p !== 111, ...NO_REAL_WAIT });
    assert.strictEqual(await deadProbe.claim('s1', { pid: 222, host: 'box-b' }), true);
    assert.ok(!fs.files.has(lockKey));
  });

  test('an explicit { force: true } breaks a held lock (operator override)', async () => {
    const fs = makeFakeFs();
    const setup = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });
    await setup.write({ sprintId: 's1' });
    fs.files.set(`${SPOOL_DIR}/s1.handle.json.claimlock`, JSON.stringify({ pid: 111, host: 'box-a', at: 'then' }));

    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', isAlive: () => true, ...NO_REAL_WAIT });
    assert.strictEqual(await spool.claim('s1', { pid: 222, host: 'box-b', force: true }), true);
  });

  test('claim() refuses to run when the injected fs has no unlink (a lock it could never release)', async () => {
    const fs = makeFakeFs();
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });
    await spool.write({ sprintId: 's1' });
    delete fs.unlink;
    await assert.rejects(() => spool.claim('s1', { pid: 1, host: 'h' }), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
  });
});

describe('unique temp file names', () => {
  test('concurrent patch() calls never share a temp path, within or across processes', async () => {
    const fs = makeFakeFs();
    const tmpPaths = [];
    const realWriteFile = fs.writeFile.bind(fs);
    fs.writeFile = async (p, body, encOrOpts) => {
      if (String(p).endsWith('.tmp')) tmpPaths.push(String(p));
      return realWriteFile(p, body, encOrOpts);
    };

    const spoolA = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', pid: 111, ...NO_REAL_WAIT });
    const spoolB = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', pid: 222, ...NO_REAL_WAIT });
    await spoolA.write({ sprintId: 's1' });

    await Promise.all([
      spoolA.patch('s1', (d) => { d.sinkCursors.a = 1; }),
      spoolB.patch('s1', (d) => { d.sinkCursors.b = 2; }),
      spoolA.patch('s1', (d) => { d.sinkCursors.c = 3; }),
      spoolB.patch('s1', (d) => { d.sinkCursors.d = 4; }),
    ]);

    assert.ok(tmpPaths.length >= 5, 'sanity: every write goes through a temp file');
    assert.strictEqual(new Set(tmpPaths).size, tmpPaths.length, 'no two writes may share a temp path');
    assert.ok(
      tmpPaths.some((p) => p.includes('.111.')) && tmpPaths.some((p) => p.includes('.222.')),
      'the temp name must carry the writing pid so two processes cannot collide'
    );
    assert.ok(tmpPaths.every((p) => p.endsWith('.tmp')), 'temp names must still end in .tmp so list() skips them');
  });

  test('a failed write cleans up its temp file instead of littering the spool directory', async () => {
    const fs = makeFakeFs();
    fs.rename = async () => {
      const err = new Error('EIO: i/o error');
      err.code = 'EIO';
      throw err;
    };
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });

    await assert.rejects(() => spool.write({ sprintId: 's1' }), (err) => {
      assert.ok(err instanceof BridgeError, 'a failed write must cross the boundary as a BridgeError');
      assert.strictEqual(err.details.fsCode, 'EIO');
      return true;
    });
    assert.ok(
      ![...fs.files.keys()].some((k) => k.endsWith('.tmp')),
      'no temp file may be left behind by a failed write'
    );
  });
});

describe('raw filesystem errors never cross the module boundary', () => {
  test('list() wraps a non-ENOENT readdir failure in a BridgeError, preserving the cause', async () => {
    const fs = makeFakeFs();
    const cause = new Error("EACCES: permission denied, scandir '/spool'");
    cause.code = 'EACCES';
    fs.readdir = async () => { throw cause; };
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });

    await assert.rejects(() => spool.list(), (err) => {
      assert.ok(err instanceof BridgeError, 'an unreadable spool directory must not escape as a raw fs error');
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.PREFLIGHT_UNAVAILABLE);
      assert.strictEqual(err.details.fsCode, 'EACCES');
      assert.strictEqual(err.details.cause, cause, 'the original error must be preserved for diagnosis');
      assert.ok(err.message.includes('EACCES'));
      return true;
    });
  });

  test('list() still treats a missing spool directory as empty, not as a failure', async () => {
    const fs = makeFakeFs();
    fs.readdir = async () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    };
    const spool = createSpool({ spoolDir: SPOOL_DIR, fs, now: () => 'now', ...NO_REAL_WAIT });
    assert.deepStrictEqual(await spool.list(), []);
  });
});
