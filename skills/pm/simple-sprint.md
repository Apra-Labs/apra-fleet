# Simple Sprint

Short, focused task. Single member, 1 session. No `PLAN.md` or `progress.json`.

## Usage

- 1–3 tasks.
- No complex phasing/dependencies.
- Low risk, clear scope.

Larger? Use `single-pair-sprint.md`.

## Flow

**Branch naming**: clear purpose (`feat/<desc>`). PM records as `{{branch}}` in context file.

1. Write concise `<project>/requirements.md`.
2. Dispatch doer via `execute_prompt`.
3. Doer completes/commits/pushes.
4. Dispatch reviewer (`resume=false`). Send requirements + diff.
5. Verdict: APPROVED or CHANGES NEEDED.
6. APPROVED: update `backlog.md`, cleanup, raise PR (`cleanup.md`).
7. CHANGES NEEDED: send feedback to doer, re-dispatch.

## Rules

- Still requires permissions, pre-flights, pairing (`doer-reviewer.md`).
- No `progress.json`. Status in `<project>/status.md`.
- Agent context file is required (`context-file.md`).

## Recovery

Relies on git + `status.md`.

1. `git log` on member.
2. `git status`.
3. Compare with `status.md`.

- **Committed, clear next step**: resume doer (`resume=true`) or dispatch reviewer.
- **Review checkpoint**: dispatch reviewer (`resume=false`).
- **Unknown uncommitted changes**: escalate to user.
- **No progress**: re-dispatch.
