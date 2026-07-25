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

The launcher resolves the workflow from `~/.apra-fleet/workflows/fleet-sprint`
(installed by `apra-fleet install`, self-healed on demand). Everything after
the workflow name is passed through verbatim, so
`apra-fleet workflow fleet-sprint --help` prints the engine's own help.

### 2. Directly from a source checkout (development)

```bash
node packages/apra-fleet-se/bin/cli.mjs \
  --issue apra-fleet-eft \
  --members fleet-rev \
  --branch sprint/eft-service-fixes \
  --base main \
  --viewer-port 18300
```

Useful when you are changing the engine itself and want to run the working
tree rather than the installed copy.

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
| `--dispatch-timeout-s <s>` | | no | `3600` | Per-dispatch time budget in seconds, applied as both the inactivity timeout and the hard ceiling on every agent dispatch (integ-test dispatch ceiling is 2x). Minimum 60. Lower it for small sprints so a hung dispatch costs minutes, not an hour. |
| `--sync` | | no | off | Synced topology mode (orchestrator-bracketed git sync): members may sit on differing HEADs but must share the same origin URL and pass a `bd dolt pull` probe. Omitted uses shared-workspace mode (all members on the same HEAD). |
| `--help` | `-h` | | | Show the engine's help. |

Unrecognized flags fail loudly rather than being silently ignored, so a typo
like `--max-cycle` aborts instead of quietly applying the default.

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
