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
import { parseBibleText, carriedBasisOf } from '../src/services/knowledge/bible-import.js';
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

  it('ships one example per accepted shape (v1, v2, v3)', () => {
    expect(fs.readdirSync(EXAMPLES_DIR).sort()).toEqual(['v1-bare-array.json', 'v2-envelope.json', 'v3-envelope.json']);
  });

  for (const name of ['v1-bare-array.json', 'v2-envelope.json', 'v3-envelope.json']) {
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
});
