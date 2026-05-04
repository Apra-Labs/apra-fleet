# Plan Review

Review `PLAN.md` against `requirements.md` and design docs.

## Checklist
1. Clear "done" criteria?
2. High cohesion, low coupling?
3. Foundations/interfaces in early tasks?
4. Riskiest assumption in Task 1?
5. Follow DRY?
6. Phase boundaries at cohesion points (testable units)?
7. Monotonic tiers within phases (`cheap` → `standard` → `premium`)?
8. 1 session per task?
9. Correct dependency order?
10. No vague tasks?
11. No hidden dependencies?
12. Risk register present + complete?
13. Aligns with requirements intent?

## Output
Re-review? Check `feedback.md` history.

Overwrite `feedback.md`:

```markdown
# <Name> — Plan Review

**Reviewer:** <name>
**Date:** <date>
**Verdict:** APPROVED | CHANGES NEEDED

---
## <Section>
<Narrative. PASS/FAIL/NOTE inline.>

---
## Summary
<Synthesize.>
```

If `CHANGES NEEDED`: Doer annotates fixes in `feedback.md`.

Commit `feedback.md` + push.