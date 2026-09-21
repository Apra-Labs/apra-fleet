// Tests for src/sinks/health.mjs and src/spa/archive-publisher.mjs -- the
// two pieces that make the remote-observability path VISIBLE rather than
// merely present.
//
// The failure mode being guarded against is not "the blob sink is broken".
// It is "the blob sink is broken and nothing said so": the sink batches, so
// every emit succeeds instantly, and the fan isolates it, so the caller
// never sees an error. Without these two modules, a sprint could run for two
// days publishing nothing remotely while every log line and every exit code
// said everything was fine.
//
// Fake clock, fake log, fake alert, fake http -- no timers, no network.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createSinkHealthMonitor, DEFAULT_UNHEALTHY_AFTER, DEFAULT_REALERT_EVERY_MS } from '../src/sinks/health.mjs';
import { createArchivePublisher, ARCHIVE_PREFIX } from '../src/spa/archive-publisher.mjs';
import { runWatch } from '../src/verbs/watch.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';

/** A sink stub whose health() is whatever the test says it is right now. */
function fakeSink(health) {
  const box = { current: health };
  return {
    box,
    entry(name = 'append-blob') {
      return { name, sink: { emit() {}, health: () => box.current } };
    },
  };
}

function healthy(extra = {}) {
  return { name: 'append-blob', healthy: true, consecutiveFailures: 0, successfulFlushes: 5, pendingRecords: 0, target: 'c/s.jsonl', ...extra };
}

function failing(n, extra = {}) {
  return { name: 'append-blob', healthy: false, consecutiveFailures: n, successfulFlushes: 0, pendingRecords: n * 2, lastFailure: 'status 403', target: 'c/s.jsonl', ...extra };
}

function makeHarness({ start = 0 } = {}) {
  let t = start;
  const logs = [];
  const alerts = [];
  const monitor = createSinkHealthMonitor({
    log: (m) => logs.push(String(m)),
    now: () => t,
    alert: async (m) => { alerts.push(String(m)); },
  });
  return { monitor, logs, alerts, advance(ms) { t += ms; }, at: () => t };
}

describe('createSinkHealthMonitor construction', () => {
  test('requires an injected log and now, as BridgeErrors', () => {
    for (const bad of [{}, { log: () => {} }, { now: () => 0 }]) {
      assert.throws(() => createSinkHealthMonitor(bad), (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
        return true;
      });
    }
  });
});

describe('createSinkHealthMonitor escalation', () => {
  test('a sink with no health() is silently ignored -- opting out is not a failure', async () => {
    const { monitor, logs, alerts } = makeHarness();
    await monitor.check([{ name: 'jsonl-file', sink: { emit() {} } }]);
    assert.deepEqual(logs, []);
    assert.deepEqual(alerts, []);
  });

  test('a failure streak below the threshold says nothing -- one 500 is normal', async () => {
    const { monitor, logs, alerts } = makeHarness();
    const s = fakeSink(failing(DEFAULT_UNHEALTHY_AFTER - 1));
    await monitor.check([s.entry()]);
    assert.deepEqual(logs, []);
    assert.deepEqual(alerts, []);
    assert.deepEqual(monitor.degradedNames(), []);
  });

  test('crossing the threshold produces a MULTI-LINE banner, not a one-liner that scrolls past', async () => {
    const { monitor, logs, alerts } = makeHarness();
    const s = fakeSink(failing(DEFAULT_UNHEALTHY_AFTER));
    await monitor.check([s.entry(), { name: 'jsonl-file', sink: { emit() {} } }]);

    assert.equal(logs.length, 1);
    const lines = logs[0].split('\n');
    assert.ok(lines.length >= 8, `expected a banner, got ${lines.length} line(s)`);
    assert.match(logs[0], /PROGRESS SINK DEGRADED: append-blob/);
    assert.match(logs[0], /Records waiting in memory and NOT yet remote: 6/);
    assert.match(logs[0], /status 403/);
    // The reader must be told what they have NOT lost.
    assert.match(logs[0], /Still writing normally: jsonl-file/);
    assert.match(logs[0], /not a sprint failure/);

    // And the operator, who is not watching this log, is told too.
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /Remote progress sink "append-blob" is failing/);
    assert.deepEqual(monitor.degradedNames(), ['append-blob']);
  });

  test('the banner says so explicitly when NO other sink is running', async () => {
    const { monitor, logs } = makeHarness();
    const s = fakeSink(failing(DEFAULT_UNHEALTHY_AFTER));
    await monitor.check([s.entry()]);
    assert.match(logs[0], /NO other sink is running/);
  });

  test('a sustained outage re-announces on a heartbeat, not on every tick', async () => {
    const { monitor, logs, alerts, advance } = makeHarness();
    const s = fakeSink(failing(DEFAULT_UNHEALTHY_AFTER));
    const entries = [s.entry()];

    await monitor.check(entries);
    for (let i = 0; i < 20; i += 1) {
      advance(1000);
      // eslint-disable-next-line no-await-in-loop
      await monitor.check(entries);
    }
    assert.equal(logs.length, 1, 'a two-day outage must not print a banner per tick');
    assert.equal(alerts.length, 1);

    advance(DEFAULT_REALERT_EVERY_MS);
    s.box.current = failing(DEFAULT_UNHEALTHY_AFTER + 40);
    await monitor.check(entries);
    assert.equal(logs.length, 2);
    assert.match(logs[1], /STILL DEGRADED/);
    assert.equal(alerts.length, 2, 'the operator is reminded on a heartbeat, so the failure cannot be forgotten');
  });

  test('recovery is announced too -- "it came back" is half the signal', async () => {
    const { monitor, logs, alerts, advance } = makeHarness();
    const s = fakeSink(failing(DEFAULT_UNHEALTHY_AFTER));
    const entries = [s.entry()];
    await monitor.check(entries);

    advance(120000);
    s.box.current = healthy();
    await monitor.check(entries);

    assert.match(logs[1], /PROGRESS SINK RECOVERED: append-blob/);
    assert.match(alerts[1], /recovered after/);
    assert.deepEqual(monitor.degradedNames(), []);
  });

  test('an alert channel that throws is isolated -- reporting a failure cannot become a second failure', async () => {
    const logs = [];
    const monitor = createSinkHealthMonitor({
      log: (m) => logs.push(String(m)),
      now: () => 0,
      alert: async () => { throw new Error('work item API is down'); },
    });
    const s = fakeSink(failing(DEFAULT_UNHEALTHY_AFTER));
    await monitor.check([s.entry()]);
    assert.match(logs.join('\n'), /alert channel failed/);
  });

  test('a health() that throws is treated as the worst case, never swallowed', async () => {
    const { monitor, logs } = makeHarness();
    await monitor.check([{ name: 'append-blob', sink: { emit() {}, health() { throw new Error('boom'); } } }]);
    assert.match(logs.join('\n'), /PROGRESS SINK DEGRADED/);
  });

  test('finalReport escalates a sink that was still failing when the run ended', async () => {
    const { monitor, logs } = makeHarness();
    const s = fakeSink(failing(1)); // below the tick threshold, so check() stayed quiet
    await monitor.check([s.entry()]);
    assert.deepEqual(logs, []);

    monitor.finalReport([s.entry()]);
    assert.match(logs[0], /PROGRESS SINK ENDED DEGRADED/);
    assert.match(logs[0], /remote log for this sprint is INCOMPLETE/);
  });

  test('finalReport is quiet for a sink that was never in trouble', () => {
    const { monitor, logs } = makeHarness();
    monitor.finalReport([fakeSink(healthy()).entry()]);
    assert.deepEqual(logs, []);
  });
});

// ---------------------------------------------------------------------------
// watch wires the monitor in for real.
// ---------------------------------------------------------------------------

describe('runWatch escalates a quietly failing sink', () => {
  test('a sink that accepts every record but reports failing health produces a banner and a work-item comment', async () => {
    const logs = [];
    const comments = [];
    const emitted = [];

    // The whole point: emit() SUCCEEDS every time. Only health() knows.
    const blobSink = {
      emit(r) { emitted.push(r); },
      flushNow() {},
      stop() {},
      health: () => failing(10),
    };

    const sprint = { sprintId: 's1', terminal: true, state: { tree: [] } };
    const result = await runWatch({ sprintId: 's1' }, {
      supervisorClient: { getSprint: async () => sprint, getLog: async () => null },
      sinks: [{ name: 'append-blob', sink: blobSink }],
      spool: { read: async () => null },
      adapter: { comment: async (t) => { comments.push(t); } },
      sleep: async () => {},
      now: () => 0,
      log: (m) => logs.push(String(m)),
    });

    assert.ok(result, 'watch must still return its snapshot -- a failing sink never ends the sprint');
    assert.equal(emitted.length, 1, 'the record was accepted by the sink, as it always is');
    const all = logs.join('\n');
    assert.match(all, /PROGRESS SINK DEGRADED: append-blob/);
    assert.match(all, /PROGRESS SINK ENDED DEGRADED: append-blob/);
    assert.ok(comments.some((c) => /Remote progress sink "append-blob" is failing/.test(c)),
      `expected the operator to be told via the work item; comments were: ${JSON.stringify(comments)}`);
  });

  test('a healthy run produces no degradation noise at all', async () => {
    const logs = [];
    const sprint = { sprintId: 's1', terminal: true, state: { tree: [] } };
    await runWatch({ sprintId: 's1' }, {
      supervisorClient: { getSprint: async () => sprint, getLog: async () => null },
      sinks: [{ name: 'append-blob', sink: { emit() {}, health: () => healthy() } }],
      spool: { read: async () => null },
      adapter: {},
      sleep: async () => {},
      now: () => 0,
      log: (m) => logs.push(String(m)),
    });
    assert.ok(!logs.join('\n').includes('DEGRADED'), logs.join('\n'));
  });
});

// ---------------------------------------------------------------------------
// The archive publisher.
// ---------------------------------------------------------------------------

const ARCHIVE_SAS = 'sv=2025-01-01&sp=racw&sig=archive-secret-signature';

function makeFakeBlobHttp(statusFor = () => 201) {
  const calls = [];
  return {
    calls,
    putBlockBlob: async (args) => {
      calls.push(args);
      const status = statusFor(args);
      if (status === 'throw') throw new Error('socket hang up');
      return { status };
    },
  };
}

const TERMINAL_STATE = {
  tree: [{ phases: [{ events: [{ type: 'activity', id: 'act-1', data: { output: 'hello' } }] }] }],
  extensions: {},
};

describe('createArchivePublisher', () => {
  test('requires its coordinates and an http with putBlockBlob', () => {
    for (const bad of [
      {},
      { accountUrl: 'u' },
      { accountUrl: 'u', containerName: 'c' },
      { accountUrl: 'u', containerName: 'c', sas: 's' },
      { accountUrl: 'u', containerName: 'c', sas: 's', http: {} },
    ]) {
      assert.throws(() => createArchivePublisher(bad), (err) => {
        assert.ok(err instanceof BridgeError);
        return true;
      });
    }
  });

  test('uploads the page and every per-item blob under sprints/<sprintId>/', async () => {
    const http = makeFakeBlobHttp();
    const publisher = createArchivePublisher({ accountUrl: 'https://acct.invalid', containerName: 'logs', sas: ARCHIVE_SAS, http });

    const result = await publisher.publish({ sprintId: 'spr-1', state: TERMINAL_STATE });

    assert.equal(result.ok, true);
    assert.equal(result.failures.length, 0);
    const names = http.calls.map((c) => c.blobName);
    assert.ok(names.includes(`${ARCHIVE_PREFIX}/spr-1/index.html`));
    assert.ok(names.includes(`${ARCHIVE_PREFIX}/spr-1/activities/act-1.json`),
      `the lazy-load blob that 404s on a finished sprint today must be materialised; saw ${names.join(', ')}`);
    assert.equal(result.uploaded, names.length);
  });

  test('the reported index URL is UNSIGNED -- it gets pasted into a work item', async () => {
    const http = makeFakeBlobHttp();
    const publisher = createArchivePublisher({ accountUrl: 'https://acct.invalid/', containerName: 'logs', sas: ARCHIVE_SAS, http });
    const result = await publisher.publish({ sprintId: 'spr-1', state: TERMINAL_STATE });
    assert.equal(result.indexUrl, 'https://acct.invalid/logs/sprints/spr-1/index.html');
    assert.ok(!result.indexUrl.includes('sig='));
    assert.ok(!JSON.stringify(result).includes('archive-secret-signature'));
  });

  test('a failed upload is reported per file and never thrown', async () => {
    const http = makeFakeBlobHttp((args) => (args.blobName.endsWith('index.html') ? 403 : 201));
    const publisher = createArchivePublisher({ accountUrl: 'https://acct.invalid', containerName: 'logs', sas: ARCHIVE_SAS, http });

    const result = await publisher.publish({ sprintId: 'spr-1', state: TERMINAL_STATE });
    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].path, 'index.html');
    assert.match(result.failures[0].reason, /403/);
  });

  test('a transport error is data too, not an exception', async () => {
    const http = makeFakeBlobHttp(() => 'throw');
    const publisher = createArchivePublisher({ accountUrl: 'https://acct.invalid', containerName: 'logs', sas: ARCHIVE_SAS, http });
    const result = await publisher.publish({ sprintId: 'spr-1', state: TERMINAL_STATE });
    assert.equal(result.ok, false);
    assert.equal(result.uploaded, 0);
    assert.equal(result.indexUrl, null);
    assert.match(result.failures[0].reason, /socket hang up/);
  });

  test('a malformed terminal state is reported, not thrown -- finalize must still finish', async () => {
    const http = makeFakeBlobHttp();
    const publisher = createArchivePublisher({ accountUrl: 'https://acct.invalid', containerName: 'logs', sas: ARCHIVE_SAS, http });
    const result = await publisher.publish({ sprintId: 'spr-1', state: null });
    assert.equal(result.ok, false);
    assert.match(result.error, /could not build the bundle/);
    assert.equal(http.calls.length, 0);
  });
});
