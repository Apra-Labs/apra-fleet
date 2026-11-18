import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { kbImportCmd, parseKbImportArgs, KB_IMPORT_USAGE, type KbImportFn } from '../../src/cli/kb-import.js';
import { kbImport } from '../../src/tools/kb-import.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';

// T2.2 (F4, D3): `apra-fleet kb import [--repo <path>] [--path <file>]`. Handler
// unit tests use a mocked KbImportFn (never touching a real KB); the smoke test
// drives the real kbImport against a temp repo + bible fixture.

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseKbImportArgs', () => {
  it('defaults to no repo and no path', () => {
    expect(parseKbImportArgs([])).toEqual({ repo: undefined, path: undefined });
  });

  it('parses --repo and --path in either order', () => {
    expect(parseKbImportArgs(['--repo', '/r', '--path', '/p'])).toEqual({ repo: '/r', path: '/p' });
    expect(parseKbImportArgs(['--path', '/p', '--repo', '/r'])).toEqual({ repo: '/r', path: '/p' });
  });

  it('ignores a trailing flag with no value', () => {
    expect(parseKbImportArgs(['--repo'])).toEqual({ repo: undefined, path: undefined });
  });

  it('parses --ref and --base-branch in any order alongside --repo/--path', () => {
    expect(parseKbImportArgs(['--base-branch', 'main', '--repo', '/r', '--ref', 'refs/remotes/origin/main', '--path', 'p.json']))
      .toEqual({ repo: '/r', path: 'p.json', ref: 'refs/remotes/origin/main', baseBranch: 'main' });
  });
});

describe('KB_IMPORT_USAGE carries the trust-boundary line', () => {
  it('mentions caller-asserted trust for --path', () => {
    expect(KB_IMPORT_USAGE).toContain('--path');
    expect(KB_IMPORT_USAGE).toContain('caller-asserted trust');
  });

  it('lists --ref and --base-branch', () => {
    expect(KB_IMPORT_USAGE).toContain('--ref <ref>');
    expect(KB_IMPORT_USAGE).toContain('--base-branch <branch>');
  });
});

describe('kbImportCmd (handler unit)', () => {
  it('prints the report and exits 0 on success', async () => {
    const importFn: KbImportFn = vi.fn(async () =>
      JSON.stringify({ imported: 3, skipped: 1, linked: 2, flagged: 1, sweep: { checked: 5, staled: 2, unstaled: 1 } })
    );
    const code = await kbImportCmd(importFn, ['--repo', '/some/repo']);
    expect(code).toBe(0);
    expect(importFn).toHaveBeenCalledWith({ path: undefined }, { folder: '/some/repo' });
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Imported 3, skipped 1, linked 2, flagged 1.');
    expect(out).toContain('Freshness sweep: checked 5, staled 2, unstaled 1.');
  });

  it('passes --path through', async () => {
    const importFn: KbImportFn = vi.fn(async () =>
      JSON.stringify({ imported: 0, skipped: 0, linked: 0, flagged: 0, sweep: { checked: 0, staled: 0, unstaled: 0 } })
    );
    await kbImportCmd(importFn, ['--path', '/some/bible.json']);
    expect(importFn).toHaveBeenCalledWith({ path: '/some/bible.json' }, undefined);
  });

  it('forwards --ref and --base-branch as ref and base_branch', async () => {
    const importFn: KbImportFn = vi.fn(async () =>
      JSON.stringify({ imported: 0, skipped: 0, linked: 0, flagged: 0, sweep: { checked: 0, staled: 0, unstaled: 0 } })
    );
    const code = await kbImportCmd(importFn, ['--ref', 'refs/remotes/origin/main', '--base-branch', 'main']);
    expect(code).toBe(0);
    expect(importFn).toHaveBeenCalledWith({ path: undefined, ref: 'refs/remotes/origin/main', base_branch: 'main' }, undefined);
  });

  it('rejects a value the tool schema refuses: exit 1, importFn never called', async () => {
    const importFn: KbImportFn = vi.fn(async () => '{}');
    expect(await kbImportCmd(importFn, ['--base-branch', 'a..b'])).toBe(1);
    expect(await kbImportCmd(importFn, ['--ref', '-x'])).toBe(1);
    expect(importFn).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join(' ')).toContain('--ref');
  });

  it('exits 1 and prints the message on a resolution failure (missing bible / invalid repo)', async () => {
    const importFn: KbImportFn = vi.fn(async () => {
      throw new Error('kb_import: bible file not found: /nope/.fleet/kb-canonical.json');
    });
    const code = await kbImportCmd(importFn, ['--repo', '/nope']);
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('bible file not found');
  });

  it('exits 1 when the import returns malformed JSON', async () => {
    const importFn: KbImportFn = vi.fn(async () => 'not json');
    const code = await kbImportCmd(importFn, []);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('kbImportCmd smoke (real kbImport, temp repo + bible)', () => {
  let provider: SqliteProvider;
  let tmpRepo: string;

  beforeEach(async () => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-import-cli-'));
    fs.mkdirSync(path.join(tmpRepo, '.fleet'), { recursive: true });
    provider = new SqliteProvider(':memory:');
    await provider.init();
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: provider, global: provider, projectSlug: 'test',
    } as any);
  });

  afterEach(() => {
    provider.close();
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  it('happy path: imports a bible and exits 0', async () => {
    fs.writeFileSync(path.join(tmpRepo, '.fleet', 'kb-canonical.json'), JSON.stringify([
      { id: 'cli-1', type: 'knowledge', title: 'cli entry', summary: 'a fact', symbols: ['cliSym'], source_files: ['src/fixture.ts'], confidence: 'CONFIRMED', updated_at: '2026-07-07T00:00:00.000Z' },
    ]), 'utf-8');

    const code = await kbImportCmd(kbImport, ['--repo', tmpRepo]);
    expect(code).toBe(0);
    expect(provider.hasEntry('cli-1')).toBe(true);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Imported 1');
  });

  it('missing-bible error path: exits 1', async () => {
    const code = await kbImportCmd(kbImport, ['--path', path.join(tmpRepo, '.fleet', 'does-not-exist.json')]);
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('not found');
  });
});

describe('kbImportCmd --ref/--base-branch applies withdrawn tombstones (real kbImport, git clone fixture)', () => {
  let root: string;
  let repo: string;
  let provider: SqliteProvider;
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const confidenceOf = (id: string) =>
    ((provider as any).getDb().prepare('SELECT confidence FROM entries WHERE id = ?').get(id) as { confidence: string }).confidence;
  let y: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-import-cli-wd-'));
    repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'y.ts'), 'export const y = 1;\n');
    execFileSync('git', ['init', '--quiet', '-b', 'main', repo]);
    git(['config', 'user.name', 'test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['config', 'commit.gpgsign', 'false']);
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'seed']);
    provider = new SqliteProvider(path.join(root, 'kb.sqlite'), repo);
    await provider.init();
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockImplementation(
      async () => ({ project: provider, global: provider, projectSlug: 'test' }) as any,
    );
    const cap = await provider.capture({
      type: 'knowledge', title: 'Y', summary: 'Summary of Y', content: 'Content body.', source_files: ['src/y.ts'],
      symbols: ['symY'], tags: [], content_hash: '', content_hash_type: 'sha256', flagged_for_review: false,
      author: 'test-agent', source: 'doer', confidence: 'INFERRED',
    } as any);
    y = cap.id;
    await provider.promote(y, 'test fixture: verified');
    await provider.promote(y, 'test fixture: verified');
    (provider as any).getDb().prepare('UPDATE entries SET created_at = ?, promoted_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', '2020-02-01T00:00:00.000Z', y);
    const entry = (id: string) => ({
      id, type: 'knowledge', title: 'W ' + id, summary: 'Summary', symbols: [], source_files: ['src/y.ts'],
      confidence: 'CONFIRMED', updated_at: '2020-01-01T00:00:00.000Z',
    });
    const bible = {
      version: 3, provenance: { commit: 'b'.repeat(40), branch: 'main', entry_count: 1 }, entries: [entry(y)],
      demotions: [{ id: y, at: '2021-06-01T00:00:00.000Z', reason: 'withdrawn', note: 'guard removed', evidence_files: ['src/y.ts'] }],
    };
    fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), JSON.stringify(bible, null, 2) + '\n');
    git(['add', '-A']);
    git(['commit', '--quiet', '-m', 'bible']);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    // No refs/remotes/origin/HEAD: only --base-branch can name the base.
  });

  afterEach(() => {
    provider.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('with the flags the withdrawn tombstone is applied; exit 0', async () => {
    const code = await kbImportCmd(kbImport, ['--repo', repo, '--ref', 'refs/remotes/origin/main', '--base-branch', 'main']);
    expect(code).toBe(0);
    expect(confidenceOf(y)).toBe('INFERRED');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Withdrawals: withdrawn 1');
  });

  it('without the flags the same import does not apply it and warns', async () => {
    const code = await kbImportCmd(kbImport, ['--repo', repo]);
    expect(code).toBe(0);
    expect(confidenceOf(y)).toBe('CONFIRMED');
  });

  it('--ref without --base-branch (no remote HEAD) defers with a printed warning', async () => {
    const code = await kbImportCmd(kbImport, ['--repo', repo, '--ref', 'refs/remotes/origin/main']);
    expect(code).toBe(0);
    expect(confidenceOf(y)).toBe('CONFIRMED');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Withdrawals deferred');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('base branch is unknown');
  });

  it('an invalid --base-branch or --ref exits 1 and imports nothing', async () => {
    expect(await kbImportCmd(kbImport, ['--repo', repo, '--ref', 'refs/remotes/origin/main', '--base-branch', 'a..b'])).toBe(1);
    expect(await kbImportCmd(kbImport, ['--repo', repo, '--ref', '-bad', '--base-branch', 'main'])).toBe(1);
    expect(confidenceOf(y)).toBe('CONFIRMED');
    expect(errSpy.mock.calls.flat().join(' ')).toContain('invalid argument');
  });
});
