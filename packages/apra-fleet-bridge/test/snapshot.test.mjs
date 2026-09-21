// Tests for src/snapshot.mjs -- pure, no I/O, no fakes needed beyond plain
// data. Covers: a realistic leaned sprint state (including a missing
// `extensions.beads`), an unknown phase title (no throw, `cycle: null`),
// an empty tree, a terminal record's verdict, and `phaseChanged` across a
// Plan -> Develop transition.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  currentPhase,
  parseCycleFromTitle,
  phaseChanged,
  toProgressSnapshot,
  verdictFromSprint,
  prUrlFromSprint,
  spendUsdFromSprint,
  UNKNOWN_PHASE,
} from '../src/snapshot.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';
// throttle.mjs has no dedicated test file in this package's file list (only
// snapshot.test.mjs and sinks.test.mjs were commissioned); since throttle.mjs
// is a thin, PURE consumer of this module's phaseChanged() (createPhaseGate
// wraps it directly) and createBackoff() has no dependency on snapshot.mjs at
// all, its coverage lives here rather than inventing an uncommissioned file.
import { createBackoff, createPhaseGate } from '../src/throttle.mjs';
// Imported so the beads-progress tests below assert against the REAL
// reduction (same function toProgressSnapshot() calls internally), rather
// than a hand-duplicated expectation that could silently drift from it.
import { computeSprintProgress } from '@apralabs/apra-fleet-se/fleet-sprint/sprint-progress.mjs';

function makeSprint({ state, sprintId = 'sprint-1', live = true, terminal = false, latest } = {}) {
  return { sprintId, live, terminal, state, history: null, latest: latest ?? null };
}

function phaseObj(title, { startedAt = '2026-09-19T00:00:00.000Z', endedAt = null } = {}) {
  return { title, phaseStartedAt: startedAt, phaseEndedAt: endedAt };
}

// -- parseCycleFromTitle ------------------------------------------------------

describe('parseCycleFromTitle', () => {
  test('extracts the cycle number from realistic titles', () => {
    assert.equal(parseCycleFromTitle('Plan C1 R1'), 1);
    assert.equal(parseCycleFromTitle('Develop C2 R1'), 2);
    assert.equal(parseCycleFromTitle('Publish PR C1'), 1);
  });

  test('returns null (never throws) for an unrecognised title', () => {
    assert.equal(parseCycleFromTitle('Some Brand New Phase Nobody Has Seen'), null);
  });

  test('returns null for non-string input', () => {
    assert.equal(parseCycleFromTitle(undefined), null);
    assert.equal(parseCycleFromTitle(null), null);
    assert.equal(parseCycleFromTitle(42), null);
  });
});

// -- currentPhase --------------------------------------------------------------

describe('currentPhase', () => {
  test('walks to the last group\'s last phase', () => {
    const state = {
      tree: [
        { title: 'Cycle 1', phases: [phaseObj('Plan C1 R1', { endedAt: '2026-09-19T00:10:00.000Z' })] },
        { title: 'Cycle 2', phases: [phaseObj('Develop C2 R1')] },
      ],
    };
    const phase = currentPhase(state);
    assert.deepEqual(phase, {
      title: 'Develop C2 R1',
      cycle: 2,
      startedAt: '2026-09-19T00:00:00.000Z',
      endedAt: null,
    });
  });

  test('an unknown phase title does not throw; cycle is null', () => {
    const state = { tree: [{ title: 'g', phases: [phaseObj('Something Entirely New')] }] };
    assert.doesNotThrow(() => currentPhase(state));
    const phase = currentPhase(state);
    assert.equal(phase.title, 'Something Entirely New');
    assert.equal(phase.cycle, null);
  });

  test('phaseEndedAt !== null means the phase already finished', () => {
    const state = { tree: [{ title: 'g', phases: [phaseObj('Plan C1 R1', { endedAt: '2026-09-19T00:05:00.000Z' })] }] };
    assert.equal(currentPhase(state).endedAt, '2026-09-19T00:05:00.000Z');
  });

  test('an empty tree returns null', () => {
    assert.equal(currentPhase({ tree: [] }), null);
  });

  test('no tree at all returns null', () => {
    assert.equal(currentPhase({}), null);
    assert.equal(currentPhase(null), null);
    assert.equal(currentPhase(undefined), null);
  });

  test('a group with no phases returns null', () => {
    assert.equal(currentPhase({ tree: [{ title: 'g', phases: [] }] }), null);
    assert.equal(currentPhase({ tree: [{ title: 'g' }] }), null);
  });

  test('a last phase missing a title returns null', () => {
    assert.equal(currentPhase({ tree: [{ title: 'g', phases: [{ phaseStartedAt: 'x' }] }] }), null);
  });
});

// -- phaseChanged --------------------------------------------------------------

describe('phaseChanged', () => {
  test('Plan -> Develop counts as a change', () => {
    const prev = { phase: 'Plan C1 R1', cycle: 1 };
    const next = { phase: 'Develop C1 R1', cycle: 1 };
    assert.equal(phaseChanged(prev, next), true);
  });

  test('same title, same cycle is not a change', () => {
    const snap = { phase: 'Plan C1 R1', cycle: 1 };
    assert.equal(phaseChanged(snap, { ...snap }), false);
  });

  test('same title, different cycle IS a change', () => {
    assert.equal(phaseChanged({ phase: 'Plan', cycle: 1 }, { phase: 'Plan', cycle: 2 }), true);
  });

  test('null -> non-null and non-null -> null both count as a change', () => {
    const snap = { phase: 'Plan C1 R1', cycle: 1 };
    assert.equal(phaseChanged(null, snap), true);
    assert.equal(phaseChanged(snap, null), true);
    assert.equal(phaseChanged(null, null), false);
    assert.equal(phaseChanged(undefined, undefined), false);
  });

  test('also accepts currentPhase()-shaped objects (title/cycle) not just snapshots (phase/cycle)', () => {
    assert.equal(phaseChanged({ title: 'Plan C1 R1', cycle: 1 }, { title: 'Develop C1 R1', cycle: 1 }), true);
    assert.equal(phaseChanged({ title: 'Plan C1 R1', cycle: 1 }, { title: 'Plan C1 R1', cycle: 1 }), false);
  });
});

// -- toProgressSnapshot ---------------------------------------------------------

describe('toProgressSnapshot', () => {
  test('derives a full snapshot from a realistic leaned state, missing extensions.beads', () => {
    const sprint = makeSprint({
      sprintId: 'sprint-42',
      live: true,
      terminal: false,
      state: {
        tree: [{ title: 'Cycle 1', phases: [phaseObj('Develop C1 R1')] }],
        stats: { totalCost: 12.5, activitiesCount: 7, totalTokens: 1000 },
        // extensions present, but WITHOUT a beads key -- must not throw and
        // must leave closed/required/fraction undefined.
        extensions: { plan: { status: 'approved' } },
        updatedAt: '2026-09-19T01:00:00.000Z',
      },
    });

    const snapshot = toProgressSnapshot(sprint);
    assert.equal(snapshot.sprintId, 'sprint-42');
    assert.equal(snapshot.phase, 'Develop C1 R1');
    assert.equal(snapshot.cycle, 1);
    assert.equal(snapshot.health, 'running');
    assert.equal(snapshot.closed, undefined);
    assert.equal(snapshot.required, undefined);
    assert.equal(snapshot.fraction, undefined);
    assert.equal(snapshot.spendUsd, 12.5);
    assert.equal(snapshot.verdict, undefined);
    assert.equal(snapshot.updatedAt, Date.parse('2026-09-19T01:00:00.000Z'));
  });

  // The engine's real publishState('beads', payload) shape is
  // `{sprintTasks, backlogTasks?, goalMax, decomposedParentIds}` -- it never
  // carries closed/required/fraction directly. toProgressSnapshot() must
  // derive those via computeSprintProgress(), the same reduction the sprint
  // dashboard embeds, so the two can never independently drift.
  test('derives closed/required/fraction from extensions.beads.sprintTasks via computeSprintProgress', () => {
    const sprintTasks = [
      { id: 'b1', status: 'closed', priority: 1 },
      { id: 'b2', status: 'open', priority: 1 },
    ];
    const sprint = makeSprint({
      state: {
        tree: [{ title: 'Cycle 1', phases: [phaseObj('Develop C1 R1')] }],
        extensions: { beads: { sprintTasks, goalMax: 2, decomposedParentIds: [] } },
      },
    });
    const snapshot = toProgressSnapshot(sprint);
    const expected = computeSprintProgress(sprintTasks, { goalMax: 2, decomposedParentIds: [] });
    assert.equal(snapshot.closed, expected.closed);
    assert.equal(snapshot.required, expected.required);
    assert.equal(snapshot.fraction, expected.fraction);
    // Pin the actual numbers too, so a change to computeSprintProgress's
    // own behavior is visible here, not just "still agrees with itself".
    assert.equal(snapshot.closed, 1);
    assert.equal(snapshot.required, 2);
    assert.equal(snapshot.fraction, 0.5);
  });

  test('applies goalMax and decomposedParentIds filtering -- ignoring them would give a different answer', () => {
    const sprintTasks = [
      { id: 'b1', status: 'closed', priority: 1 },
      { id: 'b2', status: 'closed', priority: 1 },
      { id: 'b3', status: 'open', priority: 1 },
      { id: 'b4', status: 'closed', priority: 3 }, // above goalMax -- must be excluded
      { id: 'parent1', status: 'open', priority: 1 }, // a decomposed parent -- must be excluded
    ];
    const goalMax = 2;
    const decomposedParentIds = ['parent1'];
    const sprint = makeSprint({
      state: {
        tree: [{ title: 'Cycle 1', phases: [phaseObj('Develop C1 R1')] }],
        extensions: { beads: { sprintTasks, goalMax, decomposedParentIds } },
      },
    });

    const snapshot = toProgressSnapshot(sprint);
    const filtered = computeSprintProgress(sprintTasks, { goalMax, decomposedParentIds });
    const unfiltered = computeSprintProgress(sprintTasks);

    // Sanity check that the fixture actually exercises the filter: ignoring
    // opts must produce a different result than applying them.
    assert.notEqual(filtered.required, unfiltered.required);
    assert.notEqual(filtered.fraction, unfiltered.fraction);

    assert.equal(snapshot.closed, filtered.closed);
    assert.equal(snapshot.required, filtered.required);
    assert.equal(snapshot.fraction, filtered.fraction);
    assert.equal(snapshot.closed, 2);
    assert.equal(snapshot.required, 3);
  });

  test('missing extensions.beads.sprintTasks does not throw and yields the empty-list reduction', () => {
    const sprint = makeSprint({
      state: {
        tree: [{ title: 'Cycle 1', phases: [phaseObj('Develop C1 R1')] }],
        extensions: { beads: { goalMax: 2, decomposedParentIds: [] } },
      },
    });
    assert.doesNotThrow(() => toProgressSnapshot(sprint));
    const snapshot = toProgressSnapshot(sprint);
    const expected = computeSprintProgress(undefined, { goalMax: 2, decomposedParentIds: [] });
    assert.equal(snapshot.closed, expected.closed);
    assert.equal(snapshot.required, expected.required);
    assert.equal(snapshot.fraction, expected.fraction);
  });

  test('a non-array sprintTasks does not throw and yields the empty-list reduction', () => {
    const sprint = makeSprint({
      state: {
        tree: [{ title: 'Cycle 1', phases: [phaseObj('Develop C1 R1')] }],
        extensions: { beads: { sprintTasks: 'not-an-array', goalMax: 2 } },
      },
    });
    assert.doesNotThrow(() => toProgressSnapshot(sprint));
    const snapshot = toProgressSnapshot(sprint);
    assert.equal(snapshot.closed, 0);
    assert.equal(snapshot.required, 0);
    assert.equal(snapshot.fraction, 0);
  });

  test('an entirely empty tree still produces a valid snapshot (unknown phase, cycle 0)', () => {
    const sprint = makeSprint({ state: { tree: [] } });
    const snapshot = toProgressSnapshot(sprint);
    assert.equal(snapshot.phase, UNKNOWN_PHASE);
    assert.equal(snapshot.cycle, 0);
  });

  test('never throws on an unrecognised phase title -- cycle falls back to 0', () => {
    const sprint = makeSprint({ state: { tree: [{ title: 'g', phases: [phaseObj('A Phase From The Future')] }] } });
    assert.doesNotThrow(() => toProgressSnapshot(sprint));
    const snapshot = toProgressSnapshot(sprint);
    assert.equal(snapshot.phase, 'A Phase From The Future');
    assert.equal(snapshot.cycle, 0);
  });

  test('pulls verdict from a historical terminal record (sprint.latest)', () => {
    const sprint = makeSprint({
      live: false,
      terminal: true,
      state: { tree: [], updatedAt: '2026-09-19T02:00:00.000Z' },
      latest: { sprintId: 'sprint-42', event: 'FINISHED', terminalReason: 'DONE', verdict: 'PASS', at: '2026-09-19T02:00:00.000Z' },
    });
    const snapshot = toProgressSnapshot(sprint);
    assert.equal(snapshot.verdict, 'PASS');
    assert.equal(snapshot.health, 'terminal');
  });

  test('falls back to state.result.verdict when there is no sprint.latest', () => {
    const sprint = makeSprint({
      terminal: true,
      state: { tree: [], result: { verdict: 'FAIL', prUrl: 'https://example.invalid/pr/1' } },
    });
    assert.equal(toProgressSnapshot(sprint).verdict, 'FAIL');
  });

  test('falls back to a bare state.verdict when neither sprint.latest nor state.result exist', () => {
    const sprint = makeSprint({ terminal: true, state: { tree: [], verdict: 'PASS' } });
    assert.equal(toProgressSnapshot(sprint).verdict, 'PASS');
  });

  test('a sprint still running has no verdict', () => {
    const sprint = makeSprint({ live: true, terminal: false, state: { tree: [] } });
    assert.equal(toProgressSnapshot(sprint).verdict, undefined);
    assert.equal(toProgressSnapshot(sprint).health, 'running');
  });

  test('an entirely absent state does not throw', () => {
    const sprint = makeSprint({ state: undefined });
    assert.doesNotThrow(() => toProgressSnapshot(sprint));
    const snapshot = toProgressSnapshot(sprint);
    assert.equal(snapshot.phase, UNKNOWN_PHASE);
    assert.equal(snapshot.updatedAt, 0);
  });

  test('missing sprintId is a genuinely malformed input -- CONFIG_INVALID, not a swallowed default', () => {
    let caught;
    try {
      toProgressSnapshot({ live: true, terminal: false, state: { tree: [] } });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof BridgeError);
    assert.equal(caught.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });
});

// -- toProgressSnapshot: getSprint()'s third shape (history-only, no `state`) --
// The real incident this task fixes: a prior pass wrongly assumed the
// supervisor 404s once a sprint's process exits. Verified live instead: it
// answers 200 with `{live:false, history, latest}` and NO `state`/`terminal`
// at all -- a shape toProgressSnapshot() never recognised, so it fell all
// the way through to health:'unknown', erasing a real, structured failure.
// This fixture is the REAL response body captured from the live supervisor
// for sprint ado_toy-e3z-1fbb61f0-5d7c-493a-b8a9-f5dfa86a0367 (trimmed of
// nothing but repeated boilerplate fields), not a hand-abridged guess.
describe('toProgressSnapshot: history-only shape (getSprint 200, no state)', () => {
  const CHILD_EXITED_EVENT = {
    sprintId: 'ado_toy-e3z-1fbb61f0-5d7c-493a-b8a9-f5dfa86a0367',
    event: 'child-exited',
    reason: null,
    by: null,
    members: [],
    issueRoots: [],
    at: '2026-09-21T03:24:49.597Z',
    exitCode: 1,
    signal: null,
    logPath: 'C:\\Users\\runner\\.apra-fleet-se\\logs\\ado_toy-e3z-1fbb61f0-5d7c-493a-b8a9-f5dfa86a0367.log',
    terminalReason: null,
    verdict: null,
  };
  const FINISHED_EVENT = {
    sprintId: 'ado_toy-e3z-1fbb61f0-5d7c-493a-b8a9-f5dfa86a0367',
    event: 'finished',
    reason: null,
    by: null,
    members: [],
    issueRoots: [],
    at: '2026-09-21T03:24:50.020Z',
    exitCode: null,
    signal: null,
    logPath: null,
    terminalReason: "[Sync] G-pull fetch failed for member 'aztoy': [Command Failed] Exit code 128: Exit code: 128\n"
      + '[stderr]\n'
      + "fatal: Authentication failed for 'https://dev.azure.com/apralabs/e2e-fleet-testing/_git/fleet-e2e-toy/'\n",
    verdict: 'ABORTED',
  };
  const AUTO_RELEASED_EVENT = {
    sprintId: 'ado_toy-e3z-1fbb61f0-5d7c-493a-b8a9-f5dfa86a0367',
    event: 'auto-released',
    reason: 'watchdog: classified finished (exited 1 at 2026-09-21T03:24:49.597Z)',
    by: null,
    members: ['aztoy'],
    issueRoots: ['ado_toy-e3z'],
    at: '2026-09-21T03:24:50.022Z',
    exitCode: null,
    signal: null,
    logPath: null,
    terminalReason: null,
    verdict: null,
  };
  const REAL_LIVE_PAYLOAD = {
    sprintId: 'ado_toy-e3z-1fbb61f0-5d7c-493a-b8a9-f5dfa86a0367',
    live: false,
    terminal: false,
    state: null,
    history: [CHILD_EXITED_EVENT, FINISHED_EVENT, AUTO_RELEASED_EVENT],
    latest: AUTO_RELEASED_EVENT,
  };

  test('the real captured payload: terminal, verbatim reason, verdict, exitCode and logPath all surfaced', () => {
    const snapshot = toProgressSnapshot(REAL_LIVE_PAYLOAD);
    assert.equal(snapshot.sprintId, 'ado_toy-e3z-1fbb61f0-5d7c-493a-b8a9-f5dfa86a0367');
    assert.equal(snapshot.health, 'terminal');
    assert.equal(snapshot.verdict, 'ABORTED');
    // Verbatim: a literal substring of the engine's own terminalReason, not
    // this package's paraphrase, and not `latest`'s own supervisor-authored
    // "watchdog: classified finished (...)" text.
    assert.equal(snapshot.reason, FINISHED_EVENT.terminalReason);
    assert.ok(!snapshot.reason.includes('watchdog: classified'));
    assert.equal(snapshot.exitCode, 1);
    assert.equal(snapshot.logPath, CHILD_EXITED_EVENT.logPath);
    assert.equal(snapshot.cycle, null);
    assert.equal(snapshot.phase, UNKNOWN_PHASE);
    // updatedAt comes from `latest.at` (the auto-released event), the
    // chronologically last thing that happened, not the 'finished' event's
    // own earlier timestamp.
    assert.equal(snapshot.updatedAt, Date.parse(AUTO_RELEASED_EVENT.at));
    assert.ok(Object.isFrozen(snapshot));
  });

  test('a live sprint (getSprint 200, state present) is completely unaffected by this branch', () => {
    const sprint = makeSprint({
      sprintId: 'sprint-live',
      live: true,
      terminal: false,
      state: { tree: [{ title: 'g', phases: [phaseObj('Develop C1 R1')] }], updatedAt: '2026-09-19T01:00:00.000Z' },
      // A live sprint's normalised shape always carries history:null,
      // latest:null (makeSprint()'s default) -- confirming their mere
      // presence never overrides a `state` that IS present.
    });
    const snapshot = toProgressSnapshot(sprint);
    assert.equal(snapshot.health, 'running');
    assert.equal(snapshot.phase, 'Develop C1 R1');
    assert.equal(snapshot.cycle, 1);
  });

  test('a terminal record missing terminalReason reports reason:null, never a fabricated string', () => {
    const finishedNoReason = { ...FINISHED_EVENT, terminalReason: null };
    const sprint = {
      sprintId: 'spr-no-reason', live: false, terminal: false, state: null,
      history: [CHILD_EXITED_EVENT, finishedNoReason],
      latest: finishedNoReason,
    };
    const snapshot = toProgressSnapshot(sprint);
    assert.equal(snapshot.health, 'terminal');
    assert.equal(snapshot.verdict, 'ABORTED');
    assert.equal(snapshot.reason, null);
  });

  test('a verdict other than ABORTED (e.g. a clean DONE) is passed through unchanged', () => {
    const finishedDone = { ...FINISHED_EVENT, verdict: 'DONE', terminalReason: null };
    const sprint = {
      sprintId: 'spr-done', live: false, terminal: false, state: null,
      history: [finishedDone],
      latest: finishedDone,
    };
    const snapshot = toProgressSnapshot(sprint);
    assert.equal(snapshot.health, 'terminal');
    assert.equal(snapshot.verdict, 'DONE');
    assert.equal(snapshot.reason, null);
  });

  test('no "finished" event at all (e.g. only child-exited + auto-released) -- still terminal, verdict/reason absent, exitCode/logPath still surfaced', () => {
    const sprint = {
      sprintId: 'spr-crashed', live: false, terminal: false, state: null,
      history: [CHILD_EXITED_EVENT, AUTO_RELEASED_EVENT],
      latest: AUTO_RELEASED_EVENT,
    };
    const snapshot = toProgressSnapshot(sprint);
    assert.equal(snapshot.health, 'terminal');
    assert.equal(snapshot.verdict, undefined);
    assert.equal(snapshot.reason, null);
    assert.equal(snapshot.exitCode, 1);
    assert.equal(snapshot.logPath, CHILD_EXITED_EVENT.logPath);
  });

  test('`latest` present but `history` absent still works off `latest` alone', () => {
    const sprint = {
      sprintId: 'spr-latest-only', live: false, terminal: false, state: null,
      history: null,
      latest: FINISHED_EVENT,
    };
    const snapshot = toProgressSnapshot(sprint);
    assert.equal(snapshot.health, 'terminal');
    // No history array to search for a 'finished'/'child-exited' entry, so
    // only updatedAt (read off `latest` directly) is recoverable here.
    assert.equal(snapshot.verdict, undefined);
    assert.equal(snapshot.updatedAt, Date.parse(FINISHED_EVENT.at));
  });

  test('neither state, history, nor latest carry anything -- stays health:unknown, never guesses terminal', () => {
    const sprint = { sprintId: 'spr-nothing', live: false, terminal: false, state: null, history: null, latest: null };
    const snapshot = toProgressSnapshot(sprint);
    assert.equal(snapshot.health, 'unknown');
  });

  test('no field anywhere renders the literal string "undefined"', () => {
    const scenarios = [
      REAL_LIVE_PAYLOAD,
      { sprintId: 'spr-no-reason', live: false, terminal: false, state: null, history: [{ ...FINISHED_EVENT, terminalReason: null }], latest: null },
      { sprintId: 'spr-crashed', live: false, terminal: false, state: null, history: [CHILD_EXITED_EVENT, AUTO_RELEASED_EVENT], latest: AUTO_RELEASED_EVENT },
    ];
    for (const sprint of scenarios) {
      const snapshot = toProgressSnapshot(sprint);
      for (const value of Object.values(snapshot)) {
        assert.notStrictEqual(value, 'undefined');
      }
    }
  });
});

// -- verdictFromSprint / prUrlFromSprint / spendUsdFromSprint ------------------
// The single-owner extractors ../verbs/finalize.mjs imports rather than
// keeping its own copies of (see that module's header). Moved here from
// finalize.test.mjs when the two modules were consolidated: this package's
// tests should exercise them where they are defined.

describe('verdictFromSprint / prUrlFromSprint / spendUsdFromSprint', () => {
  function terminalSprint(overrides = {}) {
    return makeSprint({
      sprintId: 'spr-1',
      live: false,
      terminal: true,
      state: {
        result: { verdict: 'PASS', prUrl: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/42' },
        stats: { totalCost: 12.5 },
      },
      ...overrides,
    });
  }

  test('reads from state.result (post-M2 opaque shape)', () => {
    const sprint = terminalSprint();
    assert.strictEqual(verdictFromSprint(sprint), 'PASS');
    assert.strictEqual(prUrlFromSprint(sprint), 'https://dev.azure.com/org/proj/_git/repo/pullrequest/42');
    assert.strictEqual(spendUsdFromSprint(sprint), 12.5);
  });

  test('verdict falls back to sprint.latest.verdict (a HistoryEvent)', () => {
    const sprint = { state: null, latest: { verdict: 'FAIL' } };
    assert.strictEqual(verdictFromSprint(sprint), 'FAIL');
  });

  test('verdict falls back to a bare state.verdict (legacy shape)', () => {
    const sprint = { state: { verdict: 'FAIL' } };
    assert.strictEqual(verdictFromSprint(sprint), 'FAIL');
  });

  test('prUrl falls back to a bare state.prUrl (legacy shape)', () => {
    const sprint = { state: { prUrl: 'https://example/pr/9' } };
    assert.strictEqual(prUrlFromSprint(sprint), 'https://example/pr/9');
  });

  // Pinned as `undefined`, not `null`: toProgressSnapshot() feeds these
  // straight into makeProgressSnapshot(), and contracts.mjs's
  // validateProgressSnapshot() throws CONFIG_INVALID if an optional field
  // like `verdict` is `null` instead of `undefined` (it only special-cases
  // `undefined`). `null` was finalize.mjs's OWN local-copy convention before
  // consolidation -- a quirk of the duplicate, not a real requirement, so it
  // is not preserved here.
  test('all three return undefined (never throw, never null) when nothing is present', () => {
    assert.strictEqual(verdictFromSprint({}), undefined);
    assert.strictEqual(prUrlFromSprint({}), undefined);
    assert.strictEqual(spendUsdFromSprint({}), undefined);
    assert.strictEqual(verdictFromSprint(null), undefined);
    assert.strictEqual(prUrlFromSprint(undefined), undefined);
  });
});

// -- throttle.mjs: createBackoff -----------------------------------------------
// (see the import comment above for why this lives here)

describe('createBackoff', () => {
  test('widens by factor on every call after the first, capped at maxMs', () => {
    const backoff = createBackoff({ initialMs: 1000, maxMs: 8000, factor: 2 });
    assert.equal(backoff.next(), 1000);
    assert.equal(backoff.next(), 2000);
    assert.equal(backoff.next(), 4000);
    assert.equal(backoff.next(), 8000);
    assert.equal(backoff.next(), 8000, 'must not exceed maxMs');
  });

  test('reset() returns the counter to its pre-first-call state', () => {
    const backoff = createBackoff({ initialMs: 500, maxMs: 4000, factor: 2 });
    backoff.next();
    backoff.next();
    assert.equal(backoff.next(), 2000);
    backoff.reset();
    assert.equal(backoff.next(), 500, 'first call after reset must return initialMs again');
    assert.equal(backoff.next(), 1000);
  });

  test('applies documented defaults when no options are given', () => {
    const backoff = createBackoff();
    assert.equal(backoff.next(), 5000);
    assert.equal(backoff.next(), 10000);
  });

  test('rejects a non-widening factor', () => {
    assert.throws(() => createBackoff({ factor: 1 }), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      return true;
    });
    assert.throws(() => createBackoff({ factor: 0.5 }), (err) => err instanceof BridgeError);
  });

  test('rejects maxMs below initialMs', () => {
    assert.throws(() => createBackoff({ initialMs: 9000, maxMs: 1000 }), (err) => err instanceof BridgeError);
  });

  test('rejects a non-positive initialMs', () => {
    assert.throws(() => createBackoff({ initialMs: 0 }), (err) => err instanceof BridgeError);
    assert.throws(() => createBackoff({ initialMs: -5 }), (err) => err instanceof BridgeError);
  });
});

// -- throttle.mjs: createPhaseGate ---------------------------------------------

describe('createPhaseGate', () => {
  test('the very first snapshot always announces', () => {
    const gate = createPhaseGate();
    assert.equal(gate.shouldAnnounce({ phase: 'Plan C1 R1', cycle: 1 }), true);
  });

  test('announces once per transition, not once per tick', () => {
    const gate = createPhaseGate();
    const plan = { phase: 'Plan C1 R1', cycle: 1 };
    const develop = { phase: 'Develop C1 R1', cycle: 1 };

    assert.equal(gate.shouldAnnounce(plan), true, 'first ever snapshot announces');
    // Several ticks in the SAME phase -- a poll loop would call this once
    // per tick, but it must not re-announce.
    assert.equal(gate.shouldAnnounce({ ...plan }), false);
    assert.equal(gate.shouldAnnounce({ ...plan }), false);
    assert.equal(gate.shouldAnnounce({ ...plan }), false);

    // Plan -> Develop is a real transition.
    assert.equal(gate.shouldAnnounce(develop), true);
    // Ticking in Develop repeatedly does not re-announce.
    assert.equal(gate.shouldAnnounce({ ...develop }), false);
    assert.equal(gate.shouldAnnounce({ ...develop }), false);
  });

  test('a same-title, later-cycle transition still announces', () => {
    const gate = createPhaseGate();
    gate.shouldAnnounce({ phase: 'Plan', cycle: 1 });
    assert.equal(gate.shouldAnnounce({ phase: 'Plan', cycle: 2 }), true);
  });
});
