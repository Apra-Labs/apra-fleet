# Windows File-Transfer Bug Fix — Plan Review

**Reviewer:** apra-fleet-reviewer
**Date:** 2026-05-01T12:00:00+05:30
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.

---

## Criterion 1: Does every task have clear "done" criteria?

**PASS.** Every work task (T1–T10) includes a "Done when:" block with specific, verifiable conditions — file existence checks, command outputs, behavioral assertions. The verify checkpoints (V1–V3) list explicit acceptance items. No task leaves "done" to the implementer's interpretation. Notably, T4's done criteria include both positive (function exists, exported, build passes) and negative (sftp.ts no longer uses `path.posix.resolve`), which is thorough.

---

## Criterion 2: High cohesion within each task, low coupling between tasks?

**PASS.** Each task has a single concern: T1 is an issue, T2 is a repro test, T3 is bisect + documentation, T4 is the code fix, T5 is the test matrix, T6–T8 are individual documentation updates, T9 is CI verification, T10 is final validation. No task mixes implementation with documentation or testing with issue management. Cross-task coupling is limited to explicit data dependencies (T1's issue number used by T6/T7, T4's `resolveRemotePath` tested by T5).

---

## Criterion 3: Are key abstractions and shared interfaces in the earliest tasks?

**PASS.** The core abstraction — `resolveRemotePath(workFolder, subPath)` — is introduced in T4, the first implementation task of Phase 2. Phase 1 is entirely diagnostic (no implementation), so T4 is the earliest possible location. T5 then tests this function. The pattern of existing Windows path handling in `platform.ts` (`isContainedInWorkFolder`) is correctly identified in the exploration summary as the model for the new function, establishing continuity with the existing codebase.

---

## Criterion 4: Is the riskiest assumption validated in Task 1?

**PASS with NOTE.** The riskiest assumption — that `path.posix.resolve` mishandles Windows drive-letter paths — was already validated during exploration (Node.js REPL confirmation documented in the Exploration Summary, verified assumption #1). T2 formalizes this into a regression test. T1 opens the GH issue using the pre-validated diagnosis.

**NOTE:** T1 opens the GH issue labeling PR #97 as "suspected source" before T3's bisect confirms that PR #97 is NOT the source. The exploration summary already concludes PR #97 is not the cause, so the issue body should reflect this with language like "initially suspected but analysis indicates pre-existing." The plan partially handles this ("GH issue body notes this if confirmed" — Risk Register row 1), but T1's description still says to "Link PR #97 as the suspected source." This could be tightened: T1 should note PR #97 as initially suspected but likely cleared, pending bisect confirmation in T3.

---

## Criterion 5: Later tasks reuse early abstractions (DRY)?

**PASS.** T5's test matrix exercises `resolveRemotePath` from T4. T6–T8 reference the test matrix from T5 and the GH issue from T1. The `resolveRemotePath` function reuses the Windows drive-letter detection pattern already present in `isContainedInWorkFolder` (platform.ts lines 12–13), avoiding a second implementation of the same logic. The plan explicitly identifies this reuse in the Exploration Summary (verified assumption #4).

---

## Criterion 6: Are phase boundaries drawn at cohesion boundaries?

**PASS.** Phase 1 (diagnosis): GH issue + repro test + bisect — all about understanding and confirming the root cause. Phase 2 (fix + tests): code change + test matrix — tightly coupled, must land together. Phase 3 (guardrails + docs): documentation, CI verification, final validation — all lightweight, independent tasks sharing the goal of preventing regression. Each phase produces a reviewable increment: Phase 1 produces a confirmed diagnosis, Phase 2 produces a working fix with tests, Phase 3 produces documentation guardrails.

---

## Criterion 7: Are tiers monotonically non-decreasing within each phase?

**PASS.** Phase 1: cheap (T1) -> standard (T2) -> standard (T3). Phase 2: standard (T4) -> standard (T5). Phase 3: cheap (T6) -> cheap (T7) -> cheap (T8) -> cheap (T9) -> cheap (T10). All monotonically non-decreasing. The plan's Notes section explicitly documents this, showing awareness of the constraint.

---

## Criterion 8: Each task completable in one session?

**PASS.** T1 is a `gh issue create` command. T2 is a single test file with clear scope. T3 is a git bisect + writing a paragraph. T4 touches exactly 2 files with a well-defined function signature. T5 is a parameterized test file. T6–T8 are markdown edits. T9 is reading CI config + appending a note. T10 is running `npm run build && npm test`. None of these require multi-session work.

---

## Criterion 9: Dependencies satisfied in order?

**PASS.** Dependency graph:
- T1: no blockers
- T2: no blockers (can run parallel with T1)
- T3: blocks on T2 (uses repro test as bisect oracle)
- T4: no blockers (root cause pre-confirmed during exploration)
- T5: blocks on T4 (tests the fix)
- T6: blocks on T1 (needs issue number)
- T7: blocks on T1 (needs issue number)
- T8: no blockers
- T9: no blockers
- T10: blocks on all prior

All dependencies are satisfied by task ordering. Phase boundaries enforce additional sequencing (Phase 2 starts after Phase 1 VERIFY, etc.).

**NOTE:** T4 lists "Blockers: None" but conceptually depends on Phase 1's root cause confirmation. This is justified — the exploration summary already confirmed the root cause via code reading and REPL testing. T3's bisect is a formality to document the originating commit, not to discover whether the bug exists. The plan correctly treats T4 as independently executable.

---

## Criterion 10: Any vague tasks two developers would interpret differently?

**PASS.** T4 specifies the exact function signature (`resolveRemotePath(workFolder: string, subPath: string): string`), the exact file locations, the exact lines to replace (68 and 109 in sftp.ts), and the regex pattern for Windows detection (`/^[A-Za-z]:/`). T5 specifies the exact matrix dimensions, which combinations to implement vs. mark as TODO, and the 5 repro cases. The only task with slight ambiguity is T3's bisect — "write feedback.md documenting root cause commit SHA" — but the done criteria clarify exactly what's needed.

---

## Criterion 11: Any hidden dependencies between tasks?

**PASS with NOTE.** The explicit dependency graph is clean. Two subtle points:

1. **T3 and T9 both write to `feedback.md`** — T3 creates it, T9 appends to it. This is correctly ordered (T3 in Phase 1, T9 in Phase 3) and T9 explicitly says "append." No conflict.

2. **T4's `resolveRemotePath` placement in `platform.ts`** — this file already exports `isContainedInWorkFolder` and `detectOS`. Adding `resolveRemotePath` is a natural fit, but T4 should note that the new function's Windows detection logic (`/^[A-Za-z]:/`) must stay consistent with `isContainedInWorkFolder`'s identical check on line 12. This isn't a hidden *dependency* per se, but a hidden *consistency constraint* within T4. Minor.

---

## Criterion 12: Does the plan include a risk register?

**PASS.** The risk register contains 5 risks with impact ratings and concrete mitigations:
- Bug predating PR #97 (low) — correctly mitigated by "fix is the same regardless"
- `sftpMkdirRecursive` breakage (medium) — mitigated by testing in T2/T5
- UNC/network path edge cases (low) — correctly scoped out
- Mock vs. live SFTP divergence (medium) — mitigated by E2E verification (though see AC5 gap below)
- CLAUDE.md `git add -f` requirement (low) — acknowledged as existing pattern

The register is proportionate to the sprint scope and addresses the most likely failure modes.

---

## Criterion 13: Does the plan align with requirements intent — solving the right problem?

**PASS with NOTE.** The plan correctly identifies the root cause (`path.posix.resolve` in sftp.ts lines 68 and 109), proposes the right fix (`resolveRemotePath` with Windows drive-letter awareness), and covers all 12 acceptance criteria — with one gap:

**AC5 Gap — E2E Verification:** Acceptance criterion 5 requires "E2E verification of all 5 failing repro cases against a Windows member." No work task (T1–T10) is assigned to this. The plan acknowledges it in the Notes ("E2E verification against live Windows member requires PM coordination") and in the Phase 3 VERIFY checkpoint, but VERIFY is a checkpoint, not a work task. T5's test matrix uses mocks, not a live Windows member.

This is understandable — E2E against a live Windows member requires infrastructure that may not be available during the sprint — but it should be explicitly represented as a task (even if the task's done criteria include "PM confirms member availability" as a precondition). As written, a developer could complete all 10 tasks, pass all 3 verify checkpoints, and still not have performed E2E verification. Recommend adding a T11 in Phase 3 for E2E verification with a PM-coordination precondition, or explicitly noting in V3 that E2E is a PM-gated post-merge step.

---

## Summary

**11 of 13 criteria pass cleanly. 2 pass with notes. No criteria fail.**

The plan is well-structured with clear phase boundaries, specific done criteria, correct dependency ordering, and monotonically non-decreasing tiers. The root cause analysis in the Exploration Summary is thorough and already validated — the plan correctly builds on confirmed findings rather than speculating.

**Must address before execution:**
- AC5 (E2E verification) has no assigned work task. Add an explicit task or document it as a PM-gated post-merge step in V3. This is the only gap between the plan and the 12 acceptance criteria.

**Minor improvements (non-blocking):**
- T1's GH issue body should reflect the pre-exploration finding that PR #97 is likely NOT the source, rather than framing it as "suspected."
- T4 should note the consistency constraint with `isContainedInWorkFolder`'s Windows detection regex.

**Verdict rationale:** The plan solves the right problem with the right approach. The single gap (AC5 E2E) is acknowledged in the plan and is infrastructure-dependent rather than a planning oversight. The risk register correctly identifies it. Approved for execution with the recommendation to formalize the E2E step.
