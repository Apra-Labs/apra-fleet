# Plan Review -- KB Branch Reconcile Sprint (epic yashr-ii1)

Reviewer: pm-plan-reviewer. Reviewing PLAN.md at commit a23aded against
requirements.md (F1-F6) and design.md (D1-D6), with source verification on
feat/code-intelligence-abstraction.

## VERDICT: CHANGES NEEDED

1 HIGH, 4 MEDIUM, 2 LOW. The plan's structure is strong: F1-F6 all covered
with testable done criteria, fail-then-pass demanded where required, the
sqlite-provider.ts ordering is binding, R1-R6 resolve every ambiguity the
design left open, models and VERIFYs are sane, and the R4 import-mode
mechanism survives a direct attack (details below). The blocker is a
winner-end-state hole in the reconcile ladder that makes the F6 e2e's own
done criteria unsatisfiable as written: the code's AUDN and export filters
guarantee the "winning" claim never reaches the exported bible under the
plan's current prefilter specification. Two predicate/invariant gaps found
by war-gaming (invalidate() revival, downvote laundering) also need
resolutions before the doers start T1.3/T3.1.

All factual anchors checked against source: clamp at kb-capture.ts:97-101
[OK]; HTTP route kb-server.ts:133-141 (file is src/commands/kb-server.ts,
not src/kb/ -- cosmetic) [OK]; directive gate sqlite-provider.ts:450-462
(plan cites 449-461, off-by-one, cosmetic) [OK]; checkFreshness sets stale=1
only [OK]; CaptureSource lacks 'import' (types.ts:20) [OK]; promote() does
NOT clear flagged_for_review or contradiction_of (its UPDATE touches only
confidence/promoted_at/content/source) -- KB a2781b82 confirmed [OK];
feedback() sets stale=1 + flagged_for_review=1 + "[feedback ...]" note [OK];
AUDN update and rejectDirective both set superseded_at + stale [OK].

---

## HIGH

### HIGH-1: Reconcile winner never reaches the exported bible as specified
(T3.1, T3.2, T3.3; design D4/D6 latent inconsistency the plan reproduced)

Three verified facts compose into a broken ladder:

1. audn.ts makeAudnDecision's contradiction branch inserts the NEW entry
   with newEntryOverrides { confidence: 'UNVERIFIED', contradiction_of,
   flagged_for_review: false } -- so the imported (bible/B-side)
   contradiction entry is stored UNVERIFIED, regardless of T2.1's
   import-mode confidence preservation, and it is NOT flagged (only the
   existing A-side gets flagged_for_review=1).
2. T3.1's win path says "promote the winner if INFERRED". The typical
   winner -- the contradiction-born imported entry -- is UNVERIFIED, so
   this clause never fires; even if promoted once it lands at INFERRED,
   not CONFIRMED. Additionally the winner can be stale=1 at prefilter time
   (T3.3 step 4 explicitly stales B; the D2 sweep cannot revive it while
   the pair is unresolved -- and the ladder in T3.2 runs the sweep at step
   2, BEFORE the prefilter at step 3, with no sweep after).
3. kb_export exports via list({confidence:'CONFIRMED'}) and list()
   hard-filters superseded_at IS NULL AND stale = 0 (kb-export.ts:173,
   sqlite-provider.ts:775). A winner that is UNVERIFIED, INFERRED, or
   stale=1 is silently absent from .fleet/kb-canonical.json.

Net effect: in the e2e as scripted (T3.3), after step 5 the winner B is at
best INFERRED and still stale=1; step 6's assertion "B's claim in [the
bible]" FAILS, and worse, the bible loses BOTH claims (A superseded, B
filtered out) -- the opposite of "merged truth".

Required fix (pick one, state it in T3.1 and mirror it in T3.2's ladder and
T3.3's assertions):
- (preferred) The prefilter win path explicitly sets the winner's end
  state: stale=0 (justified: the win condition IS a full-basis match --
  the same predicate the D2 sweep uses to revive) and promotes the winner
  to CONFIRMED regardless of starting tier (UNVERIFIED -> INFERRED ->
  CONFIRMED via two promote steps or a dedicated reconcile-promotion path),
  reason citing "hash-basis match on merged worktree"; or
- Keep single-step promotion but add a post-prefilter freshnessSweep as
  ladder step 4.5 AND redefine the e2e/export expectation for a winner that
  ends INFERRED (which contradicts D6's "B's claim in" -- so this variant
  needs a recorded design deviation).

Also make T3.1's "clear BOTH flags" concrete against the verified pair
asymmetry: flagged_for_review lives on the OLD side only; contradiction_of
lives on the NEW side only.

## MEDIUM

### MEDIUM-1: The D2 un-stale predicate misses the fourth stale actor:
invalidate() (T1.3)

D2 and T1.3 enumerate three stale=1 setters (freshness, supersede,
feedback). Verified in source there is a fourth: invalidate() sets
content_hash='invalidated' + stale=1 on context-cache entries while leaving
flagged_for_review=0 and superseded_at NULL, and it does NOT touch the
stored source_file_hashes basis -- which still matches the unchanged
worktree. Such an entry satisfies every clause of the T1.3 predicate, so
freshnessSweep would REVIVE an explicitly invalidated entry into
kb_query/list results (context() is independently protected by its own
content_hash check; query()/list() are not). Fix: add a fourth conjunct to
the predicate (content_hash != 'invalidated' or equivalent) and a seventh
exclusion test: invalidated entry with matching basis stays stale after
sweep.

### MEDIUM-2: Downvote laundering through the prefilter's flag-clear
(T3.1; violates D2's "a downvoted entry must stay retired")

War-game result for checklist 2b: the single flagged_for_review bit is
shared by the contradiction flag and the feedback downvote. An entry that
is both contradiction-flagged and feedback-downvoted (stale=1, flagged=1,
"[feedback ...]" note, superseded_at NULL) can WIN the hash prefilter; the
win path clears its flag without setting superseded_at, after which it
satisfies the D2 predicate and the next sweep revives it -- the mechanical
hash win silently erases an agent/human downvote. The LOSER side is safe
everywhere (the plan always sets superseded_at before/while clearing the
loser's flag -- invariant holds), and approveDirective (the only other
flag-clearer today) is a human act on directives. Fix: T3.1 must state the
winner-side rule -- either (a) pairs whose hash-winner carries a
"[feedback " content note (the reliable downvote discriminator; a pure
contradiction flag leaves stale=0) are left for the agent/human rung, or
(b) the override is declared deliberate, documented in tpl-kb-reconciler.md
/ kb-reconcile.md, and covered by a test. (a) is more faithful to D2.

### MEDIUM-3: flaggedPairs() liveness must be "not superseded" only --
stale pair members MUST be included (T3.1)

The plan says "both sides live (not superseded)". Everywhere else in this
codebase "live" means superseded_at IS NULL AND stale = 0 (list(), stats(),
query() defaults). If a doer reuses that filter, the typically-stale
imported side of a pair (T3.3 step 4 stales it) makes flaggedPairs() return
nothing and the prefilter silently no-ops -- the e2e would fail with zero
resolved pairs. Pin the definition in T3.1: superseded excluded, stale
INCLUDED; add a test where one pair member is stale and the pair is still
returned and resolvable.

### MEDIUM-4: source='import' provenance is forgeable via HTTP
/api/kb/capture (T2.1)

The route parses the body as KBEntryInput and insertEntry persists
input.source verbatim -- so once 'import' joins CaptureSource, any HTTP
caller can stamp source='import' on its entries. Post-T1.2 they are still
clamped to INFERRED (no confidence escalation), but the plan explicitly
advertises source='import' as showing "the channel"; audits and future
logic keyed on it would trust forged rows. Fix in T2.1: capture() must
normalize/reject a caller-supplied source of 'import' when the internal
import opt is not set (e.g. rewrite to 'session'/'unknown'), and extend
test 7 to assert both the clamp AND the source rewrite for the HTTP-shaped
payload.

## LOW

### LOW-1: kb_import arbitrary-path trust boundary should be stated
(T2.1/T2.2 docs)

{path?} accepts any readable file, so any MCP caller can import a crafted
"bible" and bulk-mint CONFIRMED entries. Honest boundary statement: this is
within the existing local-tool trust envelope -- kb_promote is already
MCP-exposed and lets any agent walk any entry INFERRED->CONFIRMED one call
at a time, so import-from-path adds bulk convenience, not a new privilege
class; directives stay quarantined either way (gate runs before the
exemption). But the plan should say this out loud: add a sentence to the
tool description and kb-reconcile.md that an explicit path is
caller-asserted trust (the "git-reviewed artifact" rationale only holds for
the repo-resolved .fleet/kb-canonical.json), and validate the path
resolves/parses before importing.

### LOW-2: Id-preservation skip must run BEFORE AUDN routing (T2.1)

Bible entries have no content field ({id, type, title, summary, symbols,
source_files, confidence, updated_at}), and AUDN dedupe requires symbol AND
file overlap plus content equality -- symbolsOverlap()/filesOverlap()
return false on empty arrays, so a symbol-less or file-less bible entry can
never dedupe via AUDN and would re-add on every import if only AUDN guards
idempotency. The plan's id-preservation rule covers this, but T2.1 should
state explicitly that the id-exists check happens BEFORE capture()/AUDN
(skip on id hit), and that import synthesizes content deterministically
(e.g. from summary) so the AUDN 'none' content-equality path also works for
id-collision-with-identical-content cases.

---

## Attack answers (checklist item 2)

### 2a: Import-mode clamp exemption (R4)

VERDICT: the R4 mechanism is airtight as specified; one provenance-hygiene
gap (MEDIUM-4). Verified: the HTTP route (src/commands/kb-server.ts:133-141)
does `const input = JSON.parse(body) as KBEntryInput; provider.capture(input)`
-- exactly ONE argument, no spread, no opts passthrough. The MCP kb_capture
handler builds the KBEntryInput object explicitly from zod-parsed fields
(z.object strips unknown keys), so no MCP caller can smuggle extra fields
either. An import flag carried as a SECOND parameter of capture() (per R4)
is therefore structurally unreachable from every deserialized route; the
plan's T2.1 test 7 (HTTP-shaped payload with import-ish fields still
clamped) locks it in. Cannot mint CONFIRMED via HTTP or MCP capture.
Residual: input.source IS part of the deserialized body and is persisted
verbatim -- forged source='import' provenance (clamped, but mislabeled) is
possible unless normalized (MEDIUM-4). Directive quarantine holds under
import: the gate at the top of capture() runs before any confidence
handling and T2.1 test 2 asserts it. Arbitrary-path poisoned bible: real,
but equivalent in power to the already-MCP-exposed kb_promote ladder --
within the local trust model, should be stated honestly in docs (LOW-1).

### 2b: Un-stale predicate (D2)

- Superseded entry: CANNOT be revived -- AUDN update sets superseded_at +
  stale in one UPDATE; predicate excludes superseded_at IS NOT NULL. [OK]
- Rejected directive: CANNOT be revived -- rejectDirective sets
  superseded_at + stale (verified line ~963). [OK]
- Feedback-downvoted entry: excluded while flagged_for_review=1 stands.
  Flag-clearing flows audited: approveDirective (human CLI, directive-only,
  and directives carry empty bases so the full-basis-match clause blocks
  revival anyway); promote() does NOT clear flags (verified -- KB a2781b82
  correct); the T3.1 prefilter is the first generic flag-clearer. Its
  LOSER path is safe everywhere (superseded_at set alongside the
  flag-clear, so the loser stays retired -- the invariant the checklist
  asked to verify HOLDS on the loser side). The WINNER path is the gap:
  a downvoted entry that also sits in a contradiction pair can win on
  hash, get its flag cleared without superseded_at, and become
  sweep-revivable -- downvote laundered (MEDIUM-2).
- NEW: a fourth stale actor nobody enumerated -- invalidate() -- satisfies
  the full predicate (flagged=0, superseded NULL, basis unchanged) and
  would be wrongly revived (MEDIUM-1).

---

## Checklist confirmations (items 1, 3, 4, 5)

1. Coverage: F1=T1.1, F2=T1.3 (fail-then-pass test 1 + per-exclusion
   tests), F3=T1.2 (fail-then-pass at provider level), F4=T2.1/T2.2
   (idempotency test 3, directive quarantine test 2, HTTP-shape test 7),
   F5=T3.1/T3.2, F6=T3.3. Done criteria are concrete and testable
   throughout. [OK] (subject to HIGH-1 correction in T3.1/T3.3)
2. See attack answers above.
3. F1 is the first task; zero-failure criterion binding from T1.2 onward
   and in every VERIFY; sqlite-provider strict ordering T1.2 -> T1.3 ->
   T2.1 -> T3.1 stated as binding with a shared-file table; prefilter HARD
   EXCLUSION for active-directive pairs present in T3.1; reconciler
   template + kb-reconcile.md + SKILL.md row + cleanup-flow hook in T3.2;
   kb_export closes the ladder (step 5) and the e2e (step 6). [OK]
4. Factual anchors verified against source (see header). KB citations
   9462ab04/d1c6f758/4b87fbce/a2781b82/d036ab13 all consistent with code.
   Two cosmetic path/line nits noted, not findings. [OK]
5. Models: opus exactly on the two flagged hard tasks (T1.3 predicate,
   T2.1 import trust); haiku only on mechanical CLI wiring; VERIFYs carry
   the gitnexus-analyze + git checkout AGENTS.md/CLAUDE.md gotcha verbatim;
   T3.4 adds the byte-level ASCII sweep; ASCII/never-main/no-PR constraints
   present sprint-wide. [OK]

## What must change before APPROVED

- T3.1/T3.2/T3.3: specify the winner end-state (stale=0 + path to
  CONFIRMED, or recorded deviation) per HIGH-1; pin flaggedPairs stale
  inclusion (MEDIUM-3); winner-side downvote rule (MEDIUM-2).
- T1.3: fourth predicate conjunct for invalidate() + exclusion test
  (MEDIUM-1).
- T2.1: source normalization when import opt unset + test extension
  (MEDIUM-4); LOW-1/LOW-2 wording can ride along.
