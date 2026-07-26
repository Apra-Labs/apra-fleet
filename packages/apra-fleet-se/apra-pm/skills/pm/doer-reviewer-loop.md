# Doer-Reviewer Loop

The execute-phase loop for one track. Every dispatch is an inline subagent call (its
result returns in the same turn). Beads is the task store; the reviewer's verdict is
returned as structured output directly to the orchestrator. The orchestrator finds
ready work with `bd ready` and hands the doer explicit bead ids; the doer claims each
with `bd update --claim` and closes it with `bd close`. The
reviewer reads acceptance criteria with `bd show` and returns its verdict
(`verdict`/`notes`/`reopenIds`/`newTasks`) as structured output -- it never touches
beads. On CHANGES NEEDED the orchestrator reads that structured output and runs the
beads updates itself. There is no PLAN.md and no progress.json -- code is committed to
the branch; all task state lives in beads. (The plan loop that precedes this -- planner /
plan-reviewer -- is in `sprint.md`.)

## Pre-flight checks

### Before any dispatch

Verify the agent's worktree is on the correct branch with a clean working tree:

1. `git -C <worktree> status --porcelain` -- must be empty.
2. `git -C <worktree> branch --show-current` -- must match the track's branch.

Do not dispatch into a worktree on the wrong branch or with uncommitted changes.

### Before review dispatch (SHA matching)

Verify the reviewer sees the same state the doer pushed:

1. `git -C <reviewer-worktree> rev-parse HEAD` -- record the SHA.
2. Compare with the doer's last pushed HEAD on the track branch.
3. If SHA does not match: `git -C <reviewer-worktree> fetch origin &&
   git -C <reviewer-worktree> reset --hard origin/<branch>`, then re-verify.

Never dispatch a reviewer against stale code -- SHA mismatch means the review
covers the wrong diff.

## The loop (the Develop phase of one cycle)

```
Plan APPROVED, beads tasks created (each with acceptance criteria + model tier in
metadata). goal priority = the sprint's exit threshold.
  loop:
    1. Find ready tasks: bd ready (tasks with no open blockers, in the sprint-root subtree).
       If none AND bd list --status=open at the goal priority is empty AND the last
       reviewer verdict was APPROVED -> Develop phase done; exit to Test (or Harvest
       on the final cycle).
    2. Group ready tasks into model streaks (consecutive tasks sharing a model tier,
       in priority/dependency order). For each streak the doer, on dispatch:
         - reads each task with `bd show <id>` (description, acceptance, model tier),
         - claims it with `bd update <id> --claim`,
         - implements the work and commits,
         - closes it with `bd close <id>`.
       The doer works its streak in order and STOPS at the VERIFY checkpoint.
    3. On doer completion: assert the worktree is clean (`git status --porcelain`
       empty); a dirty tree means the doer left uncommitted work -- send it back to
       commit before any review. If a task is blocked, the doer leaves it open with a
       blocker note -- handle the blocker (see Safeguards). The doer has already
       closed the tasks it finished; the orchestrator does not touch beads here.
    4. Dispatch ONE reviewer (inline) over all tasks worked this iteration. It reads
       each task's acceptance criteria with `bd show <id>` and the diff. The reviewer
       runs standard-tier, escalated to premium-tier if any streak this iteration ran
       premium-tier. It returns its verdict as structured output only (see reviewer
       template) -- it never writes a file. Read the returned verdict:
         APPROVED       -> tasks stay closed. `reopenIds` and `newTasks` absent or
                           empty -- no beads action needed.
         CHANGES NEEDED -> the orchestrator parses `reopenIds` and `newTasks` from
                           the reviewer's structured output (see "Orchestrator reads
                           the reviewer's output" below) and runs the beads updates.
                           Dispatch the doer to fix.
    -> back to step 1.
```

**Exit condition.** The Develop phase exits when `bd ready` returns nothing, no open
task at the goal priority remains, **and** the last reviewer verdict was APPROVED --
a single APPROVED is sufficient because beads tracks discrete tasks, not a
convergence streak. Any CHANGES NEEDED reopens tasks, so the loop continues until
they are cleared and a clean APPROVED lands on an empty ready queue. Never advance to
Test or Harvest with open tasks at the goal priority.

The orchestrator does nothing between a doer finishing and a reviewer starting except
read state from beads + git and dispatch. Never pause for the user mid-loop.

## Model per task

The planner assigned each task a model **tier** -- cheap-tier for mechanical tasks,
standard-tier for standard implementation, premium-tier for hard design -- and wrote it
into the task's beads metadata (`--metadata '{"model": "<tier>"}'`). Read it with `bd show <id>`
at dispatch time and dispatch the doer on that tier. An iteration may span tiers
across its ready tasks; run one doer dispatch per model streak (a run of consecutive
tasks sharing a tier), in priority/dependency order. An iteration with three tier
groups becomes up to three doer dispatches, each on its own tier. The dispatch whose
streak reaches the VERIFY task carries through it.

The reviewer runs standard-tier, escalated to premium-tier whenever any streak in the
iteration ran premium-tier -- review must never be weaker than the work it judges. Cheap
bounded state checks (`bd ready` queries, feedback commits, log appends) run
cheap-tier.

## Dispatch and wait inline

Dispatch each subagent and wait for its result in the same turn -- the dispatch
returns the agent's result to you inline. Run the loop sequentially this way: one
dispatch, its result, the next. NEVER end your turn while a dispatched agent still
owes you a result; in a headless run nothing re-invokes you, so ending the turn
parks the sprint. With multiple tracks, dispatch one per active track and poll them
to completion within the turn -- track A's reviewer can run while track B's doer
works -- but keep the turn alive until you have collected their results.

After each agent returns, the orchestrator's FIRST action is to read state from beads
and git (`bd ready`, `bd list --status=open`, `bd show <id>`, the reviewer's returned
structured output, `git log <base>..<branch>`); those are the source of truth for what
was dispatched and where it landed.

## Commit identity

So the branch history shows who did what, each role commits under its OWN git
identity rather than the ambient one. Pass it inline on every commit -- do not rely
on global config:

```
git -c user.name='pm-<role>' -c user.email='<role>@pm.local' commit -m "<msg>"
```

Identities: `pm-planner`, `pm-plan-reviewer`, `pm-doer`,
`pm-reviewer`. The orchestrator's own git plumbing (requirements.md, design.md,
and the completion scaffolding drop) commits as `pm`. Each template below restates
its identity so the dispatched agent uses it.

## Per-role prompt templates

Everything the agent needs is in the prompt plus the committed files in its
worktree. Every prompt pins the worktree path. `<transport line>` is decided once
per repo (see `worktrees.md` Transport): remote present => "Push your commits." ;
local-only => "This is a local-only worktree -- commit every turn and skip pushing."

### planner

```
You are planning a track. Your worktree is <abs worktree path> on branch <branch>
(base <base>). cd there first; use absolute paths. Read requirements.md (and
design.md if present). Follow your planner instructions: explore, draft, front-load
foundations, self-critique, refine. Then write the plan into beads under sprint root
<sprint-id> -- do NOT write PLAN.md. For each task: bd create "<title>" -p <priority>
--parent <sprint-id> --assignee <track> --acceptance="<what must be true to be done>"
--metadata '{"model": "<tier>"}', where <tier> is cheap-tier for mechanical work, standard-tier
for standard implementation, premium-tier for hard design (pick from the tiers available
in this environment). Wire dependencies with bd dep add <task> <blocker>. Verify
with bd ready that leaf tasks (not features/sprint roots) are unblocked. <transport line>.
The worktree and branch already exist -- do not create or switch branches.
```

### plan-reviewer

```
You are reviewing a plan. Your worktree is <abs worktree path> on branch <branch>.
cd there; use absolute paths. Read requirements.md and design.md (if present), then
inspect the beads DAG under sprint root <sprint-id>: bd graph --compact <sprint-id>, bd ready,
and bd show <id> on each task to read its acceptance criteria and model-tier metadata.
Follow your plan-reviewer instructions: check coverage, task size, acceptance
criteria, dependency direction, and model-tier assignment. Classify each task with a
complexity bucket (S = 1 file/narrow scope, M = 2-3 files/moderate logic,
L = 3+ files/non-trivial design) and read its assigned model tier from its metadata.

Return your structured output ONLY -- do not write a file:
  - `verdict`: APPROVED or CHANGES_NEEDED (exact strings; the machine value is the
    underscore form from agents/schemas/plan-reviewer-output.json)
  - `notes`: specific findings with issue IDs and exact bd commands to fix any
    dependency direction problems
  - `taskAssignments`: one entry per task in JSON array form:
    [{"id":"<beads-id>","bucket":"S|M|L","model":"<tier: cheap|standard|premium>"},...]

You never write feedback.md or mutate beads -- the orchestrator reads your structured
output. <transport line>.
```

The orchestrator reads `taskAssignments` from the plan-reviewer's structured output
after APPROVED to run `computeSprintQuote` (see `cost.md`). The array shape must match
exactly: `[{ "id": "<beads task id>", "bucket": "S|M|L", "model": "<tier: cheap|standard|premium>" }]`.

### doer

```
You are executing tasks. Your worktree is <abs worktree path> on branch <branch>
(base <base>). cd there; use absolute paths. Work ONLY task(s) <task scope>, in
order. For each task: bd show <id> to read its description and acceptance criteria;
bd update <id> --claim to claim it; implement the work; run fast tests; commit as
identity pm-doer (git -c user.name='pm-doer' -c user.email='doer@pm.local' commit);
then bd close <id>. Never close a type=feature or type=bug issue -- only type=task.
If your scope reaches the VERIFY checkpoint, run it -- build, linter, and full test
suite -- then stop. Otherwise stop after the last task in <task scope>. If a task is
blocked, leave it open, add a blocker note (bd update <id> --notes="blocked: ..."),
and stop. <transport line>. Do not start anything beyond <task scope>. The worktree
and branch already exist -- do not create branches.
[If fixing review findings:] the reopened task(s) carry review notes (bd show <id>).
Address every finding, commit, bd close <id> again, then stop for re-review.
```

### reviewer

```
You are reviewing code. Your worktree is <abs worktree path> on branch <branch>
(base <base>). cd there; use absolute paths. Review ONLY the tasks worked this
iteration: <task ids>. Run bd show <id> on each to read its acceptance criteria, and
git diff <base>...<branch> to see the changes. Read requirements.md and design.md (if
present). Run the build, linter, and full test suite. Read the prior review history
(git log <base>..<branch>) so you account for how earlier findings were addressed.
Judge each task against its acceptance criteria.

Do NOT run any bd commands. Return your structured output ONLY -- do not write a file:

  verdict: "APPROVED" or "CHANGES_NEEDED"
  notes: <human-readable notes: one finding per task, referencing the task ID and what
  acceptance criterion was not met>
  reopenIds: ["<id1>", "<id2>"]
  newTasks: [{"title": "fix: <finding>", "description": "<detail>", "priority": "P2"}]
  (newTasks entries use {title, description, priority-as-string} -- the exact shape in
  agents/schemas/reviewer-output.json)

On APPROVED: reopenIds and newTasks are both empty arrays.
On CHANGES NEEDED: reopenIds lists every task that failed its acceptance criteria;
newTasks lists out-of-scope findings that need a new tracked task (may be []).
Both fields must be present and contain valid JSON arrays when verdict is CHANGES NEEDED.

You never write feedback.md or mutate beads -- the orchestrator reads your structured
output and applies the reopen/create transitions. <transport line>.
```

### Orchestrator reads the reviewer's output

After the reviewer returns, the orchestrator reads its structured output and runs all
beads updates itself -- the reviewer is a pure reader of beads:

1. Read the `verdict` field (`APPROVED` or `CHANGES_NEEDED`).
2. On CHANGES NEEDED:
   - Read `reopenIds`. For each id: `bd update <id> --status=open --notes="<relevant finding from notes>"`.
     Reopened tasks return to `bd ready` next iteration.
   - Read `newTasks`. For each entry:
     `bd create "<title>" -p <priority> --parent <sprint-id> --assignee <track> --description="<description>"`.
     Empty array `[]` means no new tasks to create.
3. On APPROVED: no beads action needed.

## Continuity between dispatches

Each dispatch is a fresh subagent run; continuity comes from the files it reads.
Two ways to continue:

- **Default: fresh dispatch.** Dispatch a new agent with the right tags (tags: ['doer'] / tags: ['reviewer']); it
  reconstructs context from beads (`bd ready`, `bd show <id>`) and `git log`. This is
  robust and the right choice across phase boundaries and tag switches -- the agents
  begin with a context-recovery `git log` and `bd` query.
- **Tight iteration: continue the same agent.** For a quick same-worktree, same-tag
  turn -- e.g. the doer addressing review findings it just produced context for --
  continue the SAME agent instance, which keeps its context. Use this within one
  worktree and one tag; switch tags with a fresh dispatch.

## Resume rules

Resume is data-driven from beads task state, not manually reasoned. A fresh dispatch
re-derives everything from `bd ready` / `bd show <id>` and `git log`; resume keeps an
agent's in-session context for a tight follow-up turn.

### Doer dispatches

| Condition | resume |
|-----------|--------|
| Next ready task is the same kind of work the agent just finished | `true` (continue session) |
| Next ready task is a context switch (different feature/area) | `false` (fresh) |
| After reviewer CHANGES NEEDED -> same doer fixes the reopened task it just built | `true` |
| Role switch (doer -> reviewer) | `false` |

### All dispatches

| Dispatch | resume |
|----------|--------|
| Initial plan generation | `false` |
| Plan revision (any feedback iteration) | `true` |
| Initial review dispatch | `false` |
| Re-review after CHANGES NEEDED + doer fixes | `true` |
| Tag switch (tags: ['doer'] -> tags: ['reviewer'], or vice versa) | `false` |
| After stop_prompt cancellation (fleet mode) | `false` -- session state unreliable after kill; start fresh |
| After session timed out mid-grant (fleet mode) | `true` -- fleet auto-recovers but member restarts without prior context |

A tag switch always requires sending the new context (context file or inline
prompt). Never resume across a tag switch.

## Safeguards

| Safeguard            | Trigger                          | Orchestrator action                                              | Limit            |
|----------------------|----------------------------------|------------------------------------------------------------------|------------------|
| Dispatch retry       | Agent errors or returns nothing  | Re-dispatch the same tag fresh; after 3 fails, pause + flag user | 3 per dispatch   |
| Doer-reviewer cycle  | Reviewer lists task in `reopenIds`; orchestrator reopens it | Doer fixes, re-review; if 3 cycles leave it open, pause + flag | 3 cycles/task    |
| Zero progress        | Two fresh dispatches, no commits | Escalate to a stronger model; still stuck after the strongest => flag | 2 per model  |
| Blocked task         | Doer left a task open with a `blocked:` note | Read the blocker note (bd show <id>); resolve if mechanical, else flag user | --        |

Escalate to the user only after a safeguard limit trips, on a genuine requirements
ambiguity, or on a risky/irreversible action. Otherwise keep the loop running.
