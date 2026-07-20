# Auto-Sprint Overview

`@apralabs/apra-fleet-se` ("sprint engine") implements **auto-sprint**: a
CLI-driven, autonomous sprint runner. It dispatches a fixed sequence of AI
agent roles -- planner, plan-reviewer, doer, reviewer, deployer,
integ-test-runner, harvester -- against a [beads](https://github.com/gastownhall/beads)
(`bd`) issue tracker, using `@apralabs/apra-fleet-workflow` as its execution
engine, to autonomously plan, implement, review, deploy/integration-test, and
publish a batch of work with no human in the loop until the final PR review.

Auto-sprint is one entry point built on top of `apra-fleet-workflow`: it is a
single opinionated workflow script (`auto-sprint/runner.js`) plus a CLI
wrapper (`bin/cli.mjs`) that wires it to a live fleet. The workflow engine
itself (agent/command/parallel primitives, budget tracking, the dashboard
viewer, the journal) is generic and documented in
`packages/apra-fleet-workflow/docs/`; this package's docs describe how
auto-sprint specifically uses those primitives.

**The per-sprint CLI is not the supported entry point for end users.** An
always-on supervisor process (`fleet-se serve`) owns a reservation ledger
(which members and which issue-scope are already claimed by a running
sprint) and launches each sprint as a detached child running the same CLI
underneath. Users launch and watch sprints through the supervisor's HTTP API
and web dashboard (a sprint-stack view of everything running, a backlog tree
of everything free, and a launch form), never by invoking the CLI directly --
direct CLI invocation bypasses the reservation ledger entirely and is an
internal implementation detail, not a supported workflow. See
`docs/architecture.md`'s "Supervisor" sections for the process model and
`docs/architecture.md`'s "Multi-member topology" sections for how a sprint
whose members are genuinely separate checkouts keeps their git and beads
state reconciled via orchestrator-bracketed sync brackets, as opposed to the
simpler shared-workspace mode that needs no such reconciliation.

## Mental model

A sprint is scoped to one or more beads issues (the `--issue` root(s)) and
runs as a loop of **cycles**, up to `--max-cycles`. Each cycle is:

1. **Plan** -- a `planner` agent decomposes the sprint scope into a
   features+tasks DAG in beads (or, on cycle 2+, patches gaps in an existing
   DAG). A `plan-reviewer` agent then reviews that DAG structurally (coverage,
   task sizing, acceptance criteria, dependency wiring) and returns
   `APPROVED` or `CHANGES_NEEDED`. Planner and plan-reviewer alternate for up
   to 3 rounds within the cycle; the cycle can never proceed to Develop with
   an unapproved plan -- doing so throws `SprintPlanRejectedError` and fails
   the whole sprint.
2. **Develop & Review** -- ready beads are grouped into "streaks" (chains of
   beads that should be worked by the same doer sequentially; independent
   beads become separate streaks so different doers can work them in
   parallel). Each streak is dispatched to a `doer` agent, which implements
   and closes its assigned bead(s). A `reviewer` agent then reviews the diff
   against every closed bead's acceptance criteria and returns `APPROVED` or
   `CHANGES_NEEDED` (with specific beads to reopen and/or new follow-up
   tasks). The orchestrator (not the LLM) applies every state transition:
   reopening beads, creating new tasks. This loop repeats (up to 3 rounds)
   until there is nothing ready to dispatch.
3. **Deploy & Integration Test** (conditional) -- if a `deploy.md` file
   exists in the repo, a `deployer` agent follows it to stand up a test
   environment; if that succeeds and an `integ-test-playbook.md` also exists,
   an `integ-test-runner` agent exercises features end-to-end, closing
   passing features and filing bug beads for failures. Both phases are
   skipped cleanly (not fatally) when the corresponding runbook is absent.
4. **Cycle Evaluation** -- the runner decides whether to exit the loop or run
   another cycle, based on real beads state (see "Exit condition" below), not
   just "did the doer/reviewer loop run out of ready work".

Once the loop exits (goal satisfied, or `max_cycles` reached), the runner
performs sprint-level **Finalization**: a `reviewer` agent renders an
evidence-based PASS/FAIL **final verdict** for the whole sprint, a
`harvester` agent extracts durable knowledge into `docs/`, updates
`README.md`/`CHANGELOG.md` (with a pre-computed cost block), and defers
low-priority open issues; then the runner pushes the sprint branch and opens
(but never auto-merges) a PR whose title/body states the final verdict
plainly.

See `docs/architecture.md` in this folder for the full internals (exit
condition, stall detection, budget tracking, multi-member topology, the
journal/replay mechanism) and `docs/cli-reference.md` for every flag.

## When to use it

Auto-sprint is for driving a scoped, well-defined batch of beads work (one or
more sprint-root issues, e.g. epics) to completion autonomously: plan it out,
implement it, review it, verify it end-to-end if runbooks exist, and raise a
PR -- without a human orchestrating each step. It fits:

- A backlog of already-triaged work (bugs, small features) under one or more
  parent issues, where the main risk is execution effort rather than
  ambiguous product decisions.
- Situations where you want a bounded, auditable run: a fixed cycle ceiling,
  an optional USD budget ceiling, a live dashboard, and a final PASS/FAIL
  verdict gating the resulting PR.
- Repos that already have (or can add) `deploy.md` / `integ-test-playbook.md`
  runbooks, so integration verification is part of the loop rather than an
  afterthought.

It is not a substitute for human product/architecture decisions: the planner
only decomposes what is already in beads scope (it explicitly must not add
scope beyond the sprint goals and existing open bugs/enhancements), and the
final PR is never auto-merged -- a human always reviews it (see the pm
skill's "never auto-merge" rule, which this runner's Publish phase honors
explicitly).

## Role roster

| Role | Dispatched by | Cardinality per cycle | Fixed model tier |
|---|---|---|---|
| `planner` | Plan phase, and Develop phase's streak-assignment step | 1 (Plan) + 1 per Develop round | `premium` |
| `plan-reviewer` | Plan phase | 1 per planning round (up to 3) | `premium` |
| `doer` | Develop phase | 1 per streak (parallel) | per-bead metadata tier (see `docs/architecture.md`) |
| `reviewer` | Develop/Review phase, Cycle Evaluation re-review, Finalization | 1 per develop round + conditional re-review + 1 final | `premium` |
| `deployer` | Deploy phase (conditional on `deploy.md`) | 0 or 1 | `standard` |
| `integ-test-runner` | Integration phase (conditional on `deploy.md` + `integ-test-playbook.md` + successful deploy) | 0 or 1 | `standard` |
| `harvester` | Finalization | 1 | `standard` |
| `ci-watcher` | Not dispatched by this runner today (contract exists in `contracts.mjs`/vendor for future use) | -- | -- |

Each role's full behavioral contract (what it reads, what it does, what it
must return) lives in the vendored `vendor/apra-pm/agents/<role>.md` files;
see `docs/role-contracts.md` in this folder for how this package consumes
those definitions.
