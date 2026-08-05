# Simple Sprint

A lightweight flow for small, single-session tasks. Use this when the work is
small enough that a full task harness (PLAN.md, progress.json) is unnecessary
overhead.

## When to use

- 1-3 tasks, completable in a single session
- No complex phasing or cross-phase dependencies
- Low risk, well-understood scope

Use the full sprint lifecycle (sprint.md) for anything larger. If the work turns
out bigger than expected, promote to a full sprint.

## Flow

1. Write a concise requirements.md on the branch and commit.
2. Create a small beads epic + a task per item.
3. Dispatch the doer (model sized to the work) with requirements inline or by
   reference. The doer completes work, commits, and pushes.
4. Dispatch the reviewer (strongest model, fresh session). The reviewer reads
   deliverables + diff, outputs verdict: APPROVED or CHANGES NEEDED.
5. On APPROVED: dispatch the KB Agent (see kb-agent.md) -- pass the reviewer
   verdict, feedback.md content, doer session summary, and git diff stat. Read
   the KB Agent report. Then close the beads tasks and the delivered source
   issues, clean sprint scaffolding from the PR (see sprint.md Completion step 3
   -- git rm sprint-created tracking files, restore any the repo already shipped,
   then verify the net diff is product only), commit as pm, raise the PR (or
   report the diff for local-only), remove the worktree.
6. On CHANGES NEEDED: dispatch the KB Agent (see kb-agent.md) with the verdict
   and feedback before re-dispatching the doer. Then send feedback to doer,
   re-dispatch, repeat from step 3.
7. Create low-priority beads tasks for any unresolved findings or deferred items.
8. STOP: do not merge. Surface the PR URL and CI status to the user and await
   explicit instruction.

## Rules

- Still requires pre-flight checks (see doer-reviewer-loop.md Pre-flight checks).
- In fleet mode: still requires permissions and doer/reviewer pairing (see
  fleet-addendum.md).
- No progress.json or PLAN.md -- beads + git carry the state.
- Branch naming: choose a name that makes the purpose clear --
  feat/<description>, fix/<description>, chore/<description>.

## Recovery after orchestrator restart

No progress.json -- recovery relies on git history and beads.

1. `bd list --tree <epic-id>` -- what is open, in progress, closed.
2. Per worktree: `git log --oneline -5` -- any commits since last known state?
3. `git status` -- uncommitted changes?

Then act:

- **Work committed, next step clear** -> dispatch reviewer or continue doer.
- **At review checkpoint** -> dispatch reviewer (fresh session).
- **Uncommitted changes of unknown origin** -> escalate to user: "commit and
  resume, or discard?"
- **No progress** -> re-dispatch from scratch.
