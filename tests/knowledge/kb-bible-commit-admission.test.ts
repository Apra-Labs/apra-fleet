import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { kbExport } from '../../src/tools/kb-export.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// kb_bible_commit admission = kb_export (scope=project) admission: both pass a
// CONFIRMED entry only through the shared bible basis predicate, against a REAL
// temp git repo (bare origin + clone) and the real handlers.
//
// FALSIFICATION: reverting the predicate call in src/tools/kb-bible-commit.ts
// (back to admitting every requested CONFIRMED id) makes scenario 2 (the edited
// file would be merged, not skipped) and scenario 3 (kb_bible_commit would merge
// the changed/missing/empty/non-relative ids that kb_export refuses) FAIL.
// Scenario 1 stays green under that revert.
//
// All temp repos live under one root removed in afterEach.

const BIBLE_REL = '.fleet/kb-canonical.json';
const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge', title: 'T', summary: 'Summary', content: 'Content body.',
    source_files: ['src/a.ts'], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test-agent', source: 'doer', confidence: 'INFERRED',
    ...overrides,
  };
}

let root: string;
let clone: string;
let provider: SqliteProvider;

function writeSrc(rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(clone, rel)), { recursive: true });
  fs.writeFileSync(path.join(clone, rel), body);
}

async function confirmedCiting(title: string, files: string[]): Promise<string> {
  const { id } = await provider.capture(makeInput({ title, summary: 'Summary of ' + title, symbols: ['sym' + title], source_files: files }));
  await provider.promote(id, 'test fixture: verified');
  await provider.promote(id, 'test fixture: verified');
  return id;
}

function db(): any {
  return (provider as any).getDb();
}

function bibleIds(): string[] {
  const p = path.join(clone, BIBLE_REL);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf-8')).entries.map((e: { id: string }) => e.id).sort();
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-admission-'));
  const origin = path.join(root, 'origin.git');
  clone = path.join(root, 'clone');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, clone], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(clone, ['config', 'user.name', 'test']);
  git(clone, ['config', 'user.email', 'test@example.invalid']);
  git(clone, ['config', 'commit.gpgsign', 'false']);
  git(clone, ['checkout', '--quiet', '-B', 'main']);
  writeSrc('README.md', 'seed\n');
  git(clone, ['add', '-A']);
  git(clone, ['commit', '--quiet', '-m', 'seed']);
  git(clone, ['push', '--quiet', 'origin', 'main']);

  provider = new SqliteProvider(path.join(root, 'kb.sqlite'), clone);
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

describe('kb_bible_commit admission (shared basis predicate)', () => {
  it('scenario 1: a CONFIRMED id whose cited file is unchanged is merged and committed', async () => {
    writeSrc('src/a.ts', 'export const a = 1;\n');
    const id = await confirmedCiting('Unchanged', ['src/a.ts']);

    const r = JSON.parse(await kbBibleCommit({ ids: [id], ...BASE }, { folder: clone }));

    expect(r.merged).toEqual([id]);
    expect(r.skipped).toEqual([]);
    expect(r.committed).toBe(true);
    expect(bibleIds()).toEqual([id]);
    expect(git(clone, ['log', '--format=%an %s', '-1'])).toMatch(/pm-kb .*knowledge bible/);
  });

  it('scenario 2: a CONFIRMED id whose cited file was edited after capture is skipped with basis_mismatch and not written', async () => {
    writeSrc('src/a.ts', 'export const a = 1;\n');
    writeSrc('src/b.ts', 'export const b = 1;\n');
    const ok = await confirmedCiting('Unchanged', ['src/a.ts']);
    const drift = await confirmedCiting('Changed', ['src/b.ts']);
    writeSrc('src/b.ts', 'export const b = 2;\n');

    const r = JSON.parse(await kbBibleCommit({ ids: [ok, drift], ...BASE }, { folder: clone }));

    expect(r.merged).toEqual([ok]);
    expect(r.skipped).toEqual([{ id: drift, reason: 'basis_mismatch' }]);
    expect(bibleIds()).toEqual([ok]);
  });

  it('an unknown or non-CONFIRMED id still reports not_confirmed_or_unknown', async () => {
    writeSrc('src/a.ts', 'export const a = 1;\n');
    const { id: inferred } = await provider.capture(makeInput({ title: 'Only inferred' }));

    const r = JSON.parse(await kbBibleCommit({ ids: [inferred, 'no-such-id'], ...BASE }, { folder: clone }));

    expect(r.merged).toEqual([]);
    expect(r.skipped).toEqual([
      { id: inferred, reason: 'not_confirmed_or_unknown' },
      { id: 'no-such-id', reason: 'not_confirmed_or_unknown' },
    ]);
    expect(r.committed).toBe(false);
  });

  it('scenario 3: on one mixed fixture, kb_bible_commit merges exactly the ids kb_export admits', async () => {
    for (const f of ['u', 'c', 'm', 'e', 'n', 'i']) writeSrc('src/' + f + '.ts', 'export const ' + f + ' = 1;\n');
    const u = await confirmedCiting('Unchanged', ['src/u.ts']);
    const c = await confirmedCiting('Changed', ['src/c.ts']);
    const m = await confirmedCiting('Missing', ['src/m.ts']);
    const e = await confirmedCiting('EmptyBasis', ['src/e.ts']);
    const n = await confirmedCiting('NonRelative', ['src/n.ts']);
    const i = await confirmedCiting('Inferred', ['src/i.ts']);

    writeSrc('src/c.ts', 'edited after capture\n');
    fs.rmSync(path.join(clone, 'src/m.ts'));
    db().prepare('UPDATE entries SET source_file_hashes = ? WHERE id = ?').run('{}', e);
    const nBasis = JSON.parse((db().prepare('SELECT source_file_hashes FROM entries WHERE id = ?').get(n) as any).source_file_hashes);
    db().prepare('UPDATE entries SET source_file_hashes = ? WHERE id = ?')
      .run(JSON.stringify({ ...nBasis, '../outside.ts': 'deadbeef' }), n);
    db().prepare("UPDATE entries SET confidence = 'INFERRED' WHERE id = ?").run(i);

    const all = [u, c, m, e, n, i];
    const commitResult = JSON.parse(await kbBibleCommit({ ids: all, ...BASE }, { folder: clone }));
    const mergedByCommit = [...commitResult.merged].sort();
    expect(commitResult.skipped.map((s: { id: string }) => s.id).sort()).toEqual([c, m, e, n, i].sort());
    expect(bibleIds()).toEqual(mergedByCommit);

    // Reset the bible (drop the pm-kb commit), then run kb_export on the same state.
    git(clone, ['reset', '--hard', '--quiet', 'HEAD~1']);
    expect(bibleIds()).toEqual([]);
    await kbExport({}, { folder: clone });
    const addedByExport = bibleIds();

    expect(mergedByCommit).toEqual([u]);
    expect(addedByExport).toEqual(mergedByCommit);
  });
});
