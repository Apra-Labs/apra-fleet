# SPRINT-FINAL Review -- KB Trust-Ops Sprint (epic yashr-bp2)

Reviewer: pm-reviewer. Target: Phase 3 (T3.1-T3.8 + PM-added T3.7b) plus a
sprint-wide re-check, on branch feat/code-intelligence-abstraction (base main).
Phases 1 and 2 were reviewed and APPROVED previously (Phase 2 verdict is
preserved in git history of this file). Phase 3 commits reviewed: b8825c7 (T3.1
kb_feedback), 7a98072 (T3.2 docs), ccea4be (T3.3 global export), 2b9114a (T3.4
installer copy), ef12973 (T3.5 global cold-seed), 8f3d17f (T3.6 quantitative
templates), 091e612 (T3.7 e2e), cb53ae7 (T3.7b kb commit CLI), 3c8f991 (ASCII
fix), c292f5c (T3.8 VERIFY). Checked against requirements.md (F8-F11), design.md
(D7, D8, D9), PLAN.md (T3.1-T3.8 done criteria), and progress.json.

## VERDICT: APPROVED

0 HIGH, 0 MEDIUM, 3 LOW (all informational / carried-forward). Every Phase 3
acceptance point holds and the two security invariants the sprint exists to
protect are intact after Phase 3: kb_feedback cannot elevate or activate a
directive, and the global-bible distribution path cannot smuggle an active
directive into a cold-seeded project KB. Build clean; full suite 1975 passed,
6 failed, and the 6 are EXACTLY the allowed set (2 timezone yashr-302 + 4
kb-session-prime graph-neighbor yashr-bwc), verified by an isolated re-run of
those two files. ASCII sweep of the sprint's added lines (cb37341..HEAD) is
clean. Main untouched; branch in sync with origin; no PR raised.

## SECURITY RE-CHECK (the gate must survive Phase 3) -- BOTH PATHS SAFE

Answer to the posed question: NO. Neither the feedback path nor the bible path
can reach an ACTIVE directive.

- kb_feedback CANNOT elevate/activate a directive. SqliteProvider.feedback()
  (sqlite-provider.ts:861-887) issues exactly one of two UPDATEs, and NEITHER
  writes the `confidence` column, the `type` column, or the `directive:pending`
  tag. For a normal entry: `stale=1, flagged_for_review=1, content=?`. For an
  ACTIVE directive (type='user-directive' AND confidence='CONFIRMED'):
  `flagged_for_review=1, content=?` only -- stale is left untouched. There is no
  code path in feedback() that can move UNVERIFIED -> CONFIRMED or otherwise
  mint the ACTIVE predicate. Activation remains reachable ONLY via
  approveDirective/addDirective (dedicated CLI methods, not MCP), unchanged
  since T1.1/T1.2.

- The GLOBAL BIBLE path CANNOT smuggle an active directive into a cold-seeded
  KB. Two independent barriers hold:
  1. Getting a directive into kb-canonical-global.json is already blocked
     upstream: kb_capture forces scope='project' for user-directive proposals
     (M1, T1.1), addDirective (CLI) writes providers.project, and kb_export
     scope='global' reads providers.global.list({confidence:'CONFIRMED'}) -- the
     global KB, which no supported flow populates with a directive.
  2. Even if kb-canonical-global.json DID contain a
     type='user-directive'/confidence='CONFIRMED' entry, the cold-seed block
     (kb-session-prime.ts:334-372) ONLY appends synthesized KBEntry objects to
     `result.top_entries` -- the prime OUTPUT JSON. It performs NO database
     write of any kind. The synthesized entries are marked
     via/author='canonical-bible-global' (the canonical marker lives in the
     OUTPUT only). The DB-level directive guards (query()/prime() default
     exclusion, supersede guard, decay guard, promote-ladder refusal) all
     operate on real DB rows, of which the cold-seed creates none. So a directive
     riding the bible would surface at most as a marked context suggestion in one
     prime response, never as a persisted, retrievable-as-directive, or
     guard-protected active directive. The gate is intact.

## T3.1 kb_feedback (F8, D7) -- CONFORMS

- stale + flagged + ASCII note with validated role: CONFIRMED. feedback() sets
  stale=1 + flagged_for_review=1 (non-directive path) and appends
  '\n\n[feedback <ISO>] <author>: <reason>' built by string concatenation (ASCII
  hook gotcha respected). Role validated in the tool layer via a duplicated
  AUTHOR_VALUES/validateAuthor (kb-feedback.ts:9-16, deliberately NOT imported
  from kb-capture.ts per the shared-file sequencing); invalid/absent -> 'unknown'.
- never deletes / never touches confidence: CONFIRMED. Both UPDATE statements
  omit the confidence column and there is no DELETE anywhere in the path.
- USER-DIRECTIVE FLAG-ONLY, never staled -- guard verified: CONFIRMED.
  isActiveDirective = `type === 'user-directive' && confidence === 'CONFIRMED'`
  (same rekey as T1.1's guards). Active directive -> flagged_for_review=1 only,
  stale left as-is. A pending proposal (confidence != CONFIRMED) falls to the
  else branch and stales normally -- proven by a dedicated test.
- CONTENT_CAP respected: CONFIRMED. Note is appended through
  truncateContent(entry.content + note), CONTENT_CAP=4000 (sqlite-provider.ts:33).
- Registered as kb_feedback in index.ts (line 393) with the never-deletes /
  never-demotes / directive-exception wording in the description.

## T3.3/T3.4/T3.5 global bible chain (F9, D8) -- CONFORMS, chain traced end-to-end

- T3.3 kb_export scope='global': reads providers.global via
  source.list({confidence:'CONFIRMED'}), writes .fleet/kb-canonical-global.json
  with the same CanonicalEntry field set and the same asciiSafeStringify +
  id-sorted determinism as project scope. maybeAutoCommitBible() gained a scope
  param used ONLY for the commit-message label ('global knowledge bible'); the
  pathspec-only add+commit, pm-kb identity, content-gating, config off-switch,
  and non-fatal contract are unchanged and apply identically to the global file.
- T3.4 installer copy: copyGlobalBible(repoCwd) (install.ts:444-457) copies
  <repo>/.fleet/kb-canonical-global.json -> FLEET_DIR/knowledge/global/
  kb-canonical-global.json. Absent source -> early silent return (before any dir
  creation); any error -> caught, '[WARN] ...' logged, never thrown. Target dir
  created with mkdirSync({recursive:true}). Called from Step 9 (install.ts:824).
  Non-fatal on every path.
- T3.5 cold-seed merge: a NEW block (kb-session-prime.ts:334-372) appended AFTER
  the existing project-bible block, reading FLEET_DIR/knowledge/global/
  kb-canonical-global.json (homedir-based, the T3.4 target -- NOT the repo). It
  re-checks the SAME shared COLD_KB_MAX threshold against top_entries as built by
  every prior merge, dedupes by id against everything already in top_entries
  (live hits + project bible), marks via:'canonical-bible-global', caps at
  ADDED_ENTRY_CAP, and hard-skips non-fatally on missing/malformed/non-array
  (identical try/catch shape to the project block).
- Existing blocks not restructured: CONFIRMED. Only toCanonicalKBEntry gained an
  optional `via` param defaulting to 'canonical-bible', so the project call site
  (line 304) is byte-for-byte unchanged.
- Ordering end-to-end: live hits -> global-KB FTS append -> graph-neighbor ->
  project bible -> global bible. Global-bible entries land strictly below
  project-bible entries, per D8. Correct.
- Degrade paths: installer absent/error non-fatal; cold-seed
  missing/unreadable/malformed/non-array all leave `result` exactly as built;
  warm session (>= COLD_KB_MAX) never enters either bible block.

## T3.7b kb commit CLI -- CONFORMS, closes Phase 2 LOW-1

- Thin wrapper over kbExport (kb-commit.ts): kbCommitCmd takes an injected
  KbExportFn, parses [--repo <path>] [--global], calls
  exportFn({ repo_path, scope: global ? 'global' : 'project' }), prints the
  export count/path/scope + committed true/false, returns 0 on success and 1 on
  any thrown/parse error. No new git or repo-path logic -- resolveRepoPath
  precedence stays inside kb_export (explicit --repo > validated cwd, T1.6).
- CLI-only, NOT MCP-exposed: CONFIRMED. Wired ONLY into the src/index.ts kb
  subcommand dispatch (subCmd === 'commit', lines 129-136); there is no
  server.tool('kb_commit', ...) registration anywhere.
- Closes the Phase 2 LOW-1 dangling reference: the amended-D5 fleet_status
  bible-drift anomaly message tells operators to "run apra-fleet kb commit", and
  that command now exists and does exactly that (re-export + auto-commit).

## T3.6 quantitative templates (F10, D9) -- CONFORMS

- tpl-planner.md carries the numbered thresholds (coverage >= 0.8 ->
  cheap/standard; < 0.3 -> premium + front-load; between -> judgment), the
  explicit "PLAN.md's model rationale MUST cite the coverage number" requirement
  with an example, the kb_stats-unavailable qualitative fallback, and a
  Self-critique citation-check bullet.
- doer-reviewer-loop.md's planner dispatch block (lines 134-137) carries the same
  kb_stats-then-threshold instruction, the citation requirement, and the
  unavailable fallback. Both planner surfaces covered. Template text only, no
  code touched.

## T3.7 flagged-pipeline e2e (F11) -- CONFORMS

- tests/knowledge/kb-flagged-pipeline.test.ts drives the real tool layer
  (kbCapture/kbFeedback/kbQuery) + provider primitives. Stage 1: A vs B
  contradiction -> B.audn_decision 'flagged', A.flagged_for_review=true,
  B.contradiction_of=A. Stage 2: kb_feedback downvotes unrelated C ->
  stale+flagged. Stage 3: flagged_only returns all three (A,B,C) with non-empty
  content (the tool forces include_stale so C is not dropped). Stage 4/5: resolve
  via promote(B)x2 + a corrective capture that supersedes A, then asserts the
  ACTUAL post-resolution reality -- A (superseded) drops out of flagged_only,
  B (promoted winner) REMAINS listed because kb_promote never clears
  contradiction_of, C remains until separately resolved; final flagged_only
  total=2, not 0.
- Non-directive entries used throughout (directive resolution is CLI-only, out
  of scope for the agent-resolvable flow). CONFIRMS.
- kb-review.md corrected to match observed reality (Step-4 supersede mechanics +
  a "Verified actual behavior" note that a kb_feedback-downvoted entry stays
  listed until separately resolved, line 84). Doc-vs-code mismatch resolved in
  favor of documented reality, per resolution 7.

## Sprint-wide done criteria -- ALL MET

- npm run build: CLEAN (tsc, no output).
- npm test (full suite): 1975 passed, 6 failed, 14 skipped. The 6 are EXACTLY
  the allowed set, verified by an isolated re-run of the two files:
  tests/time-utils.test.ts -> 2 failed (toLocalISOString offset +
  minute-preservation, yashr-302); tests/knowledge/kb-session-prime.test.ts ->
  4 failed, ALL inside the "graph-neighbor expansion" describe block
  (graceful-skip x2, isError-context, FTS-hostile-neighbor, yashr-bwc, the
  unmocked-process.cwd() real-KB leak). The T3.5 global-bible cold-seed lives in
  a separate describe block and passes; no new/different failures.
- F1 fail-then-pass gate present and green: tests/knowledge/kb-directive-gate.
  test.ts (8 tests), unchanged since T1.3.
- ASCII sweep over the sprint's added lines (git diff cb37341..HEAD, added-lines
  only, > U+007F scan): CLEAN, zero hits (the T3.8 em-dash fix in
  install.test.ts's describe title is the last remaining violation and is
  resolved).
- No mass migration: forward-only. feedback()/approve/reject/addDirective all
  operate on a single addressed row; no bulk rewrite of historical rows anywhere
  in Phase 3.
- Main untouched (main at 5526fe7, branch HEAD c292f5c), branch in sync with
  origin (rev-list left-right 0 0), no PR raised. Only untracked
  orchestrator-scratch dirs (.claude/skills/, .claude/worktrees/) remain, as in
  every prior VERIFY.

## Findings

LOW-1 (informational, bible-seed does not filter directive types). The
global-bible cold-seed's toCanonicalKBEntry copies `type` verbatim and defaults
absent confidence to 'CONFIRMED', so a hypothetical type='user-directive' row in
kb-canonical-global.json would appear in the prime OUTPUT top_entries marked
via='canonical-bible-global'. This is OUTPUT-ONLY and never persisted (see the
security re-check above), and two upstream barriers make such a row nearly
impossible to create, so it is not a trust breach -- purely a display note.
Optional future hardening: skip type='user-directive' entries when seeding from
any bible, since a directive should only ever be activated through the CLI.
Non-blocking.

LOW-2 (informational, kb commit "not committed" reason is generic). kb_export's
returned `committed:false` does not distinguish "no change" from "autoCommit
disabled" from "not a git repo", so the CLI prints all three as one message. The
progress note acknowledges this; it matches kb_export's own contract. Cosmetic.

LOW-3 (informational, carried from Phase 1/2). The 4 kb-session-prime
graph-neighbor failures (yashr-bwc) are an environmental real-KB leak (unmocked
process.cwd() reads this repo's own .fleet/kb-canonical.json), not a Phase 3
regression -- confirmed unchanged by T3.5, which adds a separate, passing
describe block. Already tracked.
