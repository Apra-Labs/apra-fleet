# Bug Fixes & API Cleanup Sprint — Plan Review

**Reviewer:** sprint/skill-refactor reviewer  
**Date:** 2026-04-06 14:32:00+00:00  
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## 1. Requirements-Plan Alignment Analysis

**CRITICAL FINDING: The user's review checklist references specifications that do NOT appear in requirements.md.**

I compared each item from the user's prompt against the actual requirements.md:

| User's Question | What requirements.md Actually Says | Match? |
|-----------------|-----------------------------------|--------|
| #89: CWD fix correct? | Agent CWD = `agent.workFolder`, prompt file in tmpDir | YES |
| #88: Fix crash `ledger.granted is not iterable`? Fix template? Test fresh template? | Only: add warning when granting without `project_folder` | **NO** — no crash fix, no template fix mentioned |
| #87: Rename to `llm_cli` (not just `cli`)? | Rename to `cli` or provider-agnostic name | **NO** — requirements say `cli` is acceptable |
| #85: Rename `work_folder` → `run_from`? macOS tilde expansion? Update execute_prompt defaults? | Only: document `work_folder` in skill docs | **NO** — no renames, no tilde fix, no execute_prompt changes |
| #84: Rename `provision_auth` → `provision_llm_auth`? | Only: audit for consistent naming (no hyphenated refs) | **NO** — no rename to `provision_llm_auth` |
| #83: Server-side accumulation + REMOVE tool? | Only: clarify best-effort git commit behavior in docs | **NO** — no removal, just documentation |

**Diagnosis:** Either:
1. requirements.md is incomplete and needs to be updated with the full specifications, OR
2. The user's checklist is based on an outdated understanding of the scope

The plan correctly addresses requirements.md as currently written. But if the user's checklist represents the TRUE intent, then requirements.md is the problem, not the plan.

---

## 2. Plan Review Checklist (Against Current requirements.md)

| # | Check | Status |
|---|-------|--------|
| 1 | Every task has clear "done" criteria? | PASS — all tasks have explicit "Done when:" |
| 2 | High cohesion within tasks, low coupling between? | PASS |
| 3 | Key abstractions in earliest tasks? | PASS — #89 is front-loaded |
| 4 | Riskiest assumption validated in Task 1? | PASS — CWD fix explicitly first |
| 5 | Later tasks reuse early abstractions (DRY)? | N/A — independent bug fixes |
| 6 | 2-3 work tasks per phase + VERIFY? | PASS — all phases structured correctly |
| 7 | Each task completable in one session? | PASS — all marked cheap/standard |
| 8 | Dependencies satisfied in order? | PASS — Task 6 waits for Task 4 |
| 9 | Vague tasks two devs would interpret differently? | PASS — all specific |
| 10 | Hidden dependencies? | PASS — none found |
| 11 | Risk register? | PASS — 4 risks documented |
| 12 | Aligns with requirements.md intent? | **CONDITIONAL PASS** — matches current requirements.md, but requirements.md may be incomplete |

---

## 3. Specific Issue-by-Issue Analysis

### #89 — CWD Fix
**PASS.** Plan Task 1 correctly identifies:
- Change `promptOpts.folder` from `tmpDir` to `agent.workFolder`
- Keep prompt file written to `tmpDir`
- Pass absolute path to `buildAgentPromptCommand`
- Verify `os-commands.ts` supports absolute paths (blocker noted)

Code at `execute-prompt.ts:112` confirms `folder: tmpDir` is the bug. Plan addresses this correctly.

### #88 — Ledger Warning
**PASS (per requirements.md).** Plan Task 2 adds a warning when granting without `project_folder`.

**But if the user's intent is to fix a crash:** The plan does NOT address `ledger.granted is not iterable`. Looking at `compose-permissions.ts:161`, the code already defaults to `{ stacks: [], granted: [] }` when `project_folder` is omitted, so `granted` should always be an array. Either:
- The crash scenario is different than expected (e.g., `loadLedger` returning malformed data), OR
- requirements.md omitted the crash fix specification

### #87 — Field Rename
**PASS (per requirements.md).** Plan Task 4 renames `claude` → `cli`. Code at `member-detail.ts:146` shows `result.claude = cli`.

**Note:** requirements.md says `cli` is acceptable. If the actual requirement is `llm_cli`, requirements.md should specify this.

### #85 — work_folder Documentation
**PASS (per requirements.md).** Plan Task 6 item 1 documents `work_folder` in skill docs.

**Note:** requirements.md does NOT mention:
- Renaming to `run_from`
- macOS tilde expansion
- Updating `execute_prompt` defaults
- "Never pass registered folder explicitly" guidance

If these are required, they must be added to requirements.md.

### #84 — provision_auth Consistency
**PASS (per requirements.md).** Plan Task 6 item 2 audits for consistent naming.

Code at `src/index.ts:95` shows the tool is registered as `provision_auth`. requirements.md only asks for consistency audit, not a rename to `provision_llm_auth`.

### #83 — Token Behavior Documentation
**PASS (per requirements.md).** Plan Task 5 updates the tool description and improves the warning message.

requirements.md explicitly states this is a documentation fix, not a tool removal.

---

## 4. Missing Items

If the user's checklist represents true intent, the following are missing from requirements.md AND the plan:

1. **#88 crash fix:** The `ledger.granted is not iterable` scenario and its fix
2. **#88 template fix:** Whatever template issue exists
3. **#88 fresh template test:** Test for fresh template handling
4. **#87 field name:** `llm_cli` vs `cli` decision
5. **#85 renames:** `work_folder` → `run_from` if intended
6. **#85 tilde expansion:** macOS tilde expansion fix
7. **#85 execute_prompt:** Update defaults for execute_prompt
8. **#84 rename:** `provision_auth` → `provision_llm_auth` if intended
9. **#83 tool removal:** Server-side accumulation + tool removal if intended

---

## Summary

The plan is correctly aligned with requirements.md as written. However, the user's review checklist references specifications that are NOT in requirements.md. This is a **requirements gap**, not a planning error.

**Action Required:**

1. **Update requirements.md** with the full specifications for each issue (crash fixes, renames, tool removals, etc.) if those are the true requirements
2. **Re-plan** once requirements are authoritative
3. OR **Confirm current scope** — if requirements.md accurately reflects the intended scope, the plan can proceed as-is

**Cannot approve until** the requirements-checklist discrepancy is resolved. The plan should not be implemented against ambiguous specifications.
