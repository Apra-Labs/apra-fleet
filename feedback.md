# Stall Detector Redesign (#241) — Plan Review

**Reviewer:** fleet-rev
**Date:** 2026-05-05T00:00:00-04:00
**Verdict:** ~~CHANGES NEEDED~~ → **APPROVED** (re-review 2026-05-05)

---

## Plan Quality

**Clear "done" criteria per task:** PASS — Every task has a concrete "Done when" clause with observable outputs (correct separators, correct paths, events firing exactly once, tests green).

**High cohesion within tasks, low coupling between tasks:** PASS — Each task is focused on a single concern. Implementation and tests are separated but co-located within the same phase.

**Riskiest assumption validated early:** PASS — The two High-impact risks (SSH transport accessibility, AbortSignal threading) have explicit mitigations ("audit before Task 3", "trace call chain before Task 7"). Phase ordering puts the transport-dependent work (Phase 2) before the deeper transport surgery (Phase 4).

**Phase boundaries at cohesion boundaries:** PASS — Five phases map cleanly to five independent concerns: path encoding, log discovery, polling, MCP disconnect, timestamp fix.

**Tiers monotonically non-decreasing within each phase:** PASS (within-phase). Within every phase, all tasks share the same tier. **Note:** Cross-phase ordering is non-monotonic — Phase 5 (cheap) follows Phase 4 (premium). This is acceptable since Phase 5 is an independent leaf fix with no dependency on Phase 4, but consider reordering Phase 5 before Phase 4 to restore the cheap → standard → premium progression.

**No vague tasks, no hidden dependencies:** ~~FAIL~~ → **PASS** — The hidden dependency is resolved. Task 3 now produces the `[<inv>] ` token and Task 5 consumes it as a tiebreaker. Dependency chain is explicit and correctly ordered within the plan.

**Risk register present and complete:** PASS — Four risks with impact ratings and mitigations. Covers transport access, AbortSignal depth, BSD/GNU `find` variance, and same-second tiebreaker.

---

## Design Doc Coverage

**Section 1 — Token = inv ID:** ~~MISSING~~ → **COVERED.** Task 3 (Phase 1) prepends `[<inv>] ` to the `-p` argument in `execute-prompt.ts`. Task 4 adds corresponding unit tests.

**Section 2 — Log directory resolution:** COVERED. Task 1 addresses `-` encoding, Gemini `/chats/` subdirectory, and remote home dir inline resolution.

**Section 3 — Log file discovery strategy:** COVERED. Task 5 addresses Case A (mtime scan), Case B Claude (direct sessionId path), Case B Gemini (mtime scan), retry logic (10s x 3), `stall_log_not_found` logging, and `[inv]` tiebreaker for >1 candidate.

**Section 4 — Activity polling:** COVERED. Task 7 addresses 500-byte tail, Claude `timestamp` from `assistant` entries, Gemini `lastUpdated` from `$set` lines, `stall_poll_format_error` logging, `stallReported` guard, and reset on activity advance.

**Section 5 — Local vs. remote scan:** COVERED. Task 5 specifies both the `find -newermt` Linux/macOS variant and the `Get-ChildItem | Where-Object LastWriteTime` Windows PowerShell variant. Remote home dir resolution is in Task 1.

**Section 6 — R8 MCP disconnect fix:** COVERED. Task 9 specifies AbortSignal injection into `execCommand`, independent unblocking of the await, best-effort subprocess kill in parallel, and `finally` block cleanup.

**Section 7 — toLocalISOString:** COVERED. Task 11 specifies the corrected implementation with `ms - offsetMin * 60000` adjustment and correct sign logic.

---

## Requirements Coverage

| Acceptance Criterion | Covered By |
|---|---|
| `-p` argument prefixed with `[<inv>] ` in execute-prompt.ts | **Task 3** |
| Claude log dir path encoding produces `-` separators | Task 1 |
| Gemini log dir path includes `/chats/` | Task 1 |
| `findLogFile` resolves log for fresh Claude session within 30s | Task 5 |
| `findLogFile` resolves log for fresh Gemini session within 30s | Task 5 |
| `findLogFile` uses mtime filter as primary mechanism | Task 5 |
| Activity polling reads correct timestamp field for Claude and Gemini | Task 7 |
| `stall_detected` fires exactly once per stall period | Task 7 |
| `stall_detected` resets after activity resumes | Task 7 |
| MCP client disconnect clears stall entry and `inFlightAgents` | Task 9 |
| `toLocalISOString` produces correct local time offset | Task 11 |
| All existing tests pass | VERIFY gates at each phase |
| New unit tests cover path encoding, mtime filter, timestamp extraction, toLocalISOString | Tasks 2, 4, 6, 8, 10, 12 |

**13 of 13 acceptance criteria now have covering tasks.**

---

## Re-review Checklist (2026-05-05)

1. **Task 3 (inv token prepend) present in Phase 1?** YES — Task 3 prepends `[<inv>] ` to `-p` in `execute-prompt.ts`, correctly placed before Task 5 which consumes the token.
2. **Task 4 (unit tests) present?** YES — Task 4 adds tests for fresh and resumed sessions.
3. **Subsequent tasks correctly renumbered?** YES — Former Tasks 3–10 are now Tasks 5–12. Phase 2 starts at Task 5, Phase 3 at Task 7, Phase 4 at Task 9, Phase 5 at Task 11. All VERIFY gates reference correct task numbers.
4. **Doer annotation present?** YES — Line 73 of prior feedback. Minor note: references commit `b8c68b0` but actual commit is `a81806a` (SHA mismatch, content is correct).
5. **Full coverage of design doc and requirements?** YES — All 7 design doc sections and all 13 acceptance criteria are covered.

---

## Summary

**Passed:** All plan quality checks pass. All 7 design doc sections covered. All 13 acceptance criteria have covering tasks. The blocking finding from the initial review (missing inv token prepend task) has been resolved — Task 3 and Task 4 are correctly placed in Phase 1, before the tiebreaker logic in Task 5 that depends on the token.

**Prior finding — RESOLVED:**
> **Must change:** Add a task (and corresponding test task) for Fix 0 — prepend `[<inv>] ` to the `-p` argument in `execute-prompt.ts`.

**Doer:** fixed in commit b8c68b0 — added Task 3 (inv token prepend) and Task 4 (tests) to Phase 1

**Re-review verdict:** The fix is correctly implemented. Task 3 produces the token, Task 4 tests it, and Task 5 consumes it. Dependency ordering is sound.

**Optional improvement (carried forward):** Reorder Phase 5 (toLocalISOString, cheap) before Phase 4 (MCP disconnect, premium) to restore monotonically non-decreasing tier ordering across phases.
