# update-member model_tiers -- Code Review

**Reviewer:** claude-sonnet-4-6 (automated)
**Date:** 2026-06-15 21:45:00+00:00
**Verdict:** CHANGES NEEDED

> No prior feedback history for this diff. This is the first review of this change.

---

## Working Tree and Build State

FAIL. The change under review is uncommitted. `git status --porcelain` shows
`src/tools/update-member.ts` as a modified unstaged file. Tests were run against
the working tree (which includes the change), not against a committed snapshot.
The policy requires a clean tree before a review can pass. The diff must be
committed before requesting approval.

Additional untracked files present that should not be in the repo:

- `analyze_transcripts.js` -- scratch/analysis script
- `apra-labs-apra-fleet-0.2.2.tgz` -- packed tarball artifact
- `permissions.json` -- tool harness config
- `results.json` -- analysis artifact
- `tpl-plan.md` -- template/scratch file
- `.sprint/` directory (contains `tpl-plan.md`, `tpl-progress.json`, `docs-harvest-id.txt`, `p3-fix-id.txt`, `p7-fix-id.txt`)

These are not sprint-tracked source files and must not be committed. They should
be added to `.gitignore` or removed before the commit lands.

---

## Diff Accuracy

NOTE. The diff submitted for review includes the `opencode` addition to the
`llm_provider` enum as if it were new. It is already committed at HEAD (line 45
of `src/tools/update-member.ts`). The actual uncommitted delta is only the
`model_tiers` schema field, normalization block, and output display line. The
reviewer should evaluate only those three hunks.

---

## Logic Correctness -- Normalization

PASS. The normalization logic is a direct, line-for-line copy of the equivalent
block in `register-member.ts` (lines 116-130 there vs. lines 129-145 here).
Behavior is identical:

- Empty object (`{}`) is caught early and returns an error before writing.
- Single-value map expands to all three tiers (cheap/standard/premium) with the
  same value.
- Multi-value partial map applies the fallback chain: standard ?? cheap ?? first
  non-empty value, then fills missing tiers in that order. Premium falls back to
  standard specifically.

No divergence from the register path. PASS.

---

## Schema Field

PASS. The Zod schema field is structurally identical to the one in
`register-member.ts`. Both use `z.object({ cheap, standard, premium })` with
all subfields optional and the parent optional. Free-form string values are
accepted without pattern restriction, which is the design intent for local model
IDs like `ollama/qwen3-coder:30b`. PASS.

---

## Output Display

PASS. The result string block at line 210-213 mirrors exactly the display added
in `register-member.ts` at lines 321-324. Consistent formatting. PASS.

---

## Interaction with Curated Fields (model_cheap / model_standard / model_premium)

NOTE (non-blocking). When both `model_tiers` and the curated
`model_cheap`/`model_standard`/`model_premium` fields are passed in the same
`update_member` call, both are written to the registry, but at dispatch time
(`execute-prompt.ts` lines 173-185), `modelTiers` is checked first and takes
exclusive precedence -- the curated fields are silently ignored. The schema
description for `model_tiers` does not warn about this. The same gap exists in
`register-member.ts` and is pre-existing. This is a documentation gap, not a
regression introduced by this diff. It should be addressed eventually but does
not block this change.

---

## Test Coverage -- BLOCKING

FAIL. The `update-member.test.ts` and `model-tiers.test.ts` files contain zero
test calls to `updateMember` with `model_tiers`. The `model-tiers.test.ts` suite
covers `register_member` normalization thoroughly (5 cases) but has no parallel
coverage for `update_member`. The following paths in the new code are completely
untested:

1. Empty `model_tiers` rejection via `update_member` (`values.length === 0`
   branch -- returns the `[-] model_tiers was provided but contains no models`
   error).
2. Single-model expansion via `update_member` (`values.length === 1` branch).
3. Partial map fallback via `update_member` (e.g., provide only `standard`,
   confirm `cheap` and `premium` are filled).
4. Full three-tier map stored correctly via `update_member`.
5. Output display: confirm `Model Tiers:` line appears in the success string.

All five of these cases have direct analogues in the `register_member` section
of `model-tiers.test.ts`. They must be added for `update_member` before this
change can be approved.

---

## Build and Test Suite

PASS. `npm run build` succeeds with no errors. `npm test` passes: 1506 tests
pass, 14 skipped, 0 failures (91 test files). The new code does not break any
existing test.

---

## Summary

The normalization logic and schema are correct -- a faithful port of the
`register-member` pattern. The build is clean and all existing tests pass.

Two issues block approval:

1. **BLOCKING -- uncommitted change.** The diff is in the working tree but not
   committed. The review policy requires a clean `git status` before a verdict
   of APPROVED can be issued. Commit the change.

2. **BLOCKING -- missing test coverage.** `update_member` with `model_tiers`
   has zero test coverage. Add at least the five cases enumerated above to
   `tests/update-member.test.ts` or `tests/model-tiers.test.ts` before
   re-requesting review.

Non-blocking:

- The untracked scratch/harness files (`.sprint/`, `permissions.json`,
  `results.json`, `analyze_transcripts.js`, `apra-labs-apra-fleet-0.2.2.tgz`,
  `tpl-plan.md`) should be cleaned up or gitignored. They must not be committed.
- The schema descriptions for `model_tiers` and the curated model fields could
  note their mutual exclusion semantics, but this is a pre-existing gap.
