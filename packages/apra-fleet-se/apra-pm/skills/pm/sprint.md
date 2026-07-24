# Running a Sprint

Full lifecycle for a pm sprint on a single project, driven from one session.

A sprint is one or more **cycles**. Each cycle runs three phases -- **Plan**,
**Develop**, **Test** -- then checks the goal; a fourth phase, **Harvest**, runs
once at sprint close. Setup, requirements, and design happen once before the first
cycle.

```
setup -> requirements -> design ->
  repeat cycle (until goal met or cycle ceiling):
    Plan    (planner writes tasks to beads -> plan-reviewer loop to APPROVED)
    Develop (doer-review loop: bd ready -> claim -> close, to a clean APPROVED)
    Test    (deploy + integration tests, if deploy.md + playbook present)
    goal check -> exit | next cycle
Harvest (CI watch -> final review -> docs/CHANGELOG -> complete -> PR)
```

State lives in **beads** (all task state -- the plan, what is open/in-progress/closed,
acceptance criteria, model tier, review findings) and **git** (the code, the branch
history, and the requirements/design narrative). There is no PLAN.md and no
progress.json. See `beads.md` for the task-DB backbone and `worktrees.md` for
worktree mechanics.

## The cycle loop

Run cycles until the **goal** is met or the **cycle ceiling** is reached.

- **Goal** -- a priority threshold (default P1/P2; also P1 or P1/P2/P3). The sprint
  is done when no open beads issue in the sprint-root subtree sits at or above it.
- **Cycle ceiling** -- a hard cap on cycles (default 5) so a sprint can never loop
  unbounded.

Each cycle:

1. **Plan** (Phase 3). If planning is already complete -- the sprint root has features and
   every open feature's tasks carry acceptance criteria (`bd show <id>`) -- skip the
   plan loop. First reset any task left `in_progress` by a crashed prior dispatch
   back to `open` (`bd update <id> --status=open`) so no work is orphaned.
2. **Develop** (Phase 4). Run the doer-review loop until `bd ready` is empty, no open
   task remains at the goal priority, and the last reviewer verdict was APPROVED (see
   `doer-reviewer-loop.md`).
3. **Test** (Phase 5). Deploy and run integration tests, only if both `deploy.md`
   and `integ-test-playbook.md` are present; otherwise skip.
4. **Goal check.** Count open issues at or above the goal priority in the sprint-root
   subtree. Zero -> goal met, exit the loop and go to Harvest. Otherwise: if this
   cycle resolved none of the previous cycle's open issues, abort and flag the user
   (no-progress); else start the next cycle.

After the loop exits, run **Harvest** once (see Completion).

## Sprint selection

Choose the shape before starting:

| Condition | Shape |
|-----------|-------|
| 1-3 tasks, one sitting, low risk, no phasing | Lightweight (see Lightweight sprint) |
| Work splits into independent, low-coupling units | Parallel tracks (see Parallel tracks) |
| Default | Single track, full lifecycle below |

Tightly coupled work stays a single track -- splitting it costs more coordination
than it saves.

## Setup (once per sprint)

1. Detect transport: `git -C <repo> remote` (empty => local-only). This decides the
   `<transport line>` in every dispatch prompt (see `worktrees.md`).
2. **Check Node.js** (required for cost quoting): `node --version 2>/dev/null || echo MISSING`.
   If `MISSING`: warn the user that cost quoting is unavailable and skip all cost
   steps for this sprint; everything else runs normally. If present: load or bootstrap
   `sprint-logs/calibration.json` (see `cost.md` Setup check).
3. Create the beads sprint root and record its id:
   `bd create "sprint: <name>" -p 1` -> `<sprint-id>` (see `beads.md`).
4. Create the track worktree(s) off the base branch (one per track):
   `git -C <repo> worktree add -b <branch> <repo>-wt/<track> <base-ref>`.

## Phase 1 -- Requirements

Write `<worktree>/requirements.md` on the track branch. Quality bar: full detail
(code locations, root causes, impact), risk front-loaded (the riskiest assumption
must become Task 1 of the plan), no 2-3 line summaries. Commit it with the message
`plan: write requirements` -- the `plan:` prefix is required (it signals to the
independent gate checker that the Plan phase ran).

## Phase 2 -- Design

When the work involves non-trivial architecture, shared interfaces, or a decision
with more than one reasonable answer, write `<worktree>/design.md` capturing the
architecture and the binding decisions, and commit it. The planner consumes it and
the reviewer checks code against it. For mechanical or single-obvious-path work,
skip design and note in `requirements.md` that none was needed.

## Phase 3 -- Plan (loop)

1. Dispatch `planner` (inline, premium-tier). It explores, drafts, self-critiques, then
   writes the plan **directly into beads** -- one task per plan item under the sprint root,
   each with `--acceptance="..."` (the reviewer's contract), `--metadata
   '{"model": "<tier>"}'` (cheap-tier for mechanical work, standard-tier for standard implementation,
   premium-tier for hard design), a priority matching the sprint goal, and dependencies
   wired with `bd dep add` (see `beads.md`). It does NOT write PLAN.md.
2. Loop, capped at three rounds: dispatch `plan-reviewer` (inline, standard-tier). It
   inspects the beads DAG (`bd graph --compact <sprint-id>`, `bd ready`, `bd show <id>`)
   for coverage, task size, acceptance criteria, dependency direction, and model-tier
   assignment, classifying each task's complexity bucket (S/M/L). Read its returned
   verdict (structured output only -- it never writes a file). `CHANGES NEEDED` ->
   dispatch `planner` to revise the beads tasks -> re-review. `APPROVED` -> continue.
   If three rounds leave the plan unapproved, abort and flag the user.

Beads now holds the full execution state -- the tasks, their acceptance criteria,
their model tiers, and their dependency order. There is no PLAN.md to commit and no
progress.json to generate; the doer loop reads `bd ready` directly.

**After APPROVED (if Node.js is available):** compute and log the sprint cost quote
using `computeSprintQuote` from `<skillDir>/cost.js` (installed alongside this
skill; see `cost.md` for the path per provider), then write per-task cost estimates
back to beads notes. See `cost.md` Phase 3.

## Phase 4 -- Develop

Run the doer-review loop in `doer-reviewer-loop.md`. Each iteration: read the ready
tasks (`bd ready`), group them into model streaks (consecutive tasks sharing a model
tier, read from each task's beads metadata -- the `model` key in `bd show <id>`,
never `--notes`), dispatch one `doer` per streak
on that tier, then one `reviewer` over all worked tasks. The doer claims each task
(`bd update <id> --claim`), implements, commits, and closes it (`bd close <id>`); the
orchestrator does not touch beads between doer and reviewer. The reviewer runs
standard-tier, escalating to premium-tier if any streak this iteration ran premium-tier; on
CHANGES NEEDED it returns `reopenIds` and `newTasks` as structured output (it never
writes a file) and the orchestrator runs `bd update <id> --status=open` for each,
returning them to `bd ready` next iteration (see `beads.md` and
`doer-reviewer-loop.md`).

The Develop phase exits when `bd ready` returns nothing, `bd list --status=open` at
the goal priority is empty, **and** the last reviewer verdict was APPROVED -- a
single APPROVED suffices because beads tracks discrete tasks. A CHANGES NEEDED
reopens tasks; the doer fixes and the loop continues. Do not advance to Test (or
Harvest) while open tasks remain at the goal priority.

## Phase 5 -- Test

Run only when both `deploy.md` and `integ-test-playbook.md` are present in the
worktree (or repo root / `docs/`); otherwise skip the phase and proceed to the goal
check. The phase has two steps:

1. **Deploy** -- dispatch `deployer` (standard-tier) with `operation: deploy`. It
   follows `deploy.md` only: deploys the build and runs the smoke test. On
   smoke-test failure, PM skips integration tests this cycle and continues. The
   deployer does NOT touch `integ-test-playbook.md` -- that playbook belongs to
   `integ-test-runner`.
2. **Integration tests.** First **enumerate the open features in the sprint-root
   subtree** yourself -- the same subtree the goal-check uses (`bd graph --json
   <sprint-id>` or `bd list --tree <sprint-id>`, then keep `issue_type == feature`,
   `status != closed`). Then dispatch `integ-test-runner` (standard-tier), passing that
   **explicit feature-id list** in the prompt -- not the sprint id for it to re-derive,
   and never the whole DB. Scoping is the orchestrator's job (you have the full sprint
   context); the runner only tests what it is handed. The runner owns
   `integ-test-playbook.md` end to end: it runs the playbook's real functional
   suite (part 1), brings the test sandbox up itself (playbook Setup on the first
   cycle, Reset on later cycles), runs the playbook's smoke scenario and each
   listed feature's tests inside it, closes passing features in beads, files a
   priority-ranked bug for each failure (see `beads.md`), and ALWAYS runs the
   playbook's Teardown before returning. An empty feature list does not skip the
   dispatch: the runner still executes the playbook's two parts as the sprint's
   standing confidence check.

If the project ships but has no runbook yet, write `deploy.md` capturing the exact
execute / verify / rollback steps and `integ-test-playbook.md` capturing Setup /
Reset / Teardown, and commit them. Deployment that needs remote machines,
credentials, or shell access beyond the local environment is out of scope for pm
itself -- note it as a manual or external step in `deploy.md`.

## Completion (Harvest)

The cycle loop has exited (goal met or cycle ceiling reached) and every track's
Develop phase ended on an APPROVED review with no open tasks at the goal priority.
Run the Harvest phase once. **ALL steps below are mandatory and must complete before
calling the sprint done.**

```
MANDATORY CHECKLIST -- verify each before exiting:
  [ ] 1. CI watch dispatched
  [ ] 2. Final reviewer dispatched + APPROVED
  [ ] 3. Harvester dispatched (docs/ or CHANGELOG in branch diff)
  [ ] 4. Cost analysis committed (or skipped if no Node.js)
  [ ] 5. Sprint root + delivered issues closed
  [ ] 6. bd export committed to branch (.beads/*.jsonl updated)
  [ ] 7. Sprint scaffolding (requirements.md, design.md) removed from PR diff
  [ ] 8. PR raised with gh pr create
```

1. **CI watch** -- dispatch `ci-watcher` (cheap-tier) to poll CI for the sprint HEAD
   SHA: green / red / not configured / pending. If CI is not configured, file a
   beads task to add it and flag the user. Carry red/not-configured into the PR body
   rather than blocking the harvest.
2. **Final review** -- dispatch `reviewer` (premium-tier) over the whole sprint output:
   does it address the original sprint goals, are there gaps or regressions, is it in a
   releasable state for what was completed? `CHANGES NEEDED` -> stop before harvest
   and flag the user. `APPROVED` -> continue.
3. **Documentation harvest** -- dispatch `harvester` to extract long-term knowledge
   from requirements.md, design.md, and the beads task tree (`bd list --tree
   <sprint-id>`, `bd show <id>`) into `docs/` and update `CHANGELOG`.
   Structure inside `docs/` is content-driven (e.g. `docs/architecture.md`,
   `docs/features/<name>.md`). Extract: architecture decisions, feature design, key
   trade-offs, API contracts. Do NOT extract: task lists, code-line references, debug
   notes, implementation steps. The harvester commits the `docs/` and `CHANGELOG`
   output to the branch.
4. **Cost analysis and calibration update** (if Node.js available) -- run
   `computeSprintAnalysis`, `buildSprintSummary`, and `computeUpdatedCalibration`
   from `<skillDir>/cost.js` (the extracted module installed alongside this skill on
   every provider -- see `cost.md`) to produce `sprint-logs/<branch>-<startedAt>.analysis.md` and
   update `sprint-logs/calibration.json` with actual token data from this sprint.
   Commit both. See `cost.md` Harvest.
5. **Close the sprint root and the delivered issues** -- `bd close <sprint-id>`; also close
   any source beads issues this sprint implemented -- the ready backlog items the
   requirement was drawn from -- with `bd close <issue-id> ...`. Closing the sprint root
   alone leaves those open.
6. **Persist beads state to branch** -- this step is REQUIRED for the PR to carry
   durable issue-closure evidence. Run:
   ```
   bd export -o <track-worktree>/.beads/issues.jsonl
   git -C <track-worktree> add .beads/issues.jsonl
   git -C <track-worktree> -c user.name='pm' -c user.email='pm@pm.local' \
     commit -m "chore: export beads state"
   ```
   (A bare `bd export` only prints to stdout; you MUST pass `-o <path>` to write the
   file. This step carries the closed state into the PR regardless of backend type.)
   Record the PR link on the sprint root with `bd update <sprint-id> --notes "pr: <url>"`
   once the PR is raised (step 8).
7. **Clean sprint scaffolding from the PR** -- the PR's net diff must be product
   only. The tracking files (`requirements.md`, `design.md`) are sprint narrative,
   not product; beads holds the durable task record, and the reviewer's verdict is
   returned as structured output rather than written to a file, so these narrative
   files stay visible in the branch history as proof the loop ran. For each such
   file, decide by whether it existed on the base branch:
   - **Sprint created it** (absent on base): `git rm` it.
   - **The repo already had it** (present on base, the sprint only touched it):
     restore it to base content -- `git checkout <base> -- <file>` -- so the diff
     shows no change. Never delete a file the repo shipped.

   Commit as the orchestrator identity `pm`. Then VERIFY:
   `git diff --name-only <base>...<branch>` must list no tracking-file name in any
   case. If one remains, repeat until the net diff is product only. (Same drop the
   parallel-track flow does before integrating.)
8. **Raise the PR** -- run the PR command directly: open a PR from the (integration)
   branch to the base, then watch checks until CI is green. For a local-only sprint
   there is no PR -- report the branch and its `git diff <base>...<branch>` instead.
   Use `gh pr create --base <base_branch> --head <branch> --title "..." --body "..."`.
9. **Do NOT merge.** Surface the PR URL and CI status; await explicit user
   instruction to merge.
10. **Remove worktrees** -- `git -C <repo> worktree remove <repo>-wt/<track>` for
    each track once the PR is raised (or the branch is merged).

## Parallel tracks

Use multiple tracks when the work splits into independent, low-coupling units. Each
track runs its OWN full pipeline (`planner` -> `plan-reviewer` -> `doer` ->
`reviewer`) in its OWN worktree and branch, concurrently with the others.

1. **Contracts first.** Identify shared interfaces (APIs, data models, schemas) up
   front; write them to `contracts.md`, commit to the base branch, and base every
   track worktree on that commit. Contracts are immutable mid-sprint; if one must
   change, that track stops and the orchestrator serializes the revision (one track
   revises; dependents wait until it merges).
2. **Fan out.** Create one worktree + branch per track. Run each track's plan loop
   and execute loop independently. Dispatch one pipeline per track and poll them to
   completion within the turn -- track A's reviewer may run while track B's doer
   works -- keeping the turn alive until their results are in. In
   beads, every task carries its track (assignee or label) so the tree shows which
   track owns what.
3. **Integrate.** When a track is APPROVED, merge its branch into the integration
   base branch (never the trunk): `git -C <repo> merge <track-branch>`. Merge code
   only -- the per-track narrative files (`requirements.md`, `design.md`) are sprint
   scaffolding for that one track and stay on its branch. Drop them before the merge
   (e.g. `git rm` on the track branch, or resolve the merge in favour of removing
   them) so two tracks never collide on a same-named file. beads holds the
   cross-track task record, so nothing durable is lost. Notify dependent tracks to
   rebase on the updated base.
4. **Finish.** When all tracks are merged: raise one PR from the integration branch,
   confirm CI, remove all worktrees.

## Lightweight sprint

For 1-3 tasks completable in one sitting, skip the full harness:

1. Write a concise `requirements.md` on the branch and commit.
2. Create a small beads sprint root + a task per item.
3. Dispatch the `doer` (model sized to the work) for the task(s); it commits.
4. Dispatch the `reviewer` (premium-tier); read the verdict. `CHANGES NEEDED` ->
   doer fixes -> re-review. `APPROVED` -> close the beads tasks and the delivered
   source issues, clean the sprint scaffolding from the PR (see Completion step 7 --
   `git rm` sprint-created tracking files, restore any the repo already shipped, then
   verify the net diff is product only) and commit as `pm`, raise the PR (or
   report the diff for local-only), remove the worktree.

No harness files; beads + git carry the state. Promote to a full sprint if the work
turns out larger than expected.

## Recovery after an orchestrator restart

State is in beads and git -- no status file, no memory, no progress.json. To
re-orient:

1. `bd list --status=open` + `bd list --status=in_progress` + `bd ready` (or
   `bd list --tree <sprint-id>`) -- what is open, claimed, and unblocked. Beads
   reflects claim/close actions, not on-disk completion, so confirm against git next.
2. Per track worktree: `git -C <repo> log --oneline <base>..<branch>` (what is
   committed). The reviewer's verdict is returned as structured output, not written
   to a file -- if the orchestrator crashed before applying it, there is no verdict
   to recover; treat any task last known to be under review as needing a fresh
   `reviewer` dispatch.
3. `git -C <repo> -C <worktree> status` -- uncommitted changes?

Then act:

- **Task `in_progress` with no matching commits** -> orphaned claim from a crashed
  dispatch; reset it (`bd update <id> --status=open`) and re-dispatch the doer.
- **VERIFY reached, no review yet** -> dispatch the reviewer now.
- **Ready tasks remain, working tree clean** -> dispatch the doer for the next ready
  task (its model tier from `bd show <id>`).
- **Idle, no progress** -> re-dispatch from the next ready task.
- **Uncommitted work of unknown origin, or beads and git disagree** -> STOP and flag
  the user; do not guess.

Each dispatch reads its context from beads + git, so recovery is just "read beads +
git, dispatch the right next role." Every dispatch starts fresh from that state.
