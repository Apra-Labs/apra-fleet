# D7 - Phases API, dogfood instance counter, canary and rollback

Usage: `--requirements-file docs/director/sprints/D7-phases-dogfood.md`
Branch: `feat/v05-d7-phases-dogfood` off `v0.5_dashboard`. Wave 9, lane B.
Spec (normative): `07-phases-dogfood-os-rotation.md` sections 1-2.
Depends on D2a, S19. MUST NOT edit `src/supervisor/watchdog.mjs` (S25 owns it
in wave 9).

## Requirements

R1. Phase API (operator credential), history, effects, `phase.changed`.

R2. Dogfood instance support: a project's `dogfood.enabled` routes it to the
dogfood supervisor instance; operator route to move a project between
instances; documented setup of the second instance (data dir, port, build).

R3. Dogfood counter from the dogfood instance's run history (sprint-hours per
candidate build) and regression attribution (`07` 2.4) with an operator clear
action.

R4. Promotion gate (`promote_release`, `propose_blocking`) whose answer API
refuses "promote" below thresholds with computed evidence.

R5. Canary upgrades of dogfood members to exact builds; rollback via a new
`allow_downgrade` option on the member install/update path
(`src/services/member-fleet-install.ts` and the tool schema) with client
wrapper parity (`packages/apra-fleet-client`); every upgrade a `member_upgrade`
decision.

R6. `/fleet-status` skew indicator: dogfood canary members shown as info.

## Acceptance

`07` section 5 (phase, dogfood, canary, rollback); client parity test for the
new option.

Estimate 10 h. Tier: standard (premium R5).
