# Authoring workflows

This is the contract for writing a workflow that runs under
`apra-fleet workflow <name> [args...]` -- the import-trampoline launcher
implemented in `src/cli/workflow.ts`. See `docs/workflow-subsystem-plan.md`
for the full architecture background and `docs/adr-workflow-server-resolution.md`
for how the launcher reaches the fleet MCP server. This doc is the
task-facing summary: how to structure, write, and run a workflow.

## 1. The `workflows/` directory convention

Installed workflows live under `~/.apra-fleet/workflows/<name>/`. Each
workflow is a real, self-sufficient file tree on disk -- there is no
compilation step and no packaging format beyond plain files:

```
~/.apra-fleet/workflows/
  .installed.json            <- installer-owned; lists built-in workflow names + version
  hello-world/
    workflow.json
    main.mjs
  auto-sprint/
    workflow.json
    package.json              ("type": "module")
    bin/cli.mjs
    auto-sprint/{runner.js,contracts.mjs,errors.mjs,viewer-extensions.mjs}
    vendor/schemas/*.json
  <your-workflow>/
    workflow.json
    <your entry file(s)>
```

A workflow directory is either:

- a **built-in**, installed and refreshed by `apra-fleet install` /
  `apra-fleet update` (its name is listed in `.installed.json`'s `builtin`
  array); or
- a **user workflow**, any other directory you place under
  `~/.apra-fleet/workflows/`. Install/update/uninstall never touch
  non-built-in directories (see `docs/install.md`'s directory table and
  `packages/apra-fleet-se/docs/cli-reference.md`).

## 2. The `workflow.json` schema

```json
{
  "name": "hello-world",
  "entry": "main.mjs",
  "description": "Minimal example workflow"
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | no (informational) | Should match the directory name; not enforced by the launcher. |
| `entry` | yes | Path relative to the workflow directory. Must resolve **inside** the workflow directory -- an `entry` that escapes via `..` is rejected with an actionable error. |
| `description` | no | Shown by `apra-fleet workflow --list`. Defaults to `(no description)` if absent. |

If a workflow directory has no `workflow.json` at all, the launcher falls
back to the first existing file among these documented conventions, in
order: `main.mjs`, `index.mjs`, `runner.js`. Prefer shipping an explicit
`workflow.json` -- it is required if your entry file is not one of those
three names.

## 3. The entry contract

Your entry file must be one of:

1. **A self-executing ES module** (the documented primary convention,
   demonstrated by `examples/workflows/hello-world/main.mjs`). Top-level
   code runs immediately on import and does whatever the workflow does
   (read `process.argv.slice(2)` for its args, print output, exit).
2. **A module that exports `main(args)`, `run(args)`, or `default(args)`**
   (checked in that order). If your module does not self-execute, the
   launcher calls whichever of these three exports is a function, passing
   it the array of pass-through args (everything typed after `<name>` on
   the command line).

The launcher never re-parses your args -- `apra-fleet workflow auto-sprint
--issue BD-1 --members m1 --branch f --base main` hands
`['--issue', 'BD-1', '--members', 'm1', '--branch', 'f', '--base', 'main']`
to your entry exactly as typed, whether via `process.argv` (self-executing
form) or as the `args` parameter (exported-function form). Before importing
the entry, the launcher rewrites `process.argv` to
`[execPath, <entryAbsPath>, ...passthroughArgs]`, so a self-executing
module's own `parseArgs()`-style code (and any `isMainModule()`-style guard
comparing `import.meta.url` to `process.argv[1]`) works unmodified.

## 4. The two env vars the launcher sets

The launcher sets these two environment variables **only when they are not
already set** -- a value you (or your shell, or a parent process) set
always wins:

| Env var | Default value | Purpose |
|---|---|---|
| `APRA_FLEET_SERVER_BIN` | the resolved apra-fleet server executable | Read by `resolveFleetServerCommand()` / the shared server-resolution helper as an explicit stdio request. Only defaulted when the launcher's own resolution already chose stdio -- it is never set when the launcher attached over HTTP, so it cannot sabotage an HTTP attach. |
| `APRA_FLEET_SE_SCHEMAS_DIR` | `~/.apra-fleet/schemas` | Tier-1 override consumed by `contracts.mjs`'s `resolveSchemasDir()` with zero code changes required there (see Section 5 below). |

A third env var controls **transport selection**, not a launcher-set
default -- you (the user) set it, the launcher reads it:

| Env var | Values | Purpose |
|---|---|---|
| `APRA_FLEET_TRANSPORT` | `http` (default) \| `stdio` | Forces how the launcher reaches the fleet MCP server. See Section 5. |

## 5. Connecting to the fleet server

Every workflow that needs to call fleet MCP tools follows the same
resolution order the launcher itself performs before your entry runs
(`docs/adr-workflow-server-resolution.md`, binding on `src/cli/workflow.ts`):

1. **Forced-transport override** -- `APRA_FLEET_TRANSPORT=stdio` skips
   straight to stdio self-spawn; `APRA_FLEET_TRANSPORT=http` requires a
   healthy HTTP singleton or fails loudly (no silent stdio fallback).
2. **HTTP singleton probe (the default)** -- attach to the already-running
   `apra-fleet` OS-service singleton (`checkRunningInstance()` against
   `~/.apra-fleet/data/server.json`, a pid-alive check plus a `/health`
   GET) via `StreamableHttpTransport`. Nothing is spawned.
3. **stdio self-spawn fallback** -- only if no healthy HTTP singleton was
   found, spawn a private server using `APRA_FLEET_SERVER_BIN`/`_CMD` (or
   the bundled/dev-layout fallback), then connect with `StdioTransport`.

This logic lives in exactly one place -- `@apralabs/apra-fleet-client`'s
`server-resolution` subpath export -- and both `apra-fleet workflow` and
the `auto-sprint` CLI call it; do not reimplement it in your workflow.

### Recommended: `connectFleet()`

`server-resolution.mjs` exports a `connectFleet()` helper that already does
resolution + transport construction + start + the mode-correct handshake in
one call (a stdio connection needs a manual `initialize` +
`notifications/initialized` pair; an HTTP connection does not, because
`StreamableHttpTransport.start()` performs that handshake internally as
part of its POST/session-id exchange -- sending the manual pair again on
HTTP would double-initialize). Prefer this for new workflow code:

```js
import { connectFleet } from '@apralabs/apra-fleet-client/server-resolution';

const { mcpClient, fleetApi, mode } = await connectFleet({ env: process.env });

// fleetApi is an ApraFleet(mcpClient) wrapper; mcpClient.request(...) also works directly.
```

A workflow that never needs the fleet server (like `hello-world`) can skip
this entirely -- there is no requirement to connect.

### Lower-level variant: `resolveFleetServerConnection()`

If you need to construct the transport yourself (for example, to pass
transport-specific options `connectFleet()` does not expose), call
`resolveFleetServerConnection()` directly and build the transport and
handshake from the resolved `mode`. The handshake step below is
**mode-conditional** -- only run it for `mode === 'stdio'`, since the HTTP
transport already performed its own handshake inside `transport.start()`:

```js
import { resolveFleetServerConnection } from '@apralabs/apra-fleet-client/server-resolution';
import { StdioTransport, StreamableHttpTransport } from '@apralabs/apra-fleet-client/transport';
import { McpClient } from '@apralabs/apra-fleet-client/client';

const resolution = await resolveFleetServerConnection({ env: process.env });
const transport = resolution.mode === 'http'
  ? new StreamableHttpTransport(resolution.url)
  : new StdioTransport(resolution.command, resolution.args);
await transport.start();

const mcpClient = new McpClient(transport);
if (resolution.mode === 'stdio') {
  await mcpClient.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: '<your-workflow-name>', version: '1.0.0' },
  });
  await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
}

// mcpClient.request(...) / an ApraFleet(mcpClient) wrapper from here on.
```

## 6. Importing the shared engine/client

The installed runtime tree (`~/.apra-fleet/node_modules/`) makes the shared
packages resolvable as ordinary bare specifiers from any workflow directory
under `~/.apra-fleet/workflows/` -- Node's normal upward `node_modules`
walk finds them, no npm install and no system Node package manager
required:

```js
import { WorkflowEngine } from '@apralabs/apra-fleet-workflow/engine';
import { resolveFleetServerConnection } from '@apralabs/apra-fleet-client/server-resolution';
```

Available subpath exports:

- `@apralabs/apra-fleet-workflow` (root), `@apralabs/apra-fleet-workflow/engine`,
  `@apralabs/apra-fleet-workflow/viewer`, `@apralabs/apra-fleet-workflow/viewer/html-utils`
- `@apralabs/apra-fleet-client` (root), `@apralabs/apra-fleet-client/client`,
  `@apralabs/apra-fleet-client/factory`, `@apralabs/apra-fleet-client/transport`,
  `@apralabs/apra-fleet-client/server-resolution`

`hello-world`'s `main.mjs` demonstrates the recommended defensive pattern
for a workflow that merely wants to *prove* the runtime resolves, without
crashing if it does not: use a **dynamic** `import(...).catch(() => ({}))`,
not a static `import { ... } from ...`. A static import throws
`ERR_MODULE_NOT_FOUND` during module resolution -- before a single line of
your file runs -- so it cannot be caught and reported as a soft failure. If
your workflow genuinely requires the engine (as opposed to merely probing
for it), a static import is fine and appropriate.

## 7. The schema pattern for workflows needing role schemas

If your workflow dispatches agents/roles that need the verdict/input JSON
schemas (the same ones `packages/apra-fleet-se/auto-sprint/contracts.mjs`
loads), follow the same resolution pattern documented in
`packages/apra-fleet-se/docs/cli-reference.md` ("Role schema resolution"):

1. Read `process.env.APRA_FLEET_SE_SCHEMAS_DIR` first -- the launcher sets
   this to `~/.apra-fleet/schemas` when it is unset, so under
   `apra-fleet workflow <name>` it is always populated with no code change
   on your part.
2. Fall back to a workflow-local `vendor/schemas/` directory you ship
   inside your own workflow tree, for the case where your workflow (or its
   entry file) is run directly with `node` (see Section 8) rather than
   through the launcher, so the env var was never set.

This is exactly the belt-and-braces pattern `auto-sprint`'s installed
workflow directory uses: `contracts.mjs` is not modified at all --
`APRA_FLEET_SE_SCHEMAS_DIR` is already its tier-1 override -- and the
`vendor/schemas/` copy inside `workflows/auto-sprint/` is the tier-3 hit
for a direct `node bin/cli.mjs` invocation.

## 8. Escape hatch: running a workflow with a system Node directly

Every installed workflow is a real file tree, and Section 2's install
payload is already self-sufficient on disk. If you already have a system
Node available, you can always run a workflow's entry directly instead of
going through `apra-fleet workflow <name>`:

```
node ~/.apra-fleet/workflows/<name>/<entry> [args]
```

For example: `node ~/.apra-fleet/workflows/auto-sprint/bin/cli.mjs --help`
or `node ~/.apra-fleet/workflows/hello-world/main.mjs one two`.

This costs no extra code or install step -- it works purely because the
installed workflow tree, the shared runtime under
`~/.apra-fleet/node_modules/`, and (where present) a workflow's own
`vendor/schemas/` fallback are already self-sufficient files on disk.

**This is a debug/power-user escape hatch, not an equally-supported
alternative to `apra-fleet workflow <name>`.** Running a workflow's entry
directly with `node` does **not** get:

- the launcher's env-var auto-wiring (`APRA_FLEET_SERVER_BIN`,
  `APRA_FLEET_SE_SCHEMAS_DIR` are not set for you -- you must set them
  yourself, or rely on a workflow's own fallback resolution such as its
  `vendor/schemas/` tier);
- `--list` (there is no discovery mechanism outside the launcher);
- the version-mismatch check (R10 in `docs/workflow-subsystem-plan.md`) --
  a stale on-disk workflow tree after `apra-fleet update` refreshed the
  built-ins gives no diagnostic under raw `node` invocation.

Prefer `apra-fleet workflow <name> [args...]` for normal use, including on
machines with no system Node installed at all -- that is the actual
product requirement this subsystem exists to satisfy (see
`docs/workflow-subsystem-plan.md` Section 1.1 for the full reasoning
behind keeping the launcher primary and raw-node secondary).

## 9. Worked example: authoring a trivial new workflow

1. Create `~/.apra-fleet/workflows/my-workflow/workflow.json`:

   ```json
   { "name": "my-workflow", "entry": "main.mjs", "description": "My first workflow" }
   ```

2. Create `~/.apra-fleet/workflows/my-workflow/main.mjs`:

   ```js
   const args = process.argv.slice(2);
   console.log(`[OK] my-workflow: args=${args.join(',')}`);
   process.exit(0);
   ```

3. Run it: `apra-fleet workflow my-workflow a b`. Expected output:
   `[OK] my-workflow: args=a,b`.

4. Confirm it is discoverable: `apra-fleet workflow --list` should show
   `my-workflow  [user]  My first workflow` alongside the built-ins.

No source code needs to be read to do this -- Sections 2-4 above are the
complete contract.
