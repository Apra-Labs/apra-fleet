import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbExport } from '../../src/tools/kb-export.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import * as logHelpers from '../../src/utils/log-helpers.js';
import { FLEET_DIR } from '../../src/paths.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// T2.3 (F6a, D5 AMENDED -- USER DIRECTIVE 2026-07-07): auto-commit inside
// kb_export. All five D5 test behaviors: content-unchanged -> no commit;
// changed -> exactly one pathspec commit with pm-kb identity; git failure ->
// export success + warning; autoCommit:false -> no git call; dirty unrelated
// file never committed. Uses a real temp git repo fixture (git init) per the
// dispatch instruction.

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
}

function initTempGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-export-autocommit-'));
  git(dir, ['init', '--quiet']);
  return dir;
}

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Default title',
    summary: 'Default summary',
    content: 'Default content body.',
    source_files: ['src/default.ts'],
    symbols: ['defaultSymbol'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'test-agent',
    source: 'doer',
    confidence: 'INFERRED',
    ...overrides,
  };
}

let provider: SqliteProvider;
let repoDir: string;
const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');
let priorConfigContent: string | null = null;

beforeEach(async () => {
  provider = new SqliteProvider(':memory:');
  await provider.init();
  repoDir = initTempGitRepo();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider,
    global: provider,
    projectSlug: 'test',
  } as any);
  // Snapshot the shared config.json (FLEET_DIR is a fixed test tmp path per
  // tests/setup.ts, shared with kb-setup.test.ts) so autoCommit-off tests can
  // restore it afterward without polluting other test files' shared state.
  priorConfigContent = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
});

afterEach(() => {
  provider.close();
  fs.rmSync(repoDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  if (priorConfigContent !== null) {
    fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, priorConfigContent);
  } else if (fs.existsSync(KB_CONFIG_PATH)) {
    fs.rmSync(KB_CONFIG_PATH, { force: true });
  }
});

describe('kb_export auto-commit (T2.3, F6a, D5 amended)', () => {
  it('changed -> exactly one pathspec commit with pm-kb identity', async () => {
    const a = await provider.capture(makeInput({ title: 'A', symbols: ['symA'] }));
    await provider.promote(a.id, 'test');
    await provider.promote(a.id, 'test');

    const result = JSON.parse(await kbExport({ repo_path: repoDir }));
    expect(result.exported).toBe(1);
    expect(result.committed).toBe(true);

    const log = git(repoDir, ['log', '--format=%an|%ae|%s']).trim().split('\n');
    expect(log).toHaveLength(1);
    const [name, email, subject] = log[0].split('|');
    expect(name).toBe('pm-kb');
    expect(email).toBe('kb@pm.local');
    expect(subject).toBe('chore(kb): update knowledge bible -- 1 confirmed entries');

    // Pathspec-only: the commit touches ONLY the bible file. git always
    // reports paths with forward slashes regardless of OS.
    const changedFiles = git(repoDir, ['show', '--stat', '--format=', 'HEAD']).trim();
    expect(changedFiles).toContain('.fleet/kb-canonical.json');
    expect(git(repoDir, ['status', '--porcelain']).trim()).toBe('');
  });

  it('content-unchanged -> no commit on re-export', async () => {
    const a = await provider.capture(makeInput({ title: 'A', symbols: ['symA'] }));
    await provider.promote(a.id, 'test');
    await provider.promote(a.id, 'test');

    const first = JSON.parse(await kbExport({ repo_path: repoDir }));
    expect(first.committed).toBe(true);

    const second = JSON.parse(await kbExport({ repo_path: repoDir }));
    expect(second.committed).toBe(false);

    const log = git(repoDir, ['log', '--format=%H']).trim().split('\n');
    expect(log).toHaveLength(1); // still exactly one commit
  });

  it('git failure -> export still succeeds and logs a warning (non-fatal)', async () => {
    // A ".git" that exists but is not a real git repo (isGitRepo() checks
    // existsSync only) -- any actual git command inside fails.
    fs.rmSync(path.join(repoDir, '.git'), { recursive: true, force: true });
    fs.writeFileSync(path.join(repoDir, '.git'), 'not a real git dir');

    const warnSpy = vi.spyOn(logHelpers, 'logWarn');

    const a = await provider.capture(makeInput({ title: 'A', symbols: ['symA'] }));
    await provider.promote(a.id, 'test');
    await provider.promote(a.id, 'test');

    const result = JSON.parse(await kbExport({ repo_path: repoDir }));
    expect(result.exported).toBe(1);
    expect(result.committed).toBe(false);
    expect(fs.existsSync(path.join(repoDir, '.fleet', 'kb-canonical.json'))).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0].join(' ')).toContain('kb-export');
  });

  it('autoCommit:false -> no git call at all', async () => {
    fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ bible: { autoCommit: false } }));

    const a = await provider.capture(makeInput({ title: 'A', symbols: ['symA'] }));
    await provider.promote(a.id, 'test');
    await provider.promote(a.id, 'test');

    const result = JSON.parse(await kbExport({ repo_path: repoDir }));
    expect(result.exported).toBe(1);
    expect(result.committed).toBe(false);

    // No commit was ever created (the bible file is untracked, not committed).
    expect(() => git(repoDir, ['log'])).toThrow();
    expect(git(repoDir, ['status', '--porcelain']).trim()).not.toBe('');
  });

  it('dirty unrelated file never committed (pathspec-only)', async () => {
    const otherPath = path.join(repoDir, 'other.txt');
    fs.writeFileSync(otherPath, 'unrelated dirty content');
    git(repoDir, ['add', 'other.txt']);

    const a = await provider.capture(makeInput({ title: 'A', symbols: ['symA'] }));
    await provider.promote(a.id, 'test');
    await provider.promote(a.id, 'test');

    const result = JSON.parse(await kbExport({ repo_path: repoDir }));
    expect(result.committed).toBe(true);

    // The commit contains ONLY the bible file -- the staged unrelated file
    // was never swept into it.
    const changedFiles = git(repoDir, ['show', '--stat', '--format=', 'HEAD']).trim();
    expect(changedFiles).not.toContain('other.txt');

    // The unrelated file is still staged (untouched, neither committed nor
    // unstaged) -- proves the commit used `-- <bible-path>` pathspec rather
    // than a bare `git commit -a` or committing the whole index.
    const status = git(repoDir, ['status', '--porcelain']).trim();
    expect(status).toContain('other.txt');
  });
});
