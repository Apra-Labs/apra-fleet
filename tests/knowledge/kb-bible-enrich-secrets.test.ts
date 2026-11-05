// kb_bible_commit keeps and backfills an entry's rich fields (enrich, and a
// re-promotion that keeps what the bible holds), and no secret-shaped text
// reaches a bible through a merge or an export.
//
// Real handlers and real SqliteProviders in a per-test sandbox, as in
// kb-bible-rich-content.test.ts: only the provider lookup is redirected.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import * as toolScope from '../../src/services/tool-scope.js';
import { kbCapture, kbCaptureSchema } from '../../src/tools/kb-capture.js';
import { kbPromote } from '../../src/tools/kb-promote.js';
import { kbExport, bibleContentOf, hasBibleSecret, scrubBibleSecrets, toCanonicalEntry } from '../../src/tools/kb-export.js';
import { bibleCommitMessage, kbBibleCommit, kbBibleCommitSchema } from '../../src/tools/kb-bible-commit.js';
import { kbImport } from '../../src/tools/kb-import.js';
import { vetKbWork } from '../../packages/apra-fleet-se/fleet-sprint/kb.mjs';

// Real git commits per test, several of them when calls queue: 5s is too tight
// when other test files share the machine.
vi.setConfig({ testTimeout: 60000 });

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BASE = { baseBranch: 'main', baseCommit: '1111111111111111111111111111111111111111' };
const SUMMARY = 'Reading beta before alpha throws during module init.';
const RICH_CONTENT = 'Symptom: importing beta first raises a ReferenceError. Rule/Fix: import alpha first.';

// Built by concatenation: no token-shaped literal lives in this repository.
const TOKENS: Record<string, string> = {
  'classic GitHub token': 'gh' + 'p_' + 'a1'.repeat(18),
  'GitHub server token': 'gh' + 's_' + 'b2'.repeat(18),
  'fine-grained GitHub token': 'github' + '_pat_' + 'c3'.repeat(20),
  'Slack token': 'xo' + 'xb-' + '1234567890-abcdefgh',
  'AWS access key': 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP',
  'bearer value': 'Bear' + 'er ' + 'd4'.repeat(20),
  'secret placeholder': '{{' + 'secret.GH_TOKEN' + '}}',
};

let sandbox: string;
let repoA: string;
let repoB: string;
let providerA: SqliteProvider;
let providerB: SqliteProvider;
let savedGitEnv: Array<[string, string | undefined]>;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function makeRepo(name: string): string {
  const root = path.join(sandbox, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  git(root, ['init', '-q', '.']);
  git(root, ['remote', 'add', 'origin', 'git@github.com:acme/kb-enrich-' + name + '.git']);
  fs.writeFileSync(path.join(root, 'src', 'alpha.ts'), 'export const alpha = 1;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--no-verify', '-m', 'seed']);
  return root;
}

beforeEach(async () => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-enrich-')));
  const gitconfig = path.join(sandbox, '.gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = KB Test\n\temail = kb@test.invalid\n[commit]\n\tgpgsign = false\n');
  savedGitEnv = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].map(k => [k, process.env[k]]);
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  repoA = makeRepo('a');
  repoB = makeRepo('b');
  providerA = new SqliteProvider(path.join(sandbox, 'kb-a.sqlite'), repoA);
  providerB = new SqliteProvider(path.join(sandbox, 'kb-b.sqlite'), repoB);
  await providerA.init();
  await providerB.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockImplementation(async (repoPath?: string) => {
    const p = repoPath !== undefined && path.resolve(repoPath) === repoB ? providerB : providerA;
    return { project: p, global: p, projectSlug: 'kb-enrich' } as any;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  providerA.close();
  providerB.close();
  for (const [k, v] of savedGitEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const A = () => ({ folder: repoA });
const B = () => ({ folder: repoB });
const biblePath = (repo: string) => path.join(repo, '.fleet', 'kb-canonical.json');
const bibleText = (repo: string) => fs.readFileSync(biblePath(repo), 'utf-8');
const bibleEntry = (repo: string, id: string) => JSON.parse(bibleText(repo)).entries.find((e: { id: string }) => e.id === id);
const stored = async (p: SqliteProvider, id: string) => (await p.query({ ids: [id] })).results[0];
const commit = async (args: Record<string, unknown>) =>
  JSON.parse(await kbBibleCommit(kbBibleCommitSchema.parse({ ids: [], ...BASE, ...args }), A()));

/** A CONFIRMED entry merged into repo A's bible, with no rich fields. */
async function plainBibleEntry(symbol = 'alpha'): Promise<string> {
  const { id } = JSON.parse(await kbCapture(kbCaptureSchema.parse({
    type: 'learning', title: 'alpha must be read before beta: ' + symbol, summary: SUMMARY,
    source_files: ['src/alpha.ts'], symbols: [symbol],
  }), A()));
  await kbPromote({ id, reason: 'verified: reproduced the ReferenceError by hand' }, A());
  await commit({ ids: [id] });
  return id;
}

describe('kb_bible_commit enrich', () => {
  it('sets content, cues and signatures in the bible and the row, commits, and moves nothing else', async () => {
    const id = await plainBibleEntry();
    const before = bibleEntry(repoA, id);
    expect(before.content).toBeUndefined();

    const out = await commit({ enrich: [{ id, content: RICH_CONTENT, recall_cues: ['why does beta throw'], error_signatures: ['ReferenceError: alpha'] }] });

    expect(out.enriched).toEqual([id]);
    expect(out.skipped).toEqual([]);
    expect(out.committed).toBe(true);
    expect(git(repoA, ['log', '-1', '--format=%s'])).toMatch(/^chore\(kb\): enrich 1 knowledge bible entries -- 1 total/);

    const after = bibleEntry(repoA, id);
    expect(after).toEqual({ ...before, content: RICH_CONTENT, recall_cues: ['why does beta throw'], error_signatures: ['ReferenceError: alpha'] });
    // toCanonicalEntry's key order, so the diff is the three fields and nothing else.
    expect(Object.keys(after)).toEqual(['id', 'type', 'title', 'summary', 'content', 'symbols', 'source_files', 'recall_cues', 'error_signatures', 'confidence', 'updated_at', 'source_file_hashes']);

    const row = await stored(providerA, id);
    expect(row.content.startsWith(RICH_CONTENT)).toBe(true);
    expect(row.recall_cues).toEqual(['why does beta throw']);
    expect(row.error_signatures).toEqual(['ReferenceError: alpha']);
    expect(row.confidence).toBe('CONFIRMED');
  });

  it('keeps the row audit notes, which never reach the bible', async () => {
    const id = await plainBibleEntry();
    expect((await stored(providerA, id)).content).toMatch(/\n\[Promoted/);
    await commit({ enrich: [{ id, content: RICH_CONTENT }] });
    const row = await stored(providerA, id);
    expect(row.content).toMatch(new RegExp('^' + RICH_CONTENT.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '\\n+\\[Promoted'));
    expect(bibleEntry(repoA, id).content).toBe(RICH_CONTENT);
  });

  it('needs no basis re-admission: it works after the cited file moved on at HEAD', async () => {
    const id = await plainBibleEntry();
    fs.writeFileSync(path.join(repoA, 'src', 'alpha.ts'), 'export const alpha = 2;\n');
    git(repoA, ['add', '-A']);
    git(repoA, ['commit', '-q', '--no-verify', '-m', 'moved']);
    const hashes = bibleEntry(repoA, id).source_file_hashes;
    const out = await commit({ enrich: [{ id, content: RICH_CONTENT }] });
    expect(out.enriched).toEqual([id]);
    expect(bibleEntry(repoA, id).source_file_hashes).toEqual(hashes);
  });

  it('a field left out stays as it is; an empty list clears a list', async () => {
    const id = await plainBibleEntry();
    await commit({ enrich: [{ id, content: RICH_CONTENT, recall_cues: ['a cue'], error_signatures: ['an error'] }] });
    await commit({ enrich: [{ id, recall_cues: [] }] });
    const after = bibleEntry(repoA, id);
    expect(after.content).toBe(RICH_CONTENT);
    expect(after.recall_cues).toBeUndefined();
    expect(after.error_signatures).toEqual(['an error']);
  });

  it('can name an id merged by the same call', async () => {
    const { id } = JSON.parse(await kbCapture(kbCaptureSchema.parse({
      type: 'learning', title: 'a lesson merged and enriched at once', summary: SUMMARY, source_files: ['src/alpha.ts'], symbols: ['together'],
    }), A()));
    await kbPromote({ id, reason: 'verified: reproduced the ReferenceError by hand' }, A());
    const out = await commit({ ids: [id], enrich: [{ id, content: RICH_CONTENT }] });
    expect(out.merged).toEqual([id]);
    expect(out.enriched).toEqual([id]);
    expect(bibleEntry(repoA, id).content).toBe(RICH_CONTENT);
    expect(git(repoA, ['log', '-1', '--format=%b'])).toContain('Enriched 1 existing entries.');
  });

  it('enriches a bible entry this KB has no row for, in the bible only', async () => {
    fs.mkdirSync(path.join(repoA, '.fleet'), { recursive: true });
    const held = { id: 'from-another-host', type: 'knowledge', title: 'held only in the bible', summary: SUMMARY, symbols: [], source_files: ['src/alpha.ts'], confidence: 'CONFIRMED', updated_at: '2026-01-01T00:00:00.000Z' };
    fs.writeFileSync(biblePath(repoA), JSON.stringify({ version: 3, provenance: { commit: null, branch: null, entry_count: 1 }, entries: [held] }));
    const out = await commit({ enrich: [{ id: held.id, content: RICH_CONTENT }] });
    expect(out.enriched).toEqual([held.id]);
    expect(bibleEntry(repoA, held.id)).toEqual({ ...held, content: RICH_CONTENT });
    expect(providerA.hasEntry(held.id)).toBe(false);
  });

  it('skips, with a reason and no write: unknown, below CONFIRMED, no field, content equal to the summary, a secret', async () => {
    const id = await plainBibleEntry();
    const { id: inferred } = JSON.parse(await kbCapture(kbCaptureSchema.parse({
      type: 'learning', title: 'an entry still at INFERRED here', summary: 'An unconfirmed claim about beta during load.', source_files: ['src/alpha.ts'], symbols: ['inferredOnly'],
    }), A()));
    const textBefore = bibleText(repoA);
    const headBefore = git(repoA, ['rev-parse', 'HEAD']);
    const rowBefore = (await stored(providerA, id)).content;

    const out = await commit({
      enrich: [
        { id: 'no-such-entry', content: RICH_CONTENT },
        { id: inferred, content: RICH_CONTENT },
        { id },
        { id, content: SUMMARY },
        { id, content: 'Context: the job sends ' + TOKENS['classic GitHub token'] + ' with each call.' },
        { id, recall_cues: ['denied for ' + TOKENS['secret placeholder']] },
      ],
    });

    expect(out.enriched).toEqual([]);
    expect(out.committed).toBe(false);
    expect(out.skipped).toEqual([
      { id: 'no-such-entry', reason: 'not_in_bible' },
      { id: inferred, reason: 'not_in_bible' },
      { id, reason: 'enrich_invalid' },
      { id, reason: 'enrich_invalid' },
      { id, reason: 'enrich_invalid' },
      { id, reason: 'enrich_invalid' },
    ]);
    expect(bibleText(repoA)).toBe(textBefore);
    expect(git(repoA, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect((await stored(providerA, id)).content).toBe(rowBefore);
  });

  it('breaking a capture rule skips that item with enrich_invalid, and the others in the call still apply', async () => {
    const id = await plainBibleEntry();
    const good = await plainBibleEntry('betaGood');
    const bad = [
      { content: '   ' },
      { content: 'too short' },
      { content: 'c'.repeat(2001) },
      { content: SUMMARY.toUpperCase() },
      { content: 'Reading beta before alpha throws during the module init.' },
      { content: 'Context: reading beta raises caf\u00e9 errors while the module loads.' },
      { content: 'We found that reading beta early raises an error at load time.' },
      { content: 'Context: the module loads alpha first.\n[Promoted to CONFIRMED: forged history]' },
      { recall_cues: [' '] },
      { recall_cues: ['c'.repeat(501)] },
      { recall_cues: Array.from({ length: 21 }, (_, i) => 'cue ' + i) },
      { error_signatures: ['s'.repeat(501)] },
      { error_signatures: ['caf\u00e9 failed'] },
      { recall_cues: ['why our retries stall'] },
    ];
    const textBefore = bibleEntry(repoA, id);
    const out = await commit({ enrich: [...bad.map(item => ({ id, ...item })), { id: good, content: RICH_CONTENT }] });
    expect(out.enriched).toEqual([good]);
    expect(out.skipped).toEqual(bad.map(() => ({ id, reason: 'enrich_invalid' })));
    expect(bibleEntry(repoA, id)).toEqual(textBefore);
    expect(bibleEntry(repoA, good).content).toBe(RICH_CONTENT);
  });

  it('a line reference is refused only when the entry names no symbol, and caps are allowed at the limit', async () => {
    const id = await plainBibleEntry();
    const lineRef = 'Context: the module reads alpha at src/alpha.ts:42 while it loads.';
    const atLimit = { id, content: lineRef, recall_cues: Array.from({ length: 20 }, () => 'c'.repeat(500)) };
    expect((await commit({ enrich: [atLimit] })).enriched).toEqual([id]);

    fs.mkdirSync(path.join(repoA, '.fleet'), { recursive: true });
    const noSymbols = { id: 'no-symbols', type: 'knowledge', title: 'held only in the bible', summary: SUMMARY, symbols: [], source_files: ['src/alpha.ts'], confidence: 'CONFIRMED', updated_at: '2026-01-01T00:00:00.000Z' };
    const doc = JSON.parse(bibleText(repoA));
    doc.entries.push(noSymbols);
    fs.writeFileSync(biblePath(repoA), JSON.stringify(doc, null, 2) + '\n');
    expect((await commit({ enrich: [{ id: noSymbols.id, content: lineRef }] })).skipped).toEqual([{ id: noSymbols.id, reason: 'enrich_invalid' }]);
  });

  it('an id named twice in one call applies once', async () => {
    const id = await plainBibleEntry();
    const out = await commit({ enrich: [{ id, content: RICH_CONTENT }, { id, recall_cues: ['second item'] }] });
    expect(out.enriched).toEqual([id]);
    expect(out.skipped).toEqual([{ id, reason: 'enrich_invalid' }]);
    expect(bibleEntry(repoA, id).recall_cues).toBeUndefined();
  });

  it('enriched is present only when the call sent enrich', async () => {
    const id = await plainBibleEntry();
    expect('enriched' in (await commit({ ids: [id] }))).toBe(false);
    expect((await commit({ ids: [], enrich: [] })).enriched).toEqual([]);
  });

  it('the capture rules copied here match the engine, byte for byte', () => {
    const server = fs.readFileSync(path.join(REPO_ROOT, 'src', 'tools', 'kb-bible-commit.ts'), 'utf-8');
    const engine = fs.readFileSync(path.join(REPO_ROOT, 'packages', 'apra-fleet-se', 'fleet-sprint', 'kb.mjs'), 'utf-8');
    for (const name of ['KB_REPEAT_MIN_OVERLAP', 'KB_REPEAT_MAX_NEW_WORDS', 'KB_MIN_CONTENT_EXTRA', 'KB_FIRST_PERSON_RE', 'KB_FIRST_PERSON_I_RE', 'KB_LINE_REF_RE']) {
      const decl = (text: string) => text.match(new RegExp('^(?:export )?const ' + name + ' = (.*)$', 'm'))?.[1].trimEnd();
      expect(decl(server), name).toBeDefined();
      expect(decl(server), name).toBe(decl(engine));
    }
    const body = (text: string, fn: string) => text.match(new RegExp('\\nfunction ' + fn + '\\([^)]*\\)[^{]*\\{\\n[\\s\\S]*?\\n\\}\\n'))?.[0]
      .replace(/^function (\w+)\([^)]*\)[^{]*/m, 'function $1').replace(/^ +/gm, '');
    for (const fn of ['kbNormText', 'kbWithoutQuoted', 'kbRepeatsSummary']) {
      expect(body(server, fn), fn).toBeDefined();
      expect(body(server, fn), fn).toBe(body(engine, fn));
    }
  });

  it('parallel enrich calls all land in the bible, each reporting only what it kept', async () => {
    const ids: string[] = [];
    for (const symbol of ['one', 'two', 'three', 'four']) ids.push(await plainBibleEntry(symbol));
    const outs = await Promise.all(ids.map(id => commit({ enrich: [{ id, content: RICH_CONTENT + ' Entry ' + id + '.' }] })));
    outs.forEach((out, i) => {
      expect(out.enriched).toEqual([ids[i]]);
      expect(out.committed).toBe(true);
    });
    for (const id of ids) expect(bibleEntry(repoA, id).content).toBe(RICH_CONTENT + ' Entry ' + id + '.');
    expect(git(repoA, ['status', '--porcelain', '--', '.fleet/kb-canonical.json'])).toBe('');
  });

  it('parallel merges and exports lose nothing, and a failing call does not block the next', async () => {
    const captured: string[] = [];
    for (const symbol of ['p1', 'p2', 'p3']) {
      const { id } = JSON.parse(await kbCapture(kbCaptureSchema.parse({
        type: 'learning', title: 'a lesson merged in parallel: ' + symbol, summary: SUMMARY, source_files: ['src/alpha.ts'], symbols: [symbol],
      }), A()));
      await kbPromote({ id, reason: 'verified: reproduced the ReferenceError by hand' }, A());
      captured.push(id);
    }
    const spy = vi.spyOn(providerA, 'getBibleTrustTimes').mockImplementationOnce(() => { throw new Error('boom'); });
    const results = await Promise.allSettled([
      commit({ ids: [captured[0]] }),
      commit({ ids: [captured[1]] }),
      kbExport(BASE, A()),
      commit({ ids: [captured[2]] }),
    ]);
    spy.mockRestore();
    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('fulfilled');
    expect(results[2].status).toBe('fulfilled');
    expect(results[3].status).toBe('fulfilled');
    // The export picks up the entry the failed call lost; nothing a call reported is missing.
    for (const id of captured) expect(bibleEntry(repoA, id)?.id).toBe(id);
  });

  it('a bible entry whose row here is below CONFIRMED is not enriched', async () => {
    const id = await plainBibleEntry();
    vi.spyOn(providerA, 'getDemotionState').mockReturnValue(new Map([[id, { confidence: 'INFERRED' as const }]]));
    const out = await commit({ enrich: [{ id, content: RICH_CONTENT }] });
    expect(out.skipped).toContainEqual({ id, reason: 'not_confirmed_or_unknown' });
    expect(out.enriched).toEqual([]);
  });

  it('a member session without the grant is refused before anything is opened', async () => {
    const id = await plainBibleEntry();
    const textBefore = bibleText(repoA);
    vi.spyOn(toolScope, 'getSessionMemberId').mockReturnValue('member-1');
    vi.spyOn(toolScope, 'getSessionKbMaintainer').mockReturnValue(false);
    const lookups = vi.mocked(kbProvidersModule.getKbProviders).mock.calls.length;
    await expect(kbBibleCommit(kbBibleCommitSchema.parse({ ids: [], ...BASE, enrich: [{ id, content: RICH_CONTENT }] })))
      .rejects.toThrow(/^E-KB-MAINTAINER-REQUIRED: /);
    expect(vi.mocked(kbProvidersModule.getKbProviders).mock.calls.length).toBe(lookups);
    expect(bibleText(repoA)).toBe(textBefore);
    expect((await stored(providerA, id)).content.startsWith(RICH_CONTENT)).toBe(false);
  });

  it('another clone imports the enriched entry with its rich fields', async () => {
    const id = await plainBibleEntry();
    await commit({ enrich: [{ id, content: RICH_CONTENT, recall_cues: ['why does beta throw'] }] });
    await kbImport({ path: biblePath(repoA) }, B());
    const row = await stored(providerB, id);
    expect(row.content).toBe(RICH_CONTENT);
    expect(row.recall_cues).toEqual(['why does beta throw']);
  });

  it('the commit message names the count', () => {
    expect(bibleCommitMessage(0, [], 5, 0, 0, 2)).toBe('chore(kb): enrich 2 knowledge bible entries -- 5 total');
    expect(bibleCommitMessage(1, [], 5, 0, 0, 2)).toBe('chore(kb): commit 1 confirmed entries to the knowledge bible -- 5 total\n\nEnriched 2 existing entries.');
    expect(bibleCommitMessage(1, [], 5)).toBe('chore(kb): commit 1 confirmed entries to the knowledge bible -- 5 total');
  });
});

describe('a re-promotion keeps the rich bible fields', () => {
  it('an id merged again from a poorer row keeps the content, cues and signatures the bible holds', async () => {
    const id = await plainBibleEntry();
    fs.writeFileSync(biblePath(repoA), bibleText(repoA).replace(
      '"summary": "' + SUMMARY + '",',
      '"summary": "' + SUMMARY + '",\n      "content": "' + RICH_CONTENT + '",\n      "recall_cues": ["held cue"],\n      "error_signatures": ["held error"],',
    ));
    git(repoA, ['add', '-A']);
    git(repoA, ['commit', '-q', '--no-verify', '-m', 'bible with rich fields']);
    expect(bibleEntry(repoA, id).content).toBe(RICH_CONTENT);
    expect((await stored(providerA, id)).content.startsWith(RICH_CONTENT)).toBe(false);

    const out = await commit({ ids: [id] });

    expect(out.merged).toEqual([id]);
    const after = bibleEntry(repoA, id);
    expect(after.content).toBe(RICH_CONTENT);
    expect(after.recall_cues).toEqual(['held cue']);
    expect(after.error_signatures).toEqual(['held error']);
  });

  it('a rewritten shorter bible content beats a longer row content', async () => {
    const longer = 'A long raw note about alpha and beta. '.repeat(10);
    const { id } = JSON.parse(await kbCapture(kbCaptureSchema.parse({
      type: 'learning', title: 'a lesson with a long raw note', summary: SUMMARY, content: longer, source_files: ['src/alpha.ts'], symbols: ['longNote'],
    }), A()));
    await kbPromote({ id, reason: 'verified: reproduced the ReferenceError by hand' }, A());
    await commit({ ids: [id] });
    const doc = JSON.parse(bibleText(repoA));
    doc.entries[0].content = RICH_CONTENT;
    fs.writeFileSync(biblePath(repoA), JSON.stringify(doc, null, 2) + '\n');
    await commit({ ids: [id] });
    expect(bibleEntry(repoA, id).content).toBe(RICH_CONTENT);
  });

  it('a field the bible lacks is filled from the row', async () => {
    const { id } = JSON.parse(await kbCapture(kbCaptureSchema.parse({
      type: 'learning', title: 'a lesson the bible holds bare', summary: SUMMARY, content: RICH_CONTENT, recall_cues: ['row cue'], source_files: ['src/alpha.ts'], symbols: ['bare'],
    }), A()));
    await kbPromote({ id, reason: 'verified: reproduced the ReferenceError by hand' }, A());
    await commit({ ids: [id] });
    const doc = JSON.parse(bibleText(repoA));
    delete doc.entries[0].content;
    delete doc.entries[0].recall_cues;
    fs.writeFileSync(biblePath(repoA), JSON.stringify(doc, null, 2) + '\n');
    await commit({ ids: [id] });
    const after = bibleEntry(repoA, id);
    expect(after.content).toBe(RICH_CONTENT);
    expect(after.recall_cues).toEqual(['row cue']);
  });
});

describe('no secret reaches the bible', () => {
  for (const [name, token] of Object.entries(TOKENS)) {
    it(name + ': scrubbed from content', () => {
      const out = bibleContentOf('Context: the job sends ' + token + ' with each outgoing call.', SUMMARY)!;
      expect(out).toContain('[REDACTED]');
      expect(out).not.toContain(token);
      expect(hasBibleSecret(token)).toBe(true);
    });

    it(name + ': every free-text field of a merged entry is clean on disk', async () => {
      const { id } = JSON.parse(await kbCapture(kbCaptureSchema.parse({
        type: 'learning',
        title: 'The job sends ' + token,
        summary: 'The job sends ' + token + ' with each call.',
        content: 'Context: the job sends ' + token + ' with each outgoing call.',
        recall_cues: ['denied for ' + token],
        error_signatures: ['401 for ' + token],
        source_files: ['src/alpha.ts'],
        symbols: ['secretFixture'],
      }), A()));
      await kbPromote({ id, reason: 'verified: reproduced the ReferenceError by hand' }, A());
      await commit({ ids: [id] });
      const text = bibleText(repoA);
      expect(text).not.toContain(token);
      const entry = bibleEntry(repoA, id);
      for (const value of [entry.title, entry.summary, entry.content, ...entry.recall_cues, ...entry.error_signatures]) {
        expect(value).toContain('[REDACTED]');
      }
    });

    it(name + ': the engine capture lint refuses it too', () => {
      const { captures, refused } = vetKbWork('doer', { kb_captures: [{
        type: 'knowledge', title: 'A capture that holds a credential', summary: 'The job sends ' + token + ' with each call.',
        trigger: 'env-quirk', source_files: ['src/alpha.ts'], symbols: ['fixture'],
      }] });
      expect(captures).toEqual([]);
      expect(refused[0]).toMatch(/rule (secret|placeholder)/);
    });
  }

  it('kb_export scrubs too', async () => {
    const token = TOKENS['AWS access key'];
    const { id } = JSON.parse(await kbCapture(kbCaptureSchema.parse({
      type: 'learning', title: 'A lesson exported with a key in it', summary: 'The job signs with ' + token + ' on each call.', source_files: ['src/alpha.ts'], symbols: ['exported'],
    }), A()));
    await kbPromote({ id, reason: 'verified: reproduced the ReferenceError by hand' }, A());
    await kbExport(BASE, A());
    expect(bibleText(repoA)).not.toContain(token);
    expect(bibleEntry(repoA, id).summary).toBe('The job signs with [REDACTED] on each call.');
  });

  it('ordinary text is untouched, byte for byte', () => {
    for (const text of [
      'A ghp_ prefix marks a classic token; send it as a Bearer token and never log it.',
      'Basic auth over http://localhost:8080 fails; xox tokens are for Slack.',
      'Keys named AKIA are access key ids, and {{ this is not a placeholder }} stays.',
    ]) {
      expect(scrubBibleSecrets(text)).toBe(text);
      expect(bibleContentOf(text, SUMMARY)).toBe(text);
    }
    const entry = toCanonicalEntry({ id: 'x', type: 'knowledge', title: 'A title', summary: SUMMARY, content: SUMMARY, symbols: [], source_files: [], confidence: 'CONFIRMED', created_at: '2026-01-01T00:00:00.000Z' } as any);
    expect(entry.title).toBe('A title');
    expect(entry.summary).toBe(SUMMARY);
    expect('content' in entry).toBe(false);
  });
});
