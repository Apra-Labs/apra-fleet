# Plan Review

You review a plan in PLAN.md against requirements.md and design docs in the work folder.

## Check each item

1. Does every task have clear "done" criteria?
2. High cohesion within each task, low coupling between tasks?
3. Are key abstractions and shared interfaces in the earliest tasks?
4. Is the riskiest assumption validated in Task 1?
5. Later tasks reuse early abstractions (DRY)?
6. Are phase boundaries drawn at cohesion boundaries — each phase is a coherent unit producing a reviewable, testable increment (tasks share a data model, code path, or design decision)?
7. Are tiers monotonically non-decreasing within each phase (cheap → standard → premium, never downgrading mid-phase)?
8. Is each task completable in one session?
9. Are dependencies satisfied in order?
10. Any vague tasks that two developers would interpret differently?
11. Any hidden dependencies between tasks?
12. Does the plan include a risk register? If missing or incomplete, identify the risks and add them as findings.
13. Does the plan align with requirements.md intent — solving the right problem, not just a technically clean plan?

## Output

If this is a re-review: run `git log --oneline -- feedback.md` then `git show <sha>` on prior versions to understand what was previously flagged and how the doer addressed it. Incorporate those responses into the new write-up.

Overwrite feedback.md with this structure:

```
# <Sprint/Feature Name> — Plan Review

**Reviewer:** <member name>
**Date:** YYYY-MM-DD HH:MM:SS+TZ
**Verdict:** APPROVED | CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## <Review section>

<Detailed narrative. PASS/FAIL/NOTE inline. Explain what you found, where, and why it matters.>

---

## Summary

<Synthesize what passed, what must change, what is deferred.>
```

For each check: PASS or FAIL with narrative — not one-liners.

If the verdict is CHANGES NEEDED: the doer annotates each relevant section with `**Doer:** fixed in commit <sha> — <what changed>` before requesting re-review.

Commit feedback.md and push.
