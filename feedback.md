# Re-Review -- In-Flight KB Capture (epic yashr-auh, lightweight sprint)

Reviewer: pm-reviewer. Branch feat/code-intelligence-abstraction (base main).
Round 1 (verdict CHANGES NEEDED: 1 HIGH, 1 MEDIUM, 2 LOW) is preserved in this
file's git history (commit c015535). This round re-reviews the fix commit
df31631 against Round 1's HIGH-1 and MEDIUM-1; LOW-1 and LOW-2 were left
unaddressed per PM instruction and are carried forward below.

## VERDICT: APPROVED

0 HIGH, 0 MEDIUM, 2 LOW (both carried forward from Round 1, informational,
explicitly deferred by the PM). The single blocker is fixed exactly as
prescribed and verified end-to-end; the MEDIUM residual-risk mitigation was
also implemented. Build clean; full suite 1989 passed / 6 failed with the 6
EXACTLY the allowed set (2 time-utils yashr-302 + 4 kb-session-prime
graph-neighbor yashr-bwc); ASCII sweep of df31631's added lines clean; main
untouched.

## HIGH-1 (kb_query rejected the curator's tag-only Step 2 call) -- FIXED, VERIFIED

- Guard relaxed to the exact prescribed shape: kb-query.ts:23-25 now reads
  `if (!input.query && !input.flagged_only && !input.tag)`, with a comment
  citing the HIGH-1 rationale (provider's plain non-FTS branch supports
  queryless listing; the KB Agent curator's Step 2 depends on it). The error
  message names all three acceptable inputs.
- Schema + descriptions updated: the `query` description now says "Required
  unless flagged_only is true or tag is provided"; the `tag` description and
  the index.ts kb_query tool description both state the tag "may be used alone
  (no query) to list all entries carrying the tag".
- Tests: 2 new tool-layer tests. (a) `kbQuery({ tag: 'phase:1' })` -- no query
  -- is accepted, returns ONLY the tagged entry, and asserts the returned entry
  carries its `tags` array including the sprint tag, which is precisely what
  the curator's client-side sprint+phase intersection needs. (b) `kbQuery({})`
  still rejects (regression guard on the empty call). Both pass; kb-query.test.ts
  + kb-list.test.ts together: 28/28 passed. No other test referenced the old
  error message, so nothing else was invalidated.
- End-to-end verification of the curator's Step 2 call path: exercised the
  built provider (dist) with the exact documented call shape -- tag 'phase:1',
  include_stale: true, limit 100, no query -- against a KB seeded with two
  sprint:kb-inflight-capture+phase:1 entries, one sprint:other+phase:1 entry,
  and one untagged entry. Result: exactly the 3 phase:1 entries returned, ALL
  carrying their full tags array, and the client-side intersection on
  'sprint:kb-inflight-capture' yields exactly the 2 in-flight entries. The
  tpl-kb-agent.md Step 2 -> Step 3 pipeline is now executable as documented.

## MEDIUM-1 (unvalidated INFERRED captures become retrieval-trusted) -- MITIGATED

All three role templates (tpl-planner.md, tpl-doer.md, tpl-reviewer.md) gained
the calibrated trust line: trust CONFIRMED fully; treat INFERRED as a strong
hint but verify against source when correctness matters, because an INFERRED
entry may now be an unvalidated in-flight capture. This directly closes the
"trust INFERRED and skip the source read" amplification identified in Round 1:
the CONFIRMED gate was never breached, and now the retrieval side no longer
extends full trust to un-curated INFERRED content. The remaining KB-noise
growth (the "left Z" bucket accumulating) is inherent to the design and
bounded by dedupe-first + curator flagging; acceptable.

## TRUST RE-CHECK (unchanged from Round 1, re-confirmed on df31631): NO HOLE

df31631 touches only the tool guard, descriptions, tests, and template trust
wording -- no capture, promote, or directive path. The clamp still caps every
kb_capture at INFERRED; CONFIRMED is still minted only by kb_promote, which
only the KB Agent calls, only on APPROVED-verdict-validated entries;
user-directive activation remains human-CLI-only (kb_promote refuses
directives; default retrieval excludes pending proposals). The tag-only query
path is read-only and mints nothing. Gate intact.

## Carried-forward findings (deferred by PM, non-blocking)

LOW-1 (minor, from Round 1). Step 2's `include_stale: true` also flips
`include_superseded` true (kb-query.ts ties the two), so a superseded in-flight
capture can appear in the curation set. Step 3's dedupe handles it. Cosmetic.

LOW-2 (operational, from Round 1). The dispatch blocks carry literal
`['sprint:<sprint>', 'phase:<phase>']` placeholders; the PM assembly must
substitute concrete values on both the capture side and the KB Agent's
{{sprint_name}}/{{phase}} query side, or tags will not match. Verify in the
first live run of this flow.

## EVIDENCE

- npm run build: CLEAN (tsc, exit 0).
- kb-query.test.ts + kb-list.test.ts isolated: 28 passed, 0 failed (includes
  the 2 new HIGH-1 tests).
- npm test (full suite): 1989 passed, 6 failed, 14 skipped. The 6 are EXACTLY
  the allowed set: time-utils.test.ts x2 (toLocalISOString, yashr-302) +
  kb-session-prime.test.ts x4 (all in "graph-neighbor expansion", yashr-bwc).
  No new failures; +2 passed vs Round 1 (the two new tests).
- End-to-end Step 2 curator call: PASS (see HIGH-1 section; scratchpad script
  against dist/services/knowledge/sqlite-provider.js, temp DB).
- ASCII sweep of df31631's added lines: CLEAN, zero non-ASCII hits.
- Main untouched; no PR raised.
