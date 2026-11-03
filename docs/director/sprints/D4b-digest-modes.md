# D4b - Digest, operator modes, delegates, gates in the UIs

Usage: `--requirements-file docs/director/sprints/D4b-digest-modes.md`
Branch: `feat/v05-d4b-digest` off `v0.5_dashboard`. Wave 8, lane A.
Spec: `04-gates-and-digest.md` sections 3-4. Depends on D4a, D1b.

## Requirements

R1. Digest builder `src/director/digest.mjs`: transport-neutral sections per
`04` section 3, built only from stores; sent through the D1b notifier at
`notify.digest_at` (policy) with quiet hours and urgent bypass.

R2. Operator modes `present` / `light` / `away` (per operator, supervisor
config) and delegates with class-scoped delegate tokens issued by an
operator-only route.

R3. Gates in `/fleet-status` (`plugins/claude-code/fleet-status`) and the
supervisor dashboard: list open gates with one button per option; answering
uses the operator credential through the out-of-band confirmation flow; no
token in transcript, toast or log.

R4. OPTIONAL: email-reply answers with the per-gate HMAC nonce (`04` section 2).

## Acceptance

Golden-file digest for a fixture week containing every section; no secret or
token in any section; mode delivery tests; delegate token refused outside its
classes; mod renders gates and posts an answer (stubbed API).

Estimate 10 h. Tier: standard.
