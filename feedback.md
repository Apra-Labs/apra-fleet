# OpenCode+PM epic - Plan Review

**Reviewer:** fleet-rev (plan-reviewer)
**Date:** 2026-06-13
**Branch:** feat/opencode-pm-epic
**Documents reviewed:** requirements.md, design.md, plan.md, docs/opencode-exploration.md, old PM skill files (git show main:skills/pm/*)

---

## Verdict: CHANGES NEEDED

Three issues require correction before implementation proceeds: (1) the parseResponse design section contains a known-wrong NDJSON schema and incorrectly claims usage metrics are unavailable, contradicting the PM's own verified observations; (2) the gap analysis under-enumerates core rules behind an "etc." and misclassifies fleet-critical resume rules as "should port"; (3) tier monotonicity is violated within three phases.

---

## Section A: Gap Analysis Completeness -- FAIL

**What works:** The gap table is thorough structurally -- 26 rows covering all 21 old-pm files. The file-by-file comparison is present and every old file is accounted for. The 7 must-port, 3 should-port, 2 drop structure is clear. The two "Drop" decisions (fleet dependency bootstrap) are correct and well-justified.

**What fails:**

1. **Core rules enumeration uses "etc." to hide gaps.** Gap row #7 says: "Port rules: project sandboxing (#2), status.md updates (#3), tool verification (#4), idle prevention (#6), agent dispatch grouping (#8), unattended mode (#9), security audit in DoD (#11), PR lifecycle (#12-13)." This explicitly lists 8 of 14 rules but hides the rest behind "(project sandboxing, status.md, tool verification, etc.)" in the must-port summary. The following old-pm core rules are neither listed for porting NOR confirmed present in pm-lite:
   - Rule 1: "NEVER read code, diagnose bugs, or suggest fixes -- assign a member"
   - Rule 5: "If a member can finish in one session (1-3 steps), use ad-hoc execute_prompt. Otherwise use the task harness."
   - Rule 7: "During execution: keep going until stuck or done -- don't wait for the user."
   - Rule 10: "PLAN.md, progress.json, and feedback.md must be committed and pushed by the member at every turn"
   - Rule 14: "Always read referenced sub-documents before executing PM commands"

   Rules 1 and 7 are behavioral constraints on the PM agent. Rule 10 is a critical data integrity rule (git-as-transport depends on it). These must be explicitly confirmed as present in pm-lite or flagged for porting -- not hidden in "etc."

2. **Resume rules misclassified as "should port."** Gap row #14 (resume rules -- data-driven from planned.json phase numbers) is marked "should port" but the doer-reviewer loop in fleet mode DEPENDS on correct resume/fresh-session decisions. The old pm has an explicit resume table keyed to phase numbers, role switches, and edge cases (post-stop_prompt, post-timeout). If this is missing in fleet mode, the wrong resume decision will cause session context corruption or wasted work. This should be "must port" for fleet mode.

3. **Simple sprint marked "should port" but it is a user-facing command.** Old pm SKILL.md lists `/pm` commands including an implicit lightweight path. Gap row #18 marks simple-sprint as "should port." But if existing users invoke a lightweight flow and the new pm drops it, that is user disruption (violating hard constraint #2). Either confirm pm-lite has an equivalent lightweight path or promote to "must port."

4. **Template cross-check is shallow.** The gap analysis says templates tpl-status.md, tpl-requirements.md, tpl-design.md, tpl-deploy.md, tpl-projects.md are "nice-to-have templates that can be generated inline." But these are used by `init.md` during `/pm init`. If pm-lite's sprint setup generates equivalent scaffolding inline, say so explicitly. If not, the init flow will regress.

**Verdict for this section:** Must-port list should expand from 7 to 9 items (promote resume rules and simple sprint), and core rules #7 must be explicitly enumerated rather than using "etc."

---

## Section B: Dual-Mode Execution -- PASS (with advisory)

**What works:** Design.md section 4a is the strongest part of the plan. The mode detection logic is concrete (3-step check: fleet available, user flag, default). The difference table (dispatch mechanism, blocking model, turn lifecycle, error recovery, concurrency, context passing) is precise. Fleet-only features are cleanly enumerated. The acceptance criteria are explicit and testable. The "state and transport: identical across modes" section correctly identifies git as the unifying bus.

**Advisory (not blocking):**

1. **Mode detection assumes fleet skill introspection.** The pm skill detects fleet availability by checking "fleet skill loaded + members registered." But pm is designed to be fleet-independent -- it cannot import or reference fleet skill code. The detection must work via MCP tool availability probing (attempt `fleet_status` call, catch error) or environment signals. The design should specify the concrete detection mechanism, not just the intent. This is solvable at implementation time but worth noting.

2. **Local-mode agent dispatch assumes Claude Code Agent tool.** The design says local mode uses `Agent` tool with `subagent_type: "planner"`. This is Claude Code specific. If the PM runs on Gemini or OpenCode, local-mode subagent dispatch needs a provider-specific mechanism. The design implicitly assumes PM always runs on Claude Code, which is currently true but worth making explicit.

3. **Risk #9 (drift) mitigation is directionally correct but not architecturally enforced.** "mode-selection logic is a single well-tested function" -- but this function would live in the skill's markdown instructions, not in testable code. Skill instructions can drift. The mitigation would be stronger if the mode selection were a code function in apra-fleet that the skill invokes, but this is a design choice not a defect.

---

## Section C: Per-Member Model Tiers -- PASS

**What works:** Design.md section 5a is sound. The three-layer resolution (member map -> standard fallback within map -> adapter static defaults) is well-defined. The `resolveModelForTier` function is concrete and correct. Validation rules are clear (at least one model, single-model expansion, tier inheritance). The separation of concerns (adapter knows defaults, dispatch layer resolves per-member) is clean.

**Minor note:** The tier inheritance description says "Missing tiers inherit from the next-lower tier (premium -> standard -> cheap)" but the code's fallback chain goes `memberTiers[tier] -> memberTiers.standard -> memberTiers.cheap -> Object.values(memberTiers)[0]`, which is not strictly "next-lower" inheritance but rather a priority chain. The result is the same in practice -- any supplied model will be found. Not a defect, just a documentation imprecision.

---

## Section D: OpenCode Adapter -- FAIL

**What works:** The adapter surface mapping covers all 31 ProviderAdapter members (5 readonly properties + 26 methods). Method implementations are reasonable and well-justified by the exploration doc. The class structure mirrors codex.ts. The install config paths are correct. The classifyError patterns are sensible. The session resume flags match verified `opencode run --help` output.

**What fails:**

1. **parseResponse design section assumes WRONG NDJSON schema.** Design.md section 5 ("parseResponse Design Detail") shows:
   ```
   {"type": "text", "content": "..."}
   {"type": "tool-call", "name": "edit", "args": {...}}
   {"type": "tool-result", "name": "edit", "result": "..."}
   {"type": "finish", "reason": "stop", "usage": {...}}
   ```
   The PM captured REAL `opencode run --format json` output. The actual format is NDJSON with top-level `{type, timestamp, sessionID, part}`. Text content is in `part.text` of `type:"text"` events, NOT in a top-level `content` field. Session ID is a top-level field on every event, not buried in a finish event. The design's assumed schema (`{"type":"text","content":"..."}`) will lead the implementer to write a parser that extracts from the wrong fields.

2. **Design incorrectly claims usage metrics are unavailable.** Line 340 of design.md: "No usage tracking initially (OpenCode doesn't emit token counts in JSON mode -- TBD)." The real output DOES emit usage in `step_finish.part.tokens`. This is not a TBD -- it is verified. Claiming unavailability means the implementer will skip usage extraction, losing a useful capability that exists in the wire format.

3. **The plan's mitigation (T3.4 "capture real output first") is correct in intent but the design still misleads.** T3.4 says "Do NOT code parseResponse against an assumed schema -- use real captured NDJSON as the test fixture and design basis." This is the right approach. But the design document is the first thing the implementer reads, and it shows a concrete wrong schema. The design should either show the REAL schema (from the PM's captured output) or explicitly state that the example is hypothetical and the implementer MUST use real captured output, not the design's examples.

**Required fix:** Update design.md section 5 "parseResponse Design Detail" to show the REAL NDJSON format (`{type, timestamp, sessionID, part}` with `part.text` for text events and `step_finish.part.tokens` for usage). Remove the "No usage tracking" TBD claim and replace with the verified usage extraction path.

---

## Section E: Phasing/Dependency Soundness -- FAIL

**What works:** The 6-phase structure is well-ordered. Riskiest assumptions (submodule vendoring, OpenCode headless) are in Phases 1 and 3 respectively. VERIFY checkpoints exist at every phase boundary. The dependency graph is explicit and acyclic. The test strategy table is complete across unit/integration/e2e levels.

**What fails:**

1. **Tier monotonicity violated in 3 phases.**
   - **Phase 1:** T1.1(standard) -> T1.2(cheap) -- downgrade. T1.2 is "Add apra-pm as git submodule" (cheap), following T1.1 "Rename repo + internal references" (standard). Fix: either reorder (T1.2 first is impossible since it depends on T1.1) or split Phase 1 at the tier boundary (T1.1 in its own phase, T1.2-T1.4 in the next).
   - **Phase 2:** T2.2(premium) -> T2.3(cheap) -- downgrade. T2.3 "Update submodule pin" is trivial (cheap) but follows T2.2 "Port gap-analysis items" (premium). Fix: T2.3 is a mechanical follow-up that could be the first task of Phase 3, or Phase 2 could be split at T2.2's VERIFY.
   - **Phase 6:** T6.2(standard) -> T6.3(cheap) -- downgrade. T6.3 "Commit opencode-exploration.md" is trivial and could be moved before T6.2 or to Phase 5.

   The plan's own plan-prompt.md says: "Monotonically non-decreasing tiers within a phase [...] If a dependency forces a higher-tier task before a lower-tier task within a phase, split the phase at that boundary." The plan violates its own generation rules.

2. **T2.2 (gap ports) may exceed ~50 tool calls.** This task modifies 5 files across the apra-pm submodule, porting 7 must-port items plus up to 3 should-port items. Each port involves reading the old pm source, understanding the gap, writing new content, and verifying consistency. At 4-5 tool calls per port item across 10 items, this is 40-50+ tool calls. Consider splitting: T2.2a ports items 1-4 (SKILL.md additions), T2.2b ports items 5-7 (doer-reviewer-loop, fleet-addendum).

3. **T1.1 has an implicit external dependency.** `gh repo rename` requires org-admin permissions on Apra-Labs. If the doer member doesn't have these permissions, T1.1 blocks the entire epic. This should be listed as a blocker or pre-condition, not discovered at execution time.

4. **T2.2 has a cross-repo dependency that is acknowledged but under-specified.** The task says "This modifies the submodule -- requires a commit in apra-pm repo and submodule SHA update in apra-fleet." But the plan doesn't specify HOW the doer pushes to apra-pm. Does the doer have push access? Does the PM need to create a PR in apra-pm and merge it? This is a process gap that could block the entire Phase 2.

---

## Section F: Backward Compat + Migration -- PASS (with advisory)

**What works:** The rollout section correctly gates the merge on s1-s8 e2e passing. T5.3 (backward-compat.test.ts) covers the key compatibility surfaces: `/pm` command mapping, state file format, beads hooks, context-file filenames. The ND.1-ND.6 requirements in requirements.md are concrete and testable.

**Advisory (not blocking):**

1. **Backward-compat testing is late.** Old pm is deleted in T2.1 (Phase 2) but backward-compat tests aren't written until T5.3 (Phase 5). If a compatibility regression is introduced in Phase 2 gap ports, it won't be caught until Phase 5. Consider adding a smoke test in VERIFY 2: "install new pm skill, run `/pm init`, `/pm status` -- verify no errors."

2. **In-flight sprint migration is not explicitly tested.** The backward-compat test covers state file format compatibility, which implies in-flight sprints are handled. But there's no explicit test scenario: "user is mid-sprint with old pm, upgrades to new pm, resumes sprint." This is an edge case but worth calling out for the e2e suite.

---

## Section G: Submodule+NPM Vendor -- PASS

**What works:** The three install paths (npm, git-clone, SEA binary) are all addressed. The `prepublishOnly` script with fallback checks is sound. The dev-mode path (look in `vendor/apra-pm/` first, fall back to `dist/`) covers both development and npm scenarios. The SEA manifest update is explicitly called out. Error messages ("run git submodule update --init") are user-friendly.

**Minor note:** For a fresh `git clone` without `--recursive`, both `vendor/apra-pm/` and `dist/` will be empty. The install flow should detect this and print a clear error directing the user to run `git submodule update --init`. The design's `vendor-pm.mjs` handles the npm publish case but install.ts itself should have a similar check for the dev-mode path. Verify during VERIFY 1.

---

## Summary

| Section | Verdict | Key Finding |
|---------|---------|-------------|
| A. Gap Analysis | FAIL | Core rules hidden behind "etc."; resume rules misclassified as "should port"; simple sprint demotion risks user disruption |
| B. Dual-Mode Execution | PASS | Strong design; mode detection mechanism could be more concrete |
| C. Per-Member Model Tiers | PASS | Sound three-layer resolution; clean separation of concerns |
| D. OpenCode Adapter | FAIL | parseResponse shows WRONG NDJSON schema (content vs part.text); incorrectly claims usage unavailable; contradicts PM's verified observations |
| E. Phasing/Dependency | FAIL | Tier monotonicity violated in 3 phases; T2.2 possibly too large; cross-repo push access unspecified |
| F. Backward Compat | PASS | Solid rollout gates; backward-compat testing could be earlier |
| G. Submodule+NPM Vendor | PASS | All three install paths covered |

**Top 3 required changes before implementation proceeds:**

1. **Fix parseResponse design** (Section D): Replace the hypothetical NDJSON schema with the REAL format (`{type, timestamp, sessionID, part}`, text in `part.text`, usage in `step_finish.part.tokens`). Remove the "No usage tracking" claim. The plan already says "capture real output first" -- the design should show what that real output looks like.

2. **Strengthen gap analysis** (Section A): Explicitly enumerate all 14 core rules (not "etc.") with per-rule present/port/drop decisions. Promote resume rules (#14) and simple sprint (#18) from "should port" to "must port." Confirm template equivalents in pm-lite for init flow scaffolding.

3. **Fix tier monotonicity** (Section E): Split phases at tier downgrade boundaries, or reorder tasks where dependencies allow. Phase 1: split after T1.1. Phase 2: split after T2.2 or move T2.3 to Phase 3 start. Phase 6: move T6.3 before T6.2.
