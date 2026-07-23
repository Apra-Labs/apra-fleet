# auto-sprint Dispatch Patterns

Architectural decisions governing how `auto-sprint.js` dispatches agents and
shells, recorded so future contributors understand the invariants and do not
re-litigate them.

---

## Core concepts

### dispatchShell vs agent dispatch

The workflow has two dispatch modes:

- **Agent dispatch** -- dispatches a named agent (planner, doer, etc.) with a
  prompt and a model. The agent is a full LLM session that can read files,
  run tools, and reason. Use for tasks that require judgment.

- **dispatchShell(cmds, opts)** -- dispatches a Haiku agent with a
  pre-built list of shell commands and a strict `maxTurns` ceiling.
  `maxTurns` is `cmds.length + 1` by default (`shellMaxTurns(cmds)`).
  The agent runs each command in order and writes outputs. Use for
  deterministic, judgment-free operations.

**The rule:** any block of operations that can be fully pre-specified as a
list of shell commands must be a single `dispatchShell`, not multiple
sequential agent dispatches. Multiple dispatches compound context-switch
overhead and are harder to reason about for `maxTurns` budgeting.

### parallel()

`parallel([...dispatches])` runs a list of dispatches concurrently and waits
for all to complete. Use it whenever two dispatches have no data dependency
on each other. Current parallel groups:

- Cycle start: per-cycle checkpoint write + `checkCycleState` run
- Sprint end: `calibration-update` + `close-sprint-goals`

Downstream operations that depend on the parallel group's results must run
after the `await parallel(...)` call -- not inside it.

### Fire-and-forget (write-only dispatches)

Some dispatches write a single file and do not produce outputs that the
workflow reads. These must be fire-and-forget: dispatched but not awaited.

Current fire-and-forget dispatches:
- `appendNewEntries` -- flushes new sprint-log entries to disk. The file is
  later committed in `beads-export-cleanup` with an unconditional `git add
  sprint-logs/`.
- Dev-loop `commitFeedback` -- writes `feedback.md` only (no commit, no push).
  The file is evicted in `beads-export-cleanup` with `git rm -f` + `rm -f`.

**Invariant:** fire-and-forget dispatches must never commit or push. They
write to disk; the cleanup step owns all git index operations. Mixing
git operations across fire-and-forget and cleanup steps creates index races.

---

## Setup: dispatchShell for deterministic steps

The setup phase has two parts:

1. **Deterministic steps** -- branch creation/checkout, `git pull`, and other
   fixed operations are consolidated into a single `dispatchShell` (named
   `setup-shell`). Outputs are addressed by fixed index, so the workflow
   never needs to parse shell output by position guesswork.

2. **Free-form setup** -- the integ-test-runner agent (which owns
   `integ-test-playbook.md`) executes the playbook's `## Setup` section as
   part of its own dispatch. This is a full agent dispatch with
   `maxTurns: 20` as a backstop (not the default `shellMaxTurns` formula,
   because the command count is not known ahead of time).

---

## Merged dispatches with strict output-index contracts

When a `dispatchShell` produces multiple outputs, every callsite must address
outputs by the exact index they were assigned at dispatch time. Implicit
positional assumptions (e.g. "second output is always headSha") are fragile.

Patterns established this sprint:

- **push + head-sha:** a single `dispatchShell` runs `git push ... && git
  rev-parse HEAD`. The SHA is always at `outputs[1]`.

- **exit-check (getReadyStreaks + countBeadsBlockers):** merged into a single
  `dispatchShell` with an explicit fallback when `outputs.length < rootCount + 2`.
  `parseBlockers` and `parseReadyStreaks` each accept explicit `index` parameters
  so callsites can be updated without hunting implicit assumptions.

- **orphan reset:** in-progress task resets at cycle start are merged into a
  single `dispatchShell([...resetCmds])`. The command list is derived from
  `inProgressIds`; `maxTurns` defaults to `shellMaxTurns(cmds)` which equals
  `inProgressIds.length + 1`. Zero in-progress tasks produces an empty array
  and no dispatch.

---

## Plan-commit: pre-built command list

`write-quote` and `plan-commit` were formerly two separate dispatches.
They are now one `dispatchShell` whose command list is pre-built in
`taskAssignments` by the planner session. This means:

- The command list is deterministic and testable before any dispatch runs.
- `maxTurns` is `planCommitCmds.length + 2` (extra turn for bd export).
- The reviewer still awaits `commitFeedback(...)` which commits and pushes
  (this is the one place a commit+push legitimately lives in a dispatch).

---

## CI watcher: post-PR placement

The `ci-watcher` dispatch was moved from its previous pre-PR position to
after the PR is created. Rationale:

- CI runs are associated with a PR number via `gh run list --pr N`.
  Without a PR the query returns an empty list, causing a false
  `not_configured` classification.
- CI annotates the PR body (via `gh pr comment`) when CI is not green,
  so the annotation target must already exist.

**Classification rule (ci-watcher.md):** if CI runs exist for the branch
but none match the current HEAD SHA, classify as `pending` (CI is running or
queued), not `not_configured`. `not_configured` means no CI runs exist at all
for the PR.

---

## Cycle-start checkpoint

The checkpoint written at the start of each cycle uses `type: 'cycle-start'`,
distinct from the one-time sprint metadata record which uses `type: 'meta'`.
Both records land in the same sprint JSONL file. Consumers that join log
entries to cycles must filter on `type` to distinguish them.

---

## Harvester: sprint analysis as Step 1

The sprint-analysis-write dispatch was removed from `auto-sprint.js`.
Instead:

- The `harvester` agent writes the analysis artifact as its **first action**
  (Step 1 of `agents/harvester.md`) before any other doc updates.
- If the harvester returns `null` (crash or timeout), the JS workflow writes
  `.analysis.md` itself via a `dispatchShell` using the pre-computed
  `analysisText`. This guarantees the artifact is always committed to the
  branch, independent of harvester success.

The analysis file path is `sprint-logs/<branch>-<timestamp>.analysis.md`.

---

## Harvest: dolt push (non-fatal)

After `beads-export-cleanup` commits the beads JSONL export and before PR
creation, the Harvest phase dispatches a Haiku agent to run `bd dolt push`.

Key invariants:

- **Ordering**: dolt-push runs AFTER `beads-export-cleanup` (so the export is
  committed and the Dolt working tree is clean) and BEFORE `harvestPr` (PR
  creation). Reordering breaks the "sync before PR" guarantee.
- **Non-fatal**: the dispatch prompt explicitly instructs "do NOT throw, return
  an error, or abort the workflow". If `bd dolt push` exits non-zero (no remote
  configured, network failure, etc.) the agent logs a warning and returns "OK".
  There is no early-return guard on the result in the calling JS code.
- **Sprint log**: the dispatch uses `phase: 'Harvest'` and `label: 'dolt-push'`
  so its cost is captured in the sprint log and the Execution Summary.

When `bd dolt push` fails, it is always safe to run manually after harvest:

```bash
bd dolt push
```

---

## Sprint Execution Summary

`buildExecutionSummary(logEntries, opts)` is a pure function (inside the
`PURE_FUNCTIONS` block of `auto-sprint.js`) that assembles a markdown
"Sprint Execution Summary" section for appending to `.analysis.md`.

**Inputs:**
- `logEntries` -- the dispatch ledger array `{ cycle, phase, label, model, outTokens, costUsd, ts? }`.
  The `ts` field is optional -- `dispatchLedger` entries carry no timestamp.
  Only entries merged from the committed JSONL log-append carry `ts`.
- `opts` -- `{ cycleCount, goalMet, goal, tasksOpen, openIssueIds, startedAt }`.

**What it emits:**
- Cycle count with parenthetical notes (develop iterations, reviewer CHANGES NEEDED
  rounds, plan re-rounds) derived from dispatch labels.
- Per-phase dispatch/token/cost table (Plan, Develop, Test, Harvest).
- Per-phase wall-clock timing (best-effort -- reports "n/a (no timestamps)" when
  `ts` is absent rather than fabricating durations).
- Failures/retries: labels matching `CHANGES NEEDED`, `feedback-write`, or
  `null-recovery` patterns.
- Remaining risks: `goalMet=false` flag + open issue ids at close.

**Wiring:** appended to `sprintSummary.summaryText` unconditionally at line ~1818,
before the `goalMet`/fallback branch. This means the Execution Summary reaches
`.analysis.md` on BOTH the harvester path and the JS fallback path.

**Per-phase timing limitation:** in production, `dispatchLedger` entries carry no
`ts` field; the timing rows will always emit "n/a (no timestamps)". The JSONL log
does contain `ts`, but it is never merged into `logEntries` at the callsite.
This is a known gap -- timing data degrades gracefully and the section remains
useful for token/cost data. A follow-up is needed to merge JSONL `ts` into
`logEntries` so timing populates.

---

## Develop loop: doer context-limit resilience

Three mechanisms protect the develop loop against doer context exhaustion:

### JIT task close

The doer must call `bd close <id>` immediately after committing each task and
**before** claiming the next one. This is encoded in `agents/doer.md` (step 7
and Rules) and mirrored in the doer dispatch prompt in `auto-sprint.js`.
Rationale: a doer that exhausts its context window mid-streak leaves no
in-progress breadcrumbs for a partial streak; JIT close ensures every completed
task is recorded before the session ends.

### Streak token-ceiling truncation

`truncateStreakToCeiling(streakIds, bucketById, calibration, tier)` returns the
longest in-order prefix of a streak whose summed estimated output tokens stays
at or under `calibration.doer_token_ceiling[tier]`. It always keeps at least one
task. It is a no-op when no ceiling is configured for the tier.

The ceiling is keyed by model tier (`cheap` / `standard` / `premium`), consistent
with the `TIER_*` constants. Default values in `DEFAULT_CALIBRATION` and
`sprint-logs/calibration.json`:

| Tier     | Default ceiling (output tokens) |
|----------|---------------------------------|
| cheap    | 40,000                          |
| standard | 80,000                          |
| premium  | 150,000                         |

**Calibration note:** the per-task estimate (`estFor`) uses
`complexity_buckets.doer_tokens` (S=600 / M=1400 / L=2800 output tokens). With
the standard ceiling at 80,000, truncation rarely fires for typical sprints. The
ceiling is explicitly tunable in `calibration.json` per tier. If context-window
exhaustion remains a problem in practice, lower the ceiling values or switch the
estimate basis to total context tokens.

### Null-return recovery

When the doer dispatch returns `null` (crash, timeout, or forced termination), the
workflow no longer aborts. Instead it:

1. Dispatches a Haiku shell to list all `in_progress` tasks.
2. Resets each to `open` via `bd update <id> --status=open`.
3. Sets `doerNullReset = true` and continues to the next dev-loop iteration
   (`if (doerNullReset) continue;` before the reviewer dispatch).

The dev-loop counter (`devIter`) is incremented before the `continue`, so the
MAX_DEV_ITER=20 bound is always respected and infinite loops are impossible.

---

## Develop loop: progress visibility

### labelTaskIds helper

`labelTaskIds(ids)` formats a task-id list for log messages and agent labels:
- Up to 3 IDs are joined with spaces.
- Four or more IDs become `<first3> +Nmore`.

### Log call sites

The develop loop emits three structured log entries per iteration:

1. **Before doer dispatch** -- `Doer cX-iY: <ids> [model=... est=$...]` -- shows
   which tasks the doer will work and the estimated USD cost.
2. **At dev-iter entry** -- `Dev loop cX-iY: N ready task(s)` -- shows how many
   tasks were ready at the start of this iteration.
3. **After reviewer verdict** -- `Reviewer cX-iY: APPROVED/CHANGES NEEDED -- <ids>`.

Agent labels for doer and reviewer sessions carry the same `<ids>` suffix
(`doer-cX-iY: <ids>`, `reviewer-cX-iY: <ids>`) so session logs are searchable
by task id.

---

## CI pipeline task: dedup guard

When the `not_configured` branch fires at the end of setup (no CI runs found for
the project), `auto-sprint.js` must not create a duplicate "Add CI pipeline"
beads task if one already exists. The guard is:

1. Run `bd search "Add CI pipeline" --status=open --json` first.
2. If any open match is returned, log the existing id and skip `bd create`.
3. If only **closed** matches are returned (or no matches at all), proceed with
   `bd create` as normal.

**Key invariant -- closed-issue case:** a previously closed CI task must NOT
suppress creation of a new one. The guard checks `--status=open` explicitly so
that a resolved prior task never blocks a fresh cycle from filing the task again.

**Tests (test/ci-watcher.test.mjs):** assert search-before-create ordering, that
`--status=open` is present in the search command, and that the already-exists
branch emits the existing id without calling `bd create`.

---

## Exit check: scoped to sprint roots only

`parseBlockers(outputs, rootCount, openListIdx, threshold, rootIds)` accepts an
optional `rootIds` array. When provided, an open issue is counted as a blocker
only when its id appears in `rootIds` (the sprint's root goals), in addition to
satisfying the subtree membership and priority-threshold tests.

Both exit-check callsites pass `rootIds`:

- `countBeadsBlockers` (line ~901) -- used by the cycle-end blocker count.
- The inline exit-check dispatch (line ~1579) -- used by the goal-met decision.

**Why this matters:** without scoping, a non-root P1 issue anywhere in the beads
database would block `goalMet` even if the sprint never targeted it. The sprint
should exit (goal met) once all its root goals and their subtrees are closed,
regardless of unrelated open issues in the DB.
