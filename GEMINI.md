# apra-fleet #245 — Uninstall Command — Plan Execution

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
1. Run `npm run build` then `npm test`. Both must pass.
2. Confirm all prior tasks in the phase work correctly
3. Update progress.json with test results and issues found
4. `git push origin feat/uninstall-command` — code must be on origin before PM reviews
5. STOP — do not continue. Report status so the PM can review.

## Branch Hygiene
- Branch: `feat/uninstall-command` (base: `main`)
- Before pushing a PR or at PM's request: `git fetch origin && git rebase origin/main`, rerun tests after rebase

## Rules
- ONE task at a time, then commit, then continue
- After every commit: run `npm run build` and fast unit tests. If they fail, fix before moving to the next task.
- Always update progress.json after each task
- Blocker? Set status to "blocked" with notes, then STOP
- NEVER skip tasks — execute in order
- Read PLAN.md before starting each task
- Commit and push PLAN.md, progress.json at every turn
- NEVER commit this file (GEMINI.md) — it is the agent context file
- NEVER push to main — always work on feat/uninstall-command
- NEVER stage or commit `.fleet-task.md`
