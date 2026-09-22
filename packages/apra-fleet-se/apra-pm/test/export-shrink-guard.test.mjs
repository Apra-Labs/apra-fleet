import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, mkdirSync, readFileSync, chmodSync, unlinkSync, statSync,
} from 'node:fs';
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
const { buildExportShrinkGuardCmd, detectExportGuardIssue, exportGuardLogLine } =
  new Function(
    `${pureFnMatch[1]}; return { buildExportShrinkGuardCmd, detectExportGuardIssue, exportGuardLogLine };`
  )();

// The inline copy is dispatched to a member shell, never spawned directly -- so it must be
// executed through a real shell, not just called as a JS function, to catch quoting
// breakage. Member shells are POSIX or PowerShell, so use `sh` on POSIX and Windows
// PowerShell (-EncodedCommand, same wrapping as src/os/windows.ts) on Windows. bash is
// deliberately NOT required: it may be missing or resolve to WSL on Windows CI.
function runInlineGuardCmd(repo, env = process.env) {
  const cmd = buildExportShrinkGuardCmd(repo);
  if (process.platform === 'win32') {
    const encoded = Buffer.from(cmd, 'utf16le').toString('base64');
    return execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { cwd: repo, encoding: 'utf8', env }
    );
  }
  return execFileSync('sh', ['-c', cmd], { cwd: repo, encoding: 'utf8', env });
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
  const out = runInlineGuardCmd(repo, { ...process.env, AUTO_SPRINT_ALLOW_EXPORT_SHRINK: '1' });

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

// ---- fail-closed: >1 MB committed export, unreadable blob, absent path ------------
// (the old code read HEAD with Node's 1 MB default maxBuffer and an empty catch, so a
// real-sized export threw ENOBUFS and was treated as "nothing committed" -> unguarded.)

const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
const commitAll = (repo, msg) =>
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t.local', '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', msg]);

function bigIds(n) {
  return Array.from({ length: n }, (_, i) => `big-${i}`);
}
function bigJsonl(ids) {
  const pad = 'x'.repeat(120);
  return ids.map((id) => JSON.stringify({ id, title: id, description: pad })).join('\n') + '\n';
}
// Committed export well over 1 MB; the fresh export drops exactly one id.
function makeBigRepoFixture() {
  const repo = mkdtempSync(join(tmpdir(), 'export-shrink-guard-big-'));
  git(repo, ['init', '-q']);
  mkdirSync(join(repo, '.beads'), { recursive: true });
  const all = bigIds(12000);
  writeFileSync(join(repo, '.beads', 'issues.jsonl'), bigJsonl(all));
  git(repo, ['add', '.beads/issues.jsonl']);
  commitAll(repo, 'seed');
  assert.ok(statSync(join(repo, '.beads', 'issues.jsonl')).size > 1.2 * 1024 * 1024,
    'fixture must exceed the 1 MB default maxBuffer');
  writeFileSync(join(repo, '.beads', 'issues.jsonl'), bigJsonl(all.filter((id) => id !== 'big-777')));
  return repo;
}

// Committed export exists at HEAD (tree entry intact) but its blob is unreadable:
// delete the loose object so `git ls-tree` succeeds and `git show` fails.
function makeUnreadableBlobFixture() {
  const repo = makeRepoFixture(['id-1', 'id-2'], ['id-1', 'id-2', 'id-3']);
  const sha = git(repo, ['rev-parse', 'HEAD:.beads/issues.jsonl']).trim();
  const obj = join(repo, '.git', 'objects', sha.slice(0, 2), sha.slice(2));
  chmodSync(obj, 0o666);
  unlinkSync(obj);
  return { repo, sha };
}
const indexSha = (repo) =>
  git(repo, ['ls-files', '-s', '--', '.beads/issues.jsonl']).trim().split(/\s+/)[1];

// Fresh repo with one commit that does NOT contain .beads/issues.jsonl.
function makeAbsentAtHeadFixture({ unborn = false } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'export-shrink-guard-new-'));
  git(repo, ['init', '-q']);
  if (!unborn) {
    writeFileSync(join(repo, 'README.md'), 'x\n');
    git(repo, ['add', 'README.md']);
    commitAll(repo, 'seed');
  }
  mkdirSync(join(repo, '.beads'), { recursive: true });
  writeFileSync(join(repo, '.beads', 'issues.jsonl'), jsonl(['id-1', 'id-2']));
  return repo;
}

test('>1 MB committed export: lib guard still refuses a single dropped id', () => {
  const repo = makeBigRepoFixture();
  const result = runExportShrinkGuard(repo);
  assert.equal(result.error, undefined);
  assert.equal(result.staged, false);
  assert.deepEqual(result.dropped, ['big-777']);
});

test('>1 MB committed export: inline guard cmd still refuses a single dropped id', () => {
  const repo = makeBigRepoFixture();
  const out = runInlineGuardCmd(repo);
  assert.match(out, /EXPORT_GUARD_REFUSED: 1 committed id\(s\)/);
  assert.match(out, /big-777/);
  assert.doesNotMatch(out, /EXPORT_GUARD_OK/);
  assert.equal(indexSha(repo), git(repo, ['rev-parse', 'HEAD:.beads/issues.jsonl']).trim(),
    'index must still hold the committed export');
});

test('unreadable committed blob: lib guard fails closed (error, nothing staged)', () => {
  const { repo, sha } = makeUnreadableBlobFixture();
  const result = runExportShrinkGuard(repo);
  assert.equal(result.staged, false);
  assert.match(result.error, /cannot read committed HEAD:\.beads\/issues\.jsonl/);
  assert.equal(indexSha(repo), sha, 'index must be unchanged');
});

test('unreadable committed blob: CLI prints EXPORT_GUARD_ERROR, exits 0, stages nothing', () => {
  const { repo, sha } = makeUnreadableBlobFixture();
  const out = execFileSync('node', [GUARD_SCRIPT, repo], { encoding: 'utf8' });
  assert.match(out, /^EXPORT_GUARD_ERROR: /m);
  assert.doesNotMatch(out, /EXPORT_GUARD_OK/);
  assert.equal(indexSha(repo), sha);
});

test('unreadable committed blob: inline guard cmd prints EXPORT_GUARD_ERROR, stages nothing', () => {
  const { repo, sha } = makeUnreadableBlobFixture();
  const out = runInlineGuardCmd(repo);
  assert.match(out, /EXPORT_GUARD_ERROR: cannot read committed HEAD:\.beads\/issues\.jsonl/);
  assert.doesNotMatch(out, /EXPORT_GUARD_OK/);
  assert.equal(indexSha(repo), sha);
});

test('export absent at HEAD (first export): lib + inline guard stage normally', () => {
  const r1 = makeAbsentAtHeadFixture();
  const result = runExportShrinkGuard(r1);
  assert.equal(result.error, undefined);
  assert.equal(result.staged, true);
  assert.match(stagedContent(r1), /id-2/);

  const r2 = makeAbsentAtHeadFixture();
  assert.match(runInlineGuardCmd(r2), /EXPORT_GUARD_OK/);
  assert.match(stagedContent(r2), /id-2/);
});

test('unborn HEAD (no commits yet): lib + inline guard stage normally', () => {
  const r1 = makeAbsentAtHeadFixture({ unborn: true });
  assert.equal(runExportShrinkGuard(r1).staged, true);
  const r2 = makeAbsentAtHeadFixture({ unborn: true });
  assert.match(runInlineGuardCmd(r2), /EXPORT_GUARD_OK/);
  assert.match(stagedContent(r2), /id-1/);
});

// ---- orchestrator-side detection (refusals must reach the sprint log) ------------

test('detectExportGuardIssue + exportGuardLogLine: dispatchShell {outputs} refusal -> log line', () => {
  const refusal = 'EXPORT_GUARD_REFUSED: 2 committed id(s) missing from new export (e.g. bd-1, bd-2). ' +
    'Written to disk but NOT staged/committed. Set AUTO_SPRINT_ALLOW_EXPORT_SHRINK=1 to override.';
  const res = { outputs: ['', 'Exported 40 issues', refusal + '\n', '', ''] };
  const d = detectExportGuardIssue(res.outputs);
  assert.equal(d.kind, 'REFUSED');
  assert.equal(d.line, refusal);
  const line = exportGuardLogLine(d, 'plan-commit-c1');
  assert.match(line, /^WARNING: \[export-guard\] plan-commit-c1: beads export NOT committed/);
  assert.match(line, /2 committed id\(s\)/);
  assert.match(line, /e\.g\. bd-1, bd-2/);
  assert.match(line, /AUTO_SPRINT_ALLOW_EXPORT_SHRINK=1/);
});

test('detectExportGuardIssue: harvest string reply and nested objects are scanned', () => {
  const d = detectExportGuardIssue('OK\nEXPORT_GUARD_ERROR: cannot read committed HEAD:.beads/issues.jsonl: boom. x');
  assert.equal(d.kind, 'ERROR');
  assert.match(exportGuardLogLine(d, 'beads-export-cleanup'), /guard failed closed/);
  assert.equal(detectExportGuardIssue({ result: { text: 'EXPORT_GUARD_REFUSED: 1 x' } }).kind, 'REFUSED');
});

test('detectExportGuardIssue: OK -> no log line; no marker -> WARN line', () => {
  const ok = detectExportGuardIssue({ outputs: ['EXPORT_GUARD_OK: staged .beads/issues.jsonl'] });
  assert.equal(ok.kind, 'OK');
  assert.equal(exportGuardLogLine(ok, 'x'), null);
  assert.equal(detectExportGuardIssue('OK'), null);
  assert.equal(detectExportGuardIssue(undefined), null);
  assert.match(exportGuardLogLine(null, 'beads-export-cleanup'), /^WARN: \[export-guard\].*no EXPORT_GUARD_\* result/);
});

test('end to end: a real inline-guard refusal, fed back as a shell result, becomes a log line', () => {
  const repo = makeRepoFixture(['id-1', 'id-2', 'id-3'], ['id-9']);
  const out = runInlineGuardCmd(repo);
  const line = exportGuardLogLine(detectExportGuardIssue({ outputs: ['', out] }), 'plan-commit-c2');
  assert.match(line, /3 committed id\(s\)/);
  assert.match(line, /AUTO_SPRINT_ALLOW_EXPORT_SHRINK=1/);
});

test('both call sites route their dispatch result through the guard detection and log()', () => {
  assert.match(WORKFLOW_SRC,
    /const planCommitRes = await dispatchShell\(planCommitCmds[\s\S]{0,400}exportGuardLogLine\([\s\S]{0,120}detectExportGuardIssue\(planCommitRes[\s\S]{0,120}if \(planGuardLine\) log\(planGuardLine\)/);
  assert.match(WORKFLOW_SRC,
    /const exportCleanupRes = await dispatch\([\s\S]*?label: 'beads-export-cleanup'[\s\S]{0,300}detectExportGuardIssue\(exportCleanupRes\)[\s\S]{0,120}if \(harvestGuardLine\) log\(harvestGuardLine\)/);
  const idx = src_indexOf("label: 'beads-export-cleanup'");
  const region = WORKFLOW_SRC.slice(Math.max(0, idx - 3500), idx);
  assert.doesNotMatch(region, /not an error/, 'harvest prompt must not downplay a refusal');
  assert.match(region, /EXPORT_GUARD_\* line[^\n]*verbatim/);
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
