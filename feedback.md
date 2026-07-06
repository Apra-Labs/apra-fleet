# Plan Review -- KB Integrity Sprint (PLAN.md @ e46c1ee)

Reviewer: pm-plan-reviewer. Scope: PLAN.md vs requirements.md (F1-F8) and
design.md (D1-D8), with the planner's recorded ambiguity resolutions verified
against source (src/tools/kb-capture.ts, src/tools/kb-promote.ts,
src/tools/kb-session-prime.ts, src/tools/kb-harvest.ts,
src/services/knowledge/sqlite-provider.ts, src/services/knowledge/audn.ts,
src/services/knowledge/types.ts, src/index.ts, src/tools/execute-prompt.ts).

## Verdict: CHANGES NEEDED

The plan is strong: full F1-F8 coverage, correct risk ordering, sound
shared-file sequencing, exact models on every work task, complete VERIFY
recipes, and all three critical code-location resolutions are CORRECT
(verified against source, section "Resolution validation" below). But one
task rests on a factually false claim about the codebase (kb_harvest IS
auto-dispatched today), and four task specs have gaps that would send doers
into unplanned territory or ship features that under-deliver their audit
finding. These need plan edits, not re-architecture.

## Findings

### 1. HIGH -- T3.2 (F7/D7): kb_harvest is NOT undispatched -- execute-prompt.ts auto-fires it on every successful prompt

T3.2 states "Its behavior may remain as-is; nothing dispatches it" and D7
assumes the tool is vestigial. False: src/tools/execute-prompt.ts lines
323-330 auto-dispatches kbHarvest (fire-and-forget,
`void import('./kb-harvest.js')` with `session_transcript: parsed.result`)
after every successful execute_prompt. Consequences:

- If T3.2 only edits templates/descriptions, harvest remains an ACTIVE,
  silent capture path writing UNVERIFIED regex-extracted entries into the KB
  on every prompt -- directly against F7's "KB-Agent direct capture is the
  sole documented capture path" and the sprint's trust-model intent.
- If the doer removes the auto-wire, tests/knowledge/kb-harvest-autowire.test.ts
  FAILS (it asserts the wiring strings exist in execute-prompt.ts), directly
  contradicting T3.2's "no test churn beyond registration" instruction.

Required change: T3.2 must add src/tools/execute-prompt.ts and
tests/knowledge/kb-harvest-autowire.test.ts to its file list, decide
explicitly (recommend: remove the auto-wire and update/retire the autowire
test; record the decision in progress.json notes since D7's premise was
wrong), and adjust its done criteria accordingly.

### 2. MEDIUM -- T3.1 (F6/D6): the "agent capture gets flagged instead" test cannot pass as specified -- findAudnCandidates filters by type

findAudnCandidates (sqlite-provider.ts lines 231-248) restricts candidates
with `AND e.type = ?` (the input's type). An agent capture
(type='learning'/'knowledge') will therefore NEVER retrieve a
type='user-directive' candidate, so the makeAudnDecision supersede-guard
T3.1 specifies is unreachable end-to-end, and the specified provider-level
test ("old entry keeps superseded_at IS NULL and gets flagged instead")
fails even after a correct guard implementation. T3.1 must also widen
candidate discovery (e.g. findAudnCandidates additionally returns
user-directive candidates regardless of input type, or drops the type
filter for the contradiction path) and say so -- otherwise the doer
discovers this mid-task on the integrity-critical capture path.

### 3. MEDIUM -- T2.1 (F4/D4): a fourth implicit-AND query site is missed -- the global-append query in kb-session-prime.ts

T2.1 correctly identifies three sites (makeFtsQuery; prime()'s
searchTerms.join(' ') at sqlite-provider.ts line 536; the neighbor batch
join at kb-session-prime.ts line 141). But kb-session-prime.ts lines 83-91
build a FOURTH FTS query for the GLOBAL provider:
`input.session_files?.join(' ') ?? input.hint_symbols?.join(' ')`. Same
implicit-AND failure for multi-symbol primes, plus raw file paths ('/',
'.') are FTS5-hostile and likely throw into the silent catch -- so the
global-knowledge append is broken for exactly the multi-hint case F4 fixes.
T2.1 should sanitize (ftsSafeTerm) and OR-join this site too, with a test.
Without it, F4's done criterion "multi-term prime returns relevant entries"
is only half true for kb_session_prime's actual output.

### 4. MEDIUM -- T2.2 (F3/D3): auto-staleness at prime is a near-no-op for the entries prime actually surfaces

T2.2 (correctly) skips entries with empty content_hash, but content_hash is
only ever set for type='context-cache' with source_file (kb-capture.ts lines
37-43), and prime()'s top_entries explicitly EXCLUDE context-cache
(sqlite-provider.ts line 542, `filter(e => e.type !== 'context-cache')`).
Net effect: checkFreshness over top_entries candidates will skip nearly
every entry, and the audit finding it targets ("0 entries stale across 2+
weeks of code change") remains effectively unfixed in production. The task
acknowledges the skip but not its consequence. Required: T2.2 must state at
least one of (a) stale-mark entries whose source_files no longer exist
(detectable without a hash baseline), (b) persist stale=1 for the
context-cache entries that prime's context(session_files) pass already
detects as hash-stale (today it only reports them), or (c) an explicit
recorded limitation in the done criteria + docs/kb-trust-model.md so the
sprint does not claim the audit finding closed. (a)+(b) are small and stay
within D3's bounded/non-fatal contract.

### 5. MEDIUM -- T1.4 (F2/D2): contradiction proof is pure-function only; end-to-end the code_graph pair still would not flag until T2.1, and never across types

T1.4's fail-then-pass test injects candidates directly into
makeAudnDecision -- sound as far as it goes. But in capture(), candidates
come from findAudnCandidates, which (a) builds the FTS query from the INPUT
title with makeFtsQuery's implicit-AND join until T2.1 lands ("code_graph
now works" tokens require the OLD entry to contain 'works' -- it does not,
so the pair is not even a candidate at T1.4 time), and (b) requires
`e.type = input.type`, so a cross-type broken-vs-fixed pair is invisible
forever. Requirements F2 says "the new logic must flag such a pair going
forward; add a test that proves it" -- proving the pure function is not
proving capture(). Required: add an integration-level test at
provider.capture() on the code_graph pair shape (natural home: T2.1, after
the OR-join makes candidate discovery work), and either relax the type
filter for the contradiction path or record the cross-type blind spot as an
accepted limitation.

### 6. LOW -- T2.3 (F5/D5): kb-harvest.ts's free-string author 'kb-harvest' not covered

T2.3 maps kb-harvest.ts's source 'kb_agent_harvest' to 'harvest' but is
silent on its author field, which is the free string 'kb-harvest'
(kb-harvest.ts line 112) -- not in the Author union ('kb-agent' is the
nearest enum). Map it (or route harvest writes through the same stamping
path) so no free-string author survives at the tool layer.

## Resolution validation (checklist item 3 -- all three CORRECT)

- (a) CORRECT. makeFtsQuery (audn.ts lines 20-23) is called ONLY by
  findAudnCandidates (capture-time AUDN candidate discovery), not by any
  retrieval path. The multi-term retrieval failure lives in
  SqliteProvider.prime's `searchTerms.join(' ')` (sqlite-provider.ts line
  536) and the neighbor-batch `.join(' ')` (kb-session-prime.ts line 141).
  Fixing all three coherently, as T2.1 directs, is right -- though see
  finding 3 for the missed fourth site, and finding 5 for why makeFtsQuery's
  AND-join also matters to F2.
- (b) CORRECT. sync() (sqlite-provider.ts lines 610-612) is a stub returning
  `{ synced: false, reason: 'local-only provider' }`. Lines 436-490 are
  context() (computeFileHashBatch at line 436) and invalidate() (472-498).
  design.md's "sync() does file-hash staleness (lines 436-490)" is wrong;
  a new checkFreshness helper reusing computeFileHashBatch
  (src/services/knowledge/file-hash.ts) is the correct approach.
- (c) CORRECT. The 'update' branch (sqlite-provider.ts lines 272-277) runs
  `UPDATE entries SET superseded_at = ? WHERE id = ?` (line 273) -- it sets
  superseded_at but NOT stale. T1.3's claim and its fail-then-pass test on
  the stale column are sound.

## Checklist confirmation (items 1, 2, 4, 5, 6)

- Coverage: every F1-F8 maps to tasks (F1: T1.1/T1.2; F2: T1.3/T1.4; F3:
  T2.2; F4: T2.1; F5: T2.3; F6: T3.1; F7: T3.2; F8: T3.3/T3.4/T3.5).
  Fail-then-pass is explicitly mandated for the gate clamp (T1.1),
  supersede-stale (T1.3), contradiction flag (T1.4), and OR-join (T2.1),
  and the stated test shapes are sound at the level each targets -- with
  the end-to-end caveats in findings 2, 3, 5.
- Design compliance: D1 (clamp in handler, promote-only CONFIRMED,
  user-directive exemption pre-wired, forward-only, no migration) [OK].
  D2 [OK] modulo finding 5. D3 placement in SqliteProvider.prime with
  try/catch + bounded set [OK] modulo finding 4. D4 [OK] modulo finding 3.
  D5 enums + tolerant reads + no migration [OK] modulo finding 6. D6 [OK]
  modulo finding 2 (decay-exemption note: decayConceptEntries only touches
  INFERRED rows, so a CONFIRMED-at-capture user-directive is already safe;
  the explicit type guard is harmless belt-and-braces). D7 -- finding 1.
  D8 kb_list (incl. the correct use_count observation -- query() bumps it
  at lines 406-411), export shape/ordering/ASCII, cold-seed with named
  threshold and three degrade paths [OK].
- Risk order and shared files: Phase 1 = F1+F2 first [OK]. audn.ts: T1.4
  (Phase 1) then T2.1 as FIRST Phase-2 task; disjoint functions [OK].
  kb-session-prime.ts: T2.1 then T3.5 last, F3 kept out of the wrapper [OK].
- Models: all 12 work tasks carry an exact model (3 opus, 7 sonnet, 2
  haiku); all 3 VERIFY tasks are modelless and include build, test with the
  2-known-timezone-failures allowance (tests/time-utils.test.ts, yashr-302),
  gitnexus analyze, the mandatory `git checkout -- AGENTS.md CLAUDE.md`
  ASCII revert (runbook 3fa771af), ASCII sweep, and push to the feature
  branch [OK].
- Repo rules: ASCII-only stated sprint-wide with the template-literal hook
  gotcha; NEVER push main and NO PR stated in the header and every VERIFY
  task [OK].

## Summary

1 HIGH, 4 MEDIUM, 1 LOW. The HIGH (kb_harvest auto-dispatch) and the four
MEDIUMs are all plan-text fixes: amend T3.2's file list/decision, add the
findAudnCandidates type-filter work to T3.1, add the fourth OR-join site to
T2.1, state T2.2's coverage decision, and add the capture-level
contradiction integration test. Resubmit after these edits; the structure,
sequencing, and model assignments need no change.
