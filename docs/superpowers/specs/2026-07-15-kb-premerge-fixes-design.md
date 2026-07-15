# KB pre-merge fixes (PR #305) -- design

Date: 2026-07-15
Branch: feat/code-intelligence-abstraction
PR: #305 (+29,933 / -9, CHANGES_REQUESTED)
Status: design approved, not yet implemented

## Problem

Two defects in the KB retrieval and write paths were found by replaying real
agent output through the live `SqliteProvider`. Both are invisible from the
outside: `prime()` and `enrichContextWithKb()` wrap their KB calls in `catch {}`,
so failures degrade to "no knowledge returned" rather than an error. All 360 KB
tests pass with both defects present.

Neither defect appears in the existing PR review, which is scoped to
housekeeping (harvesting scaffolding into docs, `/pm cleanup`, submodule
relocation, CI pin rationale).

## Evidence

Method: three subagents were given the verbatim doer/reviewer KB instructions
from `skills/pm/doer-reviewer-loop.md` and pointed at `eval/kb-eval-project`
(1,074 lines). Nothing in their prompts mentioned titles, symbols, or the FTS
index. Their captures, `hint_symbols`, and `kb_query` strings were then loaded
into a real in-memory `SqliteProvider` and replayed.

Sample: 24 captures, 33 queries, 73 hint symbols, 145 symbol occurrences.

Measured on current `main` behavior:

```
kb_query:   3 hit / 10 zero-results / 20 THREW   (61% throw, 9% useful)
AUDN:       24 captures written -> 18 live       (6 destroyed, 25%)
prime():    68 hit / 5 miss  (per-hint)
symbols present in FTS-indexed text: 122/145 (84%)

throw taxonomy:
  13  fts5: syntax error near "." / "(" / ")"
   5  no such column: eval        (from "kb-eval-project")
   2  no such column: trip        (from "round-trip")
```

The throws are on the documented happy path. `skills/pm/doer-reviewer-loop.md`
instructs every agent: "Before reading an unfamiliar file call kb_query first."
The most natural such query is a filename, and `.`, `-`, `(`, `)`, `/` all throw.

## Fix 1 -- one sanitization point for FTS

### Root cause

`QueryOptions.query` carries two incompatible types:

- free text from the `kb_query` MCP tool (`z.string().min(1)`, unsanitized)
- a pre-built FTS expression from `prime()`, which calls
  `orJoinFtsTerms(searchTerms)` and passes the result as `query`

`query()` (sqlite-provider.ts:797) passes whichever it receives straight to
`entries_fts MATCH ?` with no sanitization and no try/catch. The two internal
FTS callers do sanitize (`findAudnCandidates` via `makeFtsQuery`, `prime` via
`orJoinFtsTerms`); the one user-facing caller does not. The comment at
`audn.ts:73` claiming the helper is "Shared by every FTS query-building site
(D4)" is false.

### Design

1. Add an internal-only field to `QueryOptions`:

```ts
export interface QueryOptions {
  // Free text from a caller (kb_query). Sanitized + OR-joined inside query().
  // NEVER pass a pre-built FTS expression here -- see fts_terms.
  query?: string;
  // Internal callers (prime) pass RAW terms here and let query() sanitize once.
  fts_terms?: string[];
  ...
}
```

2. `query()` sanitizes exactly once, and only one of the two paths applies:

```ts
if (opts.query || opts.fts_terms?.length) {
  const ftsQuery = opts.fts_terms?.length
    ? orJoinFtsTerms(opts.fts_terms)
    : orJoinFtsTerms(opts.query!.match(/[A-Za-z0-9_]+/g) ?? []);
  if (!ftsQuery) return { results: [], total: 0, l1_only: !!opts.l1_only };
  // ... MATCH ftsQuery
}
```

3. `prime()` stops pre-building and passes raw terms:

```ts
const l1 = await this.query({
  fts_terms: searchTerms,   // was: query: orJoinFtsTerms(searchTerms)
  l1_only: true, limit: 10, include_stale: false,
});
```

### Why `fts_terms` rather than re-sanitizing `query`

A prototype that only sanitized `opts.query` double-sanitized `prime()`'s input.
`prime()` builds `"alpha" OR "beta"`; re-tokenizing that string extracts the
literal word `OR` as a search term and rebuilds `"alpha" OR "OR" OR "beta"`,
injecting a search for the word "or" -- which appears in nearly every entry.
Keeping the terms discrete until the single sanitization point avoids this and
preserves AND-within-term semantics for qualified names (`Parser.parsePower`
stays `"Parser" "parsePower"`, not four OR'd tokens).

### Constraint

`fts_terms` is internal-only. It MUST NOT be reachable from `kbQuerySchema` or
the HTTP `/api/kb/query` route. This mirrors the existing `CaptureOpts` pattern,
which is a second parameter of `capture()` specifically so it is structurally
unreachable from deserialized routes.

### Behavior change

OR-join trades precision for recall: a multi-term query matches entries
containing ANY term rather than ALL. This is the same treatment `prime()`
already applies. Mitigated by bm25 ranking (`ORDER BY rank`) and `limit`
(default 20). This is a deliberate behavior change, not a pure bug fix.

## Fix 2 -- AUDN never auto-supersedes

### Root cause

`makeAudnDecision` (audn.ts:131) treats "same type + symbol overlap + file
overlap + content differs" as an `update` and retires the prior entry:

```ts
db.prepare('UPDATE entries SET superseded_at = ?, stale = 1 WHERE id = ?')
  .run(now, decision.matchedId);
```

There is no similarity threshold -- content inequality is the entire test. Two
genuinely distinct facts about the same function in the same file destroy each
other. It also returns on the FIRST symbol-overlapping candidate in bm25 rank
order, so which entry gets destroyed depends on ranking, not on topicality.

`docs/knowledge-layer-design.md` "Known Limitations (v1)" documents the inverse
failure (two same-topic entries with no keyword overlap are not merged -> a
harmless duplicate) but not this one, which loses data.

### REVISED after an implementation finding (2026-07-15)

The original design said "AUDN never supersedes; curation decides what to
retire". That was wrong, and the error was mine: I never checked HOW curation
retires. It retires through the exact mechanism the design deleted.

`skills/pm/kb-review.md` Step 4 is the KB agent's resolution workflow. Four of
its five paths use a corrective `kb_capture` specifically to trigger AUDN's
auto-supersede:

- A (keep original):   "AUDN will UPDATE (supersede) the challenger."
- B (keep challenger): "AUDN updates (supersedes) the original."
- M (merge):           "AUDN supersedes whichever entry has the closest title match."
- D (delete both):     "AUDN supersedes the original."

It even instructs the agent to craft "corrected content that carries no
contradiction keyword or polarity word (or AUDN will flag it again instead of
updating)" -- i.e. the curation layer deliberately steers AUDN's dedup path and
uses it as an implicit supersede API.

After removing AUDN's trigger, only two writers of `superseded_at` remain:
`resolveContradiction` (requires a genuine contradiction pair) and the
directive-rejection path (requires `type='user-directive'`). `invalidate()` only
touches `context-cache`. So paths M and D would have had NO retirement mechanism,
and A/B would have changed documented behavior.

### Design (revised): supersede becomes opt-in, not inferred

`KBEntryInput` gains `supersedes?: string`. AUDN's `update` branch retires the
prior entry ONLY when the caller explicitly named it:

```ts
if (decision.decision === 'update') {
  const newId = randomUUID();
  if (input.supersedes === decision.matchedId) {
    // EXPLICIT: caller named what it replaces. Unchanged legacy semantics --
    // superseded_at + stale=1, flagged_for_review deliberately NOT cleared
    // (that is resolveContradiction's behavior, not this path's).
    db.prepare('UPDATE entries SET superseded_at = ?, stale = 1 WHERE id = ?')
      .run(now, decision.matchedId);
    this.insertEntry(db, newId, input, newContent, now, sourceFileHashes);
    this.wireLinks(db, newId, input);
    return { id: newId, audn_decision: 'update' };
  }
  // IMPLICIT: symbol+file overlap is NOT consent to destroy. Link and keep both.
  this.insertEntry(db, newId, input, newContent, now, sourceFileHashes);
  this.wireLinks(db, newId, input);
  db.prepare('INSERT OR IGNORE INTO links (from_id, to_id, link_type) VALUES (?, ?, ?)')
    .run(newId, decision.matchedId, 'refines');
  return { id: newId, audn_decision: 'update' };
}
```

Why this is strictly better than the original design:

- It kills the data loss at its source. The 25% came from ordinary doer/reviewer
  captures that never intended to replace anything. They will not pass
  `supersedes`, so they link.
- It preserves curation for all five paths, with byte-identical semantics --
  the explicit branch runs the same UPDATE the old code ran.
- It preserves every existing supersede assertion in the test suite. The
  contradiction-pair substitution the original design implied would have broken
  four assertions in `kb-flagged-pipeline.test.ts`, because
  `resolveContradiction` also clears `flagged_for_review` while the AUDN path
  does not. Test repairs collapse to adding `supersedes: <id>` to the second
  capture.

`skills/pm/kb-review.md` Step 4 must be rewritten to pass `supersedes` explicitly
in paths A, B, M and D, rather than relying on AUDN to infer it. Note kumaakh's
PR review asks for `skills/pm/` to move into the `apra-pm` submodule; that
relocation is out of scope here, but whoever performs it must carry this change.

### Rationale

Symbol+file overlap is too coarse a topicality proxy: 27 of the 97 entries in
`.fleet/kb-canonical.json` share `src/services/knowledge/sqlite-provider.ts`
alone. Every current KG system pairs cheap blocking with an adjudication step
(Graphiti: embedding kNN + BM25 -> LLM adjudication; Mem0: LLM conflict
resolver; HippoRAG: embedding synonym edges). AUDN has blocking with no
adjudicator -- it overwrites on candidate match. Given that embedding/LLM
adjudication is deliberately deferred to v2, the correct v1 posture is to not
adjudicate destructively at all.

This applies the risk posture the design doc already states (duplicates are
tolerable) to the direction it had not been applied to.

## Measured outcome (prototype, then reverted)

| metric | before | after |
| --- | --- | --- |
| queries that throw | 20/33 | 0/33 |
| queries returning results | 3/33 | 33/33 |
| captures destroying an entry | 6/24 | 0/24 |
| prime per-hint misses | 5/73 | 0/73 |

The prime misses (`evalBinary`, `dispatchNode`, `EvalOptions`, `checkOverflow`,
`evaluateAll`) were resolved by Fix 2, not Fix 1: those entries existed and had
been silently superseded by AUDN. The apparent "symbol recall gap" was
substantially a symptom of the data loss.

## Test impact

9 tests across 8 files assert the current supersede semantics and must be
updated:

- tests/knowledge/kb-capture.test.ts -- "updated fact returns audn_decision=update
  and old entry has superseded_at set"
- tests/knowledge/kb-query.test.ts -- "superseded entry excluded by default"
- tests/knowledge/kb-list.test.ts -- "excludes superseded entries by default"
- tests/knowledge/kb-export.test.ts -- "only live CONFIRMED entries appear"
- tests/knowledge/kb-flagged-pipeline.test.ts -- flagged-pipeline e2e
- tests/knowledge/kb-stats.test.ts -- "stale/flagged/superseded counts"
- tests/knowledge/kb-supersede.test.ts -- "sets superseded_at and stale=1 on the
  old entry, keeps the new one live"
- tests/knowledge/kb-reconcile-e2e.test.ts -- bible reconcile e2e

Two categories:

- Tests that genuinely exercise supersede should drive it through an explicit
  path (`resolveContradiction` / `promote`) rather than using AUDN as a fixture
  to manufacture a superseded row.
- Tests that assert AUDN auto-supersedes encode the defect. They should assert
  the `refines` link and both entries staying live.

`audn_decision: 'update'` is retained as a return value -- it now means "a
related prior entry was found and linked", not "the prior entry was retired".

## Test coverage for the fixes

The measurement harness used to find and size these defects is NOT shipped. It
was throwaway instrumentation; its recorded samples are one-off agent output
from a single toy project and would rot. It lives in the session scratchpad only.

The fixes get ordinary unit tests in the existing suite. These are the cases the
suite currently lacks -- each one is a defect that shipped because nothing
exercised it:

Fix 1 (`tests/knowledge/kb-query.test.ts`):

- `query({ query: 'src/auth.ts' })` returns results and does not throw
- `query({ query: 'parse() vs parseWithMeta()' })` does not throw
- `query({ query: 'kb-eval-project build' })` does not throw
- a multi-term query returns entries matching ANY term (OR), not only ALL
- a query of pure punctuation returns empty rather than throwing

Fix 2 (`tests/knowledge/kb-supersede.test.ts` / `kb-capture.test.ts`):

- two DISTINCT captures sharing type+symbol+file both stay live
- the second capture links `refines` -> the first
- `resolveContradiction` / `promote` still set `superseded_at` (mechanism intact)

Fix 1 regression guard (`tests/knowledge/kb-fts-orjoin.test.ts`):

- `prime()` with MULTIPLE `hint_symbols` in ONE call does not inject a literal
  `"OR"` term. This is load-bearing: a per-hint-at-a-time test cannot catch the
  double-sanitization bug described under Fix 1, because a single term never
  contains " OR ".

No existing test would have caught either defect. Every symbol-recall test bends
its fixture around the flaw -- see the comment at
`tests/knowledge/kb-freshness.test.ts:23`:

```
// The symbol name is embedded in title+content too (not just the symbols
// array) because entries_fts only indexes title/summary/content/tags --
// prime()'s hint_symbols search is an FTS MATCH over those text columns,
// not the symbols JSON column.
```

and no test passes a path, hyphen, quote, or paren to `query()`.

## Out of scope (fast-follow)

- `symbols` / `source_files` structured filters. `QueryOptions` declares both;
  `query()` implements neither and silently ignores them (a caller passing
  `symbols: ['nonexistent']` gets unfiltered results, not zero). Measured miss
  rate is 7% of hint symbols (5/73), concentrated in qualified names written by
  reviewers (`Parser.parsePower`). Real, but not a blocker. Fixing it needs a
  tool-schema change and therefore an `apra-pm` skill-docs PR.
- `makeFtsQuery`'s `{3,}` filter drops symbols shorter than 3 chars (`id`, `db`,
  `fs`) from AUDN candidate discovery. FTS5 itself has no minimum token length,
  so only this call site is affected.
- The `hasOppositePolarity` antonym lexicon is negation-blind ("not fixed" reads
  as a contradiction of "broken"; "no longer broken" reads as agreement). Real
  but rare: 7/97 bible entries contain any negation cue and 1/97 trips the
  contradiction keywords. Non-destructive (costs spurious review work and demotes
  a new entry to UNVERIFIED). Defer to a v2 NLI spike.
- `wireLinks()` full-scans every live entry on every capture and writes
  `shares_symbol`/`shares_file` edges. `getLinked()` is implemented but called by
  no tool -- the edges are write-only. Waste, not harm.

## Non-goals (validated by research, leave alone)

`docs/knowledge-layer-design.md` defers semantic/vector search, GraphZep-style
temporal KG, and embedding-based dedup on the rationale that "FTS5 covers v1".
Current evidence supports that call:

- Mem0's own paper reports their graph variant at +1.56 J overall for 3.3x search
  latency over their flat store.
- On Mem0's own LoCoMo table, full-context (72.90) beats every memory system
  including their graph variant (68.44).
- CodeSearchNet's human-annotated relevance set ranks a bag-of-words model above
  self-attention, because rare identifiers dominate code retrieval.
- The entire 97-entry bible is ~9,575 tokens and fits in a single prompt.

Do NOT add Porter stemming as a fix for the camelCase infix gap. Measured against
FTS5's actual porter tokenizer: `parser` and `parsing` do not match each other,
while `generic` matches `generator`, and `serializer` stems to `serial`. Also
`tokenize='porter trigram'` is accepted and silently corrupts the index.
