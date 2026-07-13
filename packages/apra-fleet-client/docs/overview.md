# apra-fleet-client -- Overview

## What this package is

`@apralabs/apra-fleet-client` is the MCP client SDK for Apra Fleet. It is a
small, dependency-free (aside from Node built-ins) Node.js library that
knows how to:

1. Open a connection to a running `apra-fleet` MCP server, either as a
   spawned child process (stdio) or over HTTP+SSE.
2. Speak the JSON-RPC 2.0 request/response protocol MCP uses, including
   request IDs, timeouts, and cancellation.
3. Expose the fleet server's tool surface (`execute_prompt`,
   `execute_command`, `list_members`, `fleet_status`, `send_files`,
   `receive_files`, `register_member`, `update_member`, `remove_member`) as
   a typed, promise-based JavaScript API instead of raw `tools/call`
   payloads.

It is a **transport and protocol** layer. It does not implement any
scheduling, retry, workflow, or orchestration logic of its own -- it hands
callers a clean way to issue one MCP request and get one MCP response (or a
timeout/abort error). Anything stateful or multi-step (sprints, phases,
budgets, dashboards) lives one layer up, in `@apralabs/apra-fleet-workflow`.

## The problem it solves

The `apra-fleet` MCP server exposes its capabilities as MCP tools over
JSON-RPC. Any Node.js code that wants to drive a fleet programmatically
(rather than through a chat-driven LLM client like Claude Code) would
otherwise have to hand-roll:

- process spawning and stdout/stdin line-framing for the stdio transport, or
  the two-request SSE handshake (POST to initialize, GET to open the event
  stream) for the HTTP transport;
- JSON-RPC message construction and ID correlation;
- a timeout policy so a server that accepts a request and never replies
  doesn't hang the caller forever;
- cancellation plumbing so an in-flight wait can be abandoned locally.

`apra-fleet-client` does all of that once, correctly, and packages it
behind a small `ApraFleet` class whose methods map 1:1 to the server's MCP
tools.

## How it fits into the broader apra-fleet system

Per the monorepo architecture (see `docs/adr-monorepo.md` at the repo
root), `apra-fleet-client` is one of three packages that make up
`apra-fleet-core`, the horizontal, domain-agnostic foundation:

- **`apra-fleet`** -- the MCP server itself (a separate process/binary,
  `apra-fleet.exe` or equivalent, referred to as "the fleet-server" in this
  package's source comments). It owns fleet members, SSH connections,
  credentials, and actually executes prompts/commands on member machines.
- **`@apralabs/apra-fleet-client`** (this package) -- the MCP client SDK
  that talks to that server: transports + JSON-RPC plumbing + a typed API.
- **`@apralabs/apra-fleet-workflow`** -- the dynamic workflow engine built
  on top of the client. It depends on `apra-fleet-client` (see its
  `package.json`), not the other way around: `apra-fleet-client` has no
  knowledge of workflows, phases, budgets, or agent personas.

Domain-specific editions (`apra-fleet-se` for software engineering, and in
principle other verticals) depend on `apra-fleet-core` as a whole and build
skills, hooks, and workflows on top of it. `apra-fleet-se`'s `package.json`
lists `@apralabs/apra-fleet-client` as a direct dependency.

## Who should use it, and why

- **`apra-fleet-workflow`** and any other package that needs to script a
  fleet programmatically (rather than through a conversational LLM client)
  uses `apra-fleet-client` as its transport/protocol foundation. The
  `createWorkflowEngine()` factory (`src/client/factory.mjs`) exists
  specifically to wire a transport, an `ApraFleet` API instance, and a
  `FleetWorkflow`/`WorkflowEngine` together in one call for that use case.
- **Anyone writing a standalone Node.js tool or script** that wants to
  drive a running fleet server directly -- list members, run a command on
  one, ship files to/from it -- without pulling in the full workflow engine
  can depend on `apra-fleet-client` alone and use `ApraFleet` +
  `McpClient` + a transport directly.
- It is not intended for end users interacting through a chat UI; those
  users go through an LLM CLI (Claude Code, Antigravity, Gemini, Codex,
  ...) that talks MCP natively. This package is for programmatic,
  code-level fleet automation.

## Public entry points

Declared in `package.json#exports`:

| Import path | File | Contents |
|---|---|---|
| `@apralabs/apra-fleet-client` | `src/client/api.mjs` | `ApraFleet` class, `deriveTimeoutMs()` |
| `@apralabs/apra-fleet-client/client` | `src/client/client.mjs` | `McpClient` class, `DEFAULT_REQUEST_TIMEOUT_MS` |
| `@apralabs/apra-fleet-client/factory` | `src/client/factory.mjs` | `createWorkflowEngine()` |
| `@apralabs/apra-fleet-client/transport` | `src/client/transport.mjs` | `StdioTransport`, `StreamableHttpTransport` |

`src/client/errors.mjs` (`ClientError`, `TimeoutError`, `AbortError`) is not
listed in `exports` but its instances are the error/rejection values
thrown by `McpClient.request()`; catching code typically discriminates on
`err.code` rather than importing the classes directly.

See `api-reference.md` for full method-by-method documentation and
`getting-started.md` for usage examples.

## A note on the `factory` entry point

`src/client/factory.mjs` imports `FleetWorkflow` from
`'../workflow/index.mjs'` and `WorkflowEngine` from `'../workflow/engine.mjs'`
-- paths that would resolve to `src/workflow/*` *inside this package*.
This package has no `src/workflow` directory; that code actually lives in
the separate `@apralabs/apra-fleet-workflow` package
(`packages/apra-fleet-workflow/src/workflow/`). See "Known issues" in
`api-reference.md` for details -- this affects only the `./factory` export;
the `.` , `./client`, and `./transport` exports are self-contained and
unaffected.
