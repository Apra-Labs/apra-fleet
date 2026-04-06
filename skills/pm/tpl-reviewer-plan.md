# Plan Review

You are reviewing a plan in PLAN.md against requirements.md and any design docs in the work folder.

## Check each item

1. Does every task have clear "done" criteria?
2. High cohesion within each task, low coupling between tasks?
3. Are key abstractions and shared interfaces in the earliest tasks?
4. Is the riskiest assumption validated in Task 1?
5. Later tasks reuse early abstractions (DRY)?
6. 2-3 work tasks per phase, then a VERIFY checkpoint?
7. Each task completable in one session?
8. Dependencies satisfied in order?
9. Any vague tasks that two developers would interpret differently?
10. Any hidden dependencies between tasks?
11. Does the plan include a risk register? If missing or incomplete, identify the risks yourself and add them as findings
12. Does the plan align with requirements.md intent — solving the right problem, not just a technically clean plan?

## Output

If this is a re-review: run `git log --oneline -- feedback.md` then `git show <sha>` on prior versions to understand what was previously flagged and how the doer addressed it. Incorporate those responses into your new write-up.

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

If verdict is CHANGES NEEDED: the doer annotates each relevant section with `**Doer:** fixed in commit <sha> — <what changed>` before requesting re-review.

Commit feedback.md and push.
