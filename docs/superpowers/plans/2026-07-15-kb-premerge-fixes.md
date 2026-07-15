# KB Pre-Merge Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two measured defects in the KB before PR #305 merges: `kb_query` throws on 61% of realistic agent queries, and AUDN silently destroys 25% of captured entries.

**Architecture:** Two independent changes in `src/services/knowledge/`. Fix 1 gives FTS query-building a single sanitization point by splitting the overloaded `QueryOptions.query` field into free-text (`query`) and pre-tokenized (`fts_terms`) inputs. Fix 2 stops AUDN from auto-superseding on symbol+file overlap; it links instead, while leaving the supersede mechanism intact for the explicit curation paths.

**Tech Stack:** TypeScript (NodeNext ESM), better-sqlite3 with FTS5, vitest.

**Design:** `docs/superpowers/specs/2026-07-15-kb-premerge-fixes-design.md` (commit 1269f66)

## Global Constraints

- ASCII only. Never write non-ASCII characters to any file. Use `-` for dashes, `->` for arrows, `[OK]` for checkmarks. A pre-commit hook enforces this.
- Inside string literals prefer concatenation over template literals when the string contains backslash escapes -- the ASCII pre-commit hook false-positives on backtick-n/t/r inside template literals. See `sqlite-provider.ts:1276` for the existing precedent.
- Commit style: `<type>(<scope>): <description>`, e.g. `fix(kb): ...`.
- Branch: `feat/code-intelligence-abstraction`. Never push to `main`.
- Relative imports use explicit `.js` extensions (NodeNext).
- `npm test` must be green at the end of every task.
- Do NOT ship the measurement harness used to find these defects. It stays in the session scratchpad.
- Do NOT add Porter stemming, embeddings, or vector search. Explicitly out of scope per the design's Non-goals.

---

## File Structure

**Modified:**
- `src/services/knowledge/types.ts` -- add internal `fts_terms` to `QueryOptions` (Task 1)
- `src/services/knowledge/sqlite-provider.ts` -- `query()` sanitization (Task 1), `prime()` call site (Task 1), `evaluateAudn()` update branch (Task 2)
- `src/services/knowledge/audn.ts` -- correct a false comment (Task 1)

**Test files modified:**
- `tests/knowledge/kb-query.test.ts` -- new sanitization cases (Task 1), supersede fixture (Task 2)
- `tests/knowledge/kb-fts-orjoin.test.ts` -- bulk-prime regression guard (Task 1)
- `tests/knowledge/kb-supersede.test.ts` -- rewritten around the explicit path (Task 2)
- `tests/knowledge/kb-capture.test.ts` -- AUDN update semantics (Task 2)
- `tests/knowledge/kb-list.test.ts`, `kb-export.test.ts`, `kb-stats.test.ts`, `kb-flagged-pipeline.test.ts`, `kb-reconcile-e2e.test.ts` -- supersede fixture (Task 2)

**Task independence:** Fix 1 is purely additive -- verified: all 360 existing KB tests pass with Fix 1 applied alone. Fix 2 is what breaks the 9 tests. Task 1 therefore lands green with no test churn, and Task 2 owns all of it.

---

## Task 1: Single FTS sanitization point

**Files:**
- Modify: `src/services/knowledge/types.ts:85-102` (`QueryOptions`)
- Modify: `src/services/knowledge/sqlite-provider.ts:797-806` (`query()` FTS branch)
- Modify: `src/services/knowledge/sqlite-provider.ts:952-959` (`prime()` call site)
- Modify: `src/services/knowledge/audn.ts:73` (false comment)
- Test: `tests/knowledge/kb-query.test.ts`
- Test: `tests/knowledge/kb-fts-orjoin.test.ts`

**Interfaces:**
- Consumes: `orJoinFtsTerms(terms: string[]): string` from `./audn.js` (already imported by `sqlite-provider.ts`).
- Produces: `QueryOptions.fts_terms?: string[]` -- internal-only; consumed by `query()`, passed by `prime()`. MUST NOT be exposed on `kbQuerySchema` or the HTTP route.

**Background for the implementer:**

`query()` currently passes the caller's string straight into `entries_fts MATCH ?`. FTS5 treats `.`, `-`, `(`, `)`, `/` as syntax, so real queries throw:

```
query("errors.ts hierarchy")   -> THREW: fts5: syntax error near "."
query("kb-eval-project build") -> THREW: no such column: eval
query("parse() check")         -> THREW: fts5: syntax error near ")"
```

Bare words are also implicitly AND-ed, so multi-term queries silently return zero.

`prime()` currently pre-builds an FTS expression and passes it as `query`. If `query()` sanitized `opts.query` naively, it would re-tokenize `"alpha" OR "beta"` into `['alpha','OR','beta']` and rebuild `"alpha" OR "OR" OR "beta"` -- injecting a search for the literal word "or". That is why `fts_terms` exists: raw terms stay discrete until the one sanitization point.

- [ ] **Step 1: Write the failing tests**

Add to `tests/knowledge/kb-query.test.ts`, inside the existing `describe('kb_query', ...)` block. `makeInput` and `provider` already exist in this file.

```ts
  it('does not throw on FTS-hostile strings agents actually send', async () => {
    await provider.capture(makeInput());

    // Each of these threw before sanitization. The doer skill instructs agents
    // to "call kb_query before reading an unfamiliar file" -- a file path is
    // the single most likely query.
    const hostile = [
      'src/services/registry.ts',
      'getOrCreate() vs initRegistry()',
      'kb-eval-project registry init',
      'registry.ts init',
      '.js ESM registry',
    ];
    for (const q of hostile) {
      const r = await provider.query({ query: q });
      expect(Array.isArray(r.results)).toBe(true);
    }
  });

  it('finds an entry by a path-shaped query', async () => {
    const e = await provider.capture(makeInput());
    const r = await provider.query({ query: 'src/services/registry.ts' });
    expect(r.results.map(x => x.id)).toContain(e.id);
  });

  it('OR-joins multi-term queries instead of requiring every term', async () => {
    const e = await provider.capture(makeInput());
    // 'registry' matches; 'nonexistentterm' does not. Implicit AND returned 0.
    const r = await provider.query({ query: 'registry nonexistentterm' });
    expect(r.results.map(x => x.id)).toContain(e.id);
  });

  it('returns empty (not a throw) for a query with no usable tokens', async () => {
    await provider.capture(makeInput());
    const r = await provider.query({ query: '--- ... ///' });
    expect(r.results).toHaveLength(0);
  });
```

Add to `tests/knowledge/kb-fts-orjoin.test.ts`. This is the regression guard for the double-sanitization bug; a per-hint-at-a-time test cannot catch it, because a single term never contains " OR ".

```ts
describe('prime() does not double-sanitize hint_symbols', () => {
  it('bulk prime with MULTIPLE hints does not inject a literal OR term', async () => {
    const provider = new SqliteProvider(':memory:');
    await provider.init();

    // Entry mentions alphaSym only. The word "or" appears in its prose.
    await provider.capture({
      type: 'knowledge',
      title: 'alphaSym behavior',
      summary: 'Describes alphaSym.',
      content: 'This alphaSym path caches results or recomputes them.',
      source_files: ['src/alpha.ts'],
      symbols: ['alphaSym'],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'test-agent',
      source: 'doer',
      confidence: 'INFERRED',
    } as KBEntryInput);

    // Entry that mentions NEITHER hint, but does contain the word "or".
    await provider.capture({
      type: 'knowledge',
      title: 'unrelated subject',
      summary: 'Mentions neither hint.',
      content: 'This unrelated path either succeeds or fails.',
      source_files: ['src/unrelated.ts'],
      symbols: ['unrelatedSym'],
      tags: [],
      content_hash: '',
      content_hash_type: 'sha256',
      flagged_for_review: false,
      author: 'test-agent',
      source: 'doer',
      confidence: 'INFERRED',
    } as KBEntryInput);

    const r = await provider.prime({ hint_symbols: ['alphaSym', 'betaSym'] });
    const titles = r.top_entries.map(e => e.title);

    expect(titles).toContain('alphaSym behavior');
    // If "OR" leaks in as a search term, the unrelated entry matches on "or".
    expect(titles).not.toContain('unrelated subject');

    provider.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/knowledge/kb-query.test.ts tests/knowledge/kb-fts-orjoin.test.ts`

Expected: FAIL. The kb-query cases fail with `fts5: syntax error near "."` / `no such column: eval`; the OR-join case fails with 0 results; the bulk-prime case passes already (it guards the fix you are about to write -- confirm it still passes in Step 4).

- [ ] **Step 3: Add `fts_terms` to `QueryOptions`**

In `src/services/knowledge/types.ts`, replace the opening of `QueryOptions`:

```ts
export interface QueryOptions {
  // Free text from a caller (kb_query). Tokenized + OR-joined inside query().
  // NEVER pass a pre-built FTS expression here -- query() would re-tokenize it
  // and turn '"a" OR "b"' into '"a" OR "OR" OR "b"'. Use fts_terms instead.
  query?: string;
  // INTERNAL ONLY. Callers that already hold discrete terms (prime) pass them
  // here so sanitization happens exactly once and AND-within-term semantics
  // survive for qualified names (Parser.parsePower -> '"Parser" "parsePower"').
  // Structurally unreachable from kbQuerySchema and the HTTP /api/kb/query
  // route -- both build QueryOptions field-by-field from zod-parsed input.
  // Do NOT add this to either surface.
  fts_terms?: string[];
```

- [ ] **Step 4: Sanitize in `query()` and stop pre-building in `prime()`**

In `src/services/knowledge/sqlite-provider.ts`, replace the FTS branch of `query()`:

```ts
    if (opts.query || opts.fts_terms?.length) {
      // ONE sanitization point. Free text is tokenized then OR-joined; internal
      // callers pass discrete terms via fts_terms. Raw MATCH threw on '.', '-',
      // '(', ')', '/' and implicit-AND'd multi-term queries to zero rows.
      const ftsQuery = opts.fts_terms?.length
        ? orJoinFtsTerms(opts.fts_terms)
        : orJoinFtsTerms(opts.query!.match(/[A-Za-z0-9_]+/g) ?? []);
      if (!ftsQuery) return { results: [], total: 0, l1_only: !!opts.l1_only };
      const ftsWhere = conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';
      rows = db.prepare(`
        SELECT e.* FROM entries e
        JOIN entries_fts ON entries_fts.rowid = e.rowid
        WHERE entries_fts MATCH ?
        ${ftsWhere}
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, ...params, limit) as Record<string, unknown>[];
```

In the same file, in `prime()`, replace the pre-built query with raw terms:

```ts
        const l1 = await this.query({
          fts_terms: searchTerms,
          l1_only: true,
          limit: 10,
          include_stale: false,
        });
```

- [ ] **Step 5: Correct the false comment in `audn.ts`**

`audn.ts:73` claims the helper is already "Shared by every FTS query-building site (D4)". That was untrue -- `query()` did not use it. It is true as of this task. Replace the phrase `Shared by every FTS query-building site (D4).` with:

```
// Shared by every FTS query-building site: findAudnCandidates (via
// makeFtsQuery), prime (via QueryOptions.fts_terms), and query() itself
// (free text). query() previously passed the caller's raw string to MATCH,
// which threw on '.', '-', '(', ')', '/' -- 61% of real agent queries.
```

- [ ] **Step 6: Run the new tests**

Run: `npx vitest run tests/knowledge/kb-query.test.ts tests/knowledge/kb-fts-orjoin.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full KB suite -- no regressions**

Run: `npx vitest run tests/knowledge/`
Expected: PASS, all files. This task is additive; nothing should break. If any test fails here, stop -- Fix 1 was verified against a clean 360/360 baseline, so a failure means the change diverged from this plan.

- [ ] **Step 8: Build and ASCII check**

Run: `npm run build`
Expected: no TypeScript errors.

Run: `node -e "const t=require('fs').readFileSync('src/services/knowledge/sqlite-provider.ts','utf-8'); const n=[...t].filter(c=>c.charCodeAt(0)>127).length; console.log('non-ASCII:', n); process.exit(n?1:0)"`
Expected: `non-ASCII: 0`

- [ ] **Step 9: Commit**

```bash
git add src/services/knowledge/types.ts src/services/knowledge/sqlite-provider.ts src/services/knowledge/audn.ts tests/knowledge/kb-query.test.ts tests/knowledge/kb-fts-orjoin.test.ts
git commit -m "fix(kb): sanitize kb_query FTS input at a single point

query() passed the caller's raw string to entries_fts MATCH, so '.', '-',
'(', ')' and '/' threw. Measured on real agent output: 20/33 queries threw,
only 3/33 returned results. Bare words were also implicitly AND-ed, so
multi-term queries silently returned zero.

Free text is now tokenized and OR-joined via the existing orJoinFtsTerms
helper. prime() passes discrete terms through a new internal fts_terms field
rather than pre-building an expression -- re-tokenizing a pre-built
'\"a\" OR \"b\"' would inject the literal word OR as a search term."
```

---

## Task 2: AUDN links instead of auto-superseding

**Files:**
- Modify: `src/services/knowledge/sqlite-provider.ts:558-567` (`evaluateAudn` update branch)
- Test: `tests/knowledge/kb-supersede.test.ts` (rewrite)
- Test: `tests/knowledge/kb-capture.test.ts`, `kb-query.test.ts`, `kb-list.test.ts`, `kb-export.test.ts`, `kb-stats.test.ts`, `kb-flagged-pipeline.test.ts`, `kb-reconcile-e2e.test.ts`

**Interfaces:**
- Consumes: `resolveContradiction(winnerId, loserId, evidence): Promise<{winnerId, loserId}>` -- the explicit supersede path. It REFUSES unless the pair is genuinely linked (`winner.contradiction_of === loser.id` or vice versa), neither is already superseded, and neither is an active user-directive.
- Produces: `audn_decision: 'update'` now means "a related prior entry was found and linked", NOT "the prior entry was retired". The value name is unchanged for continuity.

**Background for the implementer:**

`makeAudnDecision` treats "same type + symbol overlap + file overlap + content differs" as an update and retires the prior entry. There is no similarity threshold -- content inequality is the entire test. Measured on real agent output: 6 of 24 captures (25%) destroyed a distinct entry. Symbol+file overlap is far too coarse: 27 of the 97 entries in `.fleet/kb-canonical.json` share `sqlite-provider.ts` alone.

The supersede MECHANISM stays. Only AUDN's automatic trigger goes.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `tests/knowledge/kb-supersede.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// AUDN never auto-supersedes. Symbol+file overlap is too coarse a topicality
// test -- measured 25% of real agent captures destroyed a DISTINCT entry.
// A refinement links to its predecessor and both stay live; curation decides
// what to retire. Supersede still happens, but only via the explicit path
// (resolveContradiction / promote / kb-reconcile).

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'Registry initialization behavior',
    summary: 'How registry init works',
    content: 'The registry initializes lazily on first access via getOrCreate().',
    source_files: ['src/services/registry.ts'],
    symbols: ['initRegistry', 'getOrCreate'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'test-agent',
    source: 'doer',
    confidence: 'INFERRED',
    ...overrides,
  };
}

let provider: SqliteProvider;

beforeEach(async () => {
  provider = new SqliteProvider(':memory:');
  await provider.init();
});

afterEach(() => {
  provider.close();
});

describe('AUDN does not auto-supersede', () => {
  it('keeps two DISTINCT facts about the same symbol+file both live', async () => {
    const perf = await provider.capture(makeInput({
      title: 'parseConfig is slow on large files',
      content: 'parseConfig does a full re-read per key; it is slow on large files.',
      source_files: ['src/config.ts'],
      symbols: ['parseConfig'],
    }));
    const crash = await provider.capture(makeInput({
      title: 'parseConfig throws on null input',
      content: 'parseConfig throws a TypeError when handed a null input buffer.',
      source_files: ['src/config.ts'],
      symbols: ['parseConfig'],
    }));

    expect(crash.id).not.toBe(perf.id);

    const live = await provider.query({ limit: 50 });
    const ids = live.results.map(e => e.id);
    expect(ids).toContain(perf.id);
    expect(ids).toContain(crash.id);
  });

  it('leaves the prior entry unsuperseded and unstale', async () => {
    const first = await provider.capture(makeInput());
    const second = await provider.capture(makeInput({
      content: 'The registry now initializes eagerly at startup. Changed in v2.',
    }));
    expect(second.audn_decision).toBe('update');

    const all = await provider.query({ include_superseded: true, include_stale: true });
    const old = all.results.find(e => e.id === first.id);
    expect(old).toBeDefined();
    expect(old!.superseded_at).toBeFalsy();
    expect(old!.stale).toBe(false);
  });

  it('links the refinement to its predecessor', async () => {
    const first = await provider.capture(makeInput());
    const second = await provider.capture(makeInput({
      content: 'The registry now initializes eagerly at startup. Changed in v2.',
    }));

    // getLinked() does not expose link_type, and wireLinks already creates
    // shares_symbol/shares_file edges between these two. Assert the 'refines'
    // edge directly. (TS `private` is compile-time only.)
    const db = (provider as unknown as { db: import('better-sqlite3').Database }).db;
    const row = db.prepare(
      'SELECT 1 FROM links WHERE from_id = ? AND to_id = ? AND link_type = ?'
    ).get(second.id, first.id, 'refines');
    expect(row).toBeDefined();
  });
});

describe('explicit supersede still marks superseded_at AND stale', () => {
  // The original invariant (T1.3 / D2 F2a): a superseded entry must carry BOTH
  // superseded_at and stale = 1, so it cannot leak through query()/prime()
  // paths that filter on stale independently of superseded_at. Still true --
  // it is just no longer reachable by an ordinary capture.
  it('resolveContradiction retires the loser with both markers', async () => {
    const broken = await provider.capture(makeInput({
      title: 'X is broken', summary: 'X is broken', content: 'X is broken',
      symbols: ['symX'], source_files: ['src/x.ts'],
    }));
    const works = await provider.capture(makeInput({
      title: 'X now works', summary: 'X now works', content: 'X now works',
      symbols: ['symX'], source_files: ['src/x.ts'],
    }));
    expect(works.audn_decision).toBe('flagged');

    await provider.resolveContradiction(works.id, broken.id, 'verified fixed in v2');

    const all = await provider.query({ include_superseded: true, include_stale: true });
    const loser = all.results.find(e => e.id === broken.id);
    expect(loser!.superseded_at).toBeTruthy();
    expect(loser!.stale).toBe(true);

    const winner = all.results.find(e => e.id === works.id);
    expect(winner!.superseded_at).toBeFalsy();
    expect(winner!.stale).toBe(false);
  });

  it('query() excludes the explicitly superseded entry by default', async () => {
    const broken = await provider.capture(makeInput({
      title: 'X is broken', summary: 'X is broken', content: 'X is broken',
      symbols: ['symX'], source_files: ['src/x.ts'],
    }));
    const works = await provider.capture(makeInput({
      title: 'X now works', summary: 'X now works', content: 'X now works',
      symbols: ['symX'], source_files: ['src/x.ts'],
    }));
    await provider.resolveContradiction(works.id, broken.id, 'verified fixed in v2');

    const results = await provider.query({ query: 'X' });
    const ids = results.results.map(e => e.id);
    expect(ids).not.toContain(broken.id);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/knowledge/kb-supersede.test.ts`
Expected: FAIL. `keeps two DISTINCT facts ... both live` fails because the perf entry was superseded; `leaves the prior entry unsuperseded` fails because `superseded_at` is set; `links the refinement` fails because no `refines` row exists.

- [ ] **Step 3: Make AUDN link instead of supersede**

In `src/services/knowledge/sqlite-provider.ts`, replace the `update` branch of `evaluateAudn`:

```ts
    if (decision.decision === 'update') {
      // AUDN NEVER auto-supersedes. symbol+file overlap is too coarse a
      // topicality test -- content inequality was the entire gate, so two
      // DISTINCT facts about one symbol destroyed each other (measured: 25% of
      // real agent captures). Link the refinement to its predecessor and leave
      // both live; curation decides what to retire. Supersede remains reachable
      // ONLY through the explicit paths (resolveContradiction / promote /
      // kb-reconcile), which is where a human or a real signal is in the loop.
      const newId = randomUUID();
      this.insertEntry(db, newId, input, newContent, now, sourceFileHashes);
      this.wireLinks(db, newId, input);
      db.prepare(
        'INSERT OR IGNORE INTO links (from_id, to_id, link_type) VALUES (?, ?, ?)'
      ).run(newId, decision.matchedId, 'refines');
      // 'update' now means "a related prior entry was found and linked", NOT
      // "the prior entry was retired".
      return { id: newId, audn_decision: 'update' };
    }
```

- [ ] **Step 4: Run the rewritten supersede tests**

Run: `npx vitest run tests/knowledge/kb-supersede.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full KB suite to surface every dependent test**

Run: `npx vitest run tests/knowledge/`
Expected: FAIL -- roughly 7 tests across 6 files that used AUDN as a fixture to manufacture a superseded row. Record the exact list before editing.

- [ ] **Step 6: Repair each dependent test with the explicit-supersede fixture**

Every one of these captures twice with overlapping symbol+file and then asserts the first entry vanished. That fixture no longer produces a superseded row. Replace it with a genuine contradiction pair plus `resolveContradiction`.

The recipe -- inline it into each test file that needs it (do NOT create a shared test util; these files have no existing shared helper and each already defines its own local `makeInput`):

```ts
// AUDN no longer auto-supersedes, so a superseded row must be driven through
// the explicit path: capture A, capture a CONTRADICTING B (AUDN flags it and
// sets B.contradiction_of = A.id), then resolveContradiction(B, A) retires A.
async function supersedeViaContradiction(p: SqliteProvider, a: string, b: string) {
  await p.resolveContradiction(b, a, 'verified in test fixture');
}
```

`tests/knowledge/kb-query.test.ts` -- `superseded entry excluded by default` (line ~99). Replace the body:

```ts
  it('superseded entry excluded by default', async () => {
    const broken = await provider.capture(makeInput({
      title: 'X is broken', summary: 'X is broken', content: 'X is broken',
      symbols: ['symX'], source_files: ['src/x.ts'],
    }));
    const works = await provider.capture(makeInput({
      title: 'X now works', summary: 'X now works', content: 'X now works',
      symbols: ['symX'], source_files: ['src/x.ts'],
    }));
    await provider.resolveContradiction(works.id, broken.id, 'fixed in v2');

    const result = await provider.query({ query: 'X' });
    const ids = result.results.map(e => e.id);
    expect(ids).not.toContain(broken.id);
    expect(ids).toContain(works.id);
  });
```

`tests/knowledge/kb-list.test.ts` -- `excludes superseded entries by default` (line ~131). Replace the body:

```ts
  it('excludes superseded entries by default', async () => {
    const broken = await provider.capture(makeInput({
      title: 'X is broken', summary: 'X is broken', content: 'X is broken',
      symbols: ['symSupersede'], source_files: ['src/x.ts'],
    }));
    const works = await provider.capture(makeInput({
      title: 'X now works', summary: 'X now works', content: 'X now works',
      symbols: ['symSupersede'], source_files: ['src/x.ts'],
    }));
    await provider.resolveContradiction(works.id, broken.id, 'fixed in v2');

    const results = await provider.list({});
    expect(results.some(e => e.id === broken.id)).toBe(false);
  });
```

`tests/knowledge/kb-capture.test.ts` -- `updated fact returns audn_decision=update and old entry has superseded_at set`. This test encodes the defect. Rename it and invert the supersede assertion, keeping the `audn_decision` assertion:

```ts
  it('refined fact returns audn_decision=update and leaves the old entry live', async () => {
    const first = await provider.capture(makeInput());
    const second = await provider.capture(makeInput({
      content: 'The registry now initializes eagerly at startup.',
    }));
    expect(second.audn_decision).toBe('update');

    const all = await provider.query({ include_superseded: true, include_stale: true });
    const old = all.results.find(e => e.id === first.id);
    expect(old!.superseded_at).toBeFalsy();
  });
```

For `kb-export.test.ts`, `kb-stats.test.ts`, `kb-flagged-pipeline.test.ts`, and `kb-reconcile-e2e.test.ts`: each needs a superseded row for a count or an exclusion assertion. Apply the same substitution -- replace the "capture twice with overlapping symbol+file" fixture with the broken/now-works contradiction pair plus `resolveContradiction`. Do not change what these tests assert; only how they manufacture the superseded row. `kb-stats.test.ts` already uses exactly this broken/fixed pair for its `flagged` fixture (line ~80), so follow that local idiom.

Note for `kb-stats.test.ts`: the `superseded` count expectation may need adjusting, because the contradiction pair produces one flagged entry AND one superseded entry where the old fixture produced only a superseded one. Read the current expected numbers and recompute rather than guessing.

- [ ] **Step 7: Run the full KB suite**

Run: `npx vitest run tests/knowledge/`
Expected: PASS, all files.

- [ ] **Step 8: Run the whole test suite**

Run: `npm test`
Expected: PASS. Nothing outside `tests/knowledge/` referenced AUDN supersede semantics at the time this plan was written, but confirm.

- [ ] **Step 9: Build and ASCII check**

Run: `npm run build`
Expected: no TypeScript errors.

Run: `node -e "const fs=require('fs'); let bad=0; for (const f of fs.readdirSync('src/services/knowledge')) { const t=fs.readFileSync('src/services/knowledge/'+f,'utf-8'); bad += [...t].filter(c=>c.charCodeAt(0)>127).length; } console.log('non-ASCII:', bad); process.exit(bad?1:0)"`
Expected: `non-ASCII: 0`

- [ ] **Step 10: Commit**

```bash
git add src/services/knowledge/sqlite-provider.ts tests/knowledge/
git commit -m "fix(kb): AUDN links refinements instead of auto-superseding

AUDN treated 'same type + symbol overlap + file overlap + content differs' as
an update and retired the prior entry. There was no similarity threshold --
content inequality was the entire gate -- so two DISTINCT facts about one
symbol destroyed each other. Measured on real agent output: 6 of 24 captures
(25%) destroyed a distinct entry. symbol+file overlap is far too coarse: 27 of
97 bible entries share sqlite-provider.ts alone.

A refinement now links 'refines' -> its predecessor and both stay live.
Supersede remains reachable through the explicit paths (resolveContradiction /
promote / kb-reconcile). audn_decision 'update' now means 'a related prior
entry was found and linked'.

The design doc's Known Limitations already accepted duplicates as tolerable
for the inverse (missed-merge) case; this applies the same posture to the
destructive direction. Tests that used AUDN as a fixture to manufacture a
superseded row now drive it through resolveContradiction."
```

---

## Verification

After both tasks:

```bash
npm test          # all green
npm run build     # no TS errors
git log --oneline -3
```

Expected behavior change, verifiable by hand:

```
BEFORE: query("src/auth.ts")  -> THREW: fts5: syntax error near "/"
AFTER:  query("src/auth.ts")  -> returns matching entries

BEFORE: capture A (parseConfig slow) + capture B (parseConfig throws) -> 1 live
AFTER:  capture A + capture B -> 2 live, B linked 'refines' -> A
```
