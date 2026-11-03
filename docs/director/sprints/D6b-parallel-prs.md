# D6b - Parallel and stacked PRs while merges are blocked; backpressure

Usage: `--requirements-file docs/director/sprints/D6b-parallel-prs.md`
Branch: `feat/v05-d6b-parallel-prs` off `v0.5_dashboard`. Wave 11, lane A.
Spec: `05-merge-steward.md` section 4. Depends on D6a, D9.

## Requirements

R1. Merge-blocked state per `05` 4.1 (reasons computed from forge and store,
never guessed), exposed in merge stats; replaces D9's stub.

R2. Parallel-PR rule in the scheduler launch path: independence check (planner
file list vs open fleet PR diffs at directory depth 2) or stack on exactly one
open PR with depth <= 2; `max_open_prs`; `integration_red` and `conflict_storm`
deny.

R3. Stacked PRs target the parent PR branch; the merge worker retargets them to
the integration branch when the parent merges and merges in dependency order.

R4. Backpressure counts only PRs needing a human (HIGH, or effective stage
below `enforced`).

## Acceptance

`05` section 5 parallel-PR rows; retarget after parent merge; backpressure
counts differ between `visible` and `enforced`.

Estimate 8 h. Tier: premium R2/R3.
