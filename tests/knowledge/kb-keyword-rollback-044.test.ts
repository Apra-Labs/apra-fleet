import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbQuery } from '../../src/tools/kb-query.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { buildV044Kb, V044_TAG, type V044Kb, type V044Result } from '../helpers/v044-kb-build.js';

// KB keyword index rollback with a REAL 0.4.4 build (not a simulated schema):
// the 0.4.4 SqliteProvider source from git tag v0.4.4, bundled by
// tests/helpers/v044-kb-build.ts and run in a child process, opens the same
// kb.sqlite as this build, alternately:
//   (1) this build creates the DB (incl. a non-ASCII title) and answers kb_query;
//   (2) 0.4.4 opens it: kb_query (SqliteProvider.query, the core of its
//       kb_query tool, which also bumps use_count on every hit) and kb_list
//       (SqliteProvider.list), then captures one entry;
//   (3) this build opens it again: kb_query and kb_list;
//   (4) 2-3 once more.
// Every step must return the expected entry ids and never "database disk image
// is malformed".
//
// When the v0.4.4 tag is not available (e.g. a shallow clone without tags)
// the test SKIPS LOUDLY with the reason on stderr. Set APRA_REQUIRE_V044=1 to
// turn that skip into a failure.
//
// Falsifiability: restoring the DROP of entries_fts/entries_ai/ad/au in
// KbKeywordIndex.finish and removing the ensureLegacyFts() call from
// KbKeywordIndex.init (kb-index.ts) makes step (2) fail: 0.4.4 recreates
// entries_fts empty, its kb_query returns 0 rows and its use_count UPDATE
// throws malformed.
//
// Isolation: the 0.4.4 sources, the bundle and every DB live under one mkdtemp
// dir removed in afterAll.

const ALL_TIERS = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] as const;
const GRUESSE = 'Gr\u00fc\u00dfe';

let tmp: string;
let repo: string;
let v044: V044Kb | null = null;
let skipReason = '';

const built = await (async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-keyword-rollback-044-'));
  const b = await buildV044Kb(tmp);
  if (b.ok) {
    v044 = b;
  } else {
    skipReason = b.reason;
    if (process.env.APRA_REQUIRE_V044 !== '1') {
      process.stderr.write(`\n[SKIP] kb-keyword-rollback-044: real ${V044_TAG} build unavailable -- ${b.reason}\n\n`);
    }
  }
  return b.ok;
})();

beforeAll(() => {
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function input(title: string, summary: string): KBEntryInput {
  return {
    type: 'knowledge',
    title,
    summary,
    content: `${summary} Body text for the rollback test.`,
    source_files: ['src/a.ts'],
    symbols: [],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'rollback-044-test',
    source: 'doer',
    confidence: 'INFERRED',
  };
}

async function openNew(file: string): Promise<SqliteProvider> {
  const p = new SqliteProvider(file, repo);
  await p.init();
  expect(await p.waitForKeywordIndex(30_000)).toBe(true);
  return p;
}

/** kb_query through the real tool handler of this build. */
async function newKbQuery(p: SqliteProvider, query: string): Promise<string[]> {
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: p, global: p, projectSlug: 'rollback-044',
  } as any);
  const out = JSON.parse(await kbQuery({ query, limit: 100, confidence: [...ALL_TIERS] }));
  vi.restoreAllMocks();
  return out.l1_results.map((e: { id: string }) => e.id).sort();
}

function noErrors(results: V044Result[]): void {
  for (const r of results) expect(r, JSON.stringify(r)).not.toHaveProperty('error');
}

describe(`KB keyword index: real ${V044_TAG} rollback and re-upgrade`, () => {
  it('fails instead of skipping when APRA_REQUIRE_V044=1 and the build is unavailable', () => {
    if (process.env.APRA_REQUIRE_V044 === '1') expect(skipReason).toBe('');
  });

  it.skipIf(!built)('every step returns the expected ids, finds the non-ASCII entry, and never throws malformed', async () => {
    const old = v044!;
    const file = path.join(tmp, 'kb.sqlite');
    const zephyr: string[] = [];

    // (1) This build creates and migrates the DB.
    let p = await openNew(file);
    zephyr.push((await p.capture(input('Zephyr beacon alpha', 'First zephyr fact.'))).id);
    zephyr.push((await p.capture(input('Zephyr harbour schedule', 'Second zephyr fact.'))).id);
    const umlaut = (await p.capture(input(`${GRUESSE} aus dem Lager`, 'German greeting note.'))).id;
    await p.capture(input('Unrelated pelican note', 'Pelicans glide.'));
    expect(await newKbQuery(p, 'zephyr')).toEqual([...zephyr].sort());
    expect(await newKbQuery(p, GRUESSE)).toEqual([umlaut]);
    p.close();

    for (let cycle = 1; cycle <= 2; cycle++) {
      // (2) 0.4.4 opens the same file.
      const r = old.run(file, repo, [
        { op: 'query', query: 'zephyr' },
        { op: 'list' },
        { op: 'capture', title: `Zephyr rollback capture ${cycle} written by the old build`, summary: `Old build entry number ${cycle}.`, content: `Captured by ${V044_TAG} in cycle ${cycle}.` },
        { op: 'query', query: 'zephyr' },
        { op: 'list' },
      ]);
      noErrors(r);
      const [q1, l1, cap, q2, l2] = r as [
        { ids: string[] }, { ids: string[] }, { id: string; decision: string }, { ids: string[] }, { ids: string[] },
      ];
      expect([...q1.ids].sort(), `0.4.4 kb_query, cycle ${cycle}`).toEqual([...zephyr].sort());
      expect(l1.ids).toEqual(expect.arrayContaining([...zephyr, umlaut]));
      expect(zephyr).not.toContain(cap.id);
      zephyr.push(cap.id);
      expect([...q2.ids].sort(), `0.4.4 kb_query after its capture, cycle ${cycle}`).toEqual([...zephyr].sort());
      expect(l2.ids).toEqual(expect.arrayContaining([...zephyr, umlaut]));

      // (3) This build opens it again.
      p = await openNew(file);
      try {
        expect(await newKbQuery(p, 'zephyr'), `new build kb_query, cycle ${cycle}`).toEqual([...zephyr].sort());
        expect(await newKbQuery(p, GRUESSE)).toEqual([umlaut]);
        const listed = await p.list({ confidence: [...ALL_TIERS], limit: 1000 });
        expect(listed.map(e => e.id)).toEqual(expect.arrayContaining([...zephyr, umlaut]));
      } finally {
        p.close();
      }
    }
  });
});
