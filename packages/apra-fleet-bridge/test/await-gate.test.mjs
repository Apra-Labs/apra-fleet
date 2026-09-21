// Tests for src/await-gate.mjs -- a fake supervisor client, a fake clock and
// a fake `sleep` throughout. No real waiting, no real network, no real
// timers: `sleep(ms)` just advances the fake clock's `now()` by `ms`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  awaitMilestone,
  readPlanState,
  collectPhaseTitles,
  describeSpec,
  scrapeVerdictFromLog,
} from '../src/await-gate.mjs';
import { parseAwaitUntil } from '../src/contracts.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AWAIT_GATE_SOURCE_PATH = path.join(__dirname, '..', 'src', 'await-gate.mjs');

// -- fakes --------------------------------------------------------------------

/** A clock where `sleep(ms)` advances `now()` by exactly `ms` -- no real timers. */
function makeFakeClock(startMs = 0) {
  let current = startMs;
  return {
    now: () => current,
    sleep: async (ms) => { current += ms; },
  };
}

/**
 * A fake supervisor client whose `getSprint` returns each entry of
 * `responses` in order, then repeats the last entry forever. Also exposes a
 * `stopSprint` spy so tests can assert it is NEVER called.
 */
function makeFakeSupervisorClient(responses) {
  let index = 0;
  const calls = [];
  const stopCalls = [];
  return {
    calls,
    stopCalls,
    async getSprint(sprintId) {
      calls.push(sprintId);
      const entry = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return typeof entry === 'function' ? entry() : entry;
    },
    async stopSprint(sprintId) {
      stopCalls.push(sprintId);
      return true;
    },
  };
}

function liveSprint(state, extra = {}) {
  return { sprintId: 'sprint-1', live: true, terminal: false, state, history: null, latest: null, ...extra };
}

function terminalSprint(state) {
  return { sprintId: 'sprint-1', live: false, terminal: true, state, history: null, latest: null };
}

function planExtension(fields) {
  return {
    cycle: 1,
    planningRounds: 0,
    status: 'iterating',
    verdict: null,
    approved: false,
    deferredIds: [],
    findings: [],
    notesSummary: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...fields,
  };
}

const HANDLE = { sprintId: 'sprint-1' };

// -- launch: reached immediately, no polling ----------------------------------

describe('launch', () => {
  test('is reached immediately with no supervisor call at all', async () => {
    const client = makeFakeSupervisorClient([]);
    const clock = makeFakeClock();
    const result = await awaitMilestone(HANDLE, parseAwaitUntil('launch'), {
      supervisorClient: client, sleep: clock.sleep, now: clock.now,
    });
    assert.strictEqual(result.outcome, 'reached');
    assert.strictEqual(result.milestone, 'launch');
    assert.strictEqual(client.calls.length, 0);
  });
});

// -- each spec reaches on the right signal ------------------------------------

describe('each spec reaches on its own signal', () => {
  test('plan-round reaches on ANY verdict, including CHANGES_NEEDED', async () => {
    const client = makeFakeSupervisorClient([
      liveSprint({ extensions: { plan: planExtension({ planningRounds: 1, status: 'iterating', verdict: 'CHANGES_NEEDED', approved: false }) } }),
    ]);
    const clock = makeFakeClock();
    const result = await awaitMilestone(HANDLE, parseAwaitUntil('plan-round'), {
      supervisorClient: client, sleep: clock.sleep, now: clock.now,
    }, { timeoutMs: 100000 });
    assert.strictEqual(result.outcome, 'reached');
    assert.strictEqual(result.milestone, 'plan-round');
  });

  test('plan-approved reaches only on a clean APPROVED (approved:true)', async () => {
    const client = makeFakeSupervisorClient([
      liveSprint({ extensions: { plan: planExtension({ planningRounds: 2, status: 'approved', verdict: 'APPROVED', approved: true }) } }),
    ]);
    const clock = makeFakeClock();
    const result = await awaitMilestone(HANDLE, parseAwaitUntil('plan-approved'), {
      supervisorClient: client, sleep: clock.sleep, now: clock.now,
    }, { timeoutMs: 100000 });
    assert.strictEqual(result.outcome, 'reached');
  });

  test('plan-settled reaches on a plan-cap deferral (status:deferred)', async () => {
    const client = makeFakeSupervisorClient([
      liveSprint({ extensions: { plan: planExtension({ status: 'deferred', approved: false, deferredIds: ['bd-1'] }) } }),
    ]);
    const clock = makeFakeClock();
    const result = await awaitMilestone(HANDLE, parseAwaitUntil('plan-settled'), {
      supervisorClient: client, sleep: clock.sleep, now: clock.now,
    }, { timeoutMs: 100000 });
    assert.strictEqual(result.outcome, 'reached');
  });

  test('plan-settled also reaches on a clean approval', async () => {
    const client = makeFakeSupervisorClient([
      liveSprint({ extensions: { plan: planExtension({ status: 'approved', approved: true }) } }),
    ]);
    const clock = makeFakeClock();
    const result = await awaitMilestone(HANDLE, parseAwaitUntil('plan-settled'), {
      supervisorClient: client, sleep: clock.sleep, now: clock.now,
    }, { timeoutMs: 100000 });
    assert.strictEqual(result.outcome, 'reached');
  });

  test('phase:<regex> reaches when a matching phase title appears in state.tree', async () => {
    const tree = [{ title: 'Workflow', phases: [{ title: 'Plan C1 R1' }, { title: 'Develop C1 R1' }] }];
    const client = makeFakeSupervisorClient([liveSprint({ tree })]);
    const clock = makeFakeClock();
    const result = await awaitMilestone(HANDLE, parseAwaitUntil('phase:^Develop'), {
      supervisorClient: client, sleep: clock.sleep, now: clock.now,
    }, { timeoutMs: 100000 });
    assert.strictEqual(result.outcome, 'reached');
    assert.match(result.reason, /Develop C1 R1/);
  });

  test('cycle:N reaches when the published cycle reaches N', async () => {
    const client = makeFakeSupervisorClient([
      liveSprint({ extensions: { plan: planExtension({ cycle: 3 }) } }),
    ]);
    const clock = makeFakeClock();
    const result = await awaitMilestone(HANDLE, parseAwaitUntil('cycle:3'), {
      supervisorClient: client, sleep: clock.sleep, now: clock.now,
    }, { timeoutMs: 100000 });
    assert.strictEqual(result.outcome, 'reached');
  });

  test('cycle:N does not reach on an earlier cycle', async () => {
    const client = makeFakeSupervisorClient([
      liveSprint({ extensions: { plan: planExtension({ cycle: 1 }) } }),
    ]);
    const clock = makeFakeClock();
    const result = await awaitMilestone(HANDLE, parseAwaitUntil('cycle:3'), {
      supervisorClient: client, sleep: clock.sleep, now: clock.now,
    }, { timeoutMs: 10000, pollMs: 5000 });
    assert.strictEqual(result.outcome, 'timeout');
  });
});

// -- plan-round vs plan-approved on the SAME data -----------------------------

describe('plan-round fires while plan-approved keeps waiting', () => {
  const sameData = () => liveSprint({
    extensions: { plan: planExtension({ planningRounds: 1, status: 'iterating', verdict: 'CHANGES_NEEDED', approved: false }) },
  });

  test('plan-round: reached on the CHANGES_NEEDED round', async () => {
    const client = makeFakeSupervisorClient([sameData()]);
    const clock = makeFakeClock();
    const result = await awaitMilestone(HANDLE, parseAwaitUntil('plan-round'), {
      supervisorClient: client, sleep: clock.sleep, now: clock.now,
    }, { timeoutMs: 100000 });
    assert.strictEqual(result.outcome, 'reached');
  });

  test('plan-approved: NOT reached on the same CHANGES_NEEDED round -- keeps waiting until timeout', async () => {
    const client = makeFakeSupervisorClient([sameData()]);
    const clock = makeFakeClock();
    const result = await awaitMilestone(HANDLE, parseAwaitUntil('plan-approved'), {
      supervisorClient: client, sleep: clock.sleep, now: clock.now,
    }, { timeoutMs: 10000, pollMs: 5000 });
    assert.strictEqual(result.outcome, 'timeout');
    assert.ok(client.calls.length >= 2, 'must have polled more than once while waiting');
  });
});

// -- plan-approved must not be satisfied by a plan-cap deferral ---------------

describe('plan-approved vs plan-cap deferral (the entire reason the channel exists)', () => {
  test('a deferral (status:deferred, approved:false) does NOT satisfy plan-approved', async () => {
    const client = makeFakeSupervisorClient([
      liveSprint({ extensions: { plan: planExtension({ status: 'deferred', approved: false, deferredIds: ['bd-1', 'bd-2'] }) } }),
    ]);
    const clock = makeFakeClock();
    const result = await awaitMilestone(HANDLE, parseAwaitUntil('plan-approved'), {
      supervisorClient: client, sleep: clock.sleep, now: clock.now,
    }, { timeoutMs: 10000, pollMs: 5000 });
    assert.strictEqual(result.outcome, 'timeout');
  });
});

// -- phase: regex that never matches -----------------------------------------

describe('phase: a non-matching regex', () => {
  test('times out green and reports the phase titles actually observed', async () => {
    const client = makeFakeSupervisorClient([
      liveSprint({ tree: [{ title: 'Workflow', phases: [{ title: 'Plan C1 R1' }] }] }),
      liveSprint({ tree: [{ title: 'Workflow', phases: [{ title: 'Develop C1 R1' }] }] }),
    ]);
    const clock = makeFakeClock();
    const result = await awaitMilestone(HANDLE, parseAwaitUntil('phase:^Publish PR'), {
      supervisorClient: client, sleep: clock.sleep, now: clock.now,
    }, { timeoutMs: 12000, pollMs: 5000 });

    assert.strictEqual(result.outcome, 'timeout');
    assert.match(result.reason, /not reached, now detached/);
    assert.match(result.reason, /Plan C1 R1/);
    assert.match(result.reason, /Develop C1 R1/);
  });

  test('a non-matching regex with NO phases observed at all still reports cleanly', async () => {
    const client = makeFakeSupervisorClient([liveSprint({ tree: [] })]);
    const clock = makeFakeClock();
    const result = await awaitMilestone(HANDLE, parseAwaitUntil('phase:^Nope'), {
      supervisorClient: client, sleep: clock.sleep, now: clock.now,
    }, { timeoutMs: 1000, pollMs: 5000 });
    assert.strictEqual(result.outcome, 'timeout');
    assert.match(result.reason, /no phase titles were observed/);
  });
});

// -- terminal before milestone -------------------------------------------------

describe('terminal before the milestone', () => {
  test('is red, with the engine reason carried VERBATIM', async () => {
    const engineReason = "NOTHING_TO_DO: work item 'WI-99' has no children";
    const client = makeFakeSupervisorClient([
      terminalSprint({ terminalReason: engineReason }),
    ]);
    const clock = makeFakeClock();
    const result = await awaitMilestone(HANDLE, parseAwaitUntil('plan-approved'), {
      supervisorClient: client, sleep: clock.sleep, now: clock.now,
    }, { timeoutMs: 100000 });
    assert.strictEqual(result.outcome, 'terminal');
    assert.strictEqual(result.reason, engineReason, 'the reason must be byte-identical, not reworded');
  });

  test('falls back to a generic reason when the terminal state carries none', async () => {
    const client = makeFakeSupervisorClient([terminalSprint({})]);
    const clock = makeFakeClock();
    const result = await awaitMilestone(HANDLE, parseAwaitUntil('plan-approved'), {
      supervisorClient: client, sleep: clock.sleep, now: clock.now,
    }, { timeoutMs: 100000 });
    assert.strictEqual(result.outcome, 'terminal');
    assert.strictEqual(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
  });

  test('a milestone satisfied on the SAME read that is also terminal counts as reached, not terminal', async () => {
    const client = makeFakeSupervisorClient([
      { sprintId: 'sprint-1', live: false, terminal: true, state: { extensions: { plan: planExtension({ status: 'approved', approved: true }), terminalReason: 'FINISHED' } }, history: null, latest: null },
    ]);
    const clock = makeFakeClock();
    const result = await awaitMilestone(HANDLE, parseAwaitUntil('plan-approved'), {
      supervisorClient: client, sleep: clock.sleep, now: clock.now,
    }, { timeoutMs: 100000 });
    assert.strictEqual(result.outcome, 'reached');
  });
});

// -- timeout NEVER stops the sprint --------------------------------------------

describe('timeout never stops the sprint', () => {
  test('after a timeout, the supervisor client stop spy has zero calls', async () => {
    const client = makeFakeSupervisorClient([
      liveSprint({ extensions: { plan: planExtension({ status: 'iterating' }) } }),
    ]);
    const clock = makeFakeClock();
    const result = await awaitMilestone(HANDLE, parseAwaitUntil('plan-approved'), {
      supervisorClient: client, sleep: clock.sleep, now: clock.now,
    }, { timeoutMs: 20000, pollMs: 5000 });

    assert.strictEqual(result.outcome, 'timeout');
    assert.strictEqual(result.reason.includes('milestone not reached, now detached') || result.reason.startsWith("milestone '"), true);
    assert.strictEqual(client.stopCalls.length, 0, 'awaitMilestone must never call stopSprint');
  });

  test('awaitMilestone exposes no stop/cancel API of its own', () => {
    assert.strictEqual(typeof awaitMilestone.stop, 'undefined');
    assert.strictEqual(typeof awaitMilestone.cancel, 'undefined');
  });
});

// -- backoff: poll interval grows without exceeding the ceiling ---------------

describe('backoff', () => {
  test('sleeps are called with a growing, capped interval', async () => {
    const sleepCalls = [];
    const client = makeFakeSupervisorClient([
      liveSprint({ extensions: { plan: planExtension({ status: 'iterating' }) } }),
    ]);
    let current = 0;
    const now = () => current;
    const sleep = async (ms) => { sleepCalls.push(ms); current += ms; };

    await awaitMilestone(HANDLE, parseAwaitUntil('plan-approved'), {
      supervisorClient: client, sleep, now,
    }, { timeoutMs: 200000, pollMs: 5000 });

    assert.ok(sleepCalls.length >= 2);
    assert.strictEqual(sleepCalls[0], 5000);
    for (let i = 1; i < sleepCalls.length; i += 1) {
      assert.ok(sleepCalls[i] >= sleepCalls[i - 1], 'poll interval must never shrink');
      assert.ok(sleepCalls[i] <= 60000, 'poll interval must never exceed the 60s ceiling');
    }
  });
});

// -- readPlanState: engine channel preferred, log-tail fallback, degrade -----

describe('readPlanState', () => {
  test('prefers state.extensions.plan verbatim, and never calls the log fetcher when it is present', async () => {
    let fetchCalled = false;
    const plan = planExtension({ status: 'approved', approved: true });
    const state = { extensions: { plan } };
    const result = await readPlanState(state, { sprintId: 'x', fetchLogTail: async () => { fetchCalled = true; return ''; } });
    assert.deepStrictEqual(result, plan);
    assert.strictEqual(fetchCalled, false);
  });

  test('falls back to scraping the log tail when the engine channel is absent', async () => {
    const result = await readPlanState({}, {
      sprintId: 'x',
      fetchLogTail: async () => 'plan-reviewer round 2 verdict: APPROVED\n',
    });
    assert.ok(result);
    assert.strictEqual(result.approved, true);
    assert.strictEqual(result.status, 'approved');
  });

  test('degrades to null (not a throw) when there is no channel and no fetcher', async () => {
    const result = await readPlanState({}, {});
    assert.strictEqual(result, null);
  });

  test('degrades to null when the fetcher itself throws', async () => {
    const result = await readPlanState(null, { fetchLogTail: async () => { throw new Error('network down'); } });
    assert.strictEqual(result, null);
  });

  test('degrades to null when the log tail has no recognizable verdict', async () => {
    const result = await readPlanState({}, { fetchLogTail: async () => 'nothing interesting here\n' });
    assert.strictEqual(result, null);
  });
});

// -- small pure helpers ---------------------------------------------------------

describe('collectPhaseTitles', () => {
  test('walks groups -> phases -> title', () => {
    const tree = [
      { title: 'Workflow', phases: [{ title: 'Plan C1 R1' }, { title: 'Develop C1 R1' }] },
      { title: 'Workflow', phases: [{ title: 'Publish PR C1' }] },
    ];
    assert.deepStrictEqual(collectPhaseTitles(tree), ['Plan C1 R1', 'Develop C1 R1', 'Publish PR C1']);
  });

  test('tolerates a malformed or missing tree', () => {
    assert.deepStrictEqual(collectPhaseTitles(undefined), []);
    assert.deepStrictEqual(collectPhaseTitles(null), []);
    assert.deepStrictEqual(collectPhaseTitles([{ title: 'no phases key' }]), []);
    assert.deepStrictEqual(collectPhaseTitles([{ phases: [null, { notATitle: 1 }, { title: 'ok' }] }]), ['ok']);
  });
});

describe('describeSpec', () => {
  test('renders every kind back to its canonical string', () => {
    assert.strictEqual(describeSpec(parseAwaitUntil('launch')), 'launch');
    assert.strictEqual(describeSpec(parseAwaitUntil('plan-round')), 'plan-round');
    assert.strictEqual(describeSpec(parseAwaitUntil('plan-approved')), 'plan-approved');
    assert.strictEqual(describeSpec(parseAwaitUntil('plan-settled')), 'plan-settled');
    assert.strictEqual(describeSpec(parseAwaitUntil('phase:^Develop')), 'phase:^Develop');
    assert.strictEqual(describeSpec(parseAwaitUntil('cycle:5')), 'cycle:5');
  });
});

describe('scrapeVerdictFromLog', () => {
  test('recognizes an APPROVED verdict', () => {
    const result = scrapeVerdictFromLog('some log noise\nverdict: APPROVED\nmore noise');
    assert.deepStrictEqual(result, { status: 'approved', verdict: 'APPROVED', approved: true });
  });

  test('recognizes a CHANGES_NEEDED verdict', () => {
    const result = scrapeVerdictFromLog('plan-reviewer verdict = CHANGES_NEEDED');
    assert.deepStrictEqual(result, { status: 'iterating', verdict: 'CHANGES_NEEDED', approved: false });
  });

  test('returns null for text with no recognizable verdict', () => {
    assert.strictEqual(scrapeVerdictFromLog('nothing here'), null);
    assert.strictEqual(scrapeVerdictFromLog(''), null);
    assert.strictEqual(scrapeVerdictFromLog(null), null);
  });
});

// -- FIX 1: every constructor-boundary throw is a BridgeError, never a raw
// TypeError/Error, so it never falls into exitCodeFor's exit-1 catch-all --------

describe('awaitMilestone() argument/dependency validation raises BridgeError, not a raw Error', () => {
  function assertBridgeError(code) {
    return (err) => {
      assert.ok(err instanceof BridgeError, `expected a BridgeError, got ${err && err.constructor && err.constructor.name}`);
      assert.strictEqual(err.code, code);
      return true;
    };
  }

  test('missing handle.sprintId -> CONFIG_INVALID', async () => {
    const clock = makeFakeClock();
    await assert.rejects(
      () => awaitMilestone({}, parseAwaitUntil('launch'), { sleep: clock.sleep, now: clock.now }),
      assertBridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID)
    );
  });

  test('missing/invalid spec -> CONFIG_INVALID', async () => {
    const clock = makeFakeClock();
    await assert.rejects(
      () => awaitMilestone(HANDLE, null, { sleep: clock.sleep, now: clock.now }),
      assertBridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID)
    );
  });

  test('missing deps.sleep -> CONFIG_MISSING', async () => {
    const clock = makeFakeClock();
    await assert.rejects(
      () => awaitMilestone(HANDLE, parseAwaitUntil('launch'), { now: clock.now }),
      assertBridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING)
    );
  });

  test('missing deps.now -> CONFIG_MISSING', async () => {
    const clock = makeFakeClock();
    await assert.rejects(
      () => awaitMilestone(HANDLE, parseAwaitUntil('launch'), { sleep: clock.sleep }),
      assertBridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING)
    );
  });

  test('missing deps.supervisorClient.getSprint (non-launch spec) -> CONFIG_MISSING', async () => {
    const clock = makeFakeClock();
    await assert.rejects(
      () => awaitMilestone(HANDLE, parseAwaitUntil('plan-approved'), { sleep: clock.sleep, now: clock.now }),
      assertBridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING)
    );
  });
});

// -- FIX 5: source-scan guard against ambient I/O sneaking into await-gate.mjs --
// Equivalent to adapters.test.mjs's guard over the adapter modules. Every
// collaborator await-gate.mjs needs (supervisor client, sleep, now, log
// fetcher) is injected via `deps`; the only imports this module is allowed
// are `./errors.mjs` for the BridgeError taxonomy and `./throttle.mjs` for
// the shared `createBackoff` poll-interval schedule (FIX 2 -- reused rather
// than reimplemented, the same way watch.mjs and append-blob.mjs reuse it).
// Both are pure, no-I/O modules, so this guard's actual intent (no ambient
// I/O) still holds with the second import allowed.

describe('source-scan guard (FIX 5)', () => {
  const ALLOWED_AWAIT_GATE_IMPORTS = ['./errors.mjs', './throttle.mjs'];

  test('await-gate.mjs imports only from the explicit allowlist', () => {
    const src = readFileSync(AWAIT_GATE_SOURCE_PATH, 'utf-8');
    const specifiers = [...src.matchAll(/^import\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"];?\s*$/gm)].map((m) => m[1]);
    assert.ok(specifiers.length > 0, 'sanity check: the import scan must find at least one import');
    for (const spec of specifiers) {
      assert.ok(
        ALLOWED_AWAIT_GATE_IMPORTS.includes(spec),
        `await-gate.mjs imports an unexpected module "${spec}" -- must be one of: ${ALLOWED_AWAIT_GATE_IMPORTS.join(', ')}`
      );
    }
  });

  test('await-gate.mjs never reads process.env, imports a real node:fs, or calls fetch directly', () => {
    const src = readFileSync(AWAIT_GATE_SOURCE_PATH, 'utf-8');
    assert.ok(!/process\.env[.[]/.test(src), 'await-gate.mjs must not read process.env');
    assert.ok(
      !/from ['"]node:fs['"]/.test(src) && !/require\(['"]node:fs['"]\)/.test(src),
      'await-gate.mjs must not import a real node:fs'
    );
    assert.ok(
      !/globalThis\.fetch\s*\(/.test(src) && !/(?<![.\w])fetch\s*\(/.test(src),
      'await-gate.mjs must not call fetch directly'
    );
  });
});
