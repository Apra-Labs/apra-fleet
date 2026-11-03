# D4a - Gates: store, policy integration, answer API, re-evaluation, expiry

Usage: `--requirements-file docs/director/sprints/D4a-gates.md`
Branch: `feat/v05-d4a-gates` off `v0.5_dashboard`. Wave 7, lane B.
Spec (normative): `04-gates-and-digest.md` sections 1-2. Depends on D2a, S11.

## Goal

Every question for the operator becomes a gate bead with a recommended default
and an expiry; answering it executes only what is still allowed.

## Requirements

R1. Extend the S11 beads client allowlist (`src/projects/beads/verbs.mjs`) with
creating `gate` issues, metadata writes and dependency edges; strict argument
validation.

R2. Gate store `src/director/gates.mjs`: create with dedupe per
`(action_class, subject)`, update evidence, answer, expire, obsolete; `blocks`
edges to the waiting beads.

R3. Router integration: `propose` -> gate with `firesAt = now +
base.gates.default_expiry_hours`; `propose_blocking` -> no expiry; replaces
D2b's `gated-pending`.

R4. Answer route (operator credential or delegate token), expiry sweep on the
tick, `gate.answered|expired|obsolete` events, P9 with re-evaluation of steps
0-2 and 4-7 at execution (`04` section 2); refused effects re-open the gate
with the reason. `policy_file_change` effect opens a PR, never commits.

R5. Precedent export via `kb_capture` in the project's KB scope when present.

R6. Set `director.enforce: true` becomes meaningful: the example policy comment
and `09` section 7 note are updated to "as built".

## Acceptance

`04` section 5 (dedupe, blocks/unblocks readiness, expiry, blocking never
expires, auth, re-evaluation refusal re-opens).

Estimate 10 h. Tier: standard (premium R4).
