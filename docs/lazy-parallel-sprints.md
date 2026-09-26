# Parallel sprints for lazyfleet -- design

Status: **design, not implemented.** Nothing in the engine changes until this
document is reviewed. Everything here is opt-in and lives on `feat/lazyfleet`.

Goal: **speed.** A sprint should finish as fast as the work allows, with every
ready task being built at the same time, and quality protected by machine
checks while building and by review at the end.

## 1. Where we are today

fleet-sprint (`packages/apra-fleet-se/fleet-sprint/`) runs a sprint as cycles:

```
Plan -> [ Develop round -> Review round ] x up to 3 -> Deploy/Integ test -> Evaluate -> next cycle
```

Two facts limit its speed:

1. **Doers never run at the same time.** `phases/develop.mjs:250` pushes every
   doer turn through one gate, `globalDoerTurn` ("at most one doer dispatch is
   ever in flight"). Work is spread over helpers in turn, one after another.
2. **Review is per round.** One reviewer reads everything a round touched, and
   the next round waits for it.

Upstream did this on purpose (`docs/fleet-sprint-phase-routing-design.md`,
"Serialized writers are load-bearing"). Two things break if doers overlap:

- **One shared sprint branch.** Each doer pushes to it; a second concurrent push
  is not a fast-forward, so it has to rebase and can conflict.
- **The task database.** Dolt conflicts at row level; two helpers writing the
  same row (for example both running `bd close`) can wedge the sync.

This design keeps both protections but moves them to where they are cheap: only
one writer ever touches the sprint branch and the task database (the
orchestrator), and only for the few seconds it takes to land a change.

## 2. Decisions already made

| # | Decision |
|---|---|
| D1 | **Full throttle by default.** Every ready task is started at once. The UI offers an optional limit; there is no default cap. |
| D2 | **Review goes last.** No review while building. Machine checks guard each merge; review happens once, at the end, in parallel. |
| D3 | **Features working comes before review.** After everything has landed, acceptance tests run first; failures become fix tasks. |
| D4 | **Split by code, not by feature.** Tasks are code pieces (modules, layers) whose goal is "code done, unit tests pass". A task does not have to make a whole feature work. |
| D5 | **Acceptance tests are tasks.** The planner writes each feature's acceptance test as its own task, built in parallel with the code. |
| D6 | **Landing notes.** When a task lands, running helpers are told mid-task and pull the latest. Shown on the board. |
| D7 | **No re-review on a clean merge.** |
| D8 | **Fix loops are cycles of the same sprint**, on the same branch. A new sprint is only for a new ask. |
| D9 | **Only the orchestrator writes the task database.** Doers run no `bd` commands. |
| D10 | **Better doer instructions** so review finds less at the end. |

## 3. The flow

```
                              +--------------------------------+
  ask -> PLAN ---------------> |  BUILD  (event-driven pipeline) |
         code tasks +          |                                 |
         acceptance-test       |  ready task -> doer -> LAND     |
         tasks + shape of      |    ^                   |        |
         the code              |    |  newly unblocked  |        |
                               |    +-------------------+        |
                               +---------------+-----------------+
                                               | nothing ready, nothing in flight
                                               v
                               FEATURE CHECK (acceptance tests on combined code)
                                   | failures -> fix tasks -> BUILD (next cycle)
                                   v all pass
                               REVIEW (parallel, one reviewer per area + one across)
                                   | findings -> fix tasks -> BUILD (next cycle)
                                   v nothing left
                               DONE (branch, or PR if asked)
```

One **cycle** = Plan (full on cycle 1, gaps only after) -> Build -> Feature check
-> Review. Fix tasks from the feature check or review start the next cycle on the
same branch. The existing cycle cap (default 5) still bounds the whole sprint.

## 4. Planning

The planner already breaks an issue into features and tasks with dependencies.
It gains four duties (edits to `apra-pm/agents/planner.md` and the plan-reviewer's
gates):

1. **Split by code** (D4), as finely as is useful: each task is 1-4 files and
   finishes with "code done, unit tests pass".
2. **Write acceptance-test tasks** (D5): one per feature, stating the behaviour
   in testable terms ("the toggle persists across reloads"), blocked by every
   code task of that feature. It starts the moment they have landed, and its
   helper writes the end-to-end test *and* fixes whatever the separately built
   pieces got wrong together. (Built in parallel with the code instead, it
   would fail the gate until the code landed and bounce for nothing.)
3. **Fix the shape of the code first.** Names of new modules, files, public
   interfaces and data shapes go in the plan, so parallel doers do not each
   invent their own. This is the main defence against late review findings when
   many doers work at once.
4. **Predict the files each task touches** (`metadata.files`). The scheduler uses
   it to avoid running two tasks on the same files at once (section 5).

## 5. Build: the pipeline

Replaces the Develop/Review round loop with an event-driven scheduler, as a new
mode next to the existing one (`--pipeline`; the old loop stays the default for
upstream users, lazyfleet always passes it).

**Scheduling.**

- The ready set is `bd list --ready` (dependencies satisfied).
- Every ready task is dispatched immediately (D1). If the UI limit is set,
  excess tasks wait in a queue.
- **Conflict avoidance:** a ready task whose predicted files overlap a task
  already in flight waits for that task to land. This only delays; it never
  blocks forever, because landing always frees the files.
- When a task lands, the ready set is recomputed and newly unblocked tasks start
  at once. No rounds, no barrier.

**Helpers are created on demand.** The lazyfleet launcher grows the helper pool
to match what is running: a new clone under `~/.lazyfleet/helpers/<project>/`
plus a helper registration, reused across tasks and sprints. One spare clone is
kept warm so a new task never waits for `git clone`. Idle helpers are cleaned up
by the existing reaper.

**The doer's job (D9, D10).** Each doer gets:

- its own branch, `<sprint-branch>--task/<task-id>`, cut from the sprint branch
  as it is right now;
- a self-contained brief: the task, its acceptance criteria, the planned shape
  of the code, the repo's conventions (CLAUDE.md, lint config), the reviewer's
  checklist, and review findings already seen earlier in this sprint;
- a contract: implement, run the unit tests, commit on its branch, push its
  branch, and return a structured result
  `{ verdict, summary, filesTouched, newTasks[] }`. It runs **no** `bd`
  commands; anything it discovers comes back as `newTasks`, which the
  orchestrator creates.

Unique branch names mean doers never collide while pushing.

## 6. Landing: one at a time, seconds each

The orchestrator (helper 1) runs a single landing queue. When a doer finishes,
its task joins the queue. Each landing turn:

1. fetch the task branch and merge it onto the current sprint branch;
2. run the **gate**: the project's own fast checks (unit tests, type check,
   lint), found from the repo (package.json scripts, Makefile, deploy.md's test
   command) and cached per project;
3. push the sprint branch;
4. `bd close` the task and push the task database (existing mutex);
5. send a landing note (section 7) and recompute the ready set.

Because only this queue writes the sprint branch and the task database, the two
protections from section 1 still hold; the lock is held for seconds, not for a
whole doer turn.

**When a landing fails:**

| What happened | What we do |
|---|---|
| Clean merge, gate passes | Land it. No re-review (D7). |
| Textual merge conflict | Hand the task back to its doer with the conflicting files. It rebases, resolves, re-runs its unit tests and rejoins the queue. |
| Gate fails after merge | Hand back to the doer with the failing output. |
| Doer crashed or gave up | Reopen the task; it is scheduled again (fresh doer). |
| Same task bounced 3 times | Run it alone: nothing else is scheduled on its files until it lands. Guarantees progress. |

## 7. Landing notes (mid-run messages)

When a task lands, every helper still working gets a note such as:

> task shop-9x.1.1 landed on the sprint branch and touched src/theme.css.
> Pull the latest before your next commit.

**How it is delivered.** Each helper's clone gets a Claude Code `PostToolUse`
hook (in the clone's `.claude/settings.local.json`, excluded from git). After
every tool call the hook reads that helper's inbox file; if there is a note it
returns it as `additionalContext` and empties the inbox, so the note is shown
exactly once, at the helper's next step.

Verified on 2026-09-26 with Claude Code 2.1.282 on Haiku: a note placed in the
inbox before a session started was delivered during the first `Read`, quoted
back exactly, and not repeated on the second `Read`. Still to verify: delivery
into a session started through the fleet (`execute_prompt`), and whether
project-level hooks load in a helper's clone without an extra trust prompt.

**Relevance.** Every helper gets the note, but the wording depends on overlap:
a helper whose files overlap what landed is told to pull **now**; the others are
told to pull at their next commit. Reviewers are not notified; a clean rebase
does not change what they review.

**On the board**, each note is an event on the helper's timeline ("rebased onto
shop-9x.1.1") and the landed card flashes.

## 8. Feature check (D3)

Starts when the pipeline is quiet: nothing ready, nothing in flight.

1. Deploy, if the project has a deploy runbook (`deploy.md`), exactly as today.
2. Run the acceptance tests (the D5 tasks) against the combined code. The
   existing integ-test runner does this; its scope becomes "the acceptance
   tests, plus any issue marked verify".
3. Every failure becomes a precise fix task ("toggle test fails: setting not
   saved") and the sprint starts its next cycle (D8), which goes straight to
   Build with a gaps-only plan.

## 9. Review, last and in parallel (D2)

When the feature check passes:

- The sprint's full diff is split by area (directory or module clusters,
  balanced by size). **One reviewer per area**, plus **one across all areas**
  looking for inconsistency (two ways of doing the same thing, duplicated
  helpers, broken conventions).
- Reviewers run at the same time. Small areas use the cheap model tier.
- Findings become fix tasks; if there are any, the next cycle builds them, the
  gate and the feature check run again, and a short review covers only what
  the fixes changed.
- When review finds nothing to fix, the sprint is done.

## 10. Safety nets, re-derived per task

Upstream's nets count in rounds. In the pipeline they become:

| Net | Pipeline version |
|---|---|
| Round cap | Per-task bounce cap (3), then run alone (section 6). |
| Stall detection | Tasks in flight but nothing landed for a configurable time -> the board shows it, the log says which helpers are stuck. |
| Cycle cap | Unchanged (default 5 cycles). |
| Budget | Unchanged: the usage limit stops new dispatches before they start. |
| Usage limits | Unchanged: the engine pauses and resumes; the board says "paused - usage limit, resumes at HH:MM". Likely with no cap (D1). |

## 11. The board

- Card states follow the pipeline: **Queued -> Building -> Landing -> Landed ->
  Feature check -> Review -> Done**, with a badge when a card bounced back.
- The Helpers timeline shows landing notes and rebases.
- The New sprint form gains an optional **"Most helpers at once"** field (empty
  = no limit).

## 12. What changes where

| Area | Change |
|---|---|
| `fleet-sprint/phases/develop-pipeline.mjs` (new) | Scheduler, landing queue, bounce handling. The round loop is untouched. |
| `fleet-sprint/git-sync.mjs` | A landing bracket for the orchestrator's merge+push; task branches push outside the code-write lock. |
| `fleet-sprint/phases/integ-test.mjs`, review phases | Feature-check scope; parallel sliced review. |
| `apra-pm/agents/planner.md`, `doer.md`, `reviewer.md` | Split-by-code, acceptance-test tasks, file predictions, shape of code; no-`bd` doer contract; area reviewer. |
| `bin/cli.mjs` | `--pipeline`, `--max-doers` (optional). |
| `packages/apra-fleet-client` | Updated in the same change if any fleet tool changes (repo rule). |
| `src/lazy/sprints/launcher.ts` | Dynamic helper pool, warm spare clone, landing-note hook in each clone. |
| `src/lazy/sprints/board.ts`, `ui-sprints.ts` | Pipeline states, landing events, limit field. |
| `packages/apra-fleet-se/docs/architecture.md` | Document pipeline mode next to the "serialized writers" reasoning it relaxes. |

The engine must stay generic (checked by `check-generic-boundary.mjs`): nothing
here may assume a particular target repo, language or test command.

## 13. Test plan

Upstream's mock-sprint harness drives the engine without real Claude calls. New
scenarios, each a test:

1. Four independent tasks all build at once and land one at a time.
2. A task unblocked by a landing starts immediately.
3. Two tasks with overlapping predicted files never run at the same time.
4. Textual conflict: the task goes back to its doer, is resolved and lands.
5. Gate failure after merge: back to the doer with the output.
6. A doer crashes mid-task: the task is reopened and lands later.
7. A task bouncing 3 times runs alone and lands.
8. Landing notes reach the right helpers with the right wording.
9. The feature check turns a failing acceptance test into a fix task and a new cycle.
10. Parallel review slices the diff, and findings become fix tasks.
11. `--pipeline` off: behaviour identical to today (existing suite passes).

Then two real sprints on the same small job, pipeline vs today's engine,
measured with `scripts/bench-sprint.mjs` from the `feat/sprint-benchmark`
branch (wall clock, speedup, peak concurrency, cost); it needs merging in first.

## 14. Risks

- **Usage limits with no cap.** Many helpers at once will hit plan limits sooner;
  the engine pauses and resumes, so the sprint slows rather than fails. The UI
  limit is the escape hatch.
- **Semantic conflicts** (clean merge, broken behaviour) surface at the gate
  only if the project's unit tests cover them; otherwise at the feature check.
- **Late review findings** cost more to fix than early ones. Section 4's "shape
  of the code" and section 5's doer brief are the mitigation; watch the review
  fix rate in benchmarks.
- **Disk and clone time** grow with helpers; the warm spare and clone reuse
  keep it bounded.
- **Hook behaviour can change** between Claude Code versions. Landing notes are
  a speed optimisation, not a correctness requirement: without them, conflicts
  are still caught at landing.
- **Remote helpers** (other machines) are out of scope; lazyfleet helpers are
  local.

## 15. Milestones

1. Pipeline scheduler + landing queue + orchestrator-only task writes, behind
   `--pipeline`; scenarios 1-7 and 11.
2. Dynamic helper pool in the lazyfleet launcher.
3. Landing notes (hook + inbox), scenario 8, plus the two open verifications in
   section 7.
4. Planner changes and the feature check loop; scenario 9.
5. Parallel sliced review; scenario 10.
6. Board states and the limit field.
7. Benchmark against today's engine.
