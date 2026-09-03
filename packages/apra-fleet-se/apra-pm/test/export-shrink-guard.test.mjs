import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseIds,
  computeDroppedIds,
  runExportShrinkGuard,
} from '../lib/export-shrink-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD_SCRIPT = join(HERE, '../lib/export-shrink-guard.mjs');
const WORKFLOW_SRC = readFileSync(
  join(HERE, '../.claude/workflows/auto-sprint.js'), 'utf-8'
);

// Extract the PURE_FUNCTIONS block so buildExportShrinkGuardCmd's actual OUTPUT can be
// executed for real (my-beads-db-27m.12 round-2: a string-shape regex assertion let a
// syntactically-invalid `node -e "..."` command -- broken by JSON.stringify(repoPath)
// emitting double quotes into an outer double-quoted shell string -- pass review).
const pureFnMatch = WORKFLOW_SRC.match(/\/\/ PURE_FUNCTIONS_BEGIN[^\n]*\n([\s\S]*?)\/\/ PURE_FUNCTIONS_END/);
if (!pureFnMatch) throw new Error('PURE_FUNCTIONS_BEGIN/END markers not found');
// eslint-disable-next-line no-new-func
const { buildExportShrinkGuardCmd } =
  new Function(`${pureFnMatch[1]}; return { buildExportShrinkGuardCmd };`)();

// The inline copy is dispatched to a shell (bash, per the dispatched-agent convention this
// file uses throughout), never spawned directly -- so it must be executed through a real
// shell, not just called as a JS function, to catch quoting breakage.
function runInlineGuardCmd(repo) {
  const cmd = buildExportShrinkGuardCmd(repo);
  return execFileSync('bash', ['-c', cmd], { cwd: repo, encoding: 'utf8' });
}

function jsonl(ids) {
  return ids.map((id) => JSON.stringify({ id, title: id })).join('\n') + '\n';
}

// Builds a real temp git repo with a committed .beads/issues.jsonl containing
// `committedIds`, then overwrites the file on disk (unstaged) with `freshIds`
// -- mirroring what `bd export -o .beads/issues.jsonl` does before the guard runs.
function makeRepoFixture(committedIds, freshIds) {
  const repo = mkdtempSync(join(tmpdir(), 'export-shrink-guard-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.local', 'config', 'commit.gpgsign', 'false'], { cwd: repo });
  mkdirSync(join(repo, '.beads'), { recursive: true });
  writeFileSync(join(repo, '.beads', 'issues.jsonl'), jsonl(committedIds));
  execFileSync('git', ['add', '.beads/issues.jsonl'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t.local', 'commit', '-m', 'seed'],
    { cwd: repo }
  );
  // Now simulate `bd export` overwriting the working-tree file with a divergent set.
  writeFileSync(join(repo, '.beads', 'issues.jsonl'), jsonl(freshIds));
  return repo;
}

function stagedContent(repo) {
  try {
    return execFileSync('git', ['show', ':.beads/issues.jsonl'], { cwd: repo, encoding: 'utf8' });
  } catch {
    return null;
  }
}

// ---- parseIds / computeDroppedIds (pure) -------------------------------------

test('parseIds extracts ids from jsonl, ignoring blank/malformed lines', () => {
  const text = jsonl(['a', 'b']) + '\nnot json\n' + JSON.stringify({ noId: true }) + '\n';
  assert.deepEqual([...parseIds(text)].sort(), ['a', 'b']);
});

test('parseIds on empty/missing text returns empty set', () => {
  assert.deepEqual([...parseIds('')], []);
  assert.deepEqual([...parseIds(undefined)], []);
});

test('computeDroppedIds returns committed ids missing from the fresh export', () => {
  const before = jsonl(['a', 'b', 'c']);
  const after = jsonl(['a', 'x']); // b, c dropped; x is new -- irrelevant to "dropped"
  assert.deepEqual(computeDroppedIds(before, after).sort(), ['b', 'c']);
});

test('computeDroppedIds returns [] for a pure superset (incremental export)', () => {
  const before = jsonl(['a', 'b']);
  const after = jsonl(['a', 'b', 'c']);
  assert.deepEqual(computeDroppedIds(before, after), []);
});

// ---- runExportShrinkGuard against a real git repo (no mocks) -----------------

test('disjoint export: guard refuses to stage without opt-in, leaves index at old content', () => {
  const repo = makeRepoFixture(['id-1', 'id-2', 'id-3'], ['id-9', 'id-10']);
  const result = runExportShrinkGuard(repo);

  assert.equal(result.staged, false);
  assert.deepEqual(result.dropped.sort(), ['id-1', 'id-2', 'id-3']);

  // Nothing new got staged -- the index still matches the last commit.
  const staged = stagedContent(repo);
  assert.match(staged, /id-1/);
  assert.doesNotMatch(staged, /id-9/);
});

test('disjoint export: explicit opt-in stages the shrinking export anyway', () => {
  const repo = makeRepoFixture(['id-1', 'id-2', 'id-3'], ['id-9', 'id-99']);
  const result = runExportShrinkGuard(repo, { allowShrink: true });

  assert.equal(result.staged, true);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.dropped.sort(), ['id-1', 'id-2', 'id-3']);

  const staged = stagedContent(repo);
  assert.match(staged, /id-9/);
  assert.doesNotMatch(staged, /"id-1"/);
});

test('superset export (normal incremental export): guard stages it unchanged', () => {
  const repo = makeRepoFixture(['id-1', 'id-2'], ['id-1', 'id-2', 'id-3']);
  const result = runExportShrinkGuard(repo);

  assert.equal(result.staged, true);
  assert.deepEqual(result.dropped, []);

  const staged = stagedContent(repo);
  assert.match(staged, /id-1/);
  assert.match(staged, /id-2/);
  assert.match(staged, /id-3/);
});

// ---- CLI entry point (spawned as a real subprocess, like the dispatched shell) ----

test('CLI: refuses and exits 0 on a disjoint export without the env opt-in', () => {
  const repo = makeRepoFixture(['id-1', 'id-2'], ['id-9']);
  const out = execFileSync('node', [GUARD_SCRIPT, repo], { encoding: 'utf8' });
  assert.match(out, /EXPORT_GUARD_REFUSED/);
  assert.match(out, /AUTO_SPRINT_ALLOW_EXPORT_SHRINK=1/);
  assert.doesNotMatch(stagedContent(repo), /id-9/);
});

test('CLI: AUTO_SPRINT_ALLOW_EXPORT_SHRINK=1 stages a disjoint export', () => {
  const repo = makeRepoFixture(['id-1', 'id-2'], ['id-9']);
  const out = execFileSync('node', [GUARD_SCRIPT, repo], {
    encoding: 'utf8',
    env: { ...process.env, AUTO_SPRINT_ALLOW_EXPORT_SHRINK: '1' },
  });
  assert.match(out, /EXPORT_GUARD_OK/);
  assert.match(out, /override used/);
  assert.match(stagedContent(repo), /id-9/);
});

test('CLI: a normal superset export stages unchanged (OK, no override note)', () => {
  const repo = makeRepoFixture(['id-1'], ['id-1', 'id-2']);
  const out = execFileSync('node', [GUARD_SCRIPT, repo], { encoding: 'utf8' });
  assert.match(out, /EXPORT_GUARD_OK/);
  assert.doesNotMatch(out, /override used/);
});

// ---- inline auto-sprint.js copy: executed for real through a shell --------------
// (my-beads-db-27m.12 round-2 reopen: the earlier version of these tests only regexed
// the command STRING and never ran it, so a `node -e "..."` broken by JSON.stringify
// emitting inner double quotes passed review. These spawn the real generated command.)

test('inline guard cmd: disjoint export refuses to stage, exits 0, leaves index unchanged', () => {
  const repo = makeRepoFixture(['id-1', 'id-2', 'id-3'], ['id-9', 'id-10']);
  const out = runInlineGuardCmd(repo);

  assert.match(out, /EXPORT_GUARD_REFUSED/);
  assert.match(out, /AUTO_SPRINT_ALLOW_EXPORT_SHRINK=1/);
  assert.doesNotMatch(stagedContent(repo), /id-9/);
  assert.match(stagedContent(repo), /id-1/);
});

test('inline guard cmd: superset export (normal incremental export) stages unchanged', () => {
  const repo = makeRepoFixture(['id-1', 'id-2'], ['id-1', 'id-2', 'id-3']);
  const out = runInlineGuardCmd(repo);

  assert.match(out, /EXPORT_GUARD_OK/);
  assert.doesNotMatch(out, /override used/);
  const staged = stagedContent(repo);
  assert.match(staged, /id-1/);
  assert.match(staged, /id-2/);
  assert.match(staged, /id-3/);
});

test('inline guard cmd: AUTO_SPRINT_ALLOW_EXPORT_SHRINK=1 stages a disjoint export anyway', () => {
  const repo = makeRepoFixture(['id-1', 'id-2', 'id-3'], ['id-9', 'id-99']);
  const cmd = buildExportShrinkGuardCmd(repo);
  const out = execFileSync('bash', ['-c', cmd], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, AUTO_SPRINT_ALLOW_EXPORT_SHRINK: '1' },
  });

  assert.match(out, /EXPORT_GUARD_OK/);
  assert.match(out, /override used/);
  assert.match(stagedContent(repo), /id-9/);
});

test('inline guard cmd: repo path containing a space survives the shell round-trip', () => {
  // Regression target for the exact defect: JSON.stringify(repoPath) broke the outer
  // double-quoted `node -e "..."` string for EVERY path, but a path with a space is
  // also the case the fix's `"${repoPath}"` shell-arg quoting must handle correctly.
  const parent = mkdtempSync(join(tmpdir(), 'export-shrink-guard-'));
  const repo = join(parent, 'has space');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.local', 'config', 'commit.gpgsign', 'false'], { cwd: repo });
  mkdirSync(join(repo, '.beads'), { recursive: true });
  writeFileSync(join(repo, '.beads', 'issues.jsonl'), jsonl(['id-1']));
  execFileSync('git', ['add', '.beads/issues.jsonl'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.local', 'commit', '-m', 'seed'], { cwd: repo });
  writeFileSync(join(repo, '.beads', 'issues.jsonl'), jsonl(['id-1', 'id-2']));

  const out = runInlineGuardCmd(repo);
  assert.match(out, /EXPORT_GUARD_OK/);
  assert.match(stagedContent(repo), /id-2/);
});

// ---- source introspection: the inline auto-sprint.js copy stays wired in --------

test('plan-commit block calls buildExportShrinkGuardCmd instead of an unguarded git add', () => {
  const idx = src_indexOf('const planCommitCmds = [');
  const region = WORKFLOW_SRC.slice(idx, idx + 700);
  assert.match(region, /buildExportShrinkGuardCmd\(repo\)/,
    'plan-commit must stage .beads/issues.jsonl via the shrink guard, not a raw git add');
  assert.doesNotMatch(region, /git -C "\$\{repo\}" add \.beads\/issues\.jsonl/,
    'plan-commit must not contain the old unguarded git add line');
});

test('beads-export-cleanup (harvest) step calls buildExportShrinkGuardCmd instead of an unguarded git add', () => {
  const idx = src_indexOf("label: 'beads-export-cleanup'");
  const region = WORKFLOW_SRC.slice(Math.max(0, idx - 3000), idx);
  assert.match(region, /buildExportShrinkGuardCmd\(repo\)/,
    'harvest export step must stage .beads/issues.jsonl via the shrink guard, not a raw git add');
  assert.doesNotMatch(region, /git -C "\$\{repo\}" add \.beads\/issues\.jsonl/,
    'harvest export step must not contain the old unguarded git add line');
});

test('AUTO_SPRINT_ALLOW_EXPORT_SHRINK opt-in is documented in the inline guard builder', () => {
  assert.match(WORKFLOW_SRC, /AUTO_SPRINT_ALLOW_EXPORT_SHRINK/);
});

function src_indexOf(needle) {
  const idx = WORKFLOW_SRC.indexOf(needle);
  assert.ok(idx >= 0, `expected to find "${needle}" in auto-sprint.js`);
  return idx;
}
