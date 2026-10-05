import { describe, it, expect, afterAll, vi } from 'vitest';

// Sandbox the data dir (logs) before any project import.
const sandbox = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-exclude-')));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  process.env.APRA_FLEET_DATA_DIR = data;
  return { root };
});

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ensureLocalGitExcluded, GITNEXUS_ANALYZE_ARGS, GITNEXUS_REPO_ARTIFACTS,
} from '../src/tools/code-intelligence-reindex.js';

// The fleet's own git-exclude step for code index artefacts, against real git
// repos in a temp sandbox (runs on every OS, unlike the fake-npx suite).

const root = sandbox.root;
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

let n = 0;
function newRepo(): string {
  const dir = path.join(root, `repo${n++}`);
  fs.mkdirSync(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

function excludeFile(dir: string): string {
  const rel = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: dir, encoding: 'utf8' }).trim();
  return path.resolve(dir, rel);
}

function porcelain(dir: string): string {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' });
}

describe('fleet code index invocation', () => {
  it('runs gitnexus in index-only mode', () => {
    expect([...GITNEXUS_ANALYZE_ARGS]).toEqual(['gitnexus', 'analyze', '--index-only']);
  });

  it('excludes the .gitnexus/ index dir', () => {
    expect([...GITNEXUS_REPO_ARTIFACTS]).toEqual(['.gitnexus/']);
  });
});

describe('ensureLocalGitExcluded()', () => {
  it('adds an anchored line once and keeps .gitnexus/ out of git status', () => {
    const repo = newRepo();
    expect(ensureLocalGitExcluded(repo, GITNEXUS_REPO_ARTIFACTS)).toBe(true);
    expect(ensureLocalGitExcluded(repo, GITNEXUS_REPO_ARTIFACTS)).toBe(true);
    const lines = fs.readFileSync(excludeFile(repo), 'utf8').split('\n');
    expect(lines.filter((l) => l === '/.gitnexus/')).toHaveLength(1);
    fs.mkdirSync(path.join(repo, '.gitnexus'));
    fs.writeFileSync(path.join(repo, '.gitnexus', 'meta.json'), '{}');
    expect(porcelain(repo)).toBe('');
  });

  it('keeps existing exclude content', () => {
    const repo = newRepo();
    const excl = excludeFile(repo);
    fs.writeFileSync(excl, '# mine\n/keep-me\n');
    ensureLocalGitExcluded(repo, GITNEXUS_REPO_ARTIFACTS);
    expect(fs.readFileSync(excl, 'utf8')).toBe('# mine\n/keep-me\n/.gitnexus/\n');
  });

  it('a linked worktree (.git is a file) uses the common exclude file', () => {
    const repo = newRepo();
    const wt = path.join(root, `wt${n++}`);
    execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: repo });
    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true);
    expect(ensureLocalGitExcluded(wt, GITNEXUS_REPO_ARTIFACTS)).toBe(true);
    fs.mkdirSync(path.join(wt, '.gitnexus'));
    fs.writeFileSync(path.join(wt, '.gitnexus', 'meta.json'), '{}');
    expect(porcelain(wt)).toBe('');
  });

  it('a folder that is not a git repo is a quiet false, never a throw', () => {
    const plain = path.join(root, `plain${n++}`);
    fs.mkdirSync(plain);
    // GIT_CEILING_DIRECTORIES stops git from finding a parent repo above the temp dir.
    const saved = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = root;
    try {
      expect(ensureLocalGitExcluded(plain, GITNEXUS_REPO_ARTIFACTS)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = saved;
    }
  });
});
