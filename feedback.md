# Re-Review: plan/issue-212 — apra-fleet update command

**Reviewer:** fleet-rev
**Date:** 2026-05-01
**Branch:** plan/issue-212
**Prior review:** commit 3e4e929

---

## Verdict: CHANGES NEEDED

Two of the six issues from the prior review are resolved; four remain — including the blocking binary corruption that still renders ~30% of the plan unreadable. A new blocking issue is also identified: the plan does not document its dependency on PR #214.

---

## Prior-Review Issue Resolution (6 items)

| # | Issue | Status | Notes |
|---|-------|--------|-------|
| 1 | Binary corruption in PLAN.md | ❌ OPEN | Still present — Task 3 blockers (line ~46), Phase 3/Task 4 body (lines ~46-48), risk register entries 3+ (lines ~79-86) are garbled binary data. Git treats PLAN.md as binary. |
| 2 | Factual errors: `runUpdateCheck()`, `--check`, update placeholder missing | ✅ RESOLVED | These exist on `fixes/after_v0.1.8` (PR #214). Verified: `runUpdateCheck()` at line 63, update command block at lines 43-52 with "coming soon" placeholder, `--check` handler at line 45. Plan's references are correct *given PR #214 merges first*. |
| 3 | Update notice file reference (`check-status.ts` vs `update-check.ts`) | ❓ UNVERIFIABLE | Phase 3 / Task 4 is still corrupted. Cannot confirm whether the file reference was corrected. |
| 4 | Typos in done-when clauses | ❌ OPEN | All four typos remain: `{"llm":"gemini","skill":"none"}c` (Task 1, line 23), trailing `a` in Task 5 (line 57), `npm testpasses2` (Task 5, line 59), `npm testpasses clean` (Phase 4 verify, line 70). |
| 5 | Missing risks (rate limiting, arch mismatch, permissions) | ❓ UNVERIFIABLE | Risk register lines 79-86 are still corrupted binary. Cannot confirm whether new risks were added. |
| 6 | `getUpdateNotice()` location in Task 4 | ❓ UNVERIFIABLE | Task 4 body is corrupted. Same as issue #3. |

**Score: 2/6 resolved, 1/6 open (confirmed), 3/6 unverifiable (corruption).**

---

## New Issue

### 7. PR #214 dependency not documented (BLOCKING)

The plan assumes `runUpdateCheck()`, the `update` CLI block, and `--check` routing all exist — but these come from PR #214 (`fixes/after_v0.1.8`), which is still open. **The plan does not mention PR #214 anywhere.** There is no prerequisite section, no blocker annotation, and no note explaining that these functions will exist once #214 merges.

The plan must add a clearly visible prerequisite block (e.g., at the top, before Phase 1) stating:
```
## Prerequisites
- PR #214 (fixes/after_v0.1.8) must be merged first.
  It adds: runUpdateCheck() in update-check.ts, the `update` command
  block in index.ts with --check routing and "coming soon" placeholder.
```

Without this, an implementer starting from `main` will immediately hit missing functions and non-existent code paths.

---

## 13-Point Checklist

### 1. Clear "done" criteria on every task?
**PARTIAL.** Tasks 1, 2, 3, 5, 6 have done-when clauses but four contain typos (see issue #4). Task 4 / Phase 3 is corrupted — no done criteria visible.

### 2. High cohesion within tasks, low coupling between?
**YES** for readable tasks. Phase boundaries are clean: persistence → core command → notice update → tests.

### 3. Key abstractions in earliest tasks?
**YES.** install-config.json (Task 1) is the foundational data contract and comes first.

### 4. Riskiest assumption validated early?
**YES (with PR #214 caveat).** The plan's assumptions about `runUpdateCheck()`, `--check`, and the update command block are all valid on `fixes/after_v0.1.8`. Verified:
- `runUpdateCheck()` — exists at src/services/update-check.ts:63 on that branch
- `--check` handler — exists at src/index.ts:45
- "Coming soon" placeholder — exists at src/index.ts:50

However, this dependency must be documented (see issue #7).

### 5. Later tasks reuse early abstractions (DRY)?
**YES.** Task 2 reads install-config.json from Task 1. Task 6 tests the flow from Task 2.

### 6. Phase boundaries at cohesion boundaries?
**YES.** Phase 1 (persistence), Phase 2 (core command), Phase 3 (notice update), Phase 4 (tests) are well-separated.

### 7. Tiers monotonically non-decreasing within each phase?
**YES** for readable phases. Phase 1: cheap. Phase 2: cheap→standard. Phase 4: cheap→standard. Phase 3 is corrupted.

### 8. Each task completable in one session?
**YES** for readable tasks. All scoped to 1-2 files.

### 9. Dependencies satisfied in order?
**PARTIAL.** Readable task dependencies are correct (Task 2→1, Task 3→2, Task 5→1, Task 6→2). Task 3 blockers field is corrupted. Cross-branch dependency on PR #214 is undocumented.

### 10. Any vague tasks?
**YES — by corruption.** Task 4 (Phase 3) is entirely garbled binary data. The task is unreadable and cannot be implemented as written.

### 11. Hidden dependencies?
**YES.** PR #214 is a hidden dependency — the plan assumes its code exists but never mentions it. See issue #7.

### 12. Risk register complete?
**PARTIAL.** Two readable risks (Windows binary lock, download interruption) are sound. Remaining entries are binary garbage. Previously flagged missing risks (GitHub API rate limiting, architecture mismatch, executable permissions) cannot be confirmed as added or not.

### 13. Plan aligns with requirements intent?
**PARTIAL.** Readable portions align well with requirements.md. Corrupted sections prevent full confirmation.

---

## Summary

The plan's architecture remains sound and the factual-error concern from the prior review is resolved — PR #214 does provide the assumed functions. However:

1. **Binary corruption** (blocking) — PLAN.md must be regenerated or repaired. ~30% is still unreadable binary data. Git cannot diff it. The "fix typos" commit (29e8395) did not resolve this.
2. **PR #214 prerequisite** (blocking) — Must be explicitly documented as a blocker at the top of the plan.
3. **Typos** (non-blocking) — Four done-when typos persist and should be cleaned up.

The plan cannot proceed to implementation until the corruption is fixed and the PR #214 dependency is documented.
