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
  buildExecutionSummary,
  buildSprintSummary,
  // eslint-disable-next-line no-new-func
} = new Function(`${match[1]}; return { buildExecutionSummary, buildSprintSummary };`)();

// -- shared sample logEntries --------------------------------------------------

const SAMPLE_LOG = [
  { cycle: 1, phase: 'Plan',    label: 'plan-commit-c1',   outTokens:  900, costUsd: 0.013, ts: '2026-06-26T09:00:00Z' },
  { cycle: 1, phase: 'Develop', label: 'iter-c1-i0',       outTokens: 2800, costUsd: 0.042, ts: '2026-06-26T09:05:00Z' },
  { cycle: 1, phase: 'Develop', label: 'iter-c1-i1',       outTokens: 2200, costUsd: 0.033, ts: '2026-06-26T09:18:00Z' },
  { cycle: 1, phase: 'Test',    label: 'CHANGES NEEDED',   outTokens:  700, costUsd: 0.010, ts: '2026-06-26T09:25:00Z' },
  { cycle: 1, phase: 'Harvest', label: 'harvester',        outTokens:  600, costUsd: 0.009, ts: '2026-06-26T09:35:00Z' },
];

test('buildExecutionSummary: per-phase cost totals appear in output', () => {
  // Plan costUsd = 0.013 -> $0.0130
  const { summaryText } = buildExecutionSummary(SAMPLE_LOG, {
    cycleCount: 1, goalMet: true, goal: 'g', tasksOpen: 0, openIssueIds: [],
  });
  assert.ok(summaryText.includes('$0.0130'), 'Plan phase cost $0.0130 must appear');
});

// -- Assertions unique to this file (the rest were duplicates of sprint-cost.test.mjs)

test('buildExecutionSummary: reviewer feedback round noted when CHANGES NEEDED label present', () => {
  const { summaryText } = buildExecutionSummary(SAMPLE_LOG, {
    cycleCount: 1, goalMet: true, goal: 'g', tasksOpen: 0, openIssueIds: [],
  });
  assert.match(summaryText, /reviewer CHANGES-NEEDED|CHANGES-NEEDED.*round/,
    'must note reviewer CHANGES NEEDED / feedback round');
});


test('buildExecutionSummary: goalMet=false risks section is non-empty', () => {
  const { summaryText } = buildExecutionSummary(SAMPLE_LOG, {
    cycleCount: 1, goalMet: false, goal: 'ship module', tasksOpen: 1,
    openIssueIds: ['BD-3'],
  });
  const risksIdx = summaryText.indexOf('Risks remaining');
  assert.ok(risksIdx >= 0, 'Risks remaining section must be present');
  const risksRegion = summaryText.slice(risksIdx);
  assert.doesNotMatch(risksRegion, /None -- goal met/,
    'risks section must NOT say "None -- goal met" when goalMet=false');
  assert.ok(risksRegion.includes('BD-3'), 'risks section must list open issue BD-3');
});

test('buildExecutionSummary: goalMet=true risks section shows none', () => {
  const { summaryText } = buildExecutionSummary(SAMPLE_LOG, {
    cycleCount: 1, goalMet: true, goal: 'ship it', tasksOpen: 0, openIssueIds: [],
  });
  assert.ok(summaryText.includes('_None -- goal met._'),
    'risks section must show "None -- goal met." when goal is met');
});


test('buildExecutionSummary: null logEntries handled gracefully', () => {
  assert.doesNotThrow(() => {
    const { summaryText } = buildExecutionSummary(null, {
      cycleCount: 0, goalMet: false, goal: '', tasksOpen: 0, openIssueIds: [],
    });
    assert.ok(typeof summaryText === 'string', 'must return string even with null logEntries');
  });
});

// -- 6. source-text wiring: buildExecutionSummary in Harvest flow --------------

test('buildExecutionSummary is called in the Harvest flow before the harvester dispatch', () => {
  // The call must appear before the harvester dispatch label.
  const execIdx = src.indexOf('buildExecutionSummary(logEntries');
  const harvestDispatch = src.indexOf("label: harvestLabel");
  assert.ok(execIdx >= 0,
    'buildExecutionSummary(logEntries, ...) call must exist in source');
  assert.ok(harvestDispatch >= 0,
    '"label: harvestLabel" must exist in source');
  assert.ok(execIdx < harvestDispatch,
    'buildExecutionSummary must be called before the harvester dispatch');
});

test('buildExecutionSummary output is appended to sprintSummary.summaryText', () => {
  // The result must be merged into sprintSummary so both sections flow to .analysis.md.
  assert.match(src, /sprintSummary\.summaryText\s*\+=.*executionSummary\.summaryText/,
    'executionSummary.summaryText must be appended to sprintSummary.summaryText');
});

test('harvester dispatch receives sprintSummary.summaryText (which includes execution summary)', () => {
  const harvestLabel = src.indexOf("label: harvestLabel");
  // Look backward for the prompt that the harvester receives (up to 2000 chars before the label).
  const region = src.slice(Math.max(0, harvestLabel - 2000), harvestLabel);
  assert.match(region, /sprintSummary\.summaryText/,
    'harvester dispatch prompt must embed sprintSummary.summaryText');
});

test('JS fallback path writes sprintSummary.summaryText (which includes execution summary)', () => {
  const fallbackIdx = src.indexOf('harvest-analysis-fallback');
  assert.ok(fallbackIdx >= 0, '"harvest-analysis-fallback" label must exist in source');
  const region = src.slice(Math.max(0, fallbackIdx - 1500), fallbackIdx);
  assert.match(region, /sprintSummary\.summaryText/,
    'JS fallback must write sprintSummary.summaryText (containing execution summary) to artifact');
});

test('buildExecutionSummary output reaches .analysis.md on both harvester and fallback paths', () => {
  // Wiring: executionSummary appended to sprintSummary -> sprintSummary used in both
  // harvester prompt AND fallback shell write.
  const appendMatch = src.match(
    /sprintSummary\.summaryText\s*\+=.*executionSummary\.summaryText/
  );
  assert.ok(appendMatch, 'executionSummary.summaryText must be appended to sprintSummary.summaryText');

  // Count how many times sprintSummary.summaryText flows to an artifact write (harvester + fallback).
  const harvestCount = (src.match(/sprintSummary\.summaryText/g) || []).length;
  assert.ok(harvestCount >= 3,
    'sprintSummary.summaryText must appear at least 3 times (append, harvester prompt, fallback)');
});
