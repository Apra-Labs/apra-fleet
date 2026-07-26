import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);
const match = src.match(/\/\/ PURE_FUNCTIONS_BEGIN[^\n]*\n([\s\S]*?)\/\/ PURE_FUNCTIONS_END/);
if (!match) throw new Error('PURE_FUNCTIONS_BEGIN/END markers not found in auto-sprint.js');
const {
  MODEL_OPUS, MODEL_SONNET, MODEL_HAIKU,
  DEFAULT_CALIBRATION,
  reviewerModelFor,
  computeSprintQuote,
  computeSprintAnalysis,
  computeUpdatedCalibration,
  accumulateBucketTokens,
  buildSprintSummary,
  buildExecutionSummary,
  // eslint-disable-next-line no-new-func
} = new Function(`${match[1]}; return { MODEL_OPUS, MODEL_SONNET, MODEL_HAIKU, DEFAULT_CALIBRATION, reviewerModelFor, computeSprintQuote, computeSprintAnalysis, computeUpdatedCalibration, accumulateBucketTokens, buildSprintSummary, buildExecutionSummary };`)();

// -- reviewerModelFor ----------------------------------------------------------

test('reviewerModelFor: opus stays opus', () => {
  assert.equal(reviewerModelFor(MODEL_OPUS), MODEL_OPUS);
});

test('reviewerModelFor: sonnet gets sonnet', () => {
  assert.equal(reviewerModelFor(MODEL_SONNET), MODEL_SONNET);
});

test('reviewerModelFor: haiku gets sonnet', () => {
  assert.equal(reviewerModelFor(MODEL_HAIKU), MODEL_SONNET);
});

// -- computeSprintQuote --------------------------------------------------------

test('computeSprintQuote: empty task list returns zero-cost scenarios', () => {
  const q = computeSprintQuote([], DEFAULT_CALIBRATION);
  assert.equal(q.tasks.length, 0);
  assert.equal(q.calibrationSource, 'defaults');
  assert.equal(q.inputMultiplier, 4.0);
  // All scenarios are positive (overhead exists even with no tasks)
  assert.ok(q.scenarios.optimistic.outputOnly > 0);
  assert.ok(q.scenarios.expected.outputOnly > 0);
  assert.ok(q.scenarios.pessimistic.outputOnly > 0);
  // expected is between optimistic and pessimistic
  assert.ok(q.scenarios.optimistic.outputOnly <= q.scenarios.expected.outputOnly);
  assert.ok(q.scenarios.expected.outputOnly <= q.scenarios.pessimistic.outputOnly);
});

test('computeSprintQuote: single S-bucket sonnet task', () => {
  const tasks = [{ id: 'BD-1', bucket: 'S', model: MODEL_SONNET }];
  const q = computeSprintQuote(tasks, DEFAULT_CALIBRATION);

  assert.equal(q.tasks.length, 1);
  const t = q.tasks[0];
  assert.equal(t.id, 'BD-1');
  assert.equal(t.bucket, 'S');
  assert.equal(t.model, MODEL_SONNET);
  assert.equal(t.doerTokens, 600);               // S bucket default
  assert.equal(t.reviewerTokens, Math.round(600 * 0.4)); // 240
  // outputUsd = (600 * 15 + 240 * 15) / 1_000_000
  const expected = (600 * 15 + 240 * 15) / 1_000_000;
  assert.ok(Math.abs(t.outputUsd - expected) < 1e-9);
});

test('computeSprintQuote: opus task uses opus price for doer, opus for reviewer', () => {
  const tasks = [{ id: 'BD-2', bucket: 'M', model: MODEL_OPUS }];
  const q = computeSprintQuote(tasks, DEFAULT_CALIBRATION);
  const t = q.tasks[0];
  assert.equal(t.doerTokens, 1400);
  assert.equal(t.reviewerTokens, Math.round(1400 * 0.4));
  const expectedUsd = (1400 * 25 + Math.round(1400 * 0.4) * 25) / 1_000_000;
  assert.ok(Math.abs(t.outputUsd - expectedUsd) < 1e-9);
});

test('computeSprintQuote: haiku doer gets sonnet reviewer', () => {
  const tasks = [{ id: 'BD-3', bucket: 'S', model: MODEL_HAIKU }];
  const q = computeSprintQuote(tasks, DEFAULT_CALIBRATION);
  const t = q.tasks[0];
  // doer = haiku ($5), reviewer = sonnet ($15)
  const expectedUsd = (600 * 5 + Math.round(600 * 0.4) * 15) / 1_000_000;
  assert.ok(Math.abs(t.outputUsd - expectedUsd) < 1e-9);
});

test('computeSprintQuote: total scenario scales with cycle multiplier', () => {
  const tasks = [{ id: 'BD-1', bucket: 'M', model: MODEL_SONNET }];
  const q = computeSprintQuote(tasks, DEFAULT_CALIBRATION);
  // overhead is fixed; only per-task portion and log-flush scale with cycles
  assert.ok(q.scenarios.pessimistic.outputOnly > q.scenarios.expected.outputOnly);
  assert.ok(q.scenarios.expected.outputOnly > q.scenarios.optimistic.outputOnly);
});

test('computeSprintQuote: total = outputOnly * inputMultiplier', () => {
  const tasks = [{ id: 'BD-1', bucket: 'M', model: MODEL_SONNET }];
  const q = computeSprintQuote(tasks, DEFAULT_CALIBRATION);
  for (const s of Object.values(q.scenarios)) {
    assert.ok(Math.abs(s.total - s.outputOnly * q.inputMultiplier) < 1e-9);
  }
});

test('computeSprintQuote: historical data overrides bucket defaults', () => {
  const cal = {
    ...DEFAULT_CALIBRATION,
    historical: {
      ...DEFAULT_CALIBRATION.historical,
      sprints_sampled: 2,
      reviewer_ratio_avg: 0.5,
      bucket_avg_tokens: { M: 2000 },
    },
  };
  const tasks = [{ id: 'BD-1', bucket: 'M', model: MODEL_SONNET }];
  const q = computeSprintQuote(tasks, cal);
  assert.equal(q.tasks[0].doerTokens, 2000);       // from historical
  assert.equal(q.tasks[0].reviewerTokens, 1000);   // 2000 * 0.5
  assert.equal(q.calibrationSource, 'historical (2 sprints)');
});

test('computeSprintQuote: missing model falls back to doer_model_fallback', () => {
  const tasks = [{ id: 'BD-1', bucket: 'S' }];  // no model field
  const q = computeSprintQuote(tasks, DEFAULT_CALIBRATION);
  assert.equal(q.tasks[0].model, MODEL_SONNET);  // fallback
});

// -- computeSprintAnalysis -----------------------------------------------------

const SAMPLE_QUOTE = computeSprintQuote(
  [{ id: 'BD-1', bucket: 'M', model: MODEL_SONNET }],
  DEFAULT_CALIBRATION
);

const SAMPLE_LOG = [
  { label: 'doer-c1-i0',    outTokens: 1200, costUsd: 0.018, phase: 'Develop' },
  { label: 'reviewer-c1',   outTokens:  450, costUsd: 0.006, phase: 'Develop' },
  { label: 'doer-c2-i0',    outTokens: 1100, costUsd: 0.0165, phase: 'Develop' },
  { label: 'reviewer-c2',   outTokens:  400, costUsd: 0.006, phase: 'Develop' },
  { label: 'harvester',     outTokens:  800, costUsd: 0.012, phase: 'Harvest' },
];

test('computeSprintAnalysis: groups log entries by role', () => {
  const r = computeSprintAnalysis(SAMPLE_QUOTE, SAMPLE_LOG, DEFAULT_CALIBRATION, 2);
  assert.equal(r.byRole['doer'].tokens, 2300);    // 1200+1100
  assert.equal(r.byRole['doer'].dispatches, 2);
  assert.equal(r.byRole['reviewer'].tokens, 850); // 450+400
  assert.equal(r.byRole['harvester'].tokens, 800);
});

test('computeSprintAnalysis: actualCycles passed through', () => {
  const r = computeSprintAnalysis(SAMPLE_QUOTE, SAMPLE_LOG, DEFAULT_CALIBRATION, 2);
  assert.equal(r.actualCycles, 2);
});

test('computeSprintAnalysis: totals are sums of actuals', () => {
  const r = computeSprintAnalysis(SAMPLE_QUOTE, SAMPLE_LOG, DEFAULT_CALIBRATION, 2);
  const expectedActUsd = 0.018 + 0.006 + 0.0165 + 0.006 + 0.012;
  assert.ok(Math.abs(r.totActUsd - expectedActUsd) < 1e-9);
});

test('computeSprintAnalysis: analysisText contains markdown table header', () => {
  const r = computeSprintAnalysis(SAMPLE_QUOTE, SAMPLE_LOG, DEFAULT_CALIBRATION, 2);
  assert.ok(r.analysisText.includes('| Role'));
  assert.ok(r.analysisText.includes('| doer'));
  assert.ok(r.analysisText.includes('| TOTAL'));
});

test('computeSprintAnalysis: analysisText contains outlier/failure lines', () => {
  const r = computeSprintAnalysis(SAMPLE_QUOTE, SAMPLE_LOG, DEFAULT_CALIBRATION, 2);
  assert.ok(r.analysisText.includes('Outliers'));
  assert.ok(r.analysisText.includes('Calibration failures'));
});

test('computeSprintAnalysis: null quote handled gracefully (no tasks)', () => {
  const r = computeSprintAnalysis(null, SAMPLE_LOG, DEFAULT_CALIBRATION, 1);
  assert.ok(r.analysisText.includes('#### Sprint cost analysis'));
  assert.equal(typeof r.totEstOutputUsd, 'number');
  assert.ok(isFinite(r.totEstOutputUsd));
});

test('computeSprintAnalysis: empty log entries returns zeros for actuals', () => {
  const r = computeSprintAnalysis(SAMPLE_QUOTE, [], DEFAULT_CALIBRATION, 1);
  assert.equal(r.totActUsd, 0);
  assert.deepEqual(r.byRole, {});
});

test('computeSprintAnalysis: labels without cycle suffix are grouped to role', () => {
  const log = [
    { label: 'setup', outTokens: 200, costUsd: 0.001 },
    { label: 'harvester', outTokens: 800, costUsd: 0.012 },
  ];
  const r = computeSprintAnalysis(SAMPLE_QUOTE, log, DEFAULT_CALIBRATION, 1);
  assert.equal(r.byRole['setup']?.tokens, 200);
  assert.equal(r.byRole['harvester']?.tokens, 800);
});

// -- computeUpdatedCalibration -------------------------------------------------

const SAMPLE_ANALYSIS = {
  actualCycles: 2,
  totEstOutputUsd: 0.05,
  totActUsd: 0.06,
  byRole: {
    doer:      { tokens: 2300, costUsd: 0.0345, dispatches: 2 },
    reviewer:  { tokens:  850, costUsd: 0.0128, dispatches: 2 },
    harvester: { tokens:  800, costUsd: 0.0120, dispatches: 1 },
  },
};

test('computeUpdatedCalibration: first sprint sets sprints_sampled to 1', () => {
  const u = computeUpdatedCalibration(DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000');
  assert.equal(u.historical.sprints_sampled, 1);
});

test('computeUpdatedCalibration: last_updated extracted from startedAt', () => {
  const u = computeUpdatedCalibration(DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000');
  assert.equal(u.historical.last_updated, '2026-06-20');
});

test('computeUpdatedCalibration: first sprint cycle_avg equals actualCycles', () => {
  const u = computeUpdatedCalibration(DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000');
  assert.equal(u.historical.cycle_avg, 2);
});

test('computeUpdatedCalibration: second sprint blends cycle_avg', () => {
  const after1 = computeUpdatedCalibration(DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000');
  const analysis2 = { ...SAMPLE_ANALYSIS, actualCycles: 4 };
  const after2 = computeUpdatedCalibration(after1, analysis2, '20260621_090000');
  // blend(2, 4) with prev=1, n=2 => (2*1 + 4) / 2 = 3
  assert.equal(after2.historical.cycle_avg, 3);
  assert.equal(after2.historical.sprints_sampled, 2);
});

test('computeUpdatedCalibration: reviewer_ratio_avg computed from doer/reviewer tokens', () => {
  const u = computeUpdatedCalibration(DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000');
  // revTok / doerTok = 850 / 2300
  const expected = 850 / 2300;
  assert.ok(Math.abs(u.historical.reviewer_ratio_avg - expected) < 1e-9);
});

test('computeUpdatedCalibration: role avg_output_tokens set on first sprint', () => {
  const u = computeUpdatedCalibration(DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000');
  // doer: 2300 tokens / 2 dispatches = 1150
  assert.equal(u.historical.roles['doer'].avg_output_tokens, 1150);
  assert.equal(u.historical.roles['doer'].sample_n, 2);
});

test('computeUpdatedCalibration: rolling blend capped at max_samples_in_average', () => {
  let cal = DEFAULT_CALIBRATION;
  // Set the cap to 5 so we don't have to loop 50 times
  cal = JSON.parse(JSON.stringify(cal));
  cal.historical = { max_samples_in_average: 5 };
  
  const analysis = { ...SAMPLE_ANALYSIS, actualCycles: 2 };
  // Run 6 sprints -- each adds 1 cycle sample
  for (let i = 0; i < 6; i++) {
    cal = computeUpdatedCalibration(cal, analysis, '20260620_130000');
  }
  // cycle_sample_n should cap at 5, sprints_sampled will just be 6
  assert.equal(cal.historical.cycle_sample_n, 5);
  assert.equal(cal.historical.sprints_sampled, 6);
});

test('computeUpdatedCalibration: does not mutate original calibration', () => {
  const original = JSON.parse(JSON.stringify(DEFAULT_CALIBRATION));
  computeUpdatedCalibration(DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000');
  assert.deepEqual(DEFAULT_CALIBRATION.historical, original.historical);
});

test('computeUpdatedCalibration: other calibration fields preserved', () => {
  const u = computeUpdatedCalibration(DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000');
  assert.deepEqual(u.model_prices_per_1m_output_tokens, DEFAULT_CALIBRATION.model_prices_per_1m_output_tokens);
  assert.deepEqual(u.complexity_buckets, DEFAULT_CALIBRATION.complexity_buckets);
});

test('computeUpdatedCalibration: skips roles where all dispatches had zero tokens (cached replay)', () => {
  const analysis = {
    ...SAMPLE_ANALYSIS,
    byRole: {
      ...SAMPLE_ANALYSIS.byRole,
      planner: { tokens: 0, costUsd: 0, dispatches: 2 },
    },
  };
  const u = computeUpdatedCalibration(DEFAULT_CALIBRATION, analysis, '20260620_130000');
  assert.equal(u.historical.roles['planner'], undefined);
});

// -- accumulateBucketTokens ----------------------------------------------------

const BUCKET_ASSIGNMENTS = [
  { id: 'BD-1', bucket: 'S', model: MODEL_SONNET },
  { id: 'BD-2', bucket: 'M', model: MODEL_SONNET },
  { id: 'BD-3', bucket: 'M', model: MODEL_OPUS },
  { id: 'BD-4', bucket: 'L', model: MODEL_OPUS },
];

test('accumulateBucketTokens: single doer entry with one task attributes all tokens', () => {
  const entries = [{ label: 'doer-c1-i1', context: 'tasks BD-1', outTokens: 600 }];
  const acc = accumulateBucketTokens(entries, BUCKET_ASSIGNMENTS);
  assert.equal(acc.S.tokens, 600);
  assert.equal(acc.S.n, 1);
  assert.equal(acc.M, undefined);
  assert.equal(acc.L, undefined);
});

test('accumulateBucketTokens: tokens split evenly across listed task IDs', () => {
  // BD-1 (S) + BD-2 (M) in one entry -> 1000 tokens split 500/500
  const entries = [{ label: 'doer-c1-i1', context: 'tasks BD-1, BD-2', outTokens: 1000 }];
  const acc = accumulateBucketTokens(entries, BUCKET_ASSIGNMENTS);
  assert.equal(acc.S.tokens, 500);
  assert.equal(acc.S.n, 1);
  assert.equal(acc.M.tokens, 500);
  assert.equal(acc.M.n, 1);
});

test('accumulateBucketTokens: two M-bucket IDs in one entry both counted as M', () => {
  const entries = [{ label: 'doer-c1-i1', context: 'tasks BD-2, BD-3', outTokens: 2000 }];
  const acc = accumulateBucketTokens(entries, BUCKET_ASSIGNMENTS);
  // both BD-2 and BD-3 are M -> 1000 each, n=2
  assert.equal(acc.M.tokens, 2000);
  assert.equal(acc.M.n, 2);
});

test('accumulateBucketTokens: ignores non-doer entries', () => {
  const entries = [
    { label: 'reviewer-c1-i1', context: 'reviewing tasks BD-1', outTokens: 500 },
    { label: 'harvester',      context: '',                     outTokens: 800 },
    { label: 'doer-c1-i1',     context: 'tasks BD-4',           outTokens: 3000 },
  ];
  const acc = accumulateBucketTokens(entries, BUCKET_ASSIGNMENTS);
  assert.deepEqual(Object.keys(acc).sort(), ['L']);
  assert.equal(acc.L.tokens, 3000);
});

test('accumulateBucketTokens: skips zero-token (cached) doer entries', () => {
  const entries = [{ label: 'doer-c1-i1', context: 'tasks BD-1', outTokens: 0 }];
  const acc = accumulateBucketTokens(entries, BUCKET_ASSIGNMENTS);
  assert.deepEqual(acc, {});
});

test('accumulateBucketTokens: unmappable task IDs are skipped', () => {
  const entries = [{ label: 'doer-c1-i1', context: 'tasks BD-99', outTokens: 600 }];
  const acc = accumulateBucketTokens(entries, BUCKET_ASSIGNMENTS);
  assert.deepEqual(acc, {});
});

test('accumulateBucketTokens: aggregates across multiple doer entries', () => {
  const entries = [
    { label: 'doer-c1-i1', context: 'tasks BD-2', outTokens: 1200 },
    { label: 'doer-c2-i1', context: 'tasks BD-3', outTokens: 1600 },
  ];
  const acc = accumulateBucketTokens(entries, BUCKET_ASSIGNMENTS);
  assert.equal(acc.M.tokens, 2800);
  assert.equal(acc.M.n, 2);
});

// -- computeUpdatedCalibration bucket_avg_tokens join --------------------------

test('computeUpdatedCalibration: populates bucket_avg_tokens for exercised buckets', () => {
  const logEntries = [
    { label: 'doer-c1-i1', context: 'tasks BD-1', outTokens: 600 },  // S
    { label: 'doer-c1-i1', context: 'tasks BD-2', outTokens: 1400 }, // M
  ];
  const u = computeUpdatedCalibration(
    DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000', BUCKET_ASSIGNMENTS, logEntries);
  assert.equal(u.historical.bucket_avg_tokens.S, 600);
  assert.equal(u.historical.bucket_avg_tokens.M, 1400);
  // L never exercised -> stays absent so computeSprintQuote defaults apply
  assert.equal(u.historical.bucket_avg_tokens.L, undefined);
});

test('computeUpdatedCalibration: blends bucket_avg_tokens against prior history', () => {
  const cal = JSON.parse(JSON.stringify(DEFAULT_CALIBRATION));
  cal.historical.bucket_sample_n = { M: 1 };            // prev=1 sample
  cal.historical.bucket_avg_tokens = { M: 1000 };
  const logEntries = [{ label: 'doer-c1-i1', context: 'tasks BD-2', outTokens: 2000 }]; // M=2000 (1 sample)
  const u = computeUpdatedCalibration(cal, SAMPLE_ANALYSIS, '20260621_090000', BUCKET_ASSIGNMENTS, logEntries);
  // blend(1000, 2000) with prev=1, n=2 => (1000*1 + 2000)/2 = 1500
  assert.equal(u.historical.bucket_avg_tokens.M, 1500);
  assert.equal(u.historical.bucket_sample_n.M, 2);
});

test('computeUpdatedCalibration: bucket join populated value flows into computeSprintQuote', () => {
  const logEntries = [{ label: 'doer-c1-i1', context: 'tasks BD-2', outTokens: 1800 }]; // M
  const u = computeUpdatedCalibration(
    DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000', BUCKET_ASSIGNMENTS, logEntries);
  // sprints_sampled now >=1 and M has history -> quote uses 1800, not the 1400 default
  const q = computeSprintQuote([{ id: 'X', bucket: 'M', model: MODEL_SONNET }], u);
  assert.equal(q.tasks[0].doerTokens, 1800);
});

test('computeUpdatedCalibration: no doer log entries leaves bucket_avg_tokens unchanged', () => {
  const u = computeUpdatedCalibration(
    DEFAULT_CALIBRATION, SAMPLE_ANALYSIS, '20260620_130000', BUCKET_ASSIGNMENTS, []);
  assert.deepEqual(u.historical.bucket_avg_tokens, {});
});

test('computeSprintQuote: _doc strings in calibration.json do not cause NaN', () => {
  const calWithDoc = JSON.parse(JSON.stringify(DEFAULT_CALIBRATION));
  calWithDoc.fixed_overhead_tokens._doc = 'documentation string';
  const q = computeSprintQuote([], calWithDoc);
  assert.ok(!isNaN(q.scenarios.expected.outputOnly));
  assert.ok(!isNaN(q.scenarios.expected.total));
});

test('computeSprintAnalysis: _doc strings in calibration.json do not cause NaN', () => {
  const calWithDoc = JSON.parse(JSON.stringify(DEFAULT_CALIBRATION));
  calWithDoc.fixed_overhead_tokens._doc = 'documentation string';
  const r = computeSprintAnalysis(SAMPLE_QUOTE, SAMPLE_LOG, calWithDoc, 2);
  assert.ok(!isNaN(r.totEstOutputUsd));
  assert.ok(r.analysisText.includes('#### Sprint cost analysis'));
});

// -- buildSprintSummary --------------------------------------------------------

const BSS_QUOTE = computeSprintQuote(
  [{ id: 'BD-1', bucket: 'M', model: MODEL_SONNET }],
  DEFAULT_CALIBRATION
);
// BD-1 M bucket -> doerTokens=1400, reviewerTokens=560 (at estCycles=1.5 expected:
//   doer est = 1400 * 1.5 = 2100  reviewer est = 560 * 1.5 = 840)

test('buildSprintSummary: returns summaryText string', () => {
  const analysis = computeSprintAnalysis(BSS_QUOTE, [], DEFAULT_CALIBRATION, 1);
  const { summaryText } = buildSprintSummary(analysis, BSS_QUOTE, DEFAULT_CALIBRATION, {
    branch: 'feat/test', goal: 'ship it', goalMet: true, cycleCount: 2,
    tasksCompleted: 3, tasksOpen: 0, startedAt: '20260620_100000',
  });
  assert.ok(typeof summaryText === 'string', 'summaryText must be a string');
  assert.ok(summaryText.includes('# Sprint summary'), 'must include sprint summary header');
  assert.ok(summaryText.includes('feat/test'), 'must include branch name');
  assert.ok(summaryText.includes('ship it'), 'must include goal');
  assert.ok(summaryText.includes('MET'), 'must show goal met/not met');
  assert.ok(summaryText.includes('Suggested calibration adjustments'), 'must include suggestions section');
  // AC criterion 1: cycles line
  assert.ok(summaryText.includes('estimated') && summaryText.includes('actual'),
    'must include cycles estimated X actual Y');
  // AC criterion 1: tasks line
  assert.ok(summaryText.includes('completed') && summaryText.includes('open'),
    'must include tasks completed C open O');
  // AC criterion 1: cost table header row
  assert.ok(summaryText.includes('#### Sprint cost analysis'),
    'must include cost table header row');
});

test('buildSprintSummary: reviewer outlier produces a suggestion (non-doer role fix)', () => {
  // Reviewer actual is far above estimate -> should produce a suggestion.
  // BSS_QUOTE M-bucket sonnet: reviewerTokens=560 per task, estCycles=1.5 -> 840 est total.
  // We set actual reviewer tokens to 5000 (>>200% outlier threshold).
  const analysis = {
    actualCycles: 2,
    analysisText: '#### Sprint cost analysis\nstub\n',
    byRole: {
      doer:     { tokens: 1400, costUsd: 0.021, dispatches: 1 },
      reviewer: { tokens: 5000, costUsd: 0.075, dispatches: 1 }, // big outlier
    },
    totEstOutputUsd: 0.030,
    totActUsd: 0.096,
  };
  const { summaryText } = buildSprintSummary(analysis, BSS_QUOTE, DEFAULT_CALIBRATION, {
    branch: 'feat/test', goal: 'g', goalMet: false, cycleCount: 2,
    tasksCompleted: 1, tasksOpen: 0, startedAt: '20260620',
  });
  assert.ok(summaryText.includes('reviewer'), 'reviewer outlier suggestion must mention reviewer');
  assert.ok(summaryText.includes('over'), 'suggestion must say over estimate');
  assert.match(summaryText, /Suggested calibration adjustments/, 'must have suggestions section');
  // AC criterion 4: goalMet=false must render NOT MET
  assert.ok(summaryText.includes('NOT MET'), 'goalMet=false must render NOT MET');
});

test('buildSprintSummary: doer-only outlier produces suggestion but reviewer (within range) does not', () => {
  // doer: est=2100, actual=8000 -> big outlier
  // reviewer: est=840, actual=800 -> within range
  const analysis = {
    actualCycles: 2,
    analysisText: '#### Sprint cost analysis\nstub\n',
    byRole: {
      doer:     { tokens: 8000, costUsd: 0.12, dispatches: 1 },
      reviewer: { tokens:  800, costUsd: 0.012, dispatches: 1 },
    },
    totEstOutputUsd: 0.030,
    totActUsd: 0.132,
  };
  const { summaryText } = buildSprintSummary(analysis, BSS_QUOTE, DEFAULT_CALIBRATION, {
    branch: 'feat/test', goal: 'g', goalMet: false, cycleCount: 2,
    tasksCompleted: 1, tasksOpen: 0, startedAt: '20260620',
  });
  assert.ok(summaryText.includes('doer'), 'doer outlier suggestion must mention doer');
  // reviewer was NOT an outlier -- verify we did not emit a reviewer suggestion
  // (we check that the suggestion section doesn't say "reviewer ... over/under")
  const suggestStart = summaryText.indexOf('### Suggested calibration adjustments');
  const suggestRegion = summaryText.slice(suggestStart);
  assert.doesNotMatch(suggestRegion, /`reviewer`/, 'reviewer within range must not produce suggestion');
});

test('buildSprintSummary: overhead role outlier produces suggestion', () => {
  // harvester: fixed_overhead_tokens.harvester = 3000 (per DEFAULT_CALIBRATION)
  // actual = 15000 (5x -> 400% over, exceeds outlier_pct=200)
  const analysis = {
    actualCycles: 1,
    analysisText: '#### Sprint cost analysis\nstub\n',
    byRole: {
      doer:      { tokens: 1400, costUsd: 0.021, dispatches: 1 },
      reviewer:  { tokens:  560, costUsd: 0.008, dispatches: 1 },
      harvester: { tokens: 15000, costUsd: 0.225, dispatches: 1 },
    },
    totEstOutputUsd: 0.05,
    totActUsd: 0.254,
  };
  const { summaryText } = buildSprintSummary(analysis, BSS_QUOTE, DEFAULT_CALIBRATION, {
    branch: 'feat/test', goal: 'g', goalMet: false, cycleCount: 1,
    tasksCompleted: 1, tasksOpen: 0, startedAt: '20260620',
  });
  const suggestStart = summaryText.indexOf('### Suggested calibration adjustments');
  const suggestRegion = summaryText.slice(suggestStart);
  assert.match(suggestRegion, /harvester/, 'harvester outlier must appear in suggestions');
  assert.match(suggestRegion, /over/, 'suggestion must say over estimate');
});

test('buildSprintSummary: no outliers => no-outliers message', () => {
  // All actuals at exactly the estimate -> no suggestions
  const analysis = {
    actualCycles: 1,
    analysisText: '#### Sprint cost analysis\nstub\n',
    byRole: {
      doer:     { tokens: 1400, costUsd: 0.021, dispatches: 1 },
      reviewer: { tokens:  560, costUsd: 0.008, dispatches: 1 },
    },
    totEstOutputUsd: 0.029,
    totActUsd: 0.029,
  };
  const { summaryText } = buildSprintSummary(analysis, BSS_QUOTE, DEFAULT_CALIBRATION, {
    branch: 'feat/test', goal: 'g', goalMet: true, cycleCount: 1,
    tasksCompleted: 1, tasksOpen: 0, startedAt: '20260620',
  });
  assert.match(summaryText, /No outliers detected/, 'should show no-outliers message when all within range');
});

test('buildSprintSummary: null analysis returns graceful summary', () => {
  const { summaryText } = buildSprintSummary(null, null, DEFAULT_CALIBRATION, {
    branch: 'feat/test', goal: 'g', goalMet: false, cycleCount: 0,
    tasksCompleted: 0, tasksOpen: 0, startedAt: '',
  });
  assert.ok(typeof summaryText === 'string', 'summaryText must be a string even with null inputs');
  assert.ok(summaryText.includes('# Sprint summary'), 'must include sprint summary header');
});

// -- buildExecutionSummary -----------------------------------------------------

const BES_LOG = [
  { cycle: 1, phase: 'Plan',    label: 'plan-commit-c1',   model: MODEL_OPUS,   outTokens: 1200, costUsd: 0.018, ts: '2026-06-26T10:00:00Z' },
  { cycle: 1, phase: 'Develop', label: 'iter-c1-i1 BD-1',  model: MODEL_SONNET, outTokens: 3000, costUsd: 0.045, ts: '2026-06-26T10:05:00Z' },
  { cycle: 1, phase: 'Develop', label: 'iter-c1-i2 BD-1',  model: MODEL_SONNET, outTokens: 2500, costUsd: 0.037, ts: '2026-06-26T10:12:00Z' },
  { cycle: 1, phase: 'Test',    label: 'CHANGES NEEDED',   model: MODEL_SONNET, outTokens:  800, costUsd: 0.012, ts: '2026-06-26T10:20:00Z' },
  { cycle: 1, phase: 'Harvest', label: 'reset-orphans',    model: MODEL_HAIKU,  outTokens:  400, costUsd: 0.001, ts: '2026-06-26T10:30:00Z' },
];

test('buildExecutionSummary: returns markdown with required sections', () => {
  const { summaryText } = buildExecutionSummary(BES_LOG, {
    cycleCount: 2, goalMet: true, goal: 'ship', tasksOpen: 0,
    openIssueIds: [], startedAt: '20260626_100000',
  });
  assert.ok(typeof summaryText === 'string', 'summaryText must be a string');
  assert.ok(summaryText.includes('Sprint Execution Summary'), 'must include section title');
  assert.ok(summaryText.includes('Per-phase breakdown'), 'must include per-phase breakdown');
  assert.ok(summaryText.includes('**Cycles:** 2'), 'must include cycle count');
  // per-phase summed outTokens for Develop = 3000 + 2500 = 5500
  assert.ok(summaryText.includes('5500'), 'Develop phase must sum outTokens');
  // cycle reasoning: 2 develop iterations + reviewer change + plan round
  assert.ok(summaryText.includes('develop iteration'), 'must note develop iterations');
});

test('buildExecutionSummary: detects failures and retries', () => {
  const { summaryText } = buildExecutionSummary(BES_LOG, {
    cycleCount: 1, goalMet: true, goal: 'g', tasksOpen: 0, openIssueIds: [],
  });
  assert.ok(summaryText.includes('orphan reset'), 'must list orphan reset failure');
  assert.match(summaryText, /develop iterations \(retries\)/, 'must flag multi-iteration retry');
});

test('buildExecutionSummary: timing best-effort with timestamps', () => {
  const { summaryText } = buildExecutionSummary(BES_LOG, { cycleCount: 1, goalMet: true });
  // Develop has 2 timestamped events 7 min apart -> ~420s span reported
  assert.match(summaryText, /Develop: ~420s/, 'must compute Develop timing span from ts');
});

test('buildExecutionSummary: timing n/a when no timestamps', () => {
  const noTs = BES_LOG.map(({ ts, ...rest }) => rest);
  const { summaryText } = buildExecutionSummary(noTs, { cycleCount: 1, goalMet: true });
  assert.match(summaryText, /n\/a \(no timestamps\)/, 'must emit n/a when ts missing');
});

test('buildExecutionSummary: goalMet=false lists risks', () => {
  const { summaryText } = buildExecutionSummary(BES_LOG, {
    cycleCount: 1, goalMet: false, goal: 'finish feature', tasksOpen: 2,
    openIssueIds: ['BD-9', 'BD-10'],
  });
  assert.ok(summaryText.includes('Goal NOT met'), 'must flag goal not met');
  assert.ok(summaryText.includes('finish feature'), 'must include the goal text');
  assert.ok(summaryText.includes('BD-9') && summaryText.includes('BD-10'), 'must list open issue ids');
  assert.ok(summaryText.includes('2 task(s) still open'), 'must include open task count');
});

test('buildExecutionSummary: empty log still returns valid section', () => {
  const { summaryText } = buildExecutionSummary([], {
    cycleCount: 0, goalMet: false, goal: '', tasksOpen: 0, openIssueIds: [],
  });
  assert.ok(typeof summaryText === 'string', 'must return a string for empty log');
  assert.ok(summaryText.includes('Sprint Execution Summary'), 'must include section title');
  assert.ok(summaryText.includes('Per-phase breakdown'), 'must include per-phase table');
  // all phase rows present with zero counts
  for (const ph of ['Plan', 'Develop', 'Test', 'Harvest']) {
    assert.ok(summaryText.includes(`| ${ph} | 0 |`), `phase ${ph} row must show 0 dispatches`);
  }
});
