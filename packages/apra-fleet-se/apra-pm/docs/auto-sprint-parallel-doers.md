# Auto-Sprint Parallel Doers -- Design

Status: design. Branch: `ruggedize/auto-sprint-preflight-checkpoint`.

Goal: cut sprint wall-clock by running independent ready tasks **concurrently** instead of
one doer working them in sequence. This is the dominant time sink (the doers writing real
code, serialized). Target: 2-4x on task-parallel cycles.

## Non-negotiable: this is a general product

auto-sprint runs against **hundreds of unrelated projects** (any language, build system,
repo layout, monorepo or not). The design MUST NOT assume anything about the toy/e2e repo.
Concretely:
- No hard-coded paths, languages, file counts, or task shapes.
- Degrade safely: if parallelism can't be used (1 ready task, worktree unsupported, width=1),
  behave EXACTLY like today's sequential loop. Never worse than the serial path.
- Correctness first: a parallel run must produce the same committed result a serial run would,
  or re-queue the work and fall back to serial. Speed never trades away correctness.
- Every failure mode (doer crash, merge conflict, worktree leak) has a defined recovery.

## Why `bd ready` tasks are safe to parallelize

`bd ready` returns only tasks whose dependencies are all satisfied -- by the DAG they are
mutually order-independent. The remaining risk is not logical dependency but **physical file
overlap** (two ready tasks editing the same file). We handle that at merge time, not by
guessing up front. So the parallelism unit = a ready task (or a small same-tier group), each
worked on an isolated branch, merged back sequentially with conflict fallback.

## Isolation model: worktree + temp branch per doer

Two doers cannot share one working tree, and cannot both be on the sprint branch. So each
parallel doer gets:
- its own git worktree under `.auto-sprint/wt/<taskid>` (a temp dir, git-ignored / cleaned up)
- its own temp branch `auto-sprint/wt/<sprintbranch>/<taskid>` cut from the CURRENT sprint HEAD

The doer implements ONLY its assigned task in that worktree and commits there. It never
touches the sprint branch or the main checkout.

## Beads state is centralized in the workflow (critical for correctness)

Today each doer runs `bd update --claim` / `bd close` itself. Under parallelism that breaks:
each worktree has its own `.beads/` working copy, so concurrent bd writes diverge and are
invisible to each other and to the main checkout.

Fix: **the workflow owns all beads state transitions; parallel doers do NO bd commands.**
- Before fan-out, the workflow (in the main checkout) `bd update --claim`s each task it is
  about to dispatch.
- The parallel doer's contract shrinks to: "implement task X (acceptance criteria inlined),
  run the project's own verification if cheap, commit in this worktree, return VERIFY. Do NOT
  run any bd command."
- After a doer's branch merges cleanly into the sprint branch, the workflow `bd close`s that
  task centrally in the main checkout.
- On merge conflict or doer failure, the workflow `bd update --status=open`s the task (re-queue)
  centrally.

This removes all bd concurrency, keeps beads as the single source of truth, and makes the
doer a pure code-writer -- which also makes it cheaper and more predictable.

## Control flow (replaces the serial `for (streak of streaks)` block)

Per develop iteration:
1. `getReadyStreaks(rootIds)` as today.
2. Compute the batch: take ready tasks (respecting the existing token-ceiling AND
   context-fit split per task), cap the batch to `width = min(readyCount, maxParallelDoers)`.
   `maxParallelDoers` comes from calibration (`parallelism.max_doers`, default 4), and is
   further capped by the harness concurrency cap. Leftover ready tasks resurface next iter.
3. Workflow claims all batch tasks centrally (`bd update --claim`).
4. `parallel(batch.map(task => doInWorktree(task)))` -- each thunk:
   a. create worktree + temp branch off sprint HEAD (a single dispatchShell),
   b. dispatch a doer bound to that worktree working ONLY that task,
   c. return {task, tempBranch, worktreePath, ok}. A thrown/`null` doer -> {ok:false}.
5. Barrier (parallel resolves). Then **merge sequentially** into the sprint branch in the
   main checkout, in a deterministic order (task id) so runs are reproducible:
   - `git merge --no-ff <tempBranch>` (or cherry-pick the worktree commits).
   - clean merge -> `bd close <task>`; record worked.
   - conflict -> `git merge --abort`, `bd update --status=open <task>` (re-queue), log it.
   - doer failed (ok:false) -> re-queue (`--status=open`), no merge.
6. Always clean up: `git worktree remove --force` + delete temp branch, for every batch task,
   even on failure (finally-style). A leaked worktree must never block the next iteration.
7. Reviewer runs once over all successfully-merged tasks (unchanged).
8. Re-queued tasks (conflict/failure) come back via `getReadyStreaks` next iteration and are
   eventually worked; if a task conflicts repeatedly it degrades to being the sole task in a
   batch (width shrinks naturally as ready count drops), i.e. serial -- guaranteeing progress.

## Safe degradation (must hold for every project)

- `width === 1` (one ready task, or `parallelism.max_doers = 1`): skip worktree machinery
  entirely, run the doer in the main checkout exactly as today. Zero new risk for serial work.
- worktree creation fails (old git, FS constraints): log, fall back to serial for that task.
- The existing per-streak token-ceiling and context-fit splitting are applied per task BEFORE
  batching, so a single oversized task is still handled correctly.

## Calibration additions

```
parallelism: {
  _doc: 'Doer concurrency. max_doers>1 fans out independent bd-ready tasks into isolated git
         worktrees worked in parallel, merged back sequentially with conflict fallback. Set to
         1 to force the serial path. Capped by the harness concurrency limit regardless.',
  max_doers: 4,
  worktree_root: '.auto-sprint/wt',
}
```

## Measurement first (per-phase wall-clock)

We cannot currently prove where time goes (the `Date.now()` ban means the workflow can't
self-time; ledger entries carry no `ts`). Before and after parallelization we capture
per-phase wall-clock via a cheap `date +%s` at each phase boundary (a `stamp()` helper,
~6-10 cheap shell calls over a whole sprint) and report per-phase seconds in the sprint
summary. This turns "it's slow" into "develop was N of M minutes" and lets us prove the
parallel win with numbers.

## Explicitly out of scope (kept simple on purpose)

- Cross-issue parallelism beyond what `bd ready` already exposes (the DAG governs it).
- Auto-resolving merge conflicts (we re-queue instead -- deterministic and safe).
- Parallel reviewers (review stays a single pass; it is not the dominant cost).
