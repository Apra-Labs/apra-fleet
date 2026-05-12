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

Task 5.1 now specifies `<!-- OPTIONAL: gbrain -->` / `<!-- /OPTIONAL: gbrain -->` markers instead of `{{#if gbrain}}...{{/if}}` Handlebars conditionals. Task 5.1 also adds `src/services/template-renderer.ts` to its file list for optional-section stripping logic, properly accounting for the code change needed. The Notes section is updated to match. This is compatible with the PM skill's simple `{{PLACEHOLDER}}` token model. Fixed in commits a5d21d5 + eab88d0.

### Finding 3: Course correction wiring — RESOLVED

New Task 5.4 ("Wire course_correction_capture into PM sprint execution flow") added. It chooses Option A (template-based) for explicitness and auditability: adds `course_correction_capture` call-sites to `skills/pm/single-pair-sprint.md` and `skills/pm/doer-reviewer.md` at post-iteration review checkpoints, wrapped in `<!-- OPTIONAL: gbrain -->` blocks. Done-when criteria are clear: corrections in gbrain-enabled sprints are persisted to brain, non-gbrain sprints unaffected. This addresses the "automatically captured" acceptance criterion — automatic from the user's perspective, no manual tool invocation needed. Fixed in commits a5d21d5 + eab88d0.

### Finding 4: DRY helpers — RESOLVED

New Task 2.0 ("Create shared gbrain helpers") creates `src/utils/gbrain-helpers.ts` with `assertGbrainEnabled()` and `callGbrainTool()` at the start of Phase 2, before any tools that use the pattern. Task 3.1 updated to explicitly reference "Use shared helpers from Task 2.0." Task 6.1 reduced from an extraction to a DRY audit — verifies consistency, no new files. Helpers are available from Phase 2 onward so Phases 3–5 use them from the start. Fixed in commits a5d21d5 + eab88d0.

### Finding 5: Phase 1 tier monotonicity — STILL OPEN

Phase 1 tier sequence remains: cheap (1.1) → cheap (1.2) → **premium** (1.3) → **standard** (1.4). The premium → standard transition is still a tier downgrade, violating the monotonically non-decreasing rule. This finding was not mentioned in feedback-gbrain.md and PLAN.md was not updated to address it.

**Fix (same as original):** Promote Task 1.4 from standard to premium tier. The tests for the gbrain client service (mocked child process, MCP client lifecycle, reconnection) are complex enough to justify premium tier. This makes the sequence: cheap → cheap → premium → premium.

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

### 7. Tier Monotonicity — FAIL

Phase 1 sequence: cheap (1.1) → cheap (1.2) → premium (1.3) → standard (1.4). Premium → standard is decreasing. See Finding 5 above for the fix.

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

**Re-review: 11 PASS, 1 NOTE, 1 FAIL.**

4 of 5 previous findings resolved. One remaining blocker:

### Must change before approval:

1. **Tier monotonicity (Finding 5):** Phase 1 still has premium (1.3) → standard (1.4) — a decreasing tier. Promote Task 1.4 to premium to make the sequence cheap → cheap → premium → premium. This is a one-word change.

### Deferred / advisory:

- Task 5.2 correction format could be more concrete (check 10) — low risk, note for implementer.
