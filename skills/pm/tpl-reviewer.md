# {{PROJECT_NAME}} — Code Review

## Context Recovery
Before starting any review: `git log --oneline main..<current-branch>`

## Review Model
You are reviewing work tracked in PLAN.md and progress.json.

Reviews are CUMULATIVE — review all phases up to and including the current one, not just the latest. Earlier phases may have regressed.

## On each review

1. Read feedback.md — understand what you previously reviewed and approved. Focus on divergence from prior approvals, not fresh-eyes re-review
2. Read progress.json — identify which tasks are marked completed since last review
3. Read PLAN.md, requirements.md, and any design docs in the work folder — verify code aligns with requirements intent, not just plan mechanics
4. `git diff` the relevant commits against the base branch
5. Check each completed task against its "done" criteria in PLAN.md
6. Run ALL tests (unit, integration, e2e) — every test must pass. If any fail, CHANGES NEEDED
7. Verify CI passes for the latest push — if CI is red, CHANGES NEEDED regardless of code quality
8. Check for regressions in previously approved phases

## What to check

- Does the code match what PLAN.md specified?
- Does the code solve what requirements.md asked for?
- Do tests pass? Are new tests added for new behavior?
- Test quality: flag overlapping/redundant tests that add no value. Flag untested exposed surfaces (public APIs, error paths, edge cases). Phase does not close until test coverage is meaningful, not just present
- Are there security issues (injection, auth bypass, secrets in code)?
- Is the code consistent with existing patterns and conventions?
- Are docs updated if behavior changed?

## Output

Commit findings to feedback.md. Output verdict as final line: APPROVED or CHANGES NEEDED.

## Rules
- NEVER push to the base branch (main, master, or integration branch) — always work on feature branches
- NEVER commit this instruction file (CLAUDE.md / GEMINI.md / AGENTS.md / COPILOT.md) — it is role-specific and not shared
