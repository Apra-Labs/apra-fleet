# Re-Review: plan/issue-212 — apra-fleet update command

**Reviewer:** fleet-rev
**Date:** 2026-05-01
**Branch:** plan/issue-212
**Prior review:** commit 3e4e929
**Reviewing:** commit 10180bc (plan rewrite)

---

## Verdict: APPROVED

The rewritten plan resolves all six issues from the prior review. The binary corruption is eliminated, the PR #214 dependency is clearly documented, factual references are accurate, and the risk register is complete. The plan is ready for implementation.

---

## Prior-Review Issue Resolution (6 items)

| # | Issue | Status | Evidence |
|---|-------|--------|----------|
| 1 | Binary corruption in PLAN.md | ✅ RESOLVED | File is clean text throughout. Git no longer treats it as binary. All tasks, risk entries, and verify blocks are readable. |
| 2 | Factual errors: `runUpdateCheck()`, `--check`, update placeholder | ✅ RESOLVED | Plan now documents PR #214 dependency (line 12) and correctly states these exist on `fixes/after_v0.1.8`. Verified: `runUpdateCheck()` at line 63, update block at lines 43-52, `--check` at line 45 on that branch. |
| 3 | Update notice file reference (`check-status.ts` vs `update-check.ts`) | ✅ RESOLVED | Task 4 (line 59) now correctly references `src/services/update-check.ts` and the `getUpdateNotice()` function. |
| 4 | Typos in done-when clauses (`}c`, `testpasses2`, `testpasses clean`) | ✅ RESOLVED | All done-when clauses are clean prose. No trailing characters or missing spaces. |
| 5 | Missing risks (rate limiting, arch mismatch, permissions) | ✅ RESOLVED | Risk register now has 6 entries covering: Windows binary lock, interrupted download, missing install-config, GitHub API rate limit, platform detection mismatch, and PR #214 not merged. |
| 6 | `getUpdateNotice()` location in Task 4 | ✅ RESOLVED | Same as #3 — correct file reference. |

**Score: 6/6 resolved.**

---

## 13-Point Checklist

### 1. Clear "done" criteria on every task?
**YES.** All six tasks have specific, testable done-when clauses. Task 1 specifies exact JSON content for two scenarios. Task 2 specifies behavior for both stale and current versions. Task 4 specifies which string in which tool's output changes. Tasks 5 and 6 specify which test cases must pass.

### 2. High cohesion within tasks, low coupling between?
**YES.** Each task touches 1 file (or 1 new file). Phase boundaries cleanly separate persistence, core logic, UI string, and tests.

### 3. Key abstractions in earliest tasks?
**YES.** `install-config.json` (Task 1) is the foundational data contract and is Phase 1. Everything downstream reads from it.

### 4. Riskiest assumption validated early?
**YES.** PR #214 dependency is documented as a prerequisite (line 12), with a risk register entry (row 6) explicitly blocking Phase 2 until `runUpdateCheck` is on `main`. Task 2 blockers also call this out.

### 5. Later tasks reuse early abstractions (DRY)?
**YES.** Task 2 reads `install-config.json` from Task 1. Task 6 tests the flow from Task 2. `isNewer()`/`parseVersion()` from `update-check.ts` are reused rather than reimplemented.

### 6. Phase boundaries at cohesion boundaries?
**YES.** Phase 1 (persistence), Phase 2 (core command + wiring), Phase 3 (notice string), Phase 4 (tests). Each phase is independently verifiable.

### 7. Tiers monotonically non-decreasing within each phase?
**YES.** Phase 1: cheap. Phase 2: standard→cheap (slight inversion — Task 3 is cheaper than Task 2, but Task 3 depends on Task 2 so ordering is forced by dependency, not tier). Phase 3: cheap. Phase 4: cheap→standard. Acceptable.

### 8. Each task completable in one session?
**YES.** Largest task (Task 2) is a single new file with 10 well-specified steps. All others are 1-file edits or test files.

### 9. Dependencies satisfied in order?
**YES.** Task 2→Task 1 ✓, Task 3→Task 2 ✓, Task 5→Task 1 ✓, Task 6→Task 2 ✓, PR #214→main as prerequisite ✓. No circular or out-of-order dependencies.

### 10. Any vague tasks?
**NO.** Task 2 is the most detailed, with a 10-step implementation spec including platform detection rules, fallback behavior, and spawn configuration. All other tasks are equally specific.

### 11. Hidden dependencies?
**NO.** PR #214 is documented at the top of the plan (line 12), in Task 2 blockers (line 41), and in the risk register (row 6). No undocumented cross-branch or external dependencies remain.

### 12. Risk register complete?
**YES.** Six risks covering: OS-level binary locking, download failure, missing config, API rate limits, platform detection, and prerequisite branch. Impact ratings and mitigations are specific and actionable.

### 13. Plan aligns with requirements intent?
**YES.** All requirements from `requirements.md` are covered:
- Install option replay (Task 1 + Task 2 step 6-7) ✓
- Process handoff / detached spawn (Task 2 steps 8-10) ✓
- Update flow with GitHub fetch, version compare, download, spawn (Task 2) ✓
- `--check` preserved (Task 3) ✓
- `--help` added (Task 3) ✓
- Notice string updated (Task 4) ✓
- Reuse of existing `checkForUpdate`/`parseVersion`/`isNewer` (Task 2) ✓

---

## Minor Observations (non-blocking)

1. **Task 2 platform detection** hardcodes `darwin-arm64` — may want a note about Intel Macs (`darwin-x64`). The risk register mentions Rosetta but Task 2's asset mapping only lists `arm64`. Low risk since new Mac installs are overwhelmingly ARM.

2. **Task 2 download mechanism** mentions both `https.get` and `fetch` — implementer should pick one. `fetch` is available in Node 18+ and matches the existing pattern in `checkForUpdate()`. Minor ambiguity, not blocking.

---

## Summary

The rewritten PLAN.md is clean, complete, and accurate. All six prior-review issues are resolved. The PR #214 dependency is clearly documented in three places. The 13-point checklist passes on all items. Plan is approved for implementation once PR #214 merges to `main`.
