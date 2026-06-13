# OpenCode+PM epic - Plan Review

**Reviewer:** amf43 (plan-reviewer)
**Date:** 2026-06-13
**Branch:** feat/opencode-pm-epic
**Documents reviewed:** requirements.md, design.md, plan.md, docs/opencode-exploration.md, old PM skill files (git show main:skills/pm/*), src/providers/provider.ts (ProviderAdapter interface), src/providers/codex.ts (reference adapter)

---

## Verdict: CHANGES NEEDED

Three categories of defect prevent implementation from proceeding safely: (1) the parseResponse design section contains a fabricated NDJSON schema that contradicts verified observations and falsely claims usage metrics are unavailable; (2) the gap analysis hides 5 of 14 core rules behind an "etc." and demotes two user-facing features to "should port" when dropping them would break existing workflows; (3) tier monotonicity is violated within three phases, contradicting the plan's own generation rules from plan-prompt.md.

---

## Section A: Gap Analysis Completeness -- FAIL

**What works:** The gap table is structurally thorough -- 26 rows covering all 21 old-pm files and every old-pm concept. The file-by-file comparison is present. The 7 must-port / 3 should-port / 2 drop structure is clear. Both "Drop" decisions (fleet dependency bootstrap, fleet skill references in header) are correct and well-justified -- pm-lite's fleet-independent design is the whole point of the unification.

**What fails:**

1. **Core rules enumeration hides 5 rules behind "etc."** Gap row #7 says "Port rules: project sandboxing (#2), status.md updates (#3), tool verification (#4), idle prevention (#6), agent dispatch grouping (#8), unattended mode (#9), security audit in DoD (#11), PR lifecycle (#12-13)." That explicitly accounts for rules 2, 3, 4, 6, 8, 9, 11, 12, 13. The old PM SKILL.md has 14 numbered core rules. The following 5 are neither listed for porting NOR confirmed present in pm-lite:

   - **Rule 1:** "NEVER read code, diagnose bugs, or suggest fixes -- assign a member." This is a behavioral constraint that prevents the PM from doing work instead of delegating. If pm-lite's design principles implicitly cover this, it must be stated explicitly. If not, it must be ported.
   - **Rule 5:** "If a member can finish in one session (1-3 steps), use ad-hoc execute_prompt. Otherwise use the task harness." This is the decision gate between simple sprint and full sprint. It is tightly coupled to gap row #18 (simple sprint). Both must be addressed together.
   - **Rule 7:** "During execution: keep going until stuck or done -- don't wait for the user." This is critical PM autonomy behavior. Without it, the PM may stop and ask the user at every checkpoint instead of driving through phases autonomously.
   - **Rule 10:** "PLAN.md, progress.json, and feedback.md must be committed and pushed by the member at every turn." This is a data integrity rule -- the entire git-as-transport model depends on it. If members don't commit state files at every turn, the PM cannot recover from crashes, reviews cannot access current state, and the sprint loop breaks. Must be confirmed present in pm-lite or explicitly ported.
   - **Rule 14:** "Always read referenced sub-documents before executing PM commands." Procedural, but prevents the PM from acting on stale or partial information.

   The design must explicitly enumerate all 14 rules with a per-rule decision (present in pm-lite / port / drop with justification). "Etc." is not acceptable for a gap analysis.

2. **Resume rules misclassified as "should port" (gap row #14).** The old PM has an explicit resume table keyed to phase numbers, role switches, and edge cases (post-stop_prompt, post-timeout). This table is critical for fleet execution: the wrong resume decision (resume=true when it should be false) causes the member to inherit stale context from a previous role or phase, leading to incorrect work. The wrong decision the other way (resume=false when it should be true) wastes an entire session's context and potentially reruns completed work. The old PM doer-reviewer.md has a detailed resume table with 8 entries including edge cases. pm-lite's "dispatch fresh/continue" is simpler but adequate only for local subagents where context switching is cheap. For fleet dispatch, where each session costs real compute time and context window, the full resume table is needed. Promote to "must port."

3. **Simple sprint misclassified as "should port" (gap row #18).** The old PM SKILL.md sprint selection table explicitly routes 1-3 task work to simple-sprint.md. This is a user-facing workflow -- existing users who invoke `/pm start` for trivial work expect the lightweight path (no PLAN.md, no progress.json, ad-hoc execute_prompt). If the new pm drops this, those users get the full heavyweight sprint for a 2-task fix, which is user disruption (hard constraint #2 violation). Either confirm pm-lite has an equivalent lightweight path or promote to "must port."

4. **Template cross-check is shallow.** Gap row #26 says templates tpl-status.md, tpl-requirements.md, tpl-design.md, tpl-deploy.md, tpl-projects.md are "nice-to-have templates that can be generated inline." But the old init.md explicitly populates `<project>/status.md` from tpl-status.md, `<project>/requirements.md` from tpl-requirements.md, `<project>/design.md` from tpl-design.md, and creates projects.md from tpl-projects.md. If pm-lite's sprint setup generates equivalent scaffolding inline during its setup phase, that is fine -- but the gap analysis must explicitly confirm this equivalence, not assert "can be generated inline" without verification.

**Required fix:** Expand the must-port list from 7 to at least 9 items (promote resume rules and simple sprint). Enumerate all 14 core rules individually with present/port/drop per rule. Confirm template equivalence in pm-lite for init-flow scaffolding.

---

## Section B: Dual-Mode Execution -- PASS

**What works:** Design.md section 4a is the strongest section of the design. The mode detection logic is concrete and deterministic (3-step check: fleet members available, user flag, default). The comparison table (dispatch mechanism, blocking model, turn lifecycle, error recovery, concurrency, context passing) precisely articulates the differences. The "state and transport: identical across modes" section correctly identifies git as the unifying bus -- this is the key architectural insight that makes dual-mode feasible. Fleet-only features are cleanly enumerated and gated. The acceptance criteria (6 items) are explicit and testable.

**Advisory (not blocking):**

1. **Mode detection mechanism is specified at intent level but not at mechanism level.** The design says "Check: are fleet members available? (fleet skill loaded + members registered)." But the pm skill is designed to be fleet-independent -- it cannot import or reference fleet skill code directly. The concrete detection mechanism must be MCP tool availability probing (attempt a `fleet_status` call, handle the error if fleet is not loaded) or environment signals (check for registered members via a tool call). This is solvable at implementation time without design changes, but the implementer should know that fleet introspection is indirect.

2. **Local-mode subagent dispatch is Claude Code specific.** The design says local mode uses `Agent` tool with `subagent_type: "planner"`. This is correct for Claude Code but would not work if the PM runs on Gemini (which uses the same Agent tool interface) or OpenCode (which uses the `task` tool with different semantics). Since PM currently only runs on Claude Code, this is not a defect, but the assumption should be made explicit to avoid confusion when extending to other providers.

3. **Mid-sprint mode fallback is unspecified.** If a fleet member goes down mid-sprint and no other fleet member can take over, can the PM fall back to local subagent mode for the remaining work? The design stores the mode in status.md at sprint init and does not address mid-sprint switching. This is an edge case but worth noting -- the PM should at minimum detect the failure and flag the user rather than silently trying to dispatch to a dead member indefinitely.

---

## Section C: Per-Member Model Tiers -- PASS

**What works:** Design.md section 5a is sound and well-architected. The three-layer resolution chain (member.model_tiers[tier] -> member.model_tiers.standard -> member.model_tiers.cheap -> Object.values(memberTiers)[0] -> provider.modelForTier(tier)) is well-defined and handles all edge cases. Validation rules are clear: at least one model at registration, single-model fills all tiers, missing tiers inherit. The separation of concerns is clean -- the adapter knows static defaults, the dispatch layer resolves per-member overrides, and the adapter never needs to know about member-specific configuration.

The `resolveModelForTier` function is concrete enough to implement directly. The tie-in to issue #299 (MODEL_EP_URL) is correctly identified as complementary (endpoint vs model selection).

**Minor note:** The documentation says "Missing tiers inherit from the next-lower tier (premium -> standard -> cheap)" but the code's fallback chain is a priority list (tier -> standard -> cheap -> first value), not strict next-lower inheritance. For example, if only `premium` is supplied, the fallback for `cheap` goes standard(missing) -> cheap(missing) -> Object.values()[0](=premium). The result is correct (any supplied model is used), but the documentation describes a different mechanism than the code implements. Not a defect -- the code is more robust than the documentation suggests.

---

## Section D: OpenCode Adapter -- FAIL

**What works:** The adapter surface mapping is comprehensive. I verified it against the actual `ProviderAdapter` interface in `src/providers/provider.ts:49-115` -- all 5 readonly properties and 26 methods are accounted for (the design says "24 methods" in the current-state map, which is a minor count error; the actual mapping covers all 26). The implementation patterns mirror codex.ts closely, which is the right reference adapter for a non-Claude provider. The classifyError patterns are sensible. The session resume flags (--continue, --session) match the verified `opencode run --help` output from the exploration doc. The install config paths are correct.

**What fails:**

1. **parseResponse design section shows a fabricated NDJSON schema.** Design.md section 5 ("parseResponse Design Detail", lines 498-517) presents this schema:
   ```
   {"type": "text", "content": "..."}
   {"type": "tool-call", "name": "edit", "args": {...}}
   {"type": "tool-result", "name": "edit", "result": "..."}
   {"type": "finish", "reason": "stop", "usage": {...}}
   ```
   This is marked as "Expected event types (from ai-sdk patterns)" -- meaning it is speculative, extrapolated from the ai-sdk library's internal types, not from actual `opencode run --format json` output. The task description confirms the PM captured REAL output, and the actual format is NDJSON with top-level `{type, timestamp, sessionID, part}`. Text content is in `part.text` of `type:"text"` events, NOT in a top-level `content` field. Session ID is a top-level field on every event, not extracted from a finish event.

   The design will mislead the implementer because it presents a concrete, plausible-looking schema. Even though T3.4 says "capture real output first," the implementer reads the design document first and may use it as a mental model, writing code that extracts `event.content` instead of `event.part.text`. The design should either show the REAL schema or explicitly say "the schema below is hypothetical and MUST NOT be used as the implementation basis."

2. **Design falsely claims usage metrics are unavailable.** Line 340: "No usage tracking initially (OpenCode doesn't emit token counts in JSON mode -- TBD)." The real output DOES emit usage data in `step_finish.part.tokens`. This is not a TBD -- it is a verified capability. Claiming unavailability means the implementer will skip usage extraction entirely, losing token tracking that exists in the wire format. This directly contradicts the exploration doc's verified observations.

3. **Session ID extraction is vaguely specified.** The design says "Extract session ID from finish event if present" (line 516). In the real format, `sessionID` is a top-level field on every NDJSON event, not something buried in a finish event. The implementer can extract it from the first event, not the last. This is a minor optimization but the design's description is factually incorrect about where the data lives.

4. **Method count discrepancy.** Design.md line 9 says "ProviderAdapter (24 methods)" but the actual interface has 26 methods (plus 5 readonly properties). Minor but could confuse the implementer about scope.

**Required fix:** Replace the hypothetical NDJSON schema in section 5 with the REAL format: `{type, timestamp, sessionID, part}` with `part.text` for text events and `step_finish.part.tokens` for usage. Remove the "No usage tracking initially" claim and replace with the verified usage extraction path. Fix the session ID extraction description.

---

## Section E: Phasing/Dependency Soundness -- FAIL

**What works:** The 6-phase structure is well-ordered by dependency. Riskiest assumptions (submodule vendoring, OpenCode headless reliability) are front-loaded in Phases 1 and 3. VERIFY checkpoints exist at every phase boundary with reviewer-specific check items. The dependency graph is explicit, acyclic, and correctly rendered. The test strategy table covers unit, integration, and e2e levels. The rollout section correctly gates the merge on s1-s8 e2e passing.

**What fails:**

1. **Tier monotonicity violated in 3 phases.** The plan's own generation rules (plan-prompt.md Phase 3, "SELF-CRITIQUE") state: "Monotonically non-decreasing tiers within a phase [...] If a dependency forces a higher-tier task before a lower-tier task within a phase, split the phase at that boundary." The plan violates this rule:

   - **Phase 1:** T1.1(standard) -> T1.2(cheap) -- downgrade. T1.2 depends on T1.1, so reordering is impossible. Fix: split Phase 1 after T1.1 (T1.1 becomes its own phase or mini-phase), or promote T1.2 to standard (it's a simple `git submodule add` but the tier label should match its position).
   - **Phase 2:** T2.1(cheap) -> T2.2(premium) -> T2.3(cheap) -- downgrade at T2.3. T2.3 depends on T2.2, so reordering is impossible. Fix: move T2.3 to the start of Phase 3 (it's a mechanical submodule pin update), or split Phase 2 after T2.2.
   - **Phase 6:** T6.1(cheap) -> T6.2(standard) -> T6.3(cheap) -- downgrade at T6.3. Fix: move T6.3 before T6.2 (T6.3 has no dependency on T6.2, so reordering is valid), or move T6.3 to Phase 5.

   These are not catastrophic -- the tier rule exists to prevent a cheap-tier model from inheriting a premium-tier context window within the same resumed session. But the plan contradicts its own rules, which undermines reviewer confidence.

2. **T2.2 (gap ports) may exceed ~50 tool calls.** This task modifies 5 files across the apra-pm submodule, porting 7 must-port items (potentially 9+ after the gap analysis fix above). Each port requires: (a) reading the old PM source file for the specific feature, (b) reading the corresponding pm-lite file to understand the gap, (c) writing the ported content, (d) verifying consistency. At 4-6 tool calls per port item across 9+ items, this reaches 40-55 tool calls. The plan-prompt.md's self-critique phase says "Too large -- more than ~50 tool calls? Split it." Fix: split into T2.2a (SKILL.md additions: sprint selection, command reference, core rules, secrets reference) and T2.2b (doer-reviewer-loop additions: pre-flight checks, resume rules, fleet-addendum).

3. **T1.1 has an implicit external dependency not listed as a blocker.** `gh repo rename apra-pm --repo Apra-Labs/apra-pm-lite` requires org-admin permissions on the Apra-Labs GitHub organization. If the doer member's GitHub token doesn't have admin scope, T1.1 blocks the entire epic at the first task. This must be listed as a pre-condition ("org-admin access to Apra-Labs verified") or split into a manual pre-step the user confirms before the doer starts.

4. **T2.2 has an under-specified cross-repo workflow.** The task modifies files in the apra-pm submodule, which requires committing and pushing to a different repository (Apra-Labs/apra-pm). The plan acknowledges this ("requires a commit in apra-pm repo and submodule SHA update in apra-fleet") but does not specify the mechanism: Does the doer clone apra-pm separately? Does the PM create a branch + PR in apra-pm? Does the doer need push access to apra-pm? This is a process gap that could block Phase 2 entirely if the doer cannot push to the submodule repo.

5. **Phase 3 dependency graph has unclear sequencing for parallel tasks.** T3.5 (permissions, depends on T3.2) and T3.6 (install config, depends on T3.1) can run in parallel with T3.3 and T3.4. T3.7 (member tier map, depends on T3.2) is also independent of T3.3-T3.4. The dependency graph shows these parallelisms but the plan's linear task numbering (T3.1 -> T3.2 -> T3.3 -> T3.4 -> T3.5 -> T3.6 -> T3.7) implies strict sequential execution. If the intent is parallel execution, the plan should group independent tasks or explicitly note which can be dispatched concurrently.

---

## Section F: Backward Compat + Migration -- PASS

**What works:** The rollout section correctly gates the merge on s1-s8 e2e suites passing with the new PM skill. T5.3 (backward-compat.test.ts) covers the key compatibility surfaces: `/pm` command mapping, state file format, beads lifecycle hooks, provider-specific context-file filenames. Requirements ND.1-ND.6 are concrete and independently testable. The protection table (fleet skill untouched, hooks untouched, settings merge unchanged, beads DB untouched, old sprint state files compatible) is comprehensive.

**Advisory (not blocking):**

1. **Backward-compat testing is late in the pipeline.** Old pm is deleted in T2.1 (Phase 2) but backward-compat tests are not written until T5.3 (Phase 5). If a compatibility regression is introduced during the gap ports in T2.2, it will not be caught until 3 phases later. Consider adding a smoke test to VERIFY 2: "install new pm skill, verify `/pm init` scaffolds correct files, verify `/pm status` reads existing status.md without errors."

2. **In-flight sprint migration is not explicitly tested.** T5.3 covers state file format compatibility, which implies in-flight sprints would work. But there is no explicit test scenario: "user is mid-sprint with old pm, upgrades, resumes sprint with new pm." This is an edge case worth adding to the e2e suite -- even if it's a manual test initially.

---

## Section G: Submodule+NPM Vendor -- PASS

**What works:** All three install paths are explicitly addressed:

- **npm (`npm install -g apra-fleet`):** The `prepublishOnly` script copies submodule files to `dist/` before publish. The tarball includes pm skill + agent files. Users need no `--recursive` or git interaction.
- **git clone:** `vendor/apra-pm/` submodule provides files directly. `findProjectRoot()` in install.ts looks in `vendor/apra-pm/` first.
- **SEA binary:** `gen-sea-config.mjs` updated to collect from `vendor/apra-pm/`.

The vendor-pm.mjs fallback checks (submodule initialized -> copy; not initialized -> check dist/ populated; neither -> error with "run git submodule update --init") are sound.

**Minor note:** For a fresh `git clone` without `--recursive`, install.ts's dev-mode path needs a similar detection: if `vendor/apra-pm/` is empty AND `dist/skills/pm/` is empty, print a clear error. The design's vendor-pm.mjs handles the npm publish case, but install.ts must also handle the dev-mode case (a developer who cloned without `--recursive`). The design acknowledges this ("Update skill/agent paths to look in vendor/apra-pm/ first, fall back to dist/ for npm") but does not explicitly handle the both-empty case. Verify during VERIFY 1.

---

## Summary

| Section | Verdict | Key Finding |
|---------|---------|-------------|
| A. Gap Analysis | FAIL | 5 of 14 core rules hidden behind "etc."; resume rules and simple sprint misclassified as "should port"; template equivalence unverified |
| B. Dual-Mode Execution | PASS | Strongest section; mode detection mechanism could be more concrete; local-mode Claude Code assumption should be explicit |
| C. Per-Member Model Tiers | PASS | Sound three-layer resolution chain; clean separation of concerns |
| D. OpenCode Adapter | FAIL | parseResponse shows fabricated NDJSON schema (content vs part.text); falsely claims usage unavailable; contradicts PM's verified observations |
| E. Phasing/Dependency | FAIL | Tier monotonicity violated in 3 phases; T2.2 possibly too large; T1.1 org-admin dependency implicit; T2.2 cross-repo push unspecified |
| F. Backward Compat | PASS | Solid rollout gates; backward-compat testing could start earlier |
| G. Submodule+NPM Vendor | PASS | All three install paths covered; dev-mode both-empty case should be verified |

**Top 3 required changes before implementation proceeds:**

1. **Fix parseResponse design (Section D).** Replace the speculative NDJSON schema with the REAL format: top-level `{type, timestamp, sessionID, part}`, text in `part.text` of type:"text" events, usage in `step_finish.part.tokens`. Remove the "No usage tracking initially" TBD claim -- it is verified available. The plan's T3.4 "capture real output first" mitigation is correct in spirit, but the design document should not present a wrong schema as if it were real.

2. **Strengthen gap analysis (Section A).** Explicitly enumerate all 14 core rules with per-rule present/port/drop decisions. Promote resume rules (gap row #14) and simple sprint (gap row #18) from "should port" to "must port." Confirm that pm-lite's sprint setup phase produces equivalent scaffolding for the templates marked "can be generated inline" (tpl-status.md, tpl-requirements.md, tpl-design.md, tpl-deploy.md, tpl-projects.md).

3. **Fix tier monotonicity and task sizing (Section E).** Split phases at tier downgrade boundaries or reorder tasks where dependencies allow. Specific fixes: Phase 1 -- split after T1.1 or promote T1.2 to standard; Phase 2 -- move T2.3 to Phase 3 start; Phase 6 -- move T6.3 before T6.2. Split T2.2 into two tasks (SKILL.md ports and doer-reviewer-loop/fleet-addendum ports). Add T1.1 org-admin access as an explicit pre-condition.
