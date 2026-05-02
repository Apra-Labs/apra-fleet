# Plan Template Improvements — Code Review

**Reviewer:** claude-opus (independent review)
**Date:** 2026-05-02
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.

---

## R1: Diff vs Retro Spec Alignment

The retro's "Summary of Proposed Changes" table lists 3 edits for `tpl-plan.md` and 6 edits for `plan-prompt.md`. All 9 are present in the diff. Nothing is missing, nothing is extra.

| Retro item | Status |
|---|---|
| tpl-plan: `Implementation branch: {{impl_branch}}` in Notes | PASS — added after `Base branch: {{base_branch}}` |
| tpl-plan: Risk register category prompt | PASS — one line under the table with the four categories |
| tpl-plan: Phase Sizing Rules tier paragraph | PASS — adds WHY (context window), PM streak, exception clause, cross-phase note |
| plan-prompt: Strengthen PHASE 0 step 5 | PASS — existence + accessibility checks, unverified → risk register |
| plan-prompt: Tier WHY + streak + cross-phase in PHASE 1 | PASS — full reasoning inline with the rule |
| plan-prompt: Elaboration rule in PHASE 1 | PASS — "plan is the elaboration, not the summary" |
| plan-prompt: Untracked work check in PHASE 3 | PASS — re-read every description/note/comment |
| plan-prompt: Missing blocker check in PHASE 3 | PASS — explicit blocker declaration rule |
| plan-prompt: Tier downgrade check in PHASE 3 | PASS — replaces old terse version, adds cross-phase clarification |

Wording is faithful to the retro's reasoning throughout. The retro's root cause 3 also proposed changing the Blockers template field in `tpl-plan.md` from `{{potential blockers}}` to `none | Task N[, Task M] — list every task...`, but the Summary table (the authoritative spec) did not include this edit — the branch correctly follows the Summary, placing blocker enforcement in `plan-prompt.md` self-critique instead. This is the right call per Q1's resolution (process items in plan-prompt.md, output items in tpl-plan.md).

---

## R2: Internal Consistency Between Files

**plan-prompt.md tier rule vs tpl-plan.md tier rule:** Both state the same constraint with the same reasoning (context window, PM streak, exception clause, cross-phase note). Minor stylistic differences — tpl-plan.md adds "rather than violating the ordering rule" and uses "always starts" vs "starts" — these are editorial, not substantive. PASS.

**plan-prompt.md vs tpl-reviewer-plan.md:** The reviewer checklist item 7 ("Are tiers monotonically non-decreasing within each phase?") is consistent with the updated tier rules. Item 12 (risk register completeness) aligns with the new risk register category prompt in tpl-plan.md — the reviewer now has specific categories to check against. No conflicts. PASS.

**Phase boundary rule:** Identical wording in both plan-prompt.md (PHASE 1 rules) and tpl-plan.md (Phase Sizing Rules). PASS.

---

## R3: Regression Check

All pre-existing rules were preserved:

- PHASE 0 steps 1-4, 6: unchanged
- PHASE 1 task structure (Change/Files/Tier/Done when/Blockers): unchanged
- PHASE 1 rules (session size, dependency ordering, tier assignment): unchanged
- PHASE 2 front-load foundations: unchanged
- PHASE 3 existing self-critique checks (low cohesion, high coupling, vague task, too large, hidden dependency, late verification, wrong ordering, missing done criteria, phase boundary): all preserved
- PHASE 4 refine and PHASE 5 branch & commit: unchanged
- tpl-plan.md task template structure: unchanged
- tpl-reviewer-plan.md: no changes needed, no changes made

The fix commit (`e78302d`) correctly removed the old "Tier downgrade mid-phase" line that the first commit (`cea5880`) left as a duplicate alongside the new expanded version. PASS.

---

## R4: Commit Hygiene

Two commits: the main change (`cea5880`) and a quick follow-up fix for a duplicate line (`e78302d`). Both scoped correctly. No unrelated changes. PASS.

---

## Summary

All 9 proposed changes from the retro are present, correctly placed, and faithfully worded. The two files are internally consistent with each other and with `tpl-reviewer-plan.md`. No regressions to existing rules. The Blockers template field was intentionally left unchanged per the retro's Q1 resolution — blocker enforcement lives in the planner's self-critique, not the committed template. Clean approval.
