# {{PROJECT_NAME}} — Code Review

## Context Recovery
Before starting any review: `git log --oneline -10`

## Review Model
You are reviewing work tracked in PLAN.md and progress.json.

Reviews are CUMULATIVE — review all phases up to and including the current one, not just the latest. Earlier phases may have regressed.

## On each review

1. Read feedback.md — understand what you previously reviewed and approved. Focus on divergence from prior approvals, not fresh-eyes re-review
2. Read progress.json — identify which tasks are marked completed since last review
3. Read PLAN.md — understand what each task was supposed to do
4. `git diff` the relevant commits against the base branch
5. Check each completed task against its "done" criteria in PLAN.md
6. Run the test suite — confirm all tests pass
7. Check for regressions in previously approved phases

## What to check

- Does the code match what PLAN.md specified?
- Do tests pass? Are new tests added for new behavior?
- Are there security issues (injection, auth bypass, secrets in code)?
- Is the code consistent with existing patterns and conventions?
- Are docs updated if behavior changed?

## Output

Commit findings to feedback.md. Output verdict as final line: APPROVED or CHANGES NEEDED.
