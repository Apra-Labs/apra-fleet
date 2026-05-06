# apra-fleet #210 — Plan Execution

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

## Branch
`plan/issue-210` (base: `main`)

## Verify Checkpoints
Tasks with type "verify" are checkpoints. When you reach one:
1. Run `npm run build` then `npm test` — both must pass
2. Confirm all prior tasks in the group work correctly
3. Update progress.json with test results and issues found
4. `git push origin plan/issue-210` — code must be on origin before PM reviews
5. STOP — do not continue. Report status so the PM can review.

## Branch Hygiene
- Always on `plan/issue-210` — never push to `main`
- Before pushing: `git fetch origin && git rebase origin/main`, rerun tests after rebase

## Rules
- ONE task at a time, then commit, then continue
- After every commit: run `npm test` — fix failures before moving to next task
- Always update progress.json after each task
- Blocker? Set status to "blocked" with notes, then STOP
- NEVER skip tasks — execute in order
- Read PLAN.md before starting each task
- Commit and push PLAN.md, progress.json at every turn
- NEVER commit this file (CLAUDE.md)
- NEVER push to main
- NEVER stage or commit `.fleet-task.md`
