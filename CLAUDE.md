# apra-fleet — Plan Execution

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
4. `git push origin bug_fix/file-transfer-windows` — code must be on origin before PM reviews
5. STOP — do not continue. Report status so the PM can review.

## Branch Hygiene
- Before creating a branch: `git fetch origin && git checkout origin/main`
- Before pushing a PR or at PM's request: `git fetch origin && git rebase origin/main`, rerun tests after rebase

## Secrets & API Keys

If this task requires secrets, API keys, or tokens (e.g., external API calls, private registry pushes, third-party service authentication), check whether the PM has pre-loaded them via the credential store before you start. Use `{{secure.NAME}}` tokens only in `execute_command` — never in prompts or log messages. Fleet resolves and redacts them automatically in commands. Do not ask for raw secret values in conversation; if a required `sec://NAME` handle is missing, report it as a blocker so the PM can store it OOB.

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

## File Transfer Tools (`send_files`, `receive_files`)

Both tools must work bidirectionally across all supported OS combinations. The authoritative test matrix is in `tests/file-transfer-matrix.test.ts` — it enumerates every (driver OS, target member type) combination and the strategy each must use.

**Before any change to `src/tools/send-files.ts`, `src/tools/receive-files.ts`, `src/services/strategy.ts`, or `src/services/sftp.ts`:**

1. Read `tests/file-transfer-matrix.test.ts` and confirm you understand which cases your change affects.
2. Run the matrix: `npm test tests/file-transfer-matrix.test.ts` — it must pass before AND after your change.
3. If you are adding a new transport, OS combination, or path-style assumption, add a new row to the matrix BEFORE writing the code.
4. **Path style is the trap.** Windows members report `work_folder` with backslashes (e.g. `C:\Users\...`). The path-resolution code must normalize to forward slashes only on the SFTP path side. Never use `path.posix.resolve()` on Windows-style absolute paths — use `resolveRemotePath()` from `src/utils/platform.ts` instead. The bug fixed in [GH issue #220](https://github.com/Apra-Labs/apra-fleet/issues/220) was caused by `path.posix.resolve('C:/Users/...', '_staging')` producing a garbage Linux-CWD-prefixed path.
5. Path validation must use `agentType` to choose between `path.resolve` (local agents) and `path.posix.resolve` (remote SFTP agents) — never assume the local Node `path` API matches the remote OS.

PRs that don't follow this checklist will be rejected at review.
