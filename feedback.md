# gbrain Integration — Plan Review

**Reviewer:** fleet-reviewer
**Date:** 2026-05-13 18:45:00+05:30
**Verdict:** CHANGES NEEDED

---

## 1. Done Criteria Clarity

**PASS.** Every task has explicit "done when" criteria — compilation checks, test pass conditions, and observable behaviors. Phase VERIFY blocks add integration-level checks. The criteria are testable and unambiguous. No task leaves "done" up to interpretation.

---

## 2. Cohesion / Coupling

**PASS.** Phases are well-scoped: Phase 1 is the client + config foundation, Phases 2–4 are independent tool groups that depend only on Phase 1, Phase 5 adds reviewer/correction features, Phase 6 consolidates. Within each phase, tasks share a data path (e.g., Phase 2 tasks both go through `gbrainClient.callTool`). Cross-phase coupling is minimal — the only shared dependency is the gbrain client singleton from Phase 1.

---

## 3. Shared Abstractions First

**NOTE.** Task 6.1 extracts `assertGbrainEnabled()` and `callGbrainTool()` helpers — but this should happen earlier. Phases 2, 3, and 4 will each independently implement the same gbrain-enabled check and error handling pattern, then Phase 6 retroactively DRYs them. The shared helper should be created in Phase 2 (alongside the first tools that use the pattern) and reused from the start. As written, Task 6.1 is a refactor of avoidable duplication.

---

## 4. Riskiest Assumption Validated First

**PASS.** Phase 1 Task 1.3 creates the gbrain MCP client with connection validation, tool listing, and error handling. The riskiest unknowns — MCP protocol compatibility, child process lifecycle, reconnection — are all addressed in the first phase. The VERIFY checkpoint confirms connection works before any tools are built on top.

---

## 5. DRY / Reuse of Early Abstractions

**FAIL.** As noted in check 3, the plan explicitly defers DRY extraction to Phase 6 Task 6.1. Phases 2–5 will each independently implement gbrain-enabled checks and tool call wrappers. This is backwards — the abstraction should be introduced when the pattern first appears (Phase 2) and reused in Phases 3–5. The plan acknowledges this in Task 3.1 ("extract if not already shared") but doesn't enforce it.

**Fix:** Move helper extraction to Phase 2 as Task 2.0 or fold it into Task 2.1. Delete Task 6.1 or reduce it to a verification pass.

---

## 6. Phase Boundaries at Cohesion Boundaries

**PASS.** Phase 1 = infrastructure (client + config). Phase 2 = knowledge layer (brain read/write). Phase 3 = code analysis. Phase 4 = job queue. Phase 5 = reviewer + corrections. Phase 6 = documentation + integration. Each phase is a reviewable, testable increment with its own VERIFY block. The boundaries align with feature domains, not arbitrary size cuts.

---

## 7. Tier Monotonicity

**FAIL.** Phase 1 tier sequence: cheap (1.1) → cheap (1.2) → **premium** (1.3) → **standard** (1.4). Premium → standard is *decreasing*, violating the "non-decreasing within each phase" rule. Task 1.4 (tests for Phase 1) is standard tier but follows premium Task 1.3. All other phases are monotonically non-decreasing.

**Fix:** Either reorder Task 1.3 to the end of Phase 1 (so sequence becomes cheap → cheap → standard → premium), or promote Task 1.4 to premium tier to match.

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

**FAIL — partial.** The plan covers all 5 scope areas from requirements.md and addresses most acceptance criteria. However, acceptance criterion 6 says "User course corrections mid-sprint are captured to brain **automatically**" — the plan only creates standalone tools (`course_correction_capture`, `course_correction_recall`) that must be called explicitly. There is no wiring into the sprint execution flow (PM skill's doer-reviewer loop, plan correction handling, etc.) that would make capture automatic. The requirements explicitly say "Capture happens at the fleet layer (not PM) — any orchestrator benefits," but the plan delivers a tool that orchestrators *could* call, not automatic capture. See check 18 for details.

---

## 14. gbrain Tool Name Mapping

**FAIL.** The plan assumes gbrain tools use hyphens (`brain-query`, `code-callers`, `minions-dispatch`, `minions-status`) and that fleet needs a hyphen-to-underscore translation. Per inspection of the gbrain repository (github.com/garrytan/gbrain):

- **Code analysis CLI subcommands** use hyphens: `code-callers`, `code-callees`, `code-def`, `code-refs` — but MCP tool registration names may differ (the source tool-defs.ts was not directly accessible)
- **Brain operations** appear to be `query` (with synthesis + citations) and `search`/`get`, not `brain-query` / `brain-write`
- **Job queue** tools are `jobs submit`, `jobs list`, `jobs stats`, `jobs supervisor` — NOT `minions-dispatch` / `minions-status`

The plan's name mapping is incorrect in at least two ways:
1. The brain tool names don't match (`brain-query`/`brain-write` vs likely `query`/something else)
2. The Minions/jobs tools have completely different names than the plan assumes (`jobs submit` vs `minions-dispatch`, `jobs list`/`jobs stats` vs `minions-status`)

**Fix:** Before finalizing the plan, run `npx -y gbrain` locally, connect as an MCP client, and call `listTools()` to get the authoritative tool name list. Update all `callTool` references in Tasks 2.1, 2.2, 3.1, 4.1, and the Notes section. Phase 4 tool names and descriptions need rework to align with gbrain's actual `jobs_*` API.

---

## 15. Graceful Degradation Without gbrain

**PASS.** The plan handles this well at multiple levels: (1) `gbrain?: boolean` is optional on Agent, defaults falsy; (2) gbrain client uses lazy connection — fleet starts without gbrain running; (3) each tool checks `agent.gbrain === true` before calling; (4) clear error messages when gbrain unavailable; (5) Task 5.2 course correction service "no-ops if gbrain is not available." Task 6.4 explicitly tests "fleet starts without gbrain."

---

## 16. gbrain MCP Tool Name Accuracy

**FAIL.** See check 14 above. Additionally, Phase 4 is built entirely around "Minions" as the abstraction, but gbrain exposes job queue functionality as `jobs *` tools. The plan needs to:
- Rename `minions_dispatch` → align with actual `jobs submit` / `jobs_submit`
- Rename `minions_status` → decide whether to wrap `jobs list`, `jobs stats`, or both
- Consider whether `jobs work` / `jobs supervisor` (worker registration?) needs fleet tools
- Update all descriptions, schemas, and tests accordingly

---

## 17. Reviewer Template Conditionals

**FAIL.** The plan proposes `{{#if gbrain}}...{{/if}}` Handlebars-style conditionals in `tpl-reviewer.md`. The PM skill's template system does **not** support this. Per `skills/pm/SKILL.md` line 99: "PM substitutes `{{token}}` placeholders before sending" — this is simple string replacement, not a Handlebars/Mustache engine. All existing templates (`tpl-reviewer.md`, `tpl-status.md`, `tpl-requirements.md`) use only `{{PLACEHOLDER}}` tokens with direct value substitution.

The plan's own Notes section acknowledges this risk: "If the PM skill doesn't support conditionals, the brain instructions can be placed in a clearly marked optional section that reviewers skip when gbrain is not enabled." This fallback is the correct approach, but the plan doesn't commit to it — Task 5.1 still specifies `{{#if gbrain}}` as the implementation.

**Fix:** Task 5.1 should use the fallback approach — add a clearly marked optional section (e.g., `## Brain-Aware Review (if gbrain is enabled on this member)`) that reviewers include or skip based on context. No conditional rendering needed. Alternatively, the PM could prepare two template variants and `send_files` the appropriate one — but that adds complexity the plan doesn't account for.

---

## 18. Course Correction Automatic Capture

**FAIL.** Requirements §5 says corrections are "automatically captured" and "automatically written to brain." The plan delivers:
- A service (`src/services/course-correction.ts`) with `captureCorrection()` and `recallCorrections()`
- Fleet tools (`course_correction_capture`, `course_correction_recall`) that expose these as MCP tools

This means an orchestrator (PM or other) must **explicitly call** `course_correction_capture` whenever the user intervenes. There is no hook, event listener, or automatic trigger.

Investigation of the codebase confirms:
- Fleet has an `AbortSignal` pattern in `execute_prompt` for cancellation, but no correction-capture hook
- The `wrapTool()` function in `src/index.ts` wraps all tool handlers but has no event hooks for corrections
- `hooks/hooks-config.json` only triggers on `register_member` — no sprint-lifecycle hooks exist
- PM sprint workflow files (`doer-reviewer.md`, `single-pair-sprint.md`) have no mention of course corrections

For "automatic" capture, the plan needs one of:
1. **PM skill workflow update (lightest):** Add instructions to PM sprint files telling PM to call `course_correction_capture` whenever the user overrides a decision mid-sprint. This is instruction-level wiring — no code change, just template/workflow text.
2. **PostToolUse hook:** Add a fleet hook that fires after `stop_prompt` or plan re-execution to capture the correction context.
3. **At minimum:** Document in the PM skill that `course_correction_capture` should be called on user corrections, and add `course_correction_recall` to the sprint startup flow.

As written, the plan delivers the plumbing but not the wiring.

---

## Summary

**5 PASS, 3 NOTE, 6 FAIL.**

### Must change before approval:

1. **gbrain tool names (checks 14, 16):** Verify actual MCP tool names by running gbrain locally and calling `listTools()`. Fix all `callTool` references. Phase 4 naming (`minions_*`) needs rework to align with gbrain's `jobs_*` API. Brain tool names (`brain-query`/`brain-write`) likely need correction too.

2. **Reviewer template conditionals (check 17):** Replace `{{#if gbrain}}...{{/if}}` with a static optional section approach compatible with the PM's simple `{{token}}` substitution system. Commit to the fallback the plan already identified in its Notes.

3. **Course correction wiring (checks 13, 18):** Add a task (in Phase 5 or 6) to update PM sprint workflow files with instructions to call `course_correction_capture` on user interventions. Without this, the "automatically captured" acceptance criterion is not met.

4. **DRY ordering (checks 3, 5):** Move shared helper extraction from Task 6.1 to Phase 2 (create `assertGbrainEnabled` + `callGbrainTool` alongside the first tools that use them). Phases 3–5 then import from the start.

5. **Tier monotonicity (check 7):** Fix Phase 1 tier ordering — premium (1.3) → standard (1.4) is decreasing. Reorder or re-tier.

### Deferred / advisory:

- Task 5.2 correction format could be more concrete (check 10) — low risk, note for implementer.
- Risk register could add gbrain parameter schema changes — low priority given existing mitigations.
