# Phase 1 Review -- Code Intelligence Power Sprint

Reviewer: pm-reviewer
Scope: Phase 1 commits 5e29169 (T1.1 spike), b01bd97 (T1.2 spike),
495a676 (T1.3 P4b). Focus: T1.3 code (src/tools/kb-session-prime.ts +
tests/knowledge/kb-session-prime.test.ts). Spikes sanity-checked for presence
and internal consistency.
Sources: PLAN.md (T1.1-T1.4), requirements.md (P4b), design.md (D1, D4),
progress.json, code_impact/code_context on the changed wrapper.

## Verdict: APPROVED

T1.3 meets every binding item of design D4 and the review checklist. The key
safety property (prime never throws and never returns degraded output when the
graph/CI side fails) holds on every code path I traced. Build clean; full suite
1667 passed with only the 2 known pre-existing timezone failures
(tests/time-utils.test.ts, yashr-302). One MEDIUM finding is a plan-inherited
effectiveness limitation, not a safety or correctness regression; it does not
block Phase 1.

Counts: 0 HIGH, 1 MEDIUM, 3 LOW.

## Findings

1. MEDIUM -- Multi-neighbor batch query uses FTS5 implicit-AND, so expansion
   rarely surfaces entries once there are 2+ distinct neighbors.
   SqliteProvider.query() (src/services/knowledge/sqlite-provider.ts:379-388)
   passes opts.query verbatim into `entries_fts MATCH ?` with no OR rewrite.
   ftsSafeTerm produces quoted phrases (`"nbrA"`) and the neighbors are joined
   with a single space (kb-session-prime.ts:138-141), so the batch becomes
   `"nbrA" "nbrB" ...`, which FTS5 treats as AND -- an entry must contain ALL
   neighbor tokens to match. In the common case (2+ unrelated neighbor names)
   the batch returns nothing and no entries are ever appended, so the feature
   under-delivers on its P4b intent ("surface additional relevant entries").
   This is plan-specified (PLAN.md T1.3 step 3 says `neighbors.join(' ')`) and
   is fully SAFE -- it only ever yields fewer additions, never a throw or
   degraded output -- so it is non-blocking. Recommended follow-up (backlog):
   OR-join the sanitized terms (e.g. `.join(' OR ')`) so the batch surfaces
   entries relevant to ANY neighbor. Single-neighbor and shared-token cases
   already work today.

2. LOW -- Embeddings doc line-3 wording is internally inconsistent with its own
   evidence. docs/code-intelligence-embeddings.md line 3 parenthetical calls the
   model "bundled", but Evidence section 3 (lines 73-87) states "The model is
   NOT bundled in the package; it is fetched from HuggingFace on first use"
   (~87 MB one-time download). The LOCAL classification itself is correct and
   well-evidenced (local ONNX, no API key, offline after first fetch, --embeddings
   flag exists on 1.6.7); only the "bundled" adjective is loose. Cosmetic; does
   not mislead T2.3, which reads the flag + download caveat correctly.

3. LOW -- parseContextNeighbors harvests BOTH incoming.calls and outgoing.calls
   (kb-session-prime.ts:46). Requirements P4b says "depth 1"; taking callers and
   callees is depth-1 in both directions, which is a reasonable and generous
   reading (the T1.1 surface doc lines 90-92 confirm both arrays carry parseable
   names). Recording it only so the choice is explicit; matches the plan's
   "impact/context, depth 1" latitude. No change required.

4. LOW -- Minor: the neighbor-expansion merge does not filter appended entries by
   type, unlike the global-append block just above it (which filters
   `type === 'knowledge'`, line 93). This is plan-compliant (PLAN.md T1.3 step 4
   specifies only id-dedupe + via marker + cap, no type filter) and dedupe/cap
   keep the output bounded, so it is not a defect -- noted only for symmetry
   awareness if a type filter is later desired.

## Checklist verification (T1.3, design D4 binding)

1. Expansion location -- PASS. `git diff 6671ec6..495a676 -- src/services/knowledge/`
   is empty: SqliteProvider.prime and HttpKbProvider.prime are byte-unchanged.
   All expansion lives in src/tools/kb-session-prime.ts, one layer up (D4).

2. CI surface + defensive parse -- PASS. Uses `getProvider().context({ name })`
   (kb-session-prime.ts:112,123), NOT provider.graph (T1.1 doc confirms
   graph -> call_graph is broken on gitnexus 1.6.7). parseContextNeighbors
   returns [] on isError, non-object result, missing/non-array content, no text
   block, unparseable JSON, and ambiguous-candidate responses (verified against
   a live context call: `incoming` can be `{}` and is handled). Never throws.

3. Caps -- PASS. NEIGHBOR_CAP=10 and ADDED_ENTRY_CAP=5 are exported consts
   (lines 17,19). Guards use `>=` BEFORE push in both loops (lines 120,128,156),
   so no off-by-one. Tests assert exactly 10 quoted terms from 11 neighbors and
   exactly 5 additions from 8 candidates.

4. Merge -- PASS. existingIds seeded from `result.top_entries` (line 153), which
   at that point already includes both prime's direct hits AND the appended
   globals -> dedupe covers both. Each addition gets `via: 'graph-neighbor'`
   (line 159); additions are appended AFTER direct hits (line 162), so they rank
   strictly below; capped at ADDED_ENTRY_CAP. Tests confirm order [direct...,
   neighbors...], via marker only on neighbors, and dedupe against direct hits.

5. Graceful skip (KEY SAFETY PROPERTY) -- PASS. The entire expansion is inside
   one try/catch (lines 111-168) whose catch is a no-op, leaving `result`
   exactly as prime returned it. getProvider() is inside the try, so a provider
   throw is caught. Per-symbol context() calls have their own inner try/catch
   (continue on throw). The KB neighbor query and merge are inside the outer try.
   Skips entirely when hint_symbols is empty/absent (line 110 guard). I could
   find no path that makes prime throw or emit error text when the CI/graph side
   fails. Tests cover getProvider-throws and context-throws-for-every-symbol,
   both yielding output identical to non-expanded prime.

6. FTS-safety -- PASS. ftsSafeTerm tokenizes on [A-Za-z0-9_]+ and quotes each
   token; names with no usable token return null and are filtered out
   (lines 138-141), so one FTS-hostile neighbor degrades to skipping that
   neighbor, not killing the batch. Test "FTS-hostile neighbor is skipped"
   confirms `((` drops out while `goodName` survives as `"goodName"`. (See
   finding 1 for the separate AND-semantics effectiveness note.)

7. Tests meaningful -- PASS. 13 tests, all green. Real over-limit inputs for
   both caps, dedupe against direct hits, via marker + below-direct ranking,
   both graceful-skip paths (getProvider throws; context throws), isError
   result, FTS-hostile neighbor, and hint_symbols-absent skip. KB constraint 1
   honored: vi.hoisted() mock fns, vi.mock factories, vi.resetModules() +
   dynamic import at the start of each expansion test.

8. Build + tests -- PASS. `npm run build` (tsc) exit 0.
   `npx vitest run tests/knowledge/kb-session-prime.test.ts` 13/13 pass. Full
   `npx vitest run`: 1667 passed, 2 failed, 14 skipped -- the 2 failures are
   ONLY the known pre-existing timezone tests in tests/time-utils.test.ts
   (yashr-302). Matches T1.4 progress.json note.

9. ASCII -- PASS. No non-ASCII bytes in kb-session-prime.ts,
   kb-session-prime.test.ts, or either spike doc.

## Spike sanity check

- T1.1 (docs/code-intelligence-child-surface.md): present, internally
  consistent. 13-tool inventory, three capability sections each ending in an
  explicit ladder rung, and a Decisions table whose rungs match the section
  conclusions (communities -> rung 2 compose via cypher; flows -> rung 2 compose
  via cypher; upstream-for-tests -> rung 1/2 direct impact + isTestPath filter).
  Documents the call_graph-broken-on-1.6.7 finding that justifies T1.3 using
  context. Consistent with progress.json T1.1 note.
- T1.2 (docs/code-intelligence-embeddings.md): present. Classification LOCAL on
  line 1, evidence + cost sections complete, consistent with progress.json T1.2
  note. One cosmetic wording inconsistency (finding 2).

## Summary

APPROVED. 0 HIGH, 1 MEDIUM, 3 LOW. The MEDIUM is a plan-inherited FTS AND-vs-OR
effectiveness limitation that never compromises safety or correctness and is a
clean backlog follow-up. The load-bearing safety property is airtight, tests are
substantive and green, providers are untouched, and both spikes are present and
self-consistent.
