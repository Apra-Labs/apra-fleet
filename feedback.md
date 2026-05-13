# gbrain Integration — Phase 2 Code Review

**Reviewer:** fleet-reviewer (Claude Opus 4.6)
**Date:** 2026-05-13
**Branch:** feat/gbrain-integration
**Commits reviewed:** e663a17, f7b7d82, 2977df5
**Verdict:** APPROVED

---

## Files Reviewed

| File | Lines | Purpose |
|------|-------|---------|
| `src/utils/gbrain-helpers.ts` | 29 | `assertGbrainEnabled()` + `callGbrainTool()` shared helpers |
| `src/tools/brain-query.ts` | 24 | `brain_query` fleet tool |
| `src/tools/brain-write.ts` | 26 | `brain_write` fleet tool |
| `tests/brain-tools.test.ts` | 146 | 11 tests covering both tools |
| `src/index.ts` (lines 126-127, 261-262) | — | Tool registration |

---

## Review Checklist

### 1. `assertGbrainEnabled` — PASS
- Correctly gates on `agent.gbrain` flag (line 9: `if (!agent.gbrain)`)
- Handles both `false` and `undefined` (the `Agent` type declares `gbrain?: boolean`)
- Error message is clear and actionable: directs user to `update_member`
- Return type `string | null` is clean — no exceptions for a config check

### 2. `callGbrainTool` — PASS
- Error normalization is correct: `instanceof Error` check with `String(err)` fallback
- Catches the specific `'gbrain is not available'` substring for a user-friendly message
- Generic errors include the tool name for debuggability
- Correctly uses the singleton via `getGbrainClient()`

### 3. `brain_query` tool — PASS
- Schema uses `memberIdentifier` spread + `query` (required) + `collection` (optional) — correct
- Resolves member first, then checks gbrain enabled — correct order
- Conditionally spreads `collection` only when truthy — avoids sending `undefined` keys to MCP

### 4. `brain_write` tool — PASS
- Schema: `content` (required) + `collection` (optional) + `metadata` (optional) — correct
- Same resolve → assert → call pattern as `brain_query` — consistent
- Optional fields conditionally spread — no `undefined` pollution
- Note: the task description mentions `tags` as an optional field, but it is not present in the gbrain server's API or the implementation plan. The omission is correct.

### 5. Tool registration in `src/index.ts` — PASS
- Both tools imported at lines 126-127
- Both registered at lines 261-262 under the `--- gbrain tools ---` section
- Descriptions are clear and mention the gbrain-enabled prerequisite
- Both wrapped with `wrapTool()` for onboarding integration

### 6. Tests — PASS (11/11 passing)
- **Happy path:** both tools tested with basic args and with all optional args
- **Disabled member:** tested with `gbrain: false` and with `gbrain` omitted (undefined)
- **Member not found:** tested for both tools
- **Server unavailable:** tested for both tools — verifies friendly error message
- **Mock isolation:** clean `vi.mock` of gbrain-client, `beforeEach`/`afterEach` registry backup/restore
- Coverage is thorough for the helper + tool layer

### 7. TypeScript types — PASS
- No `any` in new files (`gbrain-helpers.ts`, `brain-query.ts`, `brain-write.ts`, `brain-tools.test.ts`)
- `args` parameter typed as `Record<string, unknown>` — appropriate for MCP tool args
- Zod schemas with `z.infer` for input types — no manual type duplication
- The `as any` casts in `src/index.ts` tool registration (e.g., `(input) => brainQuery(input as any)`) are pre-existing pattern used by all other tools — not introduced by this PR

### 8. Security — PASS
- `query` and `content` are passed through to MCP as structured arguments, not interpolated into strings or commands
- MCP protocol handles serialization — no injection vector
- No user input used in file paths, shell commands, or SQL
- Error messages don't leak internal state beyond the tool name

---

## Summary

Phase 2 is clean, well-structured, and follows the established patterns in the codebase. The helpers (`assertGbrainEnabled`, `callGbrainTool`) provide proper DRY abstraction as prescribed by the plan. Both tools have consistent schema design, correct error handling flow, and thorough test coverage. No issues found.

---

# gbrain Integration — Plan Re-Review

**Reviewer:** fleet-reviewer
**Date:** 2026-05-13 20:00:00+05:30
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## Finding Resolution

### Finding 1: gbrain tool names — RESOLVED

All tool names now use underscores matching gbrain's canonical API: `brain_query`, `brain_write`, `code_callers`, `code_callees`, `code_def`, `code_refs`, `jobs_submit`, `jobs_list`, `jobs_stats`, `jobs_work`. The old `minions-dispatch` / `minions-status` references are replaced by four `jobs_*` tools. Tool counts updated from 10 to 12 throughout. The Notes section confirms "No name translation needed — fleet passes tool names through directly." All `callTool` references across Tasks 2.1, 2.2, 3.1, 4.1, 6.2, 6.3, 6.4, and Notes are consistent. Fixed in commits a5d21d5 + eab88d0.

### Finding 2: Template conditionals — RESOLVED

Task 5.1 now uses string concatenation — PM appends a `## Brain-Aware Review` block to the rendered reviewer template when gbrain is enabled. No template engine changes needed. `src/services/template-renderer.ts` removed from the file list. The Notes section is updated to match. This is compatible with the PM skill's simple `{{PLACEHOLDER}}` token model. Fixed in commits a5d21d5 + eab88d0.

**Doer:** fixed in this commit — changed Task 5.1 from OPTIONAL markers to string concatenation approach, removed template-renderer.ts dependency

### Finding 3: Course correction wiring — RESOLVED

New Task 5.4 ("Document course_correction_capture call-sites in PM skill docs") added. It specifies WHERE `course_correction_capture` is called: after user interrupts/corrects a plan in single-pair-sprint, and when reviewer returns CHANGES NEEDED with user modifications in doer-reviewer. This is documentation changes only — no code changes, no template engine modifications. Done-when criteria are clear: both PM skill docs specify call-sites for course_correction_capture. Fixed in commits a5d21d5 + eab88d0.

**Doer:** fixed in this commit — changed Task 5.4 to documentation-only updates to single-pair-sprint.md and doer-reviewer.md

### Finding 4: DRY helpers — RESOLVED

Helper creation moved to Phase 2 as new Task 2.1 ("Create shared gbrain helpers"), creating `src/utils/gbrain-helpers.ts` with `assertGbrainEnabled()` and `callGbrainTool()`. Existing Phase 2 tasks renumbered: 2.1→2.2 (brain_query), 2.2→2.3 (brain_write), 2.3→2.4 (tests). Task 3.1 references "Use shared helpers from Task 2.1." Task 6.1 reduced to a DRY audit. Helpers available from Phase 2 onward. Fixed in commits a5d21d5 + eab88d0.

**Doer:** fixed in this commit — renumbered Task 2.0→2.1, existing 2.1→2.2, 2.2→2.3, 2.3→2.4; updated all cross-references

### Finding 5: Phase 1 tier monotonicity — RESOLVED

Task 1.4 promoted from standard to premium tier. Phase 1 tier sequence is now: cheap (1.1) → cheap (1.2) → premium (1.3) → premium (1.4). Monotonically non-decreasing — no tier downgrades within the phase.

**Doer:** fixed in commit 6c325c6 — promoted Task 1.4 to premium tier

---

## Plan Quality (13 Standard Criteria)

### 1. Done Criteria Clarity — PASS

Every task has explicit "done when" criteria with compilation checks, test pass conditions, and observable behaviors. New tasks (2.0, 5.4) also have clear, testable criteria. Phase VERIFY blocks remain unambiguous.

### 2. Cohesion / Coupling — PASS

Phase structure unchanged and well-scoped. Task 2.0 improves cohesion in Phase 2 — helpers introduced alongside their first consumers. Task 5.4 correctly scoped to Phase 5 with the other course-correction work.

### 3. Shared Abstractions First — PASS

Previously NOTE/FAIL. Now resolved: Task 2.0 creates helpers before any tool implementation. Task 3.1 explicitly references them.

### 4. Riskiest Assumption Validated First — PASS

Unchanged. Phase 1 Task 1.3 validates MCP protocol compatibility, child process lifecycle, and reconnection before any tools are built.

### 5. DRY / Reuse of Early Abstractions — PASS

Previously FAIL. Now resolved: Task 2.0 creates helpers at Phase 2 start, Phases 3–5 reuse them, Task 6.1 audits for consistency.

### 6. Phase Boundaries at Cohesion Boundaries — PASS

Unchanged. Each phase is a coherent feature domain with its own VERIFY block. Boundaries align with feature domains.

### 7. Tier Monotonicity — PASS

Phase 1 sequence: cheap (1.1) → cheap (1.2) → premium (1.3) → premium (1.4). Monotonically non-decreasing.

### 8. Session-Sized Tasks — PASS

All tasks appropriately scoped. New tasks (2.0: one file; 5.4: two template files) are small and focused.

### 9. Dependencies Satisfied in Order — PASS

Unchanged, and new tasks have correct blockers: Task 2.0 blocked on 1.3 (needs gbrain client), Task 5.4 blocked on 5.2 and 5.3. No circular dependencies.

### 10. Vague / Ambiguous Tasks — NOTE

Task 5.2 (course correction service) still lacks a concrete format example for the "structured knowledge" written to brain. Low risk — reasonable implementations would converge — but a format example would help the implementer.

### 11. Hidden Dependencies — PASS

Previously NOTE. The hidden dependency on `{{#if}}` support is resolved — Task 5.1 uses `<!-- OPTIONAL -->` markers and explicitly lists `src/services/template-renderer.ts` in its file list.

### 12. Risk Register — PASS

Seven risks with actionable mitigations. Tool counts updated to reflect 12 tools. No new risks introduced by the plan changes.

### 13. Alignment with Requirements Intent — PASS

Previously FAIL. Task 5.4 wires `course_correction_capture` into sprint templates at post-iteration checkpoints, meeting the "automatically captured" acceptance criterion.

---

## Summary

**Re-review: 12 PASS, 1 NOTE, 0 FAIL.**

All 5 findings resolved. No remaining blockers.

### Deferred / advisory:

- Task 5.2 correction format could be more concrete (check 10) — low risk, note for implementer.

---

## Phase 1 Code Review — Re-Review

**Reviewer:** fleet-reviewer (commit bc85296)
**Verdict:** APPROVED

The finding is resolved. Commit bc85296 adds 6 tests to `tests/gbrain-config.test.ts`:

- `list_members` compact output includes `gbrain=enabled` when enabled — VERIFIED
- `list_members` compact output omits `gbrain=enabled` when not enabled — VERIFIED
- `list_members` JSON output includes `gbrain` field — VERIFIED
- `member_detail` compact output includes `gbrain=enabled` when enabled — VERIFIED
- `member_detail` compact output omits `gbrain=enabled` when not enabled — VERIFIED
- `member_detail` JSON output includes `gbrain` field — VERIFIED

All 11 tests in `tests/gbrain-config.test.ts` pass (`npm test -- tests/gbrain-config.test.ts`). The original finding is fully addressed. Phase 1 code review is complete.

---

# gbrain Integration — Phase 3 Code Review — APPROVED

**Reviewer:** fleet-reviewer (Claude Opus 4.6)  
**Date:** 2026-05-13  
**Branch:** feat/gbrain-integration  
**Commit reviewed:** 13c49b3  
**Verdict:** APPROVED

---

## Files Reviewed

| File | Lines | Purpose |
|------|-------|---------|
| `src/tools/code-def.ts` | 20 | `code_def` fleet tool |
| `src/tools/code-refs.ts` | 20 | `code_refs` fleet tool |
| `src/tools/code-callers.ts` | 20 | `code_callers` fleet tool |
| `src/tools/code-callees.ts` | 20 | `code_callees` fleet tool |
| `tests/code-analysis-tools.test.ts` | 150 | 11 tests covering all four tools |
| `src/index.ts` (lines 128-131, 269-272) | — | Tool imports and registration |

---

## Review Checklist

### 1. Consistent resolve → assertGbrainEnabled → callGbrainTool pattern — PASS

All four tools follow the identical three-step pattern:
1. `resolveMember(input.member_id, input.member_name)` — early return on error string
2. `assertGbrainEnabled(agentOrError)` — early return on error string
3. `callGbrainTool('<tool_name>', { symbol: input.symbol })` — delegate to gbrain

This matches the Phase 2 `brain_query` / `brain_write` pattern exactly.

### 2. All 4 registered in `src/index.ts` — PASS

- Imports: dynamic `await import()` at lines 128-131
- Registration: `server.tool()` calls at lines 269-272 under `// --- code analysis tools ---`
- Descriptions mention gbrain-enabled prerequisite
- All wrapped with `wrapTool()` for onboarding integration

### 3. Schema correctness — PASS

All four schemas use:
- `...memberIdentifier` spread for `member_id` / `member_name`
- `symbol: z.string().describe(...)` with tool-specific descriptions

Descriptions are appropriately distinct:
- `code_def`: "The symbol (function, class, variable, etc.) to find the definition of"
- `code_refs`: "The symbol to find all references to"
- `code_callers`: "The function to find callers of"
- `code_callees`: "The function to find callees of"

### 4. gbrain tool names match canonical API — PASS

Tool names passed to `callGbrainTool()`: `code_def`, `code_refs`, `code_callers`, `code_callees` — all underscore-separated, matching the plan.

### 5. Shared helpers reused — PASS

All four files import `assertGbrainEnabled` and `callGbrainTool` from `../utils/gbrain-helpers.js`. No reimplementation of error handling or gbrain client access.

### 6. Test coverage — PASS (11/11 passing)

| Tool | Happy path | Disabled | Not-found |
|------|-----------|----------|-----------|
| `code_def` | Yes | Yes | Yes |
| `code_refs` | Yes | Yes | Yes |
| `code_callers` | Yes | Yes | No |
| `code_callees` | Yes | Yes | Yes |

- `code_callers` omits the not-found test. The code path is identical across all four tools (same `resolveMember` call), so this is cosmetic, not a risk.
- Mock isolation is correct: `vi.mock` of gbrain-client, `beforeEach`/`afterEach` registry backup/restore.
- All 11 tests pass.

### 7. DRY / duplication — ACCEPTABLE

The four tool files are nearly identical (~20 lines each), differing only in naming and `symbol` description string. A factory function could reduce this to a single file, but:
- Separate files keep each tool self-contained and easy to locate
- Consistent with Phase 2's approach (`brain-query.ts` / `brain-write.ts`)
- No logic duplication that could diverge dangerously

No action needed.

---

## Minor observations (non-blocking)

1. **Missing not-found test for `code_callers`**: Cosmetic gap — the code path is exercised identically by the other three suites.
2. **`as any` casts in `index.ts`**: All four `server.tool` registrations use `input as any`. This is a pre-existing pattern used by all other tools, not introduced by this PR.

---

## Summary

Phase 3 is clean, consistent, and well-tested. All four code analysis tools follow the established pattern, schemas are correct, shared helpers are reused, and all 11 tests pass. No issues found.

---

# gbrain Integration — Phase 4 Code Review — APPROVED

**Reviewer:** fleet-reviewer (Claude Opus 4.6)  
**Date:** 2026-05-13  
**Branch:** feat/gbrain-integration  
**Commit reviewed:** 232b3be  
**Verdict:** APPROVED

---

## Files Reviewed

| File | Lines | Purpose |
|------|-------|---------|
| `src/tools/jobs-submit.ts` | 24 | `jobs_submit` fleet tool |
| `src/tools/jobs-list.ts` | 22 | `jobs_list` fleet tool |
| `src/tools/jobs-stats.ts` | 19 | `jobs_stats` fleet tool |
| `src/tools/jobs-work.ts` | 24 | `jobs_work` fleet tool |
| `tests/jobs-tools.test.ts` | 191 | 15 tests covering all four tools |
| `src/index.ts` (lines 132-135, 279-282) | — | Tool imports and registration |

---

## Review Checklist

### 1. All 4 tools registered in `src/index.ts` — PASS

- Imports: dynamic `await import()` at lines 132-135
- Registration: `server.tool()` calls at lines 279-282
- Descriptions are clear and mention the gbrain-enabled prerequisite
- All wrapped with `wrapTool()` for onboarding integration

### 2. Schema correctness — PASS

| Tool | Required params | Optional params | Correct |
|------|----------------|-----------------|---------|
| `jobs_submit` | `task` (string) | `priority` (number) | Yes |
| `jobs_list` | — | `status` (string) | Yes |
| `jobs_stats` | — | — | Yes |
| `jobs_work` | `job_id` (string), `result` (string) | — | Yes |

All schemas include `...memberIdentifier` spread for member resolution. Priority description documents the scale (0=critical, 4=backlog, default 2). Status filter documents valid values.

### 3. gbrain tool names match canonical API — PASS

Tool names passed to `callGbrainTool()`: `jobs_submit`, `jobs_list`, `jobs_stats`, `jobs_work` — all underscore-separated, matching the plan exactly.

### 4. Shared helpers used — PASS

All four files import `assertGbrainEnabled` and `callGbrainTool` from `../utils/gbrain-helpers.js`. Same resolve → assert → call pattern as Phases 2 and 3.

### 5. Test coverage — PASS (15/15 passing)

| Tool | Happy path | Optional params | Disabled | Not-found | Server unavailable |
|------|-----------|----------------|----------|-----------|-------------------|
| `jobs_submit` | Yes | Yes (priority) | Yes | Yes | Yes |
| `jobs_list` | Yes | Yes (status) | Yes | — | — |
| `jobs_stats` | Yes | — | Yes | Yes | — |
| `jobs_work` | Yes | — | Yes | Yes | Yes |

- `jobs_submit` tests the `execute_prompt` fallback suggestion in the disabled-member error — good UX coverage.
- `jobs_submit` and `jobs_work` both test server-unavailable scenarios via mock rejection.
- Mock isolation correct: `vi.mock` of gbrain-client, `beforeEach`/`afterEach` registry backup/restore.
- All 15 tests pass (vitest, 284ms total).

### 6. No unsafe parameter passthrough — PASS

- All parameters are Zod-typed (strings and numbers) — no arbitrary object passthrough.
- `jobs_submit` uses conditional spread for `priority` (`input.priority !== undefined`) — correctly handles `0` as a valid priority value rather than falsy-checking.
- `jobs_list` uses truthy check for `status` (`input.status`) — acceptable since empty string is not a valid status value.
- `jobs_work` passes `job_id` and `result` as explicit named properties, not spread from raw input.
- Error handling delegated to `callGbrainTool` helper with try/catch and user-friendly messages.

---

## Observations (non-blocking)

1. **Smart priority handling in `jobs_submit`**: Uses `input.priority !== undefined` rather than a truthy check, correctly preserving `priority: 0` (critical). Good attention to detail.
2. **Helpful fallback in `jobs_submit`**: The disabled-member error appends "For immediate work, use execute_prompt instead." — this is the only jobs tool that does this, which makes sense since submit is the primary entry point.
3. **`as any` casts in `index.ts`**: Pre-existing pattern, not introduced by this PR.
4. **Consistent structure**: All four files follow the same ~20-line pattern established in Phases 2 and 3.

---

## Summary

Phase 4 is clean, consistent, and well-tested. All four jobs tools follow the established pattern, schemas are correct with appropriate required/optional fields, shared helpers are reused, parameter handling is safe, and all 15 tests pass. No issues found. Phase 4 is ready to merge.
