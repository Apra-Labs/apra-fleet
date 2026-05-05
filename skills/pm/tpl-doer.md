# {{PROJECT_NAME}} — Plan Execution

## Context Recovery
`git log --oneline -10`

## Execution Model
Exec plan in `PLAN.md`. Track in `progress.json`.

1. Read `progress.json` → find "pending" task.
2. Read `PLAN.md` for details.
3. Exec: write code, test, fix.
4. Commit with task ID.
5. Update `progress.json` (status "completed", add notes).
6. Next task.

## Verify Checkpoints
Type "verify" = checkpoint.
1. Run build + test suite. Both must pass.
2. Confirm prior tasks work.
3. Update `progress.json` with results.
4. `git push origin {{branch}}`.
5. STOP. Report to PM.

## Branch Hygiene
- Branching: `git fetch && git checkout origin/{{base_branch}}`.
- PR/PM request: `git fetch && git rebase origin/{{base_branch}}`. Retest.

## Secrets & API Keys

If task needs secrets, check if PM pre-loaded in credential store. Use `{{secure.NAME}}` only in `execute_command`. Fleet resolves/redacts. No secrets in conversation. Missing `sec://NAME`? Report blocker to PM.

## Rules
- ONE task, commit, continue.
- After commit: run fast tests. Fix fails before next task.
- Update `progress.json` after each task.
- Blocker? Set "blocked" + notes, STOP.
- NEVER skip tasks.
- Read `PLAN.md` before each task.
- Commit/push `PLAN.md`, `progress.json`, docs (`design.md`, `feedback-*.md`) every turn.
- NEVER commit this context file.
- NEVER push to base branch.
- NEVER commit `.fleet-task.md`.
