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
- **Supervisor launches hard-pin the backlog role.** `fleet-se serve` ensures its own LLM-less,
  `unreservable` backlog member for its project folder at startup
  (`src/supervisor/backlog-member.mjs`). `POST /api/sprints` then injects that member as
  `backlog` when the request names no backlog role, accepts it when named (via either
  spelling), rejects any other member with 400 on field `roleMap`, and answers 503 when the
  backlog member is degraded or the fleet member list cannot be read. Launch-time
  auto-selection (`selectBacklogMember`) therefore only applies to direct CLI/runner launches.
- **Backlog member ensure semantics.** At startup the supervisor looks for an existing local
  member by work folder (case-insensitive on Windows; MSYS-style paths and a trailing `.beads`
  segment are accepted), regardless of tags. A match is adopted: it keeps its name, gains the
  `backlog` tag (existing tags are preserved, since `update_member` replaces the whole list) and
  is made `unreservable` if it is not. With no match, `backlog-<camelCaseFolder>` is registered
  with `llm_provider: none`, `unreservable` and the `backlog` tag. If the member at that folder
  is an LLM member, the supervisor refuses to start (exit 1) and names the member and the
  fix (use a separate clone). If the fleet is unreachable the supervisor starts in degraded
  mode, answers launches with 503 and retries in the background until ready.
- **Overlap-guard caveat.** The member-overlap/reservation check runs on the roleMap before the
  backlog member is injected, so the injected member is never checked. This is safe only
  because the backlog member is `unreservable`; relaxing that requires moving injection ahead
  of the check.
- **Direct-launch selection order.** `selectBacklogMember` is the single selector used by the
  CLI and the runner: explicit `backlog`, then the first member mapped to no role, then the
  first doer, then the first member. It logs the chosen member and the reason.
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
