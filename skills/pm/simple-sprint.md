# Simple Sprint

A simple sprint is a short, focused task that a single member can complete in one or more sessions. Use this when the work is small and a full task harness is unnecessary.

## When to use

- 1–3 tasks, completable in a single session.
- No complex phasing or cross-phase dependencies.
- Low risk and well-understood scope.

Use the full sprint lifecycle (single-pair-sprint.md) for larger tasks.

## Flow

**Branch naming:** Choose a name that makes the purpose clear, such as `feat/<description>`, `bug_fix/<short_description>`, or `chore/<description>`. The PM records this as `{{branch}}` in the agent context file before dispatch.

1. Create `<project>/requirements.md`; ensure it is concise and complete.
2. Dispatch the doer via ad-hoc `execute_prompt`; include requirements inline or reference the file.
3. The doer completes the work, commits, and pushes.
4. The PM dispatches the reviewer in a fresh session (`resume=false`); send requirements and diff context.
5. The reviewer outputs a verdict: APPROVED or CHANGES NEEDED.
6. On approval: Update `<project>/backlog.md` with unresolved findings or deferred items. Perform cleanup and raise the PR; see cleanup.md.
7. On CHANGES NEEDED: Send feedback to the doer, re-dispatch, and repeat from step 3.

## Rules

- Still requires permissions, pre-flight checks, and doer/reviewer pairing; see doer-reviewer.md.
- No progress.json or PLAN.md; status is tracked in `<project>/status.md` by the PM.
- An agent context file is still required for the doer and reviewer; see context-file.md.

## Recovery After PM Restart

Without progress.json, recovery relies on git history and status.md.

1. `execute_command → git log --oneline -5` on the member; check for commits since the last known state.
2. `execute_command → git status`; check for uncommitted changes.
3. Compare against `<project>/status.md`; identify what the PM last knew.

- **Work committed and next step clear** → Resume the doer with `resume=true` or dispatch the reviewer.
- **At review checkpoint** → Dispatch the reviewer with `resume=false`.
- **Uncommitted changes of unknown origin** → Escalate to the user: "Commit and resume, or discard?"
- **No progress** → Re-dispatch from scratch.
