# OpenCode+PM epic - Plan Review

**Reviewer:** zxmc2 (plan-reviewer)
**Date:** 2026-06-13
**Branch:** feat/opencode-pm-epic
**Documents reviewed:** requirements.md, design.md, plan.md, docs/opencode-exploration.md, old PM skill files (git show main:skills/pm/* -- all 21 files), src/providers/provider.ts (ProviderAdapter interface, 5 readonly properties + 26 methods), src/providers/codex.ts (reference adapter)

---

## Verdict: CHANGES NEEDED

Three blocking defect categories: (1) the parseResponse design section presents a fabricated NDJSON schema contradicted by the PM's own verified observations and incorrectly claims usage metrics are unavailable when they are emitted in `step_finish.part.tokens`; (2) the gap analysis covers only 9 of 14 core operational rules, hides 5 behind an implicit "etc.", and misclassifies two user-facing features (resume rules, simple sprint) as "should port" when dropping them would break existing workflows; (3) the plan violates its own tier monotonicity rule in three phases and contains a task (T2.2) that likely exceeds the ~50 tool-call ceiling.

---

## Section A: Gap Analysis Completeness -- FAIL

**What works:** The gap table is structurally sound -- 26 rows covering all 21 old-pm files file-by-file. Every old concept gets a row. The status column (Present / Missing / Partial) is clear and well-reasoned. Both "Drop" decisions (#1 fleet dependency and #2 dependency bootstrap) are correct: pm-lite's fleet-independent design is the whole point of the unification, and re-introducing fleet coupling would defeat the purpose. The 7 must-port / 3 should-port / 2 drop structure is clearly articulated.

The comparison between old multi-pair-sprint.md and pm-lite's worktrees.md (gap row #19, marked "Present, different approach") is correctly assessed -- worktrees.md is architecturally more sophisticated (single orchestrator, multiple branches via git worktrees) than the old multi-member-pair model, and the worktree approach maps cleanly to fleet dispatch (each worktree -> one member's work_folder). No port needed.

**What fails:**

1. **5 of 14 core rules are unaccounted for.** Gap row #7 lists rules for porting: "project sandboxing (#2), status.md updates (#3), tool verification (#4), idle prevention (#6), agent dispatch grouping (#8), unattended mode (#9), security audit in DoD (#11), PR lifecycle (#12-13)." That covers rules 2, 3, 4, 6, 8, 9, 11, 12, 13. The old SKILL.md has 14 numbered rules. The following 5 are neither listed for porting NOR confirmed present in pm-lite's "5 design principles":

   - **Rule 1:** "NEVER read code, diagnose bugs, or suggest fixes -- assign a member." This is the PM's core identity constraint. Without it, nothing prevents the PM from writing code itself or manually debugging instead of delegating. If pm-lite's design principles cover this implicitly (e.g. "orchestrator never writes code"), the gap analysis must say so explicitly. Otherwise it must be ported.

   - **Rule 5:** "If a member can finish in one session (1-3 steps), use ad-hoc execute_prompt. Otherwise use the task harness." This is the decision gate between simple sprint and full sprint -- it is tightly coupled to gap row #18 (simple sprint, classified as "should port"). If simple sprint is promoted to must-port (see finding #3 below), this rule must be ported alongside it.

   - **Rule 7:** "During execution: keep going until stuck or done -- don't wait for the user." This is the PM's autonomy directive. Without it, the PM may stop at every checkpoint and ask the user whether to proceed, which defeats unattended sprint execution. Critical for both local and fleet modes.

   - **Rule 10:** "PLAN.md, progress.json, and feedback.md must be committed and pushed by the member at every turn." This is a data integrity rule underpinning the git-as-transport model. If members don't commit state files every turn, the PM cannot recover from crashes, reviewers cannot see current state, and the entire doer-reviewer loop's git transport (design.md section 4a, "State and transport: identical across modes") breaks down. Must be confirmed present in pm-lite's doer-reviewer-loop.md or explicitly ported.

   - **Rule 14:** "Always read referenced sub-documents before executing PM commands." Procedural, but prevents the PM from acting on stale or incomplete information when the skill document references doer-reviewer.md, sprint.md, etc.

   The gap analysis must explicitly enumerate all 14 rules with a per-rule decision: present in pm-lite (with citation) / port / drop (with justification). A gap analysis that omits 36% of the rules list is incomplete.

2. **Resume rules misclassified as "should port" (gap row #14).** The old PM has an 8-entry resume table in doer-reviewer.md keyed to phase numbers, role switches, post-stop_prompt cancellation, and post-timeout scenarios. Each entry determines whether the dispatcher passes `resume=true` (continue existing session) or `resume=false` (fresh session). Getting this wrong in fleet mode has real costs: `resume=true` when it should be `false` causes the member to inherit stale context from a previous role or phase, producing incorrect work. `resume=false` when it should be `true` wastes the entire session's accumulated context and potentially re-executes completed work. pm-lite's "dispatch fresh/continue" model is simpler and works for local subagents where sessions are cheap. For fleet dispatch, where each session costs compute time and context window tokens, the full resume table is needed. The plan itself (T3.7) even references tier resolution "at dispatch time," confirming dispatch-time decisions are architecturally significant. **Promote to must-port.**

3. **Simple sprint misclassified as "should port" (gap row #18).** The old SKILL.md sprint selection table explicitly routes 1-3 task work to simple-sprint.md -- a user-facing workflow. Existing users who invoke `/pm start` for trivial tasks expect the lightweight path: no PLAN.md, no progress.json, no planner/reviewer cycle, just ad-hoc execute_prompt. If the new PM drops this path, those users get the full heavyweight sprint for a 2-task bug fix. This is user disruption, violating hard constraint #2 ("NO USER DISRUPTION after the PR folds in"). The pm-lite direction doc (referenced in design.md) mentions a lightweight path as "near-term roadmap" -- but "on the roadmap" is not "present." Either confirm pm-lite already has an equivalent lightweight flow or **promote to must-port.**

4. **Template equivalence asserted without verification.** Gap row #26 classifies tpl-status.md, tpl-requirements.md, tpl-design.md, tpl-deploy.md, tpl-projects.md as "nice-to-have templates that can be generated inline." But the old init.md explicitly scaffolds `<project>/status.md` from tpl-status.md (with {{PROJECT_NAME}}, {{member_id}}, {{branch}} placeholders), `<project>/requirements.md` from tpl-requirements.md, `<project>/design.md` from tpl-design.md, and projects.md from tpl-projects.md. These templates define the schema of the PM's project folder -- if pm-lite's sprint setup phase generates equivalent scaffolding inline, that is acceptable, but the gap analysis must confirm this equivalence rather than asserting it without evidence.

**Required fix:** Expand the must-port list from 7 to at least 9 items (promote resume rules and simple sprint). Enumerate all 14 core rules individually with present/port/drop per rule and citations for "present" claims. Verify template equivalence for the init-flow scaffolding templates.

---

## Section B: Dual-Mode Execution -- PASS

**What works:** Design.md section 4a is the strongest part of this design. The mode detection logic is concrete and deterministic: 3-step check (fleet members available -> user flag -> default). The comparison table covering dispatch mechanism, blocking model, turn lifecycle, error recovery, concurrency, and context passing precisely articulates the fundamental differences between inline-blocking local subagents and async fleet-member dispatch. The insight that "state and transport are identical across modes" (git is the message bus, beads tracks lifecycle, sprint state files have the same schema) is the architectural key that makes dual-mode feasible without two separate implementations.

Fleet-only features (compose_permissions, context-file filenames, member pairing, stop_prompt, unattended mode flags, monitor_task polling) are cleanly enumerated with clear justification for why each is fleet-only. The acceptance criteria (6 items) are explicit, testable, and include the critical check: "Reviewer explicitly checks BOTH modes in every VERIFY checkpoint."

**Advisory (not blocking):**

1. **Mode detection mechanism is intent-level, not mechanism-level.** The design says "Check: are fleet members available? (fleet skill loaded + members registered)" -- but the PM skill is designed to be fleet-independent and cannot import fleet code directly. The concrete mechanism must be MCP tool availability probing (attempt a `fleet_status` call, catch the error if fleet is absent) or similar runtime detection. This is solvable at implementation time without design changes, but the implementer needs to know that fleet introspection is indirect.

2. **Local-mode dispatch is Claude Code-specific.** The design specifies `Agent` tool with `subagent_type: "planner"` for local mode. This is correct for Claude Code but would not work for Gemini or OpenCode running the PM role (OpenCode uses the `task` tool with different invocation semantics). Since PM currently only runs on Claude Code, this is not a defect -- but the assumption should be stated explicitly so future provider support knows to address it.

3. **Mid-sprint mode fallback is unspecified.** If a fleet member goes down mid-sprint and no replacement is available, can the PM fall back to local subagent mode? The design stores the mode in status.md at sprint init and does not address mid-sprint switching. This is an edge case, but the PM should at minimum detect member failure and flag the user rather than attempting indefinite dispatch to a dead member.

4. **Risk #9 mitigation is concrete.** The design identifies dual-mode drift as a Medium-likelihood, High-impact risk and proposes three mitigations: explicit dual-mode acceptance criteria in every VERIFY, e2e tests for BOTH modes, and mode-selection as a single well-tested function. These are practical, not hand-wavy. The mitigation would be stronger with a concrete invariant test ("dispatch a sprint in local mode and fleet mode, compare the resulting git history for structural equivalence"), but the current approach is adequate.

---

## Section C: Per-Member Model Tiers -- PASS

**What works:** Design.md section 5a is architecturally sound. The separation of concerns is clean: the ProviderAdapter holds static fallback defaults, the member record holds user-configured tiers, and the dispatch layer resolves the concrete model at dispatch time without the adapter needing to know about member-specific configuration.

The `resolveModelForTier` function is concrete and handles all edge cases via a clear priority chain: `member.model_tiers[tier]` -> `member.model_tiers.standard` -> `member.model_tiers.cheap` -> `Object.values(memberTiers)[0]` -> `provider.modelForTier(tier)`. Validation rules are clear: at least one model at registration (no zero-model members), single-model fills all tiers, missing tiers inherit. The tie-in to issue #299 (MODEL_EP_URL) is correctly identified as complementary (endpoint vs model selection).

The plan's implementation in T3.7 is well-scoped: add `model_tiers` to MemberRecord type, accept it in register_member with validation, add `resolveModelForTier` to execute_prompt. Unit test coverage requirements are specified (full map, single-model expansion, missing map fallback).

**Minor note:** The documentation says "Missing tiers inherit from the next-lower tier (premium -> standard -> cheap)" but the code implements a different mechanism -- a priority list where any missing tier falls through to standard, then cheap, then first-available. The result is the same (any supplied model is used), but the documentation describes a strictly next-lower chain that the code doesn't implement. The code is more robust; the documentation should match it. Not blocking.

---

## Section D: OpenCode Adapter -- FAIL

**What works:** The adapter surface mapping is comprehensive. I verified it against `src/providers/provider.ts:49-115`: all 5 readonly properties (`name`, `processName`, `authEnvVar`, `credentialPath`, `instructionFileName`) and 26 methods are accounted for in the design's adapter layout. The implementation mirrors codex.ts patterns, which is the correct reference for a non-Claude provider. The classifyError patterns (not-found -> auth, connection-refused -> server, timeout -> server, rate-limit -> overloaded) are sensible. Session resume flags (--continue, --session) match verified `opencode run --help` output. Install config paths are correct.

The `composePermissionConfig` design correctly maps Claude's tool-based allowlist to OpenCode's per-tool permission system (edit/bash = allow|deny|ask), matching the verified conversion pattern from exploration doc section 6.1.

**What fails:**

1. **parseResponse design presents a fabricated NDJSON schema.** Design.md section 5 ("parseResponse Design Detail", around the event types description) shows:
   ```
   {"type": "text", "content": "..."}
   {"type": "tool-call", "name": "edit", "args": {...}}
   {"type": "tool-result", "name": "edit", "result": "..."}
   {"type": "finish", "reason": "stop", "usage": {...}}
   ```
   This is labeled "Expected event types (from ai-sdk patterns)" -- meaning it is speculative, extrapolated from the ai-sdk library's internal types, NOT from actual `opencode run --format json` output. The PM captured REAL output and the actual format is NDJSON with top-level `{type, timestamp, sessionID, part}`. Text content is in `part.text` of `type:"text"` events, NOT in a top-level `content` field. The session ID is a top-level field on every event, not buried in a finish event.

   This is actively harmful because it presents a concrete, plausible-looking schema that will mislead the implementer. Even though T3.4 says "capture real output first," the implementer reads the design document first and will form a mental model around `event.content` instead of `event.part.text`, `event.type === "finish"` for session ID instead of reading it from any event's `sessionID` field. **The design must either show the REAL schema or explicitly mark the speculative schema as "HYPOTHETICAL -- DO NOT USE AS IMPLEMENTATION BASIS."**

2. **Design falsely claims usage metrics are unavailable.** The parseResponse section states: "No usage tracking initially (OpenCode doesn't emit token counts in JSON mode -- TBD)." The real output DOES emit usage data in `step_finish.part.tokens`. This is a verified capability. Claiming unavailability means the implementer will skip usage extraction entirely and return `usage: undefined` (as codex.ts does), losing token tracking that the wire format actually provides. This directly contradicts the exploration doc's observations and the PM's captured evidence. The `ParsedResponse` interface already has a `usage?: { input_tokens: number; output_tokens: number }` field (provider.ts:46) -- it should be populated from `step_finish.part.tokens`.

3. **Session ID extraction incorrectly specified.** The design says "Extract session ID from finish event if present." In the real format, `sessionID` is a top-level field on every NDJSON event. The implementer can extract it from the first event, not the last. The parser strategy should read `sessionID` from the first successfully parsed event and carry it forward.

4. **Method count discrepancy.** Design.md line 10 says "ProviderAdapter (24 methods)." The actual interface has 26 methods (plus 5 readonly properties). The adapter mapping in section 5 does cover all 31 interface members, so this is a documentation error rather than a coverage gap, but it may confuse the implementer about scope.

**Required fix:** Replace the speculative ai-sdk NDJSON schema with the REAL format: top-level `{type, timestamp, sessionID, part}`, text in `part.text` of `type:"text"` events, usage in `step_finish.part.tokens`. Remove the "No usage tracking initially (TBD)" claim and specify the usage extraction path. Fix session ID extraction to read from top-level `sessionID` on any event. Fix method count to 26.

---

## Section E: Phasing/Dependency Soundness -- FAIL

**What works:** The 6-phase structure is well-ordered by dependency. Riskiest assumptions are correctly front-loaded: submodule + npm vendoring in Phase 1 (build infrastructure that everything else depends on), OpenCode headless + JSON parsing in Phase 3 (the second-riskiest unknown). VERIFY checkpoints exist at every phase boundary with reviewer-specific check items. The dependency graph is explicit, acyclic, and correctly rendered. The test strategy table is comprehensive (unit, integration, e2e). The rollout section correctly gates the merge on existing s1-s8 e2e suites passing with the new PM skill.

**What fails:**

1. **Tier monotonicity violated in 3 phases.** The plan's own generation rules (plan-prompt.md, Phase 3 "SELF-CRITIQUE") state: "Monotonically non-decreasing tiers within a phase [...] If a dependency forces a higher-tier task before a lower-tier task within a phase, split the phase at that boundary." The plan violates this:

   - **Phase 1:** T1.1(standard) -> T1.2(cheap) -- downgrade. T1.2 depends on T1.1 so reordering is impossible. Fix: promote T1.2 to standard (it's a simple `git submodule add` but its position after a standard task means the session context is already at standard complexity).
   - **Phase 2:** T2.1(cheap) -> T2.2(premium) -> T2.3(cheap) -- downgrade at T2.3. T2.3 depends on T2.2, so reordering is impossible. Fix: move T2.3 (submodule pin update, mechanical) to the start of Phase 3, or split Phase 2 after T2.2.
   - **Phase 6:** T6.1(cheap) -> T6.2(standard) -> T6.3(cheap) -- downgrade at T6.3. T6.3 (commit exploration doc) has no dependency on T6.2 (integration test), so reordering is valid. Fix: move T6.3 before T6.2.

   The tier rule exists to prevent a cheap-tier model from being dispatched into a session whose context window was built by a premium-tier model's deeper reasoning. The violations are not catastrophic but the plan contradicts its own generation rules.

2. **T2.2 (gap ports) likely exceeds ~50 tool calls.** This task modifies 5 files across the apra-pm submodule, porting 7 must-port items (9+ after gap analysis fixes from Section A). Each port requires: (a) reading the old PM source file for the feature, (b) reading the pm-lite equivalent to understand the gap, (c) writing the ported content, (d) verifying consistency. At 4-6 tool calls per port across 9+ items, this reaches 40-55+ calls. The plan-prompt.md self-critique says "Too large -- more than ~50 tool calls? Split it." Fix: split into T2.2a (SKILL.md additions: sprint selection, command reference, core rules, secrets, provider awareness) and T2.2b (sub-document additions: pre-flight checks, resume rules, fleet-addendum, simple-sprint).

3. **T1.1 has an implicit external dependency.** `gh repo rename apra-pm --repo Apra-Labs/apra-pm-lite` requires org-admin permissions on the Apra-Labs GitHub organization. If the doer's token lacks admin scope, T1.1 blocks the entire epic at the first task with no fallback. This must be listed as a pre-condition ("org-admin access to Apra-Labs verified") or handled as a manual pre-step the user confirms before the sprint starts.

4. **T2.2 cross-repo workflow is under-specified.** The task modifies files in the apra-pm submodule -- a different git repository (Apra-Labs/apra-pm). The plan acknowledges "requires a commit in apra-pm repo and submodule SHA update in apra-fleet" but does not specify: Does the doer clone apra-pm separately? Does the PM create a branch + PR in apra-pm? Does the doer need push access to apra-pm? Is the gap port PR merged before updating the submodule pin in T2.3? This process gap could block Phase 2 if the doer cannot push to the submodule repo.

5. **Phase 3 parallel execution opportunities are implicit.** T3.5 (permissions, depends on T3.2), T3.6 (install config, depends on T3.1), and T3.7 (member tier map, depends on T3.2) are all independent of T3.3-T3.4 but the linear task numbering (T3.1 -> ... -> T3.7) implies strict sequential execution. If the intent is parallel dispatch (which would significantly reduce Phase 3 wall time), the plan should explicitly group independent tasks or note which can run concurrently. If sequential is intended, the plan should say so.

---

## Section F: Backward Compat + Migration -- PASS

**What works:** The rollout section is solidly constructed. The merge gate on s1-s8 e2e suites is the strongest backward-compat guarantee: if existing sprint workflows pass end-to-end with the new PM skill, the upgrade is safe. T5.3 (backward-compat.test.ts) covers the key compatibility surfaces: `/pm` command mapping, state file format (status.md, progress.json, planned.json), beads lifecycle hooks, and provider-specific context-file filenames. Requirements ND.1-ND.6 are concrete and independently testable.

The protection table is comprehensive: fleet skill untouched, hooks untouched, settings merge unchanged (readConfig/writeConfig), beads DB untouched (separate binary), provider configs unchanged (only new opencode permissions added), old sprint state files compatible (same file names and formats).

**Advisory (not blocking):**

1. **Backward-compat testing is late in the pipeline.** Old PM is deleted in T2.1 (Phase 2) but backward-compat tests are not written until T5.3 (Phase 5). If a compatibility regression is introduced during the gap ports in T2.2, it will not surface until 3 phases later, requiring expensive rework. Consider adding a smoke test to VERIFY 2: "install new pm skill, verify `/pm init` scaffolds correct files, verify existing status.md parses without errors."

2. **In-flight sprint migration is not explicitly tested.** T5.3 covers state file format compatibility (implying in-flight sprints would work), but there is no explicit test scenario: "user is mid-sprint with old pm, upgrades to new pm, resumes sprint." This is an edge case worth adding -- even as a manual test.

---

## Section G: Submodule+NPM Vendor -- PASS

**What works:** All three install paths are explicitly addressed with concrete mechanisms:

- **npm (`npm install -g apra-fleet`):** `prepublishOnly` script copies submodule files to `dist/` before publish. The tarball includes pm skill + agent files. Users never need `--recursive` or git.
- **git clone:** `vendor/apra-pm/` submodule provides files directly. install.ts looks in `vendor/apra-pm/` first, falls back to `dist/` for npm installs.
- **SEA binary:** `gen-sea-config.mjs` updated to collect from `vendor/apra-pm/`.

The vendor-pm.mjs fallback logic is sound: submodule initialized -> copy; not initialized -> check dist/ populated -> error with "run git submodule update --init." The alternatives-considered table (4 options with pros/cons) is thorough and the submodule + build-time vendor choice is well-justified.

**Minor note:** For a developer who runs `git clone` without `--recursive` AND hasn't built yet (so `dist/` is empty), install.ts needs a clear error in dev-mode when both `vendor/apra-pm/` and `dist/skills/pm/` are empty. The design's vendor-pm.mjs handles the npm publish path but install.ts's dev-mode path also needs the both-empty detection. The plan should verify this in VERIFY 1.

---

## Summary

| Section | Verdict | Key Finding |
|---------|---------|-------------|
| A. Gap Analysis | FAIL | 5 of 14 core rules unaccounted for; resume rules and simple sprint misclassified as "should port" when dropping them breaks existing workflows (hard constraint #2); template equivalence asserted without verification |
| B. Dual-Mode Execution | PASS | Strongest section; mode detection, state transport, fleet-only gating all concrete and testable |
| C. Per-Member Model Tiers | PASS | Sound resolution chain; clean separation of adapter defaults vs member config vs dispatch resolution |
| D. OpenCode Adapter | FAIL | parseResponse presents fabricated NDJSON schema ({content} vs real {part.text}); falsely claims usage unavailable when step_finish.part.tokens provides it; session ID extraction mis-located |
| E. Phasing/Dependency | FAIL | Tier monotonicity violated in 3 phases; T2.2 likely exceeds ~50 tool-call ceiling; T1.1 org-admin and T2.2 cross-repo push are implicit dependencies |
| F. Backward Compat | PASS | Solid rollout gates with s1-s8 e2e as merge guard; backward-compat testing could start earlier |
| G. Submodule+NPM Vendor | PASS | All three install paths (npm, git-clone, SEA) covered with concrete mechanisms |

**Top 3 required changes before implementation proceeds:**

1. **Fix parseResponse design (Section D).** Replace the speculative ai-sdk NDJSON schema with the REAL format: top-level `{type, timestamp, sessionID, part}`, text in `part.text` of `type:"text"` events, usage in `step_finish.part.tokens`. Remove the "No usage tracking initially (TBD)" claim -- usage is verified available. Fix session ID extraction to read from top-level `sessionID` on any event. The plan's T3.4 "capture real output first" mitigation is good, but the design document itself must not present a wrong schema as if it were real.

2. **Strengthen gap analysis (Section A).** Enumerate all 14 core rules with per-rule present/port/drop decisions and citations. Promote resume rules (row #14) and simple sprint (row #18) from "should port" to "must port." Confirm template equivalence for init-flow templates (tpl-status.md, tpl-requirements.md, tpl-design.md, tpl-deploy.md, tpl-projects.md) by checking what pm-lite's sprint setup phase actually generates.

3. **Fix tier monotonicity and task sizing (Section E).** Correct tier downgrades: Phase 1 -- promote T1.2 to standard; Phase 2 -- move T2.3 to Phase 3 start; Phase 6 -- move T6.3 before T6.2. Split T2.2 into two tasks (SKILL.md ports and sub-document/fleet-addendum ports) to stay under the ~50 tool-call ceiling. Add T1.1 org-admin access as an explicit pre-condition. Specify the T2.2 cross-repo workflow (branch/PR strategy for apra-pm modifications).
