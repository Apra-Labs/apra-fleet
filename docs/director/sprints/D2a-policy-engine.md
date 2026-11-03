# D2a - Policy engine, schemas, loader, risk ledger, decisions, API

Usage: `--requirements-file docs/director/sprints/D2a-policy-engine.md`
Branch: `feat/v05-d2a-policy-engine` off `v0.5_dashboard`. Wave 5, lane B.
Spec (normative): `02-vision-policy-and-engine.md`. Depends on D1a.

## Goal

A deterministic, fully tested answer to "may the system do X now, and on whose
authority?" for every action class, with every answer auditable. No LLM.

## Requirements

R1. Add `yaml` as a runtime dependency of `packages/apra-fleet-se` (installed
tree and SEA bundle include it). Schemas `src/director/schemas/vision.schema.json`
and `policy.schema.json` implementing `02` sections 2, 3, 3.1, 3.2 (closed
action-class set, unknown keys rejected, phase-merge rule constraints).

R2. Loader `src/director/policy-loader.mjs`: supervisor-owned bare mirror at
`<data dir>/mirrors/<project>.git`; `git fetch`, then read `.fleet/vision.yaml`
and `.fleet/policy.yaml` from `refs/remotes/origin/<integration-branch>` only;
cache by blob hash; refresh per `02` section 1; emit `policy.changed`
(urgent when invalid). Missing -> default policy (`02` 4.4); invalid or fetch
failure -> I9. Commands are built in JavaScript for the supervisor host's OS
(no shell variable expansion).

R3. Engine `src/director/policy-engine.mjs`: pure `evaluate(action, ctx)` with
the evaluation order in `02` section 4.1 (steps 0-9), the phase deep-merge rule
(3.2) and the monotonic downgrade rule.

R4. Context builder `src/director/context.mjs` taking only `(project, action)`;
PR counts return 0 with `reason=pr-counts-unavailable` until the D3a forge
watcher registers a provider.

R5. Risk ledger `src/director/risk-ledger.mjs` (`02` section 5) on the
`risk_week` table from D1a; emits `budget.exhausted` / `budget.replenished`.

R6. Decision store `src/director/decisions.mjs` (`02` section 6).

R7. Operator credential: `director_operator_token` in the fleet credential
store (`network_policy: confirm`); verifier used by op routes; never logged.

R8. Routes in `02` section 7 except `phase` (D7) and `gates` (D4a), registered
as a module file under `src/director/modules/`.

R9. All files in `docs/director/examples/` validate in a test.

## Acceptance

`02` section 8 in full.

Estimate 12 h. Tier: premium R2-R4, standard otherwise.
