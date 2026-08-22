# Running fleet-sprint

`fleet-sprint` is this package's autonomous sprint engine. It drives a full
plan -> develop -> review -> deploy -> integ-test -> harvest cycle across one
or more registered fleet members, working a set of beads issues on a branch
and opening a PR at the end.

This doc covers the two ways to invoke it, the full argument contract, the
preconditions to check first, and the beads hierarchy rules that determine
what a sprint actually picks up as its scope.

## Two ways to invoke it

Both forms run the exact same engine
(`packages/apra-fleet-se/fleet-sprint/runner.js`) with the same flags. They
differ only in how the entry point is resolved.

### 1. Installed binary (normal use)

```bash
apra-fleet workflow fleet-sprint \
  --issue apra-fleet-eft \
  --members fleet-rev \
  --branch sprint/eft-service-fixes \
  --base main \
  --viewer-port 18300
```

This is the ONE command for every install method -- git-clone dev checkout,
`npm install -g @apralabs/apra-fleet`, and the pre-built standalone binary
all resolve it identically; there is no separate npm-only invocation to
learn. The launcher resolves the workflow from
`~/.apra-fleet/workflows/fleet-sprint` (installed by `apra-fleet install`,
self-healed on demand). Everything after the workflow name is passed
through verbatim, so `apra-fleet workflow fleet-sprint --help` prints the
engine's own help.

### 2. Directly from a source checkout (development only)

```bash
node packages/apra-fleet-se/bin/cli.mjs \
  --issue apra-fleet-eft \
  --members fleet-rev \
  --branch sprint/eft-service-fixes \
  --base main \
  --viewer-port 18300
```

A development-only shortcut for when you are actively changing the engine
itself and want to run the working tree directly rather than the installed
copy. Not needed, and not documented as a supported path, for any other use
-- use mode 1 above.

### Backgrounding

A sprint is a long-running process. Start it genuinely detached, not as a
child of a short-lived tool call whose process group can be killed out from
under it:

```bash
# POSIX
nohup apra-fleet workflow fleet-sprint --issue <id> --members <m> \
  --branch <branch> --base <base> > sprint.log 2>&1 &
disown
```

```powershell
# Windows
Start-Process -FilePath "apra-fleet" -ArgumentList "workflow","fleet-sprint", `
  "--issue","<id>","--members","<m>","--branch","<branch>","--base","<base>" `
  -RedirectStandardOutput "sprint.log" -RedirectStandardError "sprint.err.log" `
  -WindowStyle Hidden -PassThru
```

On start it prints the dashboard URL (`http://localhost:<viewer-port>`).
Watch progress there rather than tailing raw stdout.

## Arguments

| Flag | Short | Required | Default | Description |
|---|---|---|---|---|
| `--issue <ids>` | `-i` | yes | -- | Target issue ID(s), comma separated (e.g. `epic-1,epic-2`). Scope resolves via `bd list --parent <id>` -- see the epics section below. |
| `--members <ids>` | `-m` | yes | -- | Member IDs/names to use, comma separated. Members act as repo targets for parallelism. |
| `--branch <name>` | `-b` | yes | -- | Sprint branch to develop on. Created from `--base` if it does not exist; reused as-is if it does. |
| `--base <name>` | `-B` | yes | -- | Base branch the sprint branch is created from, and the branch the eventual PR targets. |
| `--goal <goal>` | `-g` | no | `P1/P2` | Sprint goal constraint. One of `P1`, `P1/P2`, `P1/P2/P3`. |
| `--max-cycles <n>` | `-c` | no | `5` | Max plan/develop/review cycles. |
| `--allow-missing-members` | | no | off | Warn and continue if some `--members` are not registered with the fleet. Without it, any missing member aborts the sprint. |
| `--requirements-file <path>` | | no | -- | Path to a requirements file threaded into the planner's prompt. |
| `--role-map <json\|@file>` | | no | -- | JSON object mapping role -> member[], e.g. `'{"doer":["m1","m2"]}'`. Inline JSON or `@path/to/file.json`. |
| `--viewer-port <port>` | | no | `8080` | Port for the local dashboard viewer. |
| `--budget <usd>` | | no | unlimited | USD ceiling for this run's total estimated spend. |
| `--dispatch-timeout-s <s>` | | no | `9000` | Per-dispatch time budget in seconds, applied as both the inactivity timeout and the hard ceiling on every agent dispatch (integ-test dispatch ceiling is 2x, regression-test ceiling is 3x). Minimum 60. Lower it for small sprints so a hung dispatch costs minutes, not 2.5 hours. |
| `--sync` | | no | off | Synced topology mode (orchestrator-bracketed git sync): members may sit on differing HEADs but must share the same origin URL and pass a `bd dolt pull` probe. Omitted uses shared-workspace mode (all members on the same HEAD). |
| `--help` | `-h` | | | Show the engine's help. |

Unrecognized flags fail loudly rather than being silently ignored, so a typo
like `--max-cycle` aborts instead of quietly applying the default.

**A shared/`unreservable` orchestrator member goes in `--role-map` ONLY, never
in `--members`.** `--members` (and `--role-map` values for git-having roles
like doer/reviewer/harvester) still get git-identity/topology-checked and, on
resume, git-resynced. A member registered `unreservable: true` (e.g. a
beads-only orchestrator shared across concurrent sprints) is exempted from
those checks only when it appears exclusively via `roleMap.orchestrator` --
listing it in `--members` too is redundant and not required, and defeats the
exemption for anything outside the topology precondition (e.g. a paused/
resumed sprint's resync step still runs real git commands against every
`--members` entry, unreservable or not).

## Preconditions worth checking first

- The target issue (e.g. `apra-fleet-7pm`) must exist and be open:
  `bd show <issue>`.
- Every `--members` name must be registered with the fleet
  (`list_members`); an unregistered member aborts the sprint unless
  `--allow-missing-members` is passed.
- Multi-member sprints require all configured members to share the same
  git HEAD (`checkMemberTopology`) unless `--sync` is passed -- see
  `fleet-sprint-diagram.md` for the supported-topology notes. Stick to
  single-member unless that is verified.
- If a member's LLM session is stale or unauthenticated (dispatch fails with
  `empty_response`, or "member CLI likely died"), re-run `provision_llm_auth`
  for that member before retrying.

## How to make one bead represent a whole set (epics / manifest beads)

If you want a single bead to stand in for a group of other beads (an epic,
a "next sprint scope" manifest, etc.), the group members MUST be linked as
**parent-child**, not as **blocked-by**:

- Add each item as a child of the umbrella bead:
  `bd create ... --parent <umbrella-id>` (new beads), or
  `bd update <id> --parent <umbrella-id>` (existing beads).
- The umbrella bead itself must have **zero** blocking dependencies of its
  own -- do not also add `blocks` edges from the umbrella bead to its own
  children. It should only ever be the *target* of parent-child edges
  (children point at it), never the source of a `blocks` edge pointing at
  them.
- "All done" tracking (closing the umbrella bead once every child is
  closed) is a manual/observational step based on child status
  (`dependent_count`), not something enforced by a `blocks` edge.

Why this matters: `bd`'s ready-work engine treats a `blocks` edge as a real
blocker. If the umbrella bead both (a) is `blocked-by` its children (so it
can't close until they do) AND (b) is their `parent` (so they belong to it),
that is a 2-node cycle on every pair -- and `bd` marks every bead caught in
a cycle as **not ready**, deadlocking the umbrella bead and all of its
children simultaneously. This is exactly what "blocked-by" gets you wrong
and "parent-child" gets right: a successful epic (e.g. `apra-fleet-7pm`)
has `dependency_count: 0` (it depends on / is blocked by nothing) and a
nonzero `dependent_count` (its children point at it). A broken manifest
bead that used `blocks` instead had `dependency_count: 5` and, once
children were also parented under it, deadlocked completely.

This also matters for launching a sprint: `fleet-sprint`'s `--issue <id>`
flag resolves the sprint's scope via `bd list --parent <id>` internally --
it only ever understands the `parent-child` hierarchy. A `blocked-by`-only
manifest bead is invisible to fleet-sprint's scope filter no matter what you
pass to `--issue`; only true children are picked up.

## Recovering a wedged member reservation (launched via the supervisor)

If a sprint was launched through the supervisor (`fleet-se serve`, `POST
/api/sprints`) and its child process crashes or is killed, the supervisor's
reservation ledger does **not** release that sprint's claim on its own during
normal runtime -- only a supervisor restart, or an explicit operator call,
clears it. Symptom: relaunching against the same member(s) is rejected with

```
409 member overlap rejects launch: sprint '<old-sprint-id>' already claims [<member>]
```

and `POST /api/sprints/:id/stop` against that same old sprint id also fails
(`409 ... no reachable child (port unknown)`) because the child is already
dead -- there is nothing left to proxy a stop to.

Clear it directly, with no supervisor restart required:

```bash
curl -X POST http://localhost:8787/api/reservations/<old-sprint-id>/force-release \
  -H "Content-Type: application/json" \
  -d '{"by": "<your name/reason>", "reason": "sprint child crashed, pid confirmed dead"}'
```

This releases both of the supervisor ledger's axes (member set + issue-scope
root) for that sprint id in one call and records an auditable
`force-released` event in the supervisor's event history. It does **not**
restart anything and does not affect any other live sprint.

This is a *different* mechanism from the fleet server's own per-member
`reservedBy` field (enforced at dispatch time, independent of the
supervisor). If a relaunch still 409s after force-releasing the ledger side,
also clear that axis:

```
mcp__apra-fleet__member_reservation  action: "force_release"  member_name: "<member>"
```

A crashed sprint can leave either axis wedged independently of the other --
check both. See `packages/apra-fleet-se/docs/architecture.md` ("Supervisor:
process model" / "Manual force-release") for the full mechanism.
