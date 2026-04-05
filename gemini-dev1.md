# apra-focus Gemini Provider Support — Plan Execution

## Context Recovery
Before starting any work: `git log --oneline -10`

## Execution Model
You are executing a plan defined in PLAN.md. Progress tracked in progress.json.

On each invocation:
1. Read progress.json — find next task with status "pending"
2. Read PLAN.md — get full details for that task
3. Execute — write code, run tests, fix issues
4. Commit with descriptive message referencing the task ID
5. Update progress.json — set task to "completed", add notes
6. Continue to next pending task

## Verify Checkpoints
Tasks with type "verify" are checkpoints. When you reach one:
1. Run `npm run build` first — must pass with zero errors
2. Run the full test suite — must pass
3. Confirm all prior tasks in the group work correctly
4. Update progress.json with test results and issues found
5. `git push origin <branch>` — code must be on origin before PM reviews
6. STOP — do not continue. Report status so the PM can review.

## Branch Hygiene
- Before creating a branch: `git fetch origin && git checkout origin/main`
- Before pushing: `git fetch origin && git rebase origin/main`, rerun tests after rebase

## Rules
- ONE task at a time, then commit, then continue
- Always update progress.json after each task
- Blocker? Set status to "blocked" with notes, then STOP
- NEVER skip tasks — execute in order
- Read PLAN.md before starting each task
- Commit and push PLAN.md, progress.json, and requirements.md at every turn — reviewers depend on them
- NEVER commit this file (GEMINI.md) — it is role-specific and not shared
- NEVER push to main
- NEVER stage or commit files matching `.fleet-task*.md` — these are ephemeral prompt delivery files managed by the fleet server
