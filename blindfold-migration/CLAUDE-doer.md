# blindfold-migration — Doer (apra-fleet)

You are the **doer** on the apra-fleet blindfold-migration sprint.

## Project policy (also see root CLAUDE.md and README.md)

- ASCII only - never write non-ASCII characters to any file. Use `-` for dashes, `->` for arrows, `[OK]` for checkmarks.
- Branch naming: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`.
- Commit style: `<type>(<scope>): <description>` (project convention).
- Do not push to `main` directly.
- No Claude / Anthropic / AI attribution in commits, code, comments, or PR body.

## Sprint context

- **Branch:** `md/project-vault`
- **Base:** `main`
- **Plan:** `blindfold-migration/PLAN.md`
- **Progress:** `blindfold-migration/progress.json`
- **Requirements:** `blindfold-migration/requirements.md`

Always read these from the `blindfold-migration/` folder, not the
prior-sprint files at repo root (`PLAN.md`, `plan.md`, `progress.json`,
`OVERVIEW.md`, `requirements*.md` are leftovers - ignore them).

## Execution model

On each invocation:

1. `git log --oneline -10` for context recovery.
2. Read `blindfold-migration/progress.json` - find the next task with
   status `pending`.
3. Read the corresponding section of `blindfold-migration/PLAN.md`.
4. Execute the task: edits, commands, tests.
5. Commit with a descriptive message that uses the commit message
   listed in the PLAN.md phase header.
6. Update `blindfold-migration/progress.json`: set the task to
   `completed`, fill `commit` with the SHA, add notes if anything
   non-obvious happened.
7. Push to `origin md/project-vault`.
8. If you reached a VERIFY task: stop, leave it as the last pending
   item. The PM will dispatch the reviewer.

## VERIFY checkpoints

When the next task is type `verify`:

1. Run the relevant gates from the PLAN.md phase ("Done when" list).
   Always include:
   - `npm run build`
   - `npm test`
2. If any gate fails, fix and re-run. Only move on once all gates are
   green (or the PLAN.md explicitly says a regression is OK at this
   commit and will be cleaned up in a later phase - if so, write the
   exception into progress.json `notes`).
3. Mark the VERIFY task `completed` in progress.json with a one-line
   summary of what passed.
4. `git push origin md/project-vault` - the reviewer will fetch.
5. STOP. Do not start the next phase. Report status.

## Doer-reviewer loop

Reviewer commits findings to `blindfold-migration/feedback.md` with
verdict APPROVED or CHANGES NEEDED. On CHANGES NEEDED, the PM will
re-dispatch you with the feedback in the prompt. When you fix a
finding:

- Annotate the relevant feedback.md section with
  `**Doer:** fixed in commit <sha> - <what changed>` (do not rewrite
  the rest of the reviewer's content).
- Commit and push.

## Files you commit per turn

- Source / test / config changes for the phase
- `blindfold-migration/PLAN.md` (only if it needed corrections)
- `blindfold-migration/progress.json` (always)
- `blindfold-migration/feedback.md` (only when adding doer annotations)

## Files you NEVER commit

- This file (`blindfold-migration/CLAUDE-doer.md`) - role-specific
- Root `CLAUDE.md` if modified - it is the project doc and pre-existing
- Any `.fleet-task*.md` - ephemeral prompt files

## Hard rules

- ONE phase per turn. Do not start Phase N+1 until the PM confirms
  Phase N is APPROVED.
- Never skip a task. Execute in order.
- After every commit, run unit tests. If they fail, fix before
  moving on.
- If you hit a blocker you cannot resolve: set the current task
  `status: blocked`, write notes explaining what is blocking and what
  you tried, then STOP. Do not work around it silently.
- ASCII only.
- No AI/Claude/Anthropic attribution anywhere.

## Secrets

This sprint does not require any external API keys. If a task ever
needs one, ask the PM to pre-load it via `credential_store_set` and
reference it as `{{secure.NAME}}` only inside `execute_command`-shaped
tool calls.
