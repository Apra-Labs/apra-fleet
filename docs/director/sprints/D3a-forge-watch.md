# D3a - Forge client (read), PR and branch events, playbooks P1/P6/P10

Usage: `--requirements-file docs/director/sprints/D3a-forge-watch.md`
Branch: `feat/v05-d3a-forge-watch` off `v0.5_dashboard`. Wave 6, lane B.
Spec: `05-merge-steward.md` section 3 (watch part), `03` events `pr.*`,
`branch.ci_changed`, playbooks P1 (record), P6, P10. Depends on D2a.

## Goal

The supervisor sees every fleet PR and the integration branch the way the
operator would: checks, reviews, merges, reverts, conflicts.

## Context

Existing `fleet-sprint/vcs-providers` builders only create/comment/find/update
PRs through member shells. Nothing lists PRs, reads checks or reviews, or
detects reverts. A supervisor-side REST client is needed.

## Requirements

R1. `src/director/forge/github.mjs` (read-only in this sprint): list PRs with
the `fleet-sprint:run-history` marker targeting the integration branch, head
SHA check runs, reviews, mergeability; integration branch head checks; revert
detection (revert commits on the integration branch referencing a fleet PR).
Credential: the same GitHub App / token the PR publisher uses, read from the
credential store. Provider interface so Azure DevOps / Bitbucket can follow.

R2. Watcher module polling every 2 minutes with backoff; emits `pr.ci_changed`,
`pr.review_changed`, `pr.merged`, `pr.closed`, `pr.conflicted`, `pr.reverted`,
`branch.ci_changed` with dedupe; registers the PR-count provider used by the
D2a context (`openPrs`, `prsAwaitingHuman`).

R3. P1: on `run.finished` PASS, record the PR as awaiting the steward; on
`pr.merged`, close the loop (objective progress, `kb_reconcile` proposal
recorded for D8).

R4. P6: red on a fleet PR whose run ended -> `ci_fix_sprint` via the launch list
(cap `max_per_pr`); infra/FAILED-TO-RUN -> `ci_infra_outage` flag, one notify;
integration branch red -> `integration_red` flag (scheduler and launch list
skip feature launches) + one P0 fix sprint (cap `max_per_branch_red`) + urgent
notify.

R5. P10: `pr.reverted` -> debit `reverted_merges`, demotion record in
`merge_state`, `file_bead` investigation, urgent notify.

## Acceptance

- Fake-forge tests: each event emitted once per change; no events on unchanged
  polls; backoff on errors.
- P6 three branches; caps; integration-red blocks feature launches in the launch
  list.
- P10 writes the demotion record and debits the ledger.

Estimate 10 h. Tier: standard (premium R1).
