# Plan Template Retrospective — Brainstorm

> Source: git diffs (first commit → approved PLAN.md) + feedback.md prose across all 9 planning branches  
> Goal: improve `tpl-plan.md` and `plan-prompt.md` so the reviewer's common objections don't recur

---

## Evidence Base

| Issue | First-pass verdict | Revision rounds | Key feedback themes |
|-------|--------------------|-----------------|---------------------|
| #216 (secret CLI) | CHANGES NEEDED | 1 | Task too large, undeclared blocker, pointer to reqs.md, tier cross-phase, risk gaps |
| #215 (provision_llm_auth) | CHANGES NEEDED | 1 | Broken phase headers, undeclared blockers, vague probe spec, hidden prereq |
| #212 (update command) | CHANGES NEEDED | 1 | **Binary corruption** (Gemini BOM bug) + factual errors about codebase |
| #210 (busy state) | CHANGES NEEDED | 1 | `inFlightAgents` is private (hidden prereq), vague error-matching criteria |
| #204 (caveman compress) | CHANGES NEEDED | 1 | Tier cross-phase, wrong file counts, missing branch name |
| #98 (glob transfer) | CHANGES NEEDED | 1 | Missing task for strategy.ts, security gap post-expansion, tier nit |
| #190, #159, #219 | APPROVED | 0 | No revision needed |

---

## Root Causes (ranked by impact)

### 1. EXPLORE phase didn't verify existence and accessibility of symbols

**What happened:**
- #212: Plan referenced `runUpdateCheck()` (doesn't exist — real name is `checkForUpdate()`), `--check` CLI flag (not implemented), `update` command block in `index.ts` (doesn't exist, no "coming soon" placeholder). The reviewer listed 3 factual errors about codebase state.
- #210: Tasks 3 and 4 told `stop-prompt.ts` to call `inFlightAgents.delete(agent.id)` — but `inFlightAgents` is a `const` in `execute-prompt.ts` with no export. Reviewer: "an implementer following Tasks 3–4 as written would immediately hit a compilation error."
- #215: Gemini probe specified as `gemini --version` but `--version` only confirms CLI is installed, not authenticated. Reviewer: "Two developers would interpret this differently — one might ship `--version`, another would use a real Gemini API call."

**Root cause:** The current PHASE 0 says "List assumptions about how the code works" and "Verify each assumption by reading actual code" — but these are generic. The planner didn't explicitly check: does this function exist? Is this symbol exported? Does this CLI flag already work?

**Proposed fix (plan-prompt.md, PHASE 0, step 5):**

Current:
```
5. Verify each assumption by reading actual code
```

Proposed:
```
5. For every assumption you listed, answer: "How do I know this is currently true?" Then verify it.
   Two categories to check:
   - **Existence:** Does the thing you are building on top of actually exist right now? (e.g. a named entity, interface, resource, capability, configuration, or path your plan depends on)
   - **Accessibility:** Can the part of the system that needs it actually reach it? (e.g. is it exposed, connected, permitted, or in scope for the component that will use it)
   If you cannot verify an assumption, it becomes a risk register entry, not a task precondition.
```

---

### 2. Tier monotonicity — within a phase only (corrected understanding)

**Why the rule exists (operational reason):**

The PM dispatches tasks with data-driven resume logic: `resume = (nextTask.phase === lastDispatchedPhase)`. This means:
- **Within a phase:** `resume=true` — the same `claude -p` session is continued. Context accumulates across tasks.
- **Across phases:** `resume=false` — fresh session, context wiped. What the previous phase's model was is irrelevant.

The context window concern only exists **within a phase**. If T1 is `premium` and generates 1M tokens of context, then T2 tries to resume as `cheap` (200K window), the session fails — the cheap model cannot load that context. Cheap → premium within a phase is safe because context grows into a larger window.

**The rule is: non-decreasing tiers within a phase, and only within a phase.**

Cross-phase ordering is irrelevant — Phase 2 can start at `cheap` even if Phase 1 ended at `premium`, because each new phase always starts fresh.

**Additional constraint: ordering must not break dependencies or cohesion.**

The planner should order tasks within a phase as cheap → standard → premium WHERE POSSIBLE. If a dependency forces a premium task to come before a cheap task, that is a signal the phase boundary is wrong — split the phase, not the ordering rule.

**What actually happened in the planning sessions:**

Looking back at the flagged violations:
- **#98**: Task 6 (`cheap`) appeared within Phase 3 after Tasks 4–5 (`standard`) — genuine within-phase violation ✅ correctly flagged
- **#216**: Phase 4 had `standard → cheap` within the same phase — genuine within-phase violation ✅ correctly flagged
- **#204**: Phase 3 Task 5 (`premium`) → Phase 4 Task 6 (`standard`) — this is cross-phase, NOT a violation ❌ incorrectly flagged

The reviewer's cross-phase findings were wrong. The original within-phase rule in both files is **correct in scope** — the problem was the planner and reviewer didn't apply it carefully enough within each phase.

**Proposed fix (both files):**

The rule wording stays `within a phase`. What needs to change:

1. Add the **why**: context window. cheap tasks first means context is small when the model is small; premium tasks last means large context is only handled by the largest model.
2. Add the **PM streak concept**: within a phase, the PM can group consecutive same-tier tasks as a dispatch "streak" — one `execute_prompt` per tier transition. This is why the ordering matters operationally.
3. Add the **exception clause**: if dependency order within a phase forces a premium task before a cheap task, that is a sign the phase should be split, not the tier rule violated.

**Proposed addition to tpl-plan.md Phase Sizing Rules:**
```
Within a phase, order tasks cheap → standard → premium (non-decreasing). The PM resumes the same session across tasks in a phase — a premium task can build a large context that a cheap model cannot resume from. If a dependency forces a higher-tier task before a lower-tier task, split the phase at that boundary.
```

**Proposed addition to plan-prompt.md PHASE 3 SELF-CRITIQUE:**
```
- Tier downgrade within a phase — does any task have a lower tier than the task before it in the same phase? If yes, either reorder (if dependencies allow) or split the phase at the downgrade point. Cross-phase tier order does not matter — each phase starts with a fresh session.
```

---

### 3. Blockers field treated as optional / inferred from phase order

**What happened:**
- #215: Task 5 (`Blockers: none`) depends on Task 2's `probeExistingAuth()`. Task 6 (`Blockers: none`) depends on Tasks 3 and 4. Reviewer added explicit blocker declarations.
- #216: Task 3 (`Blockers: PID kill cross-platform`) spawns `apra-fleet secret --set <name>` — a command that only exists after Task 1. Dependency not declared.
- #210: Tasks 3 and 4 need `inFlightAgents` exported from `execute-prompt.ts` — not declared as a blocker because the planner assumed access was implicit.

**Root cause:** The template's `Blockers` field has placeholder text `{{potential blockers}}` which invites "none" as a valid answer. The rule for when to declare a blocker is not stated.

**Proposed fix (tpl-plan.md, task field wording):**

Current:
```
- **Blockers:** {{potential blockers}}
```

Proposed:
```
- **Blockers:** none | Task N[, Task M] — list every task this task depends on, even if phase ordering makes it obvious
```

Also add to plan-prompt.md PHASE 3 SELF-CRITIQUE:
```
- Missing blocker — does this task depend on anything that another task produces or puts in place? If yes, that task must be listed in Blockers, even if the phase order implies it.
```

---

### 4. Plan was a terse restatement of requirements instead of an elaboration

**What happened:**
- #216: Task 1 said "Read requirements.md for exact flag semantics." Reviewer: "This is a pointer, not a specification. Two developers could interpret the `--set` error-path logic differently." The reviewer required the planner to inline the 4 `--set` use cases explicitly.
- #215: Implementation tasks didn't specify per-provider behavior — "Tasks 2-4 are generic — they don't specify per-combination behavior." The plan said "implement the flow" without detailing what the flow was for each of 6 provider combos.

**Root cause:** The planner treated the plan as a thin wrapper over requirements.md rather than as its elaboration. Requirements are written in terse human language with loose semantics — intentionally compact. The plan's job is to expand that into precise, unambiguous instructions where every decision is made and every edge case is resolved. A plan that defers decisions back to requirements.md has failed its purpose.

Note: referencing requirements.md is not wrong — it is available in the repo throughout the sprint. What is wrong is using that reference as a substitute for making the decision in the plan itself.

**Proposed fix (plan-prompt.md, PHASE 1 rules):**

Add:
```
- **The plan is the elaboration, not the summary:** requirements.md uses terse human language with intentional ambiguity. PLAN.md must resolve that ambiguity — every edge case decided, every behaviour specified, every acceptance criterion precise enough that two developers would implement the same thing. Referencing requirements.md for background is fine; deferring a decision to it is not.
```

---

### 5. Plan internally acknowledges work that has no task

**What happened:**
- #98: The plan's own Notes section said "the local strategy must be updated" — but no task existed for it. The acknowledgement was there; the commitment wasn't.
- #210: A task description said `stop-prompt.ts` needs to call `inFlightAgents.delete()` — but nowhere in the plan was there a task to make `inFlightAgents` accessible to `stop-prompt.ts`. The dependency was mentioned in passing, never turned into work.

**Root cause:** The plan's own prose (notes, task descriptions, comments) named work that wasn't captured as a task. No self-consistency check existed.

**Proposed fix (plan-prompt.md, PHASE 3 SELF-CRITIQUE):**

Add:
```
- Untracked work — re-read every task description, note, and comment in your draft. Does any sentence say "X will also need to change", "X must be updated", or "X is a prerequisite"? If yes and there is no task that does that work, either add the task or explicitly state it is out of scope.
```

---

### 6. Risk register missing predictable categories

**What happened — what was always missing in first-pass plans:**
- **Backward compat for changed APIs:** #216 missed that the existing `auth.ts` callers (and `launchAuthTerminal`) still call the old path. #98 missed that changing `uploadViaSFTP`'s signature affects all callers.
- **Security / path traversal:** #98 missed that `expandRemotePaths()` inside `downloadViaSFTP` bypasses the pre-expansion `isContainedInWorkFolder` check. A symlink could escape work_folder.
- **External dependency constraints:** #98 initially offered `minimatch` as a glob option — contradicting the requirements' "no new npm deps" constraint.
- **Partial failure:** What if only some exit paths are fixed? What if only the Windows path is fixed but not Linux? These scenarios weren't documented.

**Proposed fix (tpl-plan.md, Risk Register section header):**

Add a prompt under the Risk Register table:
```
Cover at minimum: backward compat (changed API signatures, renamed commands), security (trust boundaries, path traversal, input validation), external constraints (no new deps, min runtime version), partial failure (one platform works, the other doesn't).
```

---

### 7. Implementation branch missing from Notes

**What happened:**
- #204: Reviewer checklist item 12 is "Commit/branch conventions followed." No implementation branch name in the plan → FAIL.

**Root cause:** `tpl-plan.md` Notes has `Base branch: {{base_branch}}` but no slot for the working branch.

**Proposed fix (tpl-plan.md, Notes):**

Add:
```
- Implementation branch: {{impl_branch}}
```

---

## Summary of Proposed Changes

No new checklist section anywhere. Process items go into `plan-prompt.md` at the right phase; output items become template fields in `tpl-plan.md`; reviewer catches output items via the existing `tpl-reviewer-plan.md` checklist.

### `tpl-plan.md`

| Change | Location | Exact edit |
|--------|----------|------------|
| Add `Implementation branch: {{impl_branch}}` | Notes section | New line after `Base branch: {{base_branch}}` |
| Add risk register category prompt | Risk Register section | One line under the table: "Cover at minimum: backward compat (changed interfaces, renamed items), security (trust boundaries, input validation), external constraints (no new dependencies, min runtime version), partial failure (one path works, another doesn't)." |
| Update Phase Sizing Rules tier paragraph | Phase Sizing Rules section | Keep "within a phase" scope; add the WHY (context window growth) + PM streak concept + exception clause (dependency forces downgrade → split the phase) |

### `plan-prompt.md`

| Change | Location | Exact edit |
|--------|----------|------------|
| Strengthen EXPLORE step 5 | PHASE 0, step 5 | Replace generic "verify each assumption" with: existence check (does the thing exist right now?) + accessibility check (can the part that needs it reach it?) — unverified assumptions become risk register entries, not task preconditions |
| Add tier WHY + streak + cross-phase note | PHASE 1 rules, tier constraint bullet | Keep "within a phase"; add: context window reason, PM streak grouping, cross-phase fresh-start note, exception clause |
| Add elaboration rule | PHASE 1 rules | New bullet: plan is the elaboration of requirements — resolve every ambiguity, decide every edge case; referencing requirements.md for background is fine, deferring a decision to it is not |
| Add untracked work check | PHASE 3 SELF-CRITIQUE | New bullet: re-read every task description, note, and comment — any sentence that says "X will also need to change" or "X is a prerequisite" must either have a task or be explicitly marked out of scope |
| Add missing blocker check | PHASE 3 SELF-CRITIQUE | New bullet: does this task depend on anything another task produces or puts in place? If yes, declare it in Blockers — phase order is not a substitute |
| Add tier downgrade check | PHASE 3 SELF-CRITIQUE | New bullet: does any task within a phase have a lower tier than the task before it? If yes, reorder (if dependencies allow) or split the phase; cross-phase tier order does not matter |

---

## Open Questions for Brainstorm

### Q1: Pre-Submit Checklist location — resolved (Option D)

**Resolution:** Split by concern type — no new checklist section anywhere.

| Checklist item | Where it goes | Why |
|---|---|---|
| Tiers non-decreasing within each phase | `plan-prompt.md` PHASE 3 self-critique | Planner catches while drafting |
| Every blocker explicitly declared | `plan-prompt.md` PHASE 3 self-critique | Planner catches while drafting |
| Plan elaborates — no deferred decisions | `plan-prompt.md` PHASE 1 rules | Shapes how tasks are written |
| Untracked work → task or out-of-scope | `plan-prompt.md` PHASE 3 self-critique | Planner catches while drafting |
| Assumptions verified (existence + accessibility) | `plan-prompt.md` PHASE 0 step 5 | Fires before drafting begins |
| Risk register covers compat/security/constraints/partial failure | `tpl-plan.md` Risk Register — prompt line under the table | Committed, visible to reviewer |
| Implementation branch listed | `tpl-plan.md` Notes — `{{impl_branch}}` field | Committed, visible to reviewer |

Process items (how the planner thinks) stay in `plan-prompt.md` and never appear in the committed PLAN.md. Output items (what must be present in the document) become template fields already in `tpl-plan.md`. Reviewer catches the output items via the existing `tpl-reviewer-plan.md` checklist. No new checklist section, no clutter in committed plans. Closing this question.

---

### Q2: Binary corruption (#212) — closed

The corruption in #212's PLAN.md was caused by the Gemini BOM bug (PowerShell `Set-Content -Encoding UTF8` on Windows writes UTF-8 with BOM). Fixed by #219 (`feat/gemini-mcp-fix`). No template change needed — this was a tooling failure, not a planning failure. Closing this question.

---

### Q3: "All spec is inline" — resolved

**Resolution:** "Never reference requirements.md" is too strict. requirements.md is available in the repo throughout the sprint and referencing it for background or context is fine. What is not fine is using it as a substitute for making a decision.

The right framing: requirements.md is terse human intent; PLAN.md is its elaboration. Human language is compact and loose by nature — the planner's job is to expand it into precise, unambiguous instructions. A plan that is equally terse as requirements.md has not done its job. A plan that references requirements.md for background while making all decisions inline has done its job correctly.

**Rule adopted (Section 4 above):** "The plan is the elaboration, not the summary." Referencing requirements.md for context is allowed; deferring any decision or edge case to it is not. Closing this question.
