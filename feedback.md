# Plan Final Review -- KB Branch Reconcile Sprint (epic yashr-ii1)

Reviewer: pm-plan-reviewer. Round 3 (final). Reviewing PLAN.md at commit
75ef839 against the hardened design.md (a1d344d) and requirements.md
(F1-F6). Round 1 (CHANGES NEEDED: 1 HIGH, 4 MEDIUM, 2 LOW, commit 91b2a2c)
and Round 2 (CHANGES NEEDED: 0 HIGH, 2 MEDIUM, 1 LOW, commit 52ef4fe) are
preserved in this file's git history.

## VERDICT: APPROVED

0 HIGH, 0 MEDIUM, 0 LOW. All ten findings across two rounds are resolved
and verified in the plan text; the three Round 2 edits match the
prescriptions exactly; the R7 war-game is closed with no new hole. The
plan is ready for dispatch.

---

## Round 2 findings: verification against commit 75ef839

### MEDIUM-1 R2 (pair-linkage refusal) -- FIXED, matches prescription

T3.1(b) LINKAGE REFUSAL block: before writing ANYTHING the method
verifies loser.contradiction_of === winner.id OR winner.contradiction_of
=== loser.id (both-direction check, preserving the AUDN asymmetry point),
both rows exist, neither superseded; refuse otherwise with nothing
written. The tool-surface sentence now lists the linkage refusal among
the refusal conditions. Test 8 covers: two existing but unlinked entries
refused with NOTHING written (confidence, stale, flags, superseded_at all
asserted unchanged on both rows), missing id refused, and
linked-but-superseded member refused. Exactly as prescribed. [OK]

### MEDIUM-2 R2 (winner-path operation order) -- FIXED, matches
prescription

T3.1(b) WINNER block now states the order explicitly and numbers it:
(1) confidence='CONFIRMED' + evidence note; (2) clear the winner's flag
fields FIRST (flagged_for_review on the old side, contradiction_of on the
new side, exact column writes required in the method); (3) THEN evaluate
the shared D2 predicate and clear stale only if it holds -- with the
rationale (predicate contains flagged_for_review=0; evaluating before the
flag-clear self-defeats for a flagged old-side winner) and the
durable-exclusion preservation note ("[feedback " marker and
content_hash='invalidated' unaffected by the flag-clear, so a downvoted
or invalidated winner still stays retired). Test 7: old-side flagged
winner (flagged=1, stale=1, matching basis, no markers) ends CONFIRMED +
unflagged + stale=0 and PASSES the list({confidence:'CONFIRMED'}) export
filter. Done criteria require both the refusal and the ordering stated in
the method doc comment. Exactly as prescribed. [OK]

### LOW-1 R2 (marker anchoring) -- FIXED

T1.3 MARKER ANCHORING note: match the form feedback() actually writes
(two newlines + "[feedback " + ISO timestamp), newline-prefixed or
timestamp-anchored rather than a bare substring, with the chosen pattern
stated in the predicate comment -- closing the meta-content
false-positive. [OK]

R7's resolution text is updated to record the closure ("with the T3.1
linkage refusal and the flag-clear-before-predicate winner order, R7
introduces no new hole").

---

## No-new-hole confirmation (final war-game)

- The linkage refusal cannot break any legitimate path: every prefilter
  and reconciler-agent resolution sources its pairs from flaggedPairs(),
  whose contract (contradiction_of linkage, both rows exist, superseded
  excluded, stale INCLUDED) is a strict subset of the refusal's
  conditions -- a stale pair member remains resolvable (test 4 and the
  refusal are consistent: only superseded excludes).
- Refusal runs before any write, so partial-write states are impossible;
  the winner CONFIRMED write happens only after the refusal passes.
- The downvoted or invalidated winner still stays retired: the flag-clear
  precedes the predicate, but the durable conjuncts ("[feedback " marker,
  content_hash='invalidated') are content/hash-based and survive it --
  Round 1 MEDIUM-2 protection intact (T3.1 tests 2 and 3 unchanged and
  still correct).
- The loser invariant (superseded_at set alongside every flag-clear)
  holds on every path, including refusal (no write at all).
- Directive protection is layered and intact: the capture() gate (import
  cannot smuggle), promote() refusal, the prefilter HARD EXCLUSION, and
  kb_resolve_contradiction's own directive-pair refusal.
- R4 remains airtight (one-argument HTTP route, zod-built MCP input,
  internal opts transport) with MEDIUM-4 R1's source normalization
  closing the provenance side.

## Cumulative resolution record

- Round 1: HIGH-1 (winner never reached the bible) -> resolveContradiction
  single write path; MEDIUM-1 (invalidate() fourth stale actor) ->
  predicate conjunct + tests both levels; MEDIUM-2 (downvote laundering)
  -> durable "[feedback " conjunct + tests + template rule; MEDIUM-3
  (flaggedPairs liveness) -> superseded-only contract + tests; MEDIUM-4
  (forged source='import') -> provenance normalization + extended HTTP
  test; LOW-1/LOW-2 -> trust-boundary wording + id-skip-before-AUDN.
- Round 2: MEDIUM-1 (linkage refusal), MEDIUM-2 (winner-path order),
  LOW-1 (marker anchoring) -- all applied at 75ef839 as verified above.

## Standing confirmations (unchanged from Rounds 1-2)

F1-F6 covered with testable done criteria; fail-then-pass demanded for F2
(un-stale core) and F3 (provider clamp); F4 idempotency + directive
quarantine + HTTP-shape safety tested; F6 e2e chain independently
re-traced and satisfiable, hermetic, ends at the export assertion. F1
first, zero-failure criterion binding from T1.2 onward. sqlite-provider
strict ordering T1.2 -> T1.3 -> T2.1 -> T3.1 binding. Prefilter never
touches active-directive pairs. Reconciler template + kb-reconcile.md +
SKILL.md row + cleanup-flow hook present; kb_export auto-commit closes
the ladder. Models sane (opus exactly on T1.3 and T2.1). VERIFYs carry
the gitnexus-analyze + git checkout AGENTS.md/CLAUDE.md gotcha and the
final byte-level ASCII sweep. ASCII-only, never push main, NO PR.

APPROVED for dispatch.
