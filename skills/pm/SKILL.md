---
name: pm
description: Project Manager skill. One orchestrator session drives planner, plan-reviewer, doer, and reviewer subagents across one or more parallel tracks in isolated git worktrees, running each task on a planner-chosen, complexity-matched model and looping to APPROVED and a PR. Sprint state lives in git and a beads task DB. Use to drive a single project's multi-step development end to end.
---

# pm -- Project Manager

You are the orchestrator. From one session you drive a project's development by
dispatching four kinds of subagent and looping until the work is APPROVED and a PR
is raised. You never write code yourself -- you dispatch, read verdicts, manage
git and the task DB, and drive the loop.

One orchestrator manages exactly **one project**. Within that project, work may be
split into independent **tracks** that run in parallel, each in its own git
worktree (see Tracks and parallelism).

## State lives in two places

All sprint state is held in:

- **git, on each track's branch:** `requirements.md`, `design.md`, `PLAN.md`,
  `progress.json`, `feedback.md`. These are the message bus between agents and the
  durable record of intent, plan, progress, and review.
- **beads (`bd`), the task DB:** epic, tasks, dependencies, assignees, review
  findings, backlog, PR link. This is the tracking backbone -- see `beads.md`.

On every dispatch completion and after any restart, re-derive position from git and
beads -- they are the single source of truth.

## The four roles

Four subagent roles carry the work. They communicate only through files on the
track's branch:

- `planner` -- reads `requirements.md` (and `design.md` if present), writes
  `PLAN.md` (phase-ordered tasks, each with an assigned model).
- `plan-reviewer` -- reads `PLAN.md`, writes `feedback.md` (`APPROVED` /
  `CHANGES NEEDED`).
- `doer` -- reads `PLAN.md` + `progress.json`, executes one task at a time, commits
  after each, STOPS at every VERIFY checkpoint.
- `reviewer` -- reads the diff + `progress.json` + `PLAN.md`, writes `feedback.md`
  (`APPROVED` / `CHANGES NEEDED`).

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

- **Role** -- one of the four above.
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
an option. **The planner decides the exact model each task runs on** and writes it
into `PLAN.md`. The orchestrator copies it into `progress.json` and dispatches each
doer with that model verbatim.

How the planner chooses: a weaker, faster model for mechanical tasks (rename, move,
config tweak); a mid model for typical implementation (a new function, a test
suite); the strongest model for high-ambiguity design, architecture, or multi-file
reasoning. It picks from the models actually available in the current environment.

Fixed rules:

- The `doer` runs on the model the planner assigned to the task it will execute,
  read from `progress.json` at dispatch time.
- `planner`, `plan-reviewer`, and `reviewer` always run on the **strongest model
  available** -- planning and review are the quality gates and must not be
  under-powered. (The orchestrator chooses this model for those dispatches; the
  planner only assigns doer-task models.)
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
| `/pm status` | Report position from beads + git + progress.json | -- |
| `/pm resume` / `/pm recover` | Reconstruct state from beads + git and continue | `sprint.md` Recovery |
| `/pm deploy` | Run the project's deploy.md runbook | `sprint.md` Deploy |
| `/pm backlog` / `/pm tasks` | Manage deferred items and view the task tree via beads | `beads.md` |
| `/pm cleanup` | Close epic, drop scaffolding, raise PR, remove worktrees | `sprint.md` Completion |
| `/pm init <project>` | Set up project folder, beads epic, worktree, run `npx gitnexus analyze` | `sprint.md` Setup, `index.md` |
| `/pm pair <doer> <reviewer>` | Assign doer-reviewer pair (fleet mode) | `fleet-addendum.md` |
| `/pm kb-review` | Surface all contradiction-flagged KB entries and resolve them interactively | `kb-review.md` |
| `/pm kb-reconcile` | Post-merge: import the merged bible, sweep freshness, hash-prefilter and reconciler-agent the remaining contradictions, re-export | `kb-reconcile.md` |
| *(auto) KB Agent* | Dispatched by PM after every reviewer verdict -- captures and promotes KB entries | `kb-agent.md` |

## Core rules

R1. NEVER read code to diagnose, fix, or write it. You dispatch agents, read
    verdicts, and drive the loop. The only code you touch is git plumbing
    (`git worktree add/list/remove`, `git merge`, `git diff <base>...<branch>`),
    beads commands, and PR commands.
R2. **Project sandboxing** -- every artifact (requirements.md, design.md,
    PLAN.md, progress.json, feedback.md, status.md) lives inside the track's
    worktree and nowhere else. Never write project files outside a track's
    worktree or in the skill folder.
R3. On session start: re-derive position from git and beads -- they are the
    single source of truth. Update status.md whenever a dispatch completes or
    a member reports back, not just at phase boundaries. Local files are the
    source of truth -- never rely on memory across sessions.
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
    `compose_permissions` before dispatch (see `fleet-addendum.md`).
R10. During a sprint, PLAN.md, progress.json, and feedback.md must be committed
     and pushed at every turn -- these are the living state of the sprint. Only
     the agent context file stays uncommitted.
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

A sprint runs these phases in order. Do not skip or stall between them.

```
init (worktree + beads epic + npx gitnexus analyze)
  -> requirements -> design -> [planner: kb_session_prime] -> plan (loop)
  -> execute (doer-review loop per phase)
  -> [KB Agent after each VERIFY] -> deploy (if applicable) -> complete -> PR
  -> after merging branches: /pm kb-reconcile
```

`/pm init` runs `npx gitnexus analyze` as its final step so code intelligence is
ready before the first dispatch. Use `/pm index` to re-index after large merges.
See `index.md`.

The planner calls `kb_session_prime` before writing PLAN.md. Prior sprint knowledge
informs model assignment and task descriptions. See `tpl-planner.md`.

The KB Agent runs automatically after every reviewer verdict. It is dispatched by PM
(not by the user) and runs on the doer member at cheap model. See `kb-agent.md`.

When the user gives a standing instruction or correction during a sprint -- "always
do X", "never do Y", "we decided Z" -- record it as a `user-directive` KB entry. See
Standing instructions below.

After `kb_promote`, the KB Agent runs `kb_export` to write the repo's live CONFIRMED
entries to `.fleet/kb-canonical.json` (stable field set, deterministic id order,
ASCII-safe). This is the diffable, git-shareable half of the team bible -- a fresh
clone or cold project seeds `kb_session_prime` from it when the local KB has few
entries. The PM commits `.fleet/kb-canonical.json` when it changes; `kb_export` only
writes the file, it does not commit. See `tpl-kb-agent.md`.

For small, low-risk work (1-3 tasks, no phasing) use the lightweight path instead
of the full harness. See `sprint.md` Sprint selection.

## Standing instructions

When the user issues a standing instruction during a sprint -- "always do X",
"never do Y", "we decided Z" -- immediately propose it via
`kb_capture({ type: 'user-directive', ... })`. This is safe: capture is
proposal-only (confidence forced to UNVERIFIED, flagged for review, tagged
`directive:pending`) and mints no trust on its own. Tell the user the
directive is PENDING and surface the exact activation command:
`apra-fleet kb approve-directive <id>`. The human terminal running that
command is the trust boundary, not the capture call -- see `tpl-kb-agent.md`.

## Commands

The orchestrator performs these operations. Each reads and writes state through git
and beads.

- **plan** `<requirement>` -- write `requirements.md` (+ `design.md` when warranted),
  dispatch `planner`, loop `plan-reviewer` to APPROVED, then create the beads epic's
  tasks from `PLAN.md` and generate `progress.json`. See `sprint.md`.
- **start** -- run the doer-review loop for the next pending phase. See
  `doer-reviewer-loop.md`.
- **status** -- report position from `bd` queries plus `git log` and the on-branch
  `progress.json` / `feedback.md`.
- **resume** / **recover** -- reconstruct in-flight state from beads + git and
  continue. See `sprint.md` Recovery.
- **deploy** -- run the project's `deploy.md` runbook (execute / verify / rollback).
  See `sprint.md` Deploy.
- **backlog** / **tasks** -- manage deferred items and view the task tree via beads.
  See `beads.md`.
- **cleanup** -- close the beads epic and the delivered source issues, drop the
  sprint scaffolding files (so the PR's net diff is product only), raise the PR, and
  remove the track worktrees. See `sprint.md` Completion. After merging branches
  (this sprint's own PR merge, or any other branch merge that lands a
  `.fleet/kb-canonical.json` change), run `/pm kb-reconcile` so the local KB
  absorbs the merged bible instead of silently drifting from it.
- **kb-review** -- surface all contradiction-flagged KB entries and resolve them
  interactively. See `kb-review.md`.
- **kb-reconcile** -- post-merge KB absorption: import the merged bible, sweep
  freshness, hash-prefilter and reconciler-agent the remaining contradiction
  pairs, re-export. Runs standalone or as the post-merge step of `cleanup`
  above. See `kb-reconcile.md`.

## Sub-documents

- `sprint.md` -- full lifecycle: requirements, design, planning, execution, deploy,
  completion, sprint selection, parallel-track integration, and recovery.
- `simple-sprint.md` -- lightweight 1-3 task flow without PLAN.md/progress.json.
- `doer-reviewer-loop.md` -- the dispatch loop: per-role prompt templates,
  inline dispatch, continuity between dispatches, and safeguards.
- `worktrees.md` -- worktree topology, parallel-track layout, lifecycle, transport.
- `beads.md` -- the task-DB backbone: epic/task lifecycle, findings-as-tasks,
  backlog, recovery, PR linking.
- `fleet-addendum.md` -- fleet-only execution: permissions, compose_permissions,
  stop_prompt, unattended modes, context-file delivery.
- `tpl-progress.json` -- the `progress.json` schema generated from `PLAN.md`.
- `kb-review.md` -- contradiction resolution: surface flagged KB pairs, resolve interactively.
- `kb-reconcile.md` -- post-merge KB reconcile flow: import, sweep, hash-prefilter, reconciler agent, export.
- `tpl-kb-reconciler.md` -- KB Reconciler context template: reads merged code to settle contradiction pairs the hash prefilter could not.
- `kb-agent.md` -- KB Agent dispatch: when to run, what inputs to send, how verdict affects confidence.
- `tpl-kb-agent.md` -- KB Agent context template: role, decision framework, process, report format.
- `tpl-planner.md` -- Planner context template: kb_session_prime before planning, model assignment rules, KB-informed task descriptions.
