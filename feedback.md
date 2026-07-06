# Phase 2 Review -- KB Integrity Sprint (freshness + retrieval: F4, F3, F5)

Reviewer: pm-reviewer. Scope: Phase 2 commits e06206a (T2.1 OR-join across 4
sites + F2 cross-type e2e), 6da266e (T2.2 staleness), 480103a (T2.3 provenance).
Binding: design.md D3/D4/D5/D7 (as revised in b97ee58), requirements F3/F4/F5,
PLAN.md T2.1-T2.4. Verified against source, a clean tsc build, and a full test
run (1808 passed, only the 2 allowed yashr-302 timezone failures).

## Verdict: APPROVED

All three work tasks implement their revised binding decisions correctly and at
the right altitude. Build clean (tsc). Full suite: 1808 passed, 14 skipped, only
the 2 pre-existing yashr-302 timezone failures in tests/time-utils.test.ts
(explicitly allowed) fail -- NO regressions, and specifically none from the
OR-join breadth change or the new source_file_hashes column. Knowledge suite: 25
files, 152 tests, all green. One LOW finding carried forward from Phase 1; one
INFO (pre-existing non-ASCII). Neither blocks Phase 3.

## Checklist confirmation

### 1. T2.1 OR-join at ALL FOUR sites (D4) -- CONFORMS

- ONE shared exported helper orJoinFtsTerms (audn.ts) is applied at every site:
  (1) makeFtsQuery (audn.ts) now `orJoinFtsTerms(tokens)`; (2) prime()
  searchTerms (sqlite-provider.ts:648) `orJoinFtsTerms(searchTerms)`; (3)
  neighbor batch (kb-session-prime.ts:136) `orJoinFtsTerms(neighbors)`; (4)
  global-append (kb-session-prime.ts:78) `orJoinFtsTerms(searchTerms)`. The
  local ftsSafeTerm duplicate in kb-session-prime.ts was removed and now imports
  from audn.ts. No hand-rolled joins remain.
- Each term stays ftsSafeTerm-quoted: ftsSafeTerm extracts `[A-Za-z0-9_]+`
  tokens and wraps EACH in double quotes, dropping everything else. A symbol
  carrying quotes, parens, colons, hyphens, slashes, dots, or a reserved FTS5
  operator (AND/OR/NOT/NEAR) cannot break out of the quoted phrase -- no FTS5
  injection. A term that sanitizes to nothing is dropped, not left to throw
  (unit-tested: `orJoinFtsTerms(['((', 'goodName']) === '"goodName"'`).
- Single-term behavior unchanged: `orJoinFtsTerms(['alpha']) === '"alpha"'`
  (no OR keyword introduced) -- unit-tested, plus a single-term prime regression
  test.
- Ranking preserved and OR breadth does NOT flood output: query() (line 490-499)
  builds `... WHERE entries_fts MATCH ? <filters> ORDER BY rank LIMIT ?`. The OR
  only widens which entries are ELIGIBLE; output is still bounded by LIMIT
  (prime passes limit:10; query default 20) and ordered by FTS5 bm25 `rank`, so
  the most-relevant entries surface first and the count is capped exactly as
  before. include_stale / l1_only filters are untouched. CRITICAL cleared:
  OR-join cannot flood results or break the limit.

### 2. T2.1 F2 cross-type e2e (D2 x D4) -- CONFORMS

- kb-fts-orjoin.test.ts captures entry A ("code_graph is broken", type
  'knowledge', no shared file) then entry B ("code_graph now works, fixed via
  cypher CALLS", type 'learning' -- CROSS-TYPE, same symbols, different
  source_file); asserts B.audn_decision === 'flagged', B.contradiction_of ===
  A.id, and A.flagged_for_review === true. Matches D2/PLAN exactly.
- Genuinely failed pre-T2.1: doer verified via git-stash (progress notes T2.1),
  and the mechanism confirms it -- pre-T2.1 makeFtsQuery AND-joined B's title
  tokens, so findAudnCandidates required A to contain ALL of "code_graph now
  works fixed cypher CALLS"; A ("code_graph is broken") does not, so A was never
  a candidate -> 'add'. Post-T2.1 OR-join makes A a candidate on the shared
  "code_graph" token -> makeAudnDecision flags. T1.4 alone (type filter removed)
  was insufficient because the AND-join still blocked FTS discovery -- exactly
  the integration the test proves.
- No over-flagging of legitimate cross-type same-symbol refinements: the
  contradiction path (audn.ts:120-138) fires only on symbolsOverlap AND a
  contradiction signal (CONTRADICTION_KEYWORDS OR hasOppositePolarity). A
  same-symbol cross-type entry with NO signal falls through `continue` (audn.ts
  DEDUP/UPDATE gate re-imposes same-type) and becomes a plain 'add' -- covered
  by T1.4's "no-signal -> not flagged" and "cross-type same-file no-signal ->
  no update" tests, still green. The OR-join surfaces more CANDIDATES but the
  signal gate, not discovery, decides flagging, so broader discovery does not
  translate into broader flagging of refinements. (Residual: LOW 1 below.)

### 3. T2.2 staleness (revised D3) -- CONFORMS; CRITICAL cleared

- source_file_hashes additive column added via the same try/catch ALTER TABLE
  pattern as scope (init, line ~157); existing rows default '{}' -- no
  migration.
- capture() persists the basis for ALL types: computeSourceFileHashes(
  input.source_files) is computed once in capture() (the single choke point) and
  threaded through insertEntry in the add, flagged, AND update branches. Files
  that do not resolve are simply absent from the map (not an error).
- checkFreshness is bounded to the primed set: it filters to entries WITH
  source_files, reads their stored basis, unions the basis files, and runs ONE
  computeFileHashBatch over that union -- never the whole KB. Changed/missing
  basis files -> stale=1 (one UPDATE) + dropped from top_entries.
- Empty-basis entries are never falsely stale: basisById is populated only for
  entries whose parsed basis has > 0 keys; a malformed basis is caught and
  treated as no basis; `basisById.size === 0` short-circuits. Historical rows
  (basis '{}') are untouched. Test (c) proves an entry with no source_files is
  untouched even when unrelated files change.
- Non-fatal + cannot slow/throw prime (CRITICAL): the checkFreshness call in
  prime() (line ~665) is wrapped in try/catch that degrades to exactly today's
  top_entries on any error (test (b) forces the hash batch to throw -> entry
  still present, stale stays false). Work is bounded to primed files, so it
  cannot scan the whole KB.
- MISSING-FILE SEMANTICS confirmed as intended (answer b): computeFileHashBatch
  returns `null` for a path that no longer exists (file-hash.ts:52-54). In
  checkFreshness the check is `if (!current || current.hash !== basis[file])`,
  so a now-missing basis file (current === null) is treated as CHANGED ->
  entry marked stale. This matches revised D3 ("basis file now missing ->
  stale"); it is NOT treated as unknown/fresh.

### 4. T2.3 provenance (D5 + D7) -- CONFORMS

- types.ts: `Author = 'doer'|'reviewer'|'planner'|'plan-reviewer'|'kb-agent'|
  'harvest'|'pm'|'user'` and `CaptureSource = 'session'|'review'|'harvest'|
  'promotion'|'user-directive'|'unknown'`. The 'harvest' Author addition beyond
  D5's literal list is documented in the type comment AND recorded as a
  deviation in progress.json T2.3 notes -- acceptable per revised D7 / LOW
  finding 6.
- Tool-layer stamping: validateAuthor(role) checks the hint against
  AUTHOR_VALUES and returns 'unknown' on any invalid or absent value -- never a
  free string (tests: valid role -> stamped; invalid -> 'unknown'; absent ->
  'unknown'). source is DERIVED by the handler, never the caller: reviewer role
  -> 'review'; the D6 user-directive raw-string exemption -> 'user-directive';
  else 'session'. promote() stamps source='promotion' on the promoted row
  (test: source='promotion' after promote). kb-harvest.ts stamps author
  'harvest' + source 'harvest', confidence untouched (UNVERIFIED) -- test
  asserts all three.
- zod tightened so callers cannot inject: the free-string `author` and the
  `source` enum params were REMOVED from kbCaptureSchema and replaced with a
  `role` hint that is validated server-side. There is no schema path for a
  caller to place an arbitrary string into the stored author/source columns.
- Tolerant reads, no migration: KBEntry.source is `CaptureSource | string`,
  author stays `string`; a row written with legacy 'Knowledge Agent' /
  'kb_agent_harvest' reads back verbatim (test passes) -- no row rewritten.

### 5. Build + tests -- PASS

- `npm run build` (tsc): clean, no errors. kb-harvest.ts compiles against the
  new unions.
- `npx vitest run`: 1808 passed, 14 skipped; the only failures are the 2
  pre-existing yashr-302 timezone tests in tests/time-utils.test.ts (allowed).
  No test regressed from the OR-join breadth change or the new column. Knowledge
  suite (25 files / 152 tests) fully green.

### 6. ASCII in changed files -- PASS (Phase 2 changes clean)

- Every Phase 2 edit is ASCII clean, including the promotion-note conversion to
  string concatenation (per the ASCII-hook gotcha) and the changed src/index.ts
  kb_harvest description line ("author=harvest, source=harvest").
- See INFO 2: the non-ASCII bytes present in src/index.ts are all on lines NOT
  touched by Phase 2 (pre-existing em-dashes/arrows, already noted in the Phase
  1 review INFO 3).

## Findings

### LOW 1 -- hasOppositePolarity substring matching (carried forward from Phase 1)

audn.ts POLARITY matching uses `String.includes` on short tokens including
'fixed' and 'resolved', which collide with superstrings ('prefixed',
'suffixed', 'unresolved'). Phase 1 flagged this as LOW. Phase 2 does not touch
the polarity logic, but the T2.1 OR-join now surfaces MORE symbol-overlap
CANDIDATES into findAudnCandidates, so the substring false-positive vector has
marginally more surface area to fire on. Impact remains bounded: it still
requires symbol overlap AND opposite-polarity text, and the consequence is a
review flag (new entry -> UNVERIFIED, old -> flagged_for_review), not data loss
or supersession. Recommend word-boundary matching (or dropping the bare
'fixed'/'resolved' tokens in favor of the phrase forms) in a follow-up.
Non-blocking.

### INFO 2 -- pre-existing non-ASCII in src/index.ts (out of scope, unchanged)

src/index.ts carries em-dashes on lines 28, 137, 186, 210, 273, 274, 307 -- all
pre-existing, none touched by Phase 2 (the only Phase 2 edit to this file is the
kb_harvest description, which is ASCII clean), and outside the no-migration
scope. Identical to the Phase 1 INFO 3 note. Not a Phase 2 defect.

## Summary

APPROVED. Findings: 0 HIGH, 0 MEDIUM, 1 LOW (carry-forward) + 1 INFO. Freshness
and retrieval are real and correctly scoped:

(a) OR-JOIN BREADTH DOES NOT HARM RELEVANCE OR THE LIMIT. The shared
orJoinFtsTerms is applied at all four implicit-AND sites with each term still
ftsSafeTerm-quoted; single-term behavior is unchanged. query() still orders by
FTS5 bm25 `rank` and caps at LIMIT (10 at prime, 20 default), so the OR only
widens eligibility -- the most-relevant entries still surface first and the
returned count is bounded exactly as before. No flooding.

(b) MISSING-FILE STALENESS SEMANTICS: a basis file that is now missing is
treated as CHANGED -> the entry is marked stale=1 and dropped from top_entries
(computeFileHashBatch returns null for a missing path; checkFreshness's
`!current` branch reads that as changed). This matches revised D3's intended
semantics ("basis file now missing -> stale"); it is NOT treated as
unknown/fresh. The whole freshness check is bounded to the primed set and
wrapped in try/catch, so it can neither slow nor throw prime.

Build clean; suite green modulo the allowed timezone failures. Ready for Phase 3.
