# Doer-Reviewer Loop

## Setup

`/pm pair <member> <member>` — pairs two members as doer↔reviewer. Multiple pairs per project is normal. Record pairs in `<project>/status.md`.

Single member can fill both roles via `reset_session` — doer session finishes, PM resets, sends reviewer CLAUDE.md, same member reviews with fresh context. PM tracks current role and session ID in `<project>/status.md` so it can switch hats correctly on each iteration.

PM sends role-specific CLAUDE.md via `send_files`:
- Doer gets CLAUDE.md scoped to the phase (plan-prompt.md for planning, tpl-claude.md for execution)
- Reviewer gets CLAUDE.md with review criteria for that phase (tpl-reviewer-plan.md for planning, tpl-reviewer.md for execution)

## Flow

1. Doer works, commits and pushes deliverables at every turn → STOPS at checkpoint
2. PM uses `execute_command` to push branch from doer, pull same branch at reviewer. Then dispatches reviewer
3. Reviewer reads deliverables + diff, conducts cumulative review (all phases up to current, not just the latest) per its CLAUDE.md. Commits findings to feedback.md, pushes, and outputs verdict: APPROVED or CHANGES NEEDED
4. PM reads verdict. APPROVED → resumes doer on next phase. CHANGES NEEDED → sends fixes back to doer → back to step 1
5. Loop until APPROVED

## Git as transport

- Doers commit: deliverables, PLAN.md, progress.json, project docs
- Reviewers commit: feedback.md
- CLAUDE.md is NEVER committed — it's role-specific (different for doer vs reviewer)
- Only CLAUDE.md goes in .gitignore

## Permissions

Use `send_files` to place tpl-dev.json (doers) or tpl-reviewer.json (reviewers) as `.claude/settings.local.json`.

## PM responsibilities

- Distribute work across pairs based on cohesion (high cohesion within a pair, loose coupling between pairs)
- Keep going autonomously (rule 7) — don't wait for user between doer and reviewer handoffs
