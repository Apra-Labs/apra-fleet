# Phase 3 + Sprint-Final Code Review -- KB Branch Reconcile (epic yashr-ii1)

Reviewer: pm-reviewer. SPRINT-FINAL review of Phase 3 (T3.1-T3.4) of the
kb-branch-reconcile sprint against PLAN.md (revision 3, T3.1-T3.4 + sprint
done criteria), requirements.md (F5, F6), and design.md (D4 HARDENED, D5,
D6). Phase 3 commits reviewed: 5ac2cb8 (T3.1 flaggedPairs +
resolveContradiction + prefilter + the yashr-d8b chdir fold-in), 6ba9caf
(T3.2 reconciler template + docs), 8e4368b (T3.3 e2e). Phases 1-2 verdicts
(plan Rounds 1-3, Phase 1 ef40152, Phase 2 6a4815b) are preserved in this
file's git history. The reconcile trust core -- resolveContradiction -- was
attacked directly against the COMPILED dist, not only through the shipped
tests.

## VERDICT: APPROVED

0 HIGH, 0 MEDIUM, 1 LOW. The reconcile write path is airtight: every attack
in the review brief was reproduced live against dist and defended correctly,
including the R7 laundering war-game. The single LOW is an
already-documented design invariant (the reconcile tools re-hash against
process.cwd()), not a defect. Build clean (tsc exit 0). Full suite: 2047
passed / 14 skipped / 0 failed (this reviewer's own run) -- exactly the
expected 2047. Sprint ASCII sweep clean. main untouched, no PR raised.

---

## Verification performed (all on this reviewer's machine)

- npm run build: clean (exit 0, tsc).
- npm test (full suite, own run): 141 files, 2047 passed / 14 skipped / 0
  FAILED. Zero-failure criterion holds through sprint close.
- Targeted: kb-reconcile-e2e.test.ts (1) + kb-reconcile.test.ts (19) all
  green.
- LIVE ATTACK against compiled dist (dist/services/knowledge/
  sqlite-provider.js + dist/services/knowledge/file-hash.js), 26 assertions,
  ALL PASS. The script drove the real compiled SqliteProvider.
  resolveContradiction with directly-seeded rows controlling
  linkage/superseded/directive/flag/stale/basis exactly.
- ASCII sweep: git diff a851e40^..HEAD across all 28 sprint-touched files,
  every added (+) line scanned for bytes > 0x7F -- 0 hits (verified by
  bytes, not the pre-commit hook). Sprint scope is 28 files (a851e40^..HEAD),
  NOT the ~140 in main...HEAD (that is the whole feature branch's divergence,
  not this sprint -- correctly no mass migration).
- main untouched: main tip is 5526fe7 (unrelated docs); all sprint work is on
  feat/code-intelligence-abstraction. No PR.

## Review brief results (items 1-7)

### 1. resolveContradiction trust core -- AIRTIGHT (live-proven, 26/26)

- 1(a) UNLINKED ids (neither's contradiction_of points at the other):
  REFUSED (throws), and both rows byte-for-byte unchanged (confidence,
  stale, flags, superseded_at). Winner NOT confirmed. Nothing written.
- 1(b) LINKED-but-superseded (challenger.contradiction_of = original, but
  challenger already superseded): REFUSED, nothing written.
- 1(c) ACTIVE user-directive pair (directive CONFIRMED, challenger points at
  it): REFUSED; directive untouched, still CONFIRMED.
- 1(d) LEGITIMATE pairs, numbered order verified:
  - Old-side flagged winner (flagged_for_review=1, stale=1, matching basis,
    no feedback/invalidated marker) -> CONFIRMED + unflagged +
    contradiction_of cleared + stale=0 + evidence note; loser superseded_at
    set + stale=1 + flag cleared. This proves the flag-clear-BEFORE-predicate
    order: had the D2 predicate run before the flag-clear, the winner would
    have ended stale=1 (predicate requires flagged_for_review=0) and vanished
    from the bible.
  - Downvoted winner (anchored "[feedback " marker, flag pre-cleared, matching
    basis) -> CONFIRMED but STILL stale=1; marker survives. Laundering
    defense holds: it wins the contradiction, not its reputation.
  - Invalidated winner (content_hash='invalidated', matching basis) ->
    CONFIRMED but STILL stale=1.
- 1(e) R7 WAR-GAME re-run: attempt to launder an arbitrary UNVERIFIED entry
  to CONFIRMED by pairing it with an unrelated throwaway (non-pair) is
  REFUSED -- victim stays UNVERIFIED, throwaway NOT superseded. Self-pair
  (winnerId===loserId) also refused. The linkage refusal closes the R7 hole
  completely: the tool writes ONLY to genuinely linked, non-superseded,
  non-directive pairs.

### 2. flaggedPairs liveness -- CORRECT (SQL read, not just tests)

flaggedPairs() (sqlite-provider.ts:1182) joins challenger.contradiction_of =
original.id and filters ONLY `o.superseded_at IS NULL AND c.superseded_at IS
NULL` -- stale members are INCLUDED (it does NOT reuse the list()/query()
default stale=0 filter). The JOIN on contradiction_of structurally excludes
lone feedback-downvoted entries (flagged but no counterpart). Active
user-directives on EITHER side are excluded via
`NOT (type='user-directive' AND confidence='CONFIRMED')` on both o and c.
This is exactly the MEDIUM-3 liveness contract, and it is what lets the
prefilter resolve a pair whose imported side is stale after the post-import
sweep.

### 3. chdir fix (yashr-d8b) -- LANDED CLEAN

- Zero process.chdir calls remain in the import/sweep path: grep over src/
  finds process.chdir only in explanatory COMMENTS (file-hash.ts:10,
  sqlite-provider.ts:436-437, kb-import.ts:190). sweepAnchored() is deleted.
- kbImport() now calls provider.freshnessSweep(repoAnchor) directly.
- Regression test present (kb-import.test.ts:299) spies process.chdir and
  asserts it is NEVER called during kbImport(), with tmpRepo deliberately
  different from the process cwd.
- computeFileHashBatch(paths, {cwd}) anchoring is correct: relative paths are
  resolved via path.join(root, p) for existence/sha256 and git runs with
  {cwd: root}; the returned map is keyed by the ORIGINAL unresolved path so
  every existing caller's basis-map keys still match; absolute paths pass
  through unchanged; omitting cwd preserves prior behavior exactly.

### 4. T3.2 docs -- COMPLETE and ACCURATE

- tpl-kb-reconciler.md states all three binding rules explicitly and as
  "Rules": single write path (kb_resolve_contradiction only, NEVER
  kb_promote+kb_feedback composed, with the reason); active directives NEVER
  auto-retired (Step 2 + rule); downvoted winners stay retired (Step 7 +
  rule, "do not fix it"). Model tier stated (claude-sonnet-4-6). NEVER-delete
  stated. Report shape {pairs, code_decided, tier_decided, deferred}.
- kb-reconcile.md documents the 5-step ladder in exact tool-name order:
  kb_import -> kb_freshness_sweep -> kb_reconcile_prefilter -> reconciler
  agent -> kb_export. Matches the actual registered tools. Trust-boundary
  paragraph present; the "no post-prefilter sweep needed" note present.
- SKILL.md: command-table row for /pm kb-reconcile (line 127), lifecycle
  line ("after merging branches: /pm kb-reconcile", 210), cleanup post-merge
  hook (270), Commands bullet (274), and both new files in Sub-documents
  (293-294).

### 5. T3.3 e2e -- GENUINELY PROVEN (ran green here, 738ms)

The single e2e test exercises the full chain end to end in a real temp git
repo + temp KB: duplicate skipped (AUDN none), refinement superseded,
contradiction flagged with the correct pair asymmetry (original
flagged_for_review=1, challenger UNVERIFIED + contradiction_of), directive
pending (never active). It changes a PRE-EXISTING branch-A file before the
sweep and asserts the sweep retires that wrong-branch entry WITHOUT staling
the freshly-imported challenger (honoring the Phase 2 LOW-1 guidance -- it
does NOT claim the sweep stales a fresh import). flaggedPairs() still returns
the pair despite the stale member (liveness). The prefilter resolves the
hash-decidable pair (challenger CONFIRMED + stale=0 + passes
list({confidence:'CONFIRMED'}); loser superseded + stale=1 + flag cleared)
and counts the empty-basis, hash-undecidable pair in left_for_agent with its
rows untouched. kb_export's bible contains the winner and excludes the
superseded loser and the pending directive.

### 6. Sprint-wide -- ALL SATISFIED

- Build clean; 2047 pass / 0 fail (expected 2047 exactly).
- ASCII sweep clean (see Verification).
- No mass migration: schema growth is forward-only ALTER TABLE ADD COLUMN
  (source_file_hashes) -- no data migration.
- main untouched; no PR.
- AUDN-mints-fresh-ids discovery IS captured in the KB (entry 4e194c55,
  "AUDN's flagged/update branches always mint a fresh randomUUID, never the
  preferredId", tags sprint:kb-branch-reconcile/phase:3). Import idempotency
  is NOT broken: the id-first hasEntry() skip carries re-import for entries
  AUDN can never dedupe (symbol-less/file-less -- kb-import.test TEST 3),
  while update/flagged entries necessarily carry symbols/files (AUDN
  update/flagged require symbolsOverlap()/filesOverlap()), so on re-import
  AUDN's content-equality path dedupes them (TEST 4). The two mechanisms
  compose to full idempotency; a symbol-less/file-less entry can only ever be
  AUDN add/none, never update/flagged, so the lost preferredId on those
  branches can never leak a re-add.

### 7. Requirements F1-F6 -- ALL DELIVERED end to end

- F1 (test isolation + TZ): allowed-failure list gone; full suite 0 failures
  (T1.1, verified live).
- F2 (bidirectional staleness): freshnessRevivable() + basisFullyMatches() +
  freshnessSweep() shared predicate; revival proven at e2e (T1.3/T3.3).
- F3 (clamp in capture() choke point): live-proven Phase 2 + re-exercised in
  this review's dist attack seeding.
- F4 (kb_import trusted channel + directive quarantine + provenance
  normalization + idempotency): APPROVED Phase 2, idempotency re-confirmed.
- F5 (prefilter + resolveContradiction single write path + reconciler
  template + PM command/docs): T3.1/T3.2, live-attacked and doc-verified.
- F6 (e2e): T3.3, ran green here.

## Numbered findings

- LOW-1 (informational, non-blocking): reconcilePrefilter()
  (sqlite-provider.ts:1371) and resolveContradiction()'s winner un-stale
  re-hash (line 1301) call computeFileHashBatch WITHOUT the {cwd} anchor that
  the yashr-d8b fix threaded into freshnessSweep() -- so they re-hash the
  pair bases against process.cwd(). This is the documented, CONFIRMED design
  invariant (KB ac6cd709: the reconcile tools have no repo param by design
  and /pm kb-reconcile runs in the merged worktree cwd), and it is no worse
  than the pre-existing checkFreshness/freshnessSweep-default behavior. It is
  called out only because kb_import's sweep now has an explicit anchor while
  these two paths still rely on cwd; if the MCP server process ever runs the
  reconcile tools from a cwd other than the merged worktree, the prefilter
  would hash the wrong files. Acceptable as shipped; a future hardening could
  thread the same root through reconcilePrefilter/resolveContradiction for
  symmetry. Not a gate on this sprint.

## What is correct and load-bearing

- resolveContradiction is the SINGLE write path: linkage refusal +
  superseded refusal + active-directive refusal all fire BEFORE any write;
  winner order is (1) CONFIRMED+note, (2) flag-clear FIRST, (3) THEN D2
  predicate + full-basis re-hash; loser superseded+stale+flag-cleared; never
  deletes. Live-proven against dist.
- flaggedPairs liveness includes stale members, excludes superseded and
  active-directive pairs, and never returns lone downvotes.
- The D2 freshnessRevivable predicate is shared by checkFreshness,
  freshnessSweep, and resolveContradiction -- one implementation, not copies.
- computeFileHashBatch {cwd} anchor removes the process-global chdir with
  identical behavior; regression-tested.
- Docs and template faithfully describe the shipped tools and the three
  binding rules; both new tools registered in src/index.ts with honest
  descriptions.
- Sprint closes at 2047 pass / 0 fail, ASCII-clean, forward-only, main
  untouched, no PR.
