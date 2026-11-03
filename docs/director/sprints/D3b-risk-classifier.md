# D3b - Risk classifier: pre-rules, model, silent/visible, stats

Usage: `--requirements-file docs/director/sprints/D3b-risk-classifier.md`
Branch: `feat/v05-d3b-risk-classifier` off `v0.5_dashboard`. Wave 7, lane A.
Spec: `05-merge-steward.md` sections 2.1-2.4. Depends on D3a.

## Goal

Classify every fleet PR as LOW or HIGH risk, record it, optionally show it, and
measure agreement with the operator. Never merges.

## Requirements

R1. Deterministic pre-rules (`05` 2.1) in `src/director/risk-classifier.mjs`,
reading `merge.high_paths`, `merge.max_files`, `merge.max_lines` from policy;
`.fleet/**` always HIGH.

R2. Model classifier: role prompt `apra-pm/agents/risk-classifier.md` (generic;
boundary guard green), schemas `agents/schemas/risk-classifier-{input,output}.json`;
dispatched with `execute_prompt`, `max_turns: 1`, on a pool member whose
permission profile grants no tools - asserted before every dispatch (refuse
otherwise). Invisible Unicode stripped from inputs; invalid output, timeout or
error -> HIGH.

R3. Effective stage = more cautious of `policy.merge.stage` and the
`merge_state` demotion; `silent` records only; `visible` posts/updates one PR
comment and a `risk:low|high` label via the forge client (this sprint adds the
comment and label write calls only).

R4. Disagreement route `POST /api/director/:project/prs/:n/disagree {note}`
(operator credential); agreement stats at `GET /api/director/:project/merge/stats`.

R5. Kill-switch detection (`05` 2.4) writing demotion records; clearing a
demotion is an operator route.

## Acceptance

`05` section 5 rows for pre-rules, fail-closed, silent/visible behaviour;
profile assertion refuses a member with write tools; disagreement updates stats.

Estimate 10 h. Tier: premium R2, standard otherwise.
