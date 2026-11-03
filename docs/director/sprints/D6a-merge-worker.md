# D6a - Merge worker, stage enforced, PR body and pm R12 wording

Usage: `--requirements-file docs/director/sprints/D6a-merge-worker.md`
Branch: `feat/v05-d6a-merge-worker` off `v0.5_dashboard`. Wave 10, lane A.
Spec: `05-merge-steward.md` sections 2.3 (enforced), 2.4, 3. Depends on D3b, D4a.

## Requirements

R1. Forge client write calls: update-branch, squash-merge, retarget base.

R2. Serial merge worker per integration branch: for PRs whose `merge_pr.*`
decision is `do`/`do_notify` and effective stage `enforced`: verify CI green on
the exact head SHA, update the branch when stale and wait for CI, squash-merge;
conflicts emit `pr.conflicted` (no auto-resolve); protected targets refused.

R3. `fleet-sprint/pr-body.mjs`: for projects whose effective stage is
`enforced`, render "Merge policy: decided by the project's merge policy" in
place of the fixed "Do NOT auto-merge" sentence (target-neutral wording; the
runner receives the stage as launch data, it does not read policy itself).
`apra-pm/skills/pm/SKILL.md` R12 says merging follows the project's merge
policy when one is enforced, else the user decides.

R4. Kill switches now demote `enforced -> visible` automatically (demotion
record), debit `reverted_merges`, urgent notify.

## Acceptance

`05` section 5 merge-execution and kill-switch rows; PR body test for both
stages; boundary guard green.

Estimate 10 h. Tier: premium R2, standard otherwise.
