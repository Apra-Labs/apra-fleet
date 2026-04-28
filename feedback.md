# #182 Tier-Aware Dispatch — Code Review

**Reviewer:** fleet-rev
**Date:** 2026-04-28 18:30:00+00:00
**Verdict:** APPROVED

---

## Phase 1 Review (T1–T4)

### T1: Replace count rule with cohesion rule in plan-prompt.md — PASS

All three instances of the count-based rule have been replaced:

1. **Line 27 (DRAFT rules):** "2-3 work tasks per phase, then a VERIFY checkpoint" replaced with the full cohesion rule: "Phase boundaries by cohesion, not count — a phase is a coherent unit of work that produces a reviewable, testable increment..." — matches requirements.md §1 verbatim. PASS.
2. **Line 67 (SELF-CRITIQUE):** "Checkpoints too far apart — more than 3 work tasks without a VERIFY?" replaced with "Phase boundary at wrong place — does this phase mix unrelated subsystems that could be reviewed independently? Or does it split a cohesive unit across two phases?" — correctly reframes the failure mode in cohesion terms. PASS.
3. **Line 75 (REFINE):** "VERIFY checkpoint every 2-3 work tasks" replaced with "VERIFY checkpoint at the natural completion boundary of each cohesive phase" — consistent with the cohesion model. PASS.

Grep for "2-3 work tasks" and "more than 3 work tasks" across all 5 PM skill files returns zero matches. The count-based rule is fully eradicated.

### T2: Add monotonic tier constraint to plan-prompt.md — PASS

- **Lines 38–42 (DRAFT rules):** Monotonic tier constraint added with exact wording from requirements.md §2, including ✅/❌ examples. Placed correctly after the tier assignment block. PASS.
- **Line 68 (SELF-CRITIQUE):** "Tier downgrade mid-phase — does any phase have a cheaper task after a more expensive one? Split at the downgrade point." — correctly adds the corresponding failure mode. PASS.

### T3: Add cohesion rule and monotonic tier constraint to tpl-plan.md — PASS

- **Lines 56–64:** New "Phase Sizing Rules" section between Risk Register and Notes. Contains:
  - Cohesion rule with wording consistent with plan-prompt.md (minor expected capitalization: sentence-initial vs mid-sentence after a dash). PASS.
  - Monotonic tier constraint with identical wording and examples. PASS.

### T4: Update tpl-reviewer-plan.md checklist — PASS

- **Item 6:** Replaced count-based check with cohesion boundary check. PASS.
- **Item 7:** New monotonic tier check added. PASS.
- **Items 8–13:** Correctly renumbered from original 7–12. PASS.
- No reference to "2-3" task count remains. PASS.

### V1: Cross-file consistency — PASS

| Check | Result |
|-------|--------|
| Zero instances of "2-3 work tasks" count rule | PASS — grep returns 0 matches across all 5 files |
| Cohesion rule in plan-prompt.md and tpl-plan.md | PASS — wording matches |
| Monotonic tier constraint in plan-prompt.md, tpl-plan.md, tpl-reviewer-plan.md | PASS — identical substance |
| tpl-reviewer-plan.md has both new checklist items | PASS — items 6 and 7 |
| No contradictions between files | PASS |

---

## Phase 2 Review (T5–T7)

### T5: Per-task dispatch algorithm in single-pair-sprint.md — PASS

1. **Per-Task Dispatch Algorithm section (lines 50–60):** New section with pseudocode reading `planned.json` + `progress.json`, extracting `nextTask.tier`, deriving `resume` from `nextTask.phase === lastDispatchedPhase`. Matches requirements.md §3 exactly. PASS.
2. **Execution Loop (lines 64–71):** Updated from phase-level dispatch ("resume=false — fresh session per phase") to per-task dispatch ("resume per data-driven rule, model=nextTask.tier"). Reviewer dispatch explicitly marked `model=premium`. PASS.
3. **Session Rules table (lines 76–83):** Rows now use phase-number comparison (`nextTask.phase !== lastDispatchedPhase` / `=== lastDispatchedPhase`) instead of the old "Start of new phase" / "Within a phase" language. PASS.
4. **Data-driven resume rule table (lines 85–92):** The 4-condition table from requirements.md §4 is present and identical to the spec. PASS.
5. **`lastDispatchedPhase` tracking:**
   - Line 60: PM records it after each dispatch. PASS.
   - Line 135: Cleared on sprint completion. PASS.
   - Line 150: Checked during PM restart recovery. PASS.

### T6: Data-driven resume and tier-based dispatch in doer-reviewer.md — PASS

1. **Model tier check (line 14):** Old "Doers use `model=standard` by default" is gone. Now reads: "For doers, PM reads `tasks[i].tier` from `planned.json` and passes `model: <tier>` to `execute_prompt` — no hardcoded default." Matches requirements.md §3. PASS.
2. **Doer session rules (lines 35–36):** Updated to phase-number comparison format (`nextTask.phase !==/=== lastDispatchedPhase`), consistent with single-pair-sprint.md. PASS.
3. **Resume Rule section (lines 57–65):** New "Doer dispatches" subsection with the 4-condition data-driven resume table. Introductory text explicitly states derivation from `planned.json` phase numbers via `lastDispatchedPhase` in `status.md`. PASS.
4. **"All dispatches" table (lines 67–77):** Original table preserved and augmented with two new rows (`stop_prompt` cancellation, session timeout mid-grant). No conflict with the doer-specific table above. PASS.

### T7: Cross-file consistency sweep — PASS

Verified all 6 consistency checks from the PLAN.md specification:

| # | Check | Result |
|---|-------|--------|
| 1 | Zero count-rule survivors across all 5 files | PASS — `grep "2-3 work tasks\|2-3 tasks per phase\|more than 3 work tasks"` returns 0 matches. The two "2-3" hits (single-pair-sprint.md line 19 about requirement descriptions, SKILL.md line 126 about timeout multipliers) are unrelated to phase sizing. |
| 2 | Cohesion rule wording: plan-prompt.md ↔ tpl-plan.md | PASS — identical substance, minor expected casing difference (mid-sentence "a" vs sentence-initial "A") |
| 3 | Monotonic tier constraint: plan-prompt.md ↔ tpl-plan.md | PASS — identical wording and examples in both files |
| 4 | Resume rule: single-pair-sprint.md ↔ doer-reviewer.md | PASS — the 4-condition data-driven resume table is identical in both files |
| 5 | `lastDispatchedPhase` consistency | PASS — referenced in single-pair-sprint.md (dispatch algorithm, session rules, sprint completion, recovery) and doer-reviewer.md (doer session rules, resume rule). All references use the same `status.md` storage location. |
| 6 | No contradictions between any pair of files | PASS — all 5 files reinforce the same dispatch model. plan-prompt.md/tpl-plan.md define rules for planning; tpl-reviewer-plan.md checks them; single-pair-sprint.md and doer-reviewer.md implement them at dispatch time. |

### V2: Acceptance Criteria Verification — PASS

| # | Acceptance Criterion | Status |
|---|---------------------|--------|
| 1 | plan-prompt.md: no count rule, replaced with cohesion rule | PASS |
| 2 | tpl-plan.md: reflects cohesion rule and monotonic tier constraint | PASS |
| 3 | tpl-reviewer-plan.md: checklist items for cohesion + tier checks | PASS |
| 4 | single-pair-sprint.md: per-task dispatch algorithm with `lastDispatchedPhase` | PASS |
| 5 | doer-reviewer.md: data-driven resume derivation from phase numbers | PASS |
| 6 | All 5 files internally consistent — no contradictions | PASS |
| 7 | Count-based "2-3 tasks" rule fully removed from all 5 files | PASS |

### CI Status — NOTE

Markdown-only sprint with no build or test suite. Not a blocker.

---

## Summary

All 7 tasks (T1–T7) and both verification checkpoints (V1, V2) pass without issues. The sprint delivers a complete, consistent overhaul of the PM skill's dispatch model across all 5 files:

- **Phase sizing** shifts from arbitrary "2-3 tasks" count to cohesion-driven boundaries (plan-prompt.md, tpl-plan.md, tpl-reviewer-plan.md)
- **Tier ordering** gains a monotonic non-decreasing constraint within phases (plan-prompt.md, tpl-plan.md, tpl-reviewer-plan.md)
- **Dispatch granularity** moves from per-phase to per-task with tier-aware model selection (single-pair-sprint.md, doer-reviewer.md)
- **Resume logic** becomes data-driven via `lastDispatchedPhase` in `status.md`, replacing manual reasoning (single-pair-sprint.md, doer-reviewer.md)

No contradictions found between any pair of files. No partial survivals of the old count-based rule. All 7 acceptance criteria from requirements.md are met. Ready for merge.
