# D1a - Event backbone: terminal hooks, event store, schema, director seam

Usage: `--requirements-file docs/director/sprints/D1a-event-backbone.md`
Branch: `feat/v05-d1a-event-backbone` off `v0.5_dashboard`. Wave 4, lane A
(fleet-mac1). Specs: `01-concepts.md`, `03-events-and-playbooks.md` sections
2, 3, 3.1. Depends on: nothing.

## Goal

Every terminal outcome of every sprint becomes a durable, replayable event,
and the supervisor has one seam and one schema migration that all later
director sprints build on without editing shared files.

## Context (v0.5_dashboard @ 9155db68)

- `createWatchdog` (`src/supervisor/watchdog.mjs` ~605) takes injectable deps;
  `recordFinished` is called once per sprint on FINISHED (~958-971);
  CRASHED goes through `recordTerminalError`; LAUNCH_FAILED (~915-937) calls
  neither. `releaseTerminalReservation` (~747) releases members; the ledger is
  readable just before (~749-751). Constructed in `bin/serve.mjs` ~782.
- `reconcile()` (`src/supervisor/reconcile.mjs` ~154) releases children that
  died during a supervisor restart (`aborted-by-restart`) without
  `recordFinished`.
- The runner's success result (`fleet-sprint/runner.js` ~4045-4062) lacks
  `prUrl`/`prNumber`/`costUsd`; the abort terminal extension (~4251-4261) has
  `prUrl` but no cost. `BUDGET_EXCEEDED` is absent from
  `src/supervisor/terminal-reasons.mjs` (classed engine-bug).
- `supervisor.sqlite` store: `src/projects/store/db.mjs` with a static
  `MIGRATIONS` list; `001-projects.mjs` exists.

## Requirements

R1. `deps.onTerminal(kind, info)` on `createWatchdog`, called exactly once per
sprint per kind for FINISHED, CRASHED, LAUNCH_FAILED, and once per member
released by `releaseTerminalReservation`. `info` carries sprintId, the ledger
snapshot (members, issue roots, branch) taken BEFORE release, and the parsed
terminal state. `reconcile()` accepts the same callback and calls it for
restart-time releases with verdict ABORTED, terminalReason
`aborted-by-restart`. A throwing callback is logged and never changes
classification or release.

R2. Director seam: `src/director/index.mjs` exports
`registerDirector(supervisor, deps)`, which loads every module file in
`src/director/modules/*.mjs` (sorted by file name) and calls its exported
`register(ctx)`. `bin/serve.mjs` calls `registerDirector` once and passes its
`onTerminal` into `createWatchdog` and `reconcile`. Later sprints add modules
as new files only.

R3. Migration `002-director.mjs` (registered in `db.mjs`) creating:
`director_event`, `risk_week`, `decision`, `project_phase`,
`project_phase_history`, `os_exercise`, `merge_state`, `objective_progress`,
with the columns in `02` sections 5-6, `03` section 2, `07` sections 1 and 3.1,
`05` section 2.3 (merge_state: project, demoted_stage, reason, at, cleared_by),
`08` section 3.4 (objective_progress: project, objective, week, beads_closed,
verified_closures, sprint_hours, usd). Number 002 is reserved for this sprint.

R4. Event store `src/director/events.mjs`: `emit(event)` persists to
`director_event` with a dedupe key, then dispatches to in-process subscribers;
on start, unrouted events are delivered once. Events emitted by this sprint:
`run.finished`, `run.crashed`, `run.launch_failed`, `member.freed`.

R5. Runner result fields: success result includes `prUrl`, `prNumber` (when a
PR was raised) and `costUsd` (`number | null`, the tracked spend already shown
in the PR body); the abort terminal extension includes `costUsd`. Target-neutral
(boundary guard green).

R6. `BUDGET_EXCEEDED` added to `terminal-reasons.mjs` as class `budget`;
`run-outcome.mjs` treats it as failed.

## Acceptance

- Watchdog tests with a recording `onTerminal`: exactly one call per kind per
  sprint; member/root snapshot present for FINISHED; LAUNCH_FAILED covered;
  throwing callback does not alter classification.
- Reconcile test: restart-time release produces `run.finished` with
  `aborted-by-restart`.
- Event store tests: persisted before dispatch; replay after simulated crash
  delivers once; duplicate emit ignored.
- Migration test: 002 applies on a 001 database and is idempotent on reopen.
- Runner tests for the three result fields (including `costUsd: null`).
- Terminal-reasons test for `budget`.
- Seam test: a module file dropped in `modules/` is registered without editing
  any other file.

Constraints: ASCII only; bounded test runner; no shell variable expansion in
member-bound commands. Estimate 10 h. Tier: premium R1-R2, standard otherwise.
