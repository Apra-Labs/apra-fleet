# CLI Reference

## INTERNAL USE ONLY -- Unsupported for Direct Invocation

WARNING: The `cli.mjs` entry point below is an **internal implementation
detail** used exclusively by the Fleet supervisor process to orchestrate
agent workflows. It is **NOT** a supported user-facing interface and direct
manual invocation is unsupported.

**Hazard:** Running `cli.mjs` directly bypasses the reservation ledger, which
tracks which members are currently executing work and prevents concurrent
conflicting workflows. Manual CLI invocation can cause race conditions, task
corruption, and silent failures across the fleet.

**Supported interfaces:** Use the **service HTTP API** and **web dashboard**
instead (see docs/overview.md and parent README.md). The service API manages
reservations correctly and is the only supported way for users to launch
sprints.

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

`resolveFleetServerCommand()` (apra-fleet-3ns.1) decides how to launch the
stdio MCP server the CLI talks to, layout-aware so it works whether this CLI
is running dev-mode from a monorepo checkout or bundled as
`dist/auto-sprint.mjs` alongside the server's own `dist/index.js`
(apra-fleet-3ns.2). Resolution order:

1. `APRA_FLEET_SERVER_CMD` env var, if set -- split on spaces into
   `command`/`args` (must be non-empty after filtering). No existence check
   (this may be any command, not necessarily a literal file path).
2. `APRA_FLEET_SERVER_BIN` env var, if set -- run as
   `<value> run --transport stdio`. Resolved via `PATH`, also no existence
   check.
3. Bundled layout -- `<dirname>/index.js`, i.e. `dist/auto-sprint.mjs`'s
   sibling `dist/index.js` (the root `@apralabs/apra-fleet` package's own
   entry point, same `dist/` directory). Used if it exists on disk.
4. Dev-monorepo layout -- `node <repoRoot>/dist/index.js run --transport
   stdio`, where `repoRoot` is resolved as three directories up from
   `bin/cli.mjs` (i.e. `packages/apra-fleet-se/bin/../../../`). Used if it
   exists on disk.

Candidates 3 and 4 are literal paths this function constructs itself, so
each is checked with `fs.existsSync` before use. If neither exists, the CLI
fails loud with an actionable error naming both env overrides and both
attempted paths, instead of deferring to `StdioTransport.start()`'s opaque
spawn failure.

### The installed-binary case: `APRA_FLEET_TRANSPORT` and HTTP-singleton attach

The four-tier resolution above is `resolveFleetServerCommand()`'s
stdio-only view. It is now one branch of a larger, shared resolution order
(`@apralabs/apra-fleet-client`'s `server-resolution` subpath export,
`resolveFleetServerConnection()`) that both this CLI and the
`apra-fleet workflow <name>` launcher (`src/cli/workflow.ts`, see
`docs/authoring-workflows.md` and `docs/adr-workflow-server-resolution.md`)
call:

1. **`APRA_FLEET_TRANSPORT`** (`http` | `stdio`, default `http`) -- forces
   the mode. `stdio` goes straight to tier 3 below; `http` requires a
   healthy HTTP singleton or fails loudly (no silent stdio fallback).
   `APRA_FLEET_SERVER_CMD`/`APRA_FLEET_SERVER_BIN` remain stdio-only escape
   hatches: setting either (with `APRA_FLEET_TRANSPORT` unset or not
   `http`) is treated as an explicit stdio request.
2. **HTTP singleton probe (default path)** -- `checkRunningInstance()`
   (`src/services/singleton.ts`) checks `~/.apra-fleet/data/server.json`
   for a live pid + a passing `/health` GET; on success, attach via
   `StreamableHttpTransport` and spawn nothing.
3. **stdio self-spawn fallback** -- only when no healthy HTTP singleton is
   found: the four-tier `resolveFleetServerCommand()` resolution above,
   feeding `StdioTransport`.

See `docs/adr-workflow-server-resolution.md` for the full rationale; this
is binding on any future change to `resolveFleetServerCommand()`.

The auto-sprint runner script (`auto-sprint/runner.js`, loaded at runtime via
`engine.executeFile()` -- read from disk and fed to the workflow engine, not
imported/bundlable) is resolved the same layout-aware way by
`resolveRunnerScriptPath()`: a bundled `dist/auto-sprint.mjs` ships it as the
sibling asset `dist/auto-sprint-runner.mjs`; a dev monorepo checkout resolves
`../auto-sprint/runner.js` relative to `bin/cli.mjs`.

### Role schema resolution (contracts.mjs)

Separately, `contracts.mjs`'s `resolveSchemasDir()` (apra-fleet-bun) resolves
where the eight sprint roles' verdict/input JSON schemas are loaded from,
independent of the server-command resolution above:

1. `APRA_FLEET_SE_SCHEMAS_DIR` env override, if set. In the installed SEA
   binary's `apra-fleet workflow <name>` launcher, this is tier 1 in
   practice: the launcher sets it to `~/.apra-fleet/schemas` whenever it is
   unset (see `docs/authoring-workflows.md` Section 4/7), so `contracts.mjs`
   itself requires no code change for the installed-binary case.
2. `dist/agents/schemas/` -- populated by the root package's `scripts/dist-pm.mjs`
   at `prepublishOnly` (the same artifact `dist/auto-sprint.mjs` ships next to).
3. `packages/apra-fleet-se/vendor/schemas/` -- a package-local copy inside
   this package's own directory tree. Legacy layout: nothing populates it now
   that apra-pm lives in this monorepo, so it normally does not exist.
4. `packages/apra-fleet-se/apra-pm/agents/schemas/`, three levels up -- the
   apra-pm package in this monorepo. Dev-convenience fallback only; emits a
   one-time `console.warn` when used, since it does not exist in a
   packaged/installed layout.

If none of the four resolve, every role falls back to a hand-written literal
schema shipped inside `contracts.mjs` itself (a deliberate, permanent
last-resort safety net, not a temporary state) -- see `docs/role-contracts.md`.

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
