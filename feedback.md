# Bug Fixes & API Cleanup Sprint — Plan Review

**Reviewer:** sprint/skill-refactor reviewer  
**Date:** 2026-04-06 16:45:00+00:00  
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## Prior Review Context

The previous review (commit fdbcf0c) identified a **requirements-checklist gap**. The plan is correctly aligned with requirements.md as written, but the user's review checklist asks about specifications that do not appear in requirements.md. No changes have been made to requirements.md or PLAN.md since that review.

---

## Requirements vs. Checklist — Gap Summary

| Issue | User's Checklist Question | What requirements.md Says | Verdict |
|-------|---------------------------|---------------------------|---------|
| #89 | CWD fix correct? | Agent CWD = `agent.workFolder`, prompt in tmpDir | **MATCH** |
| #88 | Fix crash `ledger.granted is not iterable`? Fix template? Fresh template test? | Only: add warning when granting without `project_folder` | **GAP** |
| #87 | Rename to `llm_cli`? | `cli` is acceptable | **GAP** |
| #85 | Rename `work_folder` → `run_from`? macOS tilde? Update execute_prompt defaults? | Only: document `work_folder` in skill docs | **GAP** |
| #84 | Rename `provision_auth` → `provision_llm_auth`? | Only: audit for consistent naming | **GAP** |
| #83 | Server-side accumulation + REMOVE tool? | Only: document best-effort git commit | **GAP** |

The plan correctly implements requirements.md. The checklist asks for more than requirements.md specifies.

---

## Plan Review Checklist (Against Current requirements.md)

| # | Check | Status |
|---|-------|--------|
| 1 | Every task has clear "done" criteria? | **PASS** |
| 2 | High cohesion, low coupling? | **PASS** |
| 3 | Key abstractions in earliest tasks? | **PASS** — #89 front-loaded |
| 4 | Riskiest assumption in Task 1? | **PASS** |
| 5 | Later tasks reuse early abstractions? | **N/A** — independent bug fixes |
| 6 | 2-3 tasks per phase + VERIFY? | **PASS** |
| 7 | Each task one session? | **PASS** |
| 8 | Dependencies satisfied in order? | **PASS** |
| 9 | Vague tasks? | **PASS** — all specific |
| 10 | Hidden dependencies? | **PASS** |
| 11 | Risk register? | **PASS** |
| 12 | Aligns with requirements.md? | **CONDITIONAL PASS** |

---

## Path Forward

Two options:

### Option A: Confirm Current Scope
If requirements.md is authoritative, the plan can proceed. The additional items in the checklist (#88 crash fix, #87 `llm_cli`, #85 renames/tilde, #84 rename, #83 tool removal) are **out of scope** and should be tracked as separate issues.

### Option B: Expand Requirements
If the checklist represents true intent, update requirements.md with:

1. **#88:** Add crash fix specification (`ledger.granted is not iterable`), template fix, fresh template test requirement
2. **#87:** Change field name from `cli` to `llm_cli` if that's the desired name
3. **#85:** Add `work_folder` → `run_from` rename, macOS tilde expansion fix, `execute_prompt` defaults update, skill doc guidance
4. **#84:** Add `provision_auth` → `provision_llm_auth` rename
5. **#83:** Add server-side token accumulation implementation and tool removal

Then re-plan to address the expanded scope.

---

## Summary

The plan passes all structural checks and is correctly aligned with requirements.md as written. However, the review cannot be approved because the user's checklist references specifications not captured in requirements.md.

**Blocking issue:** Resolve the requirements-checklist gap before proceeding.

- If Option A: Confirm scope, plan can proceed (change verdict to APPROVED)
- If Option B: Update requirements.md first, then re-plan

The doer should clarify which option applies before implementation begins.
