import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// ---- pure parsers extracted from the PURE_FUNCTIONS block --------------------
const match = src.match(/\/\/ PURE_FUNCTIONS_BEGIN[^\n]*\n([\s\S]*?)\/\/ PURE_FUNCTIONS_END/);
if (!match) throw new Error('PURE_FUNCTIONS_BEGIN/END markers not found in auto-sprint.js');
const {
  MODEL_SONNET, MODEL_HAIKU,
  parseBlockers, parseReadyStreaks, parseCycleState, collectSubtreeIds,
  // eslint-disable-next-line no-new-func
} = new Function(`${match[1]}; return { MODEL_SONNET, MODEL_HAIKU, parseBlockers, parseReadyStreaks, parseCycleState, collectSubtreeIds };`)();

// ---- collectSubtreeIds -------------------------------------------------------

test('collectSubtreeIds: unions whitespace-joined ID lists across sprint roots', () => {
  const ids = collectSubtreeIds(['BD-1 BD-2', 'BD-2  BD-3', '[]'], 2);
  assert.deepEqual([...ids].sort(), ['BD-1', 'BD-2', 'BD-3']);
});

test('collectSubtreeIds: tolerates empty / missing entries', () => {
  assert.deepEqual([...collectSubtreeIds(['', undefined], 2)], []);
});

// ---- parseBlockers (countBeadsBlockers contract) -----------------------------

test('parseBlockers: returns {count, ids} of open issues in subtree at/under threshold', () => {
  const outputs = [
    'BD-1 BD-2 BD-3',                                                    // sprint root graph IDs
    JSON.stringify([
      { id: 'BD-1', p: 1 },   // in subtree, p<=2  -> blocker
      { id: 'BD-2', p: 3 },   // in subtree, p>2   -> ignored
      { id: 'BD-3', p: 2 },   // in subtree, p<=2  -> blocker
      { id: 'BD-9', p: 0 },   // not in subtree    -> ignored
    ]),
  ];
  const r = parseBlockers(outputs, 1, 1, 2);
  assert.equal(r.count, 2);
  assert.deepEqual(r.ids.sort(), ['BD-1', 'BD-3']);
});

test('parseBlockers: unions IDs across multiple sprint root graphs', () => {
  const outputs = [
    'BD-1',
    'BD-2',
    JSON.stringify([{ id: 'BD-1', p: 1 }, { id: 'BD-2', p: 2 }]),
  ];
  const r = parseBlockers(outputs, 2, 2, 2);
  assert.equal(r.count, 2);
  assert.deepEqual(r.ids.sort(), ['BD-1', 'BD-2']);
});

test('parseBlockers: fail-safe sentinel {999,[]} on short/missing outputs', () => {
  assert.deepEqual(parseBlockers(undefined, 1, 1, 2), { count: 999, ids: [] });
  assert.deepEqual(parseBlockers([], 1, 1, 2), { count: 999, ids: [] });
  assert.deepEqual(parseBlockers(['BD-1'], 1, 1, 2), { count: 999, ids: [] }); // missing JSON output
});

test('parseBlockers: garbage JSON yields no blockers (count 0), never throws', () => {
  const r = parseBlockers(['BD-1', 'not json {{{'], 1, 1, 2);
  assert.deepEqual(r, { count: 0, ids: [] });
});

// ---- parseReadyStreaks (getReadyStreaks contract) ----------------------------

test('parseReadyStreaks: groups ready tasks by model, ordered by min priority', () => {
  const outputs = [
    'BD-1 BD-2 BD-3',
    JSON.stringify([
      { id: 'BD-1', p: 2, m: MODEL_SONNET },
      { id: 'BD-2', p: 1, m: MODEL_HAIKU },
      { id: 'BD-3', p: 3, m: MODEL_SONNET },
      { id: 'BD-X', p: 0, m: MODEL_HAIKU }, // not in subtree -> dropped
    ]),
  ];
  const r = parseReadyStreaks(outputs, 1, 1, MODEL_SONNET);
  assert.equal(r.totalCount, 3);
  // haiku streak has min priority 1 -> comes first
  assert.equal(r.streaks[0].model, MODEL_HAIKU);
  assert.deepEqual(r.streaks[0].ids, ['BD-2']);
  // sonnet streak: ids ordered by priority (BD-1 p2 before BD-3 p3)
  assert.equal(r.streaks[1].model, MODEL_SONNET);
  assert.deepEqual(r.streaks[1].ids, ['BD-1', 'BD-3']);
});

test('parseReadyStreaks: defaults model when metadata missing', () => {
  const r = parseReadyStreaks(['BD-1', JSON.stringify([{ id: 'BD-1', p: 2 }])], 1, 1, MODEL_SONNET);
  assert.equal(r.streaks[0].model, MODEL_SONNET);
});

test('parseReadyStreaks: empty/garbage => {0, [], extractFailed: true}', () => {
  assert.deepEqual(parseReadyStreaks(undefined, 1, 1, MODEL_SONNET), { totalCount: 0, streaks: [], extractFailed: true });
  assert.deepEqual(parseReadyStreaks(['BD-1', 'oops'], 1, 1, MODEL_SONNET), { totalCount: 0, streaks: [], extractFailed: true });
});

test('parseReadyStreaks: a valid empty array is NOT flagged as extractFailed', () => {
  const r = parseReadyStreaks(['BD-1', '[]'], 1, 1, MODEL_SONNET);
  assert.deepEqual(r, { totalCount: 0, streaks: [], extractFailed: false });
});

// ---- parseCycleState (checkCycleState contract) ------------------------------

test('parseCycleState: planDone true when features closed', () => {
  const outputs = [
    JSON.stringify([{ id: 'F1', t: 'feature', s: 'closed', d: true }]),
    '', // no in-progress tasks
  ];
  const r = parseCycleState(outputs, 1);
  assert.equal(r.planDone, true);
  assert.deepEqual(r.inProgressIds, []);
});

test('parseCycleState: planDone true when open features have all tasks described', () => {
  const outputs = [
    JSON.stringify([
      { id: 'F1', t: 'feature', s: 'open', d: true },
      { id: 'T1', t: 'task', s: 'open', d: true },
      { id: 'T2', t: 'task', s: 'open', d: true },
    ]),
    'T1',
  ];
  const r = parseCycleState(outputs, 1);
  assert.equal(r.planDone, true);
  assert.deepEqual(r.inProgressIds, ['T1']);
});

test('parseCycleState: planDone false when a task lacks a description', () => {
  const outputs = [
    JSON.stringify([
      { id: 'F1', t: 'feature', s: 'open', d: true },
      { id: 'T1', t: 'task', s: 'open', d: false },
    ]),
    '',
  ];
  assert.equal(parseCycleState(outputs, 1).planDone, false);
});

test('parseCycleState: planDone false with no features', () => {
  assert.equal(parseCycleState([JSON.stringify([{ id: 'T1', t: 'task', s: 'open', d: true }]), ''], 1).planDone, false);
});

test('parseCycleState: every sprint root must satisfy planDone', () => {
  const ok = JSON.stringify([{ id: 'F1', t: 'feature', s: 'closed', d: true }]);
  const bad = JSON.stringify([{ id: 'F2', t: 'feature', s: 'open', d: true }, { id: 'T2', t: 'task', s: 'open', d: false }]);
  assert.equal(parseCycleState([ok, bad, ''], 2).planDone, false);
  assert.equal(parseCycleState([ok, ok, ''], 2).planDone, true);
});

test('parseCycleState: fail-safe {false,[]} on short/missing outputs', () => {
  assert.deepEqual(parseCycleState(undefined, 1), { planDone: false, inProgressIds: [] });
  assert.deepEqual(parseCycleState([JSON.stringify([])], 1), { planDone: false, inProgressIds: [] });
});

// ---- bounded-dispatch invariants (latency hardening) -------------------------
// These assert, by reading the source, that every shell dispatch is single-attempt
// (maxTurns bounded) and that no shell dispatch uses the old "verbatim" loop-prone
// prompt without the single-attempt contract. This is what prevents the 12.5-min
// check-blockers stall from recurring.

test('shell dispatches route through bounded dispatchShell helper', () => {
  // All three exit-check helpers must call dispatchShell (which sets maxTurns),
  // never raw dispatch with SHELL_OUTPUTS_SCHEMA.
  for (const fn of ['countBeadsBlockers', 'getReadyStreaks', 'checkCycleState']) {
    const body = src.slice(src.indexOf(`async function ${fn}(`));
    const end = body.indexOf('\nasync function ');
    const region = end > 0 ? body.slice(0, end) : body;
    assert.match(region, /dispatchShell\(/, `${fn} must use dispatchShell`);
    assert.doesNotMatch(region, /SHELL_OUTPUTS_SCHEMA/, `${fn} must not hand-roll the schema dispatch`);
  }
});

test('dispatchShell sets a bounded maxTurns = commands + 1', () => {
  assert.match(src, /function shellMaxTurns\(cmds\)\s*{\s*return cmds\.length \+ 1;/);
  assert.match(src, /async function dispatchShell\(cmds, opts\)[\s\S]*maxTurns: shellMaxTurns\(cmds\)/);
});

test('shell prompt forbids retries / re-runs (single-attempt contract)', () => {
  assert.match(src, /SHELL_DISPATCH_PROMPT_HEADER/);
  assert.match(src, /EXACTLY ONCE/);
  assert.match(src, /Do NOT[\s\S]*retry/i);
});
