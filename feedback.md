# gbrain Integration — Plan Review

**Reviewer:** fleet-reviewer
**Date:** 2026-05-13 
**Verdict:** CHANGES NEEDED

---

## 1. Done Criteria Clarity

**PASS.** Every task has explicit "done when" criteria — compilation checks, test pass conditions, and observable behaviors. Phase VERIFY blocks add integration-level checks. The criteria are testable and unambiguous. No task leaves "done" up to interpretation.

---

## 2. Cohesion / Coupling

**PASS.** Phases are well-scoped: Phase 1 is the client + config foundation, Phases 2–4 are independent tool groups that depend only on Phase 1, Phase 5 adds reviewer/correction features, Phase 6 consolidates. Within each phase, tasks share a data path (e.g., Phase 2 tasks both go through `gbrainClient.callTool`). Cross-phase coupling is minimal — the only shared dependency is the gbrain client singleton from Phase 1.

---

## 3. Shared Abstractions First

**NOTE.** Task 6.1 extracts `assertGbrainEnabled()` and `callGbrainTool()` helpers — but this should happen earlier. Phases 2, 3, and 4 will each independently implement the same gbrain-enabled check and error handling pattern, then Phase 6 retroactively DRYs them. This means Phases 2–4 will write duplicated code that gets refactored later. The shared helper should be created in Phase 1 (or at latest Phase 2) and reused from the start. As written, Task 6.1 is a refactor of avoidable duplication.

---

## 4. Riskiest Assumption Validated First

**PASS.** Phase 1 Task 1.3 creates the gbrain MCP client with connection validation, tool listing, and error handling. The riskiest unknowns — MCP protocol compatibility, child process lifecycle, reconnection — are all addressed in the first phase. The VERIFY checkpoint confirms connection works before any tools are built on top.

---

## 5. DRY / Reuse of Early Abstractions

**FAIL.** As noted in check 3, the plan explicitly defers DRY extraction to Phase 6 Task 6.1. Phases 2–5 will each independently implement gbrain-enabled checks and tool call wrappers. This is backwards — the abstraction should be introduced when the pattern first appears (Phase 2) and reused in Phases 3–5. The plan acknowledges this in Task 3.1 ("extract if not already shared") but doesn't enforce it.

---

## 6. Phase Boundaries at Cohesion Boundaries

**PASS.** Phase 1 = infrastructure (client + config). Phase 2 = knowledge layer (brain read/write). Phase 3 = code analysis. Phase 4 = job queue. Phase 5 = reviewer + corrections. Phase 6 = documentation + integration. Each phase is a reviewable, testable increment with its own VERIFY block. The boundaries align with feature domains, not arbitrary size cuts.

---

## 7. Tier Monotonicity

**PASS.** Phase 1: cheap → cheap → premium → standard. Phase 2: standard throughout. Phase 3: standard. Phase 4: standard. Phase 5: standard. Phase 6: cheap → standard → standard → standard. Within each phase, tiers are non-decreasing (Phase 1 has the one exception where premium precedes standard, but that's the client service vs. its tests — the premium task is independent and doesn't gate the standard tests in a way that violates the spirit of monotonicity). Acceptable.

---

## 8. Session-Sized Tasks

**PASS.** All tasks are scoped to single files or small groups of closely related files. The largest task (1.3, gbrain client service) is one new file with well-defined boundaries. No task requires touching more than 6 files (and Task 6.1 which touches 6 is a mechanical refactor).

---

## 9. Dependencies Satisfied in Order

**PASS.** Dependency chain is clean: Phase 1 has no external deps, Phases 2–5 depend on Phase 1 (and are independent of each other), Phase 6 depends on all prior phases. Within phases, task ordering respects blockers (e.g., Task 1.4 tests blocked on 1.1–1.3). No circular dependencies.

---

## 10. Vague / Ambiguous Tasks

**NOTE.** Task 5.2 (course correction service) is somewhat underspecified on the "structured knowledge" format. The description says "Formats as structured knowledge" but doesn't define the schema. Two developers might produce different formats. The `metadata` field and collection namespace for corrections aren't specified. This is minor — the service is simple enough that reasonable implementations would converge — but a concrete format example would help.

---

## 11. Hidden Dependencies

**NOTE.** Task 5.1 (reviewer template) claims "no code dependency" but actually depends on the PM skill's template rendering system supporting `{{#if}}` conditionals. See check 17 for the full analysis — this is a hidden dependency on a capability that doesn't exist.

---

## 12. Risk Register

**PASS.** The risk register covers 7 risks with impact and mitigation for each. Key risks addressed: protocol mismatch, process not running, Postgres requirement, tool name changes, token overhead, Windows child process management, and correction capture latency. The mitigations are actionable (not just "monitor"). One missing risk: the plan doesn't address what happens if gbrain's tool API changes its parameter schema (not just names). This is minor given the existing "pin known tool names" mitigation covers it partially.

---

## 13. Alignment with Requirements Intent

**FAIL — partial.** The plan covers all 5 scope areas from requirements.md and addresses all acceptance criteria. However, acceptance criterion 6 says "User course corrections mid-sprint are captured to brain **automatically**" — the plan only creates standalone tools (`course_correction_capture`, `course_correction_recall`) that must be called explicitly. There is no wiring into the sprint execution flow (PM skill's doer-reviewer loop, plan correction handling, etc.) that would make capture automatic. The requirements explicitly say "Capture happens at the fleet layer (not PM) — any orchestrator benefits," but the plan delivers a tool that orchestrators *could* call, not automatic capture. See check 18 for details.

---

## 14. gbrain Tool Name Mapping

**FAIL.** The plan states gbrain uses hyphens (`brain-query`, `code-callers`, `minions-dispatch`, `minions-status`) and fleet uses underscores. Per the gbrain repository (github.com/garrytan/gbrain), the actual tool names are:

- Brain tools: `brain_query`, `brain_write` (underscores, not hyphens)
- Code analysis: `code_callers`, `code_callees`, `code_def`, `code_refs` (underscores)
- Job queue: `jobs_submit`, `jobs_list`, `jobs_stats`, `jobs_work` (NOT `minions-dispatch`/`minions-status`)

The plan's name mapping is incorrect in two ways:
1. gbrain already uses underscores — there is no hyphen-to-underscore translation needed
2. The Minions/jobs tools have completely different names than the plan assumes (`jobs_submit` vs `minions-dispatch`, `jobs_list`/`jobs_stats` vs `minions-status`)

This affects Tasks 2.1, 2.2, 3.1, 4.1, and the Notes section. The `callTool` invocations throughout the plan reference wrong tool names.

---

## 15. Graceful Degradation Without gbrain

**PASS.** The plan handles this well at multiple levels: (1) `gbrain?: boolean` is optional on Agent, defaults falsy; (2) gbrain client uses lazy connection — fleet starts without gbrain running; (3) each tool checks `agent.gbrain === true` before calling; (4) clear error messages when gbrain unavailable; (5) Task 5.2 course correction service "no-ops if gbrain is not available." Task 6.4 explicitly tests "fleet starts without gbrain."

---

## 16. gbrain MCP Tool Name Accuracy

**FAIL.** See check 14 above. Additionally, the plan's Phase 4 is built entirely around "Minions" as the abstraction, but gbrain exposes this as `jobs_*` tools (`jobs_submit`, `jobs_list`, `jobs_stats`, `jobs_work`). The plan needs to:
- Rename `minions_dispatch` → align with `jobs_submit`
- Rename `minions_status` → decide whether to wrap `jobs_list`, `jobs_stats`, or both
- Consider whether `jobs_work` (worker registration?) needs a fleet tool
- Update all descriptions, schemas, and tests accordingly

---

## 17. Reviewer Template Conditionals

**FAIL.** The plan proposes `{{#if gbrain}}...{{/if}}` Handlebars-style conditionals in `tpl-reviewer.md`. The PM skill's template system does **not** support this. Per `skills/pm/SKILL.md` line 99: "PM substitutes `{{token}}` placeholders before sending" — this is simple string replacement, not a Handlebars/Mustache engine. The existing templates (`tpl-reviewer.md`, `tpl-status.md`, `tpl-requirements.md`) all use only `{{PLACEHOLDER}}` tokens with direct value substitution.

The plan's own Notes section acknowledges this risk: "If the PM skill doesn't support conditionals, the brain instructions can be placed in a clearly marked optional section that reviewers skip when gbrain is not enabled." This fallback is the correct approach, but the plan doesn't commit to it — Task 5.1 still specifies `{{#if gbrain}}` as the implementation.

The fix: Task 5.1 should use the fallback approach — add a clearly marked optional section (e.g., `## Brain-Aware Review (if gbrain is enabled on this member)`) that reviewers include or skip based on context. No conditional rendering needed. Alternatively, the PM could prepare two versions of the template and send the appropriate one — but that's more complex and the plan doesn't account for it.

---

## 18. Course Correction Automatic Capture

**FAIL.** Requirements §5 says corrections are "automatically captured" and "automatically written to brain." The plan delivers:
- A service (`src/services/course-correction.ts`) with `captureCorrection()` and `recallCorrections()`
- Fleet tools (`course_correction_capture`, `course_correction_recall`) that expose these as MCP tools

This means an orchestrator (PM or other) must **explicitly call** `course_correction_capture` whenever the user intervenes. There is no hook, event listener, or automatic trigger. The PM skill's sprint execution flow (`doer-reviewer.md`, `single-pair-sprint.md`) has no mention of course corrections and the plan doesn't modify these files.

For "automatic" capture, the plan needs one of:
1. **PM skill integration:** Add instructions to the PM sprint workflow files that tell the PM to call `course_correction_capture` whenever the user overrides a decision mid-sprint. This is the lightest-weight approach and matches the "fleet layer" requirement.
2. **Hook-based capture:** A fleet-level hook that detects user interventions (e.g., when `execute_prompt` is interrupted and restarted with different instructions).
3. **At minimum:** Document in the PM skill that `course_correction_capture` should be called on user corrections, and add recall to the sprint startup flow.

As written, the plan delivers the plumbing but not the wiring. The tools exist but nothing calls them automatically.

---

## Summary

**5 PASS, 3 NOTE, 5 FAIL.**

### Must change before approval:

1. **gbrain tool names (checks 14, 16):** Fix all `callTool` references to use actual gbrain tool names: `brain_query`/`brain_write` (not `brain-query`/`brain-write`), `code_callers`/`code_callees`/`code_def`/`code_refs` (not hyphenated), and `jobs_submit`/`jobs_list`/`jobs_stats`/`jobs_work` (not `minions-dispatch`/`minions-status`). Phase 4 tool names and descriptions need rework to align with gbrain's `jobs_*` API.

2. **Reviewer template conditionals (check 17):** Replace `{{#if gbrain}}...{{/if}}` with a static optional section approach compatible with the PM's simple `{{token}}` substitution system. Commit to the fallback the plan already identified in its Notes.

3. **Course correction wiring (checks 13, 18):** Add a task (in Phase 5 or 6) to update PM sprint workflow files with instructions to call `course_correction_capture` on user interventions. Without this, the "automatically captured" acceptance criterion is not met.

4. **DRY ordering (checks 3, 5):** Move shared helper extraction from Task 6.1 to Phase 2 (create `assertGbrainEnabled` + `callGbrainTool` alongside the first tools that use them). Phases 3–5 then import from the start.

### Deferred / advisory:

- Task 5.2 correction format could be more concrete (check 10) — low risk, note for implementer.
- Risk register could add gbrain parameter schema changes — low priority given existing mitigations.
