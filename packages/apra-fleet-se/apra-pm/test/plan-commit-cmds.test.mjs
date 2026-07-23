import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// Extract the PURE_FUNCTIONS block so we can call computeSprintQuote.
const match = src.match(/\/\/ PURE_FUNCTIONS_BEGIN[^\n]*\n([\s\S]*?)\/\/ PURE_FUNCTIONS_END/);
if (!match) throw new Error('PURE_FUNCTIONS_BEGIN/END markers not found');
// eslint-disable-next-line no-new-func
const { computeSprintQuote, DEFAULT_CALIBRATION } =
  new Function(`${match[1]}; return { computeSprintQuote, DEFAULT_CALIBRATION };`)();

// ---- helpers -----------------------------------------------------------------

/** Build planCommitCmds for a given sprintQuote, mirroring the auto-sprint.js logic. */
function buildPlanCommitCmds(sprintQuote, repo, branch) {
  return [
    ...sprintQuote.tasks.map(t =>
      `bd update ${t.id} --notes="cost-estimate: bucket=${t.bucket} model=${t.model} ` +
      `doer_tokens=${t.doerTokens} reviewer_tokens=${t.reviewerTokens} output_usd=${t.outputUsd.toFixed(4)}"`
    ),
    `bd export -o "${repo}/.beads/issues.jsonl"`,
    `git -C "${repo}" add .beads/issues.jsonl`,
    `git -C "${repo}" -c user.name='pm' -c user.email='pm@pm.local' commit --allow-empty -m "plan: approve task DAG"`,
    `git -C "${repo}" push origin ${branch}`,
  ];
}

// ---- source-level assertions -------------------------------------------------

test('planCommitCmds array starts with per-task bd update commands (source check)', () => {
  const cmdsIdx = src.indexOf('const planCommitCmds = [');
  assert.ok(cmdsIdx >= 0, 'planCommitCmds array must exist in source');

  const region = src.slice(cmdsIdx, cmdsIdx + 400);
  assert.match(region, /bd update \$\{t\.id\}/,
    'planCommitCmds must start with per-task bd update commands');
  assert.match(region, /cost-estimate:/,
    'per-task command must include cost-estimate: prefix');
});

test('planCommitCmds array appends bd export after per-task updates (source check)', () => {
  const cmdsIdx = src.indexOf('const planCommitCmds = [');
  const region = src.slice(cmdsIdx, cmdsIdx + 500);

  // bd export must appear after the per-task spread.
  const spreadIdx = region.indexOf('...sprintQuote.tasks');
  const exportIdx = region.indexOf('bd export');
  assert.ok(spreadIdx >= 0, '...sprintQuote.tasks spread must be in planCommitCmds');
  assert.ok(exportIdx > spreadIdx, 'bd export must come after per-task update spread');
});

test('planCommitCmds ends with git add, git commit, git push in order (source check)', () => {
  const cmdsIdx = src.indexOf('const planCommitCmds = [');
  const region = src.slice(cmdsIdx, cmdsIdx + 600);

  const addIdx    = region.indexOf('git -C "${repo}" add .beads/issues.jsonl');
  const commitIdx = region.indexOf('git -C "${repo}" -c user.name=\'pm\'');
  const pushIdx   = region.indexOf('git -C "${repo}" push origin ${branch}');

  assert.ok(addIdx    >= 0, 'planCommitCmds must include git add');
  assert.ok(commitIdx >= 0, 'planCommitCmds must include git commit');
  assert.ok(pushIdx   >= 0, 'planCommitCmds must include git push');
  assert.ok(addIdx < commitIdx, 'git add must come before git commit');
  assert.ok(commitIdx < pushIdx, 'git commit must come before git push');
});

test('dispatchShell maxTurns is planCommitCmds.length + 2 (source check)', () => {
  // The maxTurns expression must appear somewhere after the planCommitCmds array definition.
  const cmdsIdx = src.indexOf('const planCommitCmds = [');
  assert.ok(cmdsIdx >= 0, 'planCommitCmds array must exist');
  // Search within the next 800 chars for the maxTurns assignment.
  const afterCmds = src.slice(cmdsIdx, cmdsIdx + 800);
  assert.match(afterCmds, /maxTurns:\s*planCommitCmds\.length\s*\+\s*2/,
    'dispatchShell must use maxTurns = planCommitCmds.length + 2');
});

// ---- JS command-builder functional test --------------------------------------

test('buildPlanCommitCmds emits correct per-task bd update commands', () => {
  const taskAssignments = [
    { id: 'BD-1', bucket: 'S', model: 'standard' },
    { id: 'BD-2', bucket: 'M', model: 'premium' },
  ];
  const sprintQuote = computeSprintQuote(taskAssignments, DEFAULT_CALIBRATION);
  const cmds = buildPlanCommitCmds(sprintQuote, '/repo', 'feat/x');

  // First N commands must be per-task bd update commands.
  const taskCount = taskAssignments.length;
  for (let i = 0; i < taskCount; i++) {
    assert.match(cmds[i], /^bd update BD-[12] --notes="cost-estimate:/,
      `command[${i}] must be a bd update with cost-estimate`);
    assert.match(cmds[i], /bucket=[SM]/,     `command[${i}] must include bucket`);
    assert.match(cmds[i], /model=(standard|premium)/, `command[${i}] must include model`);
    assert.match(cmds[i], /doer_tokens=\d+/,  `command[${i}] must include doer_tokens`);
    assert.match(cmds[i], /reviewer_tokens=\d+/, `command[${i}] must include reviewer_tokens`);
    assert.match(cmds[i], /output_usd=\d+\.\d{4}/, `command[${i}] must include output_usd`);
  }
});

test('buildPlanCommitCmds appends bd export then git add/commit/push after per-task updates', () => {
  const taskAssignments = [
    { id: 'BD-3', bucket: 'L', model: 'standard' },
    { id: 'BD-4', bucket: 'S', model: 'standard' },
    { id: 'BD-5', bucket: 'M', model: 'standard' },
  ];
  const sprintQuote = computeSprintQuote(taskAssignments, DEFAULT_CALIBRATION);
  const cmds = buildPlanCommitCmds(sprintQuote, '/workspace/repo', 'feat/sprint');

  const N = taskAssignments.length; // 3

  // Command at index N: bd export
  assert.match(cmds[N], /^bd export -o /,
    `command[${N}] must be bd export`);
  // Command at index N+1: git add
  assert.match(cmds[N + 1], /git.*add .beads\/issues\.jsonl/,
    `command[${N + 1}] must be git add .beads/issues.jsonl`);
  // Command at index N+2: git commit
  assert.match(cmds[N + 2], /git.*commit.*plan: approve task DAG/,
    `command[${N + 2}] must be git commit with "plan: approve task DAG"`);
  // Command at index N+3: git push
  assert.match(cmds[N + 3], /git.*push origin feat\/sprint/,
    `command[${N + 3}] must be git push origin feat/sprint`);
  // Total length: N tasks + 4 fixed commands
  assert.equal(cmds.length, N + 4, `total commands must be ${N} tasks + 4 fixed`);
});

test('maxTurns formula: commands.length + 2 for sample taskAssignments', () => {
  const taskAssignments = [
    { id: 'BD-10', bucket: 'S', model: 'standard' },
    { id: 'BD-11', bucket: 'M', model: 'standard' },
  ];
  const sprintQuote = computeSprintQuote(taskAssignments, DEFAULT_CALIBRATION);
  const cmds = buildPlanCommitCmds(sprintQuote, '/repo', 'main');

  // maxTurns per source: planCommitCmds.length + 2
  const expectedMaxTurns = cmds.length + 2;
  // N tasks (2) + 4 fixed + 2 = 8
  assert.equal(expectedMaxTurns, 8,
    'maxTurns for 2 tasks must be 2+4+2 = 8');
});

test('maxTurns grows with task count (N tasks + 4 fixed + 2)', () => {
  const makeTask = (id) => ({ id, bucket: 'S', model: 'standard' });
  for (const n of [1, 3, 5]) {
    const tasks = Array.from({ length: n }, (_, i) => makeTask(`BD-${i}`));
    const quote = computeSprintQuote(tasks, DEFAULT_CALIBRATION);
    const cmds = buildPlanCommitCmds(quote, '/repo', 'feat/x');
    const maxTurns = cmds.length + 2;
    assert.equal(maxTurns, n + 4 + 2,
      `maxTurns for ${n} tasks must be ${n + 6}`);
  }
});
