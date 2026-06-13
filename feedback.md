# OpenCode+PM epic - Plan Review

**Reviewer:** fleet-plan-reviewer-2 (independent plan-reviewer agent)
**Date:** 2026-06-13
**Sprint:** OpenCode Provider + PM Submodule + Agent Install Epic
**Documents reviewed:** requirements.md, design.md, plan.md, docs/opencode-exploration.md, old PM skill files (git show main:skills/pm/* -- all 21 files cross-checked), src/providers/provider.ts (ProviderAdapter interface), src/providers/codex.ts (reference adapter), src/cli/config.ts

---

## Verdict: CHANGES NEEDED

The overall architecture is sound across all three parts. The dual-mode execution design is particularly strong. The per-member model tier design is clean and ready for implementation. However, two categories of defect require correction: (1) the parseResponse section in design.md contains a fabricated NDJSON schema and incorrectly claims usage metrics are unavailable -- both contradicted by the PM's own captured output; (2) the plan violates its own tier-monotonicity rule in 4 of 6 phases.

---

## A. GAP ANALYSIS COMPLETENESS -- PASS (with minor concerns)

Cross-checked all 21 old PM files against the gap table's 26 rows. Every file is accounted for. The decisions are well-reasoned.

**What works well:**
- All 21 old PM files present in the gap table with per-file analysis
- The 7 "must-port" items identify the right critical features: sprint selection, /pm command reference, core operational rules, secrets, provider awareness + context-file table, pre-flight checks, fleet-specific sections (permissions, stop_prompt, unattended)
- Both "Drop" items (fleet dependency bootstrap) are correct -- pm-lite's fleet-independence is the raison d'etre
- "Present" items spot-checked: beads lifecycle (old beads.md vs pm-lite beads.md -- equivalent), git-as-transport (old doer-reviewer.md vs pm-lite sprint.md -- equivalent), safeguards (same limits: 3 retries, 3 cycles, 2 resets per tier), worktrees (pm-lite has worktrees.md), cleanup (pm-lite sprint.md completion section), init (pm-lite setup phase), plan generation (pm-lite agents/planner.md -- more sophisticated than old plan-prompt.md), backlog (beads deferred items)
- The "Partial" items correctly identify where pm-lite covers the concept but not completely

**Minor concerns (not blocking):**

1. **Gap #19 (multi-pair-sprint -> worktrees.md) conflates two concepts.** The old multi-pair-sprint.md has two distinct ideas: (a) parallel git branches for independent tracks (covered by worktrees.md) and (b) **contracts** -- shared interfaces documented in `contracts.md` before dispatch, immutable during the sprint, with an explicit revision protocol if a contract must change. Worktrees handles (a) but not (b). This is defensible in the pm-lite model: a single orchestrator managing multiple worktrees can coordinate cross-track dependencies directly without formal contracts. But the gap analysis should acknowledge this distinction rather than treating them as equivalent.

2. **Core rule enumeration.** Gap row #7 lists 8 of 14 core rules for porting. The unlisted rules (#1 never read code, #5 ad-hoc vs task harness, #7 keep going until stuck, #10 commit state files every turn, #14 read sub-documents first) are behavioral constraints that pm-lite likely satisfies through its design principles, but this should be confirmed explicitly rather than left implicit. Rule #10 in particular (commit PLAN/progress/feedback every turn) is critical for git-as-transport integrity.

3. **tpl-status.md.** Dismissed as "nice-to-have" in gap #26, but it contains the `lastDispatchedPhase` field structure that the resume rules (gap #14) depend on. When resume rules are ported, the `lastDispatchedPhase` mechanism must be included in the status.md format specification.

4. **Simple sprint classification.** Gap #18 marks simple-sprint as "should port." The old SKILL.md sprint selection table routes 1-3 task work to simple-sprint.md. This is a user-visible workflow path. If existing users expecting the lightweight flow get the full heavyweight sprint instead, that is friction -- though not breakage since the full sprint still works for small tasks. "Should port" is defensible but borderline.

---

## B. DUAL-MODE EXECUTION -- PASS (with advisory notes)

Design section 4a is the strongest section of the entire design document. It treats the two execution models as architecturally distinct rather than bolting fleet dispatch onto local execution.

**What works well:**
- **Mode detection** is concrete: 3-step check (fleet members available -> user flag -> default based on tier matching). Mode stored in status.md for recovery/resume. Testable and deterministic.
- **Loop semantics table** clearly articulates the fundamental difference: inline-blocking (local subagents return within the same turn) vs async-dispatch (execute_prompt + monitor_task). This is the hardest thing to get right and it is correctly specified.
- **Role mapping** maps all 4 roles (planner, plan-reviewer, doer, reviewer) in both modes with concrete mechanisms (Agent tool with subagent_type vs execute_prompt to member).
- **State/transport identity** ("git is the message bus in both modes") is the architectural insight that makes dual-mode feasible. Sprint state files, beads lifecycle, and worktrees work identically regardless of mode because the transport layer is the same.
- **Fleet-only features** are cleanly enumerated with justification for why each is fleet-only (compose_permissions, context-file filenames, member pairing, stop_prompt, unattended flags, monitor_task polling).
- **Risk #9 (drift)** is acknowledged with mitigations: dual-mode acceptance criteria in every VERIFY, e2e for both modes, mode-selection as a single function. Process-level mitigation, not architectural enforcement, but pragmatic for LLM-driven skill files.
- **Acceptance criteria** are explicit: 6 checkboxes covering mode detection, complete sprint in each mode, fleet feature gating, reviewer checks, and e2e coverage.

**Advisory (not blocking):**

1. **Mode detection assumes fleet skill introspection.** The pm skill detects fleet availability by checking "fleet skill loaded + members registered." But pm is fleet-independent -- it cannot import fleet code. The detection must work via MCP tool probing (attempt `fleet_status`, catch error) or environment signals. Solvable at implementation time but worth noting.

2. **Local-mode Agent tool is Claude Code specific.** The design says local mode uses `Agent` tool with `subagent_type: "planner"`. If PM runs on OpenCode, the equivalent is the `task` tool with agent names. Since PM currently only runs on Claude Code, this is not a defect, but the assumption should be explicit.

3. **Fleet polling loop is unspecified.** After execute_prompt dispatch in fleet mode, how does the PM detect completion? The design mentions monitor_task in the fleet-only features table but doesn't specify the polling interval, timeout, or completion detection. The old doer-reviewer.md had explicit flow steps for this. This needs to be covered in the fleet-addendum (gap port #7).

---

## C. PER-MEMBER MODEL TIERS -- PASS

Design section 5a and plan T3.7 are well-specified and ready for implementation as-is.

**What works well:**
- `model_tiers` as an optional field on MemberRecord is backward-compatible for existing members
- Dispatch-time resolution in execute-prompt.ts (not in the adapter) is correct separation of concerns
- Fallback chain is concrete and correct: `memberTiers[tier]` -> `memberTiers.standard` -> `memberTiers.cheap` -> `Object.values(memberTiers)[0]` -> `provider.modelForTier(tier)`. Handles all partial-map combinations.
- Validation: at least one model required for opencode at registration, single-model expansion, non-opencode members unaffected
- `resolveModelForTier()` function is concrete enough to implement directly
- Clean tie to issue #299 (endpoint vs model selection -- complementary)
- T3.7 covers all implementation pieces with unit tests for each fallback path

**No concerns.** This section is well-architected.

---

## D. OPENCODE ADAPTER -- FAIL

The adapter method mapping is complete. I verified against the ProviderAdapter interface in `src/providers/provider.ts` -- all 5 readonly properties and 26 methods are accounted for with OpenCode-specific values. Most values are correct per the exploration document. However, the parseResponse design section contains critical technical errors.

### What works

- Method coverage: all ProviderAdapter members mapped (the design says "24 methods" in the current-state map which is a minor count error; actual interface has 26 methods + 5 properties, all covered)
- `instructionFileName: 'OPENCODE.md'` correctly flagged UNVERIFIED with TODO. Plan T3.1 includes verification. Acceptable.
- `permissionModeAutoFlag(): null` -- correct, OpenCode has no auto mode
- `buildPromptCommand` correctly uses positional arg `run "<prompt>"` (not --prompt). Verified in exploration doc section 4.
- `resumeFlag` correctly uses `--session <id>` and `--continue`. Verified.
- `composePermissionConfig` maps doer/reviewer to OpenCode permission frontmatter. Exploration doc section 6.1 verified the tool->permission mapping.
- `classifyError` patterns are reasonable for OpenCode error strings
- `skipPermissionsFlag: '--dangerously-skip-permissions'` -- verified in exploration doc
- `supportsOAuthCopy: false`, `supportsApiKey: false` -- correct for local-endpoint members
- Install config paths (`~/.config/opencode/`, `~/.config/opencode/agents/`, etc.) match OpenCode's documented paths

### What fails

**1. parseResponse NDJSON schema is fabricated and wrong.**

Design.md section 5 (parseResponse Design Detail) shows:
```
{"type": "text", "content": "..."}
{"type": "tool-call", "name": "edit", "args": {...}}
{"type": "tool-result", "name": "edit", "result": "..."}
{"type": "finish", "reason": "stop", "usage": {...}}
```

These are labeled "Expected event types (from ai-sdk patterns)" -- meaning they are speculative, extrapolated from the ai-sdk library's internal types, not from actual `opencode run --format json` output. The PM captured REAL output and the actual format is structurally different:

- **Top-level structure is `{type, timestamp, sessionID, part}`** -- not flat `{type, content}`. Every event wraps its payload in a `part` object.
- **Text content is in `part.text`** of `type:"text"` events -- not in a top-level `content` field. A parser that reads `event.content` will get `undefined`.
- **Session ID is `sessionID` at the top level on EVERY event** -- not only available from a finish event. The parser should extract it from the first event.
- **The finish event is `step_finish` with `part.tokens`** -- not `{"type":"finish","usage":{...}}`.

**2. Design incorrectly claims usage metrics are unavailable.**

Design.md line 340: "No usage tracking initially (OpenCode doesn't emit token counts in JSON mode -- TBD)."

This is factually wrong. The real output DOES emit usage in `step_finish.part.tokens`. Claiming unavailability means the implementer will set `usage: undefined` in ParsedResponse, losing token tracking that exists in the wire format. This is a verified capability, not a TBD.

**3. Plan mitigation is strong but insufficient.**

Plan T3.4 says: "Pre-step: CAPTURE REAL OUTPUT FIRST. Do NOT code parseResponse against an assumed schema -- use real captured NDJSON as the test fixture and design basis." This is excellent defensive planning. However:
- The design document is the first thing the implementer reads. It presents a concrete, plausible-looking wrong schema that will shape the implementer's mental model.
- The PM already HAS real captured output. The design should have been updated before review.
- The "No usage tracking" claim is actively misleading, not merely uncertain.

### Required changes

1. Replace the speculative NDJSON examples with real captured output showing `{type, timestamp, sessionID, part}` structure
2. Remove "No usage tracking initially" -- replace with: "Usage extracted from `step_finish.part.tokens`"
3. Update session ID extraction: top-level `sessionID` field on every event, not just finish
4. Keep the format-instability risk callout (the format IS undocumented and may change) but base it on the real structure

---

## E. PHASING/DEPENDENCY SOUNDNESS -- FAIL

### What works

- **Riskiest assumptions front-loaded:** Phase 1 = submodule+vendoring (build complexity), Phase 3 = OpenCode headless+parseResponse (format uncertainty). Correct ordering.
- **VERIFY checkpoints at cohesion boundaries:** 6 VERIFYs at natural increment boundaries. Each produces a testable, coherent artifact.
- **Dependency graph** is explicit and acyclic. The ASCII diagram shows all task dependencies clearly.
- **Test strategy table** is complete: unit (adapter, transform, config), integration (install flow, backward compat), e2e (opencode member sprint, existing suites).

### What fails

**1. Tier monotonicity violated in 4 of 6 phases.**

The plan's own plan-prompt.md mandates: "Monotonically non-decreasing tiers within a phase [...] If a dependency forces a higher-tier task before a lower-tier task within a phase, split the phase at that boundary."

| Phase | Task tiers (in order) | Violation |
|-------|----------------------|-----------|
| Phase 1 (T1.1-T1.4) | standard, **cheap**, standard, standard | T1.1(std) -> T1.2(cheap) |
| Phase 2 (T2.1-T2.3) | cheap, premium, **cheap** | T2.2(prem) -> T2.3(cheap) |
| Phase 3 (T3.1-T3.7) | cheap, std, std, premium, **std**, **cheap**, std | T3.4(prem) -> T3.5(std), T3.5(std) -> T3.6(cheap) |
| Phase 4 (T4.1-T4.4) | cheap, std, std, std | VALID |
| Phase 5 (T5.1-T5.3) | std, std, std | VALID |
| Phase 6 (T6.1-T6.3) | cheap, std, **cheap** | T6.2(std) -> T6.3(cheap) |

Fixes per phase:
- **Phase 1:** T1.2 depends on T1.1, so reorder is impossible. Split after T1.1, or promote T1.2 to standard.
- **Phase 2:** Move T2.3 (cheap, trivial submodule pin) to the start of Phase 3.
- **Phase 3:** Independent branches in the dependency graph allow reordering. T3.6(cheap) and T3.5(standard) are independent of T3.3/T3.4. Reorder: T3.1(cheap) -> T3.6(cheap) -> T3.2(std) -> T3.5(std) -> T3.7(std) -> T3.3(std) -> T3.4(premium).
- **Phase 6:** T6.3(cheap) has no dependency on T6.2(std). Move T6.3 before T6.1.

**2. T2.2 (gap ports) may exceed ~50 tool calls.**

T2.2 modifies 5+ files in the submodule with 7 must-port items + 3 should-port items. Each port involves reading the old source, understanding the pm-lite gap, writing ported content, and verifying consistency. At 4-6 tool calls per item across 10 items = 40-60 tool calls. Plan-prompt.md says: "Too large -- more than ~50 tool calls? Split it." Suggested split:
- T2.2a: SKILL.md ports (sprint selection, command reference, core rules, secrets, provider awareness)
- T2.2b: doer-reviewer-loop/sprint.md ports (pre-flight checks, resume rules, doc harvest)
- T2.2c: New files (fleet-addendum.md, simple-sprint.md)

**3. Cross-repo workflow under-specified.**

T1.1 (rename) and T2.2 (gap ports) modify the apra-pm repo, not apra-fleet. The plan acknowledges this ("requires a PR to apra-pm repo") but does not specify:
- Does the doer push directly to apra-pm, or create a PR?
- Who reviews apra-pm changes?
- How does "ONE PR at the end" constraint apply across two repos?

Natural approach: separate PR to apra-pm (reviewed and merged independently), then pin the merged SHA in apra-fleet's submodule. Should be stated explicitly.

**4. T1.1 has an implicit org-admin pre-condition.**

`gh repo rename` requires org-admin permissions on Apra-Labs. If the doer's token lacks admin scope, T1.1 blocks the entire epic at the first task. Should be listed as a pre-condition.

---

## F. BACKWARD COMPAT + MIGRATION -- PASS

**What works well:**
- T5.3 (backward-compat.test.ts) verifies: old `/pm` commands map to new equivalents, old state file formats work, beads lifecycle unchanged, context-file filenames preserved
- Rollout gates the merge on ALL existing e2e suites (s1-s8) passing -- strongest backward-compat guarantee available
- Protection table: fleet skill untouched, hooks untouched, settings merge logic unchanged, beads DB untouched, provider configs only additive, old sprint state files compatible
- ND.1-ND.6 requirements are concrete and testable
- The rollout's 5-step migration path requires no new manual steps for existing users

**Minor concern (not blocking):**

- Backward-compat testing is in Phase 5 but old PM is deleted in Phase 2. If a regression is introduced during gap ports (T2.2), it won't be caught for 3 phases. Consider adding a smoke test to VERIFY 2.
- Mid-sprint upgrade continuity is not explicitly tested. A user mid-sprint who upgrades should be able to resume. The format compatibility tests imply this works but it's worth noting as a manual verification item.

---

## G. SUBMODULE+NPM VENDOR -- PASS

Design section 2 covers all three install paths correctly.

**What works well:**
- **npm:** `prepublishOnly` runs `vendor-pm.mjs` to copy submodule files into the package. Fallback checks (submodule initialized -> copy; not initialized -> check dist/; neither -> clear error). Correct.
- **git clone:** `vendor/apra-pm/` submodule provides files directly. Install.ts looks in vendor first, falls back to dist/. Correct.
- **SEA binary:** `gen-sea-config.mjs` collects from `vendor/apra-pm/`. Correct.
- Alternatives-considered table is well-reasoned. Submodule+vendor is the right choice.
- Error messages ("run git submodule update --init") are user-friendly.

**Minor concern (not blocking):**

For a fresh `git clone` without `--recursive`, both `vendor/apra-pm/` and `dist/` may be empty. The vendor-pm.mjs handles the npm publish case, but install.ts's dev-mode path should also detect and print a clear error. Verify during VERIFY 1.

---

## Summary

| Section | Verdict | Key Finding |
|---------|---------|-------------|
| A. Gap Analysis | PASS | Comprehensive coverage; minor concerns about contracts concept, core rule enumeration, and tpl-status.md |
| B. Dual-Mode Execution | PASS | Strongest section; concrete mode detection, correct state/transport identity |
| C. Per-Member Model Tiers | PASS | Well-specified; correct fallback chain; ready for implementation |
| D. OpenCode Adapter | **FAIL** | parseResponse shows fabricated NDJSON schema (`content` vs `part.text`); falsely claims usage unavailable; contradicts PM's captured output |
| E. Phasing/Dependencies | **FAIL** | Tier monotonicity violated in 4/6 phases; T2.2 too large; cross-repo workflow and org-admin pre-condition unspecified |
| F. Backward Compat | PASS | Solid rollout gates; s1-s8 must pass before merge |
| G. Submodule+NPM Vendor | PASS | All three install paths covered correctly |

---

### Required changes (minimum to reach APPROVED)

1. **Fix design.md parseResponse section (D):** Replace the speculative NDJSON schema with the REAL captured format: top-level `{type, timestamp, sessionID, part}`, text in `part.text`, usage in `step_finish.part.tokens`. Remove "No usage tracking initially -- TBD." Keep the format-instability risk callout but base it on the real structure, not a guess.

2. **Fix plan.md tier ordering (E):** Reorder or split phases 1, 2, 3, 6 to achieve monotonically non-decreasing tiers. Concrete fixes: Phase 1 split after T1.1; Phase 2 move T2.3 to Phase 3 start; Phase 3 reorder independent tasks cheap-first; Phase 6 move T6.3 before T6.1.

3. **Split plan T2.2 (E):** Break into 2-3 sub-tasks to keep each under ~50 tool calls.

4. **Clarify cross-repo workflow (E):** State explicitly that apra-pm changes go through a separate PR, and the apra-fleet PR pins the resulting SHA.

### Items that would strengthen the plan (advisory, not blocking)

- Acknowledge the contracts vs worktrees distinction in gap #19
- Ensure tpl-status.md's `lastDispatchedPhase` mechanism is included when resume rules are ported
- Explicitly enumerate all 14 core rules with per-rule present/port/drop decisions
- Add fleet polling loop (interval, timeout) to the fleet-addendum specification
- Add backward-compat smoke test in VERIFY 2 rather than waiting for Phase 5
- List org-admin permissions as a pre-condition for T1.1
- Consider promoting simple sprint (gap #18) from "should port" to "must port" to avoid user friction
