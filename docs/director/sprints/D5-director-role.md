# D5 - Director role: prompt, schemas, client, P2, weekly review, agreement

Usage: `--requirements-file docs/director/sprints/D5-director-role.md`
Branch: `feat/v05-d5-director-role` off `v0.5_dashboard`. Wave 8, lane B.
Spec (normative): `06-director-agent.md`; `03` P2, P13 weekly. Depends on D2a,
D4a, S13 (`setDirectorRank`).

## Requirements

R1. Role prompt `packages/apra-fleet-se/apra-pm/agents/director.md` per `06`
section 4, target-neutral (boundary guard scans it). Input/output schemas per
job under `apra-pm/agents/schemas/`.

R2. Document `.fleet/vision.yaml` and `.fleet/policy.yaml` as a target-repo
contract in `docs/fleet-sprint-getting-started.md` and in the boundary
checker's target file contract, so the role prompt may name them.

R3. Client `src/director/director-client.mjs`: input builder (`06` 3), member
selection (role `director`, premium), permission-profile assertion (read-only
tools only, refuse otherwise), `max_turns` from policy, pre-dispatch cost
estimate from model pricing, post-call spend debit, per-day cap.

R4. Jobs wired: `rank` (writes level 3 via S13 `setDirectorRank` only),
`diagnose` (P2: proposals evaluated as `retry_after_abort` / `groom_mutation` /
gate), `recommend` (on every gate; `confidence: low` -> gate without default),
`weekly_review` (report + `policy_file_change` gates whose effect opens a PR +
`file_bead` epics), `summarize`.

R5. Agreement per decision class (`06` section 6) in the decision store and the
weekly review.

## Acceptance

`06` section 7, plus: operator pins untouched by `rank`; an injection string in
a bead produces `injectionSuspect` and no action; profile assertion refuses a
member with write tools.

Estimate 12 h. Tier: premium.
