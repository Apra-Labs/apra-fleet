# Director: autonomous direction of fleet work under written vision and policy

Status: DRAFT specification set for v0.5 (2026-11-02). Target branch:
`v0.5_dashboard`. Owner: operator. Supersedes nothing; amends five sprints of
`docs/planning/v05-dashboard/sprint-plan.md` and closes issues #410 and #22.

## Why

fleet-sprint runs long plan -> develop -> review -> deploy -> harvest streaks
without a human. Between sprints, nothing does: a human chooses scope,
launches, reads the PR, merges, reacts to red CI and decides what is next.
The result is members idle and token allowance unused, and work that stops on
weekends, family time and vacations.

Measured facts that shaped this design (v0.5_dashboard @ 9155db68):
- No component chains one sprint to the next; launches are explicit API calls.
- No notification of any kind is sent when a sprint ends.
- Every PR merge is manual by rule ("Do NOT auto-merge", pm skill R12); the
  wave plan assumes merges within 2 h, while PASS PRs actually wait weeks.
- Beads has a `gate` issue type that nothing uses; human decisions are not data.
- Budgets exist per sprint (`--budget`) but nothing enforces spend across
  sprints or projects.

## The idea in five lines

1. The operator writes a **vision** (objectives, weights, ordered trade-offs,
   non-goals) and a **policy** (what may be done without asking, per release
   phase, with caps) per project, in git.
2. Deterministic code turns events (sprint ended, PR green, member free, gate
   expired) into candidate actions.
3. A **policy engine** decides each action's authority: do, do-and-notify,
   propose (gate with a default and an expiry), propose-blocking, forbid.
4. An LLM **director** role only PROPOSES: queue ranking, failure diagnosis,
   gate recommendations with evidence, a weekly review.
5. A weekly **risk budget** (wasted sprints, reverted merges, defaults fired,
   dollars) bounds the damage of autonomy and grows with a clean record.

## Files

| file | contents |
|---|---|
| `01-concepts.md` | vocabulary and the ten invariants (I1-I10); wins on conflict |
| `02-vision-policy-and-engine.md` | file formats, policy evaluation order, risk ledger, decision store, API |
| `03-events-and-playbooks.md` | event catalog with code hook points, router, playbooks P1-P13 |
| `04-gates-and-digest.md` | gate beads, resolution, daily digest, operator modes, delegates |
| `05-merge-steward.md` | risk classifier, silent -> visible -> enforced rollout, merge worker, parallel PRs while merges are blocked |
| `06-director-agent.md` | the LLM role: jobs, contracts, behavioural rules, caps, agreement metric |
| `07-phases-dogfood-os-rotation.md` | release phases, dogfood instance and promotion gate, canary and rollback, OS rotation, filler work |
| `08-queue-and-groomer.md` | how #410 and #22 are delivered (S13/S21/S22/S24 + D9/D10) |
| `09-v05-execution-plan.md` | director lanes (D1a-D10), wave placement and hot-file ownership, switch-on schedule, metrics, release criteria |
| `sprints/D*.md` | 15 requirements files (D1a, D1b, D2a, D2b, D3a, D3b, D4a, D4b, D5, D6a, D6b, D7, D8, D9, D10), usable as `--requirements-file` |
| `sprints/S-amendments.md` | pre-assigned migrations; additions to S13, S19, S21, S24, S25 |
| `examples/*.yaml` | apra-fleet vision and policy, a conservative client-delivery policy |

## Reading order

Operator: this file -> `09` -> `examples/` -> `01`.
Implementer of a D sprint: its `sprints/D*.md` -> the spec files it names -> `01`.

## What this deliberately does not do

- No capability scheduler, leases, fair-share or preemption: member-to-project
  assignment is a one-time operator decision; busy-ness comes from the shared
  fleet server's reservations.
- No portfolio database above projects: each project has its own vision and
  policy, and tenants never share precedent, backlog or KB.
- No long-lived LLM session acting as a manager.
- No auto-merge into a release branch; promotion is always the operator's.
- No change to what happens inside a running sprint (that is the engine's and
  sprint-doctor's job).
