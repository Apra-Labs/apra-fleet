# update-member model_tiers -- Code Review (Re-review)

**Reviewer:** claude-sonnet-4-6 (automated)
**Date:** 2026-06-15 22:10:00-04:00
**Verdict:** APPROVED

> Prior review (commit 4117980) found two blockers: (1) change was uncommitted /
> dirty working tree, and (2) update_member model_tiers had zero test coverage.
> Both are addressed in commit 25b873b.

**Doer:** fixed in commit 25b873b -- committed all changes; added 5 update_member
model_tiers tests in tests/model-tiers.test.ts; updated opencode-provider test to
match corrected classifyError behavior.

---

## Blocker 1 -- Uncommitted Change

RESOLVED. The previously uncommitted delta is now committed at 25b873b. `git
status --porcelain` still shows untracked scratch files and a modified submodule
pointer, but none of these are the code under review. The untracked files
(analyze_transcripts.js, apra-labs-apra-fleet-0.2.2.tgz, permissions.json,
results.json, tpl-plan.md, .sprint/) remain from the prior review cycle and are
not new. The submodule divergence (vendor/apra-pm points at f5a5a71 vs committed
a32ad43) is a local-only drift and is not part of this change -- the submodule
was correctly pinned at a32ad43 in the last submodule bump commit (f9b194b). None
of these affect the correctness or safety of the committed source.

The dirty-tree items have carried over from before and were flagged as non-blocking
in the prior review. They must not be committed. PASS for the blocker; the
pre-existing untracked-file hygiene note stands (non-blocking, unchanged from
prior review).

---

## Blocker 2 -- Test Coverage

RESOLVED. Commit 25b873b adds a `describe('update_member model_tiers
normalization', ...)` block to tests/model-tiers.test.ts with exactly the five
cases required by the prior review:

1. Single model fills all three tiers (standard-only input expands to all).
2. Rejects empty model_tiers and returns early with 'no models' / 'NOT updated'.
3. Fills missing tiers from fallback (cheap + standard given, premium derived).
4. Stores full three-tier map on the member record.
5. Output displays cheap/standard/premium correctly in the result string.

Each test registers a member first, then calls updateMember, then reads back
from the registry to assert the stored value. All five assertions verify both the
return value and the persisted state. Coverage is thorough and parallel to the
register_member suite. PASS.

---

## classifyError Fix (also in 25b873b)

PASS. The prior regex `/not.*found|command not found/i -> 'auth'` was replaced
with `/command not found|is not recognized as an internal or external command/i ->
'unknown'`. The fix is correct:

- `command not found` (POSIX shells) and `is not recognized as an internal or
  external command` (Windows cmd) are genuine "binary not on PATH" signals.
- Returning 'unknown' instead of 'auth' prevents a misleading "/login" suggestion
  when the user simply has not installed opencode.
- The shell case `opencode: not found` (bash `which` style) does NOT match the
  new regex and falls through to the default `return 'unknown'` at the end of
  classifyError. The test correctly expects 'unknown' for this input and passes --
  the assertion is true via the fallthrough path rather than the explicit pattern,
  which is fine.

The opencode-provider.test.ts suite was updated to match: 'auth' expectations
replaced with 'unknown', and the Windows case added. 51 tests pass. PASS.

---

## Build and Test Suite

PASS. `npm run build` exits clean (tsc, no errors). `npm test` reports 1511 tests
passed, 14 skipped, 0 failures across 92 test files (91 passed, 1 skipped). The
net change is +5 tests vs the prior run (1506 -> 1511). No regressions.

---

## CI Status

NOTE (non-blocking). The most recent CI run on this branch was on commit 1e0e0ea
(cancelled) with ba9aba6 being the last green run. Commits 4117980 and 25b873b
were added locally after the last push and have no CI run. Local `npm test` is
fully green and the changes are narrow (new tests, a one-line regex fix, a copy-
paste normalization block). This does not block approval, but CI should be run
against 25b873b before this branch is merged to main.

---

## Previously Noted Non-Blocking Items (unchanged)

- Untracked scratch files (analyze_transcripts.js, permissions.json, results.json,
  apra-labs-apra-fleet-0.2.2.tgz, tpl-plan.md, .sprint/) are still present in
  the working tree. They must not be committed. Gitignore them or remove them
  before the PR merges.
- model_tiers and curated model_cheap/model_standard/model_premium have silent
  mutual-exclusion semantics at dispatch time (modelTiers takes precedence). The
  schema description does not warn about this. Pre-existing gap, not introduced
  here.

---

## Summary

Both prior blockers are resolved:

1. The change is committed (25b873b).
2. All five required update_member model_tiers test cases are present and passing.

The classifyError fix is semantically correct and its tests are updated. Build is
clean, all 1511 tests pass. One advisory item: push 25b873b to trigger CI before
merging. The pre-existing untracked-file hygiene note is repeated for awareness
but does not affect this verdict.

**APPROVED.**
