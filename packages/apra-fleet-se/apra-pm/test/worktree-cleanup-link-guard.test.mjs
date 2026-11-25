import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, unlinkSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// Real-git, real-filesystem proof of safeWorktreeRemoveCmd (auto-sprint.js PURE_FUNCTIONS
// block): a worktree holding a symlink/junction must be left in place with a loud
// WORKTREE_CLEANUP_REFUSED and a nonzero exit, and the link target must survive. No mocks.
//
// FALSIFIABILITY (verified by hand once): replacing the builder body with the plain
//   git -C "<repo>" worktree remove --force "<wt>"
// makes the refusal test fail -- the exit is 0 (or git deletes through the link), no
// WORKTREE_CLEANUP_REFUSED is printed and the worktree is gone from `git worktree list`.

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);
function loadPure(...names) {
  const start = src.indexOf('// PURE_FUNCTIONS_BEGIN');
  const end = src.indexOf('// PURE_FUNCTIONS_END');
  assert.ok(start >= 0 && end > start, 'pure-functions block must exist');
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(start, end)}\n return { ${names.join(', ')} };`)();
}
const { safeWorktreeRemoveCmd, worktreeNamesFor } = loadPure('safeWorktreeRemoveCmd', 'worktreeNamesFor');

// Forward-slash path usable by both node and bash (git-bash on Windows reads C:/...).
const fwd = (p) => p.split(sep).join('/');

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf-8' });
}
function git(repo, ...args) {
  const r = run('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args]);
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}
function link(target, linkPath) {
  // Junctions need no privilege on Windows; a failure elsewhere is a real failure.
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function setup() {
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'wt-link-guard-')));
  const repo = fwd(join(sandbox, 'repo'));
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const names = worktreeNamesFor('sprint/x', 'task-1', '.auto-sprint/wt');
  const wt = `${repo}/${names.path}`;
  git(repo, 'worktree', 'add', '-q', '-b', names.branch, wt);
  const outside = join(sandbox, 'outside');
  mkdirSync(join(outside, 'node_modules', 'pkg'), { recursive: true });
  const sentinel = join(outside, 'node_modules', 'pkg', 'index.js');
  writeFileSync(sentinel, 'SENTINEL\n');
  return { sandbox, repo, wt, outside, sentinel };
}

function cleanup(ctx, links) {
  for (const l of links) { try { unlinkSync(l); } catch { /* already gone */ } }
  rmSync(ctx.sandbox, { recursive: true, force: true });
}

const registered = (ctx) => fwd(git(ctx.repo, 'worktree', 'list', '--porcelain')).includes(ctx.wt);
const bash = (cmd) => run('bash', ['-c', cmd]);

test('worktree holding a link to an outside dir is refused, left registered, target intact; control removes it', () => {
  const ctx = setup();
  const lnk = join(ctx.wt, 'node_modules');
  try {
    link(join(ctx.outside, 'node_modules'), lnk);
    const cmd = safeWorktreeRemoveCmd(ctx.repo, ctx.wt);

    const r = bash(cmd);
    assert.notEqual(r.status, 0, `cleanup must exit nonzero: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /WORKTREE_CLEANUP_REFUSED/);
    assert.ok(r.stdout.includes('node_modules'), `refusal must name the link: ${r.stdout}`);
    assert.equal(readFileSync(ctx.sentinel, 'utf-8'), 'SENTINEL\n', 'outside sentinel must be untouched');
    assert.ok(registered(ctx), 'worktree must still be registered (left in place)');
    assert.ok(existsSync(join(ctx.wt, 'a.txt')), 'worktree contents must be intact');

    // Control: unlink the link, the same command now removes the worktree.
    unlinkSync(lnk);
    const r2 = bash(cmd);
    assert.equal(r2.status, 0, `control cleanup must succeed: ${r2.stdout}${r2.stderr}`);
    assert.ok(!registered(ctx), 'worktree must be gone after the control removal');
    assert.ok(!existsSync(ctx.wt));
    assert.equal(readFileSync(ctx.sentinel, 'utf-8'), 'SENTINEL\n');
  } finally {
    cleanup(ctx, [lnk]);
  }
});

test('a nested link (deeper than the worktree root) is also detected', () => {
  const ctx = setup();
  const nestedDir = join(ctx.wt, 'packages', 'x');
  const lnk = join(nestedDir, 'node_modules');
  try {
    mkdirSync(nestedDir, { recursive: true });
    link(join(ctx.outside, 'node_modules'), lnk);
    const r = bash(safeWorktreeRemoveCmd(ctx.repo, ctx.wt));
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /WORKTREE_CLEANUP_REFUSED/);
    assert.ok(r.stdout.includes('packages'), `refusal must name the nested link: ${r.stdout}`);
    assert.equal(readFileSync(ctx.sentinel, 'utf-8'), 'SENTINEL\n');
    assert.ok(registered(ctx));
  } finally {
    cleanup(ctx, [lnk]);
  }
});

test('a plain worktree without links is removed normally', () => {
  const ctx = setup();
  try {
    const r = bash(safeWorktreeRemoveCmd(ctx.repo, ctx.wt));
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.ok(!registered(ctx));
    assert.doesNotMatch(r.stdout, /WORKTREE_CLEANUP_REFUSED/);
  } finally {
    cleanup(ctx, []);
  }
});

test('in-worktree links are allowed: npm workspace link and .bin link resolve inside the tree', () => {
  const ctx = setup();
  try {
    // npm workspace shape: node_modules/@scope/a -> packages/a (a link to a real in-tree dir).
    mkdirSync(join(ctx.wt, 'packages', 'a'), { recursive: true });
    writeFileSync(join(ctx.wt, 'packages', 'a', 'index.js'), 'A\n');
    mkdirSync(join(ctx.wt, 'node_modules', '@scope'), { recursive: true });
    link(join(ctx.wt, 'packages', 'a'), join(ctx.wt, 'node_modules', '@scope', 'a'));

    // node_modules/.bin/tool -> ../pkg/cli.js (relative file symlink; junction fallback on Windows
    // hosts without symlink privilege, which is still a link whose target is in-tree).
    mkdirSync(join(ctx.wt, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(ctx.wt, 'node_modules', 'pkg', 'cli.js'), 'CLI\n');
    mkdirSync(join(ctx.wt, 'node_modules', '.bin'), { recursive: true });
    try {
      symlinkSync('../pkg/cli.js', join(ctx.wt, 'node_modules', '.bin', 'tool'), 'file');
    } catch {
      link(join(ctx.wt, 'node_modules', 'pkg'), join(ctx.wt, 'node_modules', '.bin', 'tool'));
    }

    const r = bash(safeWorktreeRemoveCmd(ctx.repo, ctx.wt));
    assert.equal(r.status, 0, `in-tree links must not block cleanup: ${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /WORKTREE_CLEANUP_REFUSED/);
    assert.ok(!registered(ctx), 'worktree must be removed');
  } finally {
    cleanup(ctx, []);
  }
});

test('a link to an outside dir is still refused when in-tree links sit beside it', () => {
  const ctx = setup();
  const bad = join(ctx.wt, 'node_modules', 'shared');
  try {
    mkdirSync(join(ctx.wt, 'packages', 'a'), { recursive: true });
    mkdirSync(join(ctx.wt, 'node_modules', '@scope'), { recursive: true });
    link(join(ctx.wt, 'packages', 'a'), join(ctx.wt, 'node_modules', '@scope', 'a'));
    link(join(ctx.outside, 'node_modules'), bad);
    const r = bash(safeWorktreeRemoveCmd(ctx.repo, ctx.wt));
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /WORKTREE_CLEANUP_REFUSED/);
    assert.ok(r.stdout.includes('shared'), r.stdout);
    assert.ok(!r.stdout.includes('@scope'), `the in-tree link must not be reported: ${r.stdout}`);
    assert.equal(readFileSync(ctx.sentinel, 'utf-8'), 'SENTINEL\n');
    assert.ok(registered(ctx));
  } finally {
    cleanup(ctx, [bad]);
  }
});
