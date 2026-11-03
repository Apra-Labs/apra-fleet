# D2b - Event router core, playbooks P3/P4/P5, nightly timer

Usage: `--requirements-file docs/director/sprints/D2b-event-router.md`
Branch: `feat/v05-d2b-event-router` off `v0.5_dashboard`. Wave 6, lane A.
Spec: `03-events-and-playbooks.md` sections 4, 5 (P3, P4, P5, P13 nightly).
Depends on D2a, D1b.

## Goal

A deterministic router that turns events into policy-evaluated actions, with
the abort playbooks that need no LLM.

## Requirements

R1. `src/director/event-router.mjs`: dispatch table event type -> playbook;
idempotent per dedupe key; every candidate action built with a class from
`02` 3.1, evaluated by the policy engine, then executed / gated (gate creation
deferred to D4a: until then `propose` is recorded as `gated-pending` and the
operator is notified) / refused; decisions recorded; risk debited on known
outcomes. Playbooks are module files under `src/director/playbooks/` loaded by
file discovery.

R2. P3 deterministic aborts: never relaunched; notification (gate after D4a)
with the existing remedy text.

R3. P4 transient aborts: one relaunch (`retry_after_abort`, cap
`max_per_root`) after the condition clears (usage-limit reset time; next tick
for sync failures); second transient failure on the same root escalates per P2
(recorded as `needs-diagnosis` until D5).

R4. P5 engine-bug / crash: never relaunched; tenant-checked bug filing
(`file_bead`) only when `report_engine_bugs.tracker` names a tracker of the same
tenant; otherwise digest/notify only.

R5. Breaker from D1b reused for router-launched relaunches.

R6. `timer.nightly`: risk-ledger housekeeping, utilization snapshot, stale
`gated-pending` sweep.

## Acceptance

- Router: every event type in the D1a set routed under a fixture policy with
  expected decisions (mode + rule); replay after crash routes once.
- P3/P4/P5 cases including cap exhaustion and the cross-tenant refusal for P5.
- With `director.enforce: false`, decisions are `logged` and no relaunch happens.

Estimate 8 h. Tier: standard.
