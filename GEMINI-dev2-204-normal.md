# apra-fleet #204 — Compress Skill Files (Normal Mode) — Plan Execution

## Context Recovery
Before starting any work: `git log --oneline -5` and `git branch --show-current`

## Execution Model
You are executing a plan defined in progress.json (in your work folder C:/akhil/git/apra-fleet-2).

On each invocation:
1. Read progress.json — find next task with status "pending"
2. Execute the task
3. Commit with descriptive message including task ID and pre/post word counts
4. Update progress.json — set task to "completed", add notes
5. Continue to next pending task

## Caveman Normal Mode
Use `/caveman` with NO flags (default normal mode). Normal mode = compress aggressively, remove filler, condense sentences, may drop articles. This is stronger than lite mode but not the maximum setting.

For each file compression task:
- Record word count BEFORE: `(Get-Content <file> | Measure-Object -Word).Words`
- Run `/caveman` in normal mode on the file
- Record word count AFTER
- Include both counts in the commit message: `before=NNN after=NNN (NN% reduction)`

## Rules
- ONE task at a time, then commit, then continue
- Always update progress.json after each task
- Blocker? Set status to "blocked" with notes, then STOP
- NEVER skip tasks — execute in order
- NEVER commit this file (GEMINI.md or GEMINI-dev2-204-normal.md)
- NEVER push to main — always work on plan/issue-204/normal-compression
- NEVER run `npm run build` or `npm test` — this is a markdown-only sprint, tests add no value

## Final VERIFY (V1)
When you reach V1:
1. Confirm all prior tasks (T1–T11) are committed
2. `git push origin plan/issue-204/normal-compression`
3. Update progress.json — set V1 to "completed". Commit and push progress.json.
4. STOP — do not continue. The PM will dispatch a reviewer for prose review.
