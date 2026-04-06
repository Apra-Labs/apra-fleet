# Simple Sprint

A simple sprint is a short, focused task that a single member can complete in one or a few sessions. Use this when the work is small enough that a full task harness (PLAN.md, progress.json) is unnecessary overhead.

## When to use

- 1–3 tasks, completable in a single session
- No complex phasing or cross-phase dependencies
- Low risk, well-understood scope

Use the full sprint lifecycle (single-pair-sprint.md) for anything larger.

## Flow

**Branch naming:** choose a name that makes the purpose immediately clear — `feat/<description>`, `bug_fix/<short_description>`, `chore/<description>`, etc. PM records this as `{{branch}}` in the agent context file before dispatch.

1. Write `<project>/requirements.md` — keep it concise but complete
2. Dispatch doer via ad-hoc `execute_prompt` — include requirements inline or reference the file
3. Doer completes work, commits, and pushes
4. PM dispatches reviewer (fresh session, `resume=false`) — send requirements + diff context
5. Reviewer outputs verdict: APPROVED or CHANGES NEEDED
6. On APPROVED: update `<project>/backlog.md` with any unresolved findings or deferred items, then cleanup and raise PR — see cleanup.md
7. On CHANGES NEEDED: send feedback to doer, re-dispatch, repeat from step 3

## Rules

- Still requires permissions, pre-flight checks, and doer/reviewer pairing (see doer-reviewer.md)
- No progress.json or PLAN.md — status is tracked in `<project>/status.md` by PM
- Agent context file is still required for doer and reviewer (see context-file.md)

## Recovery After PM Restart

No progress.json — recovery relies on git history and status.md.

1. `execute_command → git log --oneline -5` on member — any commits since last known state?
2. `execute_command → git status` — uncommitted changes?
3. Compare against `<project>/status.md` — what did PM last know?

- **Work committed, next step clear** → resume doer with `resume=true` or dispatch reviewer
- **At review checkpoint** → dispatch reviewer with `resume=false`
- **Uncommitted changes of unknown origin** → escalate to user: "commit and resume, or discard?"
- **No progress** → re-dispatch from scratch
