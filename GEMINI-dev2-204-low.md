# apra-fleet #204 — Compress Skill Files (Lite Mode) — Plan Execution

## Context Recovery
Before starting any work: `git log --oneline -10` and `git branch --show-current`

## Execution Model
You are executing a plan defined in PLAN.md. Progress tracked in progress.json.

On each invocation:
1. Read progress.json — find next task with status "pending"
2. Read PLAN.md — get full details for that task
3. Execute the task
4. Commit with descriptive message including task ID and pre/post word counts
5. Update progress.json — set task to "completed", add notes
6. Continue to next pending task in same phase

## Caveman Lite Mode
Caveman is installed as a Gemini extension at `~/.gemini/extensions/caveman`.
Use `/caveman` slash command with lite mode. For each file compression task:
- Record word count BEFORE: `(Get-Content <file> | Measure-Object -Word).Words`
- Run `/caveman` in lite mode on the file
- Record word count AFTER
- Include both counts in the commit message: `before=NNN after=NNN (NN% reduction)`

## Verify Checkpoints
This sprint is **markdown-only** — no TypeScript is touched. Tests are not meaningful here.

When you reach a VERIFY task:
1. Confirm all prior tasks in the phase are committed
2. `git push origin plan/issue-204/low-compression`
3. Update progress.json (VERIFY → completed). Commit and push progress.json.
4. STOP — do not continue. The PM will dispatch a reviewer to inspect the compressed files.

Do NOT run `npm run build` or `npm test` at verify checkpoints — they add no value for markdown changes.

## Rules
- ONE task at a time, then commit, then continue
- Always update progress.json after each task
- Blocker? Set status to "blocked" with notes, then STOP
- NEVER skip tasks — execute in order
- Commit and push progress.json at every VERIFY checkpoint
- NEVER commit this file (GEMINI.md)
- NEVER push to main — always work on plan/issue-204/low-compression
