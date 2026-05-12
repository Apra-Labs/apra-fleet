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
