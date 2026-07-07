# Plan Re-Review -- KB Branch Reconcile Sprint (epic yashr-ii1)

Reviewer: pm-plan-reviewer. Round 2. Reviewing PLAN.md at commit 3374fc9
against the HARDENED design.md (a1d344d) and requirements.md (F1-F6).
Round 1 (verdict CHANGES NEEDED: 1 HIGH, 4 MEDIUM, 2 LOW, commit 91b2a2c)
is preserved in this file's git history.

## VERDICT: CHANGES NEEDED

0 HIGH, 2 MEDIUM, 1 LOW -- all seven Round 1 findings are verified FIXED
(per-finding verification below), and the resolveContradiction redesign
makes the F6 e2e chain genuinely satisfiable (independently re-traced).
The two remaining MEDIUMs are both residuals of the new write path itself:
kb_resolve_contradiction performs no pair-linkage verification (the exact
class of check this sprint's trust philosophy demands on a new MCP-exposed
CONFIRMED-minting surface), and the winner path's stated operation order
(predicate-guarded un-stale BEFORE flag clearing) self-defeats for a
flagged old-side winner because the shared D2 predicate contains
flagged_for_review=0. Both are small, surgical plan edits to T3.1; no
structural change needed.

---

## Round 1 findings: verification

### HIGH-1 (winner never reaches the bible) -- FIXED, chain re-traced

The fix is resolveContradiction(winnerId, loserId, evidence) as the SINGLE
write path (hardened D4, plan T3.1(b), R7). Re-traced end-to-end against
source semantics:

1. Import: AUDN contradiction branch stores B UNVERIFIED, contradiction_of
   = A, flagged=0; A gets flagged=1. Plan now states this asymmetry
   explicitly (T3.1(a), T3.3 step 3). Matches audn.ts newEntryOverrides.
2. Post-import sweep stales B (basis mismatch). flaggedPairs() still
   returns the pair because liveness is pinned to superseded_at IS NULL
   only (MEDIUM-3 fix); e2e step 4 asserts it.
3. Merged state: B's basis matches, A's does not -> prefilter calls
   resolveContradiction(B, A, "hash-basis match on merged worktree").
   Winner: CONFIRMED directly (no promote ladder -- correct, since
   promote() is one-step and clears no flags; KB a2781b82). Un-stale via
   the D2 predicate: B has stale=1, superseded NULL, flagged=0, empty
   content_hash, no "[feedback " marker, full basis match -> stale=0.
   Loser A: superseded_at + stale=1 + flag cleared (safe: superseded_at
   set alongside, loser can never satisfy the predicate).
4. kb_export's list({confidence:'CONFIRMED'}) filter (CONFIRMED AND
   stale=0 AND superseded_at IS NULL) now INCLUDES B and excludes A.
   T3.3 step 6 asserts exactly this. T3.1 test 1 asserts the same at the
   provider level, including the list() cross-check.

The "no post-prefilter sweep needed" note in T3.2 step 2 is correct FOR
THE NEW-SIDE WINNER (flagged=0). It is NOT correct for a flagged old-side
winner -- see MEDIUM-1 below (an ordering residual inside the method, not
a ladder problem).

### MEDIUM-1 R1 (invalidate() fourth stale actor) -- FIXED

content_hash != 'invalidated' conjunct added to the binding predicate
(T1.3, verbatim block, six conjuncts); four-actor enumeration corrected;
tested at BOTH levels: T1.3 test 5 (sweep exclusion) and T3.1 test 3
(invalidated winner stays stale=1 through resolveContradiction). [OK]

### MEDIUM-2 R1 (downvote laundering) -- FIXED

content NOT LIKE '%[feedback %' conjunct makes the downvote durable across
any flag-clear; T1.3 test 4 (marker with flag cleared, matching basis,
stays stale); T3.1 test 2 (downvoted winner: CONFIRMED, flag-cleared,
STILL stale=1, and a subsequent freshnessSweep does not revive);
tpl-kb-reconciler.md rule "a downvoted winner stays stale (it wins the
contradiction, not its reputation)" so the agent does not undo it. [OK]
One false-positive edge noted as LOW-1 below.

### MEDIUM-3 R1 (flaggedPairs liveness) -- FIXED

Liveness contract pinned in T3.1(a): superseded_at IS NULL only, stale
members MUST be included, with the explicit anti-pattern warning against
reusing list()/stats()/query()'s default live filter; doc-comment
requirement; T3.1 test 4 (stale member returned and resolvable; superseded
member excludes; lone downvote never returned); e2e step 4 asserts the
stale-member pair. [OK]

### MEDIUM-4 R1 (forged source='import') -- FIXED

T2.1(b) provenance normalization: caller-supplied 'import' OR 'promotion'
overwritten unless internal import mode engaged; test 7 extended to assert
clamp AND source rewrite for the HTTP-shaped one-argument payload,
including the 'promotion' case; done criterion added. Matches hardened D3.
[OK]

### LOW-1 R1 (arbitrary-path trust boundary) -- FIXED

Honest boundary statement (equivalent in power to kb_promote; explicit
path = caller-asserted trust; directives quarantined regardless, gate
before exemption) placed in the T2.1 tool description, T2.2 --path help
text, and kb-reconcile.md step 1. [OK]

### LOW-2 R1 (id-skip before AUDN) -- FIXED

T2.1 "ORDER OF OPERATIONS": id-exists check FIRST, before capture()/AUDN,
with the correct rationale (symbolsOverlap/filesOverlap false on empty
arrays; bible entries have no content field); deterministic content
synthesis stated; test 3 extended with a symbol-less/file-less fixture
entry. [OK]

Also verified: the two cosmetic anchors from Round 1 were corrected
(src/commands/kb-server.ts path; gate lines 450-462); R4 text updated with
the verified one-argument evidence; R7 correctly records and resolves the
D4-vs-D5 write-path conflict in favor of hardened D4.

---

## New findings (Round 2)

### MEDIUM-1: kb_resolve_contradiction does not verify the ids form a
genuine contradiction pair (T3.1(b); R7 war-game)

The plan's refusal list is: missing id, or pair involving an ACTIVE
user-directive. Nothing requires the two ids to be LINKED. As specified,
any MCP caller (including a confused reconciler agent passing wrong ids)
can call kb_resolve_contradiction(anyA, anyB, "fabricated evidence") and
get: anyA lifted to CONFIRMED in ONE call from ANY tier (bypassing the
promote ladder entirely), anyB permanently retired (superseded_at -- not
the reversible flag+stale of kb_feedback) with no human review.

Honest power analysis (why MEDIUM, not HIGH): within the local trust model
this is not a new privilege CLASS -- an agent can already supersede an
arbitrary entry via a crafted AUDN-update capture (same type + symbol
overlap + file overlap + different content) and can mint CONFIRMED via the
kb_promote ladder (two calls from UNVERIFIED). But it is a materially
sloppier one-call footgun on a brand-new surface, in a sprint whose whole
design language is choke points, refusals, and tested invariants
(directive gate, R4 opts transport, prefilter hard exclusion). The
directive refusal already inside the method proves the method reads both
rows anyway -- the linkage check is nearly free.

Required fix in T3.1(b): resolveContradiction refuses unless the pair is
genuinely linked -- loser.contradiction_of === winner.id OR
winner.contradiction_of === loser.id (the AUDN asymmetry means the pointer
can sit on either side depending on which side wins), both rows exist, and
neither is superseded. Add to the refusal test group: unlinked ids ->
refused, nothing written.

### MEDIUM-2: winner path operation order self-defeats for a flagged
old-side winner (T3.1(b))

The plan's winner bullets are ordered: set CONFIRMED -> "Clear the
winner's stale ONLY via the D2 safe predicate (reuse T1.3's shared
predicate function)" -> "Clear the winner's flag fields". The shared
predicate CONTAINS flagged_for_review = 0. By AUDN asymmetry the OLD side
of a pair carries flagged_for_review=1 -- so when the old side wins (its
basis matches the merged worktree; the imported claim was the wrong one --
precisely the branch-switch revival scenario this sprint exists for), a
doer following the stated bullet order evaluates the predicate while the
flag is still set, the predicate fails, and the winner ends CONFIRMED but
stale=1 -- silently dropped by kb_export's stale=0 filter. Same failure
mode as Round 1's HIGH-1, in a narrower but realistic slice; T3.1 test 1
and the e2e only exercise the NEW-side winner (flagged=0), so nothing
catches it.

Required fix in T3.1(b): state the order explicitly -- clear the winner's
flag fields FIRST, then evaluate the D2 predicate for the un-stale (the
durable exclusions, "[feedback " marker and content_hash='invalidated',
are unaffected by the flag-clear, so MEDIUM-2 R1 protection is preserved;
alternatively evaluate the predicate with the flag conjunct waived and the
two durable-marker conjuncts + full-basis-match enforced -- pick one and
say it). Add a test: old-side winner (flagged_for_review=1, stale=1,
matching basis, no feedback/invalidated marker) ends CONFIRMED + stale=0
and passes the list({confidence:'CONFIRMED'}) export filter.

### LOW-1: "[feedback " marker conjunct can false-positive on meta-content
(T1.3)

An entry whose content legitimately quotes the feedback note format (e.g.
a learning ABOUT the kb_feedback mechanism -- such entries exist in this
very KB) would, once freshness-staled, be permanently excluded from
revival by the content NOT LIKE '%[feedback %' conjunct. Self-healing via
re-capture and rare, hence LOW. Cheap hardening: anchor the pattern to
what feedback() actually writes -- it appends '\n\n[feedback ' +
ISO-timestamp (verified in source), so matching the newline-prefixed form
(or a timestamp-anchored form) sharply reduces collisions. Note the
choice in the predicate comment either way.

---

## R7 war-game answer (checklist)

Can an agent abuse the MCP-exposed kb_resolve_contradiction to CONFIRM
arbitrary entries outside a genuine flagged pair? AS SPECIFIED, YES --
the method verifies id existence and the active-directive exclusion but
NOT contradiction linkage (MEDIUM-1 above): one call mints CONFIRMED from
any tier and permanently supersedes the other id. Marginal power over the
existing kb_promote ladder and crafted-AUDN-supersede paths is limited
(same local trust envelope, directives still protected by the method's own
refusal), so this does not reopen yashr-f3g -- but the linkage check is
required before APPROVED because the method reads both rows anyway and the
sprint's own standard is refusal-tested choke points. With MEDIUM-1's fix
(refuse unlinked pairs) and MEDIUM-2's fix (flag-clear before predicate),
R7 introduces no new hole: the tool then writes only to genuinely flagged,
non-directive, non-superseded pairs, the winner's un-stale stays gated by
the durable D2 exclusions, and the loser invariant (superseded_at set
alongside every flag-clear) holds on every path.

## What must change before APPROVED

- T3.1(b): add the pair-linkage refusal (contradiction_of match in either
  direction, both rows live) + refusal test (MEDIUM-1).
- T3.1(b): pin winner-path order -- clear flag fields BEFORE evaluating
  the D2 un-stale predicate (or waive the flag conjunct there) + old-side
  flagged winner test asserting CONFIRMED + stale=0 + export-filter pass
  (MEDIUM-2).
- T1.3: optional LOW-1 pattern anchoring, or a recorded note accepting the
  false-positive edge.

Everything else -- structure, ordering, models, R1-R7, all Round 1 fixes,
F1-F6 coverage, fail-then-pass demands, VERIFY gotchas, ASCII/never-main/
no-PR -- is in order. This is one task's worth of plan edits from
APPROVED.
