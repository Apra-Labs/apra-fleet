# Phase 1 Code Review -- KB Branch Reconcile Sprint (epic yashr-ii1)

Reviewer: pm-reviewer. Reviewing Phase 1 (T1.1-T1.4) of the
kb-branch-reconcile sprint against PLAN.md (revision 3), requirements.md
(F1-F3), and design.md (D1, D2 hardened, D3). Commits reviewed: 9ece587
(T1.1 test isolation + TZ), 3bf2281 (T1.2 clamp relocation), 848f2a1 (T1.3
bidirectional staleness). Prior plan-review verdicts (Rounds 1-3) are
preserved in this file's git history.

## VERDICT: APPROVED

0 HIGH, 0 MEDIUM, 1 LOW. Phase 1 is correct, hermetic, and matches the
hardened design. The load-bearing T1.3 predicate implements the full
four-actor hardened D2 exactly; every exclusion war-gamed at the provider
level stays retired and a genuine freshness-stale entry revives. Both
fail-then-pass red states reproduced verbatim. Full suite: 2006 passed,
14 skipped, 0 failed (run by this reviewer). Build clean (tsc exit 0).

---

## Verification performed

- npm run build: clean (exit 0).
- npm test (this reviewer's own run): 137 test files, 2006 passed / 14
  skipped / 0 FAILED. The zero-failure criterion from T1.2 onward holds.
- T1.2 red-state reproduced: checked out the provider at 3bf2281~1, ran the
  new gate test -> RED with "AssertionError: expected 'CONFIRMED' to be
  'INFERRED'" (exactly the doer's claim). Provider restored clean.
- T1.3 red-state reproduced: checked out the provider at 848f2a1~1, ran the
  freshness suite -> 8 RED with "TypeError: provider.freshnessSweep is not a
  function" (exactly the doer's claim). Provider restored clean.
- ASCII: no non-ASCII byte appears on any line ADDED by the three Phase 1
  commits (checked + lines only). Pre-existing non-ASCII in src/index.ts
  and tests/time-utils.test.ts is untouched -- correct, per the no-mass-
  migration rule.

## T1.1 -- test isolation + TZ (F1/D1) -- PASS

- The leaking block was `kb_session_prime graph-neighbor expansion`. The fix
  adds a per-test `process.cwd()` spy pointed at a fresh empty temp dir
  (beforeEach) with cleanup (afterEach), so the canonical-bible cold-seed
  (resolveRepoPath -> cwd) finds no bible and cannot read this repo's real
  .fleet/kb-canonical.json. The other two cwd-sensitive blocks
  (canonical-bible cold-seed line ~479, global-bible cold-seed line ~738)
  already carried their own cwd spies; FLEET_DIR is isolated by
  tests/setup.ts. Coverage of the leaking block is real and complete.
- No assertion weakened: the only removed line in the T1.1 diff is the vitest
  import line (widened to add vi/afterEach). All graph-neighbor assertions
  (toEqual id-order, via:'graph-neighbor' marking, NEIGHBOR_CAP=10,
  ADDED_ENTRY_CAP=5, dedupe-by-id) are verbatim.
- TZ fix: `vi.stubEnv('TZ','Asia/Tokyo')` added to the two sub-hour-sensitive
  tests plus a header afterEach unstub; the assertions (toContain('45:30.123')
  etc.) are unchanged. Whole-hour zone pins the same minute/second-preservation
  behavior deterministically.

## T1.2 -- provider clamp relocation (F3/R3) -- PASS

- The ENFORCEMENT clamp sits inside SqliteProvider.capture()
  (sqlite-provider.ts:660-665), AFTER the directive gate (621-633). Gate runs
  first and forces user-directives to UNVERIFIED pending proposals; the clamp
  then downgrades non-directive CONFIRMED -> INFERRED and appends the bracketed
  note. Directive path verified unchanged (test asserts UNVERIFIED + flagged +
  directive:pending, no double clamp note). promote() still mints CONFIRMED.
- R5 fixture fallout migrated via the REAL ladder (capture INFERRED then
  promote) in kb-decay, kb-promote, kb-feedback, kb-claims-proof,
  kb-token-and-learning. No test-only bypass flag added to product code;
  assertions unchanged (still assert CONFIRMED end-state).
- Import-mode seam is a COMMENT ONLY (652-657); capture() still has the single
  `input: KBEntryInput` signature -- no reachable second parameter yet, as
  required. T2.1 owns it.

## T1.3 -- bidirectional staleness + freshnessSweep (F2/D2 HARDENED) -- PASS

- Shared predicate `freshnessRevivable()` (301-312) implements the four
  NON-hash conjuncts (superseded_at NULL, flagged=0, content_hash !=
  'invalidated', anchored feedback marker absent); the callers own the stale=1
  gate and the full-basis re-hash (`basisFullyMatches()`, 321-332). ONE
  implementation, reused by checkFreshness() and freshnessSweep() (and reserved
  for T3.1). The full hardened D2 predicate is stated verbatim in the comment
  at the site (281-290).
- MARKER ANCHORING cross-checked against the writer: feedback() writes
  `'\n\n[feedback ' + new Date().toISOString() + '] '` (line 1090); the regex
  FEEDBACK_MARKER_RE `/\n\n\[feedback \d{4}-\d{2}-\d{2}T/` (279) matches that
  exact newline+ISO-timestamp form, so a learning that merely QUOTES the
  feedback format is not permanently excluded once freshness-staled. Anchoring
  is correct.
- WAR-GAME (each at the provider level, confirmed by code + the individual
  tests, which use the REAL feedback()/invalidate() writers):
  - superseded (superseded_at set, matching basis) -> freshnessRevivable false
    at the superseded_at guard -> stays stale=1. RETIRED.
  - feedback flag standing (stale=1, flagged=1) -> false at the flag guard ->
    stays stale=1. RETIRED.
  - downvote marker with flag CLEARED (flag=0, marker present) -> false at the
    marker guard -> stays stale=1. RETIRED. (This is the MEDIUM-2 laundering
    defense; test 4 simulates the T3.1 flag-clear and asserts the marker
    survives.)
  - invalidated (content_hash='invalidated', flag=0, superseded NULL) -> false
    at the invalidated guard -> stays stale=1. RETIRED. (Test drives real
    invalidate(); asserts flag=0/superseded NULL first.)
  - partial basis (2 files, 1 restored) -> basisFullyMatches false (missing/
    changed file) -> not counted as a match -> stays stale=1. RETIRED.
  - empty/malformed basis -> parseBasis returns null -> excluded from
    basisById -> checked=0, never staled/revived. UNTOUCHED.
  - genuine freshness-stale, files restored byte-identical -> all four
    conjuncts pass AND full basis matches -> revived (stale=0) and re-primed.
    REVIVES.
- checkFreshness cannot revive at prime: candidate set is
  entries.filter(source_files.length>0) drawn from prime's top_entries, which
  query() already filters to stale=0; the un-stale branch is gated on
  `entry.stale && freshnessRevivable(entry)`, so it is a documented no-op at
  prime. The caveat is stated in the code (357-363). Revival surface is the
  sweep only.
- Sweep NOT wired into prime: prime() calls only checkFreshness()
  (sqlite-provider.ts:925); freshnessSweep has exactly one non-test caller,
  the kb_freshness_sweep tool. Confirmed.
- kb_freshness_sweep tool: thin handler over provider.freshnessSweep();
  registered in src/index.ts (203 import, 391 server.tool). freshnessSweep is
  read-only apart from the two `UPDATE entries SET stale = ...` statements.
  Degraded-safe at the data level: computeFileHashBatch returns null for
  missing files (treated as mismatch, not a throw) and falls back to sha256 if
  git hash-object fails.

---

## Findings

### LOW-1 -- kb_freshness_sweep hashes basis paths relative to the process cwd

freshnessSweep() re-hashes stored basis file paths via computeFileHashBatch
with no repo anchoring; the tool exposes no repo/path parameter. This is
consistent with checkFreshness()'s existing prime-time behavior and is within
D2 (a bounded full-KB sweep over the project provider), so it is not a Phase 1
defect. Flagging for T2.1/T3.2 awareness: kb_import runs the sweep internally
AFTER resolving the repo, and /pm kb-reconcile runs in the merged worktree
cwd, so both invoke it from the correct directory -- keep that invariant when
wiring those callers, and ensure basis paths remain worktree-relative so the
sweep re-hash resolves the intended files. No change required in Phase 1.

## Standing confirmations

F1/F2/F3 done criteria met with testable evidence; fail-then-pass demanded and
verified for F3 (provider clamp) and F2 (un-stale core); allowed-failure list
retired (never a literal allowlist -- the 6 known-flaky tests, now green); no
mass migration (forward-only, 5 small fixture edits via the real ladder);
ASCII-only in changed lines; build clean; zero test failures. T1.4 VERIFY
(build + test + gitnexus + push) recorded and consistent with this reviewer's
independent build+test run.

APPROVED for Phase 2.
