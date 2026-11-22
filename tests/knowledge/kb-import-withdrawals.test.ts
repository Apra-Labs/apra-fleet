import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbImport } from '../../src/tools/kb-import.js';
import { getMemberBibleView, resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntry, KBEntryInput } from '../../src/services/knowledge/types.js';

// kb_import applies a bible's "withdrawn" tombstones ONLY when the bible is the
// merged base bible: read at refs/remotes/origin/<base>, where <base> is the
// caller's base_branch (else the branch refs/remotes/origin/HEAD names, as a
// clone records it), and its provenance.branch is that same <base>. A base
// remote with another name (any remote configured in the clone) works the same
// way; a remote-tracking ref of an unknown remote is deferred with a warning
// naming the ref that was expected. From the
// work tree, HEAD or a feature ref the tombstones are view exclusions only and
// the ids are reported in withdrawals.deferred.
//
// Real SqliteProvider over a real temp git checkout, the real kb_import
// handler; the only spy is getKbProviders, pointing the handler at this test's
// provider (the seam kb-tombstone-import.test.ts uses).
//
// FALSIFICATION: on a tree without the base-ref gate (kb_import ignores every
// reason but "demoted"), the base-ref case lowers nothing and the report has
// no withdrawals block, so every test here fails (checked by stashing
// src/tools/kb-import.ts and src/services/knowledge/bible-import.ts).
//
// All temp state lives under one root removed in afterEach.

const NOTE = 'the cited guard was removed when the reader was rewritten';
const WITHDRAWN_AT = '2021-06-01T00:00:00.000Z';

let root: string;
let repo: string;
let provider: SqliteProvider;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeInput(over: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge', title: 'T', summary: 'Summary', content: 'Content body.',
    source_files: ['src/y.ts'], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test-agent', source: 'doer', confidence: 'INFERRED',
    ...over,
  };
}

function db(): any {
  return (provider as any).getDb();
}

function confidenceOf(id: string): string {
  return (db().prepare('SELECT confidence FROM entries WHERE id = ?').get(id) as { confidence: string }).confidence;
}

async function confirmed(title: string, promotedAt: string): Promise<string> {
  const { id } = await provider.capture(makeInput({ title, summary: 'Summary of ' + title, symbols: ['sym' + title] }));
  await provider.promote(id, 'test fixture: verified');
  await provider.promote(id, 'test fixture: verified');
  db().prepare('UPDATE entries SET created_at = ?, promoted_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', promotedAt, id);
  return id;
}

/**
 * Commit a v3 bible for base branch `main` on the current branch. It carries a
 * kept entry and (as a hand-edited bible would) the withdrawn entry too, so the
 * member view's exclusion of the tombstoned id is observable.
 */
function commitBible(withdrawnIds: string[], provenanceBranch = 'main'): void {
  const entry = (id: string, title: string) => ({
    id, type: 'knowledge', title, summary: 'Summary of ' + title, symbols: [], source_files: ['src/y.ts'],
    confidence: 'CONFIRMED', updated_at: '2020-01-01T00:00:00.000Z',
  });
  const bible = {
    version: 3,
    provenance: { commit: 'b'.repeat(40), branch: provenanceBranch, entry_count: 1 + withdrawnIds.length },
    entries: [entry('kept-1', 'Kept fact'), ...withdrawnIds.map(id => entry(id, 'Withdrawn fact ' + id))],
    demotions: withdrawnIds.map(id => ({ id, at: WITHDRAWN_AT, reason: 'withdrawn', note: NOTE, evidence_files: ['src/y.ts'] })),
  };
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), JSON.stringify(bible, null, 2) + '\n');
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'bible']);
}

async function importAt(ref?: string, baseBranch?: string): Promise<any> {
  const input: Record<string, unknown> = { skip_sweep: true };
  if (ref !== undefined) input.ref = ref;
  if (baseBranch !== undefined) input.base_branch = baseBranch;
  return JSON.parse(await kbImport(input as any, { folder: repo }));
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-import-withdrawals-'));
  repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'y.ts'), 'export const y = 1;\n');
  execFileSync('git', ['init', '--quiet', '-b', 'main', repo]);
  git(['config', 'user.name', 'test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'seed']);
  // As git clone records it: the remote's default branch is main.
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  provider = new SqliteProvider(path.join(root, 'kb.sqlite'), repo);
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockImplementation(
    async () => ({ project: provider, global: provider, projectSlug: 'test' }) as any,
  );
});

afterEach(() => {
  provider.close();
  resetMemberBibleViews();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('kb_import applies withdrawn tombstones only from the merged base bible (SQLite)', () => {
  it('read at refs/remotes/origin/<provenance.branch>: the row is lowered and reported withdrawn', async () => {
    const y = await confirmed('Ypsilon', '2020-02-01T00:00:00.000Z');
    commitBible([y]);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    const report = await importAt('refs/remotes/origin/main');
    expect(report.bible_source).toBe('refs/remotes/origin/main');
    expect(report.withdrawals).toEqual({
      sent: 1, withdrawn: [y], repromoted: [], already: [], not_found: [], unsupported: [], deferred: [],
    });
    expect(confidenceOf(y)).toBe('INFERRED');
    const content = (db().prepare('SELECT content FROM entries WHERE id = ?').get(y) as { content: string }).content;
    expect(content).toContain('withdrawn in the project bible: ' + NOTE);

    // A second import of the same bible changes nothing and says so.
    const again = await importAt('refs/remotes/origin/main');
    expect(again.withdrawals.already).toEqual([y]);
    expect(again.withdrawals.withdrawn).toEqual([]);
  });

  it('from the work tree, HEAD or a feature ref nothing is lowered, the id is deferred, and the member view hides it', async () => {
    const y = await confirmed('Ypsilon', '2020-02-01T00:00:00.000Z');
    git(['checkout', '--quiet', '-b', 'feat/x']);
    commitBible([y]);
    git(['update-ref', 'refs/remotes/origin/feat/x', 'HEAD']);

    for (const ref of [undefined, 'HEAD', 'refs/remotes/origin/feat/x']) {
      const report = await importAt(ref);
      expect(report.withdrawals, String(ref)).toEqual({
        sent: 0, withdrawn: [], repromoted: [], already: [], not_found: [], unsupported: [], deferred: [y],
      });
      expect(confidenceOf(y), String(ref)).toBe('CONFIRMED');
    }

    const view = await getMemberBibleView({ folder: repo });
    expect((await view.list({})).map((e: KBEntry) => e.id)).toEqual(['kept-1']);
  });

  it('a branch bible whose provenance.branch names its own feature branch, read at refs/remotes/origin/<feature>, is deferred', async () => {
    // kb_bible_commit writes provenance.branch from its caller's baseBranch,
    // so a branch bible committed with baseBranch = its own feature branch
    // and pushed names its own remote-tracking ref as "the base".
    const y = await confirmed('Ypsilon', '2020-02-01T00:00:00.000Z');
    git(['checkout', '--quiet', '-b', 'feat/x']);
    commitBible([y], 'feat/x');
    git(['update-ref', 'refs/remotes/origin/feat/x', 'HEAD']);

    for (const baseBranch of [undefined, 'main']) {
      const report = await importAt('refs/remotes/origin/feat/x', baseBranch);
      expect(report.bible_source).toBe('refs/remotes/origin/feat/x');
      expect(report.withdrawals, String(baseBranch)).toEqual({
        sent: 0, withdrawn: [], repromoted: [], already: [], not_found: [], unsupported: [], deferred: [y],
      });
      expect(confidenceOf(y), String(baseBranch)).toBe('CONFIRMED');
    }
  });

  it('the real base ref with an explicit base_branch applies the tombstones; a base_branch the bible does not name defers them', async () => {
    const y = await confirmed('Ypsilon', '2020-02-01T00:00:00.000Z');
    commitBible([y]);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    // The explicit base_branch is used even when the remote HEAD is unknown.
    git(['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);

    const mismatch = await importAt('refs/remotes/origin/main', 'release');
    expect(mismatch.withdrawals.deferred).toEqual([y]);
    expect(confidenceOf(y)).toBe('CONFIRMED');

    const report = await importAt('refs/remotes/origin/main', 'main');
    expect(report.withdrawals).toEqual({
      sent: 1, withdrawn: [y], repromoted: [], already: [], not_found: [], unsupported: [], deferred: [],
    });
    expect(confidenceOf(y)).toBe('INFERRED');
  });

  it('without base_branch and without refs/remotes/origin/HEAD the base is unknown: deferred, with a warning saying why', async () => {
    const y = await confirmed('Ypsilon', '2020-02-01T00:00:00.000Z');
    commitBible([y]);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    git(['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);

    const report = await importAt('refs/remotes/origin/main');
    expect(report.withdrawals.deferred).toEqual([y]);
    expect(report.withdrawals.sent).toBe(0);
    expect(report.withdrawals.warning).toMatch(/base branch is unknown/);
    expect(report.withdrawals.warning).toContain('refs/remotes/origin/HEAD');
    expect(report.withdrawals.warning).toContain('base_branch');
    expect(confidenceOf(y)).toBe('CONFIRMED');
  });

  it('a clone whose base remote is not named origin: refs/remotes/<that remote>/<base> is resolved and the tombstones apply', async () => {
    const y = await confirmed('Ypsilon', '2020-02-01T00:00:00.000Z');
    commitBible([y]);
    git(['remote', 'add', 'upstream', 'https://example.invalid/base.git']);
    git(['update-ref', 'refs/remotes/upstream/main', 'HEAD']);
    git(['symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/main']);

    const report = await importAt('refs/remotes/upstream/main');
    expect(report.bible_source).toBe('refs/remotes/upstream/main');
    expect(report.withdrawals).toEqual({
      sent: 1, withdrawn: [y], repromoted: [], already: [], not_found: [], unsupported: [], deferred: [],
    });
    expect(confidenceOf(y)).toBe('INFERRED');
  });

  it('a remote-tracking ref of a remote the clone does not know: deferred, and the warning names the ref it expected', async () => {
    const y = await confirmed('Ypsilon', '2020-02-01T00:00:00.000Z');
    commitBible([y]);
    git(['remote', 'add', 'upstream', 'https://example.invalid/base.git']);
    // A stale ref left behind by a remote that is no longer configured.
    git(['update-ref', 'refs/remotes/fork/main', 'HEAD']);

    const report = await importAt('refs/remotes/fork/main', 'main');
    expect(report.withdrawals.deferred).toEqual([y]);
    expect(report.withdrawals.sent).toBe(0);
    expect(report.withdrawals.warning).toContain('refs/remotes/fork/main is not a remote-tracking ref of a configured remote');
    expect(report.withdrawals.warning).toContain('expected refs/remotes/origin/main or refs/remotes/upstream/main');
    expect(confidenceOf(y)).toBe('CONFIRMED');
  });

  it('an origin clone is unchanged: refs/remotes/origin/<base> still applies when another remote is also configured', async () => {
    const y = await confirmed('Ypsilon', '2020-02-01T00:00:00.000Z');
    commitBible([y]);
    git(['remote', 'add', 'origin', 'https://example.invalid/origin.git']);
    git(['remote', 'add', 'upstream', 'https://example.invalid/base.git']);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    const report = await importAt('refs/remotes/origin/main');
    expect(report.withdrawals).toEqual({
      sent: 1, withdrawn: [y], repromoted: [], already: [], not_found: [], unsupported: [], deferred: [],
    });
    expect(confidenceOf(y)).toBe('INFERRED');
  });

  it('a row re-promoted after the tombstone stays CONFIRMED and is reported repromoted; an unknown id is not_found', async () => {
    const y = await confirmed('Ypsilon', '2022-01-01T00:00:00.000Z');
    commitBible([y, 'ghost-1']);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);

    const report = await importAt('refs/remotes/origin/main');
    expect(report.withdrawals.repromoted).toEqual([y]);
    expect(report.withdrawals.not_found).toEqual(['ghost-1']);
    expect(report.withdrawals.sent).toBe(2);
    expect(confidenceOf(y)).toBe('CONFIRMED');
    expect(db().prepare('SELECT id FROM entries WHERE id = ?').get('ghost-1')).toBeUndefined();
  });

  it('a demoted tombstone keeps its behaviour and is never reported as a withdrawal', async () => {
    const y = await confirmed('Ypsilon', '2020-02-01T00:00:00.000Z');
    const bible = {
      version: 3, provenance: { commit: null, branch: 'main', entry_count: 0 }, entries: [],
      demotions: [{ id: y, at: WITHDRAWN_AT, reason: 'demoted' }],
    };
    fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), JSON.stringify(bible));
    const report = await importAt();
    expect(report.demoted).toBe(1);
    expect(report.withdrawals).toEqual({
      sent: 0, withdrawn: [], repromoted: [], already: [], not_found: [], unsupported: [], deferred: [],
    });
  });
});
