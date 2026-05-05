# #241 Stall Detector — Plan Review (Re-review)

**Reviewer:** fleet-rev
**Date:** 2026-05-04
**Verdict:** APPROVED

> All three prior findings resolved correctly. Plan is implementation-ready with no ambiguity remaining.

---

## Prior findings — resolution check

### Finding 1: Task 4→6 sequencing
[RESOLVED] — Task 1a now adds `lastLlmActivityAt?: string` to the Agent type in Phase 1 (before Task 4 which writes to it). Task 6 in Phase 2 is marked as "(Moved to Task 1a in Phase 1)" with a forward reference. The dependency ordering is now unambiguous — no field is referenced before it is defined.

### Finding 2: execute_command contract
[RESOLVED] — Task 3 now contains a full "Internal API contract" section specifying:
- **Which function:** `getStrategy(agent).execCommand(agent, cmd, 5000)` from `src/services/strategy.ts`
- **Shell command:** `tail -c 512 <logFilePath>` (with Windows PowerShell alternative)
- **Timeout:** 5000ms
- **Result flow:** Exit code 0 → parse last JSONL line → extract timestamp. Non-zero with "No such file" → return null (not an error). Thrown exception → catch, return null + error message.
- **Logging:** `logLine({ event: 'stall_log_read', memberId, logFilePath })` before issuing the command.

The blocker is removed. An implementer has zero architectural decisions to make — the function to call, the command to issue, every branch of the result, and the logging obligation are all explicit.

### Finding 3: Two-phase vs single add
[RESOLVED] — The two-phase add pattern is now consistent across all five locations where it must appear:
1. **Task 0 resilience table:** "Two-phase add: provisional entry (no logFilePath) is created at spawn" + separate row for "Gap between process spawn and sessionId arrival" documenting provisional behavior.
2. **Task 2 StallEntry type:** Includes `provisional: boolean`, `sessionId: string | null`, `logFilePath: string | null`, and `update()` method for provisional→full upgrade.
3. **Task 4 polling logic:** "if `entry.provisional === true`, skip log reading but still check if `Date.now() - lastActivityAt > STALL_THRESHOLD_MS`."
4. **Task 7 integration hooks:** Phase A (provisional add at spawn) and Phase B (upgrade via `stallDetector.update()` when sessionId arrives), with explicit note that finally block removes provisional entries if process exits early.
5. **Risk register:** "Two-phase add: provisional entry at spawn (`lastActivityAt = Date.now()`, `provisional: true`, no log path); upgraded to full entry with real `logFilePath` when sessionId arrives."

No contradictions remain between any of these locations.

---

## New issues (if any)

None. The fixes are clean and introduce no new inconsistencies or ambiguities.

---

## Summary

The plan is approved for implementation. The three blocking findings from the initial review have been addressed with concrete, consistent changes. The sequencing is correct, the execute_command contract leaves no room for interpretation, and the two-phase add pattern is specified identically everywhere it appears. No new issues were introduced by the fixes.
