# Director: v0.5 execution plan (build the director with the director concept)

Status: DRAFT plan, v0.5. Companion to `docs/planning/v05-dashboard/sprint-plan.md`
("the wave plan"). It does not replace the wave plan: it adds two director
lanes, amends five planned sprints, and changes HOW the remaining v0.5 work is
run - under a written vision and policy, with each director piece switched on
the day it merges.

---

## 1. Where v0.5 stands (2026-11-02)

- Landed on `v0.5_dashboard` (by file presence): waves 1-3 (S1-S9) and S12,
  the `m1-*` stabilization series, the `/fleet-status` mod (#746, #752), and
  the Finalization CI gate with one extension cycle (0b516ed3, 76cccc07).
- Remaining in the wave plan: S10, S11 (wave 4); S13-S15 (5); S16-S18 (6);
  S19-S21 (7); S22-S24 (8); S25-S27 (9).
- Observed bottleneck: the wave plan assumes merges within about 2 h of PASS
  (assumption A4). Actual: PASS PRs wait weeks (#676 PASS 2026-10-06, open on
  2026-11-02). Every wave gates on its slowest merge.

## 2. Principles for running the rest of v0.5

1. **Dogfood from the first director sprint.** Each piece is switched on for
   the apra-fleet project when it merges; the remaining v0.5 sprints run under it.
2. **Unblock merging early.** The classifier starts `silent` as soon as D3b
   lands because its rollout needs 30 classified PRs.
3. **No parallel queue.** #410 is S13/S21/S22 + D9; the only interim mechanism
   is D1b's operator-written launch list, absorbed by D9.
4. **Generic engine.** Role prompts and engine changes stay target-neutral;
   apra-fleet specifics live in `.fleet/vision.yaml` / `.fleet/policy.yaml`.
5. **Policy decides, LLM proposes** (I1) from the first line of code.
6. **One owner per hot file per wave**, including `src/projects/store/db.mjs`.

## 3. Director sprints

Requirements files in `docs/director/sprints/`, usable as `--requirements-file`.
Estimates in the wave plan's units (engine-hours, target <= 12).

| key | title | spec | depends on | est h | v0.5 |
|---|---|---|---|---|---|
| D1a | Event backbone: onTerminal hooks, event store, migration 002, director seam, runner result fields | `03` 2-3.1 | -- | 10 | required |
| D1b | Weekend kit: notifier, launch list, breaker, baseline script | `03` P13, `04` 3 (transport) | D1a | 8 | required |
| D2a | Policy engine, schemas, loader (bare mirror), risk ledger, decision store, API, operator credential | `02` | D1a | 12 | required |
| D2b | Event router core + P3/P4/P5 + nightly timer | `03` 4-5 | D2a, D1b | 8 | required |
| D3a | Forge client (read) + PR/branch events + P1/P6/P10 | `05` 3, `03` | D2a | 10 | required |
| D3b | Risk classifier: pre-rules, model, silent/visible, stats, demotion store | `05` 2 | D3a | 10 | required |
| D4a | Gates: store, policy integration, answer API, re-evaluation, expiry, P9 | `04` 1-2 | D2a, S11 | 10 | required |
| D4b | Digest, operator modes, delegates, gates in `/fleet-status` and dashboard | `04` 3-4 | D4a, D1b | 10 | required |
| D5 | Director role: prompt, schemas, client, P2, weekly review, agreement | `06` | D2a, D4a, S13 | 12 | required |
| D9 | Scheduler integration on S22: policy launch check, member.freed/idle, anti-starvation, OS rotation, pause -> waiting, absorb launch list | `08` 2, `07` 3 | S22, D2a, D1b, D4a | 10 | required |
| D7 | Phases API, dogfood instance counter, canary + exact-build rollback, skew indicator | `07` 1-2 | D2a, S19 | 10 | recommended |
| D6a | Merge worker + stage enforced + PR body / pm R12 wording + kill-switch demotion | `05` 2.3-3 | D3b, D4a | 10 | required |
| D8 | Filler on member.idle, OS-exercise statistics, GitHub intake, kb_reconcile after merge | `07` 3.4/4, `03` P12 | D9, D2b | 10 | optional |
| D6b | Parallel / stacked PRs while merges are blocked; backpressure on HIGH only | `05` 4 | D6a, D9 | 8 | optional |
| D10 | Groomer producer: triggers, parsed actions, quality bar, idempotency, delivery tracking | `08` 3 | S24, D9, D4a, D2b | 10 | recommended |

Required set: about 100 engine-hours. All: about 148.

## 4. Amended wave-plan sprints

Details in `sprints/S-amendments.md`.

| sprint | amendment | added est h |
|---|---|---|
| S13 | project default role map; order fields + audit; `setDirectorRank` store API; migration 003 | +2 |
| S19 | `runs.os_doer`, `runs.os_reviewer` columns in its migration 004 | +0.5 |
| S21 | history relaunch / clone-and-amend; running definitions not editable | +2 |
| S24 | groomer input schema gains `capacity`, `queue`, `vision`, `autoqueueEpics`; migration 005 | +1 |
| S25 | notification via D1b/D4b only; sprint-doctor `pause_for_human` -> `run.paused_for_human`; resume route accepts `{answer}`; P11 | +2 |

S22 is unchanged; D9 builds on it in the next wave.

## 5. D0: operator day-0 setup (manual)

1. **Clear the merge backlog** into `v0.5_dashboard` (at least #676).
2. **Confirm the remaining wave-plan sprints exist as beads** (the plan's keys
   are converted mechanically later). Create the missing epics from the plan's
   DAG tables. Label wave-plan epics `objective:v05-console`, director-lane
   epics `objective:fleet-autonomy`.
3. **Write `.fleet/vision.yaml` and `.fleet/policy.yaml`** on `v0.5_dashboard`
   from `docs/director/examples/apra-fleet.*.yaml` (inert until D2a; writing
   them now forces the weights and limits to be decided up front).
4. **Phase** `open_window` (users have 0.4.5 from `main`).
5. **Lanes**: two members beyond fleet-mac1/lin1/win1 for director lanes A and
   B (any OS; D9 will rotate them). With one extra member, run lane B's
   sprints after lane A's in the same order (adds about 5 waves). In wave 4,
   fleet-mac1 is free (S12 landed) and takes D1a.
6. **Merge cadence until D6a**: twice daily, driven by D1b's emails.
7. **Notify config** in `supervisor.config.json` (`notify`, D1b) and the
   `sendgrid_api_key` or `smtp_password` credential.

## 6. Wave placement and hot-file ownership

Migrations are pre-assigned (no "next free number"): 002 D1a, 003 S13, 004 S19,
005 S24. `src/projects/store/db.mjs` (static `MIGRATIONS` list) owners: w4 D1a,
w5 S13, w7 S19, w8 S24. Director modules register by file discovery in
`src/director/modules/` (created by D1a), so no later sprint edits a shared
registration list.

| wave | wave plan | lane A | lane B | hot files owned by the director sprint |
|---|---|---|---|---|
| 4 | S10, S11 | D1a (fleet-mac1) | -- | `bin/serve.mjs`, `src/supervisor/watchdog.mjs`, `src/supervisor/reconcile.mjs`, `fleet-sprint/runner.js` (result fields), `terminal-reasons.mjs`, `run-outcome.mjs`, `db.mjs` |
| 5 | S13, S14, S15 | D1b | D2a | D2a: `packages/apra-fleet-se/package.json` (add `yaml`) |
| 6 | S16, S17, S18 | D2b | D3a | none (new files) |
| 7 | S19, S20, S21 | D3b | D4a | D4a: `src/projects/beads/verbs.mjs` (allowlist) |
| 8 | S22, S23, S24 | D4b | D5 | D4b: `plugins/claude-code/fleet-status/**`; D5: `docs/fleet-sprint-getting-started.md`, `scripts/check-generic-boundary.mjs` (target file contract) |
| 9 | S25, S26, S27 | D9 | D7 | D9: `src/supervisor/scheduler.mjs`, `src/supervisor/api.mjs`, `src/projects/sprints.mjs`; D7: `src/services/member-fleet-install.ts`, client `api.mjs` (parity). D7 MUST NOT edit `watchdog.mjs` (S25) |
| 10 | -- | D6a | D8 | D6a: `fleet-sprint/pr-body.mjs`, `apra-pm/skills/pm/SKILL.md` |
| 11 | -- | D6b | D10 | D6b: `src/supervisor/scheduler.mjs`; D10: `apra-pm/agents/backlog-groomer.md` |

S26/S27 (end-to-end) stay in wave 9. If the operator wants the release to
include enforced auto-merge, re-run the S26/S27 regression after D6a.

## 7. Switch-on schedule (dogfooding the director while building it)

| merged | switch on for apra-fleet | effect on the remaining work |
|---|---|---|
| D1a | events recorded | baseline data starts |
| D1b | emails on every terminal event; launch list with the next wave's sprints; breaker | weekends run the launch list; the operator learns of every end within minutes |
| D2a | policy evaluation, `director.enforce: false` (decisions logged only) | one week of decisions to compare with reality |
| D2b | router playbooks P3-P5 (enforce still false) | transient aborts relaunch once (operator-written list entries only) |
| D3a | forge watcher | PR and CI events visible; PR counts feed backpressure |
| D3b | classifier `silent` | verdicts accumulate toward 30 PRs |
| D4a | gates; set `director.enforce: true` | policy now acts: `propose` becomes gates with defaults |
| D4b | daily digest; operator mode `light` | one message a day replaces checking |
| D5 | director `rank`, `diagnose`, `recommend`, weekly review | proposals with evidence; agreement metric starts |
| D9 | scheduler under policy; launch list retired | sprint definitions are the queue; member.freed launches immediately; OS rotation on |
| D7 | dogfood instance for apra-fleet; phases | v0.5 promotion gated on dogfood hours |
| D6a | classifier `visible`, then `enforced` once its exit criterion holds | LOW PRs merge without the operator |
| D8 | filler and GitHub intake | idle members do no-PR work; issues become triage beads |
| D6b | parallel PRs while merges are blocked | progress continues during review waits |
| D10 | groomer producer, `autoqueue` on the director-lane epic first | the queue refills itself for one objective, then more |

## 8. How we know it works (reported in the digest from D4b on)

| metric | source | baseline | target by v0.5 release |
|---|---|---|---|
| member utilization (reserved minutes / day) | ledger history | D1b baseline script | >= 3x baseline |
| gap latency (terminal -> next launch, same lane) | history | D1b baseline script | < 30 min median |
| PASS-to-merge time | forge | weeks (#676) | < 4 h median for LOW |
| gates per day needing the operator | gate store | -- | < 5 |
| director/operator agreement | decision store | -- | >= 90% on `rank` and `recommend` |
| reverted auto-merges | steward | -- | 0 |
| weekend sprints completed without operator action | history | 0 | >= 4 per weekend |

## 9. v0.5 release criteria additions

- Required director sprints merged and switched on for apra-fleet.
- Dogfood: >= 40 sprint-hours on the dogfood instance running the v0.5
  candidate, zero attributed regressions (D7 counter; before D7, computed by
  the D1b baseline script from the dogfood instance's history).
- Merge steward at least `visible` with >= 30 classified PRs.
- `docs/director/` updated to "as built" (each sprint marks its section
  IMPLEMENTED and corrects what changed).

## 10. Risks specific to this plan

| risk | mitigation |
|---|---|
| Hot-file collisions with the wave plan | section 6 table; module discovery; pre-assigned migrations |
| Director built on a preview-grade supervisor | S19/S23/S25 reliability work lands before D6a (auto-merge) and D7 (canary); `enforce` stays false until D4a |
| Policy mistakes widen authority | policy read only from the remote ref via the supervisor's mirror; `.fleet/**` diffs always HIGH; operator credential for operator-only routes |
| Classifier too permissive | silent -> visible -> enforced with numeric exit criteria; automatic demotion record |
| Review load rises with throughput | backpressure; filler never opens PRs |
| Scope growth | required vs recommended vs optional column in section 3; optional sprints may move to 0.5.x |
