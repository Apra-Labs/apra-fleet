# ADR: Workflow launcher fleet-server resolution order (HTTP singleton vs. stdio self-spawn)

- Status: Accepted
- Date: 2026-07-13
- Bead: apra-fleet-7pm.6 (resolves risk-register row R13)
- Supersedes the open question left in `docs/workflow-subsystem-plan.md`
  Section 1 ("Known gap this creates ... not decided here") and the
  "not yet decided in this doc" clause of R13.
- Binding on: apra-fleet-7pm.7 (`src/cli/workflow.ts` launcher + `src/index.ts`
  dispatch), apra-fleet-7pm.11 (docs deltas), and any future change to
  `packages/apra-fleet-se/bin/cli.mjs`'s server resolution.

## Scope guard (do not violate)

This ADR decides only **how the client process reaches the MCP server**. It does
**not** reopen whether they are separate processes: the launcher (`apra-fleet
workflow`, `auto-sprint`) and the `apra-fleet` MCP server are **always separate
processes**. Merging them into one process is explicitly out of scope per
workflow-subsystem-plan.md Section 1, and no task may propose it.

## Context

- HTTP (`streamableHTTP`) is the **product default** transport. `src/cli/install.ts`
  documents `--transport http` as default and `--transport stdio` as legacy, and
  `src/cli/start.ts` spawns the installed OS service with `--transport http`
  (default singleton at `http://localhost:7523/mcp`).
- A healthy singleton is discoverable from disk: the running server writes
  `~/.apra-fleet/data/server.json` (`{pid, url}`), and
  `checkRunningInstance()` in `src/services/singleton.ts` validates it -- pid-alive
  check (`isPidAlive`) plus `GET <url with /mcp -> /health>` with a 2s timeout --
  and self-heals by deleting the file when either check fails.
- `resolveFleetServerCommand()` in `packages/apra-fleet-se/bin/cli.mjs` today has
  **only** a stdio-self-spawn branch: four resolution tiers
  (`APRA_FLEET_SERVER_CMD`, `APRA_FLEET_SERVER_BIN`, bundled sibling
  `<dirname>/index.js`, dev-monorepo `<repoRoot>/dist/index.js`), all producing
  `run --transport stdio` args, and `cli.mjs` feeds them straight into
  `new StdioTransport(...)`.
- Therefore a launcher that naively "mirrors" `resolveFleetServerCommand()` would
  **always self-spawn a private stdio server**, even when a healthy HTTP singleton
  is already running as an installed service. That defeats the "attach to what is
  already there" behavior users expect, doubles running server processes, and can
  split state across two servers.
- `packages/apra-fleet-client` already implements both transports
  (`StreamableHttpTransport` and `StdioTransport` in `src/client/transport.mjs`,
  selected by `factory.mjs`), so no new transport code is needed -- only a
  decision about **selection order**.

## Decision 1 -- Resolution order

The launcher resolves its connection in this exact order:

1. **Forced-transport override.** Read `APRA_FLEET_TRANSPORT` (new env var, launcher
   -scoped; values `http` | `stdio`). If it is `stdio`, skip straight to step 3
   (stdio self-spawn). If it is `http`, do step 2 and **fail with an actionable
   error** rather than falling back to step 3 (an explicit `http` request must not
   silently become a private stdio server). If unset, the transport is `http`
   (product default) and resolution continues at step 2.
   - `APRA_FLEET_SERVER_CMD` / `APRA_FLEET_SERVER_BIN` remain stdio-only escape
     hatches: if either is set and `APRA_FLEET_TRANSPORT` is not `http`, treat that
     as an explicit stdio request and go to step 3. This preserves the existing
     behavior of every test/CI setup that already sets them.

2. **HTTP singleton probe (the default path).** Call `checkRunningInstance()` --
   the *same* pid + `/health` check the server already uses for startup-dedup, not a
   re-implementation. On `{running: true, url}`, connect with
   `StreamableHttpTransport(url)` from `@apralabs/apra-fleet-client` and
   **spawn nothing**. This is the expected steady-state path for any machine where
   `apra-fleet install` / `apra-fleet start` has run.

3. **stdio self-spawn fallback.** Only if no healthy HTTP singleton was found
   (server never installed/started, service stopped, stale `server.json`, or stdio
   explicitly forced), fall back to the existing four-tier command resolution and
   `StdioTransport`. The four tiers and their existsSync-checked error message are
   unchanged.

The launcher logs, at info level, which path it took and why (`attached to HTTP
singleton at <url> (pid <pid>)` vs. `no healthy fleet singleton found; self-spawning
stdio server via <command>`), so a doubled-server or wrong-database report is
diagnosable from the transcript.

Rationale: probing first is cheap (one `readFileSync` + one localhost `GET /health`,
2s timeout, already self-healing) and strictly dominates spawning first -- a spawn
that the probe would have avoided costs a whole extra server process and a second
copy of server state, whereas a failed probe costs milliseconds.

## Decision 2 -- ONE shared helper, not duplicated

The resolution-order logic above lives in **one shared helper**, used by both
`apra-fleet workflow` (`src/cli/workflow.ts`) and auto-sprint's
`packages/apra-fleet-se/bin/cli.mjs`. It is **not** duplicated.

**Location:** `packages/apra-fleet-client/src/client/server-resolution.mjs`,
exported as the subpath `@apralabs/apra-fleet-client/server-resolution` (a new
entry in that package's `exports` map, alongside `./client`, `./factory`,
`./transport`). It exposes roughly:

```
resolveFleetServerConnection(deps?) -> Promise<
    { mode: 'http', url: string, pid: number }
  | { mode: 'stdio', command: string, args: string[] }>
connectFleet(deps?) -> Promise<{ transport, mcpClient, fleetApi, mode }>
```

with the same injectable `deps` ({ env, dirname, exists, checkRunningInstance })
that `resolveFleetServerCommand()` already uses, so every branch stays unit-testable
without a real install.

Why the client package:

- It is the **only existing node both consumers already reach**:
  `packages/apra-fleet-se` declares `@apralabs/apra-fleet-client` as a dependency
  today, and `src/cli/workflow.ts` must depend on it anyway (it needs `McpClient`
  and both transports to talk to the server at all). So this adds **zero new
  dependency edges**.
- The reverse homes do not work: putting it in the root `src/` would force
  `packages/apra-fleet-se` (a plain-ESM package) to depend on the root package's
  TypeScript build output, and putting it in `apra-fleet-se` would force the root
  CLI to depend on the SE edition -- an inverted edge.

**Single implementation of the liveness check.** The pid + `/health` probe must
exist exactly once. `checkRunningInstance()` moves to (or is re-exported from) the
shared helper, and `src/services/singleton.ts` keeps its current exported signature
by delegating to it, so the server's startup-dedup and the launcher's probe can
never drift apart. `resolveFleetServerCommand()` in `cli.mjs` likewise becomes a
thin re-export of the helper's stdio tier, keeping its current name and behavior for
existing callers/tests.

### Tradeoff, recorded explicitly

- **Shared helper (chosen).** One place to fix; the launcher and auto-sprint can
  never disagree about where the server is; the liveness check cannot drift from the
  server's own. Cost: `cli.mjs`'s resolution stops being a self-contained function
  in the file you are reading, the client package grows a dependency on filesystem +
  `~/.apra-fleet` layout knowledge (previously it was transport-only), and the SEA
  bundle must bundle the helper (esbuild handles the workspace ESM import; the
  Phase 1.1 spike already proved on-disk ESM import works from a SEA main script).
- **Duplicated (rejected).** Cheaper for one commit and keeps the client package
  transport-only. Rejected because it guarantees the exact drift R13 warns about:
  two copies of a four-tier + probe order, in two languages (TS and MJS), one of
  which is already wrong today. A future fix to one would silently miss the other,
  and the symptom (a second, private server holding divergent state) is expensive to
  diagnose.

## Consequences

- apra-fleet-7pm.7 (`src/cli/workflow.ts`) implements against
  `@apralabs/apra-fleet-client/server-resolution` and does **not** re-implement or
  copy `resolveFleetServerCommand()`. It must reference this ADR by name.
- `cli.mjs` is refactored to call the shared helper; its current stdio-only behavior
  is preserved for anything that sets `APRA_FLEET_SERVER_CMD`/`_BIN`, but it gains
  the HTTP-singleton attach path for free -- fixing the doubled-server bug there too.
- `APRA_FLEET_TRANSPORT` is a new documented env var (apra-fleet-7pm.11: cli-reference.md,
  install.md).
- Tests must cover: healthy singleton -> HTTP attach, no server.json -> stdio spawn,
  stale/dead pid -> stdio spawn (and `server.json` deleted), `/health` non-200 ->
  stdio spawn, `APRA_FLEET_TRANSPORT=stdio` -> stdio spawn without probing, and
  `APRA_FLEET_TRANSPORT=http` with no singleton -> actionable error, no spawn.
