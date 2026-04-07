# API Cleanup & Skill Doc Sweep — Phase 4 Code Review

**Reviewer:** fleet-rev  
**Date:** 2026-04-06 22:30:00-04:00  
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## Prior Review Context

Phase 3 was APPROVED in commit b47fdab. Phases 1 and 2 remain clean — no regressions detected (source files unchanged since their approvals).

Phase 4 work spans five commits:
- `59207ca` — Task 4.1 (add `tokenUsage` field to Agent type)
- `6251173` — Task 4.2 (auto-accumulate tokens in `execute_prompt`)
- `294d3db` — Task 4.3 (surface `tokenUsage` in `member_detail`)
- `cb352f4` — Task 4.4 (surface `tokenUsage` in `fleet_status`)
- `1c29207` — Task 4.5 (remove `update_task_tokens` tool)

---

## Task 4.1 — Add tokenUsage field to Agent type — PASS

`src/types.ts:30`: `tokenUsage?: { input: number; output: number };` added to the `Agent` interface. Optional field — existing agents remain valid. Clean.

---

## Task 4.2 — Auto-accumulate tokens in execute_prompt — PASS (code), FAIL (test coverage)

`src/tools/execute-prompt.ts:163-171`: After `touchAgent`, the code checks `parsed.usage` and does a read-modify-write via `updateAgent`:

```ts
if (parsed.usage) {
  const prev = agent.tokenUsage ?? { input: 0, output: 0 };
  updateAgent(agent.id, {
    tokenUsage: {
      input: prev.input + parsed.usage.input_tokens,
      output: prev.output + parsed.usage.output_tokens,
    },
  });
}
```

The implementation is correct:
- `parsed.usage` is typed `{ input_tokens: number; output_tokens: number }` from `provider.ts:35`
- Correctly maps provider field names (`input_tokens`) to agent field names (`input`)
- Defaults to `{ input: 0, output: 0 }` when no prior usage exists
- Race condition is a non-issue per Risk R2 (single-threaded Node.js event loop)

**However:** The existing test at `execute-prompt.test.ts:245` only asserts the output string contains `"Tokens: input=100 output=200"` — it does not verify that `updateAgent` was called with accumulated `tokenUsage`. The old `update-task-tokens.test.ts` (242 lines, 7 test cases) was deleted, but no replacement tests were added for the new accumulation path. This is a new code path that should have at least one test verifying `updateAgent` is called with the correct accumulated values when `parsed.usage` is present.

**Required:** Add a test in `tests/execute-prompt.test.ts` that verifies:
1. After a prompt response with `usage`, `updateAgent` is called with the correct `tokenUsage` accumulation
2. When `usage` is absent, `updateAgent` is NOT called for token accumulation (the existing "does not append token line" test should also assert this)

**Addressed (2026-04-06):** Three tests added to `tests/execute-prompt.test.ts`:
- *"accumulates tokenUsage on agent when usage is present in response"* — verifies `getAgent(id).tokenUsage` equals `{ input: 50, output: 75 }` after a response with `{ input_tokens: 50, output_tokens: 75 }` on an agent with no prior usage.
- *"accumulates tokenUsage on top of existing values when agent already has tokenUsage"* — verifies accumulation adds to prior values (30+10=40, 20+5=25).
- *"does not append token line when usage is absent"* — extended to also assert `getAgent(id).tokenUsage` is `undefined` when `usage` is absent.

---

## Task 4.3 — Surface tokenUsage in member_detail — PASS

`src/tools/member-detail.ts:150-152`: Adds `result.tokenUsage = agent.tokenUsage` when present (JSON format).

`src/tools/member-detail.ts:257`: Compact format appends `| tokens=in:N out:N` when `agent.tokenUsage` is truthy. Clean.

NOTE: The compact format shows tokens even when both values are 0 (as long as `tokenUsage` is set). This differs from `fleet_status` which suppresses zero values (see Task 4.4). Minor inconsistency — not blocking, but worth noting for Phase 5 doc sweep.

---

## Task 4.4 — Surface tokenUsage in fleet_status — PASS

`src/tools/check-status.ts:228-229`: Compact format includes token string only when `tokenUsage` exists AND at least one value is > 0:

```ts
const tokenStr = (r.tokenUsage && (r.tokenUsage.input > 0 || r.tokenUsage.output > 0))
  ? ` | tokens=in:${r.tokenUsage.input} out:${r.tokenUsage.output}` : '';
```

The `AgentStatusRow` interface at line 35 correctly includes `tokenUsage?: { input: number; output: number }`. The `checkAgent` function at line 62 passes through `agent.tokenUsage`. Clean.

---

## Task 4.5 — Remove update_task_tokens tool — PASS

- `src/tools/update-task-tokens.ts` — deleted (120 lines)
- `tests/update-task-tokens.test.ts` — deleted (242 lines)
- `src/index.ts:67` — import removed
- `src/index.ts:116` — `server.tool('update_task_tokens', ...)` registration removed

Verified: `grep -rn 'update_task_tokens\|updateTaskTokens' src/` returns zero matches. Clean removal, no orphaned references.

---

## Build & Full Test Suite — PASS

- `npx tsc --noEmit` — clean, no type errors
- `npx vitest run` — 40 test files, 626 passed, 4 skipped. No failures.

Test count decreased from Phase 3 (633 passed → 626 passed) because the 7 `update-task-tokens.test.ts` tests were removed. Test file count decreased from 41 → 40. This is expected and correct.

---

## Phase 1+2+3 Regression Check — PASS

- `src/tools/compose-permissions.ts` — unchanged since Phase 1 approval
- `src/tools/member-detail.ts` — modified in Phase 4 (Task 4.3), changes are additive only
- `src/tools/execute-command.ts` — unchanged since Phase 3 approval
- `src/tools/execute-prompt.ts` — modified in Phase 4 (Task 4.2), changes are additive only
- `src/index.ts` — modified in Phase 4 (Task 4.5), removal only
- All Phase 1+2+3 tests continue to pass

---

## Summary

| Task | Verdict | Notes |
|------|---------|-------|
| 4.1 — Add tokenUsage to Agent type | PASS | Clean optional field addition |
| 4.2 — Auto-accumulate in execute_prompt | PASS (code) / FAIL (tests) | Logic is correct but no test verifies `updateAgent` is called with accumulated tokens |
| 4.3 — Surface in member_detail | PASS | JSON + compact format both work |
| 4.4 — Surface in fleet_status | PASS | Correctly suppresses zero-value display |
| 4.5 — Remove update_task_tokens | PASS | Clean removal, zero stale references in src/ |
| V4 — npm test | PASS | 626 passed, 4 skipped (40 files) |
| Phase 1+2+3 regression | PASS | No regressions |

**Blocking:** Task 4.2 needs at least one test verifying that `updateAgent` is called with the correct accumulated `tokenUsage` when `parsed.usage` is present. The old tool had 7 tests covering accumulation behavior — the replacement should have at least basic coverage.

**Non-blocking (carried forward):** `member_detail` shows token string even when both values are 0; `fleet_status` suppresses zeros. Minor inconsistency — can be addressed in Phase 5 or left as-is.

**Non-blocking (carried from Phase 3):** User-facing strings in `src/` still reference `provision_auth` — Phase 5 Task 5.4 scope.
