# Amendments to planned v0.5 wave-plan sprints

Applies to `docs/planning/v05-dashboard/sprint-plan.md`. When a sprint below is
launched, append its section to the sprint's requirements file or epic
description. Rationale: `docs/director/08-queue-and-groomer.md`,
`09-v05-execution-plan.md`.

## Migrations and db.mjs ownership (all sprints)

Migration numbers are pre-assigned; tests must not assume any other numbering:

| number | sprint | wave | contents |
|---|---|---|---|
| 001 | S3 (landed) | 1 | projects, member_git (the plan's `002-member-git.mjs` never landed; member_git is in 001) |
| 002 | D1a | 4 | director tables |
| 003 | S13 | 5 | sprints, role_assignments, transitions (+ amendment fields) |
| 004 | S19 | 7 | runs, history, events, stats, mutex, child ids (+ os columns) |
| 005 | S24 | 8 | groomer_runs, groomer_items |

`src/projects/store/db.mjs` registers migrations in a static list, so it is a
hot file with one owner per wave: w4 D1a, w5 S13, w7 S19, w8 S24.

---

## S13 - sprint definition, roleMap, ready (+2 h)

- `projects.default_role_map` (JSON, same shape as a sprint roleMap; members
  carry the project's owner tag; backlog role excluded). `POST .../ready` with
  no sprint roles inherits it; `no-members-assigned` only when both are empty.
  Route `PUT /api/projects/:id/default-role-map`.
- `transitions` rows for hold/release/order carry
  `{by: operator|director|system, reason, decisionId|null}`.
- Order fields on `sprints`: `pinned_at`, `operator_position`, `director_rank`,
  `ready_at`; consume-order function in `src/projects/order.mjs` with a test per
  level (`08` section 2.3).
- Store API `setDirectorRank(project, [definitionId...], decisionId)` that
  writes level 3 only and records transitions; it never touches pinned or
  operator-positioned entries.
- `autoqueue: true` on definitions whose epic carries the `autoqueue` label.

## S19 - sqlite ledger and instances (+0.5 h)

- Migration 004 adds `runs.os_doer` and `runs.os_reviewer` (nullable text).

## S21 - sprints UI runs (+2 h)

- History: last 5 terminal runs by default, "load more".
- "Relaunch" prefills a new definition from a stored run; normal validation.
- "Clone and amend" for `open`/`ready`/`waiting`/`paused` definitions creates
  an independent definition.
- No edit controls on running definitions; the API refuses edits on running
  definitions with 409 (server-side test).

## S22 - scheduler (unchanged)

Built as planned. D9 (wave 9) adds the policy check, member events,
anti-starvation, OS rotation, pause-to-waiting and launch-list absorption on top.

## S24 - groomer page (+1 h)

- `backlog-groomer-input.json` gains optional `capacity`, `queue`, `vision`,
  `autoqueueEpics` (schema + target-neutral role prompt text; boundary guard
  green). The review page is unchanged; D10 adds producer mode.
- Migration number 005.

## S25 - doctor, notify, backup, stats (+2 h)

- Notification: use the D1b notifier and D4b digest only; remove "email via
  sendEmail" from S25's own scope.
- Doctor: implement sprint-doctor `pause_for_human` so a paused run publishes
  `humanActionRequired {question, options}`; emit `run.paused_for_human`
  through the D1a event store.
- Resume with an answer: the live resume route accepts `{answer}` and passes it
  to the engine's pre-resume hook (today it forwards only a reason string);
  sprint-doctor reads it.
- Router module for P11 (`03`): gate from the published question; resume as
  class `resume_run` on answer.
- Backup: the director tables are in `supervisor.sqlite`; assert they are in
  the nightly `VACUUM INTO` copy.
