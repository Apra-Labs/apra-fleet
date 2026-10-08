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
import { createKbWorkClient } from '../../packages/apra-fleet-se/fleet-sprint/kb.mjs';
import { selfMaintainer } from '../../packages/apra-fleet-se/test/helpers/kb-maintainer-fakes.mjs';

// End to end over a REAL git work tree acting as the kb_maintainer's checkout
// (a bare origin plus one clone), with the REAL kb_bible_commit and kb_export
// handlers and a real SqliteProvider:
//
//   1. capture + promote an entry, then dirty its cited file WITHOUT
//      committing: both tools still admit it (HEAD matches its basis);
//   2. commit a real change to that file: both tools now refuse it;
//   3. an entry citing no source file is reported with its own reason and its
//      existing bible entry stays byte-identical;
//   4. the fleet-sprint engine's bible queue (createKbWorkClient.commitRound),
//      wired to the real kb_bible_commit through memberCall, keeps an id the
//      tool skipped with a transient basis_mismatch and merges it on a later
//      round once the basis matches.
//
// FALSIFICATION: pointing filterProjectBibleCandidates back at on-disk hashing
// (computeFileHashBatch) makes scenario 1 fail -- the dirty file no longer
// matches the basis, so the entry is skipped and kb_export leaves it out.
//
// Every repo and the KB file live under one temp root removed in afterEach.

const BIBLE_REL = '.fleet/kb-canonical.json';
const REASON = 'verified against the cited file at the sprint branch HEAD';

let root: string;
let origin: string;
let clone: string;
let provider: SqliteProvider;

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.local', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(clone, rel)), { recursive: true });
  fs.writeFileSync(path.join(clone, rel), body);
}

function commit(rel: string, msg: string): void {
  git(clone, ['add', '--', rel]);
  git(clone, ['commit', '--quiet', '--no-verify', '-m', msg, '--', rel]);
}

function makeInput(title: string, files: string[]): KBEntryInput {
  return {
    type: 'knowledge', title, summary: 'Summary of ' + title, content: 'Content of ' + title,
    source_files: files, symbols: ['sym' + title.replace(/\W/g, '')], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test', source: 'doer', confidence: 'INFERRED',
  };
}

async function confirmedCiting(title: string, files: string[]): Promise<string> {
  const { id } = await provider.capture(makeInput(title, files));
  await provider.promote(id, REASON);
  return id;
}

function db(): any {
  return (provider as any).getDb();
}

const biblePath = () => path.join(clone, BIBLE_REL);
function bibleIds(): string[] {
  if (!fs.existsSync(biblePath())) return [];
  return JSON.parse(fs.readFileSync(biblePath(), 'utf-8')).entries.map((e: { id: string }) => e.id).sort();
}
const head = () => git(clone, ['rev-parse', 'HEAD']).trim();
const base = () => ({ baseBranch: 'main', baseCommit: head() });

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-head-e2e-'));
  origin = path.join(root, 'origin.git');
  clone = path.join(root, 'clone');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '--quiet', origin, clone], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(clone, ['checkout', '--quiet', '-B', 'main']);
  write('src/a.ts', 'export const a = 1;\n');
  write('src/b.ts', 'export const b = 1;\n');
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

describe('bible admission on a real maintainer work tree: dirty edits never flip the verdict, commits do', () => {
  it('a dirty cited file leaves the entry admitted by both tools; committing a change refuses it in both', async () => {
    const id = await confirmedCiting('Admitted at HEAD', ['src/a.ts']);
    write('src/a.ts', 'export const a = 1; // dirty, not committed\n');

    // kb_bible_commit admits it (HEAD still equals the basis).
    const r1 = JSON.parse(await kbBibleCommit({ ids: [id], ...base() }, { folder: clone }));
    expect(r1.merged).toEqual([id]);
    expect(r1.skipped).toEqual([]);
    expect(r1.committed).toBe(true);
    // The pathspec-only bible commit never swept the dirty edit in.
    expect(git(clone, ['status', '--porcelain', '--', 'src/a.ts']).trimEnd()).toBe(' M src/a.ts');

    // kb_export (fresh bible) admits it too.
    git(clone, ['reset', '--hard', '--quiet', 'HEAD~1']);
    write('src/a.ts', 'export const a = 1; // dirty, not committed\n');
    await kbExport({}, { folder: clone });
    expect(bibleIds()).toEqual([id]);
    git(clone, ['reset', '--hard', '--quiet', 'origin/main']);
    write('src/a.ts', 'export const a = 1; // dirty, not committed\n');

    // Commit a REAL change: the HEAD content no longer matches the basis.
    write('src/a.ts', 'export const a = 2;\n');
    commit('src/a.ts', 'change a');
    const r2 = JSON.parse(await kbBibleCommit({ ids: [id], ...base() }, { folder: clone }));
    expect(r2.merged).toEqual([]);
    expect(r2.skipped).toEqual([{ id, reason: 'basis_mismatch' }]);
    expect(fs.existsSync(biblePath())).toBe(false);
    await kbExport({}, { folder: clone });
    expect(bibleIds()).toEqual([]);
  });

  it('an entry citing no source file gets its own reason; skipped ids keep their bible entries byte-identical', async () => {
    const drift = await confirmedCiting('Will drift', ['src/a.ts']);
    const noFiles = await confirmedCiting('Will lose its files', ['src/b.ts']);
    const first = JSON.parse(await kbBibleCommit({ ids: [drift, noFiles], ...base() }, { folder: clone }));
    expect(first.merged).toEqual([drift, noFiles]);
    const before = fs.readFileSync(biblePath());

    write('src/a.ts', 'export const a = 3;\n');
    commit('src/a.ts', 'change a');
    // A legacy row can cite nothing (no MCP path mints one any more).
    db().prepare("UPDATE entries SET source_files = '[]', source_file_hashes = '{}' WHERE id = ?").run(noFiles);

    const second = JSON.parse(await kbBibleCommit({ ids: [drift, noFiles], ...base() }, { folder: clone }));
    expect(second.merged).toEqual([]);
    expect(second.skipped).toEqual([
      { id: drift, reason: 'basis_mismatch' },
      { id: noFiles, reason: 'no_source_files' },
    ]);
    expect(second.committed).toBe(false);
    expect(Buffer.compare(fs.readFileSync(biblePath()), before)).toBe(0);
  });
});

describe('the engine bible queue against the real kb_bible_commit: a transient basis_mismatch is retried, not lost', () => {
  const MAINT = { id: 'maint-uuid', name: 'maint', type: 'local' };

  function engine() {
    const logs: string[] = [];
    const calls: { tool: string; args: any }[] = [];
    // memberCall routes the engine's KB calls to the real handlers / provider
    // anchored at the maintainer's real checkout.
    const memberCall = async (_member: unknown, tool: string, args: any) => {
      calls.push({ tool, args });
      if (tool === 'kb_query') {
        const inferred = await provider.list({ confidence: ['INFERRED'] });
        return { l1_results: inferred.map(e => ({ id: e.id, type: e.type, created_at: e.created_at })) };
      }
      if (tool === 'kb_promote') {
        await provider.promote(args.id, args.reason);
        return { id: args.id, promoted: true };
      }
      if (tool === 'kb_bible_commit') return kbBibleCommit(args, { folder: clone });
      return {};
    };
    const client = createKbWorkClient({
      memberCall,
      maintainers: selfMaintainer(MAINT, ['maint', 'reviewer-1']),
      gPull: async () => {},
      gPush: async () => { git(clone, ['push', '--quiet', 'origin', 'main']); },
      abortRebase: async () => false,
      bibleBase: async () => base(),
      bibleUnpushed: async () => {
        const local = git(clone, ['rev-parse', 'HEAD']).trim();
        const remote = git(clone, ['rev-parse', 'origin/main']).trim();
        return { unpushed: local !== remote };
      },
      log: (m: string) => logs.push(m),
    });
    return { client, logs, calls };
  }

  it('an id captured against an uncommitted edit is skipped, stays queued, and is merged and pushed once the edit is committed', async () => {
    // Captured while the edit is still uncommitted: the basis matches the work
    // tree, not HEAD (the transient case the queue must survive).
    write('src/b.ts', 'export const b = 2;\n');
    const ready = (await provider.capture(makeInput('Ready now', ['src/a.ts']))).id;
    const pendingEdit = (await provider.capture(makeInput('Waits for a commit', ['src/b.ts']))).id;

    const { client, logs, calls } = engine();
    await client.promotionCandidates('reviewer-1');
    await client.apply('reviewer', 'reviewer-1', { kb_promotions: [ready, pendingEdit].map(id => ({ id, reason: REASON })) });

    const round1 = await client.commitRound('review C1');
    expect(round1).toEqual({ committed: 1, pending: 1 });
    expect(client.pendingConfirmations()).toEqual([pendingEdit]);
    expect(logs.some(l => /kept queued for the next round/.test(l) && l.includes(pendingEdit))).toBe(true);
    expect(git(origin, ['show', 'main:' + BIBLE_REL])).toContain(ready);
    expect(git(origin, ['show', 'main:' + BIBLE_REL])).not.toContain(pendingEdit);

    // The doer commits the edit; the next round re-offers the queued id.
    commit('src/b.ts', 'commit the edit');
    git(clone, ['push', '--quiet', 'origin', 'main']);
    const round2 = await client.commitRound('review C2');

    const offered = calls.filter(c => c.tool === 'kb_bible_commit').map(c => c.args.ids);
    expect(offered).toEqual([[ready, pendingEdit], [pendingEdit]]);
    expect(round2).toEqual({ committed: 1, pending: 0 });
    expect(client.pendingConfirmations()).toEqual([]);
    const published = JSON.parse(git(origin, ['show', 'main:' + BIBLE_REL])).entries.map((e: { id: string }) => e.id).sort();
    expect(published).toEqual([ready, pendingEdit].sort());
  });
});
