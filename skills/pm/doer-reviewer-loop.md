# Doer-Reviewer Loop

The execute-phase loop for one track. Every dispatch is an inline subagent call (its
result returns in the same turn);
every handoff is a file committed on the track's branch; every task transition is
recorded in beads. (The plan loop that precedes this -- planner / plan-reviewer --
is in `sprint.md`.)

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

## The loop (per track, per phase)

```
PLAN approved, beads tasks created, progress.json written
  for each phase in PLAN.md:
    1. Claim the phase's first pending task in beads (status in_progress).
       Dispatch the doer (inline) with the task's assigned model -> doer executes
       the phase's pending tasks in order, commits each, STOPS at the VERIFY checkpoint.
    2. On doer completion: read progress.json. If a task is blocked -> handle the
       blocker. Assert the worktree is clean (`git status --porcelain` empty); a dirty
       tree means the doer left uncommitted work -- send it back to commit before any
       review. Otherwise close the phase's completed tasks in beads and dispatch the
       reviewer (inline, strongest model).
    3. On reviewer completion: read the feedback.md verdict.
         APPROVED       -> dispatch KB Agent (see kb-agent.md), then advance to the
                           next phase (or Completion if last).
         CHANGES NEEDED -> dispatch KB Agent (see kb-agent.md), then create one beads
                           task per HIGH finding (assigned to the track), dispatch the
                           doer to fix (inline) -> back to step 2. Close each finding
                           task when the reviewer clears it.
  All phases APPROVED -> Completion (see sprint.md).
```

The orchestrator does nothing between a doer finishing and a reviewer starting
except read `progress.json`, update beads, and dispatch. Never pause for the user
mid-loop.

## Model per task

The planner assigned each task an exact `model` in `PLAN.md`, copied into
`progress.json`. Read the next pending task's `model` and dispatch the doer with it
verbatim. A phase may span models across its tasks; run one doer dispatch per model
streak (a run of consecutive tasks sharing a model), in dependency order. A phase
with three model groups becomes up to three doer dispatches, each on its own model.
The dispatch whose streak reaches the VERIFY task carries through it. The reviewer is
always dispatched on the strongest model available.

## Dispatch and wait inline

Dispatch each subagent and wait for its result in the same turn -- the dispatch
returns the agent's result to you inline. Run the loop sequentially this way: one
dispatch, its result, the next. NEVER end your turn while a dispatched agent still
owes you a result; in a headless run nothing re-invokes you, so ending the turn
parks the sprint. With multiple tracks, dispatch one per active track and poll them
to completion within the turn -- track A's reviewer can run while track B's doer
works -- but keep the turn alive until you have collected their results.

After each agent returns, the orchestrator's FIRST action is to read state from git
and beads (`progress.json`, `feedback.md`, `git log <base>..<branch>`, `bd show`);
those are the source of truth for what was dispatched and where it landed.

## Telemetry -- token cost per dispatch

A dispatch is the metering unit: one `Agent` call runs one subagent and returns one
usage figure for everything it did (a single task or a same-model streak). When the
harness reports usage on completion, append one record to the `dispatches` ledger in
`progress.json` (see `tpl-progress.json`):

```
{ "seq": N, "role": "doer", "model": "<model>", "phase": P,
  "tasks": ["T2","T3"], "tokens": <subagent tokens>, "toolUses": <n>, "ms": <n> }
```

Cost is attributed to the dispatch (the streak), not to individual tasks -- so no
per-task dispatch overhead is needed. The three cost buckets fall out by grouping
the ledger by role: **doer** dispatches (implementation), **plan-reviewer +
reviewer** dispatches (review), and the orchestrator's own main-loop usage
(orchestration), which is not a subagent and so is tracked at the session level, not
in this ledger. If the harness does not report per-subagent usage, record what it
provides and leave the rest null.

## Commit identity

So the branch history shows who did what, each role commits under its OWN git
identity rather than the ambient one. Pass it inline on every commit -- do not rely
on global config:

```
git -c user.name='pm-<role>' -c user.email='<role>@pm.local' commit -m "<msg>"
```

Identities: `pm-planner`, `pm-plan-reviewer`, `pm-doer`,
`pm-reviewer`. The orchestrator's own git plumbing (requirements.md, design.md,
progress.json sync, and the completion scaffolding drop) commits as `pm`. Each
template below restates its identity so the dispatched agent uses it.

## Per-role prompt templates

Everything the agent needs is in the prompt plus the committed files in its
worktree. Every prompt pins the worktree path. `<transport line>` is decided once
per repo (see `worktrees.md` Transport): remote present => "Push your commits." ;
local-only => "This is a local-only worktree -- commit every turn and skip pushing."

### planner

```
You are planning a track. Your worktree is <abs worktree path> on branch <branch>
(base <base>). cd there first; use absolute paths. Read requirements.md (and
design.md if present).
Knowledge bank: before exploring the codebase call kb_session_prime with
hint_symbols and hint_modules derived from the requirements. Read every entry in
top_entries -- prior sprint knowledge informs model assignment and task descriptions.
For symbol lookups and call graph questions use code intelligence tools
(code_graph, code_impact, code_query, code_context) -- never Glob/Grep for
structural queries.
Explore, draft, front-load risk (riskiest task first), self-critique, refine.
Assign every work task the exact model to run it on (claude-haiku-4-5-20251001 for
mechanical, claude-sonnet-4-6 for typical, claude-opus-4-8 for hard design),
chosen from the models actually available in this environment, and write it as the
task's Model in PLAN.md. Commit PLAN.md to <branch> as identity pm-planner
(git -c user.name='pm-planner' -c user.email='planner@pm.local' commit).
<transport line>. The worktree and branch already exist -- do not create or switch
branches.
```

### plan-reviewer

```
You are reviewing a plan. Your worktree is <abs worktree path> on branch <branch>.
cd there; use absolute paths. Read requirements.md, design.md (if present), and
PLAN.md. Follow your plan-reviewer instructions. Overwrite feedback.md with your
verdict (APPROVED or CHANGES NEEDED) and commit it as identity pm-plan-reviewer
(git -c user.name='pm-plan-reviewer' -c user.email='plan-reviewer@pm.local'
commit). <transport line>.
```

### doer

```
You are executing a plan. Your worktree is <abs worktree path> on branch <branch>
(base <base>). cd there; use absolute paths. Read progress.json and PLAN.md.
Execute ONLY task(s) <task scope> in phase <N>, one at a time: implement, run fast
tests after each, commit, update progress.json. Make every commit as identity
pm-doer (git -c user.name='pm-doer' -c user.email='doer@pm.local'
commit). If your scope reaches the phase <N>
VERIFY checkpoint, run it -- build, linter, full test suite, then npx gitnexus
analyze --embeddings (non-fatal; if it fails, record in progress.json and
continue) -- record results in progress.json, then stop. Otherwise stop after
the last task in <task scope>.
<transport line>. Do not start anything beyond <task scope>. The worktree and branch
already exist -- do not create branches.
[If fixing review findings:] feedback.md says CHANGES NEEDED. Address every HIGH
finding, annotate each fixed section in feedback.md with "Doer: fixed in commit
<sha> -- <what>", commit, then stop for re-review.
Knowledge bank: at session start call kb_session_prime with hint_symbols and
hint_modules derived from your first task. Before reading an unfamiliar file call
kb_query first -- if KB returns a CONFIRMED or INFERRED entry, trust it and skip
the source read. During work use code intelligence tools (code_graph, code_impact,
code_query, code_context) for symbol lookups and call graph questions -- never
Glob/Grep for structural queries. Do NOT call kb_capture or kb_harvest yourself --
kb_harvest is auto-dispatched with your transcript after your session ends, and the
KB Agent captures directly from your session output afterward. If a KB entry you
retrieved proves wrong in practice, call kb_feedback with the entry id and what was
wrong.
```

### reviewer

```
You are reviewing code. Your worktree is <abs worktree path> on branch <branch>
(base <base>). cd there; use absolute paths. Review all phases up to and including
phase <N> -- read PLAN.md, progress.json, requirements.md, design.md (if present),
and git diff <base>...<branch>. Run the build, linter, and full test suite. Read
the prior feedback.md history (git log -- feedback.md) so you account for how
earlier findings were addressed. Overwrite feedback.md with your verdict (APPROVED
or CHANGES NEEDED) and commit it as identity pm-reviewer
(git -c user.name='pm-reviewer' -c user.email='reviewer@pm.local' commit).
Knowledge bank: at session start call kb_session_prime with hint_symbols and
hint_modules derived from the diff under review. Before reading an unfamiliar file
call kb_query first -- if KB returns a CONFIRMED or INFERRED entry, trust it and
skip the source read. For who-else-calls and impact questions, use code_impact.
During review use code intelligence tools (code_graph, code_impact, code_query,
code_context) for structural questions about symbols and call chains -- never
Glob/Grep for these queries. If a KB entry you retrieved proves wrong in practice,
call kb_feedback with the entry id and what was wrong.
<transport line>.
```

## Continuity between dispatches

Each dispatch is a fresh subagent run; continuity comes from the files it reads.
Two ways to continue:

- **Default: fresh dispatch.** Dispatch a new agent of the right role; it
  reconstructs context from `progress.json`, `PLAN.md`, `feedback.md`, and
  `git log`. This is robust and the right choice across phase boundaries and role
  switches -- the agents begin with a context-recovery `git log`.
- **Tight iteration: continue the same agent.** For a quick same-worktree, same-role
  turn -- e.g. the doer addressing review findings it just produced context for --
  continue the SAME agent instance, which keeps its context. Use this within one
  worktree and one role; switch roles with a fresh dispatch.

## Resume rules

Resume is data-driven from `progress.json` phase numbers (`lastDispatchedPhase`),
not manually reasoned.

### Doer dispatches

| Condition | resume |
|-----------|--------|
| `nextTask.phase === lastDispatchedPhase` | `true` (continue session) |
| `nextTask.phase !== lastDispatchedPhase` (new phase) | `false` (fresh) |
| After reviewer CHANGES NEEDED -> doer fix | `true` |
| Role switch (doer -> reviewer) | `false` |

### All dispatches

| Dispatch | resume |
|----------|--------|
| Initial plan generation | `false` |
| Plan revision (any feedback iteration) | `true` |
| Initial review dispatch | `false` |
| Re-review after CHANGES NEEDED + doer fixes | `true` |
| Role switch (doer -> reviewer, or reviewer -> doer) | `false` |
| After stop_prompt cancellation (fleet mode) | `false` -- session state unreliable after kill; start fresh |
| After session timed out mid-grant (fleet mode) | `true` -- fleet auto-recovers but member restarts without prior context |

A role switch always requires sending the new context (context file or inline
prompt). Never resume across a role switch.

## Safeguards

| Safeguard            | Trigger                          | Orchestrator action                                              | Limit            |
|----------------------|----------------------------------|------------------------------------------------------------------|------------------|
| Dispatch retry       | Agent errors or returns nothing  | Re-dispatch the same role fresh; after 3 fails, pause + flag user | 3 per dispatch   |
| Doer-reviewer cycle  | Reviewer returns CHANGES NEEDED  | Doer fixes, re-review; if 3 cycles leave HIGH items, pause + flag | 3 cycles/phase   |
| Zero progress        | Two fresh dispatches, no commits | Escalate to a stronger model; still stuck after the strongest => flag | 2 per model  |
| Blocked task         | progress.json task = "blocked"   | Read the blocker note; resolve if mechanical, else flag user      | --               |

Escalate to the user only after a safeguard limit trips, on a genuine requirements
ambiguity, or on a risky/irreversible action. Otherwise keep the loop running.
