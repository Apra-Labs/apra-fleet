# Phase 3 Review -- Code Intelligence Power Sprint

Reviewer: pm-reviewer
Scope: Phase 3 commits e353104 (T3.1 auto-reindex module), 240a407 (T3.2 wiring +
note suffix), 31ce483 (T3.3 P4a code_context KB enrichment). Files:
src/tools/code-intelligence-reindex.ts (new), src/tools/code-intelligence-kb-enrich.ts
(new), src/tools/code-intelligence-freshness.ts, src/tools/code-intelligence-gitnexus.ts,
src/index.ts, and tests (code-intelligence-reindex.test.ts, code-intelligence-kb-enrich.test.ts,
code-intelligence-freshness.test.ts, code-intelligence.test.ts).
Sources: PLAN.md (T3.1-T3.4), requirements.md (P3, P4a), design.md (D3, D4),
progress.json. KB primed (session_warm); CONFIRMED entries on callGitNexus
resilience/freshness, the circular-import rule, and D4 layering trusted.
Structural checks via code_impact/code_context (not grep).

## Verdict: APPROVED

All three tasks implement the binding design exactly. The load-bearing safety
property -- none of reindex-scheduling, freshness-suffix, or KB-enrichment can
make a code_* call throw, block, or return degraded core content when its
subsystem fails -- holds on every traced path.

Counts: 0 HIGH, 0 MEDIUM, 2 LOW. No blocking findings.

## Checklist verification

1. T3.1 D3 auto-reindex -- PASS. code-intelligence-reindex.ts imports only
   child_process, fs, os, path, and log-helpers -- NO import from
   code-intelligence.ts (circular-import rule honored, mirrors the freshness
   precedent). shouldStartReindex(entry, now, cooldownMs=120000) is a pure
   exported fn: no timers, no IO; running -> false, within-cooldown -> false,
   past-cooldown -> true, undefined entry -> true. maybeScheduleReindex spawns
   `npx gitnexus analyze` detached ({cwd, detached:true, stdio:['ignore',
   'ignore','pipe'], shell: process.platform==='win32'}), unref'd, never awaited;
   returns a synchronous boolean. State is set to runningChild on spawn and
   cleared to { lastFinishedAt } on both 'exit' and 'error'; the prior
   lastFinishedAt is preserved while a child runs. enabled:false -> no-op;
   cooldownMs override read from config. Entire body wrapped in try/catch that
   logs and returns false, plus an inner try/catch around spawn -- never throws.
   Windows shell flag correct.

2. T3.2 wiring + suffix -- PASS. computeFreshnessNote detects divergence via
   freshnessNote(...) !== null and, only when diverged, calls
   maybeScheduleReindex(repo) inside its own try/catch (logError on throw,
   reindexScheduled falls back to false); the whole function is additionally
   wrapped in try/catch returning null. maybeScheduleReindex is synchronous and
   non-blocking, so no tool-call latency is added and no failure can reach the
   result. The exact suffix " A background re-index has been started." (leading
   space) is appended by freshnessNote only when reindexScheduled is true.
   freshnessNote stays pure -- reindexScheduled is just a defaulted parameter,
   no IO. code_impact confirms maybeScheduleReindex has exactly one caller
   (computeFreshnessNote -> callGitNexus): a single trigger point, fire-and-
   forget, off the critical path.

3. T3.3 D4 code_context KB enrichment -- PASS. New code-intelligence-kb-enrich.ts
   imports only getKbProviders; the gitnexus provider file imports neither the KB
   service nor kb-enrich (no src/tools <-> src/services cycle). enrichContextWithKb
   is imported ONLY by the code_context handler in src/index.ts; other code_*
   handlers are untouched. isErrorResult(result) is checked FIRST -- error results
   are passed through and the KB is never queried. Matches filter to
   confidence==='CONFIRMED' && Array.isArray(symbols) && symbols.includes(name)
   (exact match). Block format is exact: "[knowledge-bank] N confirmed entries for
   <name>:" then one "- <title> -- <summary sliced to 120>" line per entry. Zero
   matches -> result returned unchanged (no block). The whole body is wrapped in
   try/catch -> any KB error (getKbProviders or query throwing) returns the result
   unchanged, never failing the call. appendTextBlock preserves the content-array
   shape and returns the result unchanged for unexpected shapes.

4. Safety property (load-bearing) -- PASS. Reindex: synchronous spawn wrapped in
   nested try/catch, never awaited, never throws; a spawn failure logs and returns
   false. Freshness suffix: computeFreshnessNote is doubly guarded and returns
   null on any error, so a scheduling failure degrades to "no suffix" (or "no
   note"), never a thrown/error tool result -- verified by the "schedule throws"
   test asserting the note is still appended without the suffix and logError fires.
   KB enrichment: try/catch returns the un-enriched provider result on any KB
   failure, and error provider results skip the KB entirely. No path can corrupt
   or block the core response.

5. Tests meaningful -- PASS. reindex: shouldStartReindex pure unit across all 5
   branches (running/within-cooldown/past-cooldown/undefined/custom-cooldownMs);
   spawn-args correctness incl. platform-dependent shell flag; single-flight (two
   calls -> one spawn); enabled:false no-op; custom cooldownMs from config blocks
   a second call after the first finishes; non-zero-exit stderr-tail logWarn;
   spawn-throws never propagates. freshness: suffix on/off/default and null-when-
   SHAs-match, all exact-string. code-intelligence.test.ts: divergence+decline ->
   no suffix + called once with repo; divergence+true -> suffix; schedule throws
   -> result unaffected + logError; no-divergence -> maybeScheduleReindex never
   called. kb-enrich: append (N=2, 120-char truncation verified against the
   untruncated string); no-append x3 (zero results, symbols-not-containing-name,
   non-CONFIRMED); error x2 (getKbProviders rejects, query rejects) returning the
   original; error-result pass-through verified to skip the KB query. Module-state
   suites (reindex, kb-enrich) use vi.resetModules() + dynamic import + vi.hoisted
   mock factories per KB constraint 1; the gitnexus-wiring suite reuses the file's
   existing vi.hoisted pattern (stateless mapping under test), consistent with the
   Phase 2 review note.

6. Build + tests -- PASS. `npm run build` (tsc) exit 0. `npm test`: 1715 passed,
   2 failed, 14 skipped. The 2 failures are ONLY the known pre-existing timezone
   tests in tests/time-utils.test.ts (yashr-302). The four Phase 3 suites are
   green (reindex 11, kb-enrich 7, freshness 11, code-intelligence 45).

7. ASCII sweep -- PASS. All new/changed Phase 3 files are byte-scanned ASCII-clean;
   the Phase 3 added lines in gitnexus.ts and index.ts introduce no non-ASCII (the
   pre-existing UNICODE_ARROW_PATTERN and test fixtures predate this phase and are
   permitted by the enforced pre-commit hook, per the Phase 2 review).

## Findings (all LOW / non-blocking)

1. LOW -- computeFreshnessNote calls the pure freshnessNote() twice: once as the
   divergence predicate (`freshnessNote(...) !== null`) and once for the final
   return with reindexScheduled. freshnessNote is pure and cheap, so this is a
   readability/redundancy note only, no correctness impact. Could compare
   meta.lastCommit !== head directly for the predicate.

2. LOW -- KB enrichment appends raw entry.title / entry.summary to the code_context
   response text without ASCII-sanitizing, whereas the sibling code_map/code_flow
   paths run asciiSanitizeLabel over gitnexus-sourced label text before emitting it.
   KB content is authored under the same ASCII-only project convention so the
   practical risk is low, and this is runtime MCP output (not a file write), but a
   defensive sanitize would make the code-intelligence response surface uniformly
   ASCII. Non-blocking.

## Summary

APPROVED. 0 HIGH, 0 MEDIUM, 2 LOW. T3.1's reindex module is correctly isolated
from code-intelligence.ts, single-flight + cooldown are enforced by a pure
decision function, and the spawn path never throws. T3.2 wires scheduling into
the single per-call divergence trigger point, fire-and-forget and doubly guarded,
with the exact suffix only when a reindex actually started. T3.3 places KB
enrichment one layer above the provider (no service cycle), enriches only
successful code_context results with CONFIRMED exact-symbol matches, and degrades
to the un-enriched result on any KB error. The load-bearing safety property holds
on every path. Build clean; only the known yashr-302 timezone tests fail. Both
findings are cosmetic/defensive.
