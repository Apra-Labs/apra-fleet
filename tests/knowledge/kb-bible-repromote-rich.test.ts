import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { kbDemote } from '../../src/tools/kb-demote.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { commitWorkTree } from '../helpers/commit-work-tree.js';

// PR 790 judge F1: demote then re-promote on a clone whose row is POORER than
// the bible entry (missing content and cues) must not lose the bible's content
// and cues. The demotion removed the entry from the bible, so the current file
// holds no prior; kb_bible_commit reads it from the bible's git history.
//
// Real temp git repo, real SqliteProvider, real kb_demote/kb_bible_commit; only
// getKbProviders is pointed at this test's provider. Every assertion reads the
// bible back from disk. All files live under one sandbox removed in afterEach.

const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };
const SUMMARY = 'alpha must be read before beta, or beta throws a ReferenceError at load.';
const RICH_CONTENT = 'The module loader evaluates alpha lazily, so a direct import of beta from a test '
  + 'file reaches the getter before alpha has initialised; import alpha first in the test setup.';
const RICH_CUES = ['why does beta throw at load', 'beta ReferenceError in tests'];
const RICH_SIGNATURES = ['ReferenceError: alpha is not defined'];

let sandbox: string;
let repo: string;
let provider: SqliteProvider;
let savedGitEnv: Array<[string, string | undefined]>;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const biblePath = () => path.join(repo, '.fleet', 'kb-canonical.json');
const bibleDoc = () => JSON.parse(fs.readFileSync(biblePath(), 'utf-8'));
const bibleEntry = (id: string) => bibleDoc().entries.find((e: { id: string }) => e.id === id);

beforeEach(async () => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-repromote-rich-')));
  const gitconfig = path.join(sandbox, '.gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = KB Test\n\temail = kb@test.invalid\n[commit]\n\tgpgsign = false\n');
  savedGitEnv = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].map(k => [k, process.env[k]]);
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  repo = path.join(sandbox, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  fs.writeFileSync(path.join(repo, 'src', 'alpha.ts'), 'export const alpha = 1;\n');
  execFileSync('git', ['init', '--quiet', '-b', 'main', repo]);
  commitWorkTree(repo, 'seed');
  provider = new SqliteProvider(path.join(sandbox, 'kb.sqlite'), repo);
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider, global: provider, projectSlug: 'test',
  } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  provider.close();
  for (const [k, v] of savedGitEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A CONFIRMED entry in the bible, enriched with content, cues and signatures. */
async function richBibleEntry(): Promise<string> {
  const { id } = await provider.capture({
    type: 'learning', title: 'alpha must be read before beta', summary: SUMMARY, content: SUMMARY,
    source_files: ['src/alpha.ts'], symbols: ['alpha'], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test-agent', source: 'doer', confidence: 'INFERRED',
  });
  await provider.promote(id, 'test fixture: verified');
  await provider.promote(id, 'test fixture: verified');
  const first = JSON.parse(await kbBibleCommit({ ids: [id], ...BASE }, { folder: repo }));
  expect(first.committed).toBe(true);
  const enriched = JSON.parse(await kbBibleCommit({
    ids: [], ...BASE,
    enrich: [{ id, content: RICH_CONTENT, recall_cues: RICH_CUES, error_signatures: RICH_SIGNATURES }],
  }, { folder: repo }));
  expect(enriched.enriched).toEqual([id]);
  expect(enriched.committed).toBe(true);
  return id;
}

/** Make the local row as poor as a clone that never saw the enrich. */
function impoverishRow(id: string): void {
  (provider as any).getDb()
    .prepare("UPDATE entries SET content = ?, recall_cues = '[]', error_signatures = '[]' WHERE id = ?")
    .run(SUMMARY, id);
}

describe('kb_bible_commit: demote then re-promote keeps the bible rich fields (F1)', () => {
  it('re-promote from a poorer row restores the content, cues and signatures from bible history', async () => {
    const id = await richBibleEntry();
    expect(bibleEntry(id).content).toBe(RICH_CONTENT);

    // Demote: the entry leaves the bible and a tombstone takes its place.
    await kbDemote({ id, reason: 'the cited behaviour did not hold on the case checked', evidence_files: ['README.md'] }, { folder: repo });
    const dem = JSON.parse(await kbBibleCommit({ ids: [], demoted_ids: [id], ...BASE }, { folder: repo }));
    expect(dem.demoted).toEqual([id]);
    expect(bibleEntry(id)).toBeUndefined();

    // The re-promoting clone holds a poorer row: no content, no cues.
    impoverishRow(id);
    await provider.promote(id, 'test fixture: re-verified on newer evidence');
    const row = (await provider.query({ ids: [id] })).results[0];
    expect(row.recall_cues).toEqual([]);

    const r = JSON.parse(await kbBibleCommit({ ids: [id], ...BASE }, { folder: repo }));
    expect(r.merged).toEqual([id]);
    expect(r.committed).toBe(true);

    const back = bibleEntry(id);
    expect(back.content).toBe(RICH_CONTENT);
    expect(back.recall_cues).toEqual(RICH_CUES);
    expect(back.error_signatures).toEqual(RICH_SIGNATURES);
    expect(bibleDoc().demotions).toBeUndefined();
    expect(git(['status', '--porcelain', '--', '.fleet/kb-canonical.json']).trim()).toBe('');
  });

  it('a first-time merge of an id never in the bible is untouched by history (fresh row wins)', async () => {
    const { id } = await provider.capture({
      type: 'learning', title: 'gamma is plain', summary: 'gamma is a plain constant with no lesson body.',
      content: 'gamma is a plain constant with no lesson body.',
      source_files: ['src/alpha.ts'], symbols: ['gamma'], tags: [], content_hash: '', content_hash_type: 'sha256',
      flagged_for_review: false, author: 'test-agent', source: 'doer', confidence: 'INFERRED',
    });
    await provider.promote(id, 'test fixture: verified');
    await provider.promote(id, 'test fixture: verified');
    const r = JSON.parse(await kbBibleCommit({ ids: [id], ...BASE }, { folder: repo }));
    expect(r.merged).toEqual([id]);
    const e = bibleEntry(id);
    expect(e.content).toBeUndefined();
    expect(e.recall_cues).toBeUndefined();
  });
});
