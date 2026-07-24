# Beads -- the single source of truth

beads (`bd`) is pm's task store and message bus. It holds what is in flight, what
is blocked, what was deferred, what each task must satisfy, and what each review
found. There is no PLAN.md and no progress.json: the planner writes tasks into
beads, the orchestrator reads `bd ready` and hands the doer explicit bead ids to
claim/close, and the reviewer reads each task's acceptance criteria with `bd show`. git holds only the code, the branch
history, and the requirements/design narrative; **beads holds all task state.**

## One project, one DB

An orchestrator manages one project, so there is one beads DB for that project and
one **sprint root** per sprint. The DB is a local `.beads/` at the **base checkout** (the
orchestrator's repo root) -- not inside any track worktree. The orchestrator runs
every `bd` command from there. Doers run `bd show` / `bd update --claim` /
`bd close` against that same DB; reviewers run `bd show` only -- they never write to
beads. On CHANGES NEEDED the reviewer returns `reopenIds` and `newTasks` as structured
output (it never writes feedback.md); the orchestrator reads that output and runs the
beads updates.
The DB persists on disk across sessions, so it survives without being committed.
Committing it is optional and only shares issue history across machines; if you do,
commit it on the base or integration branch -- keeping it off the track feature
branches so parallel tracks share one DB. Tasks reference their track via assignee
or label.

## Lifecycle hooks (not optional)

`bd` is called at these points. The planner, doer, and reviewer run their own `bd`
commands; the orchestrator runs setup, completion, and recovery queries.

**Sprint setup** (orchestrator) -- create the sprint root, reusing an existing one if present:
```
bd search "sprint: <name>" --status all   # reuse the id if found
bd create "sprint: <name>" -p 1            # else create -> <sprint-id>
```

**Plan phase** (planner) -- one task per plan item, each carrying its acceptance
criteria, assigned model tier, priority, and track; dependencies wired. The planner
writes these directly into beads -- there is no PLAN.md:
```
bd create "T1.1: <title>" -p 1 --parent <sprint-id> --assignee <track> \
  --acceptance="<what must be true for this task to be done>" \
  --metadata '{"model": "standard-tier"}'                          # -> task-id
bd create "T1.2: <title>" -p 2 --parent <sprint-id> --assignee <track> \
  --acceptance="..." --metadata '{"model": "cheap-tier"}'
bd dep add <T1.2-id> <T1.1-id>             # T1.2 blocked until T1.1 done
```
The acceptance criteria are the reviewer's contract; the model tier in metadata is the
doer's dispatch tier. Both live on the task -- nothing is written to a plan file.

**Doer dispatch** (doer) -- read the task, claim it, implement, close it:
```
bd show <task-id>                          # read description + acceptance + model tier metadata
bd update <task-id> --claim                # claim (open -> in_progress, assigns self)
bd close <task-id>                         # when the work is complete
```
The ORCHESTRATOR finds ready work (`bd ready` -- tasks with no open blockers, scoped to
the sprint root) and hands the doer an explicit list of bead ids in the dispatch prompt.
The doer works exactly that list and never runs bare `bd ready` to discover work itself
(it would see other sprints' concurrent tasks with no way to tell which are its own --
see `agents/doer.md` Step 1). Never steal a task already `in_progress`.

**Reviewer returns CHANGES NEEDED** (orchestrator, after reading the reviewer's
structured output) -- the reviewer returns its verdict, human notes, and the
machine-readable `reopenIds` / `newTasks` arrays as structured output (see
`doer-reviewer-loop.md` reviewer template); it never writes feedback.md. The
orchestrator reads those fields and runs:
```
# for each id in reopenIds:
bd update <task-id> --status=open --notes="review: <finding from notes section>"

# for each entry in newTasks ({title, description, priority}):
bd create "<title>" -p <priority> --parent <sprint-id> --assignee <track> --description="<description>"
```
Reopened tasks return to `bd ready` as work for the next iteration. On APPROVED
neither command is needed -- tasks stay closed.

**At completion** -- close the sprint root, close the delivered source issues, persist the
state, link the PR:
```
bd close <sprint-id> <source-issue-id> [<source-issue-id> ...]
bd export -o <track-worktree>/.beads/issues.jsonl   # refresh the tracked file from the db
bd note <sprint-id> "PR: <url>"
```
The source issues are the ready backlog items the sprint's requirement was drawn
from. Closing the sprint root alone leaves them open, so the backlog never reflects the
delivered work -- close them here too. With a db backend (dolt) `bd close` does NOT
update `issues.jsonl`; `bd export -o <file>` rewrites it (a bare `bd export` prints to
stdout). Commit the refreshed `.beads/issues.jsonl` on the branch so the closures are
durable and visible in the PR.

## Findings are never lost

A review finding against the reviewed task goes into `reopenIds` in the reviewer's
structured output; the orchestrator runs `bd update --status=open` so the doer picks it
up next loop. A finding outside the reviewed scope goes into `newTasks`; the
orchestrator creates it.
MEDIUM/LOW findings and any scope deferred mid-sprint become low-priority backlog
tasks. Every finding either gets fixed (`bd close`) or is explicitly carried as
backlog -- it is never dropped silently.

## Backlog

Deferred work lives as low-priority tasks under the sprint root, with enough detail to act
on later without re-investigation:
```
bd create "<headline>" -p 3 --parent <sprint-id> --description "Impact / Source / Detail / Cost of not doing it"
```
Manage it:
```
bd list --status open --pretty     # review
bd update <id> -p 1                 # promote
bd close <id> --reason "<why>"      # retire as stale/superseded
bd dep add <id> <blocker-id>        # gate behind another item
```

## Status and recovery via beads

State re-derives entirely from beads + git -- no PLAN.md, no progress.json. To see
position at any time:
```
bd list --status=open                  # work still to do
bd list --status=in_progress           # tasks claimed by an interrupted dispatch
bd ready                               # everything unblocked right now, across tracks
bd list --tree <sprint-id>               # full sprint tree: tasks, status, assignee
bd show <task-id>                      # full context: description, acceptance, model tier metadata, notes
```
beads reflects claim/close actions, not on-disk completion -- always confirm against
`git log <base>..<branch>` and `git status` before acting. A task marked
`in_progress` with no matching commits is an orphaned claim from a crashed dispatch;
reset it with `bd update <id> --status=open`. See `sprint.md` Recovery.

## Rules

- **Check before create** (sprint root and task) -- `bd search ... --status all`; reuse if
  found, never duplicate.
- **Check before claim** -- dispatch only if the task is `open`.
- `bd close` is idempotent and safe to re-run.
- **Never re-run `bd init`** on a repo that already has `.beads/` -- it pulls from remote, recreates the Dolt database, and overwrites local issue state. If the database is missing, prefer `bd export` + restore over `bd init`.
- Premature close -> `bd reopen <id>`.
- Never use `bd edit` -- it opens an interactive editor and blocks. Use
  `bd update --status/--assignee/--notes` inline.
