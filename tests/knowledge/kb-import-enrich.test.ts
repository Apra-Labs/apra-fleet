import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbImport } from '../../src/tools/kb-import.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { commitWorkTree } from '../helpers/commit-work-tree.js';

// kb_import upgrades a POORER local row from the richer bible entry with the
// same id: same claim (type, title, summary, cited files, and the same basis
// when the bible carries one) and a missing content / recall_cues /
// error_signatures -> those fields are filled in and counted in `enriched`.
// A differing claim is never overwritten and stays counted in `skipped`.
//
// Real SqliteProvider over a real temp git checkout; the real kb_import
// handler reads hand-written bible files. The only spy is getKbProviders.
//
// FALSIFICATION: making SqliteProvider.enrichFromBible return false (or
// dropping its call in importBibleEntries) fails the first scenario: the row
// keeps content = summary and enriched is 0.
//
// All temp state lives under one root removed in afterEach.

const ID = 'enrich-0001';
const SUMMARY = 'kb_import fills rich fields into a poorer row with the same claim';
const RICH_CONTENT = 'The lesson body that the poorer row lacked: the same claim, now with its full explanation and context.';
const HASHES = { 'src/a.ts': 'h'.repeat(64) };

let root: string;
let clone: string;
let provider: SqliteProvider;

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID, type: 'knowledge', title: 'Import enrichment', summary: SUMMARY,
    symbols: ['importBibleEntries'], source_files: ['src/a.ts'], confidence: 'CONFIRMED',
    updated_at: '2026-11-01T00:00:00.000Z', source_file_hashes: HASHES, ...over,
  };
}

function writeBible(name: string, entries: Record<string, unknown>[]): string {
  const p = path.join(root, name);
  fs.writeFileSync(p, JSON.stringify({
    version: 3, provenance: { commit: null, branch: 'main', entry_count: entries.length }, entries,
  }, null, 2));
  return p;
}

async function importBible(p: string): Promise<Record<string, number>> {
  return JSON.parse(await kbImport({ path: p, skip_sweep: true }, { folder: clone }));
}

function row(id: string): { content: string; recall_cues: string; error_signatures: string; confidence: string; summary: string } {
  return (provider as any).getDb()
    .prepare('SELECT content, recall_cues, error_signatures, confidence, summary FROM entries WHERE id = ?').get(id);
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-import-enrich-'));
  clone = path.join(root, 'clone');
  fs.mkdirSync(path.join(clone, 'src'), { recursive: true });
  git(clone, ['init', '--quiet', '-b', 'main']);
  git(clone, ['config', 'user.name', 'test']);
  git(clone, ['config', 'user.email', 'test@example.invalid']);
  git(clone, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(clone, 'src', 'a.ts'), 'export const a = 1;\n');
  commitWorkTree(clone, 'seed');
  provider = new SqliteProvider(path.join(root, 'kb.sqlite'), clone);
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider, global: provider, projectSlug: 'test',
  } as any);
});

afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('kb_import enriches a poorer local row from the richer bible entry with the same id', () => {
  it('the poor row gains content, recall_cues and error_signatures, and the response reports it', async () => {
    const first = await importBible(writeBible('poor.json', [entry()]));
    expect(first.imported).toBe(1);
    expect(row(ID).content).toBe(SUMMARY);
    expect(JSON.parse(row(ID).recall_cues)).toEqual([]);

    const r = await importBible(writeBible('rich.json', [entry({
      content: RICH_CONTENT, recall_cues: ['why does kb_import skip my id'], error_signatures: ['row stays poor'],
    })]));
    expect(r.enriched).toBe(1);
    expect(r.skipped).toBe(0);
    expect(r.imported).toBe(0);
    const after = row(ID);
    expect(after.content).toBe(RICH_CONTENT);
    expect(JSON.parse(after.recall_cues)).toEqual(['why does kb_import skip my id']);
    expect(JSON.parse(after.error_signatures)).toEqual(['row stays poor']);
    expect(after.confidence).toBe('CONFIRMED');

    // Idempotent: nothing left to fill, so the id is skipped again.
    const again = await importBible(writeBible('rich2.json', [entry({ content: RICH_CONTENT })]));
    expect(again.enriched).toBe(0);
    expect(again.skipped).toBe(1);
  });

  it('a clone row with a different claim is left untouched and still counted as skipped', async () => {
    await importBible(writeBible('poor.json', [entry()]));
    const before = row(ID);
    const r = await importBible(writeBible('other.json', [entry({
      summary: 'A different claim under the same id, which must never overwrite the local row',
      content: RICH_CONTENT, recall_cues: ['cue'],
    })]));
    expect(r.enriched).toBe(0);
    expect(r.skipped).toBe(1);
    expect(row(ID)).toEqual(before);
  });

  it('the same text with a different carried basis is a different claim: untouched, skipped', async () => {
    await importBible(writeBible('poor.json', [entry()]));
    const before = row(ID);
    const r = await importBible(writeBible('rebased.json', [entry({
      source_file_hashes: { 'src/a.ts': 'f'.repeat(64) }, content: RICH_CONTENT,
    })]));
    expect(r.enriched).toBe(0);
    expect(r.skipped).toBe(1);
    expect(row(ID)).toEqual(before);
  });

  it('a field the row already has is never overwritten; a missing one is still filled', async () => {
    await importBible(writeBible('mid.json', [entry({ content: 'The local lesson body, already richer than the summary alone, kept as is.' })]));
    const r = await importBible(writeBible('rich.json', [entry({ content: RICH_CONTENT, recall_cues: ['a cue'] })]));
    expect(r.enriched).toBe(1);
    expect(row(ID).content).toBe('The local lesson body, already richer than the summary alone, kept as is.');
    expect(JSON.parse(row(ID).recall_cues)).toEqual(['a cue']);
  });

  it('confidence never moves: an INFERRED local row stays INFERRED when enriched', async () => {
    await importBible(writeBible('poor.json', [entry({ confidence: 'INFERRED' })]));
    const r = await importBible(writeBible('rich.json', [entry({ confidence: 'CONFIRMED', content: RICH_CONTENT })]));
    expect(r.enriched).toBe(1);
    expect(row(ID).confidence).toBe('INFERRED');
    expect(row(ID).content).toBe(RICH_CONTENT);
  });
});
