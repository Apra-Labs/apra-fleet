# gbrain Integration Plan — Reviewer Feedback

## Finding 1: Wrong gbrain tool names

**Issue:** PLAN.md used hyphenated gbrain tool names (`brain-query`, `code-callers`, `minions-dispatch`, `minions-status`) but gbrain's canonical tool names use underscores.

**Correct names:** `brain_query`, `brain_write`, `code_callers`, `code_callees`, `code_def`, `code_refs`, `jobs_submit`, `jobs_list`, `jobs_stats`, `jobs_work`.

**Impact:** `minions-dispatch` and `minions-status` don't exist at all in gbrain — the actual tools are `jobs_submit`, `jobs_list`, `jobs_stats`, `jobs_work` (four tools, not two). This also changes the tool count from 10 to 12.

**Doer:** fixed in commit a5d21d5 + eab88d0 — replaced all hyphenated tool names with underscore versions; replaced `minions-dispatch`/`minions-status` with the four `jobs_*` tools throughout PLAN.md; updated tool counts and mapping notes.

---

## Finding 2: Template conditionals

**Issue:** PLAN.md used Handlebars-style `{{#if gbrain}}...{{/if}}` conditionals in the reviewer template, but the PM skill only supports simple `{{PLACEHOLDER}}` token substitution.

**Correct approach:** Use `<!-- OPTIONAL: gbrain -->...<!-- /OPTIONAL: gbrain -->` HTML comment markers. The PM template renderer strips these sections when gbrain is not enabled.

**Doer:** fixed in commit a5d21d5 + eab88d0 — replaced all `{{#if gbrain}}` references with `<!-- OPTIONAL: gbrain -->` marker approach; added `src/services/template-renderer.ts` to Task 5.1 file list; updated Notes section.

---

## Finding 3: Wire course correction into PM sprint flow

**Issue:** `course_correction_capture` was defined as a tool (Task 5.3) and service (Task 5.2) but never wired into the PM sprint execution flow. Corrections would only be captured if someone manually called the tool.

**Correct approach:** Add explicit `course_correction_capture` call-sites in sprint templates (`single-pair-sprint.md`, `doer-reviewer.md`) at post-iteration review checkpoints, wrapped in `<!-- OPTIONAL: gbrain -->` blocks.

**Doer:** fixed in commit a5d21d5 + eab88d0 — added Task 5.4 (wire course_correction_capture into sprint templates) with template-based approach; renumbered former Task 5.4 to Task 5.5.

---

## Finding 4: Move shared helpers earlier

**Issue:** Shared helpers (`assertGbrainEnabled`, `callGbrainTool`) were deferred to Phase 6 Task 6.1, but the pattern first appears in Phase 2. This would mean Phases 2-5 all inline their own gbrain checks, then Phase 6 refactors them — unnecessary churn.

**Correct approach:** Create helpers in Phase 2 (new Task 2.0) so all subsequent phases use them from the start. Task 6.1 becomes a DRY audit rather than an extraction.

**Doer:** fixed in commit a5d21d5 + eab88d0 — added Task 2.0 (create shared gbrain helpers) in Phase 2; reduced Task 6.1 to a DRY audit; updated Task 3.1 to reference Task 2.0 helpers.

---

## Finding 5: Phase 1 tier monotonicity

**Issue:** Phase 1 tier sequence violates monotonicity: Task 1.1 (cheap) → Task 1.2 (cheap) → Task 1.3 (premium) → Task 1.4 (standard). A tier downgrade within the phase indicates a structural issue with task ordering or tier assignments.

**Correct approach:** Promote Task 1.4 to premium tier. Tests for the premium client service (mocked child process, MCP client lifecycle, reconnection) justify premium tier. This makes the sequence: cheap → cheap → premium → premium.

**Doer:** fixed in commit f29375c — promoted Task 1.4 to premium tier in PLAN.md.
