# Director: events, event router and playbooks

Status: DRAFT spec, v0.5. Vocabulary: `01-concepts.md`. Code references are
against `v0.5_dashboard` @ 9155db68.

---

## 1. Scope boundary with sprint-doctor

- **Inside a sprint** (a bead keeps failing, a member is sick, stagnation inside
  cycles): owned by the engine and by sprint-doctor
  (`packages/apra-fleet-se/fleet-sprint/docs/escalate-to-llm-design.md`,
  design only today). The director does not intervene in a running sprint.
- **Between sprints** (a sprint ended, a PR is waiting, CI is red after
  publish, a member is free, a gate expired, a phase changed): owned by the
  event router and the director.
- One crossing point: sprint-doctor's `pause_for_human` becomes a director
  event (`run.paused_for_human`) so the question reaches the operator as a
  gate instead of an unwatched paused run.

## 2. Event envelope

```
{ id, at, project, type, subject: {kind, id}, data: {...}, source }
```

Persisted in `supervisor.sqlite` table `director_event` (append-only) before
routing, so a supervisor restart replays unrouted events. Routing is
idempotent per `(type, subject.id, data.dedupeKey)`.

## 3. Event catalog

| type | produced by (where) | data | urgent |
|---|---|---|---|
| `run.finished` | new watchdog `deps.onTerminal(kind, info)` callback invoked on FINISHED (beside `recordFinished` ~958-971), and from `reconcile()` (`reconcile.mjs` ~154) when it releases a child that died during a supervisor restart (verdict ABORTED, terminalReason `aborted-by-restart`) | sprintId, issueRoots, members (from `ledger.get(sprintId)` BEFORE `releaseTerminalReservation`), verdict, terminalReason, class (from `terminal-reasons.mjs`), branch, baseBranch, prUrl, costUsd (number or null) | no |
| `run.crashed` | `deps.onTerminal` on CRASHED (`recordTerminalError` path) | sprintId, reason | yes |
| `run.launch_failed` | `deps.onTerminal` on LAUNCH_FAILED (inline branch ~915-937, which calls neither recordFinished nor recordTerminalError today) | sprintId, reason | yes |
| `run.paused_for_human` | produced by S25 (sprint-doctor `pause_for_human`): watchdog PAUSED classification (~862-874) when the run published `humanActionRequired` | sprintId, question, options | yes |
| `member.freed` | `deps.onTerminal` after `releaseTerminalReservation` (~747) succeeds, once per released member | member, previous runId | no |
| `member.idle` | scheduler (D9) when a free member has no eligible ready work | member, reason (no_ready_work / backpressure / budget / breaker / merge_blocked) | no |
| `pr.ci_changed` | merge steward forge poll | pr, sha, state (green/red/infra/pending) | red on integration branch only |
| `pr.review_changed` | merge steward forge poll | pr, approved/changes/commented, by | no |
| `pr.merged` / `pr.closed` | merge steward | pr, sha, by (steward/human) | no |
| `pr.conflicted` | merge steward | pr, base sha | no |
| `pr.reverted` | merge steward (revert commit referencing a fleet PR on the integration branch) | pr, revert sha | yes |
| `branch.ci_changed` | merge steward poll of the integration branch head | sha, state | red: yes |
| `gate.answered` / `gate.expired` / `gate.obsolete` | gate store / tick | gateId, option, by | no |
| `queue.low` | scheduler tick: ready entries < `policy.queue.min_ready` (default 2) | count | no |
| `phase.changed` | operator API / release playbook | from, to | no |
| `policy.changed` | integration branch head moved and `.fleet/*.yaml` changed | old/new hash, valid | invalid: yes |
| `budget.exhausted` / `budget.replenished` | risk ledger | counters | exhausted: yes |
| `breaker.tripped` | event router (consecutive failures) | count, last runs | yes |
| `intake.received` | intake adapters (GitHub issue, email; later Slack) | source, ref, title | no |
| `timer.digest` / `timer.nightly` / `timer.weekly` | supervisor clock | -- | no |

### 3.1 Required engine/supervisor changes to produce these (D1a unless noted)

- **onTerminal callback**: `createWatchdog` accepts `deps.onTerminal(kind,
  info)` called exactly once per sprint per terminal kind (FINISHED, CRASHED,
  LAUNCH_FAILED) and once per released member; `reconcile()` accepts the same
  callback for restart-time releases. A throwing callback is logged and never
  affects classification.
- **prUrl on success**: the runner's success result (`runner.js` ~4045-4062
  `state.result`) carries no `prUrl`; it is only rendered by the viewer. The
  result MUST include `prUrl` (and `prNumber`) so `run.finished` can carry it.
- **costUsd**: the terminal record carries no cost. The runner MUST persist its
  tracked spend (the figure already rendered in the PR body "Cost" block) into
  `state.result.costUsd` and into the abort terminal extension, as
  `number | null` (null when the workflow budget tracker is unavailable).
- **BUDGET_EXCEEDED** (thrown as `BudgetExceededError`, typed abort) is missing
  from `terminal-reasons.mjs` and is therefore classed engine-bug. Add it as
  class `budget`.
- **Ledger snapshot before release**: the terminal hook MUST read members and
  issue roots from the ledger before `releaseTerminalReservation` runs (same
  pattern as ~749-751).

## 4. Router

Module: `packages/apra-fleet-se/src/director/event-router.mjs`. Deterministic.
For each event: select playbook -> build candidate actions -> evaluate each
through the policy engine -> execute / gate / refuse -> record decisions ->
debit risk on known outcomes.

LLM involvement is limited to the steps explicitly marked (LLM) below; each is
a call to the director role (`06-director-agent.md`) that returns a proposal,
never an execution.

## 5. Playbooks

### P1 `run.finished` with verdict PASS
1. Record outcome; credit the objective's progress measures.
2. Hand the PR to the merge steward (`05-merge-steward.md`).
3. Post-merge (on `pr.merged`): run kb-reconcile for the merged branch when the
   project enables the KB (class `kb_reconcile`; today a manual
   `/pm kb-reconcile` step; issue #433).
4. Ask the scheduler for the next entry (P8).

### P2 `run.finished` NOT MET (FAIL / CHANGES_NEEDED) or ABORTED, class judgement or budget
1. Debit `wasted_sprints` if the run was director-launched.
2. Breaker check: if this is the Nth consecutive failure for the project
   (`breaker_consecutive_failures`), emit `breaker.tripped` and stop.
3. (LLM) Director diagnoses: inputs = PR body, reviewer notes, set-aside
   beads, terminal reason. Proposal is one of: `relaunch_same`,
   `relaunch_reduced_scope{roots}`, `design_spike{root}`, `defer{roots}`,
   `ask{question, options}`.
4. Evaluate: `relaunch_*` and `design_spike` -> class `retry_after_abort`
   (cap `max_per_root`); `defer` -> `groom_mutation`; `ask` -> gate.

### P3 `run.finished` ABORTED, class deterministic
Relaunch gate rules stay as today (only BEADS_SYNC_CONFLICT is gated by the
supervisor). Router action: gate `propose_blocking` with the terminal reason,
the remedy text from the existing error classification, and options
`relaunch_with_override` / `defer`. Never auto-relaunched.

### P4 `run.finished` ABORTED, class transient
One automatic relaunch (`retry_after_abort`, counts against the cap), after the
condition clears (usage-limit: after the reset time; sync failures: next tick).
Second transient failure on the same root -> P2 step 3.

### P5 `run.crashed` / class engine-bug
Never relaunch. Create a `propose_blocking` gate on the root; urgent notify.
If `policy.report_engine_bugs.tracker` names a tracker AND that tracker's
project has the same tenant as this project, file a bug there (class
`file_bead`, crash summary only, no target code or data). Otherwise the crash
summary goes to the digest only; client data never crosses tenants.

### P6 CI after publish
The engine already gates CI at Finalization (`fleet-sprint/ci-gate.mjs`, one
extension cycle by default, `--max-extensions`). The router handles what is
left AFTER the PR exists:
- `pr.ci_changed` red on a fleet PR whose run ended: queue a `ci_fix_sprint`
  (branch = the PR branch, scope = the auto-created "Fix CI" bead), cap
  `max_per_pr`.
- red with `infra` (FAILED-TO-RUN, runner/forge outage): no fix sprint; mark
  the project `ci_infra_outage` for the parallel-PR rule; notify once.
- `branch.ci_changed` red on the integration branch: set `integration_red`;
  scheduler pauses feature launches; queue one P0 fix sprint scoped to the
  failing jobs (class `ci_fix_sprint`, cap `max_per_branch_red` per red
  episode; cap reached -> `propose_blocking` gate); urgent notify.

### P7 `member.freed`
Ask the scheduler to evaluate (P8). If nothing is eligible, the scheduler emits
`member.idle` with the reason; the digest's Fleet section reports it and the
filler dispatcher (`07` section 4) consumes it.

### P8 Next-sprint selection (scheduler tick, also on `queue.low`)
Deterministic first: the scheduler (v0.5 S22, amended in `08-queue-and-groomer.md`)
consumes the ready queue in its documented order. The director's ranking
(LLM, weekly and on `queue.low`) only reorders entries that the operator has
not pinned. Launch goes through the policy engine as `launch_sprint.*`.

### P9 `gate.answered` / `gate.expired`
Execute the option's effect with authority from the answer (`04` section 2).

### P10 `pr.reverted`
Debit `reverted_merges`; merge steward kill switch (demotion record, `05`
section 2.4); file a bead "investigate revert of PR N" linked to the original
roots (class `file_bead`); urgent notify.

### P11 `run.paused_for_human` (built in S25)
Create a gate from the published question and options; on answer, resume the
run (class `resume_run`). Today `/live/resume` forwards only
`requestResume(reason)` with no payload; S25 extends the resume route to accept
`{answer}` and pass it to the engine's pre-resume hook, which sprint-doctor
reads.

### P12 `intake.received`
Create a triage bead (class `file_bead`; status open, label `triage`,
`external_ref` = source) after a duplicate check against open beads. Never
ready, never scheduled until groomed (I7).

### P13 Timers
- `timer.digest`: build and send the digest (`04` section 3).
- `timer.nightly`: risk-ledger housekeeping, stale gate sweep (`gate.obsolete`),
  utilization snapshot, groomer run if the queue is below target.
- `timer.weekly`: risk-budget replenish/growth; (LLM) director weekly review
  (`06` section 4).

## 6. Which sprint builds what

| item | sprint |
|---|---|
| event store, onTerminal/reconcile hooks, `run.*`, `member.freed` | D1a |
| notifier, launch list, breaker (interim P8) | D1b |
| router core (dispatch table, idempotency, replay), P3, P4, P5, `timer.nightly` | D2b |
| forge watcher, `pr.*`, `branch.ci_changed`, P1 (record + hand-off), P6, P10 | D3a |
| P9, gate expiry sweep in `timer.nightly` | D4a |
| `timer.digest` | D4b |
| P2, `timer.weekly` director review | D5 |
| P8 under policy, `member.idle`, `queue.low` | D9 |
| P11 | S25 (amended) |
| P12, filler on `member.idle`, `kb_reconcile` after merge | D8 |
| merge execution in P1 | D6a |

## 7. Acceptance

- Every event type has a fixture and a router test asserting the resulting
  decisions (mode + rule) under a fixture policy.
- Replay test: kill the supervisor between persist and route; on restart the
  event is routed exactly once.
- The runner result carries `prUrl` and `costUsd` (engine test).
- `BUDGET_EXCEEDED` is classified `budget` (terminal-reasons test).
- Breaker test: N consecutive failures trip the breaker and stop launches
  until reset or a PASS.
