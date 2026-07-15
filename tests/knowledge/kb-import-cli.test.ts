import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
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
});

describe('KB_IMPORT_USAGE carries the trust-boundary line', () => {
  it('mentions caller-asserted trust for --path', () => {
    expect(KB_IMPORT_USAGE).toContain('--path');
    expect(KB_IMPORT_USAGE).toContain('caller-asserted trust');
  });
});

describe('kbImportCmd (handler unit)', () => {
  it('prints the report and exits 0 on success', async () => {
    const importFn: KbImportFn = vi.fn(async () =>
      JSON.stringify({ imported: 3, skipped: 1, linked: 2, flagged: 1, sweep: { checked: 5, staled: 2, unstaled: 1 } })
    );
    const code = await kbImportCmd(importFn, ['--repo', '/some/repo']);
    expect(code).toBe(0);
    expect(importFn).toHaveBeenCalledWith({ repo: '/some/repo', path: undefined });
    const out = logSpy.mock.calls.flat().join('\n');
    expect(out).toContain('Imported 3, skipped 1, linked 2, flagged 1.');
    expect(out).toContain('Freshness sweep: checked 5, staled 2, unstaled 1.');
  });

  it('passes --path through', async () => {
    const importFn: KbImportFn = vi.fn(async () =>
      JSON.stringify({ imported: 0, skipped: 0, linked: 0, flagged: 0, sweep: { checked: 0, staled: 0, unstaled: 0 } })
    );
    await kbImportCmd(importFn, ['--path', '/some/bible.json']);
    expect(importFn).toHaveBeenCalledWith({ repo: undefined, path: '/some/bible.json' });
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
      { id: 'cli-1', type: 'knowledge', title: 'cli entry', summary: 'a fact', symbols: ['cliSym'], source_files: [], confidence: 'CONFIRMED', updated_at: '2026-07-07T00:00:00.000Z' },
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
