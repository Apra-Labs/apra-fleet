# #241 Stall Detector — Plan Review

**Reviewer:** fleet-rev
**Date:** 2026-05-04
**Verdict:** CHANGES NEEDED

> Solid plan architecture with one sequencing bug (Task 4 uses a field added in Task 6), an unresolved internal-call contract for execute_command, and a contradiction between the risk register mitigation and Task 7's add-point specification.

---

## Task-by-task review

### Phase 0: Resilience Analysis

**Task 0 — PASS.** All five edge cases from requirements are explicitly addressed in the decision table. Decisions are concrete ("do not count as stall cycle", "increment `consecutiveReadFailures`", "log warning after 3 consecutive failures") — an implementer won't need to guess. The "overwrite with warning" policy for concurrent dispatches is the right pragmatic call since the server already rejects the second dispatch upstream.

### Phase 1: Foundation

**Task 1 (Log Path Resolver) — PASS.** Clean scope, single responsibility. The unresolved Claude path-encoding scheme is appropriately flagged as a blocker with a "best-guess + TODO" strategy. This is acceptable since a wrong guess produces no false positives (readLogTail returns null → no stall counted per resilience rules).

**Task 2 (StallEntry Type & Class Skeleton) — PASS.** Good that add() is specified as idempotent-overwrite-with-warning and remove() as idempotent-no-op. Done criteria are testable.

**Task 3 (Internal execute_command Wrapper) — FAIL.** The blocker states: "Need to identify how to invoke execute_command internally (not as MCP tool call). Likely call the underlying function that execute_command tool delegates to." This is the single most important architectural decision for local/remote uniformity and observability, and it's left unresolved. Two implementers could reasonably (a) import the tool handler function directly, (b) use some internal dispatch mechanism, or (c) call the shell function that underlies it. The difference matters because requirements say "the log read itself must appear in the fleet server's structured JSONL log" — only approach (a) or (b) would naturally satisfy that if the logging is baked into the tool handler. This decision should be made in Phase 0 (resilience doc) or resolved as a precondition of Task 3 with an explicit code pointer to the function to call.

**Doer:** fixed — Task 3 now has a concrete "Internal API contract" section specifying `getStrategy(agent).execCommand(agent, cmd, 5000)` from `src/services/strategy.ts`, the exact shell command (`tail -c 512`), result flow (exit code handling, JSON parsing), error handling, and logging via `logLine()`. Blocker removed.

**Task 4 (Polling Loop) — FAIL.** The specification says "Update `lastLlmActivityAt` on the member record via `updateAgent()`" — but `lastLlmActivityAt` doesn't exist on the Agent type until Task 6 (Phase 2). This is a hidden cross-phase dependency. Either move Task 6 into Phase 1 (before Task 4), or remove the `updateAgent()` line from Task 4 and add it to a Phase 2 task that wires the poll loop to the agent record.

**Doer:** fixed — Created Task 1a in Phase 1 adding `lastLlmActivityAt` to the Agent type before Task 4. Task 6 in Phase 2 now reads "(Moved to Task 1a in Phase 1)" with a forward reference.

**Task 5 (Unit Tests) — PASS.** Comprehensive coverage list matching both the requirements' test expectations and the resilience decisions. Good that it includes the "execute_command failure" case.

### Phase 2: Integration

**Task 6 (Add lastLlmActivityAt to Agent Type) — PASS.** Trivial and well-scoped, but should be in Phase 1 given the dependency from Task 4 (see above).

**Task 7 (Hook into execute_prompt) — FAIL (minor).** The task says to add the entry "After sessionId is known (line ~216)" — meaning there's a window between process spawn and session ID extraction where no stall monitoring exists. The risk register acknowledges this and proposes: "Add entry with `lastActivityAt = now` on spawn (uses process start as baseline); add with real logFilePath when sessionId arrives." But Task 7 contradicts this by specifying a single add-point after sessionId. Either the risk mitigation is wrong (acceptable gap) or Task 7 needs a two-phase add: (1) provisional entry at spawn with no logFilePath, (2) update entry with real path when sessionId arrives. Pick one and make Task 7's specification match.

**Doer:** fixed — Task 7 now specifies two-phase add: Phase A (provisional entry at spawn with `provisional: true`, `sessionId: null`, `logFilePath: null`) and Phase B (upgrade via `stallDetector.update()` when sessionId arrives). Task 0 resilience table updated with new "Gap between process spawn and sessionId arrival" edge case. Task 2 StallEntry type updated with `provisional: boolean` and `update()` method. Task 4 polling loop updated to skip log reading for provisional entries but still detect stalls via baseline timeout. Risk register mitigation updated to match.

**Task 8 (Hook into stop_prompt) — PASS.** One line of code, idempotent, clearly specified.

**Task 9 (Hook into Member Unregister) — PASS.** Same pattern, safe.

**Task 10 (Initialize on Server Start) — PASS.** Straightforward lifecycle hook. The blocker "Need to identify exact server lifecycle hooks" is minor and easily resolved by reading the entry point.

**Tier non-monotonicity in Phase 2:** Tasks go standard → cheap → cheap → cheap (7 → 8 → 9 → 10). This violates criterion 7. Reorder to put Task 6 and Tasks 8/9/10 before Task 7, or accept that the dependency ordering (Task 7 must come first because it establishes the add-point that 8/9/10 complement) takes priority over tier ordering.

### Phase 3: Surface

**Task 11 (member_detail) — PASS.** Clear scope. The `idleSecs` derivation at read time matches requirements exactly.

**Task 12 (fleet_status) — PASS.** Same pattern, consistent with Task 11.

**Task 13 (Integration Tests) — PASS.** Good that it's marked premium tier and tests the full lifecycle end-to-end.

---

## Cross-cutting concerns

### Resilience analysis completeness
All 5 edge cases from requirements are covered with concrete, non-contradictory decisions. The `consecutiveReadFailures` counter with warning-after-3 is a good addition beyond the minimum requirements. PASS.

### execute_command contract clarity
**Insufficient.** The plan correctly states that all log access must go through execute_command and that reads must appear in the fleet JSONL log. However, the HOW is left as an unresolved blocker in Task 3. The risk is that an implementer imports the execute_command tool's handler function but misses the logging step, or uses a direct function call that bypasses the execute_command codepath entirely. The plan should include an explicit code pointer (e.g., "call `runCommandOnMember()` from `src/tools/execute-command.ts:XX` which already logs via `logLine()`") or add a Phase 0 spike to identify the correct internal call mechanism.

### Termination coverage
All 6 termination conditions from requirements are explicitly mapped to removal points in Task 7's table. The "server restart" condition is correctly handled by the in-memory design (list starts empty). The double-remove safety property is mentioned in multiple places and tested. PASS.

### monitor_task isolation
The plan explicitly states "`monitor_task` has NO role in this feature" in the Notes section and includes a Phase 3 VERIFY checkbox confirming it's not modified. No task touches monitor_task code. PASS.

### Local/remote uniformity
All log access goes through execute_command which works uniformly for local and remote members. No task introduces `fs.stat`, `fs.readFile`, or any filesystem-direct path. The `resolveSessionLogPath` function returns a string path that's passed to execute_command — it doesn't read the file itself. PASS.

---

## Summary

**What passed:** Phase 0 resilience analysis is thorough and specific. Phase boundaries are well-drawn at cohesion boundaries. The overall architecture (single polling loop, idempotent add/remove, execute_command indirection) is sound and matches requirements intent. Termination coverage is explicit and complete. monitor_task is cleanly isolated. Local/remote uniformity is maintained throughout.

**What must change (3 items):**
1. **Task 4 → Task 6 dependency:** Move `lastLlmActivityAt` type addition (Task 6) into Phase 1 before Task 4, or defer the `updateAgent()` call from Task 4 to a Phase 2 wiring task.
2. **Task 3 blocker resolution:** Resolve the internal execute_command invocation mechanism before implementation begins — add it to Phase 0 as a design decision with a specific code pointer.
3. **Task 7 vs. risk register contradiction:** Decide whether the spawn-to-sessionId gap is acceptable or needs a two-phase add. Update Task 7's specification to match the chosen approach.

**Deferred / acceptable:** Claude path encoding and Gemini log path verification are correctly flagged as risks with graceful degradation (no false positives). The tier non-monotonicity in Phase 2 is a minor ordering concern subordinate to dependency correctness.
