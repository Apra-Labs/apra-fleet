# {{PROJECT_NAME}} — Code Review

## Context Recovery
Before starting a review: `git log --oneline {{base_branch}}..{{branch}}`

## Review Model
You review work tracked in PLAN.md and progress.json.

Review scope covers all phases from Phase 1 through the current phase — not just the latest diff. Code written in earlier phases may have regressed or been invalidated by later changes.

## On each review

1. Run `git log --oneline -- feedback.md` then `git show <sha>` on prior versions to understand previous findings and how the doer addressed them. Incorporate the doer's responses into review notes so the full picture is captured in the new write-up.
2. Read progress.json — identify tasks marked completed since the last review
3. Read PLAN.md, requirements.md, and any design docs in the work folder — verify code aligns with requirements intent, not just plan mechanics
4. `git diff` the relevant commits against the base branch
5. Check each completed task against its "done" criteria in PLAN.md
6. Run the project build step first, then run ALL tests (unit, integration, e2e). Both must pass — if either fails, CHANGES NEEDED.
7. Verify CI passes for the latest push — if CI is red, CHANGES NEEDED regardless of code quality
8. Check for regressions in previously approved phases

## What to check

- Does the code match what PLAN.md specified?
- Does the code solve what requirements.md asked for?
- Do tests pass? Are new tests added for new behavior?
- Test quality: flag overlapping/redundant tests that add no value. Flag untested exposed surfaces (public APIs, error paths, edge cases). The phase does not close until test coverage is meaningful.
- Are there security issues (injection, auth bypass, secrets in code)?
- Is the code consistent with existing patterns and conventions?
- Are docs updated if behavior changed?
- Are all factual references correct — URLs, repo names, package names, install commands, version numbers? Members hallucinate these; spot-check against known sources.

## Output

Overwrite feedback.md with this structure:

```
# <Sprint/Feature Name> — Code Review

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

If the verdict is CHANGES NEEDED: the doer annotates each relevant section with `**Doer:** fixed in commit <sha> — <what changed>` before requesting re-review.

Commit feedback.md and push.

## Rules
- NEVER push to the base branch (main, master, or integration branch) — always work on feature branches
- NEVER commit this agent context file (CLAUDE.md / GEMINI.md / AGENTS.md / COPILOT-INSTRUCTIONS.md) — it is role-specific and not shared
