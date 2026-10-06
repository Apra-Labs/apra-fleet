import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { kbPromote } from '../../src/tools/kb-promote.js';
import { kbInvalidate } from '../../src/tools/kb-invalidate.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { kbExport } from '../../src/tools/kb-export.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';

// End to end over a REAL git work tree acting as the kb_maintainer's checkout
// (a bare origin plus one clone), driven only through the REAL tool handlers
// (kb_capture, kb_promote, kb_invalidate, kb_bible_commit, kb_export) on a
// real SqliteProvider:
//
//   1. three entries are captured, promoted to CONFIRMED and committed to the
//      bible by kb_bible_commit;
//   2. one is superseded (a capture naming it in supersedes) and one is
//      invalidated (kb_invalidate by id); the third stays CONFIRMED;
//   3. kb_export over that state removes nothing -- it is additive-only;
//   4. kb_bible_commit (no ids) removes the superseded and the invalidated
//      entries from .fleet/kb-canonical.json, its commit (git log -1) names
//      both ids with their reasons, and the third entry is byte-identical;
//   5. kb_export over the same KB state afterwards still removes nothing.
//
// FALSIFICATION: dropping the removal step in src/tools/kb-bible-commit.ts
// (an empty retirement map instead of getRetirementReasons) makes step 4's
// first assertion FAIL: both retired entries stay in the bible and no commit
// is made.
//
// Every repo and the KB file live under one temp root removed in afterEach.

const BIBLE_REL = '.fleet/kb-canonical.json';
const REASON = 'verified against the cited file at the sprint branch HEAD';

let root: string;
let clone: string;
let provider: SqliteProvider;

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.local', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const anchor = () => ({ folder: clone });
const biblePath = () => path.join(clone, BIBLE_REL);
function bible(): { entries: Array<Record<string, unknown> & { id: string }> } {
  return JSON.parse(fs.readFileSync(biblePath(), 'utf-8'));
}
function bibleIds(): string[] {
  return bible().entries.map(e => e.id).sort();
}
function bibleEntry(id: string): string {
  return JSON.stringify(bible().entries.find(e => e.id === id));
}
const head = () => git(clone, ['rev-parse', 'HEAD']).trim();
const base = () => ({ baseBranch: 'main', baseCommit: head() });

function confidenceOf(id: string): string {
  return ((provider as any).getDb().prepare('SELECT confidence FROM entries WHERE id = ?').get(id) as { confidence: string }).confidence;
}

/** Capture through kb_capture and promote through kb_promote until CONFIRMED. */
async function confirmed(name: string, file: string): Promise<string> {
  const { id } = JSON.parse(await kbCapture({
    type: 'knowledge', title: name + ' behaviour', summary: 'What ' + name + ' does, for the bible.',
    content: 'Original description of ' + name + '.', source_files: [file], symbols: [name],
  }, anchor()));
  for (let i = 0; i < 3 && confidenceOf(id) !== 'CONFIRMED'; i++) {
    await kbPromote({ id, reason: REASON }, anchor());
  }
  expect(confidenceOf(id)).toBe('CONFIRMED');
  return id;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-prune-e2e-'));
  const origin = path.join(root, 'origin.git');
  clone = path.join(root, 'clone');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, clone], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(clone, ['checkout', '--quiet', '-B', 'main']);
  for (const f of ['alpha', 'beta', 'gamma']) {
    fs.mkdirSync(path.join(clone, 'src'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'src', f + '.ts'), 'export function ' + f + '(): number {\n  return 1;\n}\n');
  }
  git(clone, ['add', '-A']);
  git(clone, ['commit', '--quiet', '--no-verify', '-m', 'seed']);
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

describe('the maintainer bible drops superseded and invalidated entries; kb_export stays additive', () => {
  it('kb_bible_commit removes both retired entries and names them in git log -1; the CONFIRMED one is unchanged; kb_export removes nothing', async () => {
    // 1. Three CONFIRMED entries in the bible.
    const superseded = await confirmed('alpha', 'src/alpha.ts');
    const invalidated = await confirmed('beta', 'src/beta.ts');
    const kept = await confirmed('gamma', 'src/gamma.ts');
    const seeded = JSON.parse(await kbBibleCommit({ ids: [superseded, invalidated, kept], ...base() }, anchor()));
    expect(seeded.committed).toBe(true);
    expect(bibleIds()).toEqual([superseded, invalidated, kept].sort());
    const keptBefore = bibleEntry(kept);

    // 2. Supersede one (a capture naming it in supersedes), invalidate another.
    const replacement = JSON.parse(await kbCapture({
      type: 'knowledge', title: 'alpha behaviour', summary: 'What alpha does, for the bible.',
      content: 'Corrected description of alpha: it returns one, always.', source_files: ['src/alpha.ts'],
      symbols: ['alpha'], supersedes: superseded,
    }, anchor()));
    expect(replacement.audn_decision).toBe('update');
    const inv = JSON.parse(await kbInvalidate({ ids: [invalidated] }, anchor()));
    expect(inv.discarded).toEqual([invalidated]);

    // 3. kb_export over that state removes nothing.
    const headBeforeExport = head();
    await kbExport({}, anchor());
    expect(bibleIds()).toEqual([superseded, invalidated, kept].sort());
    expect(head()).toBe(headBeforeExport);

    // 4. kb_bible_commit removes both retired entries and says so.
    const r = JSON.parse(await kbBibleCommit({ ids: [], ...base() }, anchor()));
    expect(bibleIds()).toEqual([kept]);
    expect(r.committed).toBe(true);
    expect(r.removed).toEqual(expect.arrayContaining([
      { id: superseded, reason: 'superseded' },
      { id: invalidated, reason: 'invalidated' },
    ]));
    expect(r.removed).toHaveLength(2);
    const message = git(clone, ['log', '-1', '--format=%B']);
    expect(message).toContain('- ' + superseded + ' (superseded)');
    expect(message).toContain('- ' + invalidated + ' (invalidated)');
    expect(git(clone, ['log', '-1', '--format=%an']).trim()).toBe('pm-kb');
    expect(bibleEntry(kept)).toBe(keptBefore);

    // 5. kb_export over the same KB state still removes nothing.
    await kbExport({}, anchor());
    expect(bibleIds()).toEqual([kept]);
    expect(bibleEntry(kept)).toBe(keptBefore);
  });
});
