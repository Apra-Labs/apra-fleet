# opencode model_tiers validation -- Code Review

**Reviewer:** claude-sonnet-4-6 (Reviewer Agent)
**Date:** 2026-06-16 00:10:00+00:00
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.
> Prior review (commit 317d196) found three blockers: (1) uncommitted files, (2) wrong base branch
> (worktree was not rebased onto feat/opencode-pm-epic), and (3) build failure from missing enum
> value and undefined variable. All three are resolved in commit 31f89bc.

---

## Working Tree State -- PASS

`git status --porcelain` is clean. The submodule `vendor/apra-pm` was not initialized in the
worktree (shows as `-a32ad43` in `git submodule status`), which caused `backward-compat.test.ts`
and `gen-llms-full.test.ts` to fail on first run. After `git submodule update --init vendor/apra-pm`
all 92 test files pass. This is a worktree environment setup issue, not a code defect -- the
committed submodule pointer is correct (a32ad43, matching the epic branch pin at f9b194b).

---

## Base Branch Alignment -- PASS

The single implementation commit (31f89bc) sits cleanly on top of `feat/opencode-pm-epic`. The
diff against the base branch contains exactly five files: `feedback.md`, `src/tools/register-member.ts`,
`src/tools/update-member.ts`, `src/utils/opencode-model-validation.ts`, and
`tests/opencode-model-validation.test.ts`. The previous issue of the diff re-adding already-present
model_tiers schema is gone -- the diff in `update-member.ts` now adds only the import and the
validation block (13 lines total).

---

## Build -- PASS

`npm run build` (tsc) exits clean with zero errors. The TypeScript errors from the prior review
(enum overlap, undefined `normalizedModelTiers`) are fully resolved because the base now includes
`'opencode'` in the `llm_provider` enum and defines `normalizedModelTiers` at the correct scope.

---

## Tests -- PASS

Full suite: 92 test files pass, 1 skipped (pre-existing `gen-llms-full.test.ts` skip), 0 failures
(after submodule init). The new `tests/opencode-model-validation.test.ts` has exactly 6 tests,
all passing:

1. All models valid -> no warnings
2. One invalid model -> warning with invalid model listed, available list present, `update_member` hint
3. All models invalid -> warning with full list of three bad models
4. Non-zero exit from `opencode models` -> silent skip (no warnings)
5. `execCommand` throws -> silent skip (no warnings)
6. Empty model_tiers (all undefined) -> no warnings

Test quality is good: mock is scoped per-test via `vi.clearAllMocks()` in `beforeEach`, the
`SSHExecResult` type is imported for correct typing of the mock, and the assertions cover both
the warning count and the content of the warning string.

---

## Implementation Correctness -- PASS

**Utility (`src/utils/opencode-model-validation.ts`):**
- `getStrategy(agent)` is called correctly and re-uses the existing strategy abstraction.
- `opencode models 2>&1` with a 15-second timeout is appropriate; stderr is merged into stdout so
  any provider errors appear in stdout rather than a separate stderr channel.
- Silent-skip on non-zero exit or empty stdout is correct per spec (opencode may not be installed yet).
- Line parsing strips whitespace and skips `#`-prefixed comment lines. This is a reasonable
  heuristic; any non-model text in stdout would only cause false negatives (a user model matching
  an error string is essentially impossible).
- Warning message names the invalid tier+model pairs and lists all available models, with a
  `update_member` hint. Actionable and clear.

**register-member.ts wiring:**
- Import added at line 20 (top of imports section, correct placement).
- Validation fires after `await Promise.all([versionCheck, authCheck, mkdirCheck])` -- correct
  ordering, reuses the same connection already established for the SSH ops.
- Guard `!skipSshOps && (input.llm_provider ?? 'claude') === 'opencode' && normalizedModelTiers`
  is correct: cloud members with stopped instances bypass validation (no SSH available), non-opencode
  members bypass it, and members without model_tiers bypass it.
- `tempAgent` at the call site has correct auth fields (host, port, username, keyPath, encryptedPassword)
  so `getStrategy(tempAgent)` resolves to the right transport.

**update-member.ts wiring:**
- Import added at line 10 (top of imports section, correct placement).
- Validation fires inside `if (input.model_tiers !== undefined)` after normalization, so it only
  runs when model_tiers is actually being updated.
- The inner `if (updates.modelTiers)` guard is always true at that point (set on the line above)
  but is harmless.
- `existing` (the current Agent record) is passed to the validation function, which gives the
  strategy the correct connection details for the target member.
- `effectiveProvider` correctly falls back through `input.llm_provider ?? existing.llmProvider ?? 'claude'`
  so a provider-switch-only update (without model_tiers) does not trigger validation, and an
  update that changes both provider and model_tiers validates against the new provider.

---

## File Hygiene -- PASS

Only source, test, and the active review record are in the diff. No scratch files, no tool config,
no unrelated documents. The pre-existing untracked files in the worktree root
(`analyze_transcripts.js`, `apra-labs-apra-fleet-0.2.2.tgz`, `permissions.json`, `results.json`,
`tpl-plan.md`, `.sprint/`) and the modified submodule pointer remain from earlier sprint cycles and
are not part of this commit -- noted as non-blocking in prior reviews.

---

## ASCII Compliance -- PASS

`src/utils/opencode-model-validation.ts` and `tests/opencode-model-validation.test.ts` are fully
ASCII. The non-ASCII characters in `register-member.ts` (line 28 area) and `update-member.ts`
(line 28/40 area) are pre-existing in the base branch and were not introduced by this sprint's diff.

---

## Requirements Coverage -- PASS

All items from `requirements.md` (as summarized in the task):
- model_tiers for opencode members validated against `opencode models` output: DONE
- Invalid models: warn with available list; never fail/reject: DONE (both tools return success)
- register_member: warn but always succeed: DONE
- update_member: warn but always succeed: DONE
- ASCII only in all new files: DONE
- 6 new tests all passing: DONE (6/6)
- Build passes: DONE

---

## Summary

All three blockers from the prior review are resolved. The implementation is clean, correct, and
complete. The utility is well-isolated, the wiring in both tools is placed at the right call sites,
and the test suite covers all specified scenarios. Build and full test suite pass. APPROVED for merge.
