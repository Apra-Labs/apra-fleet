import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { getKbProviders, resetKbProviders } from '../../src/services/knowledge/kb-providers.js';
import { requireSqliteProject } from '../../src/services/knowledge/require-sqlite-project.js';
import { importBibleEntries } from '../../src/services/knowledge/bible-import.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { memberBiblePath, resetMemberBibleViews } from '../../src/services/knowledge/member-bible-view.js';
import { startKbServer } from '../../src/commands/kb-server.js';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import { kbList } from '../../src/tools/kb-list.js';
import { kbSessionPrime } from '../../src/tools/kb-session-prime.js';
import { kbContext } from '../../src/tools/kb-context.js';
import { FLEET_DIR } from '../../src/paths.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// MEMBER mixed-tier reads ([CONFIRMED, INFERRED]) through the split read
// (kb-self.ts getMemberSplitRead), once over SQLite and once over http against
// fleet's own KB server (startKbServer serving a scratch SQLite file). The two
// stores hold the same knowledge, so each tool must return the same result:
//
//   SQLite: CONFIRMED from the member's checkout bible view, every listed tier
//           from the per-repo DB, own captures only.
//   http:   the KB server holds the bible's CONFIRMED entries and the same
//           captures; CONFIRMED comes from the server (kb_list: the checkout
//           bible, as its CONFIRMED-only read), every listed tier from the
//           server, own captures only.
//
// Both stores also hold another member's captures, which must never appear
// (the cross-member leak a mixed-tier read once had). The other member's
// context-cache entry for src/cog.ts is the NEWEST one for that file, so the
// own half must pick the member's own entry, not hide it behind another's.
//
// Real member session, real git checkout, real kb_setup, real HttpKbProvider,
// real kb-server, real SQLite stores. No mocks. Results are compared on what a
// caller reads (ids, tiers, titles, summaries, content, statuses), not on
// per-store bookkeeping (created_at, use_count, last_accessed).
//
// Isolation: tests/setup.ts points APRA_FLEET_DATA_DIR at a per-run temp dir
// (KB config, server token and every kb.sqlite land there); the registry is
// backed up and restored; the checkout and the server database live under one
// mkdtemp scratch root removed in afterAll. The server token is generated at
// run time, never stored in source.

const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');
const TOKEN_PATH = path.join(FLEET_DIR, 'knowledge', 'kb-server.token');
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const MIXED = ['CONFIRMED', 'INFERRED'] as Array<'CONFIRMED' | 'INFERRED'>;
const OTHER_TAG = `member:other-${RUN}`;
const FILES = ['src/gearwheel.ts', 'src/cog.ts'];

function bibleEntry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, type: 'knowledge',
    title: `Gearwheel bible fact ${id}`,
    summary: `Gearwheel bible fact recorded in the checkout bible as ${id}.`,
    symbols: ['Gearwheel'], source_files: ['src/gearwheel.ts'],
    confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

// Three Gearwheel hits keep the CONFIRMED half of kb_session_prime warm in
// both stores. A cold half (fewer than COLD_KB_MAX hits) is seeded from the
// checkout bible, and that threshold legitimately differs between the stores:
// the server's CONFIRMED set also holds the member's own promoted capture,
// which over SQLite sits in the per-repo DB, outside the bible view.
const BIBLE = [
  bibleEntry('bible-a'),
  bibleEntry('bible-b', { title: 'Gearwheel bible ratio note', summary: 'Gearwheel ratio note held in the checkout bible.' }),
  bibleEntry('bible-c', { title: 'Gearwheel bible tooth note', summary: 'Gearwheel tooth count note held in the checkout bible.' }),
  // Not a 'gearwheel' text match, so kb_query's L1 stays at five rows and its
  // top-5 L2 expansion covers all of them: which row is fifth depends on the
  // half the own promoted capture sits in, which differs between the stores.
  bibleEntry('bible-ctx', { type: 'context-cache', title: 'Wheel source context', summary: 'Context summary for the wheel source file.', symbols: [] }),
];

interface Capture { id: string; input: KBEntryInput }

function capture(id: string, ownerTag: string, over: Partial<KBEntryInput>): Capture {
  return {
    id,
    input: {
      type: 'knowledge',
      title: `Gearwheel capture ${id}`,
      summary: `Gearwheel capture ${id} recorded by a member session.`,
      content: `Gearwheel capture content for ${id}.`,
      source_files: ['src/cog.ts'], symbols: ['Gearwheel'], tags: [ownerTag],
      content_hash: '', content_hash_type: 'sha256', stale: false, flagged_for_review: false,
      author: 'test', source: 'doer', confidence: 'INFERRED', scope: 'project',
      ...over,
    } as KBEntryInput,
  };
}

let scratch: string;
let repo: string;
let memberId: string;
let ownTag: string;
let token: string;
let server: http.Server;
let port: number;
let captures: Capture[];
let otherIds: string[];

const asMember = <T>(fn: () => Promise<T>): Promise<T> => runWithSessionMember(memberId, fn);

async function seedCaptures(store: SqliteProvider): Promise<void> {
  // In order: the other member's cache entry for src/cog.ts is created last.
  for (const c of captures) {
    await store.capture(c.input, { importMode: true, preferredId: c.id, verbatim: true });
  }
}

function useSqlite(): void {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
  resetKbProviders();
  resetMemberBibleViews();
}

async function useHttp(): Promise<void> {
  resetMemberBibleViews();
  const result = JSON.parse(await kbSetup({ provider: 'http', remote: `http://127.0.0.1:${port}`, token }, { folder: repo }));
  expect(result.success).toBe(true);
  expect((await getKbProviders(repo)).project).toBeInstanceOf(HttpKbProvider);
}

/** Every id anywhere in a tool result (any field named id or entry_id). */
function allIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allIds);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) =>
    ((key === 'id' || key === 'entry_id') && typeof v === 'string' ? [v] : allIds(v)));
}

type Row = Record<string, unknown>;
const byId = (a: Row, b: Row) => String(a.id ?? a.file).localeCompare(String(b.id ?? b.file));
const pick = (row: Row, keys: string[]): Row => Object.fromEntries(keys.filter(k => k in row).map(k => [k, row[k]]));
const ENTRY_KEYS = ['id', 'type', 'confidence', 'title', 'summary', 'content', 'tags', 'source_files', 'symbols', 'via'];

// What a caller reads from each tool, independent of per-store bookkeeping.
// Rank order across the two halves is fixed by the split (CONFIRMED half
// first), but bm25 within a half depends on each store's whole corpus, so
// rows are compared as sets (sorted by id).
const NORMALISE: Record<string, (out: Row) => unknown> = {
  kb_query: out => ({
    keys: Object.keys(out).sort(),
    l1: (out.l1_results as Row[]).map(e => pick(e, ENTRY_KEYS)).sort(byId),
    l2: (out.l2_expanded as Row[]).map(e => pick(e, ENTRY_KEYS)).sort(byId),
  }),
  kb_list: out => out,
  kb_session_prime: out => ({
    keys: Object.keys(out).sort(),
    session_warm: out.session_warm,
    stale_files: [...(out.stale_files as string[])].sort(),
    top_entries: (out.top_entries as Row[]).map(e => pick(e, ['id', 'type', 'confidence', 'title', 'summary', 'via'])).sort(byId),
    fresh_summaries: (out.fresh_summaries as Row[]).map(r => pick(r, ['file', 'entry_id', 'status'])).sort(byId),
  }),
  kb_context: out => out,
};

const READS: Array<{ tool: string; run: () => Promise<string> }> = [
  { tool: 'kb_query', run: () => kbQuery({ query: 'gearwheel', confidence: MIXED }) },
  { tool: 'kb_list', run: () => kbList({ confidence: MIXED }) },
  { tool: 'kb_session_prime', run: () => kbSessionPrime({ hint_symbols: ['Gearwheel'], confidence: MIXED }) },
  { tool: 'kb_context', run: () => kbContext({ files: FILES, confidence: MIXED }) },
  { tool: 'kb_context', run: () => kbContext({ files: FILES }) },
];

beforeAll(async () => {
  backupAndResetRegistry();
  useSqlite();

  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-member-split-parity-'));
  repo = path.join(scratch, 'checkout');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  for (const file of FILES) fs.writeFileSync(path.join(repo, file), `export const value = '${file}';\n`);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', `https://example.test/kb-member-split-parity-${RUN}.git`], { cwd: repo });
  fs.writeFileSync(memberBiblePath(repo), JSON.stringify({ version: 2, entries: BIBLE }), 'utf-8');

  const agent = makeTestLocalAgent({ friendlyName: `kb-member-split-parity-${RUN}`, workFolder: repo });
  addAgent(agent);
  memberId = agent.id;
  ownTag = `member:${memberId}`;

  captures = [
    capture('own-inferred', ownTag, {}),
    capture('own-confirmed', ownTag, { title: 'Gearwheel own promoted capture', confidence: 'CONFIRMED' }),
    capture('own-ctx', ownTag, { type: 'context-cache', title: 'Cog context own', summary: 'Own context summary for src/cog.ts.', symbols: [] }),
    capture('other-inferred', OTHER_TAG, { title: 'Gearwheel other member capture' }),
    capture('other-ctx', OTHER_TAG, { type: 'context-cache', title: 'Cog context other', summary: 'Other member context summary for src/cog.ts.', symbols: [] }),
  ];
  otherIds = ['other-inferred', 'other-ctx'];

  // SQLite: the per-repo DB holds the captures; the bible file is the bible.
  await seedCaptures(requireSqliteProject((await getKbProviders(repo)).project, 'parity seed'));

  // http: the server's database holds the bible's entries and the same captures.
  const serverDb = path.join(scratch, 'server-kb.sqlite');
  const serverStore = new SqliteProvider(serverDb, repo);
  await serverStore.init();
  await importBibleEntries(serverStore, BIBLE, { verbatim: true });
  await seedCaptures(serverStore);
  serverStore.close();

  token = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, encryptPassword(token), { mode: 0o600 });
  // The server serves the project of its working folder, so it is started
  // from the member checkout (same origin remote, same project slug).
  const cwd = process.cwd();
  process.chdir(repo);
  try {
    server = await startKbServer(0, false, serverDb);
  } finally {
    process.chdir(cwd);
  }
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('kb-member-split-parity: kb-server did not bind a TCP port');
  port = address.port;
});

afterEach(() => {
  useSqlite();
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  useSqlite();
  restoreRegistry();
  fs.rmSync(TOKEN_PATH, { force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('MEMBER mixed-tier split read: SQLite and http (real kb-server) return the same result', () => {
  for (const [index, read] of READS.entries()) {
    it(`${read.tool} #${index}: identical shape and content over SQLite and over http`, async () => {
      useSqlite();
      const overSqlite = JSON.parse(await asMember(read.run)) as Row;
      await useHttp();
      const overHttp = JSON.parse(await asMember(read.run)) as Row;
      expect(NORMALISE[read.tool](overHttp)).toEqual(NORMALISE[read.tool](overSqlite));
      // Not a vacuous match: the result carries the CONFIRMED set and own captures.
      expect(allIds(overHttp).length).toBeGreaterThan(0);
    });
  }

  it('over http no result carries another member\'s captures, and every read returns the bible and own entries', async () => {
    await useHttp();
    const seen = new Set<string>();
    for (const read of READS) {
      const ids = allIds(JSON.parse(await asMember(read.run)));
      for (const id of otherIds) expect(ids, `${read.tool} leaked ${id}`).not.toContain(id);
      ids.forEach(id => seen.add(id));
    }
    for (const id of ['bible-a', 'bible-ctx', 'own-inferred', 'own-confirmed', 'own-ctx']) expect([...seen]).toContain(id);
  });
});
