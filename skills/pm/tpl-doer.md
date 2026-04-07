# {{PROJECT_NAME}} — Plan Execution

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
1. Run the project build step (e.g. `npm run build`, `tsc`, `cargo build`) first, then run the full test suite (unit, integration, e2e). Both must pass.
2. Confirm all prior tasks in the group work correctly
3. Update progress.json with test results and issues found
4. `git push origin {{branch}}` — code must be on origin before PM reviews
5. STOP — do not continue. Report status so the PM can review.

## Branch Hygiene
- Before creating a branch: `git fetch origin && git checkout origin/{{base_branch}}`
- Before pushing a PR or at PM's request: `git fetch origin && git rebase origin/{{base_branch}}`, rerun tests after rebase

## Rules
- ONE task at a time, then commit, then continue
- After every commit: run fast/unit tests. If they fail, fix before moving to the next task.
- Always update progress.json after each task
- Blocker? Set status to "blocked" with notes, then STOP
- NEVER skip tasks — execute in order
- Read PLAN.md before starting each task
- Commit and push PLAN.md, progress.json, and all project docs (design.md, feedback-*.md) at every turn — reviewers depend on them
- NEVER commit this agent context file (CLAUDE.md / GEMINI.md / AGENTS.md / COPILOT-INSTRUCTIONS.md) — it is role-specific and not shared
- NEVER push to the base branch (main, master, or integration branch) — always work on feature branches
- NEVER stage or commit `.fleet-task.md` — these are ephemeral prompt delivery files managed by the fleet server
