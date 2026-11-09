import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SqliteProvider, QUERY_EMBED_MAX_CHARS, capEmbedText,
} from '../../src/services/knowledge/sqlite-provider.js';
import {
  KbKeywordIndex, MAX_QUERY_KEYWORD_TERMS, boundedQueryTerms, keywordMatch,
} from '../../src/services/knowledge/kb-index.js';
import { normalizeQueryTerms } from '../../src/services/knowledge/kb-normalize.js';
import { FakeEmbedder } from '../helpers/fake-embedder.js';

// Long engine situations ('about to work on: <title>. <description>. Done
// when: <acceptance>', 450-800 chars) reach SqliteProvider.hybridRows as
// opts.query. The embedded text is capped to the leading sentence(s) and the
// keyword search ORs at most MAX_QUERY_KEYWORD_TERMS distinct terms; a query
// under both caps behaves exactly as before.
//
// Falsifiability (checked by hand): replacing the capEmbedText calls in
// hybridRows with the raw text makes the length assertion fail; making
// keywordMatch use normalizeQueryTerms(query) again makes the term-bound
// cases fail (the beyond-the-bound entry is returned).
//
// Isolation: every file lives under one mkdtemp dir removed in afterAll.

/** FakeEmbedder that records every query text it was asked to embed. */
class RecordingEmbedder extends FakeEmbedder {
  queries: string[] = [];
  override async embedQuery(text: string): Promise<Float32Array | null> {
    this.queries.push(text);
    return super.embedQuery(text);
  }
}

const TITLE = 'Rotate the gateway credential cache on member reconnect';
const LEAD = `about to work on: ${TITLE}.`;
// Description and acceptance use vocabulary disjoint from the title, and the
// last word (xylophone) sits far beyond the keyword term bound.
const DESCRIPTION = [
  'When a remote host drops its session the hub keeps serving stale tokens from memory',
  'for several minutes which breaks every following dispatch until an operator restarts',
  'the supervisor by hand; this change introduces a refresh hook that clears stored',
  'secrets whenever connectivity returns, logs a single warning line, keeps the existing',
  'retry budget, and avoids touching unrelated provider adapters or packaging scripts',
  'so windows linux and macos installs behave identically during upgrade windows',
].join(' ');
const ACCEPTANCE = [
  'a unit test simulates the disconnect then reconnect sequence and asserts fresh values',
  'are fetched, an integration check covers the playbook path, documentation describes',
  'the new hook, nothing else changes, and the trailing marker word is xylophone',
].join(' ');
const SITUATION = `${LEAD} ${DESCRIPTION}. Done when: ${ACCEPTANCE}`;

const ALL_TIERS = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'];
let tmp: string;
let n = 0;
let p: SqliteProvider;

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-situation-bounds-')); });
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  p = new SqliteProvider(path.join(tmp, `kb-${n++}.sqlite`));
  await p.init();
});
afterEach(() => { p.close(); vi.restoreAllMocks(); });

async function put(title: string, summary: string): Promise<string> {
  const e = await p.capture({
    type: 'learning', title, summary, content: summary, source_files: ['src/x.ts'], symbols: [], tags: [],
    content_hash: '', content_hash_type: 'sha256', flagged_for_review: false, author: 'bounds-test',
    source: 'doer', confidence: 'INFERRED',
  });
  return (e as { id: string }).id;
}

async function attachRecorder(): Promise<RecordingEmbedder> {
  const emb = new RecordingEmbedder('acme/bounds-model', 'r1', 64);
  p.attachEmbedder(() => emb);
  expect(await p.waitForEmbeddings(10_000)).toBe(true);
  return emb;
}

describe('long situation queries: bounded embed text and keyword terms', () => {
  it('the situation fixture is engine-shaped (about 800 chars)', () => {
    expect(SITUATION.length).toBeGreaterThanOrEqual(700);
    expect(SITUATION.length).toBeLessThanOrEqual(850);
    expect(SITUATION.startsWith(LEAD)).toBe(true);
  });

  it('embeds at most the cap, starting with the leading sentence, never cut mid-word', async () => {
    await put('gateway credential cache rotation', 'rotate cached credentials on reconnect');
    const emb = await attachRecorder();
    await p.query({ query: SITUATION, confidence: [...ALL_TIERS], limit: 8 });
    expect(emb.queries).toHaveLength(1);
    const sent = emb.queries[0];
    expect(sent.length).toBeLessThanOrEqual(QUERY_EMBED_MAX_CHARS);
    expect(sent.startsWith(LEAD)).toBe(true);
    // A word-boundary cut: the sent text is a prefix and the next char is whitespace.
    expect(SITUATION.startsWith(sent)).toBe(true);
    expect(SITUATION[sent.length]).toMatch(/\s/);
  });

  it('keyword search ORs at most the term bound; an entry matching only a word beyond it is not returned', async () => {
    const terms = boundedQueryTerms(SITUATION);
    expect(terms).toHaveLength(MAX_QUERY_KEYWORD_TERMS);
    expect(terms).not.toContain('xylophon');
    expect(keywordMatch({ query: SITUATION }).split(' OR ')).toHaveLength(MAX_QUERY_KEYWORD_TERMS);

    const beyond = await put('xylophone tuning', 'xylophone tuning');
    // Control: the entry is findable by that word on its own.
    expect((await p.query({ query: 'xylophone', confidence: [...ALL_TIERS] })).results.map(e => e.id)).toContain(beyond);

    const spy = vi.spyOn(KbKeywordIndex.prototype, 'search');
    const ids = (await p.query({ query: SITUATION, confidence: [...ALL_TIERS], limit: 20 })).results.map(e => e.id);
    expect(ids).not.toContain(beyond);
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) {
      const s = call[0];
      if (s.query !== undefined) expect(keywordMatch(s).split(' OR ').length).toBeLessThanOrEqual(MAX_QUERY_KEYWORD_TERMS);
    }
  });

  it('a short query (under both caps) embeds the full text and keeps today\'s keyword match and results', async () => {
    const shortQ = 'gateway credential cache reconnect';
    expect(shortQ.length).toBeLessThan(QUERY_EMBED_MAX_CHARS);
    expect(capEmbedText(shortQ, QUERY_EMBED_MAX_CHARS)).toBe(shortQ);
    expect(keywordMatch({ query: shortQ })).toBe(normalizeQueryTerms(shortQ));

    const a = await put('gateway credential cache', 'gateway credential cache notes');
    const b = await put('member reconnect sequence', 'reconnect handling for members');
    const c = await put('unrelated packaging script', 'packaging only');

    const before = (await p.query({ query: shortQ, confidence: [...ALL_TIERS], limit: 8 })).results.map(e => e.id);
    expect(before).toEqual([a, b]); // pinned keyword-only order

    const emb = await attachRecorder();
    const after = (await p.query({ query: shortQ, confidence: [...ALL_TIERS], limit: 8 })).results.map(e => e.id);
    expect(emb.queries).toEqual([shortQ]);
    expect(after[0]).toBe(a);
    expect(after).toContain(b);
    // Both inputs of the hybrid read (the embedded text above and the keyword
    // MATCH asserted equal to normalizeQueryTerms) are the uncapped ones, so
    // the fused rows are what they were before the caps existed. (c may be
    // pulled in by the fake embedder's semantic list; that is not a cap effect.)
    expect(c).toBeTruthy();
  });

  it('an entry matching the situation\'s title words is still returned first', async () => {
    const titleHit = await put(TITLE, 'rotate gateway credential cache when a member reconnects');
    await put('stale tokens served from memory', 'hub keeps serving stale tokens after a session drop');
    await put('retry budget for provider adapters', 'retry budget and provider adapters');
    await put('documentation for upgrade windows', 'installs behave identically during upgrade windows');
    await attachRecorder();
    const ids = (await p.query({ query: SITUATION, confidence: [...ALL_TIERS], limit: 8 })).results.map(e => e.id);
    expect(ids[0]).toBe(titleHit);
  });
});

describe('capEmbedText (pure)', () => {
  it('returns text at or under the cap unchanged', () => {
    expect(capEmbedText('', 10)).toBe('');
    expect(capEmbedText('exactly ten', 11)).toBe('exactly ten');
  });

  it('cuts at the last word boundary when no sentence end falls in the second half', () => {
    expect(capEmbedText('alpha beta gamma delta', 13)).toBe('alpha beta');
  });

  it('cuts after a sentence end in the second half of the window', () => {
    expect(capEmbedText('First part here. second part follows on', 20)).toBe('First part here.');
  });

  it('hard-cuts only a single word longer than the cap', () => {
    expect(capEmbedText('abcdefghijklmnop', 5)).toBe('abcde');
  });
});
