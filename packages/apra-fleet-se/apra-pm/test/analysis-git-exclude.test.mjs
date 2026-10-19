import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The auto-sprint analysis summary (sprint-logs/<branch>-<ts>.analysis.md) is written
// locally and never committed. buildGitExcludeCmd lists its pattern in the target
// clone's .git/info/exclude; this runs the REAL built command through the member
// shell (sh on POSIX, Windows PowerShell on Windows) against a real temp repo.

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '../.claude/workflows/auto-sprint.js'), 'utf-8');
const m = SRC.match(/\/\/ PURE_FUNCTIONS_BEGIN[^\n]*\n([\s\S]*?)\/\/ PURE_FUNCTIONS_END/);
if (!m) throw new Error('PURE_FUNCTIONS_BEGIN/END markers not found');
// eslint-disable-next-line no-new-func
const { buildGitExcludeCmd, gitExcludeSucceeded, ANALYSIS_EXCLUDE_PATTERN } = new Function(
  `${m[1]}; return { buildGitExcludeCmd, gitExcludeSucceeded, ANALYSIS_EXCLUDE_PATTERN };`
)();

const roots = [];
after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

function runMemberCmd(cmd, cwd, env) {
  if (process.platform === 'win32') {
    const encoded = Buffer.from(cmd, 'utf16le').toString('base64');
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { cwd, encoding: 'utf8', env });
  }
  return execFileSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', env });
}

function git(cwd, args, env) {
  return spawnSync('git', args, { cwd, env, encoding: 'utf8' });
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'analysis-exclude-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const env = {
    ...process.env, GIT_CEILING_DIRECTORIES: root,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };
  assert.equal(git(root, ['init', '-q', repo], env).status, 0);
  mkdirSync(join(repo, 'sprint-logs'));
  writeFileSync(join(repo, 'sprint-logs', 'calibration.json'), '{}\n');
  assert.equal(git(repo, ['add', '-A'], env).status, 0);
  assert.equal(git(repo, ['commit', '-q', '-m', 'init'], env).status, 0);
  return { root, repo, env };
}

test('pattern constant is the sprint-logs analysis summary', () => {
  assert.equal(ANALYSIS_EXCLUDE_PATTERN, 'sprint-logs/*.analysis.md');
});

test('run twice -> pattern listed exactly once; output reports OK', () => {
  const { root, repo, env } = makeRepo();
  for (let i = 0; i < 2; i++) {
    const out = runMemberCmd(buildGitExcludeCmd(repo, ANALYSIS_EXCLUDE_PATTERN), root, env);
    assert.ok(gitExcludeSucceeded(out), out);
  }
  const excl = resolve(repo, git(repo, ['rev-parse', '--git-path', 'info/exclude'], env).stdout.trim());
  const lines = readFileSync(excl, 'utf8').split(/\r?\n/).filter((l) => l === ANALYSIS_EXCLUDE_PATTERN);
  assert.equal(lines.length, 1);
});

test('excluded analysis file: status clean, add -A / add sprint-logs/ stage nothing; other sprint-logs files still stage', () => {
  const { root, repo, env } = makeRepo();
  const out = runMemberCmd(buildGitExcludeCmd(repo, ANALYSIS_EXCLUDE_PATTERN), root, env);
  assert.ok(gitExcludeSucceeded(out), out);
  writeFileSync(join(repo, 'sprint-logs', 'feat-x-20261019_120000.analysis.md'), '# summary\n');
  assert.equal(git(repo, ['status', '--porcelain'], env).stdout, '');
  assert.equal(git(repo, ['add', '-A'], env).status, 0);
  assert.equal(git(repo, ['add', 'sprint-logs/'], env).status, 0);
  assert.equal(git(repo, ['diff', '--cached', '--name-only'], env).stdout, '');
  const stash = git(repo, ['stash', 'push', '-u', '-m', 'probe'], env);
  assert.match(stash.stdout + stash.stderr, /No local changes to save/);

  writeFileSync(join(repo, 'sprint-logs', 'calibration.json'), '{"n":1}\n');
  assert.equal(git(repo, ['add', 'sprint-logs/'], env).status, 0);
  assert.equal(git(repo, ['diff', '--cached', '--name-only'], env).stdout.trim(), 'sprint-logs/calibration.json');
  assert.ok(existsSync(join(repo, 'sprint-logs', 'feat-x-20261019_120000.analysis.md')));
});

test('outside a git repo the command reports GIT_EXCLUDE_ERROR (never a false OK)', () => {
  const root = mkdtempSync(join(tmpdir(), 'analysis-exclude-plain-'));
  roots.push(root);
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: root };
  const out = runMemberCmd(buildGitExcludeCmd(root, ANALYSIS_EXCLUDE_PATTERN), root, env);
  assert.match(out, /GIT_EXCLUDE_ERROR:/);
  assert.equal(gitExcludeSucceeded(out), false);
});
