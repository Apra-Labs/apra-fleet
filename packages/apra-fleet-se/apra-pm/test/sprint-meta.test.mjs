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
  computeSprintAnalysis,
  computeSprintQuote,
  DEFAULT_CALIBRATION,
  MODEL_SONNET,
  // eslint-disable-next-line no-new-func
} = new Function(`${match[1]}; return { computeSprintAnalysis, computeSprintQuote, DEFAULT_CALIBRATION, MODEL_SONNET };`)();

// ---- meta record shape (source-introspection) --------------------------------

test('meta record source contains required fields: type meta, transcriptDir, branch, roots, goal, ts', () => {
  // Assert the inline meta record construction includes all required keys.
  // This mirrors how shell-dispatch.test.mjs validates source invariants.
  const metaBlock = src.slice(src.indexOf('SPRINT META RECORD'));
  const end = metaBlock.indexOf('\n}\n', 10);
  const region = end > 0 ? metaBlock.slice(0, end + 3) : metaBlock.slice(0, 600);

  assert.match(region, /type:\s*['"]meta['"]/, "meta record must have type='meta'");
  assert.match(region, /transcriptDir/, 'meta record must include transcriptDir');
  assert.match(region, /branch/, 'meta record must include branch');
  assert.match(region, /roots/, 'meta record must include roots');
  assert.match(region, /goal/, 'meta record must include goal');
  assert.match(region, /startedAt|ts/, 'meta record must include a sprint timestamp field');
});

test('meta record is written before the sprint loop (genuine first JSONL entry)', () => {
  // The meta dispatch should appear before the SPRINT LOOP section.
  const metaIdx = src.indexOf('SPRINT META RECORD');
  const sprintLoopIdx = src.indexOf('SPRINT LOOP');
  assert.ok(metaIdx > 0, 'SPRINT META RECORD marker must exist');
  assert.ok(sprintLoopIdx > 0, 'SPRINT LOOP marker must exist');
  assert.ok(metaIdx < sprintLoopIdx, 'meta record dispatch must appear before SPRINT LOOP');
});

// ---- computeSprintAnalysis ignores meta entries -------------------------------

const SAMPLE_QUOTE = computeSprintQuote(
  [{ id: 'BD-1', bucket: 'M', model: MODEL_SONNET }],
  DEFAULT_CALIBRATION
);

test('computeSprintAnalysis: type=meta entry with no label is excluded from byRole', () => {
  const logEntries = [
    // meta entry -- no label field
    { ts: '20260620_100000', type: 'meta', branch: 'feat/x', roots: ['BD-0'], goal: 'ship it',
      transcriptDir: '/home/user/.claude/projects/C--repo' },
    // real entries
    { label: 'doer-c1-i0',  outTokens: 1200, costUsd: 0.018 },
    { label: 'reviewer-c1', outTokens:  450, costUsd: 0.006 },
  ];
  const r = computeSprintAnalysis(SAMPLE_QUOTE, logEntries, DEFAULT_CALIBRATION, 1);
  // meta entry has no label -> roleOf('') returns '' -> skipped
  assert.ok(!('meta' in r.byRole), 'meta should not appear as a role in byRole');
  assert.ok(!('undefined' in r.byRole), 'undefined should not appear as a role in byRole');
  // only real entries should be present
  assert.deepEqual(Object.keys(r.byRole).sort(), ['doer', 'reviewer']);
});

test('computeSprintAnalysis: meta entry does not inflate token or cost totals', () => {
  const withMeta = [
    { ts: '20260620_100000', type: 'meta', branch: 'feat/x', roots: ['BD-0'], goal: 'g',
      transcriptDir: '' },
    { label: 'doer-c1-i0', outTokens: 1000, costUsd: 0.015 },
  ];
  const withoutMeta = [
    { label: 'doer-c1-i0', outTokens: 1000, costUsd: 0.015 },
  ];
  const rWith    = computeSprintAnalysis(SAMPLE_QUOTE, withMeta,    DEFAULT_CALIBRATION, 1);
  const rWithout = computeSprintAnalysis(SAMPLE_QUOTE, withoutMeta, DEFAULT_CALIBRATION, 1);

  assert.ok(Math.abs(rWith.totActUsd - rWithout.totActUsd) < 1e-9,
    'totActUsd must be identical with and without a meta entry');
  assert.equal(rWith.byRole['doer'].tokens, rWithout.byRole['doer'].tokens,
    'doer token count must not be affected by a meta entry');
});

test('computeSprintAnalysis: meta entry with empty label does not create phantom role', () => {
  const logEntries = [
    { label: '', type: 'meta', outTokens: 999, costUsd: 0.1 },
    { label: 'harvester', outTokens: 800, costUsd: 0.012 },
  ];
  const r = computeSprintAnalysis(SAMPLE_QUOTE, logEntries, DEFAULT_CALIBRATION, 1);
  // empty label -> roleOf('') = '' -> skipped; only harvester should appear
  assert.deepEqual(Object.keys(r.byRole), ['harvester']);
  assert.equal(r.byRole['harvester'].tokens, 800);
});

test('computeSprintAnalysis: analysisText is unaffected by presence of meta entry', () => {
  const base = [{ label: 'doer-c1-i0', outTokens: 1200, costUsd: 0.018 }];
  const withMeta = [
    { ts: '20260620', type: 'meta', branch: 'b', roots: [], goal: 'g', transcriptDir: '' },
    ...base,
  ];
  const r1 = computeSprintAnalysis(SAMPLE_QUOTE, base,     DEFAULT_CALIBRATION, 1);
  const r2 = computeSprintAnalysis(SAMPLE_QUOTE, withMeta, DEFAULT_CALIBRATION, 1);
  assert.equal(r1.analysisText, r2.analysisText,
    'analysisText must be identical regardless of meta entries');
});
