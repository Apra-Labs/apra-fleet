# D9 - Scheduler integration on S22: policy, member events, rotation, pause

Usage: `--requirements-file docs/director/sprints/D9-scheduler-integration.md`
Branch: `feat/v05-d9-scheduler-policy` off `v0.5_dashboard`. Wave 9, lane A.
Spec: `08-queue-and-groomer.md` sections 2.2-2.4; `07` section 3.2.
Depends on S22, D2a, D1b, D4a.

## Requirements

R1. Launch path in `src/supervisor/scheduler.mjs`: consume order (`08` 2.3) ->
policy engine `launch_sprint.*` (`propose` -> gate and skip; `forbid` -> skip
with reason) -> merge-blocked check (stub "not blocked" until D6b;
`integration_red` from D3a honoured) -> member union free -> OS rotation among
interchangeable pool members -> existing launch guards.

R2. Immediate evaluation on `member.freed`; emit `member.idle {member, reason}`
when nothing is eligible; emit `queue.low` when ready entries <
`queue.min_ready`.

R3. Anti-starvation `reserved-next` rule with tests (`08` 2.2).

R4. OS rotation (`07` 3.2): modes off/random/weighted_least_recent with
`random` fallback while `os_exercise` is empty; cross-OS reviewer placement;
record `runs.os_doer`, `runs.os_reviewer` (S19 columns) and bead `metadata.os`.

R5. Pause route returns the definition to `waiting` with reason `paused`;
resume relaunches from waiting (`08` 2.4).

R6. Absorb D1b's launch list: on first start, `launchList` entries become
`ready` sprint definitions with operator positions preserved; the launch-list
API becomes an adapter over definitions; D1b's launch-list tests pass against
the adapter.

## Acceptance

`08` section 4 S22 rows, OS selection tests (`07` section 5), launch-list
adapter tests, `member.idle` reasons.

Estimate 10 h. Tier: premium R1/R3, standard otherwise.
