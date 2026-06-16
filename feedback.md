# opencode model_tiers validation -- Code Review

**Reviewer:** claude-sonnet-4-6 (Reviewer Agent)
**Date:** 2026-06-15 23:50:00+00:00
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## Working Tree State -- FAIL

`git status --porcelain` is NOT clean:

```
M src/tools/register-member.ts
 M src/tools/update-member.ts
?? src/utils/opencode-model-validation.ts
?? tests/opencode-model-validation.test.ts
```

None of the four implementation files are committed. The two new files are untracked; the two modified files are unstaged. This is an incomplete delivery -- the review cannot accept uncommitted work because `npm test` would run on uncommitted files, and the committed state of the branch would be missing the implementation entirely.

**Required action:** Stage and commit all four files before requesting re-review.

---

## Wrong Base Branch -- FAIL (Critical)

The worktree branch `worktree-agent-aea1380246ab1ed38` has its HEAD at `e4f3ebb` (the main branch tip after the knowledge-bank revert merge). The parent epic branch `feat/opencode-pm-epic` is at `b7e054f`, which is 10+ commits ahead and already contains the following infrastructure that this sprint depends on:

- `register-member.ts`: `'opencode'` added to the `llm_provider` enum; `model_tiers` field added to schema; `normalizedModelTiers` variable declared and populated.
- `update-member.ts`: `'opencode'` added to `llm_provider` enum; `model_tiers` field added to schema; normalization block present.

The doer's diff re-adds the `model_tiers` schema and normalization block to `update-member.ts` (already present on the epic branch) and wires validation into `register-member.ts` against a version that has neither `'opencode'` in the enum nor `normalizedModelTiers` in scope.

**Required action:** Rebase or merge `feat/opencode-pm-epic` into the worktree branch, then re-apply only the validation wiring (the utility and import additions). The model_tiers schema additions in `update-member.ts` must be dropped from this diff -- they already exist on the epic branch.

---

## Build Failure -- FAIL

`npm run build` (TypeScript compilation via `tsc`) fails with three errors:

```
src/tools/register-member.ts(258,24): error TS2367: This comparison appears to be unintentional
  because the types '"claude" | "gemini" | "codex" | "copilot" | "agy"' and '"opencode"' have no overlap.
src/tools/register-member.ts(258,75): error TS2304: Cannot find name 'normalizedModelTiers'.
src/tools/register-member.ts(259,86): error TS2304: Cannot find name 'normalizedModelTiers'.
```

Root cause: the register-member.ts in this worktree's HEAD does not have `'opencode'` in the `llm_provider` enum (line 46), and does not define `normalizedModelTiers` anywhere. The doer injected the Phase 2 validation block referencing both, but against a base file where neither exists.

Tests pass (vitest uses tsx transpilation which suppresses type errors), but the shipped artifact would not build. This is a blocking defect.

---

## Test Suite -- PASS (conditional)

All 6 specified test cases in `tests/opencode-model-validation.test.ts` are confirmed to run and pass:

- All models valid -> no warnings [PASS]
- One invalid model -> warning with tier label and available list [PASS]
- All models invalid -> warning with all invalid tier labels [PASS]
- `opencode models` exits non-zero -> silent skip [PASS]
- `execCommand` throws -> silent skip [PASS]
- Empty model_tiers -> no warnings [PASS]

The overall suite remains at 1378 passed / 14 skipped / 88 test files (matching the expected baseline). No regressions detected in the test run. However, because the build fails and the files are uncommitted, this pass is on the current dirty working tree only and does not represent the committed state.

---

## Utility Implementation Quality -- PASS

`src/utils/opencode-model-validation.ts` matches the PLAN.md spec precisely:

- Correct interface `ModelTierValidationResult { warnings: string[] }`
- Uses `getStrategy(agent).execCommand('opencode models 2>&1', 15000)`
- Parses stdout by splitting on newlines, trimming, filtering empty and comment lines
- Returns empty warnings on non-zero exit code or empty stdout
- Returns empty warnings on thrown exception (catch block)
- Builds `invalidList` and `availableList` correctly
- Single warning string per call, listing all invalid tiers and all available models
- ASCII only: confirmed, no non-ASCII bytes

---

## update-member.ts Changes -- PARTIAL PASS / SCOPE CREEP

The diff to `update-member.ts` contains two distinct categories of change:

1. **Validation wiring** (intended): the `validateOpenCodeModelTiers` import and the validation block inside the model_tiers normalization section. These are correct and align with Phase 3 of the plan. The logic is sound: only runs when `input.model_tiers !== undefined && updates.modelTiers` is set and `effectiveProvider === 'opencode'`. `existing` (the current `Agent` record) is correctly passed as the agent for strategy resolution. PASS on the logic.

2. **Schema additions** (scope creep / duplicate work): the diff also adds `'opencode'` to the `llm_provider` enum and adds the entire `model_tiers` schema field plus the normalization block to `update-member.ts`. These already exist on `feat/opencode-pm-epic` (confirmed via `git show feat/opencode-pm-epic:src/tools/update-member.ts`). Applying them again on the wrong base creates a diff that duplicates already-merged work.

---

## register-member.ts Changes -- FAIL

The Phase 2 wiring block added to `register-member.ts`:

```typescript
if (!skipSshOps && (input.llm_provider ?? 'claude') === 'opencode' && normalizedModelTiers) {
  const { warnings: tierWarnings } = await validateOpenCodeModelTiers(tempAgent, normalizedModelTiers);
  warnings.push(...tierWarnings);
}
```

This block is logically correct for the epic branch's version of `register-member.ts` (where `'opencode'` is in the enum and `normalizedModelTiers` is declared). Against the current worktree HEAD version of `register-member.ts` it produces three TypeScript errors and would dead-letter silently at runtime even if tsc were skipped, because `normalizedModelTiers` would be undefined at that location.

---

## ASCII Compliance -- PASS

All modified and new files contain only ASCII bytes (confirmed via Node.js byte scan).

---

## File Hygiene -- PASS

No stray files (temp files, config artifacts, or unrelated scripts) are present in the worktree root. The four implementation files (utility, test, and two wiring changes) are all within plan scope.

---

## Summary

**What must change before re-review:**

1. **Rebase onto `feat/opencode-pm-epic`**: The worktree must be rebased or merged so that `register-member.ts` and `update-member.ts` already have the `model_tiers` + `'opencode'` enum infrastructure. Without this, the build fails.

2. **Trim the update-member.ts diff**: After rebasing, the schema additions (`model_tiers` field, `'opencode'` in enum, normalization block) must not re-appear in the diff -- they already exist on the base. Only the import and the validation call should appear in the update-member diff.

3. **Commit all four files**: `src/utils/opencode-model-validation.ts`, `tests/opencode-model-validation.test.ts`, `src/tools/register-member.ts`, `src/tools/update-member.ts` must all be committed before re-review.

4. **Build must pass**: `npm run build` must exit 0 after the rebase and commit.

**What passed:**

- Utility implementation is correct and matches the plan exactly.
- All 6 test cases cover the required scenarios and pass.
- Logic of the validation wiring in both tools is correct (for the right base).
- ASCII compliance throughout.
- No regressions in the existing 1378-test suite.
