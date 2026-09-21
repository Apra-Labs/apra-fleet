// Tests for src/supervisor-client.mjs -- all against a fake fetch + fake
// readTokenFile; no live supervisor (per the implementation plan's build
// scope: everything here is injected fakes only).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createSupervisorClient } from '../src/supervisor-client.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';

// -- fake fetch -------------------------------------------------------------

/**
 * @param {(url: string, init: object, callIndex: number) => object} handler
 *   returns a Response-like object: { status, text: async () => string }.
 */
function makeFakeFetch(handler) {
  const calls = [];
  async function fetchImpl(url, init = {}) {
    calls.push({ url, method: init.method, headers: init.headers || {}, body: init.body });
    return handler(url, init, calls.length - 1);
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

function jsonRes(status, obj) {
  return { status, text: async () => JSON.stringify(obj ?? {}) };
}

function textRes(status, str) {
  return { status, text: async () => str };
}

function networkFailingFetch(message = 'ECONNREFUSED') {
  return makeFakeFetch(() => { throw new Error(message); });
}

function makeLog() {
  const lines = [];
  const log = (msg) => lines.push(msg);
  log.lines = lines;
  return log;
}

const BASE = 'http://127.0.0.1:8787';

// -- construction -------------------------------------------------------------

describe('createSupervisorClient construction', () => {
  test('throws when baseUrl is missing', () => {
    assert.throws(() => createSupervisorClient({ fetch: makeFakeFetch(() => jsonRes(200, {})) }), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      assert.match(err.message, /baseUrl/);
      return true;
    });
  });

  test('normalises a trailing slash off baseUrl', async () => {
    const fetchImpl = makeFakeFetch(() => jsonRes(200, { status: 'ok' }));
    const client = createSupervisorClient({ baseUrl: `${BASE}/`, fetch: fetchImpl, readTokenFile: () => null });
    await client.getHealth();
    assert.strictEqual(fetchImpl.calls[0].url, `${BASE}/api/health`);
  });

  test('throws a clear error when no fetch implementation is available', () => {
    const original = globalThis.fetch;
    // eslint-disable-next-line no-undefined
    globalThis.fetch = undefined;
    try {
      assert.throws(
        () => createSupervisorClient({ baseUrl: BASE, readTokenFile: () => null }),
        (err) => {
          assert.ok(err instanceof BridgeError);
          assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
          assert.match(err.message, /fetch implementation/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  test('accepts an injected fetch without touching globalThis.fetch', async () => {
    const original = globalThis.fetch;
    let touchedGlobal = false;
    globalThis.fetch = new Proxy(() => {}, {
      apply() { touchedGlobal = true; return jsonRes(200, {}); },
    });
    try {
      const fetchImpl = makeFakeFetch(() => jsonRes(200, { status: 'ok' }));
      const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
      await client.getHealth();
      assert.strictEqual(touchedGlobal, false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// -- bearer forward-compat (#493) --------------------------------------------

describe('bearer forward-compat', () => {
  test('sends no Authorization header when readTokenFile returns null', async () => {
    const fetchImpl = makeFakeFetch(() => jsonRes(200, { status: 'ok' }));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    await client.getHealth();
    assert.strictEqual(fetchImpl.calls[0].headers.Authorization, undefined);
  });

  test('sends no Authorization header when readTokenFile returns empty string', async () => {
    const fetchImpl = makeFakeFetch(() => jsonRes(200, { status: 'ok' }));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => '' });
    await client.getHealth();
    assert.strictEqual(fetchImpl.calls[0].headers.Authorization, undefined);
  });

  test('sends Authorization: Bearer <token> when readTokenFile returns a token', async () => {
    const fetchImpl = makeFakeFetch(() => jsonRes(200, { status: 'ok' }));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => 'tok-abc' });
    await client.getHealth();
    assert.strictEqual(fetchImpl.calls[0].headers.Authorization, 'Bearer tok-abc');
  });

  test('caches the token after the first read; readTokenFile is not called on every request', async () => {
    const fetchImpl = makeFakeFetch(() => jsonRes(200, { status: 'ok' }));
    let reads = 0;
    const client = createSupervisorClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      readTokenFile: () => { reads += 1; return 'tok-abc'; },
    });
    await client.getHealth();
    await client.getHealth();
    await client.getHealth();
    assert.strictEqual(reads, 1);
  });

  test('a 401 triggers exactly one re-read of readTokenFile before giving up', async () => {
    let reads = 0;
    const fetchImpl = makeFakeFetch(() => jsonRes(401, { error: 'unauthorized' }));
    const client = createSupervisorClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      readTokenFile: () => { reads += 1; return null; },
    });
    await assert.rejects(() => client.getHealth(), BridgeError);
    // One read to populate the cache, one forced re-read on the 401.
    assert.strictEqual(reads, 2);
  });

  test('a 401 with a newly-minted token on re-read retries once and succeeds', async () => {
    let tokenValue = null;
    let readCalls = 0;
    const fetchImpl = makeFakeFetch((url, init) => {
      if (init.headers.Authorization === 'Bearer tok-new') return jsonRes(200, { status: 'ok' });
      return jsonRes(401, { error: 'unauthorized' });
    });
    const client = createSupervisorClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      readTokenFile: () => { readCalls += 1; return tokenValue; },
    });
    // First call: no token yet -> readTokenFile called once, returns null -> 401 ->
    // forced re-read calls readTokenFile again, still returns null -> throws.
    await assert.rejects(() => client.getHealth(), (err) => err.code === BRIDGE_ERROR_CODES.SUPERVISOR_UNAUTHORIZED);
    assert.strictEqual(readCalls, 2); // Initial read + forced re-read
    assert.strictEqual(fetchImpl.calls.length, 1); // One HTTP request (the 401)

    // Token gets minted while the bridge is running.
    tokenValue = 'tok-new';
    const health = await client.getHealth();
    assert.deepStrictEqual(health, { status: 'ok' });
    // Call 2: cache was not set for the null from call 1, so readTokenFile is called again,
    // finds the new token, sends it, gets 200. Only one HTTP request (no failed 401 first).
    // Total readTokenFile calls: 2 + 1 = 3; total HTTP calls: 1 + 1 = 2.
    assert.strictEqual(readCalls, 3);
    assert.strictEqual(fetchImpl.calls.length, 2);
  });

  test('401 throws SUPERVISOR_UNAUTHORIZED naming the token path', async () => {
    const fetchImpl = makeFakeFetch(() => jsonRes(401, { error: 'unauthorized' }));
    const client = createSupervisorClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      readTokenFile: () => null,
      tokenPath: '/var/lib/fleet/private/token',
    });
    const err = await client.getHealth().then(
      () => assert.fail('expected getHealth to reject'),
      (e) => e,
    );
    assert.ok(err instanceof BridgeError);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.SUPERVISOR_UNAUTHORIZED);
    assert.match(err.message, /\/var\/lib\/fleet\/private\/token/);
  });

  test('the token never appears in a log line or a thrown error for 401, 500, or a network failure', async () => {
    const SECRET = 'super-secret-token-should-never-leak-9f3c';

    // 401 case (via the cleanup-class stopSprint, which swallows the
    // resulting BridgeError and only ever logs/returns false).
    {
      const log = makeLog();
      const fetchImpl = makeFakeFetch(() => jsonRes(401, { error: 'unauthorized' }));
      const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => SECRET, log });
      const result = await client.stopSprint('sprint-1');
      assert.strictEqual(result, false);
      assert.ok(!log.lines.some((l) => l.includes(SECRET)));
    }

    // 500 case.
    {
      const log = makeLog();
      const fetchImpl = makeFakeFetch(() => textRes(500, 'internal error, no token here'));
      const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => SECRET, log });
      const err = await client.getHealth().then(() => null, (e) => e);
      assert.ok(err instanceof BridgeError);
      assert.ok(!err.message.includes(SECRET));
      assert.ok(!String(err.stack).includes(SECRET));
      assert.ok(!log.lines.some((l) => l.includes(SECRET)));
    }

    // Network failure case.
    {
      const log = makeLog();
      const fetchImpl = networkFailingFetch('getaddrinfo ENOTFOUND');
      const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => SECRET, log });
      const err = await client.getHealth().then(() => null, (e) => e);
      assert.ok(err instanceof BridgeError);
      assert.ok(!err.message.includes(SECRET));
      assert.ok(!String(err.stack).includes(SECRET));
      assert.ok(!log.lines.some((l) => l.includes(SECRET)));
    }
  });

  test('with readTokenFile returning null every time, three consecutive requests each call readTokenFile (FIX 4)', async () => {
    const fetchImpl = makeFakeFetch(() => jsonRes(200, { status: 'ok' }));
    let reads = 0;
    const client = createSupervisorClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      readTokenFile: () => { reads += 1; return null; },
    });
    // Three requests, each should call readTokenFile (no caching when token is null).
    await client.getHealth();
    await client.getHealth();
    await client.getHealth();
    assert.strictEqual(reads, 3);
    // Each request should have no Authorization header.
    assert.strictEqual(fetchImpl.calls[0].headers.Authorization, undefined);
    assert.strictEqual(fetchImpl.calls[1].headers.Authorization, undefined);
    assert.strictEqual(fetchImpl.calls[2].headers.Authorization, undefined);
  });
});

// -- error mapping ------------------------------------------------------------

describe('error mapping', () => {
  test('a network error maps to SUPERVISOR_UNAVAILABLE', async () => {
    const client = createSupervisorClient({
      baseUrl: BASE,
      fetch: networkFailingFetch('connect ECONNREFUSED'),
      readTokenFile: () => null,
    });
    await assert.rejects(() => client.getHealth(), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.SUPERVISOR_UNAVAILABLE);
      return true;
    });
  });

  test('postSprint: 400 maps to LAUNCH_INVALID with details.field from the body', async () => {
    const fetchImpl = makeFakeFetch(() => jsonRes(400, { error: 'branch is malformed', field: 'branch' }));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    await assert.rejects(() => client.postSprint({ issue: 'x', branch: '??' }), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.LAUNCH_INVALID);
      assert.strictEqual(err.details.field, 'branch');
      assert.match(err.message, /branch is malformed/);
      return true;
    });
  });

  test('postSprint: a plain 409 (member overlap) maps to LAUNCH_CONFLICT', async () => {
    const fetchImpl = makeFakeFetch(() => jsonRes(409, {
      error: "member overlap rejects launch: sprint 'x' already claims [alice]",
      field: 'members',
    }));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    await assert.rejects(() => client.postSprint({ issue: 'x' }), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.LAUNCH_CONFLICT);
      assert.strictEqual(err.details.field, 'members');
      return true;
    });
  });

  test('postSprint: a 409 with field:issue but without "deterministic" still maps to LAUNCH_RELAUNCH_GATE (FIX 1)', async () => {
    const fetchImpl = makeFakeFetch(() => jsonRes(409, {
      error: "relaunch of 'epic-1' refused: its prior incarnation ('epic-1-abc') ended with 'BEADS_SYNC_CONFLICT'",
      field: 'issue',
    }));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    await assert.rejects(() => client.postSprint({ issue: 'epic-1' }), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.LAUNCH_RELAUNCH_GATE);
      return true;
    });
  });

  test('postSprint: a 409 relaunch-gate body maps to LAUNCH_RELAUNCH_GATE, message verbatim', async () => {
    const serverMessage = "relaunch of 'epic-1' refused: its prior incarnation ('epic-1-abc') ended with " +
      "'BEADS_SYNC_CONFLICT', which is treated as deterministic and unaddressed -- pass " +
      'overrideRelaunchGate: true to relaunch anyway.';
    const fetchImpl = makeFakeFetch(() => jsonRes(409, { error: serverMessage, field: 'issue' }));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    await assert.rejects(() => client.postSprint({ issue: 'epic-1' }), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.LAUNCH_RELAUNCH_GATE);
      assert.strictEqual(err.message, serverMessage);
      return true;
    });
  });

  test('getSprint: 404 resolves to null rather than throwing', async () => {
    const fetchImpl = makeFakeFetch(() => textRes(404, "no sprint 'x' is live or in history"));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    const result = await client.getSprint('x');
    assert.strictEqual(result, null);
  });

  test('other non-2xx (e.g. 500) maps to SUPERVISOR_UNAVAILABLE with status and a body snippet', async () => {
    const fetchImpl = makeFakeFetch(() => textRes(500, 'boom, everything is on fire'));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    await assert.rejects(() => client.getMembers(), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.SUPERVISOR_UNAVAILABLE);
      assert.strictEqual(err.details.status, 500);
      assert.match(err.message, /boom, everything is on fire/);
      return true;
    });
  });

  test('a fetch that resolves to undefined becomes SUPERVISOR_UNAVAILABLE, not TypeError (FIX 2)', async () => {
    const fetchImpl = makeFakeFetch(() => undefined);
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    await assert.rejects(() => client.getHealth(), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.SUPERVISOR_UNAVAILABLE);
      assert.ok(!err.message.includes('TypeError'));
      return true;
    });
  });

  test('a fetch response whose text() rejects becomes SUPERVISOR_UNAVAILABLE, not rejection (FIX 2)', async () => {
    const badRes = { status: 200, text: async () => { throw new Error('text() failed'); } };
    const fetchImpl = makeFakeFetch(() => badRes);
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    await assert.rejects(() => client.getHealth(), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.SUPERVISOR_UNAVAILABLE);
      return true;
    });
  });

  test('a 500 whose body contains the token is redacted in the error message (FIX 3)', async () => {
    const SECRET = 'super-secret-tok-abc-xyz';
    const fetchImpl = makeFakeFetch(() => textRes(500, `error processing request with token=${SECRET}`));
    const client = createSupervisorClient({
      baseUrl: BASE,
      fetch: fetchImpl,
      readTokenFile: () => SECRET,
    });
    await assert.rejects(() => client.getMembers(), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.SUPERVISOR_UNAVAILABLE);
      assert.ok(!err.message.includes(SECRET));
      assert.match(err.message, /\[redacted\]/);
      return true;
    });
  });
});

// -- getSprint: un-leaning + shape normalisation ------------------------------

describe('getSprint', () => {
  test('resolves $ref entries against the _strings table before returning state', async () => {
    const repeated = 'x'.repeat(30); // >=24 chars, as dedupeStrings requires to dedupe
    const leanedState = {
      tree: [{ notesSummary: { $ref: 0 }, other: { $ref: 0 } }],
      _strings: [repeated],
    };
    const fetchImpl = makeFakeFetch(() => jsonRes(200, { sprintId: 'run-1', live: true, state: leanedState }));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    const result = await client.getSprint('run-1');
    assert.strictEqual(result.state.tree[0].notesSummary, repeated);
    assert.strictEqual(result.state.tree[0].other, repeated);
  });

  test('normalises the live shape', async () => {
    const fetchImpl = makeFakeFetch(() => jsonRes(200, { sprintId: 'run-1', live: true, state: { tree: [] } }));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    const result = await client.getSprint('run-1');
    assert.deepStrictEqual(result, {
      sprintId: 'run-1',
      live: true,
      terminal: false,
      state: { tree: [] },
      history: null,
      latest: null,
    });
  });

  test('normalises the terminal shape', async () => {
    const fetchImpl = makeFakeFetch(() => jsonRes(200, {
      sprintId: 'run-1', live: false, terminal: true, state: { tree: [], terminalReason: 'FINISHED' },
    }));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    const result = await client.getSprint('run-1');
    assert.strictEqual(result.live, false);
    assert.strictEqual(result.terminal, true);
    assert.deepStrictEqual(result.state, { tree: [], terminalReason: 'FINISHED' });
  });

  test('normalises the history shape (no state field)', async () => {
    const history = [{ event: 'FINISHED' }];
    const latest = { event: 'FINISHED', at: 123 };
    const fetchImpl = makeFakeFetch(() => jsonRes(200, { sprintId: 'run-1', live: false, history, latest }));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    const result = await client.getSprint('run-1');
    assert.deepStrictEqual(result, {
      sprintId: 'run-1',
      live: false,
      terminal: false,
      state: null,
      history,
      latest,
    });
  });
});

// -- postSprint: overrideRelaunchGate forwarding -----------------------------

describe('postSprint overrideRelaunchGate forwarding', () => {
  test('never injects overrideRelaunchGate by default', async () => {
    let sentBody;
    const fetchImpl = makeFakeFetch((url, init) => {
      sentBody = JSON.parse(init.body);
      return jsonRes(201, { sprintId: 'run-1' });
    });
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    await client.postSprint({ issue: 'epic-1', branch: 'auto/epic-1', members: 'alice' });
    assert.ok(!Object.prototype.hasOwnProperty.call(sentBody, 'overrideRelaunchGate'));
  });

  test('forwards overrideRelaunchGate when the caller explicitly passed it', async () => {
    let sentBody;
    const fetchImpl = makeFakeFetch((url, init) => {
      sentBody = JSON.parse(init.body);
      return jsonRes(201, { sprintId: 'run-1' });
    });
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    await client.postSprint({ issue: 'epic-1', overrideRelaunchGate: true });
    assert.strictEqual(sentBody.overrideRelaunchGate, true);
  });

  test('resolves with the launch response shape', async () => {
    const response = {
      sprintId: 'run-1', pid: 4242, port: 51234, logPath: '/tmp/run-1.log',
      issueRoots: ['epic-1'], members: ['alice'], goal: 'P1/P2',
    };
    const fetchImpl = makeFakeFetch(() => jsonRes(201, response));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    const result = await client.postSprint({ issue: 'epic-1', branch: 'auto/epic-1', members: 'alice' });
    assert.deepStrictEqual(result, response);
  });
});

// -- cleanup calls: stopSprint / forceRelease swallow and return false -------

describe('cleanup calls', () => {
  test('stopSprint returns a truthy result on success', async () => {
    const fetchImpl = makeFakeFetch(() => jsonRes(200, { sprintId: 'run-1', status: 'stopping' }));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    const result = await client.stopSprint('run-1');
    assert.deepStrictEqual(result, { sprintId: 'run-1', status: 'stopping' });
  });

  test('stopSprint swallows a non-2xx response and returns false (logged, not thrown)', async () => {
    const log = makeLog();
    const fetchImpl = makeFakeFetch(() => textRes(409, "sprint 'run-1' has no reachable child"));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null, log });
    const result = await client.stopSprint('run-1');
    assert.strictEqual(result, false);
    assert.ok(log.lines.some((l) => l.includes('run-1')));
  });

  test('stopSprint swallows a network failure and returns false (logged, not thrown)', async () => {
    const log = makeLog();
    const fetchImpl = networkFailingFetch('ECONNRESET');
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null, log });
    const result = await client.stopSprint('run-1');
    assert.strictEqual(result, false);
    assert.ok(log.lines.length > 0);
    // Strengthen: the log must actually mention the failure, not just be non-empty (FIX 4).
    assert.ok(log.lines.some((l) => l.includes('failed') || l.includes('ECONNRESET')));
  });

  test('forceRelease returns a truthy result on success and forwards by/reason', async () => {
    let sentBody;
    const fetchImpl = makeFakeFetch((url, init) => {
      sentBody = JSON.parse(init.body);
      return jsonRes(200, { status: 'force-released', sprintId: 'run-1' });
    });
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    const result = await client.forceRelease('run-1', { by: 'operator', reason: 'stuck' });
    assert.deepStrictEqual(result, { status: 'force-released', sprintId: 'run-1' });
    assert.deepStrictEqual(sentBody, { by: 'operator', reason: 'stuck' });
  });

  test('forceRelease swallows failure and returns false', async () => {
    const log = makeLog();
    const fetchImpl = makeFakeFetch(() => jsonRes(404, { error: "no sprint 'run-1'" }));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null, log });
    const result = await client.forceRelease('run-1', { by: 'operator', reason: 'stuck' });
    assert.strictEqual(result, false);
    assert.ok(log.lines.length > 0);
  });
});

// -- getLog -------------------------------------------------------------------

describe('getLog', () => {
  test('returns the raw text body, not JSON-parsed', async () => {
    const fetchImpl = makeFakeFetch(() => textRes(200, 'line one\nline two\n'));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    const result = await client.getLog('run-1');
    assert.strictEqual(result, 'line one\nline two\n');
  });

  test('forwards ?tail=N in the query string', async () => {
    const fetchImpl = makeFakeFetch(() => textRes(200, 'line two\n'));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    await client.getLog('run-1', { tail: 5 });
    assert.strictEqual(fetchImpl.calls[0].url, `${BASE}/sprints/run-1/log?tail=5`);
  });

  test('omits the query string when tail is not given', async () => {
    const fetchImpl = makeFakeFetch(() => textRes(200, 'all of it\n'));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    await client.getLog('run-1');
    assert.strictEqual(fetchImpl.calls[0].url, `${BASE}/sprints/run-1/log`);
  });

  test('a 404 (no log recorded) resolves to null rather than throwing', async () => {
    const fetchImpl = makeFakeFetch(() => textRes(404, "No log recorded for sprint 'run-1'"));
    const client = createSupervisorClient({ baseUrl: BASE, fetch: fetchImpl, readTokenFile: () => null });
    const result = await client.getLog('run-1');
    assert.strictEqual(result, null);
  });
});
