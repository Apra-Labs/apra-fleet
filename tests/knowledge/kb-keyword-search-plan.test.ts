import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import {
  KbKeywordIndex,
  KW_BM25,
  TRI_BM25,
  keywordMatch,
  trigramMatch,
  type KeywordSearch,
} from '../../src/services/knowledge/kb-index.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// KbKeywordIndex.search (ready index) must not join every FTS hit back to
// `entries` and sort full rows: on 5k entries with a common word in the query
// that join took about 1 s. It now ranks rowids from the FTS tables alone and
// fetches entry rows by rowid for a bounded prefix.
//
// 1. Same ids, same order as the previous single statement (kept below as
//    LEGACY_SQL, the reference) across free-text / term / column / trigram
//    searches, selective and non-selective conditions, small and large limits,
//    and groups of equal scores ordered by created_at.
// 2. EXPLAIN QUERY PLAN of every statement search() actually prepares (captured
//    from the real code path through a recording db wrapper) shows no full scan
//    of entries. Falsifiability: restoring the single-statement join makes this
//    fail -- its plan has 'SCAN e' (the join drives from entries).
//
// Isolation: every file lives under one mkdtemp dir removed in afterAll.

const LEGACY_SQL = (kw: string, tri: string, cond: string): string => `
  WITH ${kw
    ? `kw AS MATERIALIZED (SELECT rowid AS rid, ${KW_BM25} AS s FROM entries_kw WHERE entries_kw MATCH ?)`
    : 'kw AS (SELECT NULL AS rid, NULL AS s WHERE 0)'},
  ${tri
    ? `tri AS MATERIALIZED (SELECT rowid AS rid, ${TRI_BM25} AS s FROM entries_tri WHERE entries_tri MATCH ?)`
    : 'tri AS (SELECT NULL AS rid, NULL AS s WHERE 0)'}
  SELECT e.* FROM entries e
  LEFT JOIN kw ON kw.rid = e.rowid
  LEFT JOIN tri ON tri.rid = e.rowid
  WHERE e.rowid IN (SELECT rid FROM kw UNION SELECT rid FROM tri)
  ${cond}
  ORDER BY (kw.rid IS NULL), kw.s, tri.s, e.created_at DESC
  LIMIT ?
`;

const VOCAB = [
  'cache', 'member', 'session', 'token', 'retry', 'timeout', 'index', 'build', 'config', 'error',
  'rebuild', 'drain', 'sqlite', 'vector', 'anchor', 'prime', 'bible', 'worker', 'queue', 'model',
];

let tmp: string;
let provider: SqliteProvider;
let db: DatabaseSync;

let seed = 12345;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const words = (n: number): string => Array.from({ length: n }, () => pick(VOCAB)).join(' ');

function input(i: number): KBEntryInput {
  return {
    type: pick(['knowledge', 'learning', 'runbook'] as const),
    title: `${words(3)} getMemberCache${i % 7}`,
    summary: words(8),
    content: words(40),
    source_files: [`src/${pick(VOCAB)}.ts`],
    symbols: [`${pick(VOCAB)}Handler`],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'plan-test',
    source: 'doer',
    confidence: pick(['CONFIRMED', 'INFERRED', 'UNVERIFIED'] as const),
    error_signatures: i % 3 === 0 ? [`E${100 + (i % 5)} ${words(3)}`] : [],
  };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-keyword-search-plan-'));
  const file = path.join(tmp, 'kb.sqlite');
  provider = new SqliteProvider(file);
  await provider.init();
  for (let i = 0; i < 240; i++) await provider.capture(input(i));
  // Exact duplicates (equal bm25 scores): created_at alone orders them.
  for (let i = 0; i < 12; i++) {
    await provider.capture({ ...input(1000), title: 'duplicate twin entry', summary: 'twin twin', content: 'twin body' });
  }
  expect(await provider.waitForKeywordIndex(60_000)).toBe(true);
  db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  // Distinct created_at for every row, so the reference order is fully defined.
  db.exec(`UPDATE entries SET created_at = printf('2026-01-01T00:00:%02d.%03dZ', (rowid * 7919) % 60, (rowid * 104729) % 1000)`);
}, 120_000);

afterAll(() => {
  db?.close();
  provider?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function legacy(s: KeywordSearch, conditions: string[], params: SQLInputValue[], limit: number,
  opts: { trigram?: boolean; column?: string }): string[] {
  const bare = keywordMatch(s);
  const kw = bare && opts.column ? `${opts.column} : (${bare})` : bare;
  const tri = opts.trigram && !opts.column ? trigramMatch(s) : '';
  if (!kw && !tri) return [];
  const cond = conditions.length ? 'AND ' + conditions.join(' AND ') : '';
  const bind: SQLInputValue[] = [];
  if (kw) bind.push(kw);
  if (tri) bind.push(tri);
  return (db.prepare(LEGACY_SQL(kw, tri, cond)).all(...bind, ...params, limit) as { id: string }[]).map(r => r.id);
}

const CONDITION_SETS: Array<{ conditions: string[]; params: SQLInputValue[] }> = [
  { conditions: [], params: [] },
  { conditions: ['e.superseded_at IS NULL'], params: [] },
  // Selective: forces the bounded prefix to grow several times.
  { conditions: ["e.confidence IN (?)", "e.type = ?"], params: ['CONFIRMED', 'runbook'] },
  {
    conditions: [
      'e.stale = 0', 'e.superseded_at IS NULL', 'e.confidence IN (?, ?, ?)',
      "NOT (e.type = 'user-directive' AND e.confidence != 'CONFIRMED')",
    ],
    params: ['CONFIRMED', 'INFERRED', 'UNVERIFIED'],
  },
  { conditions: ['e.confidence = ?'], params: ['nonexistent-tier'] },
];

const SEARCHES: Array<{ s: KeywordSearch; opts: { trigram?: boolean; column?: 'error_signatures' } }> = [
  { s: { query: 'cache' }, opts: { trigram: true } },
  { s: { query: 'member session token retry' }, opts: { trigram: true } },
  { s: { query: 'getMemberCache3' }, opts: { trigram: true } },
  { s: { query: 'MemberCach' }, opts: { trigram: true } },
  { s: { query: 'twin' }, opts: { trigram: true } },
  { s: { query: 'twin duplicate' }, opts: {} },
  { s: { terms: ['vector', 'anchorHandler', 'src/bible.ts'] }, opts: { trigram: true } },
  { s: { terms: ['drain', 'queue'] }, opts: {} },
  { s: { query: 'E102 cache' }, opts: { column: 'error_signatures' } },
  { s: { query: 'zzzz nothing matches' }, opts: { trigram: true } },
];

describe('KbKeywordIndex.search: bounded rowid-first keyword read', () => {
  it('returns the same ids in the same order as the previous single-statement join', () => {
    const idx = new KbKeywordIndex(() => db);
    let compared = 0;
    let nonEmpty = 0;
    for (const { s, opts } of SEARCHES) {
      for (const { conditions, params } of CONDITION_SETS) {
        for (const limit of [1, 3, 8, 20, 50, 1000]) {
          const want = legacy(s, conditions, params, limit, opts);
          const got = (idx.search(s, conditions, params, limit, opts) as { id: string }[]).map(r => r.id);
          expect(got, JSON.stringify({ s, opts, conditions, limit })).toEqual(want);
          compared++;
          if (want.length > 0) nonEmpty++;
        }
      }
    }
    expect(compared).toBe(SEARCHES.length * CONDITION_SETS.length * 6);
    // The comparison is not vacuous: most cases return rows.
    expect(nonEmpty).toBeGreaterThan(compared / 2);
  });

  it('reads entries only by rowid for a bounded prefix of the FTS hits, never a full scan (EXPLAIN QUERY PLAN)', () => {
    const prepared: Array<{ sql: string; calls: unknown[][] }> = [];
    const recording = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            const rec = { sql, calls: [] as unknown[][] };
            prepared.push(rec);
            return new Proxy(stmt, {
              get(st, p2) {
                const v = Reflect.get(st, p2);
                if (p2 === 'all' || p2 === 'get' || p2 === 'iterate') {
                  return (...args: unknown[]) => { rec.calls.push(args); return (v as (...a: unknown[]) => unknown).apply(st, args); };
                }
                return typeof v === 'function' ? v.bind(st) : v;
              },
            });
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as DatabaseSync;
    const idx = new KbKeywordIndex(() => recording);
    const { conditions, params } = CONDITION_SETS[3];
    // 'cache' matches most of the KB; a limit of 5 must not touch them all.
    const totalHits = legacy({ query: 'cache member' }, conditions, params, 100_000, { trigram: true }).length;
    expect(totalHits).toBeGreaterThan(150);
    const limit = 5;
    const rows = idx.search({ query: 'cache member' }, conditions, params, limit, { trigram: true });
    expect(rows.length).toBe(limit);

    const touching = prepared.filter(r => /\bentries\s+e\b/.test(r.sql));
    expect(touching.length).toBeGreaterThan(0);
    for (const { sql, calls } of touching) {
      const placeholders = (sql.match(/\?/g) ?? []).length;
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(placeholders).fill(null)) as { detail: string }[])
        .map(r => r.detail);
      const scans = plan.filter(d => /^SCAN (e|entries)\b/.test(d));
      expect(scans, `full scan of entries in plan:\n${plan.join('\n')}\nfor:\n${sql}`).toEqual([]);
      expect(plan.some(d => /^SEARCH e USING INTEGER PRIMARY KEY/.test(d)), plan.join('\n')).toBe(true);
      // Every execution is handed an explicit, bounded rowid list (first bind
      // value, a JSON array): the statement cannot reach every FTS hit.
      expect(calls.length).toBeGreaterThan(0);
      for (const args of calls) {
        expect(typeof args[0], `entries read without a bounded rowid list:\n${sql}`).toBe('string');
        const ids = JSON.parse(args[0] as string) as unknown[];
        expect(ids.length).toBeLessThan(totalHits / 2);
      }
    }
  });
});
