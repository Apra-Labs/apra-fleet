# Design -- KB Branch Reconcile

Binding decisions for the kb-branch-reconcile sprint (epic yashr-ii1).
Deviations need a recorded reason in progress.json notes.

Relevant code (state after kb-inflight-capture, verified 2026-07-07):
- src/services/knowledge/sqlite-provider.ts -- capture() holds the directive
  proposal gate; checkFreshness() (prime-time, sets stale=1 only); promote()
  refuses directives; feedback() sets stale+flag; list()/query() tag filter;
  source_file_hashes column (JSON map) written at capture.
- src/tools/kb-capture.ts -- general INFERRED clamp lives HERE (handler layer);
  directive transformation lives in provider.capture() (choke point).
- src/tools/kb-export.ts -- bible writer + auto-commit (pm-kb, pathspec-only);
  resolveRepoPath precedence (explicit > validated cwd > refuse).
- src/tools/kb-session-prime.ts -- prime pipeline; cold-seed reads bibles
  OUTPUT-ONLY (never writes DB).
- src/cli/kb-directives.ts + kb-commit.ts -- CLI subcommand pattern (argv
  dispatch in src/index.ts, never MCP-exposed for directives).
- Provenance enums (Author, CaptureSource) stamped at tool layer;
  CaptureSource already includes... verify; add 'import' if absent.
- tests: kb-session-prime.test.ts has 4 env-leaking tests (real KB/bible via
  cwd); time-utils.test.ts has 2 TZ-dependent failures.

## D1 -- Test isolation first (F1)

- kb-session-prime tests: every test that touches cold-seed/graph-neighbor
  paths must run against a temp-dir KB and a mocked/injected repo root -- no
  test may resolve the developer's real cwd repo or ~/.apra-fleet data. Use
  the existing vi.hoisted + vi.resetModules pattern; inject resolveRepoPath or
  set an explicit repo param fixture.
- time-utils tests: force a fixed timezone (e.g. construct dates from fixed
  epoch + explicit offset expectations, or vi.stubEnv TZ where the impl reads
  it) so assertions hold in any zone. Do not weaken what the tests assert.
- From this task onward the sprint's VERIFY criterion is ZERO test failures.

## D2 -- Bidirectional staleness with a reason discriminator (F2)

Problem: stale=1 is set by three different actors -- freshness mismatch
(prime), supersede (AUDN update), feedback (downvote). Un-staling may ONLY
revive freshness-staled entries; a superseded or downvoted entry must stay
retired even if its files match again.
- Discriminator WITHOUT migration: superseded entries carry superseded_at
  (never un-stale those); feedback entries carry the "[feedback ...]" note in
  content AND flagged_for_review=1. Decision (HARDENED per plan review): the
  un-stale predicate is stale=1 AND superseded_at IS NULL AND
  flagged_for_review=0 AND content_hash != 'invalidated' AND content NOT LIKE
  '%[feedback %' AND the re-hash of the FULL stored basis matches current
  files. The two extra conjuncts close: (MEDIUM-1) invalidate() is a FOURTH
  stale actor (sets stale=1, flagged=0, superseded NULL, basis unchanged) --
  explicitly invalidated entries must never auto-revive; (MEDIUM-2) a
  feedback-downvoted entry whose flag was later cleared (e.g. by a
  flag-clearing flow) must stay retired -- the "[feedback " content marker is
  the durable downvote record. Test EACH exclusion.
- Where: extend checkFreshness() (prime-time) to do both directions over the
  primed candidate set, PLUS a new provider method freshnessSweep() that runs
  the same predicate over ALL entries with a non-empty basis (bounded: one
  computeFileHashBatch over the union; the KB is <1000 entries -- fine for an
  explicit command, NOT wired into prime). freshnessSweep returns
  {checked, staled, unstaled}.
- Prime-time un-stale caveat: prime's candidate set excludes stale entries by
  definition, so prime alone cannot revive them. The revive path is
  freshnessSweep (invoked by /pm kb-reconcile and by kb_stats? NO -- stats
  stays read-only). Also expose freshnessSweep as part of the kb_import tool
  flow (D3) and the reconcile command. Document that branch-switch revival
  requires a sweep (reconcile or import), not just a prime.

## D3 -- kb_import: trusted-channel import with directive quarantine (F4)

- New src/tools/kb-import.ts + provider support. Input { path? , repo?,
  scope?: 'project' } -- resolves the bible file via explicit path else
  resolveRepoPath(repo)/.fleet/kb-canonical.json.
- Each bible entry routes through provider.capture() (the AUDN choke point) so
  dedupe/supersede/flag semantics apply -- with an IMPORT MODE flag that:
  (a) preserves the entry's bible confidence for NON-directive types. Rationale
  (binding): the bible is a git-reviewed, human-merged artifact -- the trusted
  channel; re-clamping would demote the entire team's CONFIRMED knowledge on
  every import. This is the sole exemption to the F3 provider clamp besides
  approveDirective, and it is stamped source='import' (add to CaptureSource if
  absent) so provenance shows the channel.
  (b) FORCES type='user-directive' entries to pending proposals (the existing
  directive gate path applies -- never active via import; same security
  property as cold-seed). A bible cannot smuggle an active directive.
- Idempotency: an entry whose id OR content-identical AUDN match already exists
  -> skipped (AUDN 'none'). Re-import of the same bible = all skipped. Track
  and report {imported, skipped, superseded, flagged}.
- Preserve original ids where possible (bible id becomes the entry id if free)
  so re-import dedupe is exact; on id collision with different content, let
  AUDN decide (update/flag) under a fresh id.
- Registered as MCP tool kb_import AND CLI `apra-fleet kb import [--repo ...]
  [--path ...]`. After import, run freshnessSweep (D2) so imported entries
  whose basis does not match this worktree are immediately staled rather than
  serving wrong-branch claims.
- PROVENANCE HARDENING (MEDIUM-4): provider.capture() must NORMALIZE the
  source field -- a deserialized caller-supplied source of 'import' (or
  'promotion') is overwritten with the route-appropriate value unless the
  internal import mode is actually engaged. Forged trusted-channel provenance
  via HTTP/MCP body is thereby impossible. Test it.
- TRUST BOUNDARY (LOW, document in the tool description + kb-reconcile.md):
  kb_import reads a caller-named local file; a local caller with tool access
  could import a hand-crafted bible. This is equivalent in power to the
  already-exposed kb_promote surface and is accepted under the local trust
  model -- the unforgeable tier remains user-directives (CLI-gated). State it,
  do not pretend otherwise.

## D4 -- Hash prefilter for flagged pairs (F5 step 3) -- HARDENED per plan review

- New provider read: flaggedPairs() -- flagged entries joined to their
  contradiction_of counterpart. LIVENESS (MEDIUM-3): pair membership requires
  ONLY superseded_at IS NULL on both sides -- stale members MUST be included
  (the imported side of a pair is typically stale after the post-import sweep;
  the default "live = not superseded AND not stale" filter would silently
  return no pairs). State this explicitly in the method contract + test.
- Resolution is a DEDICATED provider method resolveContradiction(winnerId,
  loserId, evidence) -- not composed from promote()+feedback() (HIGH fix):
  - WINNER: set confidence='CONFIRMED' directly with the evidence note
    appended (the merged code IS the verdict -- reconcile is
    verdict-equivalent; promote()'s one-step ladder cannot lift the
    UNVERIFIED contradiction-born entries AUDN produces). Clear the winner's
    stale ONLY via the D2 safe predicate (so an invalidated or
    feedback-downvoted winner stays retired -- MEDIUM-2: a downvoted entry
    that wins on hash keeps its downvote; it wins the CONTRADICTION, not its
    reputation). Clear the winner's flag.
  - LOSER: superseded_at=now + stale=1 + flag cleared (retired with audit
    trail -- the existing invariant).
  - This method is what makes F6's e2e chain satisfiable: winner ends
    CONFIRMED + un-staled (when predicate allows) and therefore reaches the
    kb_export bible (which filters CONFIRMED + stale=0).
- For each pair, re-hash both sides' bases against the current worktree:
  exactly one side fully matches -> resolveContradiction(matching, other,
  "hash-basis match on merged worktree"). Both match / both mismatch / either
  side has no basis -> leave for the agent rung.
- Never applies to pairs involving an ACTIVE user-directive (flag stays for
  the human; directives outrank mechanics).
- Surface per planner R1: MCP tool kb_reconcile_prefilter; the reconciler
  agent (D5) uses the SAME resolveContradiction method for its code-decided
  resolutions (one write path for all reconcile outcomes).

## D5 -- Reconciler agent (F5 step 4)

- New skills/pm/tpl-kb-reconciler.md (role template) + skills/pm/
  kb-reconcile.md (PM flow doc) + SKILL.md command-table row + a line in the
  completion/cleanup flow ("after merging branches, run /pm kb-reconcile").
- The agent: for each remaining flagged pair, read the MERGED code via
  code_context/code_impact/code_query (never Glob/Grep), decide which claim
  the code supports; winner -> kb_promote with evidence note citing file+
  symbol; loser -> kb_feedback (flag+stale) or capture a superseding
  correction; code silent -> trust tier (CONFIRMED > INFERRED > UNVERIFIED);
  still undecidable -> leave flagged for /pm kb-review with a note appended.
  Active user-directives are NEVER auto-retired (flag only). Cheap/standard
  model tier. Report: {pairs, code_decided, tier_decided, deferred}.
- Runs AFTER import + sweep + prefilter; ends with kb_export (auto-commits).

## D6 -- E2E simulation shape (F6)

- Provider/tool-level test, temp git repo + temp KB: seed branch-A claims
  (with hash bases from fixture files), write a branch-B bible fixture
  (duplicate + refinement + contradiction entries), kb_import it, run
  freshnessSweep + prefilter. Assert: duplicate skipped; refinement superseded
  the old (superseded_at + stale, per existing semantics); contradiction
  flagged; after modifying fixture files to the "merged" state where B's claim
  matches, the prefilter resolves it (B promoted, A superseded, flags
  cleared); export writes the reconciled set. Directive-in-bible fixture ->
  pending proposal, never active.

## Phasing (risk order)

P1: F1 (test isolation FIRST -- everything after runs at zero-failure), F3
(clamp relocation -- touches the same capture() choke point F4 needs; land
before import mode), F2 (bidirectional staleness + freshnessSweep).
P2: F4 (kb_import, depends on F3's clamp location + F2's sweep).
P3: F5 (prefilter + reconciler template + PM command/docs), F6 (e2e), final
VERIFY.

Shared files: sqlite-provider.ts touched by F2, F3, F4, D4 -- strictly
sequence; kb-capture.ts by F3; kb-session-prime tests by F1 then F2's tests;
kb-export.ts untouched except reconcile invokes it.
