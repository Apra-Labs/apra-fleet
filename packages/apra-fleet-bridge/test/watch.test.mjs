// Tests for src/verbs/watch.mjs. Fakes throughout: a fake supervisor client
// (queued getSprint/getLog responses, repeating the last one forever), a
// fake adapter, fake sinks, a fake spool, and a fake clock where `sleep(ms)`
// advances `now()` by exactly `ms` -- no real timers anywhere in this file.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  runWatch,
  validateWatchOpts,
  buildPhaseComment,
  DEFAULT_GIVE_UP_MS,
  DEFAULT_LOG_TAIL_LINES,
} from '../src/verbs/watch.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';
import { createAdapterFacade } from '../src/adapters/facade.mjs';

// -- fakes --------------------------------------------------------------------

/** A clock where `sleep(ms)` advances `now()` by exactly `ms` -- no real timers. */
function makeFakeClock(startMs = 0) {
  let current = startMs;
  const sleepCalls = [];
  return {
    sleepCalls,
    now: () => current,
    sleep: async (ms) => { sleepCalls.push(ms); current += ms; },
  };
}

function makeLog() {
  const lines = [];
  const log = (msg) => lines.push(msg);
  log.lines = lines;
  return log;
}

/** Wraps a function so the fake supervisor client calls (and possibly throws from) it. */
function throwing(err) {
  return () => { throw err; };
}

/**
 * A fake supervisor client whose `getSprint`/`getLog` each return the next
 * entry of their own queue in order, then repeat the last entry forever
 * (same convention as await-gate.test.mjs's fake). An entry may be a plain
 * value or a function (invoked; a throwing function simulates a rejected
 * call).
 */
function makeFakeSupervisorClient({ getSprintResponses = [], getLogResponses = [] } = {}) {
  let sIdx = 0;
  let lIdx = 0;
  const getSprintCalls = [];
  const getLogCalls = [];
  return {
    getSprintCalls,
    getLogCalls,
    async getSprint(sprintId) {
      getSprintCalls.push(sprintId);
      const entry = getSprintResponses[Math.min(sIdx, getSprintResponses.length - 1)];
      sIdx += 1;
      return typeof entry === 'function' ? entry() : entry;
    },
    async getLog(sprintId, opts) {
      getLogCalls.push({ sprintId, opts });
      const entry = getLogResponses[Math.min(lIdx, getLogResponses.length - 1)];
      lIdx += 1;
      return typeof entry === 'function' ? entry() : entry;
    },
  };
}

function stateWithPhase(title, extra = {}) {
  return {
    tree: [{ title: 'Group', phases: [{ title, phaseStartedAt: '2026-01-01T00:00:00.000Z', phaseEndedAt: null }] }],
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function liveSprint(state, extra = {}) {
  return { sprintId: 'sprint-1', live: true, terminal: false, state, history: null, latest: null, ...extra };
}

function terminalSprint(state, extra = {}) {
  return { sprintId: 'sprint-1', live: false, terminal: true, state, history: null, latest: null, ...extra };
}

/** A sink that records every record it was given, verbatim (same shape as sinks.test.mjs's). */
function makeRecordingSink(name = 'recording') {
  const received = [];
  return {
    name,
    received,
    flushed: 0,
    stopped: 0,
    async emit(record) { received.push(record); },
    async flushNow() { this.flushed += 1; },
    async stop() { this.stopped += 1; },
  };
}

/** A sink whose emit() always throws synchronously. */
function makeThrowingSink() {
  return {
    calls: 0,
    emit() {
      this.calls += 1;
      throw new Error('sink boom');
    },
  };
}

function makeFakeAdapter({ commentThrows = false } = {}) {
  const emitProgressCalls = [];
  const commentCalls = [];
  return {
    emitProgressCalls,
    commentCalls,
    async emitProgress(snapshot) { emitProgressCalls.push(snapshot); },
    async comment(markdown) {
      commentCalls.push(markdown);
      if (commentThrows) throw new Error('comment boom');
    },
  };
}

function makeFakeSpool(doc) {
  return { read: async () => doc };
}

const baseDeps = (overrides = {}) => {
  const clock = overrides.clock ?? makeFakeClock();
  return {
    clock,
    now: clock.now,
    sleep: clock.sleep,
    log: overrides.log ?? makeLog(),
    ...overrides,
  };
};

// -- validateWatchOpts ----------------------------------------------------

describe('validateWatchOpts', () => {
  test('requires a non-empty sprintId', () => {
    assert.throws(() => validateWatchOpts({}), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
  });

  test('defaults giveUpMs and logTailLines', () => {
    const o = validateWatchOpts({ sprintId: 's1' });
    assert.strictEqual(o.giveUpMs, DEFAULT_GIVE_UP_MS);
    assert.strictEqual(o.logTailLines, DEFAULT_LOG_TAIL_LINES);
  });

  test('rejects a negative giveUpMs', () => {
    assert.throws(() => validateWatchOpts({ sprintId: 's1', giveUpMs: -1 }), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      return true;
    });
  });

  test('rejects a non-integer logTailLines', () => {
    assert.throws(() => validateWatchOpts({ sprintId: 's1', logTailLines: 1.5 }), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      return true;
    });
  });
});

// -- runWatch: deps validation ---------------------------------------------

describe('runWatch: deps validation', () => {
  test('requires deps.supervisorClient', async () => {
    await assert.rejects(
      runWatch({ sprintId: 's1' }, { sinks: [{ name: 'x', sink: { emit: async () => {} } }], ...baseDeps() }),
      (err) => {
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
        return true;
      }
    );
  });

  test('requires deps.sinks to be an array', async () => {
    const supervisorClient = makeFakeSupervisorClient({ getSprintResponses: [terminalSprint(stateWithPhase('Done'))] });
    await assert.rejects(
      runWatch({ sprintId: 's1' }, { supervisorClient, ...baseDeps() }),
      (err) => {
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
        return true;
      }
    );
  });

  test('requires deps.spool when a shared sink is present', async () => {
    const supervisorClient = makeFakeSupervisorClient({ getSprintResponses: [terminalSprint(stateWithPhase('Done'))] });
    const sinks = [{ name: 'blob', sink: makeRecordingSink('blob'), shared: true }];
    await assert.rejects(
      runWatch({ sprintId: 's1' }, { supervisorClient, sinks, ...baseDeps() }),
      (err) => {
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
        return true;
      }
    );
  });
});

// -- runWatch: the happy path -----------------------------------------------

describe('runWatch: terminal state', () => {
  test('the loop terminates on a terminal state and returns that snapshot', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResponses: [
        liveSprint(stateWithPhase('Plan C1 R1')),
        terminalSprint(stateWithPhase('Publish PR C1')),
      ],
    });
    const local = makeRecordingSink('local');
    const deps = { supervisorClient, sinks: [{ name: 'local', sink: local }], ...baseDeps() };

    const result = await runWatch({ sprintId: 'sprint-1' }, deps);

    assert.strictEqual(result.sprintId, 'sprint-1');
    assert.strictEqual(result.health, 'terminal');
    assert.strictEqual(result.phase, 'Publish PR C1');
    assert.strictEqual(local.received.length, 2);
    assert.strictEqual(local.stopped, 1, 'runWatch must stop the sink fan it created on the way out');
  });
});

describe('runWatch: phase-transition comments', () => {
  test('the comment fires once per phase transition and not per tick', async () => {
    const sameState = () => stateWithPhase('Plan C1 R1');
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResponses: [
        liveSprint(sameState()),
        liveSprint(sameState()),
        liveSprint(sameState()),
        liveSprint(sameState()),
        terminalSprint(stateWithPhase('Publish PR C1')),
      ],
    });
    const adapter = makeFakeAdapter();
    const local = makeRecordingSink('local');
    const deps = { supervisorClient, adapter, sinks: [{ name: 'local', sink: local }], ...baseDeps() };

    await runWatch({ sprintId: 'sprint-1' }, deps);

    // 5 ticks total (4 identical-phase + 1 terminal-with-a-new-phase), but
    // only 2 real phase transitions: the very first announcement, and the
    // move to "Publish PR C1".
    assert.strictEqual(adapter.emitProgressCalls.length, 5, 'emitProgress fires every tick');
    assert.strictEqual(adapter.commentCalls.length, 2, 'comment fires only on phase transitions');
    assert.match(adapter.commentCalls[0], /Plan C1 R1/);
    assert.match(adapter.commentCalls[1], /Publish PR C1/);
  });

  test('buildPhaseComment reports phase, cycle, progress, spend, and health', () => {
    const text = buildPhaseComment({
      phase: 'Develop C2 R1', cycle: 2, closed: 3, required: 10, spendUsd: 4.5, health: 'running', verdict: undefined,
    });
    assert.match(text, /Develop C2 R1/);
    assert.match(text, /\bCycle:\*\* 2\b/);
    assert.match(text, /3\/10/);
    assert.match(text, /\$4\.50/);
    assert.match(text, /running/);
  });
});

describe('runWatch: backoff', () => {
  test('backoff widens 5s -> 10s -> 20s -> 40s', async () => {
    const sameState = () => stateWithPhase('Plan C1 R1');
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResponses: [
        liveSprint(sameState()),
        liveSprint(sameState()),
        liveSprint(sameState()),
        liveSprint(sameState()),
        terminalSprint(stateWithPhase('Done')),
      ],
    });
    const clock = makeFakeClock();
    const deps = { supervisorClient, sinks: [{ name: 'local', sink: makeRecordingSink() }], ...baseDeps({ clock }) };

    await runWatch({ sprintId: 'sprint-1' }, deps);

    assert.deepStrictEqual(clock.sleepCalls, [5000, 10000, 20000, 40000]);
  });
});

describe('runWatch: adapter and sink isolation', () => {
  test('a throwing sink fan does not stop the loop', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResponses: [
        liveSprint(stateWithPhase('Plan C1 R1')),
        terminalSprint(stateWithPhase('Publish PR C1')),
      ],
    });
    const log = makeLog();
    const deps = {
      supervisorClient,
      sinks: [{ name: 'throwy', sink: makeThrowingSink() }],
      ...baseDeps({ log }),
    };

    const result = await runWatch({ sprintId: 'sprint-1' }, deps);
    assert.strictEqual(result.health, 'terminal');
  });

  test('a throwing adapter.comment does not stop the loop', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResponses: [
        liveSprint(stateWithPhase('Plan C1 R1')),
        terminalSprint(stateWithPhase('Publish PR C1')),
      ],
    });
    const adapter = makeFakeAdapter({ commentThrows: true });
    const deps = {
      supervisorClient,
      adapter,
      sinks: [{ name: 'local', sink: makeRecordingSink() }],
      ...baseDeps(),
    };

    const result = await runWatch({ sprintId: 'sprint-1' }, deps);
    assert.strictEqual(result.health, 'terminal');
    assert.strictEqual(adapter.commentCalls.length, 2, 'both transitions were still attempted');
  });
});

describe('runWatch: log-tail fallback', () => {
  test('getSprint failure falls back to the log tail and reports health: unknown', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResponses: [
        throwing(new Error('supervisor unreachable')),
        terminalSprint(stateWithPhase('Done')),
      ],
      getLogResponses: ['line one\nline two\n'],
    });
    const local = makeRecordingSink('local');
    const deps = { supervisorClient, sinks: [{ name: 'local', sink: local }], ...baseDeps() };

    const result = await runWatch({ sprintId: 'sprint-1' }, deps);

    assert.strictEqual(local.received.length, 2);
    assert.strictEqual(local.received[0].health, 'unknown');
    assert.strictEqual(local.received[0].logTail, 'line one\nline two\n');
    assert.strictEqual(supervisorClient.getLogCalls[0].opts.tail, DEFAULT_LOG_TAIL_LINES);
    assert.strictEqual(result.health, 'terminal');
  });

  test('getSprint returning null also falls back to the log tail', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResponses: [null, terminalSprint(stateWithPhase('Done'))],
      getLogResponses: [null],
    });
    const local = makeRecordingSink('local');
    const deps = { supervisorClient, sinks: [{ name: 'local', sink: local }], ...baseDeps() };

    await runWatch({ sprintId: 'sprint-1' }, deps);

    assert.strictEqual(local.received[0].health, 'unknown');
    assert.strictEqual(local.received[0].logTail, null);
  });
});

describe('runWatch: give-up on persistent failure', () => {
  test('a transient failure recovers (the failure clock resets on any successful tick)', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResponses: [
        throwing(new Error('net fail 1')),
        liveSprint(stateWithPhase('Plan C1 R1')),
        throwing(new Error('net fail 2')),
        terminalSprint(stateWithPhase('Done')),
      ],
      getLogResponses: [throwing(new Error('log fail also'))],
    });
    const deps = {
      supervisorClient,
      sinks: [{ name: 'local', sink: makeRecordingSink() }],
      ...baseDeps(),
    };

    // giveUpMs is small enough that a design which failed to reset the
    // failure clock on tick 2's success would incorrectly throw WATCH_LOST
    // on tick 3 (stale firstFailureAt from tick 1, long past giveUpMs by the
    // time the clock has advanced through two backoff sleeps).
    const result = await runWatch({ sprintId: 'sprint-1', giveUpMs: 1000 }, deps);
    assert.strictEqual(result.health, 'terminal');
  });

  test('continuous failure past giveUpMs throws WATCH_LOST', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResponses: [throwing(new Error('always down'))],
      getLogResponses: [throwing(new Error('log always down too'))],
    });
    const deps = {
      supervisorClient,
      sinks: [{ name: 'local', sink: makeRecordingSink() }],
      ...baseDeps(),
    };

    await assert.rejects(
      runWatch({ sprintId: 'sprint-1', giveUpMs: 1000 }, deps),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.WATCH_LOST);
        return true;
      }
    );
  });
});

// -- runWatch: consuming the real facade (not a hand-rolled fake adapter) --
//
// The other tests in this file exercise `deps.adapter` against
// makeFakeAdapter()'s bare-object shape, which is exactly the kind of fake
// that let this verb's `comment(markdown)` assumption diverge from the real
// registry adapter's `comment({resolved, workItemId, body}, {restClient})`
// unnoticed (see facade.mjs's file header). This block proves the fix from
// this verb's side: a REAL createAdapterFacade() instance, wrapping a
// minimal registry-adapter-shaped object, still drives runWatch correctly.

describe('runWatch: consuming the real adapter facade', () => {
  function makeMinimalRegistryAdapter({ canComment = true, commentThrows = false } = {}) {
    const emitProgressCalls = [];
    const commentCalls = [];
    return {
      emitProgressCalls,
      commentCalls,
      capabilities: () => ({ canComment }),
      async emitProgress(snapshot) { emitProgressCalls.push(snapshot); },
      async comment(opts) {
        commentCalls.push(opts);
        if (commentThrows) throw new Error('REST 503');
      },
    };
  }

  test('a facade wrapping the real registry-adapter shape drives the loop end to end', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResponses: [
        liveSprint(stateWithPhase('Plan C1 R1')),
        terminalSprint(stateWithPhase('Publish PR C1')),
      ],
    });
    const registryAdapter = makeMinimalRegistryAdapter();
    const handle = { request: { workItems: ['WI-42'] } };
    const facade = createAdapterFacade({ adapter: registryAdapter, handle, restClient: async () => ({}), log: makeLog() });
    const local = makeRecordingSink('local');
    const deps = { supervisorClient, adapter: facade, sinks: [{ name: 'local', sink: local }], ...baseDeps() };

    const result = await runWatch({ sprintId: 'sprint-1' }, deps);

    assert.strictEqual(result.health, 'terminal');
    assert.strictEqual(registryAdapter.emitProgressCalls.length, 2, 'emitProgress passthrough fires every tick');
    assert.strictEqual(registryAdapter.commentCalls.length, 2, 'one comment per phase transition');
    // The facade resolved the target work item once, from the handle, and
    // used it for every comment -- see facade.mjs's "WORK-ITEM TARGETING".
    assert.ok(registryAdapter.commentCalls.every((c) => c.workItemId === 'WI-42'));
    assert.match(registryAdapter.commentCalls[0].body, /Plan C1 R1/);
    assert.match(registryAdapter.commentCalls[1].body, /Publish PR C1/);
  });

  test('canComment:false makes the facade comment() a no-op, and the loop still completes', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResponses: [
        liveSprint(stateWithPhase('Plan C1 R1')),
        terminalSprint(stateWithPhase('Publish PR C1')),
      ],
    });
    const registryAdapter = makeMinimalRegistryAdapter({ canComment: false });
    const handle = { request: { workItems: ['WI-42'] } };
    const facade = createAdapterFacade({ adapter: registryAdapter, handle, log: makeLog() });
    const deps = { supervisorClient, adapter: facade, sinks: [{ name: 'local', sink: makeRecordingSink() }], ...baseDeps() };

    const result = await runWatch({ sprintId: 'sprint-1' }, deps);

    assert.strictEqual(result.health, 'terminal');
    assert.strictEqual(registryAdapter.commentCalls.length, 0, 'comment() degraded to a no-op, never called the registry adapter');
  });

  test('a REST failure inside the facade comment() is non-fatal to the loop', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResponses: [
        liveSprint(stateWithPhase('Plan C1 R1')),
        terminalSprint(stateWithPhase('Publish PR C1')),
      ],
    });
    const registryAdapter = makeMinimalRegistryAdapter({ commentThrows: true });
    const handle = { request: { workItems: ['WI-42'] } };
    const facade = createAdapterFacade({ adapter: registryAdapter, handle, restClient: async () => ({}), log: makeLog() });
    const deps = { supervisorClient, adapter: facade, sinks: [{ name: 'local', sink: makeRecordingSink() }], ...baseDeps() };

    const result = await runWatch({ sprintId: 'sprint-1' }, deps);

    assert.strictEqual(result.health, 'terminal');
    assert.strictEqual(registryAdapter.commentCalls.length, 2, 'both transitions were still attempted despite the REST failure');
  });
});

describe('runWatch: cooperative cancellation (deps.signal)', () => {
  test('an abort signalled mid-loop (during the backoff sleep) returns the last snapshot promptly, does not throw, does not trip WATCH_LOST, and polls no further', async () => {
    // Never reaches a terminal state on its own -- if the abort-vs-sleep race
    // in sleepInterruptible() did not work, this loop would hang forever on
    // the never-resolving `sleep` below, since nothing else would ever wake
    // it. The test times out (rather than hanging the whole suite) if that
    // regresses.
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResponses: [liveSprint(stateWithPhase('Plan C1 R1'))],
    });
    const local = makeRecordingSink('local');
    const controller = new AbortController();

    let markReachedSleep;
    const reachedSleep = new Promise((resolve) => { markReachedSleep = resolve; });
    const sleep = () => {
      markReachedSleep();
      return new Promise(() => {}); // never resolves on its own
    };

    const deps = {
      supervisorClient,
      sinks: [{ name: 'local', sink: local }],
      signal: controller.signal,
      now: () => 0,
      sleep,
      log: makeLog(),
    };

    const promise = runWatch({ sprintId: 'sprint-1' }, deps);

    // Deterministically wait until the loop has actually reached its backoff
    // sleep (one full tick: getSprint -> snapshot -> sink emit -> phase
    // announce), THEN abort -- this is "mid-loop, during the sleep", not
    // "before the loop started".
    await reachedSleep;
    controller.abort();

    const result = await Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('runWatch did not respond to the abort signal in time')), 2000)),
    ]);

    assert.ok(result, 'the last snapshot obtained before the abort is returned');
    assert.strictEqual(result.sprintId, 'sprint-1');
    assert.notStrictEqual(result.health, 'terminal', 'the sprint never actually finished -- this was an interruption');
    assert.strictEqual(local.received.length, 1, 'exactly the one tick before the abort was emitted');
    assert.strictEqual(supervisorClient.getSprintCalls.length, 1, 'no further polls were issued after the abort');
  });

  test('an already-aborted signal returns immediately without polling at all', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResponses: [liveSprint(stateWithPhase('Plan C1 R1'))],
    });
    const controller = new AbortController();
    controller.abort();
    const clock = makeFakeClock();
    const deps = {
      supervisorClient,
      sinks: [{ name: 'local', sink: makeRecordingSink() }],
      signal: controller.signal,
      ...baseDeps({ clock }),
    };

    const result = await runWatch({ sprintId: 'sprint-1' }, deps);

    assert.strictEqual(result, null, 'no snapshot was ever obtained');
    assert.strictEqual(supervisorClient.getSprintCalls.length, 0, 'getSprint was never called');
    assert.strictEqual(clock.sleepCalls.length, 0, 'no backoff sleep ever happened');
  });

  test('no signal supplied behaves exactly as before (runs to the terminal state)', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResponses: [
        liveSprint(stateWithPhase('Plan C1 R1')),
        terminalSprint(stateWithPhase('Publish PR C1')),
      ],
    });
    const local = makeRecordingSink('local');
    const deps = { supervisorClient, sinks: [{ name: 'local', sink: local }], ...baseDeps() };

    const result = await runWatch({ sprintId: 'sprint-1' }, deps);

    assert.strictEqual(result.health, 'terminal');
    assert.strictEqual(local.received.length, 2);
  });
});

describe('runWatch: the blob-sink gate (single-writer enforcement)', () => {
  test('refuses a shared sink when a live claim exists', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResponses: [terminalSprint(stateWithPhase('Done'))],
    });
    const shared = makeRecordingSink('blob');
    const local = makeRecordingSink('local');
    const spool = makeFakeSpool({ sprintId: 'sprint-1', claim: { pid: 123, host: 'other-host', claimedAt: 'now' } });
    const deps = {
      supervisorClient,
      spool,
      sinks: [
        { name: 'local', sink: local },
        { name: 'blob', sink: shared, shared: true },
      ],
      ...baseDeps(),
    };

    await runWatch({ sprintId: 'sprint-1' }, deps);

    assert.strictEqual(local.received.length, 1, 'local-only sink stays enabled');
    assert.strictEqual(shared.received.length, 0, 'shared sink was never enabled for this run');
  });

  test('permits a shared sink when no live claim exists', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResponses: [terminalSprint(stateWithPhase('Done'))],
    });
    const shared = makeRecordingSink('blob');
    const local = makeRecordingSink('local');
    const spool = makeFakeSpool({ sprintId: 'sprint-1', claim: null });
    const deps = {
      supervisorClient,
      spool,
      sinks: [
        { name: 'local', sink: local },
        { name: 'blob', sink: shared, shared: true },
      ],
      ...baseDeps(),
    };

    await runWatch({ sprintId: 'sprint-1' }, deps);

    assert.strictEqual(local.received.length, 1);
    assert.strictEqual(shared.received.length, 1, 'shared sink is enabled when no claim is live');
  });

  test('permits a shared sink when spool.read() finds no document at all', async () => {
    const supervisorClient = makeFakeSupervisorClient({
      getSprintResponses: [terminalSprint(stateWithPhase('Done'))],
    });
    const shared = makeRecordingSink('blob');
    const spool = makeFakeSpool(undefined);
    const deps = {
      supervisorClient,
      spool,
      sinks: [{ name: 'blob', sink: shared, shared: true }],
      ...baseDeps(),
    };

    await runWatch({ sprintId: 'sprint-1' }, deps);

    assert.strictEqual(shared.received.length, 1);
  });
});
