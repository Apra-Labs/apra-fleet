import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Extract the pure-function block from auto-sprint.js and eval it in isolation,
// exactly as sprint-cost / streak-ceiling tests do. These functions back the
// pre-flight validation gate and the context-fit streak predictor.
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);
const match = src.match(/\/\/ PURE_FUNCTIONS_BEGIN[^\n]*\n([\s\S]*?)\/\/ PURE_FUNCTIONS_END/);
if (!match) throw new Error('PURE_FUNCTIONS_BEGIN/END markers not found in auto-sprint.js');
// eslint-disable-next-line no-new-func
const {
  DEFAULT_CALIBRATION, validateSprintArgs, assertCalibrationComplete,
  checkModelAliasStaleness, fitStreakToContext,
} = new Function(
  `${match[1]}; return { DEFAULT_CALIBRATION, validateSprintArgs, assertCalibrationComplete, checkModelAliasStaleness, fitStreakToContext };`
)();

// -- validateSprintArgs --------------------------------------------------------

test('validateSprintArgs: accepts a well-formed object', () => {
  assert.deepEqual(validateSprintArgs({ issues: ['BD-1'], branch: 'feat/x' }, '...'), { ok: true });
  assert.equal(validateSprintArgs({ issues: ['BD-1', 'BD-2'], goal: 'P1', max_cycles: 3, base_branch: 'main' }, '').ok, true);
  assert.equal(validateSprintArgs({ issues: ['BD-1'], skip_dolt_push: true }, '').ok, true);
  assert.equal(validateSprintArgs({ issues: ['BD-1'], skip_dolt_push: false }, '').ok, true);
});

test('validateSprintArgs: rejects non-object / array / missing issues', () => {
  assert.equal(validateSprintArgs(null, 'x').ok, false);
  assert.equal(validateSprintArgs(['BD-1'], 'x').ok, false);        // array, not object
  assert.equal(validateSprintArgs({}, 'x').ok, false);              // no issues
  assert.equal(validateSprintArgs({ issues: [] }, 'x').ok, false);  // empty issues
  assert.equal(validateSprintArgs({ issues: [42] }, 'x').ok, false); // non-string entry
});

test('validateSprintArgs: rejects bad optional fields', () => {
  assert.equal(validateSprintArgs({ issues: ['BD-1'], goal: 'P9' }, '').ok, false);
  assert.equal(validateSprintArgs({ issues: ['BD-1'], max_cycles: 0 }, '').ok, false);
  assert.equal(validateSprintArgs({ issues: ['BD-1'], max_cycles: 2.5 }, '').ok, false);
  assert.equal(validateSprintArgs({ issues: ['BD-1'], branch: '' }, '').ok, false);
  assert.equal(validateSprintArgs({ issues: ['BD-1'], base_branch: '  ' }, '').ok === false, false === false);
  assert.equal(validateSprintArgs({ issues: ['BD-1'], skip_dolt_push: 'yes' }, '').ok, false); // string, not boolean
  assert.equal(validateSprintArgs({ issues: ['BD-1'], skip_dolt_push: 1 }, '').ok, false);     // number, not boolean
});

test('validateSprintArgs: failure carries an actionable detail string', () => {
  const r = validateSprintArgs({}, '{"issues":"BD-1"}');
  assert.equal(r.ok, false);
  assert.match(r.detail, /issues/);
});

// -- assertCalibrationComplete -------------------------------------------------

test('assertCalibrationComplete: a complete calibration heals nothing', () => {
  const r = assertCalibrationComplete(DEFAULT_CALIBRATION, DEFAULT_CALIBRATION);
  assert.deepEqual(r.healed, []);
});

test('assertCalibrationComplete: heals missing nested fields from defaults, without mutating defaults', () => {
  const stale = JSON.parse(JSON.stringify(DEFAULT_CALIBRATION));
  delete stale.context_limits;                 // whole new block missing (old on-disk file)
  stale.doer_token_ceiling.standard = undefined; // one nested numeric missing
  const r = assertCalibrationComplete(stale, DEFAULT_CALIBRATION);
  assert.ok(r.healed.length >= 5, 'should heal context_limits.* plus the missing ceiling');
  assert.equal(r.calibration.context_limits.base_prompt_tokens, DEFAULT_CALIBRATION.context_limits.base_prompt_tokens);
  assert.equal(r.calibration.doer_token_ceiling.standard, DEFAULT_CALIBRATION.doer_token_ceiling.standard);
  // defaults object must be untouched (clone-on-write)
  assert.ok(DEFAULT_CALIBRATION.context_limits, 'defaults must not be mutated');
});

test('assertCalibrationComplete: heals NaN / non-number values', () => {
  const bad = JSON.parse(JSON.stringify(DEFAULT_CALIBRATION));
  bad.reviewer_ratio.value = 'oops';
  const r = assertCalibrationComplete(bad, DEFAULT_CALIBRATION);
  assert.equal(r.calibration.reviewer_ratio.value, DEFAULT_CALIBRATION.reviewer_ratio.value);
  assert.ok(r.healed.some((h) => /reviewer_ratio\.value/.test(h)));
});

// -- checkModelAliasStaleness --------------------------------------------------

test('checkModelAliasStaleness: flags dated model pins, passes bare aliases', () => {
  assert.deepEqual(checkModelAliasStaleness({ cheap: 'haiku', standard: 'sonnet' }), []);
  assert.deepEqual(checkModelAliasStaleness({ standard: 'claude-sonnet-4-20250514' }), ['standard=claude-sonnet-4-20250514']);
});

// -- fitStreakToContext --------------------------------------------------------

function calWithContext(overrides) {
  return {
    ...DEFAULT_CALIBRATION,
    historical: { sprints_sampled: 0 },
    complexity_buckets: { M: { doer_tokens: 1400 } },
    context_limits: {
      model_context_tokens: { standard: 200000 },
      autocompact_headroom_fraction: 0.5, // usable = 100000
      base_prompt_tokens: 10000,
      per_task_input_overhead_tokens: 20000,
      output_expansion_factor: 1.0,
      ...overrides,
    },
  };
}

test('fitStreakToContext: splits a streak that would overflow usable context', () => {
  // usable = 100000; base 10000; per task 20000 + 1400 = 21400 -> floor((100000-10000)/21400) = 4
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const bucketById = Object.fromEntries(ids.map((i) => [i, 'M']));
  const r = fitStreakToContext(ids, bucketById, calWithContext(), 'standard');
  assert.equal(r.fittedIds.length, 4);
  assert.equal(r.wouldOverflow, true);
});

test('fitStreakToContext: keeps the whole streak when it fits', () => {
  const ids = ['a', 'b'];
  const bucketById = { a: 'M', b: 'M' };
  const r = fitStreakToContext(ids, bucketById, calWithContext(), 'standard');
  assert.deepEqual(r.fittedIds, ids);
  assert.equal(r.wouldOverflow, false);
});

test('fitStreakToContext: no configured window -> unbounded, keeps all', () => {
  const ids = ['a', 'b', 'c'];
  const r = fitStreakToContext(ids, { a: 'M', b: 'M', c: 'M' }, { context_limits: {} }, 'standard');
  assert.deepEqual(r.fittedIds, ids);
  assert.equal(r.available, Infinity);
});

test('fitStreakToContext: always keeps at least one task even if oversized', () => {
  const r = fitStreakToContext(['big'], { big: 'M' }, calWithContext({ base_prompt_tokens: 999999 }), 'standard');
  assert.deepEqual(r.fittedIds, ['big']);
});
