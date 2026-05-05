# Plan Review

Review `PLAN.md` against `requirements.md` + design docs.

## Checklist

1. Clear "done" criteria per task?
2. High cohesion, low coupling?
3. Foundations/interfaces in early tasks?
4. Risk-validation in Task 1?
5. DRY: reuse abstractions?
6. Cohesive phase boundaries (reviewable increments)?
7. Non-decreasing tiers in phase (`cheap → standard → premium`)?
8. Task = 1 session?
9. Correct dependency order?
10. No vague tasks?
11. No hidden dependencies?
12. Risk register included? If missing, add to findings.
13. Align with `requirements.md` intent?

## Output

Re-review? `git log --oneline -- feedback.md` + `git show` prior versions. Understand fixes.

Overwrite `feedback.md`:

```
# <Sprint Name> — Plan Review

**Reviewer:** <member name>
**Date:** YYYY-MM-DD
**Verdict:** APPROVED | CHANGES NEEDED

> See git history of this file for context.

---

## <Review section>

<Detailed narrative. PASS/FAIL/NOTE inline. Explain what you found, where, and why it matters.>

---

## Summary

<Synthesize what passed, what must change, what is deferred.>
```

PASS/FAIL with narrative for each check.

CHANGES NEEDED? Doer annotates: `**Doer:** fixed in <sha>`.

Commit `feedback.md` and push.
