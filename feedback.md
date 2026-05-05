# Stall Detector Redesign (#241) — Plan Review

**Reviewer:** fleet-rev
**Date:** 2026-05-05T00:00:00-04:00
**Verdict:** CHANGES NEEDED

---

## Plan Quality

**Clear "done" criteria per task:** PASS — Every task has a concrete "Done when" clause with observable outputs (correct separators, correct paths, events firing exactly once, tests green).

**High cohesion within tasks, low coupling between tasks:** PASS — Each task is focused on a single concern. Implementation and tests are separated but co-located within the same phase.

**Riskiest assumption validated early:** PASS — The two High-impact risks (SSH transport accessibility, AbortSignal threading) have explicit mitigations ("audit before Task 3", "trace call chain before Task 7"). Phase ordering puts the transport-dependent work (Phase 2) before the deeper transport surgery (Phase 4).

**Phase boundaries at cohesion boundaries:** PASS — Five phases map cleanly to five independent concerns: path encoding, log discovery, polling, MCP disconnect, timestamp fix.

**Tiers monotonically non-decreasing within each phase:** PASS (within-phase). Within every phase, all tasks share the same tier. **Note:** Cross-phase ordering is non-monotonic — Phase 5 (cheap) follows Phase 4 (premium). This is acceptable since Phase 5 is an independent leaf fix with no dependency on Phase 4, but consider reordering Phase 5 before Phase 4 to restore the cheap → standard → premium progression.

**No vague tasks, no hidden dependencies:** FAIL — See Design Doc Coverage below. There is a hidden dependency: Task 3 consumes the `[inv]` token as a tiebreaker, but no task *produces* it. The code change to prepend `[<inv>] ` to the `-p` argument in `execute-prompt.ts` is missing from the plan entirely.

**Risk register present and complete:** PASS — Four risks with impact ratings and mitigations. Covers transport access, AbortSignal depth, BSD/GNU `find` variance, and same-second tiebreaker.

---

## Design Doc Coverage

**Section 1 — Token = inv ID:** MISSING. The design doc specifies prepending `[<inv>] ` to the `-p` argument in `execute-prompt.ts`. The requirements document calls this out explicitly as "Fix 0" with source file `src/tools/execute-prompt.ts`. The plan has **no task** for this code change. Task 3 references consuming the `[inv]` token as a tiebreaker, but the write side (modifying the `-p` argument) is absent. This is a code change, not just a design note — without it, the tiebreaker in Task 3 has nothing to match against.

**Section 2 — Log directory resolution:** COVERED. Task 1 addresses `-` encoding, Gemini `/chats/` subdirectory, and remote home dir inline resolution.

**Section 3 — Log file discovery strategy:** COVERED. Task 3 addresses Case A (mtime scan), Case B Claude (direct sessionId path), Case B Gemini (mtime scan), retry logic (10s x 3), `stall_log_not_found` logging, and `[inv]` tiebreaker for >1 candidate.

**Section 4 — Activity polling:** COVERED. Task 5 addresses 500-byte tail, Claude `timestamp` from `assistant` entries, Gemini `lastUpdated` from `$set` lines, `stall_poll_format_error` logging, `stallReported` guard, and reset on activity advance.

**Section 5 — Local vs. remote scan:** COVERED. Task 3 specifies both the `find -newermt` Linux/macOS variant and the `Get-ChildItem | Where-Object LastWriteTime` Windows PowerShell variant. Remote home dir resolution is in Task 1.

**Section 6 — R8 MCP disconnect fix:** COVERED. Task 7 specifies AbortSignal injection into `execCommand`, independent unblocking of the await, best-effort subprocess kill in parallel, and `finally` block cleanup.

**Section 7 — toLocalISOString:** COVERED. Task 9 specifies the corrected implementation with `ms - offsetMin * 60000` adjustment and correct sign logic.

---

## Requirements Coverage

| Acceptance Criterion | Covered By |
|---|---|
| `-p` argument prefixed with `[<inv>] ` in execute-prompt.ts | **NOT COVERED — no task** |
| Claude log dir path encoding produces `-` separators | Task 1 |
| Gemini log dir path includes `/chats/` | Task 1 |
| `findLogFile` resolves log for fresh Claude session within 30s | Task 3 |
| `findLogFile` resolves log for fresh Gemini session within 30s | Task 3 |
| `findLogFile` uses mtime filter as primary mechanism | Task 3 |
| Activity polling reads correct timestamp field for Claude and Gemini | Task 5 |
| `stall_detected` fires exactly once per stall period | Task 5 |
| `stall_detected` resets after activity resumes | Task 5 |
| MCP client disconnect clears stall entry and `inFlightAgents` | Task 7 |
| `toLocalISOString` produces correct local time offset | Task 9 |
| All existing tests pass | VERIFY gates at each phase |
| New unit tests cover path encoding, mtime filter, timestamp extraction, toLocalISOString | Tasks 2, 4, 6, 8, 10 |

**1 of 13 acceptance criteria has no covering task.**

---

## Summary

**Passed:** Plan structure, phase boundaries, done criteria, risk register, and coverage of design doc Sections 2–7 are all solid.

**Must change:** Add a task (and corresponding test task) for **Fix 0 — prepend `[<inv>] ` to the `-p` argument in `execute-prompt.ts`**. This is a code change in `src/tools/execute-prompt.ts` that is distinct from the tiebreaker logic in `findLogFile`. Without it, the first acceptance criterion is unaddressed and the tiebreaker in Task 3 has no token to match. Recommended placement: Phase 1 (cheap tier) since it is a small, isolated change with no dependencies and should land before Task 3 which consumes the token.

**Optional improvement:** Reorder Phase 5 (toLocalISOString, cheap) before Phase 4 (MCP disconnect, premium) to restore monotonically non-decreasing tier ordering across phases.
