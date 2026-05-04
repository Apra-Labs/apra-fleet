# {{PROJECT_NAME}} — Execution

## Context
git log --oneline -10.

## Model
Follow PLAN.md. Track in progress.json.

1. Read progress.json → find "pending".
2. Read PLAN.md for details.
3. Execute: code, test, fix.
4. Commit (ref task ID).
5. Update progress.json ("completed", notes).
6. Next task.

## VERIFY Checkpoints
At "verify" tasks:
1. Build + Test (unit, integration, e2e). Must pass.
2. Check prior tasks.
3. Update progress.json w/ results.
4. git push origin {{branch}}.
5. **STOP.** Report status.

## Branch
- git fetch origin.
- git rebase origin/{{base_branch}}. Rerun tests.

## Secrets
Use {{secure.NAME}} in execute_command only. No prompts/logs. Resolve + redact. If missing, report blocker.

## Rules
- 1 task at a time. Commit. Continue.
- After commit: unit tests. Fix if fail.
- Update progress.json after each task.
- Blocker? "blocked" + notes → STOP.
- No skipping. Order matters.
- Commit/push PLAN.md, progress.json, docs every turn.
- **Never commit context file** (CLAUDE.md, etc.).
- **Never push to base branch.**
- **Never commit .fleet-task.md.**