# KB Pre-Merge Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two measured defects in the KB before PR #305 merges: `kb_query` throws on 61% of realistic agent queries, and AUDN silently destroys 25% of captured entries.

**Architecture:** Two changes in `src/services/knowledge/`. Fix 1 gives FTS query-building a single sanitization point by splitting the overloaded `QueryOptions.query` field into free-text (`query`) and pre-tokenized (`fts_terms`) inputs. Fix 2 makes supersede opt-in: AUDN retires the prior entry only when a capture explicitly names it via `supersedes`, and links `refines` otherwise. Supersede could not simply be removed -- `skills/pm/kb-review.md` Step 4 used AUDN's inference as its retirement API in 4 of 5 paths, so that file is rewritten to pass `supersedes` explicitly.

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
- `src/tools/kb-capture.ts` -- expose `supersedes` on kbCaptureSchema (Task 2)
- `skills/pm/kb-review.md` -- Step 4 passes `supersedes` explicitly (Task 2)
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

## Task 2: Supersede becomes opt-in (AUDN stops inferring it)

**Files:**
- Modify: `src/services/knowledge/types.ts` (`KBEntry` / `KBEntryInput` -- add `supersedes`)
- Modify: `src/services/knowledge/sqlite-provider.ts` (`evaluateAudn` update branch)
- Modify: `src/tools/kb-capture.ts` (`kbCaptureSchema` -- expose `supersedes`)
- Modify: `skills/pm/kb-review.md` (Step 4 paths A, B, M, D)
- Test: `tests/knowledge/kb-supersede.test.ts`, `kb-capture.test.ts`, and any file the suite reports failing

**Interfaces:**
- Consumes: `makeAudnDecision(input, candidates, newContent): AudnResult | null` from `./audn.js`. Its `update` decision means "a same-type candidate overlaps on symbol AND file and the content differs". It is a TOPICALITY signal, not consent to destroy.
- Produces: `KBEntryInput.supersedes?: string`. When it equals the matched candidate's id, AUDN retires that candidate exactly as it does today. Otherwise AUDN links `refines` and both entries stay live.

**Background for the implementer -- read this, it is the whole point of the task:**

AUDN currently treats "same type + symbol overlap + file overlap + content differs" as licence to retire the prior entry. There is no similarity check -- content inequality is the entire gate. Measured on real agent output: 6 of 24 captures (25%) silently destroyed a DISTINCT note (e.g. "parseConfig is slow on large files" was destroyed by "parseConfig throws on null input" -- both true, one lost).

But supersede cannot simply be removed. `skills/pm/kb-review.md` Step 4 uses a corrective `kb_capture` to TRIGGER AUDN's auto-supersede in four of its five resolution paths. It is using AUDN's dedup as an implicit supersede API. Removing the trigger would leave the Merge and Delete-both paths with no retirement mechanism at all (the only other `superseded_at` writers are `resolveContradiction`, which demands a genuine contradiction pair, and directive-rejection, which demands `type='user-directive'`).

So: supersede becomes OPT-IN. Callers that mean to replace something say so. Ordinary doer/reviewer captures do not, and stop destroying data.

Two properties to preserve exactly:
- The explicit branch must run the SAME UPDATE as today: `superseded_at` + `stale = 1`, and it must NOT clear `flagged_for_review`. Clearing the flag is `resolveContradiction`'s behavior (`sqlite-provider.ts:1327`), not this path's. `kb-flagged-pipeline.test.ts` asserts the difference.
- Active user-directives are already unreachable from the update path -- `makeAudnDecision` `continue`s past them before the type gate. Do not add a second guard.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `tests/knowledge/kb-supersede.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// Supersede is OPT-IN. symbol+file overlap is a topicality signal, not consent
// to destroy: measured 25% of real agent captures retired a DISTINCT entry.
// A caller that means to replace something passes `supersedes`. Everything else
// links and both entries stay live.

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

describe('implicit capture does NOT supersede', () => {
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

describe('explicit supersedes DOES supersede', () => {
  it('retires the named entry with superseded_at AND stale', async () => {
    const first = await provider.capture(makeInput());
    const second = await provider.capture(makeInput({
      content: 'The registry now initializes eagerly at startup. Changed in v2.',
      supersedes: first.id,
    }));
    expect(second.audn_decision).toBe('update');

    const all = await provider.query({ include_superseded: true, include_stale: true });
    const old = all.results.find(e => e.id === first.id);
    expect(old!.superseded_at).toBeTruthy();
    expect(old!.stale).toBe(true);
    expect(old!.content_hash).toBe('');

    const fresh = all.results.find(e => e.id === second.id);
    expect(fresh!.superseded_at).toBeFalsy();
    expect(fresh!.stale).toBe(false);
  });

  it('does NOT clear flagged_for_review on the superseded entry', async () => {
    // resolveContradiction clears the flag; this path must not. kb-review.md
    // depends on the difference.
    const first = await provider.capture(makeInput({ flagged_for_review: true }));
    const second = await provider.capture(makeInput({
      content: 'The registry now initializes eagerly at startup. Changed in v2.',
      supersedes: first.id,
    }));
    expect(second.id).not.toBe(first.id);

    const all = await provider.query({ include_superseded: true, include_stale: true });
    const old = all.results.find(e => e.id === first.id);
    expect(old!.flagged_for_review).toBe(true);
  });

  it('query() excludes the explicitly superseded entry by default', async () => {
    const first = await provider.capture(makeInput());
    const second = await provider.capture(makeInput({
      content: 'The registry now initializes eagerly at startup. Changed in v2.',
      supersedes: first.id,
    }));

    const results = await provider.query({ query: 'Registry initialization behavior' });
    const ids = results.results.map(e => e.id);
    expect(ids).not.toContain(first.id);
    expect(ids).toContain(second.id);
  });

  it('ignores a supersedes id that is not the matched candidate', async () => {
    const first = await provider.capture(makeInput());
    const unrelated = await provider.capture(makeInput({
      title: 'Unrelated cache behavior',
      content: 'The cache evicts on a 60s TTL.',
      source_files: ['src/cache.ts'],
      symbols: ['evictCache'],
    }));
    // Names an id AUDN did not match -> must not retire anything.
    const third = await provider.capture(makeInput({
      content: 'The registry now initializes eagerly at startup. Changed in v2.',
      supersedes: unrelated.id,
    }));
    expect(third.id).not.toBe(first.id);

    const all = await provider.query({ include_superseded: true, include_stale: true });
    expect(all.results.find(e => e.id === unrelated.id)!.superseded_at).toBeFalsy();
    expect(all.results.find(e => e.id === first.id)!.superseded_at).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/knowledge/kb-supersede.test.ts`
Expected: FAIL. `supersedes` does not exist on `KBEntryInput` yet (TypeScript error), and the implicit cases fail because today's AUDN supersedes unconditionally.

- [ ] **Step 3: Add `supersedes` to the type**

In `src/services/knowledge/types.ts`, add to `KBEntry` (immediately after `contradiction_of`):

```ts
  // Opt-in supersede. When a capture names the entry it replaces AND AUDN
  // independently matches that same entry as a same-topic candidate, the named
  // entry is retired. symbol+file overlap alone is NOT consent to destroy --
  // that inference silently retired 25% of real agent captures' predecessors.
  // The curation layer (skills/pm/kb-review.md Step 4) sets this deliberately;
  // ordinary doer/reviewer captures never do.
  supersedes?: string;
```

`KBEntryInput` is `Omit<KBEntry, 'id' | 'stale' | 'created_at' | 'superseded_at' | 'use_count' | 'last_accessed'>`, so it inherits `supersedes` automatically. Do not add it to the Omit list.

- [ ] **Step 4: Make AUDN honour it**

In `src/services/knowledge/sqlite-provider.ts`, replace the `update` branch of `evaluateAudn`:

```ts
    if (decision.decision === 'update') {
      const newId = randomUUID();

      if (input.supersedes === decision.matchedId) {
        // EXPLICIT: the caller named what it replaces and AUDN independently
        // matched it. Retire it exactly as before -- superseded_at + stale = 1.
        // flagged_for_review is deliberately NOT cleared here; that is
        // resolveContradiction's behavior, and kb-review.md depends on the
        // difference (a kept entry stays listed under flagged_only).
        db.prepare('UPDATE entries SET superseded_at = ?, stale = 1 WHERE id = ?')
          .run(now, decision.matchedId);
        this.insertEntry(db, newId, input, newContent, now, sourceFileHashes);
        this.wireLinks(db, newId, input);
        return { id: newId, audn_decision: 'update' };
      }

      // IMPLICIT: same type, overlapping symbol and file, different content.
      // That is a topicality signal, not consent to destroy -- two DISTINCT
      // facts about one symbol used to eat each other. Link and keep both;
      // curation retires what it means to retire, explicitly.
      this.insertEntry(db, newId, input, newContent, now, sourceFileHashes);
      this.wireLinks(db, newId, input);
      db.prepare(
        'INSERT OR IGNORE INTO links (from_id, to_id, link_type) VALUES (?, ?, ?)'
      ).run(newId, decision.matchedId, 'refines');
      return { id: newId, audn_decision: 'update' };
    }
```

- [ ] **Step 5: Run the supersede tests**

Run: `npx vitest run tests/knowledge/kb-supersede.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Expose `supersedes` on the kb_capture tool**

In `src/tools/kb-capture.ts`, add to `kbCaptureSchema`:

```ts
  supersedes: z.string().optional()
    .describe('Id of an entry this capture REPLACES. Only honored when AUDN independently matches that same entry as a same-topic candidate (same type, overlapping symbols and source_files), so it cannot retire an arbitrary entry. Omit it unless you mean to retire something -- an ordinary refinement links to its predecessor and both stay live. The KB Agent sets this when resolving a flagged pair; doer/reviewer captures should not.'),
```

Then thread it into the `capture()` input the handler builds, alongside the other zod-parsed fields. Read the handler and follow its existing shape -- do not restructure it.

- [ ] **Step 7: Run the full KB suite**

Run: `npx vitest run tests/knowledge/`
Expected: some failures. Every failure should be a test that manufactured a superseded row by capturing twice and relying on the inference. Record the exact list.

- [ ] **Step 8: Repair each failing test**

For each: add `supersedes: <firstEntryId>` to the SECOND capture. That restores the exact prior behavior, so **assertions stay unchanged**.

Worked example -- `tests/knowledge/kb-query.test.ts`, `superseded entry excluded by default`:

```ts
  it('superseded entry excluded by default', async () => {
    const first = await provider.capture(makeInput());

    const updated = makeInput({
      content: 'The registry now initializes eagerly at startup.',
      supersedes: first.id,
    });
    await provider.capture(updated);

    const result = await provider.query({ query: 'registry' });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).not.toBe(first.id);
  });
```

Two tests encode the defect rather than depend on it, and DO need their assertions changed:

`tests/knowledge/kb-capture.test.ts` -- `updated fact returns audn_decision=update and old entry has superseded_at set`. This asserts the inference. Split it:

```ts
  it('refined fact returns audn_decision=update and leaves the old entry live', async () => {
    const first = await provider.capture(makeInput());
    const second = await provider.capture(makeInput({
      content: 'The registry now initializes eagerly at startup.',
    }));
    expect(second.audn_decision).toBe('update');

    const all = await provider.query({ include_superseded: true, include_stale: true });
    expect(all.results.find(e => e.id === first.id)!.superseded_at).toBeFalsy();
  });

  it('an explicit supersedes capture returns update and retires the named entry', async () => {
    const first = await provider.capture(makeInput());
    const second = await provider.capture(makeInput({
      content: 'The registry now initializes eagerly at startup.',
      supersedes: first.id,
    }));
    expect(second.audn_decision).toBe('update');

    const all = await provider.query({ include_superseded: true, include_stale: true });
    expect(all.results.find(e => e.id === first.id)!.superseded_at).toBeTruthy();
  });
```

`tests/knowledge/kb-reconcile-e2e.test.ts:198` -- asserts a refinement IS superseded. If its scenario is a curation reconcile, pass `supersedes` and keep the assertion. If it is an ordinary refinement, invert the assertion and rename the test to say so. Read the surrounding scenario and decide; report which you chose and why.

If any other test needs an assertion changed, STOP and return NEEDS_CONTEXT naming it. Only the two above are expected.

- [ ] **Step 9: Rewrite kb-review.md Step 4**

`skills/pm/kb-review.md` Step 4 currently tells the KB Agent to trigger supersede by inference. Make each path pass `supersedes` explicitly instead. Rewrite paths A, B, M and D:

```markdown
**A -- Keep original:**
- `kb_promote(original.id, reason="contradiction resolved: original kept")` -- upgrades its confidence.
- `kb_capture` a new entry with the SAME title/symbols/source_files as the challenger, corrected content, `confidence=UNVERIFIED`, and `supersedes=<challenger.id>`. That retires the challenger.

**B -- Keep challenger:**
- `kb_promote(challenger.id, reason="contradiction resolved: challenger kept")`.
- `kb_capture` a corrected entry with the SAME title/symbols/source_files as the original, corrected content, and `supersedes=<original.id>`. That retires the original.

**M -- Merge:**
- Ask the user to provide the merged content.
- `kb_capture` a new entry with merged content and `supersedes=<id of whichever entry it replaces>`. Repeat for the second entry if both must be retired -- `supersedes` names ONE entry, so retiring both takes two captures.
- `kb_promote` the newly captured entry id.

**D -- Delete both:**
- `kb_capture` a retraction entry: `title=<original title>`, `content="Retracted: both entries were incorrect."`, `confidence=UNVERIFIED`, `supersedes=<original.id>`.
- `kb_capture` same for the challenger, with `supersedes=<challenger.id>`.
```

Also update the "Verified actual behavior" block below Step 4. Its first bullet currently reads "Superseding an entry (via the corrective `kb_capture` above, AUDN decision `update`)". Replace that parenthetical with "(via the corrective `kb_capture` above with `supersedes` set, AUDN decision `update`)". The rest of that block is still accurate -- `kb_promote` still does not clear `flagged_for_review` or `contradiction_of`, and the explicit supersede path deliberately does not either.

Remove the instruction to craft "corrected content that carries no contradiction keyword or polarity word (or AUDN will flag it again instead of updating)" ONLY if it is no longer true. It IS still true: `makeAudnDecision` checks the contradiction path before the update path, so a corrective capture carrying polarity words still gets flagged rather than superseding. Keep that guidance.

- [ ] **Step 10: Full suite, build, ASCII**

Run: `npx vitest run tests/knowledge/`
Expected: PASS, all files.

Run: `npm test`
Expected: PASS.

Run: `npm run build`
Expected: no TypeScript errors.

Run: `node -e "const fs=require('fs'); let bad=0; const fl=['src/services/knowledge/types.ts','src/services/knowledge/sqlite-provider.ts','src/tools/kb-capture.ts','skills/pm/kb-review.md']; for (const f of fl) { const t=fs.readFileSync(f,'utf-8'); bad += [...t].filter(c=>c.charCodeAt(0)>127).length; } console.log('non-ASCII:', bad); process.exit(bad?1:0)"`
Expected: `non-ASCII: 0`

- [ ] **Step 11: Commit**

```bash
git add src/services/knowledge/types.ts src/services/knowledge/sqlite-provider.ts src/tools/kb-capture.ts skills/pm/kb-review.md tests/knowledge/
git commit -m "fix(kb): make supersede opt-in so AUDN stops destroying distinct notes

AUDN treated 'same type + symbol overlap + file overlap + content differs' as
licence to retire the prior entry. There was no similarity check -- content
inequality was the entire gate -- so two DISTINCT facts about one symbol ate
each other. Measured on real agent output: 6 of 24 captures (25%) destroyed a
distinct note. symbol+file overlap is far too coarse: 27 of 97 bible entries
share sqlite-provider.ts alone.

Supersede is now opt-in. A capture that means to replace something names it via
supersedes; AUDN honors that only when it independently matches the same entry,
so a caller cannot retire an arbitrary id. Everything else links 'refines' and
both entries stay live.

Supersede could not simply be removed: skills/pm/kb-review.md Step 4 used the
corrective-capture inference as its retirement API in 4 of 5 paths, and the only
other superseded_at writers require a contradiction pair or a user-directive --
so Merge and Delete-both would have had no mechanism at all. Step 4 now passes
supersedes explicitly.

The explicit path runs the same UPDATE as before and deliberately does not clear
flagged_for_review (that is resolveContradiction's behavior); kb-flagged-pipeline
asserts the difference."
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
