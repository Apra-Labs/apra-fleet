# KB Branch-Merge Reconcile Architecture

When two branches (or two developers) accumulate different learnings, merging
the code is not enough -- the knowledge has to merge too, and where two claims
contradict, the merged code is the arbiter. This document describes the
reconcile machinery. It is the branch-merge companion to
[knowledge-layer.md](knowledge-layer.md); read that first for the trust model,
the canonical bible, and bidirectional staleness, which this flow builds on.

---

## The problem

The canonical bible (`.fleet/kb-canonical.json`) already merges through git like
any other tracked file. But three gaps remain after a merge:

1. A warm local KB never absorbs a merged-in bible. The cold-seed in
   `kb_session_prime` reads bibles for OUTPUT only (and only when the KB is
   nearly empty, under `COLD_KB_MAX=3`); it never writes the database. So a
   developer whose KB is already warm sees none of the merged branch's
   knowledge.
2. Staleness used to be one-way. Priming on branch B marked branch A's entries
   stale by file-hash mismatch and never revived them, so switching back to A
   left its still-valid knowledge permanently retired.
3. When two branches carry contradicting claims, nothing arbitrated them
   against the actually-merged code.

The reconcile flow closes all three: a write path for the bible (`kb_import`),
bidirectional staleness (`freshnessSweep`), and a code-arbitrated resolution
path for contradictions (`kb_reconcile_prefilter` + the reconciler agent, both
funnelling through the single `resolveContradiction` write path).

---

## The ladder

`/pm kb-reconcile` runs after branches merge. The steps run in this order; each
is an ordinary KB tool, so the PM invokes them like any other `kb_*` step.

```
  merged worktree + merged bible
              |
   1. kb_import            absorb the merged bible into the local DB
              |
   2. kb_freshness_sweep   re-hash every entry vs the merged worktree
              |
   3. kb_reconcile_prefilter   mechanical (hash) wins for clear pairs
              |
   4. reconciler agent     code-arbitrates the pairs hashes cannot settle
              |
   5. kb_export            re-write + auto-commit the reconciled bible
```

### 1. kb_import -- the trusted-channel write path

`kb_import` is the missing write path that lets a warm local KB absorb a
merged-in bible. It reads a bible file (explicit `--path`, or the repo-resolved
`<repo>/.fleet/kb-canonical.json`) and routes every entry through
`provider.capture()` -- the same AUDN choke point normal captures use -- so
dedupe / supersede / contradiction-flag semantics apply uniformly.

Two properties make it safe and idempotent:

- **Trusted-channel confidence.** Imported non-directive entries KEEP their
  bible confidence instead of being clamped to INFERRED. Rationale: the bible
  is a git-reviewed, human-merged artifact, so re-clamping would demote the
  whole team's CONFIRMED knowledge on every import. This is the SOLE
  capture-level exemption to the general confidence clamp, engaged through an
  internal `capture()` parameter that no deserialized route can set (see the
  trust-model section of knowledge-layer.md). Imported entries are stamped
  `source='import'` for provenance.
- **Directive quarantine.** A `type='user-directive'` entry in a bible is
  FORCED to a pending proposal (UNVERIFIED + flagged + `directive:pending`),
  never active. A bible cannot smuggle in an active directive; activation stays
  CLI-only. Same security property as the cold-seed.

Idempotency is carried by an id-exists check that runs BEFORE AUDN: if the
bible entry's id already exists, it is skipped without a capture call. (AUDN
dedupe needs symbol AND file overlap, so a symbol-less or file-less bible entry
could never dedupe through AUDN alone and would re-add on every import.)
Re-running an import on the same bible therefore adds nothing.

After the entry loop, `kb_import` runs a `freshnessSweep` so entries whose basis
does not match THIS worktree are immediately staled rather than serving
wrong-branch claims. It reports `{imported, skipped, linked, flagged}` plus
the sweep's `{checked, staled, unstaled}`. It is exposed both as an MCP tool and
as `apra-fleet kb import [--repo <path>] [--path <file>]` for post-merge use.

**Trust boundary (stated honestly):** `kb_import` reads a caller-named local
file, so a local caller with tool access could import a hand-crafted bible.
This is equivalent in power to the already-exposed `kb_promote` surface -- it
adds bulk convenience, not a new privilege class. The "git-reviewed artifact"
rationale only holds for the repo-resolved `.fleet/kb-canonical.json`; an
explicit `--path` bible is caller-asserted trust. The unforgeable tier remains
user-directives, which are CLI-gated regardless of import path.

### 2. kb_freshness_sweep -- bidirectional staleness over the whole KB

The sweep re-hashes every entry that has a stored per-file basis against the
current (merged) worktree and applies the shared `freshnessRevivable` predicate
in both directions: stale a matching-no-more entry, revive a freshness-staled
entry whose full basis matches again. It is a bounded full-KB pass (one batched
hash over the union of basis files) meant for explicit commands, never wired
into per-prime. See knowledge-layer.md for the predicate and why prime alone
cannot revive an entry (prime's candidate set excludes stale rows, so
branch-switch revival requires a sweep).

Step 2 is idempotent and covers the reconcile-without-import path;
`kb_import` already ran a sweep internally.

### 3. kb_reconcile_prefilter -- mechanical wins

For each contradiction pair, the prefilter re-hashes BOTH sides' full bases
against the merged worktree:

- **Exactly one side matches** -> that side wins mechanically. The prefilter
  calls `resolveContradiction(winnerId, loserId, "hash-basis match on merged
  worktree")`. No agent needed.
- **Both match, both mismatch, or either side has an empty/missing basis** ->
  the pair is left for the agent rung.
- **Active user-directive in the pair** (`type='user-directive'` AND
  `confidence='CONFIRMED'`) -> never touched. Directives outrank mechanics; the
  flag stays for the human.

It returns `{pairs, resolved, left_for_agent, skipped_directive}`.

Pairs are read via `flaggedPairs()`, which has a deliberate **liveness
contract**: pair membership requires only `superseded_at IS NULL` on both
sides -- stale members MUST be included. The imported side of a pair is
typically stale right after the post-import sweep, so reusing the codebase's
default `superseded_at IS NULL AND stale=0` "live" filter would return no pairs
and the prefilter would silently no-op. Note the AUDN asymmetry: the
contradiction branch stores the NEW entry as UNVERIFIED with
`contradiction_of` set and `flagged_for_review=false`, so the flag lives on the
OLD side and the pointer lives on the NEW side; `flaggedPairs()` joins from
either anchor and returns only true pairs (lone feedback-downvoted entries are
never returned).

### 4. The reconciler agent

For pairs the hashes cannot settle, a reconciler agent
(`skills/pm/tpl-kb-reconciler.md`, standard model tier) reads the MERGED code
via the code-intelligence tools (`code_context` / `code_impact` / `code_query`,
never Glob/Grep for structural questions) and decides which claim the code
supports. Every decision is written through the SAME single write path the
prefilter uses -- `kb_resolve_contradiction(winnerId, loserId, evidence)` --
never by composing `kb_promote` + `kb_feedback` (those cannot produce the
required end state; see below).

Tiebreak when the code is silent: an active user-directive always survives
(flag only); otherwise CONFIRMED > INFERRED > UNVERIFIED. Still undecidable ->
leave flagged for `/pm kb-review` with a note. A downvoted entry that wins a
contradiction keeps its downvote -- it wins the contradiction, not its
reputation. NEVER delete. The agent reports
`{pairs, code_decided, tier_decided, deferred}`.

### 5. kb_export -- persist the reconciled bible

The flow ends with `kb_export`, which re-writes `.fleet/kb-canonical.json` from
the CONFIRMED, non-superseded, non-stale entries and auto-commits it (pm-kb
identity, pathspec-only, content-gated, non-fatal -- see knowledge-layer.md).
Reconcile winners are CONFIRMED and un-staled when the predicate allows, so they
pass the export filter; superseded losers and pending directives do not appear.
No post-prefilter sweep is needed: `resolveContradiction` sets the winner's
final stale state itself.

---

## resolveContradiction -- the single write path

All reconcile resolutions (mechanical AND agent-decided) go through one provider
method, `resolveContradiction(winnerId, loserId, evidence)`, surfaced as the MCP
tool `kb_resolve_contradiction`. It is deliberately NOT composed from
`promote()` + `feedback()`: `promote()` is a one-rung ladder that cannot lift
AUDN's UNVERIFIED contradiction-born entries straight to CONFIRMED, and it
clears neither `flagged_for_review` nor `contradiction_of`.

**Linkage refusal (write nothing unless valid).** Before writing anything, the
method verifies the two ids form a genuine contradiction pair
(`loser.contradiction_of === winner.id` OR
`winner.contradiction_of === loser.id`), that both rows exist, that neither is
superseded, and that neither side is an active directive. Otherwise it throws
and writes nothing. Without this, any caller could mint CONFIRMED from any tier
in one call and retire an arbitrary entry.

**Winner (operations in this exact order):**

1. set `confidence='CONFIRMED'` directly (regardless of starting tier -- the
   merged code is the verdict, so reconcile is verdict-equivalent) with the
   evidence note appended to content;
2. clear the flag fields FIRST -- `flagged_for_review=0` (old side) and
   `contradiction_of` cleared (new side), per the AUDN asymmetry;
3. THEN evaluate the shared `freshnessRevivable` predicate and clear stale ONLY
   if it holds.

The order matters: the predicate contains `flagged_for_review=0`, so evaluating
it before the flag-clear would self-defeat for a flagged old-side winner (the
branch-switch revival case this whole flow exists for) -- it would end CONFIRMED
but stale=1 and silently vanish from the bible. The durable exclusions (the
`[feedback ...]` content marker and `content_hash='invalidated'`) are unaffected
by the flag-clear, so an invalidated or feedback-downvoted winner still stays
retired.

**Loser:** `superseded_at=now` + `stale=1` + flag cleared -- retired with an
audit trail, never deleted.

---

## Why this satisfies the merge requirement

- Learnings merge because the bible merges through git and `kb_import` writes it
  into every developer's warm KB.
- Switching branches no longer loses knowledge, because `freshnessSweep` revives
  freshness-staled entries whose basis matches again (while superseded,
  downvoted, and invalidated entries stay retired).
- Contradictions are decided by the merged code -- mechanically when a hash
  basis is decisive, by the reconciler agent reading the merged code when it is
  not, and by trust tier only when the code is silent. Nothing is ever deleted;
  undecidable pairs wait for a human at `/pm kb-review`.
