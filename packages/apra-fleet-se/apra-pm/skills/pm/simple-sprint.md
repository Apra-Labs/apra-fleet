# Simple Sprint

A lightweight flow for small, single-session tasks. Use this when the work is
small enough that the full plan/plan-review loop is unnecessary overhead. State
still lives in beads + git -- there is no PLAN.md or progress.json in any sprint.

## When to use

- 1-3 tasks, completable in a single session
- No complex phasing or cross-phase dependencies
- Low risk, well-understood scope

Use the full sprint lifecycle (sprint.md) for anything larger. If the work turns
out bigger than expected, promote to a full sprint.

## Flow

1. Write a concise requirements.md on the branch and commit.
2. Create a small beads sprint root + a task per item, each with `--acceptance="..."` and a
   `--metadata '{"model": "<tier>"}'` tag.
3. Dispatch the doer (tier sized to the work). The doer claims each task
   (`bd update <id> --claim`), implements, commits, pushes, and closes it
   (`bd close <id>`).
4. Dispatch the reviewer (premium-tier, fresh session). It reads each task's acceptance
   criteria (`bd show <id>`) + the diff and outputs a verdict: APPROVED or
   CHANGES NEEDED.
5. On APPROVED: close the delivered source issues, clean sprint scaffolding from the
   PR (see sprint.md Completion step 7 -- git rm sprint-created narrative files,
   restore any the repo already shipped, then verify the net diff is product only),
   commit as pm, raise the PR (or report the diff for local-only), remove the
   worktree.
6. On CHANGES NEEDED: the orchestrator reads `reopenIds` and `newTasks` from the
   reviewer's structured output (the reviewer never writes feedback.md); runs
   `bd update <id> --status=open` for each reopen ID and `bd create` for each new
   task; then re-dispatches the doer from step 3.
7. Create low-priority beads tasks for any unresolved findings or deferred items.
8. STOP: do not merge. Surface the PR URL and CI status to the user and await
   explicit instruction.

## Rules

- Still requires pre-flight checks (see doer-reviewer-loop.md Pre-flight checks).
- In fleet mode: still requires permissions and doer/reviewer pairing (see
  fleet-addendum.md).
- Beads + git carry the state -- as in every sprint, no progress.json or PLAN.md.
- Branch naming: choose a name that makes the purpose clear --
  feat/<description>, fix/<description>, chore/<description>.

## Recovery after orchestrator restart

Recovery relies on beads and git history.

1. `bd list --tree <sprint-id>` (and `bd ready`) -- what is open, in progress, closed.
2. Per worktree: `git log --oneline -5` -- any commits since last known state?
3. `git status` -- uncommitted changes?

Then act:

- **Task in_progress with no matching commits** -> reset it
  (`bd update <id> --status=open`) and re-dispatch the doer.
- **Work committed, next step clear** -> dispatch reviewer or continue doer.
- **At review checkpoint** -> dispatch reviewer (fresh session).
- **Uncommitted changes of unknown origin** -> escalate to user: "commit and
  resume, or discard?"
- **No progress** -> re-dispatch from scratch.
