// memory-contract/v1 bible file format (spec.md section 2.8): the hand-authored
// schema bible/kb-canonical.schema.json describes v1, v2 and v3; every example
// under bible/examples validates and parses; a LIVE kb_export and
// kb_bible_commit output (format v3, per-entry source_file_hashes) validates
// against the same schema, so the published contract cannot drift from what
// the writers emit.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { SqliteProvider } from '../src/services/knowledge/sqlite-provider.js';
import { kbExport } from '../src/tools/kb-export.js';
import { kbBibleCommit } from '../src/tools/kb-bible-commit.js';
import { parseBibleText, parseBibleDocument, carriedBasisOf } from '../src/services/knowledge/bible-import.js';
import * as kbProvidersModule from '../src/services/knowledge/kb-providers.js';

const BIBLE_DIR = path.resolve(__dirname, '..', 'memory-contract', 'v1', 'bible');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(BIBLE_DIR, 'kb-canonical.schema.json'), 'utf-8'));
const EXAMPLES_DIR = path.join(BIBLE_DIR, 'examples');

function validator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  return ajv.compile(SCHEMA);
}

describe('bible schema and examples', () => {
  const validate = validator();

  const EXAMPLES = ['v1-bare-array.json', 'v2-envelope.json', 'v3-envelope.json', 'v3-rich-content.json'];

  it('ships one example per accepted shape (v1, v2, v3, v3 with rich content)', () => {
    expect(fs.readdirSync(EXAMPLES_DIR).sort()).toEqual(EXAMPLES);
  });

  for (const name of EXAMPLES) {
    it(name + ' validates against the schema and parses with the reader', () => {
      const raw = fs.readFileSync(path.join(EXAMPLES_DIR, name), 'utf-8');
      const ok = validate(JSON.parse(raw));
      expect(validate.errors ?? []).toEqual([]);
      expect(ok).toBe(true);
      expect(parseBibleText(raw, name, 'contract').length).toBeGreaterThan(0);
    });
  }

  it('the v3 example carries a basis the reader accepts, and an entry without one', () => {
    const bible = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, 'v3-envelope.json'), 'utf-8'));
    const withHashes = bible.entries.filter((e: Record<string, unknown>) => e.source_file_hashes);
    const without = bible.entries.filter((e: Record<string, unknown>) => !e.source_file_hashes);
    expect(withHashes.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
    for (const e of withHashes) expect(carriedBasisOf(e)).toEqual(e.source_file_hashes);
  });

  it('the rich-content example carries content, recall_cues and error_signatures; the schema caps content at 2000', () => {
    const bible = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, 'v3-rich-content.json'), 'utf-8'));
    const e = bible.entries[0];
    expect(typeof e.content).toBe('string');
    expect(e.content).not.toBe(e.summary);
    expect(e.recall_cues.length).toBeGreaterThan(0);
    expect(e.error_signatures.length).toBeGreaterThan(0);
    const atCap = structuredClone(bible);
    atCap.entries[0].content = 'x'.repeat(2000);
    expect(validate(atCap)).toBe(true);
    const overCap = structuredClone(bible);
    overCap.entries[0].content = 'x'.repeat(2001);
    expect(validate(overCap)).toBe(false);
    const badCues = structuredClone(bible);
    badCues.entries[0].recall_cues = 'not an array';
    expect(validate(badCues)).toBe(false);
  });

  it('rejects a malformed v3 basis (absolute key, empty map) and hashes on a v2 entry', () => {
    const base = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, 'v3-envelope.json'), 'utf-8'));
    const abs = structuredClone(base);
    abs.entries[1].source_file_hashes = { '/etc/passwd': 'abc' };
    expect(validate(abs)).toBe(false);
    const parent = structuredClone(base);
    parent.entries[1].source_file_hashes = { '../outside.ts': 'abc' };
    expect(validate(parent)).toBe(false);
    const empty = structuredClone(base);
    empty.entries[1].source_file_hashes = {};
    expect(validate(empty)).toBe(false);
    const v2WithHashes = structuredClone(base);
    v2WithHashes.version = 2;
    expect(validate(v2WithHashes)).toBe(false);
  });
});

describe('live writer output validates against the bible schema', () => {
  let root: string;
  let provider: SqliteProvider;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-bible-format-'));
    execFileSync('git', ['init', '--quiet', root]);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'example.ts'), 'export const example = 1;\n');
    // Committed: bible admission reads cited files at HEAD.
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.local', '-c', 'commit.gpgsign=false',
      'commit', '--quiet', '--no-verify', '-m', 'seed'], { cwd: root });
    provider = new SqliteProvider(':memory:', root);
    await provider.init();
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: provider, global: provider, projectSlug: 'test',
    } as any);
  });

  afterEach(() => {
    provider.close();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function confirmed(title: string): Promise<string> {
    const { id } = await provider.capture({
      type: 'knowledge', title, summary: 'Summary of ' + title, content: 'Content of ' + title,
      source_files: ['src/example.ts'], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
      flagged_for_review: false, author: 'test', source: 'doer', confidence: 'INFERRED',
    });
    await provider.promote(id, 'contract test: basis verified');
    return id;
  }

  it('kb_export and kb_bible_commit write a schema-valid v3 bible with per-entry hashes', async () => {
    const validate = validator();
    const bible = () => JSON.parse(fs.readFileSync(path.join(root, '.fleet', 'kb-canonical.json'), 'utf-8'));

    await confirmed('Exported knowledge claim');
    await kbExport({ scope: 'project', baseBranch: 'main', baseCommit: 'abc' }, { folder: root });
    expect(validate(bible())).toBe(true);
    expect(bible().version).toBe(3);

    const id = await confirmed('Committed knowledge claim');
    await kbBibleCommit({ ids: [id], baseBranch: 'main', baseCommit: 'abc' }, { folder: root });
    const written = bible();
    const ok = validate(written);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    for (const e of written.entries) expect(Object.keys(e.source_file_hashes)).toEqual(['src/example.ts']);
  });

  it('a live kb_bible_commit removal writes superseded and invalidated tombstones that validate and that the reader keeps', async () => {
    const validate = validator();
    const biblePath = path.join(root, '.fleet', 'kb-canonical.json');
    const a = await confirmed('Claim to be superseded');
    const b = await confirmed('Claim to be invalidated');
    const keep = await confirmed('Claim that stays');
    await kbBibleCommit({ ids: [a, b, keep], baseBranch: 'main', baseCommit: 'abc' }, { folder: root });
    (provider as any).getDb()
      .prepare("UPDATE entries SET superseded_at = ?, stale = 1, retired_reason = 'superseded' WHERE id = ?")
      .run('2026-11-05T10:00:00.000Z', a);
    await provider.discard([b]);
    await kbBibleCommit({ ids: [], baseBranch: 'main', baseCommit: 'abc' }, { folder: root });

    const raw = fs.readFileSync(biblePath, 'utf-8');
    const written = JSON.parse(raw);
    const ok = validate(written);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    expect(Object.keys(written)).toEqual(['version', 'provenance', 'entries', 'demotions']);
    expect(written.provenance.entry_count).toBe(1);
    const reasons = Object.fromEntries(written.demotions.map((d: { id: string; reason: string }) => [d.id, d.reason]));
    expect(reasons).toEqual({ [a]: 'superseded', [b]: 'invalidated' });
    expect(written.demotions.find((d: { id: string }) => d.id === a).at).toBe('2026-11-05T10:00:00.000Z');
    expect(parseBibleDocument(raw, biblePath, 'contract').demotions.map(d => d.reason).sort()).toEqual(['invalidated', 'superseded']);
  });

  it('a live export carrying content, recall_cues and error_signatures validates', async () => {
    const validate = validator();
    const { id } = await provider.capture({
      type: 'learning', title: 'Rich exported claim', summary: 'Rich summary.', content: 'Rich content body that differs from the summary.',
      source_files: ['src/example.ts'], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
      flagged_for_review: false, author: 'test', source: 'doer', confidence: 'INFERRED',
      recall_cues: ['rich cue'], error_signatures: ['Error: rich'],
    });
    await provider.promote(id, 'contract test: basis verified');
    await kbExport({ scope: 'project', baseBranch: 'main', baseCommit: 'abc' }, { folder: root });
    const written = JSON.parse(fs.readFileSync(path.join(root, '.fleet', 'kb-canonical.json'), 'utf-8'));
    const ok = validate(written);
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    const e = written.entries.find((x: { id: string }) => x.id === id);
    expect(e.content).toBe('Rich content body that differs from the summary.');
    expect(e.recall_cues).toEqual(['rich cue']);
    expect(e.error_signatures).toEqual(['Error: rich']);
  });
});
