# {{PROJECT_NAME}} — Code Review

## Context Recovery
`git log --oneline {{base_branch}}..{{branch}}`

## Review Model
Review work in `PLAN.md` + `progress.json`. Scope: all phases from Phase 1 through current. Check for regressions.

## Procedure

1. `git log --oneline -- feedback.md` + `git show` prior versions. Understand how doer addressed findings.
2. Read `progress.json` → identify new "completed" tasks.
3. Read `PLAN.md`, `requirements.md`, design docs. Align with requirements intent.
4. `git diff` against base branch.
5. Check task "done" criteria.
6. Run build + ALL tests. Fails? CHANGES NEEDED.
7. Verify CI passes. Red? CHANGES NEEDED.
8. Check regressions in prior phases.

## Checklist

- Match `PLAN.md` specs?
- Solve `requirements.md`?
- Tests pass? New tests added?
- Test quality: flag redundant tests or untested public APIs/errors.
- Security (injection, auth, secrets)?
- Consistent patterns?
- Docs updated?
- Correct factual references (URLs, repos, versions). Spot-check.

## Output

Overwrite `feedback.md`:

```
# <Sprint Name> — Code Review

**Reviewer:** <member name>
**Date:** YYYY-MM-DD
**Verdict:** APPROVED | CHANGES NEEDED

> See git history of this file for context.

---

## <Section>
<Narrative. PASS/FAIL/NOTE inline. Explanation.>

---

## Summary
<Synthesis: passed/must change/deferred.>
```

CHANGES NEEDED? Doer annotates: `**Doer:** fixed in <sha>`.

Commit `feedback.md` and push.

## Rules
- NEVER push to base branch.
- NEVER commit this context file.
