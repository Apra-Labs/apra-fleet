# CLI Reference

Entry point: `packages/apra-fleet-se/bin/cli.mjs` (installed as the
`fleet-se sprint` command; also runnable directly with `node bin/cli.mjs`).

```
Usage: fleet-se sprint [options]
```

Flags are parsed with Node's built-in `node:util parseArgs` in `strict: true`
mode (see `buildOptionsSpec()`/`parseCliArgs()` in `bin/cli.mjs`): an
unrecognized or misspelled flag (e.g. `--max-cycle`) fails immediately with a
clear error instead of being silently ignored. Positional arguments are not
allowed.

## Flags

| Flag | Short | Required | Type | Default | Description |
|---|---|---|---|---|---|
| `--issue <ids>` | `-i` | yes | comma-separated string | -- | Target beads issue id(s) that scope the sprint (e.g. `epic-1,epic-2`). Every dispatch in the run filters beads by `--parent <these ids>`. |
| `--members <ids>` | `-m` | yes | comma-separated string | -- | Fleet member id(s)/name(s) available to the sprint. Members are the pool doers/reviewer round-robin across (see `docs/architecture.md` "Role -> member resolution"). |
| `--branch <name>` | `-b` | yes | string | -- | Sprint branch to develop on. Created from `--base` if it does not already exist. |
| `--base <name>` | `-B` | yes | string | -- | Base branch the sprint branch is created from, and the branch the eventual PR targets. |
| `--goal <goal>` | `-g` | no | string | `P1/P2` | Priority-tier goal constraint. Must match `P1`, `P1/P2`, or `P1/P2/P3` (pattern `^P[1-3](/P[1-3]){0,2}$`). Determines the exit condition -- see `docs/architecture.md`. |
| `--max-cycles <n>` | `-c` | no | positive integer | `5` | Hard ceiling on plan/develop/review cycles. |
| `--allow-missing-members` | | no | boolean flag | off | Without this flag, ANY `--members` entry not registered with the fleet aborts the sprint before it starts. With it, missing members are dropped with a warning and the sprint proceeds with whatever members remain (at least one valid member is still required). |
| `--requirements-file <path>` | | no | string | -- | Path to a file whose content is read once, up front, and threaded verbatim into every Plan-phase planner prompt this sprint. A missing/unreadable file only logs a warning; the sprint continues without it. |
| `--role-map <json\|@file>` | | no | JSON object or `@path/to/file.json` | -- | Maps role name -> array of member names, e.g. `'{"doer":["m1","m2"]}'`. Overrides the default member-pool resolution for that role (see `docs/architecture.md`). Also accepts the application-level pseudo-role key `orchestrator` (which member issues the sprint's own `bd`/`git` commands). Keys are normalized (trimmed + lowercased) on load; two keys that normalize to the same value are rejected as ambiguous. |
| `--viewer-port <port>` | | no | integer 1-65535 | `8080` | Port for the local dashboard viewer HTTP server. |
| `--budget <usd>` | | no | non-negative finite number | unset (unlimited) | USD ceiling for this run's total *estimated* spend. When set, `agent()` dispatches abort the run with a budget-exceeded error once tracked spend reaches the ceiling. Omitted means unlimited -- identical to not having this flag at all. See the budget-tracking caveats in `docs/architecture.md`. |
| `--help` | `-h` | no | boolean flag | -- | Prints usage text and exits 0. |

All four of `--issue`, `--members`, `--branch`, `--base` are required; if any
is missing the CLI prints `Error: Missing required flags: ...` (listing every
missing one) and exits 1.

## Validation performed before any dispatch

In order, `main()` in `bin/cli.mjs` performs:

1. **Required-flag check** -- see above.
2. **Issue id / branch name shape validation** -- every `--issue` id is
   checked against `validateIssueId` and both `--branch`/`--base` against
   `validateBranchName` (both imported from `auto-sprint/runner.js`, the same
   validators the runner itself re-applies -- single source of truth, and
   defense-in-depth if the runner is ever invoked directly, bypassing the
   CLI). Issue ids must match `^[A-Za-z0-9._-]+$`; branch names must match
   `^[A-Za-z0-9._/-]+$`. This exists specifically to keep a malicious/malformed
   id or branch name from ever reaching a shell command interpolation.
3. **`--role-map` parsing** -- via `resolveRoleMap()`; JSON-parse failure or
   a non-object/array shape is a fatal error.
4. **`--max-cycles` range check** -- must parse as a positive integer.
5. **`--viewer-port` range check** -- must parse as an integer in `[1,
   65535]`.
6. **`--budget` range check** -- if present, must be a non-negative finite
   number.
7. **Fleet transport startup** -- the CLI starts the stdio MCP transport to
   the fleet server (`resolveFleetServerCommand()`, see below) and performs
   the `initialize`/`notifications/initialized` handshake *before* any
   further precondition check, so every subsequent check runs against a live
   connection.
8. **Member existence check** -- calls the fleet's `list_members` tool and
   validates every `--members` entry is registered (`resolveMemberValidation()`).
   Any missing member aborts the sprint unless `--allow-missing-members` was
   passed (in which case missing members are dropped with a warning). If
   *no* valid members remain, the sprint aborts regardless.
9. **Target-issue existence check** -- runs `bd show <id>` for every
   `--issue` id, on the **orchestrator member** specifically (not the local
   machine -- see `checkIssuesExistOnMember()`). The orchestrator member is
   `roleMap.orchestrator[0]` if configured, else the first valid `--members`
   entry.
10. **Multi-member topology check** -- `checkMemberTopology()` (see
    `docs/architecture.md` "Multi-member topology") compares `git rev-parse
    HEAD` across every configured member and refuses to start on a mismatch.
    Single-member sprints trivially pass.

Any failure at steps 7-10 stops the fleet transport and exits 1 with a
descriptive `Error:` message before the sprint (and therefore any agent
dispatch) begins.

## Resolving the fleet MCP server command

`resolveFleetServerCommand()` decides how to launch the stdio MCP server the
CLI talks to, in this override order:

1. `APRA_FLEET_SERVER_CMD` env var, if set -- split on spaces into
   `command`/`args` (must be non-empty after filtering).
2. `APRA_FLEET_SERVER_BIN` env var, if set -- run as
   `<value> run --transport stdio`.
3. Dev-mode default -- `node <repoRoot>/dist/index.js run --transport
   stdio`, where `repoRoot` is resolved as three directories up from
   `bin/cli.mjs` (i.e. `packages/apra-fleet-se/bin/../../../`).

## Dashboard viewer

Once preconditions pass, the CLI starts a local HTTP dashboard
(`createDashboardViewer` from `@apralabs/apra-fleet-workflow/viewer`) on
`--viewer-port`, extended with this package's `beadsExtension` (a live beads
task-tree panel -- see `docs/architecture.md` "The viewer"). A `server.listen()`
failure (most commonly `EADDRINUSE`, i.e. the port is already in use) is
caught and reported as a clean, actionable error (`try --viewer-port <other
port>`) instead of an unhandled crash.

## Running the sprint

After the dashboard starts, the CLI builds the validated runner args
(`buildRunnerArgs()`) and calls
`engine.executeFile('../auto-sprint/runner.js', args)`. On completion it
prints `Sprint finished: <result>`; on failure it prints `Sprint failed:
<err>` and sets a non-zero exit code. In both cases the dashboard server and
fleet transport are closed in a `finally` block before the process exits.

Note: the CLI does not currently expose flags for the workflow engine's
journal/replay feature (`--journal`/`--resume-journal`) -- that mechanism
exists in `apra-fleet-workflow` and is available to any caller of
`engine.executeFile()`, but `bin/cli.mjs` does not wire flags for it today.
See `docs/architecture.md` "Journal and replay".
