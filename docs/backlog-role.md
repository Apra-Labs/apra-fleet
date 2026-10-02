# The `backlog` role and the deprecated `orchestrator` alias

## What the role is

`backlog` is the fleet-sprint pseudo-role (outside the doer/reviewer/planner roster) that names
the member whose beads clone the sprint runner issues its own `bd` and `git` commands against:
beads/Dolt sync brackets, scope claims and the REST call that raises the final PR. It needs no
source checkout, so the recommended setup is a dedicated, git-light, `unreservable` member
holding only a beads clone.

The role was previously spelled `orchestrator`. That name collided with the engine-sense word
"orchestrator" (the sprint engine itself, as in "orchestrator-side logic"), so the role-sense
spelling was retired. The old spelling remains a deprecated alias, accepted in 0.4.4 and removed
in v0.5.

## Design

- **One alias module.** `packages/apra-fleet-se/fleet-sprint/backlog-role.mjs` is the only code
  that knows the old spelling. `resolveBacklogRoleAlias` takes an already key-normalized
  (trim + lowercase) roleMap and returns a map carrying only `backlog`, plus a warnings list.
  Both keys present with different member lists throws; both present with identical lists is
  accepted and folded.
- **Every entry point resolves, none trusts another to have done so.**
  - CLI: `resolveRoleMapWithWarnings` prints the warning and forwards it to the runner.
  - Runner: `validateArgs` re-resolves the map, so callers that bypass the CLI are covered, and
    logs `[role-map] WARNING: ...` to the run log.
  - Supervisor `POST /api/sprints`: a conflicting pair is a 400 on field `roleMap` before any
    child process spawns. A deprecated alias yields a `warnings[]` array in the response. The
    original map (alias intact) is passed to the child so the child's own run log also warns.
    A string `@file` roleMap is rejected with 400 over HTTP (file expansion is CLI-only).
- **Member tags are labels only.** No code reads member tags, so the `orchestrator` tag alias is
  documentation only and can never produce a warning.
- **Internal identifiers use `backlog`.** Role-sense identifiers (for example the former
  `orchestratorMember` variables, log and error strings, and the beads-identity `expectedFrom`
  value) were renamed. Engine-sense uses of "orchestrator" remain legitimate.

## Invariants

- `test/backlog-role-no-orchestrator-identifiers.test.mjs` scans `fleet-sprint/`, `bin/` and
  `src/` (`*.js`/`*.mjs`) and fails on role-sense orchestrator identifiers
  (compound identifiers, `roleMap.orchestrator`, `'orchestrator member'`, the orchestrator
  `'<name>'` label). Only `backlog-role.mjs` is allowlisted. Docs are excluded from the scan,
  so prose drift must be caught in review.
- Changes to the unreservable/role wording in MCP tool descriptions must be mirrored in
  `packages/apra-fleet-client` in the same change.
- Removal in v0.5 means deleting the alias module's alias branch, its warning, and the
  allowlist entry together.

## Docs

The role-sense wording is renamed in the docs as well (both `architecture.md` files,
`cli-reference.md`, `fleet-sprint-cli-contract.md`, `fleet-sprint-diagram.md`, the
`fleet-supervisor` skill and `supervisor-openapi.yaml`). Remaining uses of "orchestrator" in docs
and prompts refer to the engine/PM process that drives a sprint, which is intentionally unchanged.
