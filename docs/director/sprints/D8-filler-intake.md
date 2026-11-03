# D8 - Filler on member.idle, OS-exercise stats, GitHub intake, kb_reconcile

Usage: `--requirements-file docs/director/sprints/D8-filler-intake.md`
Branch: `feat/v05-d8-filler-intake` off `v0.5_dashboard`. Wave 10, lane B.
Spec: `07-phases-dogfood-os-rotation.md` sections 3.4, 4; `03` P12, P1 step 3.
Depends on D9, D2b.

## Requirements

R1. Filler module consuming `member.idle`: one job per idle member from `07`
section 4 (class `filler_job`, cap `max_concurrent`), cancelled within one tick
when a real launch needs the member; no PR-publishing code reachable from the
filler path; skipped above 80% of `per_week_usd`. Each filler type has its own
acceptance test.

R2. `os_exercise` written on `run.finished` from the run's changed areas;
failure-by-OS grouping for the digest; weekly-review input.

R3. GitHub issue intake (`policy.intake.github`): new issues -> triage beads via
`file_bead` with `external_ref`, duplicate check by external_ref and title
similarity; never ready (I7); issue text stored as data only.

R4. `kb_reconcile` after `pr.merged` when the project enables the KB.

## Acceptance

Filler pre-emption within one tick; fake forge asserts zero PR writes from
filler; intake idempotency (same issue twice -> one bead); `os_exercise` update
golden test; kb_reconcile decision recorded per merge.

Estimate 10 h. Tier: standard.
