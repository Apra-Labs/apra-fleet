import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { installKbPostCommitHook, KB_POST_COMMIT_HOOK, KB_HOOK_MARKER } from '../../src/tools/kb-invalidate.js';
import { FLEET_DIR } from '../../src/paths.js';
import { isolateGitConfig } from './isolate-git-config.js';

const configPath = path.join(FLEET_DIR, 'knowledge', 'config.json');
const HOOK_STEP = 'Installed git post-commit hook for KB invalidation';

let rootDir: string;
let savedConfig: string | null;
let restoreGitConfig: () => void;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
}

beforeEach(() => {
  restoreGitConfig = isolateGitConfig();
  rootDir =fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-setup-wt-')));
  savedConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
  fs.rmSync(configPath, { force: true });
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  if (savedConfig === null) fs.rmSync(configPath, { force: true });
  else fs.writeFileSync(configPath, savedConfig);
  restoreGitConfig();
});

describe('kb_setup hook install resolves the hooks dir through git', () => {
  it('installs the hook from a linked worktree into the main repo hooks dir', async () => {
    const main = path.join(rootDir, 'main');
    const wt = path.join(rootDir, 'wt');
    initRepo(main);
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init');
    git(main, 'worktree', 'add', '-q', wt, '-b', 'wt-branch');
    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true);

    const result = JSON.parse(await kbSetup({}, { folder: wt }));

    expect(result.success).toBe(true);
    expect(result.steps).toContain(HOOK_STEP);
    const reported = git(wt, 'rev-parse', '--git-path', 'hooks');
    const hooksDir = path.isAbsolute(reported) ? reported : path.join(wt, reported);
    const hookPath = path.join(hooksDir, 'post-commit');
    expect(fs.existsSync(hookPath)).toBe(true);
    expect(fs.readFileSync(hookPath, 'utf-8')).toContain('kb invalidate');
    expect(fs.realpathSync(hooksDir)).toBe(fs.realpathSync(path.join(main, '.git', 'hooks')));
    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true);
  });

  it('honours core.hooksPath', async () => {
    const repo = path.join(rootDir, 'repo');
    initRepo(repo);
    git(repo, 'config', 'core.hooksPath', 'custom-hooks');

    const result = JSON.parse(await kbSetup({}, { folder: repo }));

    expect(result.success).toBe(true);
    const custom = path.join(repo, 'custom-hooks', 'post-commit');
    expect(fs.readFileSync(custom, 'utf-8')).toContain('kb invalidate');
    expect(fs.existsSync(path.join(repo, '.git', 'hooks', 'post-commit'))).toBe(false);
  });

  it('throws an error naming repoPath when git cannot resolve the hooks dir', () => {
    const notARepo = path.join(rootDir, 'not-a-repo');
    fs.mkdirSync(notARepo);
    // Stop git from discovering an enclosing repo above the temp dir.
    const prev = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = rootDir;
    try {
      expect(() => installKbPostCommitHook(notARepo)).toThrow(notARepo);
    } finally {
      if (prev === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prev;
    }
  });
});

describe('kb_setup never overwrites a post-commit hook it did not write', () => {
  const SKIP_PREFIX = 'Skipped git hook: ';

  function defaultHookPath(repo: string): string {
    return path.join(repo, '.git', 'hooks', 'post-commit');
  }

  function seedHook(repo: string, content: string): string {
    const hookPath = defaultHookPath(repo);
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, content);
    return hookPath;
  }

  it('installs the hook when no post-commit exists', async () => {
    const repo = path.join(rootDir, 'repo');
    initRepo(repo);
    fs.rmSync(defaultHookPath(repo), { force: true });

    const result = JSON.parse(await kbSetup({}, { folder: repo }));

    expect(result.steps).toContain(HOOK_STEP);
    expect(fs.readFileSync(defaultHookPath(repo), 'utf-8')).toBe(KB_POST_COMMIT_HOOK);
  });

  it('updates a post-commit that carries the fleet marker', async () => {
    const repo = path.join(rootDir, 'repo');
    initRepo(repo);
    const hookPath = seedHook(repo, `#!/bin/sh\n${KB_HOOK_MARKER}\necho older fleet hook\n`);

    const result = JSON.parse(await kbSetup({}, { folder: repo }));

    expect(result.steps).toContain(HOOK_STEP);
    expect(fs.readFileSync(hookPath, 'utf-8')).toBe(KB_POST_COMMIT_HOOK);
  });

  it('leaves a foreign post-commit untouched and reports the skip', async () => {
    const repo = path.join(rootDir, 'repo');
    initRepo(repo);
    const foreign = '#!/bin/sh\necho team hook\n';
    const hookPath = seedHook(repo, foreign);

    const result = JSON.parse(await kbSetup({}, { folder: repo }));

    expect(result.success).toBe(true);
    expect(fs.readFileSync(hookPath, 'utf-8')).toBe(foreign);
    expect(result.steps).not.toContain(HOOK_STEP);
    const skip = result.steps.find((s: string) => s.startsWith(SKIP_PREFIX + 'existing post-commit at '));
    expect(skip).toBeDefined();
    expect(skip).toMatch(/post-commit is not ours$/);
  });

  it('skips, without creating it, a hooks dir outside the repo and its git dir', async () => {
    const repo = path.join(rootDir, 'repo');
    initRepo(repo);
    const outside = path.join(rootDir, 'machine-global-hooks');
    // GIT_CONFIG_GLOBAL points at this test's temp file, so --global is the
    // real machine-wide core.hooksPath case, scoped to this test.
    git(repo, 'config', '--global', 'core.hooksPath', outside);

    const result = JSON.parse(await kbSetup({}, { folder: repo }));

    expect(result.success).toBe(true);
    expect(result.steps).not.toContain(HOOK_STEP);
    const skip = result.steps.find((s: string) => s.startsWith(SKIP_PREFIX + 'hooks dir '));
    expect(skip).toBeDefined();
    expect(skip).toContain('outside the repo');
    expect(fs.existsSync(outside)).toBe(false);
  });
});
