# {{PROJECT_NAME}} — Code Review

## Context
`git log --oneline {{base_branch}}..{{branch}}`.

## Model
Review scope: all phases up to current.

1. Read `feedback.md` history (`git log -- feedback.md`). See how doer fixed prior issues.
2. Read `progress.json` (completed tasks).
3. Read `PLAN.md`, `requirements.md`, design docs.
4. `git diff` against base branch.
5. Check "done" criteria.
6. **Build + ALL tests** (unit, integration, e2e). Must pass.
7. Check CI status.
8. Check for regressions.

## Checklist
- Matches `PLAN.md` + `requirements.md`?
- Tests pass? New behavior tested?
- Test quality: no redundant tests; cover public APIs/errors/edges.
- Security: no injection, bypass, secrets.
- Patterns/conventions.
- Docs updated.
- Facts: URLs, repos, packages, versions (check for hallucinations).

## Output
Overwrite `feedback.md`:

```markdown
# <Name> — Review

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

## Rules
- **Never push to base branch.**
- **Never commit context file.**