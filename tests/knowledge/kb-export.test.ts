import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbExport } from '../../src/tools/kb-export.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { vi } from 'vitest';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

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
let tmpDir: string;

beforeEach(async () => {
  provider = new SqliteProvider(':memory:');
  await provider.init();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-export-test-'));
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider,
    global: provider,
    projectSlug: 'test',
  } as any);
});

afterEach(() => {
  provider.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('kb_export (T3.4, F8b, D8)', () => {
  it('only live CONFIRMED entries appear -- INFERRED and superseded-CONFIRMED excluded', async () => {
    // Entry A: promoted to CONFIRMED, stays live.
    const a = await provider.capture(makeInput({
      title: 'Entry A knowledge',
      summary: 'Summary A',
      symbols: ['symA'],
      source_files: ['src/a.ts'],
    }));
    await provider.promote(a.id, 'confirmed for test');

    // Entry B: left at INFERRED, never promoted.
    await provider.capture(makeInput({
      title: 'Entry B knowledge',
      summary: 'Summary B',
      symbols: ['symB'],
      source_files: ['src/b.ts'],
    }));

    // Entry C: promoted to CONFIRMED, then superseded by a correcting capture
    // (AUDN 'update' -- same title/symbols/files triggers it).
    const c = await provider.capture(makeInput({
      title: 'Entry C knowledge',
      summary: 'Summary C',
      symbols: ['symC'],
      source_files: ['src/c.ts'],
    }));
    await provider.promote(c.id, 'confirmed for test');
    const cUpdate = await provider.capture(makeInput({
      title: 'Entry C knowledge',
      summary: 'Summary C',
      symbols: ['symC'],
      source_files: ['src/c.ts'],
      content: 'Corrected content for C.',
    }));
    expect(cUpdate.audn_decision).toBe('update');

    const result = JSON.parse(await kbExport({ repo_path: tmpDir }));
    expect(result.exported).toBe(1);

    const written = JSON.parse(fs.readFileSync(path.join(tmpDir, '.fleet', 'kb-canonical.json'), 'utf-8'));
    expect(written).toHaveLength(1);
    expect(written[0].id).toBe(a.id);
    expect(written[0].title).toBe('Entry A knowledge');
  });

  it('field set is exact: id, type, title, summary, symbols, source_files, confidence, updated_at', async () => {
    const { id } = await provider.capture(makeInput({ title: 'Field set entry' }));
    await provider.promote(id, 'confirmed for test');

    await kbExport({ repo_path: tmpDir });
    const written = JSON.parse(fs.readFileSync(path.join(tmpDir, '.fleet', 'kb-canonical.json'), 'utf-8'));

    expect(written).toHaveLength(1);
    expect(Object.keys(written[0]).sort()).toEqual(
      ['confidence', 'id', 'source_files', 'summary', 'symbols', 'title', 'type', 'updated_at'].sort()
    );
    expect(written[0].confidence).toBe('CONFIRMED');
    expect(typeof written[0].updated_at).toBe('string');
    expect(written[0].updated_at.length).toBeGreaterThan(0);
  });

  it('deterministic ordering by id', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { id } = await provider.capture(makeInput({
        title: `Order entry ${i}`,
        symbols: [`symOrder${i}`],
        source_files: [`src/order${i}.ts`],
      }));
      await provider.promote(id, 'confirmed for test');
      ids.push(id);
    }

    await kbExport({ repo_path: tmpDir });
    const written = JSON.parse(fs.readFileSync(path.join(tmpDir, '.fleet', 'kb-canonical.json'), 'utf-8'));

    const writtenIds = written.map((e: { id: string }) => e.id);
    const expectedSorted = [...ids].sort();
    expect(writtenIds).toEqual(expectedSorted);
  });

  it('creates the .fleet directory when missing', async () => {
    expect(fs.existsSync(path.join(tmpDir, '.fleet'))).toBe(false);

    await kbExport({ repo_path: tmpDir });

    expect(fs.existsSync(path.join(tmpDir, '.fleet', 'kb-canonical.json'))).toBe(true);
  });

  it('writes an empty array when there are no CONFIRMED entries', async () => {
    await provider.capture(makeInput({ title: 'Only inferred' }));

    const result = JSON.parse(await kbExport({ repo_path: tmpDir }));
    expect(result.exported).toBe(0);

    const written = JSON.parse(fs.readFileSync(path.join(tmpDir, '.fleet', 'kb-canonical.json'), 'utf-8'));
    expect(written).toEqual([]);
  });

  it('output is ASCII-only even when entry text has non-ASCII characters', async () => {
    // Build the non-ASCII characters at runtime (accented e-with-acute,
    // U+00E9, and em-dash, U+2014) rather than typing them literally into
    // this source file, which must itself stay ASCII-only per repo
    // convention.
    const eAcute = String.fromCharCode(233);
    const emDash = String.fromCharCode(8212);
    const { id } = await provider.capture(makeInput({
      title: 'Non-ASCII entry: caf' + eAcute + ' ' + emDash + ' note',
      summary: 'Uses an em-dash and accented letter',
    }));
    await provider.promote(id, 'confirmed for test');

    await kbExport({ repo_path: tmpDir });
    const raw = fs.readFileSync(path.join(tmpDir, '.fleet', 'kb-canonical.json'));
    for (let i = 0; i < raw.length; i++) {
      expect(raw[i]).toBeLessThanOrEqual(127);
    }
    const parsed = JSON.parse(raw.toString('utf-8'));
    expect(parsed[0].title).toContain('caf' + eAcute);
  });

  it('rejects a repo_path that does not exist', async () => {
    await expect(kbExport({ repo_path: path.join(tmpDir, 'does-not-exist') })).rejects.toThrow();
  });

  // F4 (T1.6): repo path resolution precedence -- explicit input > validated
  // session context (process.cwd(), validated) > refuse with a clear error.
  // No bare process.cwd() fallback: the session-context tier is validated
  // the same way explicit input is.
  describe('repo path precedence (F4, T1.6)', () => {
    let cwdSpy: ReturnType<typeof vi.spyOn>;

    afterEach(() => {
      cwdSpy?.mockRestore();
    });

    it('falls back to the validated session working directory when repo_path is omitted', async () => {
      const { id } = await provider.capture(makeInput({ title: 'Session-context entry' }));
      await provider.promote(id, 'confirmed for test');

      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
      const result = JSON.parse(await kbExport({}));
      expect(result.exported).toBe(1);

      const written = JSON.parse(fs.readFileSync(path.join(tmpDir, '.fleet', 'kb-canonical.json'), 'utf-8'));
      expect(written).toHaveLength(1);
    });

    it('explicit repo_path input takes precedence over the session working directory', async () => {
      const { id } = await provider.capture(makeInput({ title: 'Explicit-wins entry' }));
      await provider.promote(id, 'confirmed for test');

      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-export-other-'));
      try {
        cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(otherDir);
        await kbExport({ repo_path: tmpDir });

        expect(fs.existsSync(path.join(tmpDir, '.fleet', 'kb-canonical.json'))).toBe(true);
        expect(fs.existsSync(path.join(otherDir, '.fleet', 'kb-canonical.json'))).toBe(false);
      } finally {
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });

    it('refuses with a clear error when neither explicit input nor the session working directory validate', async () => {
      const missingCwd = path.join(tmpDir, 'does-not-exist-cwd');
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(missingCwd);

      await expect(kbExport({})).rejects.toThrow('repo_path does not exist or is not a directory');
      expect(fs.existsSync(path.join(missingCwd, '.fleet'))).toBe(false);
    });
  });
});
