# #182 Tier-Aware Dispatch — Code Review

**Reviewer:** fleet-rev
**Date:** 2026-04-28 12:00:00+00:00
**Verdict:** APPROVED

---

## Phase 1 Review (T1–T4)

### T1: Replace count rule with cohesion rule in plan-prompt.md — PASS

All three instances of the count-based rule have been replaced:

1. **Line 27 (DRAFT rules):** "2-3 work tasks per phase, then a VERIFY checkpoint" replaced with the full cohesion rule: "Phase boundaries by cohesion, not count — a phase is a coherent unit of work that produces a reviewable, testable increment..." — matches requirements.md section 1 verbatim. PASS.
2. **Line 67 (SELF-CRITIQUE):** "Checkpoints too far apart — more than 3 work tasks without a VERIFY?" replaced with "Phase boundary at wrong place — does this phase mix unrelated subsystems that could be reviewed independently? Or does it split a cohesive unit across two phases?" — correctly reframes the failure mode in cohesion terms. PASS.
3. **Line 75 (REFINE):** "VERIFY checkpoint every 2-3 work tasks" replaced with "VERIFY checkpoint at the natural completion boundary of each cohesive phase" — consistent with the cohesion model. PASS.

Grep for "2-3 work tasks" and "more than 3 work tasks" across all 5 PM skill files returns zero matches. The count-based rule is fully eradicated.

### T2: Add monotonic tier constraint to plan-prompt.md — PASS

- **Lines 38–42 (DRAFT rules):** The monotonic tier constraint is added as a new rule bullet with the exact wording from requirements.md section 2, including both the `checkmark` and `cross` examples. Placed correctly after the tier assignment block. PASS.
- **Line 68 (SELF-CRITIQUE):** "Tier downgrade mid-phase — does any phase have a cheaper task after a more expensive one? Split at the downgrade point." — correctly adds the corresponding failure mode. PASS.

### T3: Add cohesion rule and monotonic tier constraint to tpl-plan.md — PASS

- **Lines 56–64:** A new "Phase Sizing Rules" section is added between Risk Register and Notes. Contains:
  - Cohesion rule with wording consistent with plan-prompt.md (minor expected capitalization difference: sentence-initial "A" vs mid-sentence "a" after a dash). PASS.
  - Monotonic tier constraint with identical wording and examples as plan-prompt.md. PASS.

### T4: Update tpl-reviewer-plan.md checklist — PASS

- **Item 6:** Replaced "2-3 work tasks per phase, then a VERIFY checkpoint?" with "Are phase boundaries drawn at cohesion boundaries — each phase is a coherent unit producing a reviewable, testable increment (tasks share a data model, code path, or design decision)?" PASS.
- **Item 7:** New item added: "Are tiers monotonically non-decreasing within each phase (cheap → standard → premium, never downgrading mid-phase)?" PASS.
- **Items 8–13:** Correctly renumbered from the original 7–12. PASS.
- No reference to "2-3" task count remains. PASS.

### V1: Cross-file consistency — PASS

| Check | Result |
|-------|--------|
| Zero instances of "2-3 work tasks" count rule across all files | PASS — grep returns 0 matches |
| Cohesion rule in both plan-prompt.md and tpl-plan.md | PASS — wording matches (modulo expected casing) |
| Monotonic tier constraint in plan-prompt.md, tpl-plan.md, and tpl-reviewer-plan.md | PASS — identical substance in all three |
| tpl-reviewer-plan.md has both new checklist items | PASS — items 6 (cohesion) and 7 (tier ordering) |
| No contradictions between the 3 files | PASS — all files reinforce the same model |

### CI Status — NOTE

No CI runs exist for this branch. This is a markdown-only sprint with no build or test suite, so there is nothing to gate on. Not a blocker.

---

## Summary

All four Phase 1 tasks (T1–T4) and the V1 verification pass without issues. The count-based "2-3 work tasks per phase" rule is fully removed from all files. The cohesion rule and monotonic tier constraint are present and consistent across plan-prompt.md, tpl-plan.md, and tpl-reviewer-plan.md. The reviewer checklist has both new items. No contradictions found between any files.

Phase 2 (T5–T7, V2) remains pending — those tasks modify single-pair-sprint.md and doer-reviewer.md, which are untouched in this phase as expected.
