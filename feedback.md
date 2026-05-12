# gbrain Integration — Plan Re-Review

**Reviewer:** fleet-reviewer
**Date:** 2026-05-13 20:30:00+05:30
**Verdict:** CHANGES NEEDED

---

## Previous Findings Resolution

### Finding 1: gbrain tool names (checks 14, 16) — RESOLVED

**Doer fixed in:** a5d21d5, eab88d0

All tool names now use underscores matching gbrain's canonical API: `brain_query`, `brain_write`, `code_callers`, `code_callees`, `code_def`, `code_refs`, `jobs_submit`, `jobs_list`, `jobs_stats`, `jobs_work`. The Notes section confirms "No name translation needed — fleet passes tool names through directly." Phase 4 was correctly expanded from 2 tools (`minions_dispatch`, `minions_status`) to 4 tools matching gbrain's actual `jobs_*` API (`jobs_submit`, `jobs_list`, `jobs_stats`, `jobs_work`). Tool counts updated throughout (10 → 12). All `callTool` references in Tasks 2.1, 2.2, 3.1, 4.1, 6.2, 6.3, 6.4, and the Notes section are consistent.

### Finding 2: Reviewer template conditionals (check 17) — RESOLVED

**Doer fixed in:** eab88d0

Task 5.1 now specifies `<!-- OPTIONAL: gbrain -->` / `<!-- /OPTIONAL: gbrain -->` markers instead of `{{#if gbrain}}...{{/if}}`. The Notes section is updated to match. Task 5.1 also adds `src/services/template-renderer.ts` to its file list for the stripping logic, which properly accounts for the code change needed. This is compatible with the PM skill's simple `{{PLACEHOLDER}}` token model.

### Finding 3: Course correction wiring (checks 13, 18) — RESOLVED

**Doer fixed in:** eab88d0

New Task 5.4 "Wire course_correction_capture into PM sprint execution flow" added. Explicitly chooses Option A (template-based) for auditability. Adds `course_correction_capture` call-sites to `skills/pm/single-pair-sprint.md` and `skills/pm/doer-reviewer.md` at post-iteration checkpoints. Uses the same `<!-- OPTIONAL: gbrain -->` block pattern for conditional inclusion. The task's "done when" criteria are clear: corrections in gbrain-enabled sprints are persisted, non-gbrain sprints unaffected. This addresses the "automatically captured" acceptance criterion.

### Finding 4: DRY ordering (checks 3, 5) — RESOLVED

**Doer fixed in:** eab88d0

New Task 2.0 "Create shared gbrain helpers" added at the start of Phase 2 with `assertGbrainEnabled` and `callGbrainTool` in `src/utils/gbrain-helpers.ts`. Task 3.1 updated to reference "Use shared helpers from Task 2.0" instead of the vague "extract if not already shared." Task 6.1 reduced from extraction to a DRY audit/verification pass — it no longer creates new files, just verifies consistency. Helpers are available from Phase 2 onward, so Phases 3–5 use them from the start.

### Finding 5: Tier monotonicity (check 7) — NOT RESOLVED

Phase 1 tier sequence is still: cheap (1.1) → cheap (1.2) → **premium** (1.3) → **standard** (1.4). Premium → standard is decreasing. The original review requested either reordering Task 1.3 to the end (cheap → cheap → standard → premium) or promoting Task 1.4 to premium. Neither change was made. The task order, tier assignments, and descriptions are identical to the original plan for Phase 1.

---

## Full Plan Review

### 1. Done Criteria Clarity

**PASS.** Every task has explicit "done when" criteria. New tasks (2.0, 5.4) also have clear criteria. Phase VERIFY blocks remain testable and unambiguous.

---

### 2. Cohesion / Coupling

**PASS.** Phase structure unchanged. New Task 2.0 (helpers) is correctly placed — it's foundational for its phase and reused downstream. Task 5.4 (sprint wiring) is correctly scoped to Phase 5 alongside the other course-correction work.

---

### 3. Shared Abstractions First

**PASS.** Task 2.0 now creates the shared helpers before any tools are implemented. Task 3.1 explicitly references "Use shared helpers from Task 2.0." The previous finding is resolved.

---

### 4. Riskiest Assumption Validated First

**PASS.** Phase 1 still addresses MCP protocol compatibility, child process lifecycle, and reconnection before any tools are built.

---

### 5. DRY / Reuse of Early Abstractions

**PASS.** Task 2.0 creates helpers at Phase 2 start. Task 6.1 is now a verification audit, not a retroactive extraction. Phases 3–5 import helpers from the start.

---

### 6. Phase Boundaries at Cohesion Boundaries

**PASS.** Boundaries still align with feature domains. No change from original assessment.

---

### 7. Tier Monotonicity

**FAIL.** Phase 1 tier sequence: cheap (1.1) → cheap (1.2) → premium (1.3) → standard (1.4). Premium → standard is decreasing. This was finding #5 from the original review and was not addressed.

**Fix:** Promote Task 1.4 to premium tier. Tests for the premium client service (mocked child process, MCP client lifecycle, reconnection) justify premium tier. This makes the sequence: cheap → cheap → premium → premium.

---

### 8. Session-Sized Tasks

**PASS.** All tasks remain appropriately scoped. New tasks (2.0, 5.4) are small and focused.

---

### 9. Dependencies Satisfied in Order

**PASS.** Task 2.0 depends on 1.3 (gbrain client) — correct. Task 5.4 depends on 5.2 and 5.3 — correct. No circular dependencies introduced.

---

### 10. Vague / Ambiguous Tasks

**NOTE.** Task 5.2 correction format still underspecified (same as original review). Low risk — noted for implementer.

---

### 11. Hidden Dependencies

**PASS.** The previous hidden dependency (Task 5.1 depending on `{{#if}}` support that doesn't exist) is resolved. Task 5.1 now uses `<!-- OPTIONAL -->` markers and explicitly lists `src/services/template-renderer.ts` in its file list. Task 5.4 lists the sprint template files it will modify. No hidden dependencies remain.

---

### 12. Risk Register

**PASS.** Risk register updated to reflect 12 tools (was 10). All 7 risks still have actionable mitigations.

---

### 13. Alignment with Requirements Intent

**PASS.** Task 5.4 addresses "automatically captured" by wiring `course_correction_capture` into sprint templates. PM will call the tool at post-iteration checkpoints when gbrain is enabled. This is "automatic" from the user's perspective — no manual invocation needed.

---

### 14. gbrain Tool Name Mapping

**PASS.** All tool names use underscores matching gbrain's canonical names. The Notes section confirms direct passthrough with no translation layer. All references are consistent across tasks, VERIFY blocks, and documentation tasks.

---

### 15. Graceful Degradation Without gbrain

**PASS.** No changes to degradation behavior. Lazy connect, opt-in per member, clear errors, silent no-op for corrections. Task 6.4 still tests startup without gbrain.

---

### 16. gbrain MCP Tool Name Accuracy

**PASS.** Phase 4 now correctly wraps `jobs_submit`, `jobs_list`, `jobs_stats`, `jobs_work` — matching gbrain's actual API. The old `minions_dispatch` / `minions_status` naming is fully replaced.

---

### 17. Reviewer Template Conditionals

**PASS.** Task 5.1 uses `<!-- OPTIONAL: gbrain -->` / `<!-- /OPTIONAL: gbrain -->` markers. Template renderer will strip these sections when gbrain is not enabled. Compatible with the PM skill's `{{PLACEHOLDER}}` substitution system. Notes section confirms the approach.

---

### 18. Course Correction Automatic Capture

**PASS.** Task 5.4 adds explicit `course_correction_capture` call-sites to `single-pair-sprint.md` and `doer-reviewer.md` using `<!-- OPTIONAL: gbrain -->` blocks. This provides automatic capture within gbrain-enabled sprints. Option A (template-based) was chosen for explicitness and auditability — the right call given fleet's current architecture.

---

## Summary

**Re-review: 14 PASS, 1 NOTE, 1 FAIL.**

4 of 5 previous findings resolved. One remaining blocker:

### Must change before approval:

1. **Tier monotonicity (check 7):** Phase 1 still has premium (1.3) → standard (1.4) — a decreasing tier sequence. Promote Task 1.4 to premium tier to make the sequence cheap → cheap → premium → premium.

### Deferred / advisory:

- Task 5.2 correction format could be more concrete (check 10) — low risk, note for implementer.
