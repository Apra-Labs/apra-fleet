# Review: plan/issue-212 — apra-fleet update command

**Reviewer:** fleet-rev
**Date:** 2026-05-01
**Branch:** plan/issue-212

---

## Verdict: CHANGES NEEDED

The plan has a sound high-level structure but suffers from two blocking problems: (1) **binary corruption** renders large sections of the file unreadable, and (2) **multiple factual errors** about the current codebase will mislead the implementer.

---

## 13-Point Checklist

### 1. Clear "done" criteria on every task?
**PARTIAL.** Tasks 1, 2, 3, 5, 6 have done-when clauses, but several contain typos that make them ambiguous:
- Task 1: `{"llm":"gemini","skill":"none"}c` — trailing `c`
- Task 5: `npm testpasses2` — missing space
- Phase 4 verify: `npm testpasses clean` — missing space
- Tasks in the corrupted zone (Task 4 / Phase 3) are **unreadable** — no done criteria can be evaluated.

### 2. High cohesion within tasks, low coupling between?
**YES** for readable tasks. Install-config persistence (Phase 1), core update logic (Phase 2), update notice change (Phase 3), and tests (Phase 4) are well-separated concerns.

### 3. Key abstractions in earliest tasks?
**YES.** install-config.json (Task 1) is the foundational abstraction and comes first. The update flow (Task 2) builds on it.

### 4. Riskiest assumption validated early?
**NO.** The plan assumes `runUpdateCheck()` exists, that `--check` already works, and that an `update` branch exists in `index.ts`. **None of these are true:**
- `runUpdateCheck()` does not exist — the function is `checkForUpdate()` (src/services/update-check.ts:28)
- `--check` flag is not implemented — `checkForUpdate()` is only called at server startup as fire-and-forget (src/index.ts:214)
- There is no `update` command block or "coming soon" placeholder in src/index.ts
- The plan should validate these assumptions in Phase 1 or explicitly account for the additional work.

### 5. Later tasks reuse early abstractions (DRY)?
**YES.** Task 2 reads install-config.json from Task 1. Task 6 tests the flow from Task 2.

### 6. Phase boundaries at cohesion boundaries?
**YES.** Phase 1 (persistence), Phase 2 (core command), Phase 3 (notice update), Phase 4 (tests) are logical boundaries.

### 7. Tiers monotonically non-decreasing within each phase?
**YES** for readable phases. Phase 1: cheap. Phase 2: cheap→standard. Phase 4: cheap→standard. Phase 3 is corrupted.

### 8. Each task completable in one session?
**YES** for readable tasks. All are scoped to 1-2 files with clear boundaries.

### 9. Dependencies satisfied in order?
**PARTIAL.** Task 2 → Task 1 is correct. Task 3 → Task 2 is correct. Task 5 → Task 1, Task 6 → Task 2 are correct. However, Task 3's blockers field is **corrupted/unreadable**. Task 4 (Phase 3) is entirely unreadable so dependencies cannot be verified.

### 10. Any vague tasks?
**YES — by corruption.** Task 4 (Phase 3, update notice change) is almost entirely corrupted binary data. The task title and change description are unreadable. Only the VERIFY block (`npm test passes`) survived.

### 11. Hidden dependencies?
**YES — critical.**
- The plan says Task 3 should "replace the 'coming soon' else branch" — this branch **does not exist**. Task 3 needs to **create** the update command routing from scratch, not replace a placeholder. This is a larger scope than described.
- The plan references reusing `runUpdateCheck()` — this function doesn't exist. The implementer needs to either rename `checkForUpdate()` or create a new CLI-facing wrapper. This dependency is undocumented.

### 12. Risk register complete?
**NO.** Only 2 of what appear to be 4+ risks are readable:
1. Windows binary lock — readable, mitigation is sound
2. Download interrupted — partially readable, mitigation is reasonable
3-4+. **Corrupted** — remaining risk entries are binary garbage

Missing risks that should be documented:
- **GitHub API rate limiting** (unauthenticated requests are limited to 60/hr)
- **Architecture mismatch** — platform/arch detection selecting wrong asset
- **Permissions** — downloaded binary may not be executable on macOS/Linux (needs chmod)

### 13. Plan aligns with requirements intent?
**PARTIAL.** The readable portions align well with requirements.md: install-config persistence, GitHub fetch, platform detection, detached spawn, process.exit handoff, and notice string update are all covered. However, the corrupted sections make it impossible to confirm full coverage of the requirements, and the factual errors about existing code mean the implementation steps as written will not work.

---

## Specific Issues to Fix

### Blocking

1. **File corruption**: PLAN.md contains binary/garbled data in:
   - Task 3 blockers field (line ~46)
   - Task 4 / Phase 3 entirely (lines ~46-48)
   - Risk register entries 3+ (lines ~79-86)
   
   The file must be regenerated or repaired. Approximately 30% of the plan content is unreadable.

2. **Factual errors about codebase** (requirements.md § Related is also inaccurate):
   - `runUpdateCheck()` does not exist → actual function is `checkForUpdate()` (src/services/update-check.ts:28)
   - `--check` flag is not implemented → `checkForUpdate()` is startup-only (src/index.ts:214)
   - No `update` command block exists in src/index.ts → no "coming soon" placeholder to replace
   - Task 3 scope is understated: it must **create** CLI routing for `update`/`update --check`/`update --help`, not just swap in an import

3. **Update notice function**: The plan says to change a string in `src/tools/check-status.ts`, but the actual notice string lives in `src/services/update-check.ts:62` (the `getUpdateNotice()` function). The file reference is misleading.

### Non-blocking

4. **Typos in done-when clauses**: Fix `}c`, `testpasses2`, `testpasses clean` — these are minor but imprecise done criteria invite ambiguity.

5. **Missing risks**: Add GitHub rate limiting, architecture mismatch, and executable permission risks to the register.

6. **`getUpdateNotice()` location**: Task 4 should reference `src/services/update-check.ts` not `src/tools/check-status.ts` for the string change.

---

## Summary

The plan's architecture and phasing are sound — the four-phase progression from persistence → core command → notice update → tests is well-structured with appropriate task granularity. However, the binary corruption makes ~30% of the plan unreadable, and the factual errors about existing code (`runUpdateCheck`, `--check` flag, update placeholder) would lead the implementer to write code against APIs that don't exist. Both issues must be fixed before implementation can begin.
