# Plan Review: UX Quality Fixes

**Branch:** `sprint/ux-quality-fixes`
**Reviewer:** Claude Opus 4.6
**Date:** 2026-04-05

## Checklist

1. **Does every task have clear "done" criteria?**
   FAIL — No task has any done criteria. Each task is a single phrase ("Review and fix typography inconsistencies") with no definition of what "fixed" means, which files/components are in scope, or how to verify completion.

2. **High cohesion within each task, low coupling between tasks?**
   FAIL — Tasks are topically cohesive (typography, spacing, contrast) but so vague that scope overlap is inevitable. For example, font-size changes (task-1) may require spacing adjustments (task-2), and contrast fixes (task-3) may force color changes that affect both.

3. **Are key abstractions and shared interfaces in the earliest tasks?**
   FAIL — No shared abstractions are identified. If the plan intends to introduce design tokens, a theme file, or a shared CSS utility layer, that should be task-1. Currently there is no indication of this.

4. **Is the riskiest assumption validated in Task 1?**
   FAIL — The riskiest assumption is unstated. The plan assumes there *are* typography inconsistencies, spacing issues, and contrast failures, but no audit or inventory step exists to confirm this. Task-1 should be an audit that produces a concrete list of findings.

5. **Later tasks reuse early abstractions (DRY)?**
   FAIL — No abstractions are defined, so there is nothing to reuse. Each task appears fully independent, which risks introducing ad-hoc fixes that duplicate logic.

6. **2-3 work tasks per phase, then a VERIFY checkpoint?**
   PASS — 3 work tasks followed by task-4 (verify checkpoint). Structure is correct, though the checkpoint itself lacks criteria.

7. **Each task completable in one session?**
   FAIL — Without scope boundaries, any of these tasks could expand to touch every component in the app. "Fix typography inconsistencies" across an entire application is not one-session work unless the scope is bounded.

8. **Dependencies satisfied in order?**
   FAIL — Typography, spacing, and contrast are interdependent. Changing font sizes (task-1) affects spacing (task-2); changing colors for contrast (task-3) may require revisiting earlier tasks. The plan does not acknowledge or manage these dependencies.

9. **Any vague tasks that two developers would interpret differently?**
   FAIL — Every task is vague. "Review and fix typography inconsistencies" — inconsistent relative to what? A design system? A Figma file? The developer's taste? Two developers would produce entirely different outputs.

10. **Any hidden dependencies between tasks?**
    FAIL — See #8. Font-size changes ripple into spacing; contrast fixes may change colors that affect the visual hierarchy established in task-1. These are hidden because the plan does not acknowledge them.

11. **Does the plan include a risk register?**
    FAIL — No risk register exists. Identified risks:
    - **No requirements.md**: There is no requirements document on this branch. The plan cannot be validated against intent because intent is not documented.
    - **No design reference**: Without a design system, style guide, or Figma source of truth, "fix" is subjective.
    - **Regression risk**: UX changes without visual regression testing may introduce new inconsistencies.
    - **Scope creep**: Unbounded tasks in a visual domain tend to expand indefinitely.

12. **Does the plan align with requirements.md intent?**
    FAIL — `requirements.md` does not exist on this branch. There is no way to verify alignment with requirements that are not documented.

## Summary

**11 FAIL / 1 PASS**

The plan is a topic outline, not an actionable implementation plan. It lacks:
- A requirements document defining what "quality" means and what problems to solve
- Done criteria for every task
- Scope boundaries (which components, pages, or files)
- A design reference or source of truth to fix *toward*
- Dependency management between interdependent visual changes
- A risk register
- An audit/inventory step before jumping to fixes

## Recommendations

1. **Add `requirements.md`** — define the specific UX problems observed, with screenshots or component names.
2. **Task-1 should be an audit** — produce a concrete inventory of issues before fixing anything.
3. **Introduce shared abstractions early** — if design tokens or a theme layer is needed, that must come before per-component fixes.
4. **Add done criteria** to every task (e.g., "all headings use `--font-heading` token; no hardcoded font-size values remain").
5. **Bound scope** — list which pages/components are in scope per task.
6. **Add a risk register** with the items identified in check #11.

---

**Verdict: CHANGES NEEDED**
