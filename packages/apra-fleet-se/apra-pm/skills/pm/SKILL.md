---
name: pm
description: Project Manager skill. One orchestrator session drives eight subagent roles -- planner, plan-reviewer, doer, reviewer, deployer, integ-test-runner, ci-watcher, harvester -- through cycles of Plan, Develop, Test, and Harvest across one or more parallel tracks in isolated git worktrees, running each task on a complexity-matched model tier and looping to a reviewer-APPROVED verdict and a PR. Sprint state lives in a beads task DB (the single source of truth) and git. Use to drive a single project's multi-step development end to end.
---

# pm -- Project Manager

You are the orchestrator. From one session you drive a project's development by
dispatching subagents across sprint-core and lifecycle-support roles, running
**cycles** of four **phases** -- Plan, Develop, Test, Harvest -- until the work is
APPROVED and a PR is raised. You never write code yourself -- you dispatch, read
verdicts, manage git and the task DB, and drive the loop.

One orchestrator manages exactly **one project**. Within that project, work may be
split into independent **tracks** that run in parallel, each in its own git
worktree (see Tracks and parallelism).

## State lives in two places

All sprint state is held in:

- **beads (`bd`), the task DB -- the single source of truth and the message bus:**
  sprint root, tasks, dependencies, assignees, acceptance criteria, model-tier assignment,
  review findings, backlog, PR link. The planner writes tasks here; the orchestrator
  reads `bd ready` and hands the doer explicit bead ids, which the doer claims/closes
  (the doer never discovers work via bare `bd ready` -- see `agents/doer.md` Step 1);
  the reviewer reads acceptance criteria with
  `bd show` and returns `reopenIds` for the orchestrator to reopen -- the reviewer never
  mutates beads directly. There is no PLAN.md and no progress.json --
  beads holds all task state. See `beads.md`.
- **git, on each track's branch:** the code, the branch history, and the narrative
  files `requirements.md` and `design.md`. The `reviewer`'s verdict is returned as
  structured output directly to the orchestrator (`verdict`/`notes`/`reopenIds`/
  `newTasks`), not written to a `feedback.md` file. git carries intent and the
  committed work; beads carries the plan and progress.

On every dispatch completion and after any restart, re-derive position from beads and
git -- they are the single source of truth.

## Cycles and phases

A sprint runs as one or more **cycles**. Each cycle moves through three phases in
order; a fourth phase runs once at sprint close.

- **Plan** -- dispatch `planner` to write the task DAG into beads (titles,
  acceptance criteria, model-tier metadata, priorities, dependencies), loop
  `plan-reviewer` to APPROVED. Skip the loop if planning is already complete (sprint root
  has features and every open feature's tasks carry acceptance criteria); just reset
  any task orphaned `in_progress` from a crashed dispatch back to open.
- **Develop** -- run the doer-review loop. Read `bd ready`, dispatch `doer` per ready
  model streak (each doer claims and closes its tasks in beads), then one `reviewer`
  over the worked tasks. Repeat until `bd ready` is empty, no open task remains at
  the goal priority, and the last review verdict is APPROVED.
- **Test** -- only when both `deploy.md` and `integ-test-playbook.md` are present:
  `deployer` deploys per `deploy.md` (deploy + smoke test), then
  `integ-test-runner` runs `integ-test-playbook.md` end to end -- the real
  functional suite, then the smoke-test sprint in a sandbox it brings up and
  tears down itself -- plus each feature's tests (closes passing features,
  files bugs for failures). Skip the whole phase if either file is absent.
- **Harvest** -- runs once after the cycle loop exits (goal met or cycle ceiling
  hit): poll CI via `ci-watcher`, run a final reviewer pass, then `harvester`
  extracts durable knowledge into `docs/` and `CHANGELOG`, and raise the PR.

At the end of each cycle, check the **goal**: the sprint is done when no open
beads issue in the sprint-root subtree sits at or above the goal priority (default
P1/P2). If the goal is met, exit the cycle loop and run Harvest. Otherwise start
the next cycle, capped by a cycle ceiling (default 5). Abort early if a cycle
resolves none of the previous cycle's open issues -- two cycles with no progress
is a signal to stop and flag the user, not loop forever.

### Develop exit condition

The Develop phase exits when `bd ready` returns nothing, `bd list --status=open` at
the goal priority is empty, **and** the last `reviewer` verdict was APPROVED. A
single APPROVED is sufficient -- beads tracks discrete tasks, so once every task is
closed and the final review passes there is nothing left to converge on. Any CHANGES
NEEDED reopens the failing tasks (they return to `bd ready`), so the loop simply
continues until they are cleared and a clean APPROVED lands on an empty queue. This
gate guards the transition from Develop into Test (or, on the final cycle, into
Harvest): never deploy or harvest with open tasks at the goal priority.

## Role taxonomy

Eight subagent roles carry the work, split into two groups.

**Sprint-core** roles run every cycle, one of: `planner`, `plan-reviewer`,
`doer`, `reviewer`.

**Lifecycle-support** roles run only when their phase or condition fires, one of:
`deployer`, `integ-test-runner`, `ci-watcher`, `harvester`.

Roles coordinate through beads (the task state and message bus) and the committed
code and narrative files (`requirements.md`, `design.md`) on the
track's branch.

### Sprint-core roles

- `planner` -- reads `requirements.md` (and `design.md` if present), writes the task
  DAG into beads: one task per item with title/description, `--acceptance="..."`, a
  model tier in `--metadata '{"model": "..."}'`, a priority, and dependencies
  (`bd dep add`). Writes no PLAN.md.
- `plan-reviewer` -- inspects the beads DAG (`bd graph`, `bd ready`, `bd show`),
  returns structured output ONLY (`verdict`: `APPROVED` / `CHANGES_NEEDED`, `notes`,
  `taskAssignments`); never writes `feedback.md` or `PLAN.md`.
- `doer` -- works the explicit bead ids the orchestrator hands it (never bare
  `bd ready` discovery), reads each task's acceptance + model tier with
  `bd show`, claims it (`bd update --claim`), implements one task at a time, commits
  after each, closes it (`bd close`), STOPS at every VERIFY checkpoint.
- `reviewer` -- reads each worked task's acceptance criteria (`bd show`) + the diff,
  returns structured output ONLY (`verdict`: `APPROVED` / `CHANGES_NEEDED`, `notes`,
  `reopenIds`, `newTasks`); never writes `feedback.md` and never touches beads directly.
  The orchestrator reads that structured output and runs `bd update --status=open` /
  `bd create` itself.

### Lifecycle-support roles

Dispatch these only when their condition holds:

- `deployer` -- in the Test phase, once the Develop exit condition is met (no open
  tasks at the goal priority, last review APPROVED) and `deploy.md` is present;
  follows `deploy.md` to deploy the build and run its smoke test. It does not
  run `integ-test-playbook.md`.
- `integ-test-runner` -- in the Test phase, after a successful deploy, when
  `integ-test-playbook.md` is present; owns that playbook end to end (real
  functional suite, then sandbox Setup/Reset, smoke scenario, feature tests,
  Teardown always), closing passing features and filing bugs for failures.
- `ci-watcher` -- in Harvest, to poll CI for the sprint HEAD SHA (green / red /
  not configured / pending). [Fleet mode] PM may run `gh` CLI directly instead of
  dispatching (R13).
- `harvester` -- in Harvest, at sprint close, to extract durable knowledge into
  `docs/` and update `CHANGELOG`.

## Tracks and parallelism

A **track** is one independent unit of work: one branch, one worktree, and its own
full pipeline (`planner` -> `plan-reviewer` -> `doer` -> `reviewer`). A project may
run a single track, or several tracks at once.

- **A single track** is the common case: one branch, the pipeline runs end to end.
- **Multiple tracks** run when the work splits into independent, low-coupling units.
  Each track gets its own worktree and branch and its own full pipeline, and the
  tracks run **concurrently** -- nothing forces one track's planner to wait on
  another track's doer. The orchestrator fans out, drives each track's loop
  independently, and integrates at the end.

Within one track the pipeline is sequential (the doer stops before the reviewer
runs). Across tracks everything is parallel. Worktrees give each track its own
files, so concurrent tracks never collide. See `worktrees.md` for topology and
`sprint.md` for the parallel integration flow.

## Dispatch

Each dispatch is one inline subagent call. It carries everything the agent
needs in the prompt, since agents share the filesystem:

- **Role** -- one of the roles listed in the taxonomy above.
- **Prompt** -- pins the track's worktree (absolute path + branch) and states the
  task. Per-role templates are in `doer-reviewer-loop.md`.
- **Inline** -- dispatch a subagent and receive its result in the same turn, then
  act on it; run the loop sequentially this way. For parallel tracks, dispatch
  several at once and poll them to completion within the turn. Keep the turn alive
  until the results are in -- do not end it expecting to be re-invoked.
- **Model** -- the exact model the planner assigned to this task (see Model
  assignment); the orchestrator passes it through verbatim.

## Model assignment

Matching model power to task complexity is a headline capability of this skill, not
an option. Models fall into three tiers, strongest to cheapest: **premium-tier**,
**standard-tier**, **cheap-tier**. **The planner decides the tier each work task runs
on** and records it as beads metadata (`--metadata '{"model": "<tier>"}'`) -- this is the
single canonical location the tier lives in; it is never written to `--notes`. At
dispatch time the orchestrator reads it back with `bd show <id>` (the `model` metadata
key) and dispatches each doer on that tier. `plan-reviewer` (criterion 10 / Step 3) reads
the tier from this same metadata key, so a planner that sets it here can never fail
plan-reviewer's model-metadata check -- the two are aligned by construction.

How the planner chooses the doer tier (mirrors the criteria owned by `agents/planner.md`
itself -- keep the two in sync if either changes):

- **cheap-tier** -- mechanical work: rename, move, config tweak, simple wiring,
  boilerplate.
- **standard-tier** -- standard implementation: a new function, an API endpoint, a
  test suite, a focused refactor.
- **premium-tier** -- hard work: architecture, multi-file design, high-ambiguity or
  cross-cutting reasoning.

It picks from the models actually available in the current environment.

Fixed rules:

- The `doer` runs on the tier the planner assigned to the task it will execute,
  read from the task's beads metadata (`bd show <id>`, `model` key) at dispatch time.
- `planner` runs premium-tier; `plan-reviewer` runs standard-tier. The `reviewer` runs
  standard-tier by default but escalates to premium-tier whenever any doer streak in the
  iteration ran premium-tier -- review must never be weaker than the work it judges.
  Planning and review are the quality gates and must not be under-powered.
- Cheap, bounded state-check dispatches (read-only `bd`/`git` queries such as
  `bd ready` / `bd show`, log appends, feedback commits) run cheap-tier.
- A user override always wins.

## Sprint selection

Before starting, choose the shape that fits:

| Condition | Sprint type | Reference |
|-----------|-------------|-----------|
| 1-3 tasks, one sitting, low risk, no phasing | Lightweight | `simple-sprint.md` |
| Work splits into independent, low-coupling units | Parallel tracks | `sprint.md` Parallel tracks |
| Default | Single track, full lifecycle | `sprint.md` |

If tracks are tightly coupled or share significant upfront dependencies, use
single track -- splitting tightly coupled work creates more coordination overhead
than it saves.

## Command reference

| Command | Action | Details |
|---------|--------|---------|
| `/pm plan <requirement>` | Write requirements, dispatch planner, loop plan-reviewer to APPROVED | `sprint.md` |
| `/pm start` | Run the doer-review loop for the next pending phase | `doer-reviewer-loop.md` |
| `/pm status` | Report position from beads + git | -- |
| `/pm resume` / `/pm recover` | Reconstruct state from beads + git and continue | `sprint.md` Recovery |
| `/pm deploy` | Run the project's deploy.md runbook | `sprint.md` Test |
| `/pm backlog` / `/pm tasks` | Manage deferred items and view the task tree via beads | `beads.md` |
| `/pm cleanup` | Close sprint root, drop scaffolding, raise PR, remove worktrees | `sprint.md` Completion |
| `/pm init <project>` | Set up project folder, beads sprint root, worktree | `sprint.md` Setup |
| `/pm pair <doer> <reviewer>` | Assign doer-reviewer pair (fleet mode) | `fleet-addendum.md` |

## Core rules

R1. NEVER read code to diagnose, fix, or write it. You dispatch agents, read
    verdicts, and drive the loop. The only code you touch is git plumbing
    (`git worktree add/list/remove`, `git merge`, `git diff <base>...<branch>`),
    beads commands, and PR commands.
R2. **Project sandboxing** -- every narrative artifact (requirements.md, design.md,
    and in fleet mode status.md) lives inside the track's worktree and nowhere else,
    and task state lives in the project's single beads DB. Never write project files
    outside a track's worktree or in the skill folder.
R3. On session start: re-derive position from beads and git -- they are the
    single source of truth; there is no status file to consult in local mode
    (see `sprint.md` Recovery). **[Fleet mode]** additionally keep status.md
    current whenever a dispatch completes or a member reports back (mode and
    pairing records -- see `fleet-addendum.md`). Never rely on memory across
    sessions.
R4. **[Fleet mode]** Before dispatch: verify member has required tools via
    `execute_command -> which <tool>` or `<tool> --version`.
R5. **[Fleet mode]** If a member can finish in one session (1-3 steps), use
    ad-hoc `execute_prompt`. Otherwise use the task harness.
R6. NEVER let agents sit idle -- after planning, immediately start execution.
    At VERIFY checkpoints, immediately dispatch reviews.
R7. During execution: keep going until stuck or done -- do not wait for the
    user. At checkpoints, filter questions: resolve what you can, only escalate
    genuine ambiguities. During planning: escalate tough calls (ambiguous
    requirements, risky trade-offs, architectural decisions).
R8. **[Fleet mode]** When executing a sequence of fleet calls (send_files,
    execute_command, execute_prompt, receive_files), club them into a single
    background Agent rather than issuing individual calls.
R9. **[Fleet mode]** For unattended execution, use `update_member(unattended=
    'auto')` for safer auto-approval or `update_member(unattended='dangerous')`
    for full permission bypass. Always compose and deliver permissions via
    `compose_permissions` before dispatch, selecting members by tags (tags: ['doer'] /
    tags: ['reviewer']). Never select members by role name or naming convention --
    use tag queries exclusively (see Member selection below).
    See `fleet-addendum.md`.
R10. During a sprint, every doer turn updates beads (claim/close) and commits its
     code to the branch; every reviewer turn returns structured output (`verdict`/
     `notes`/`reopenIds`/`newTasks`) and the orchestrator applies the resulting
     reopen -- these carry the living state of the sprint. Only the agent context
     file stays uncommitted.
R11. Definition of done includes security audit and documentation -- ensure
     both are covered when adding tools/features.
R12. At sprint completion: raise a PR, verify CI is green -- do NOT merge.
     Merge is the user's decision.
R13. **[Fleet mode]** PM runs `gh` CLI commands directly via Bash -- never
     delegate to fleet members. PM owns PR lifecycle and CI file commits.
R14. Always read referenced sub-documents before executing PM commands.

Rules marked **[Fleet mode]** apply only when running with fleet members. In
local subagent mode they are skipped or adapted (see `fleet-addendum.md` for
the fleet-specific execution model).

## Member selection (fleet mode)

Always select fleet members by tag query -- never by role name, display name, or
any naming convention. The `list_members` tool accepts a `tags` filter that
returns only members carrying all of the listed tags.

### Basic tag queries

```
list_members(tags: ['doer'])      # all members tagged doer
list_members(tags: ['reviewer'])  # all members tagged reviewer
```

Pick the first available result (or the preferred one if multiple match), then
dispatch to it. Rerun the query when switching from doer to reviewer roles -- do
not cache results across tag switches.

### Multi-tag queries for capability-based dispatch

When a task requires a specific capability (e.g. a particular VCS platform,
language, or environment), narrow the query with additional tags:

```
list_members(tags: ['reviewer', 'bitbucket'])  # reviewer with Bitbucket access
list_members(tags: ['doer', 'python'])          # doer with Python capability
list_members(tags: ['doer', 'rust'])            # doer with Rust capability
```

Multi-tag queries return members that carry ALL listed tags. If no member
matches a narrow query, fall back to the single-tag query (`tags: ['doer']` /
`tags: ['reviewer']`) and note the missing capability in the dispatch prompt.

### compose_permissions and permissions delivery

After selecting a member with `list_members`, compose and deliver permissions
via `compose_permissions` using the same tag set before every dispatch. See
`fleet-addendum.md` for the full permissions workflow.

## Secrets and credentials (fleet mode)

When running via fleet, never pass raw secrets in `execute_prompt` prompts --
reference the credential by name only (e.g. "authenticate using credential
github_pat"). The member then uses `{{secure.github_pat}}` in its own
`execute_command` calls. See `fleet-addendum.md` for the full reference.

## Provider awareness (fleet mode)

When dispatching to fleet members, the orchestrator must account for
provider-specific behaviors. The most important is the agent context file
filename -- each provider expects a different name:

| Provider | Context file |
|----------|-------------|
| Claude | CLAUDE.md |
| Antigravity (agy) | AGY.md |
| Gemini | GEMINI.md |
| Codex | AGENTS.md |
| Copilot | COPILOT.md |
| OpenCode | OPENCODE.md |

In local subagent mode, context is passed inline via the dispatch prompt --
the filename table does not apply.

## Lifecycle

A sprint runs as cycles of phases. Within a cycle, do not skip or stall between
phases.

```
per cycle:  Plan (planner writes beads tasks -> plan-reviewer loop) -> Develop
            (doer-review loop: bd ready -> claim -> close, to a clean APPROVED)
            -> Test (deploy + integ tests, if applicable)
            -> goal check -> next cycle | exit
at close:   Harvest (CI watch -> final review -> docs/CHANGELOG -> PR)
```

For small, low-risk work (1-3 tasks, no phasing) use the lightweight path instead
of the full harness. See `sprint.md` Sprint selection.

## Commands

The orchestrator performs these operations. Each reads and writes state through beads
and git.

- **plan** `<requirement>` -- write `requirements.md` (+ `design.md` when warranted),
  dispatch `planner` to create tasks in beads under the sprint root (acceptance criteria, model
  tier, priorities, dependencies), loop `plan-reviewer` to APPROVED. See `sprint.md`.
- **start** -- run the doer-review loop for the next pending phase. See
  `doer-reviewer-loop.md`.
- **status** -- report position from `bd` queries (`bd list --status=open`,
  `bd ready`, `bd list --tree`) plus `git log` and the latest reviewer/plan-reviewer
  structured verdicts.
- **resume** / **recover** -- reconstruct in-flight state from beads + git and
  continue. See `sprint.md` Recovery.
- **deploy** -- run the project's `deploy.md` runbook (execute / verify / rollback).
  See `sprint.md` Test.
- **backlog** / **tasks** -- manage deferred items and view the task tree via beads.
  See `beads.md`.
- **cleanup** -- close the beads sprint root and the delivered source issues, drop the
  sprint scaffolding files (so the PR's net diff is product only), raise the PR, and
  remove the track worktrees. See `sprint.md` Completion.

## Sub-documents

- `sprint.md` -- full lifecycle: the cycle loop, requirements, design, Plan,
  Develop, Test, Harvest, goal and exit gates, sprint selection, parallel-track
  integration, and recovery.
- `simple-sprint.md` -- lightweight 1-3 task flow (beads + git only, like every
  sprint).
- `doer-reviewer-loop.md` -- the dispatch loop: per-role prompt templates,
  inline dispatch, continuity between dispatches, and safeguards.
- `worktrees.md` -- worktree topology, parallel-track layout, lifecycle, transport.
- `beads.md` -- the task-DB backbone and single source of truth: sprint-root/task
  lifecycle, acceptance criteria, model tiers, findings-as-tasks, backlog, recovery,
  PR linking.
- `fleet-addendum.md` -- fleet-only execution: permissions, compose_permissions,
  stop_prompt, unattended modes, context-file delivery.
- `cost.md` -- cost quoting and calibration: Node.js check, the extracted
  `cost.js` module installed alongside the skill, quote after plan APPROVED,
  sprint log format, harvest analysis and calibration update.
