# D10 - Groomer producer (closes #22)

Usage: `--requirements-file docs/director/sprints/D10-groomer-producer.md`
Branch: `feat/v05-d10-groomer-producer` off `v0.5_dashboard`. Wave 11, lane B.
Spec (normative): `08-queue-and-groomer.md` section 3. Depends on S24, D9,
D4a, D2b.

## Requirements

R1. Triggers: `queue.low`, `run.finished` (re-groom touched epics),
`intake.received` batch (15 min debounce), `timer.nightly`, manual; at most one
run per project per 30 minutes and `groomer.max_runs_per_day`.

R2. Producer mode: groomer dispatched with `dry-run: true` and the S24 input
fields; output validated against the schema.

R3. Parsed actions only (I1): `actions[].command` parsed into
`{verb, beadId, args}` against the beads-client allowlist with strict argument
validation; unparseable entries refused and recorded with the raw text; raw
strings never reach a shell. Parsed actions evaluated as `groom_mutation`.

R4. `sprintSets` -> `mark_ready` after the code-checked quality bar (`08` 3.3);
idempotent set key (sorted root ids); `needsGrooming` P0/P1 -> blocking gate.

R5. `backlog-groomer.md` gains a target-neutral producer-mode section
(boundary guard green).

R6. Delivery tracking per objective in `objective_progress`; "closed but not
landed" list for the digest.

## Acceptance

`08` section 4 S24 rows; an `actions` entry containing a shell metacharacter
payload is refused and never executed; idempotent re-run creates nothing new.

Estimate 10 h. Tier: premium R3, standard otherwise.
