<!-- llm-context: Deep-dive on how the Fleet server runs and how clients connect to it -- transport protocol, the event bus, OS service registration, and which interfaces are actually supported. Migrated out of README.md on 2026-07-24 to keep the README landing page short; content unchanged. -->
<!-- keywords: transport, HTTP, SSE, stdio, server.json, event bus, service mode, systemd, LaunchAgent, Scheduled Task, singleton, supported interfaces, cli.mjs -->
<!-- see-also: ../README.md (quickstart), install.md (installation), architecture.md (internals) -->

# Transport, Service Mode, and Supported Interfaces

Fleet runs as a singleton service on your machine. When you start it, the server
listens on port 7523 by default and multiple LLM clients (Claude Code, Antigravity,
Copilot, Codex) connect concurrently to the same fleet instance.

## HTTP+SSE Transport (default)

By default, fleet uses the **HTTP+SSE transport** -- clients connect over HTTP and
receive server-push notifications over Server-Sent Events (SSE).

```bash
apra-fleet start                 # Start HTTP server (default)
apra-fleet start --transport http # Explicitly use HTTP
```

When the server starts, it writes a `server.json` file to `~/.apra-fleet/` containing:
```json
{
  "pid": 12345,
  "port": 7523,
  "url": "http://localhost:7523/mcp",
  "version": "x.y.z",
  "startedAt": "2026-05-19T..."
}
```

If port 7523 is busy, the server falls back to port 0 (OS-assigned random port) and
records the actual port in `server.json`. You can override the default port with the
`APRA_FLEET_PORT` environment variable.

**Multiple clients, one server.** When a second LLM client starts, it reads
`server.json`, detects the running server, and connects to it. All clients share the
same fleet instance -- no restart needed. When you close all clients, the server
keeps running (as a singleton service on your machine). It shuts down on explicit
exit (`apra-fleet --shutdown` tool) or on system reboot.

**Re-register with HTTP.** When you upgrade or re-install Fleet, run:
```bash
apra-fleet install  # Registers fleet with HTTP transport (default)
```

## Event Bus

The event bus is an internal notification system. When a subsystem (like credential
storage) completes an operation, it emits an event, and the HTTP server broadcasts
the notification to all connected clients via SSE. This lets clients respond
immediately to fleet events without polling.

## Backward Compatibility: stdio Transport

Existing fleets can continue using the stdio transport:

```bash
apra-fleet start --transport stdio # Use legacy stdio transport
apra-fleet start --stdio            # Alias for --transport stdio
```

When you run `apra-fleet install --transport stdio`, the MCP config keeps the old
command-based format (no HTTP URL). The server's behavior is identical to pre-HTTP
versions: it reads JSON-RPC from stdin, writes responses to stdout, and communicates
with one client at a time via the stdio pipe.

If you want to stay on stdio for now, run:
```bash
apra-fleet install --transport stdio
```

If you later switch back to HTTP, re-run the default install:
```bash
apra-fleet install  # Switches to HTTP transport
```

## Service Mode

Fleet keeps a singleton server running so all your LLM clients share one instance.
Registering it as an OS service keeps it alive across terminal sessions -- the server
survives terminal close and restarts automatically on login:

- Windows: a per-user Scheduled Task (Task Scheduler, OnLogon trigger)
- Linux: a systemd user unit (`systemctl --user`)
- macOS: a LaunchAgent in `~/Library/LaunchAgents/`

Four verbs manage the lifecycle directly:

```
apra-fleet start    # start the server (idempotent -- exits cleanly if already running)
apra-fleet stop     # graceful shutdown: POST /shutdown, poll, force-kill fallback
apra-fleet restart  # stop then start
apra-fleet status   # state, PID, port, uptime, version, and OS service status
```

`install` and `uninstall` include service registration. Running
`apra-fleet install` on a packaged binary with the HTTP transport (the default)
registers and starts the OS service automatically -- no extra step.
`apra-fleet uninstall` stops and deregisters the service before removing files.
Service registration failures are non-fatal: a warning is printed and the install
continues.

## Supported user-facing interfaces

Fleet exposes exactly one supported user-facing interface: the **service HTTP
API** and its **web dashboard**. Users interact with Fleet exclusively through:

- The **HTTP API** and Server-Sent Events (SSE) transport on port 7523
- The **web dashboard** in Claude Code via the `/mcp` loader
- The PM skill commands in Claude Code (`/pm`)

The `bin/cli.mjs` entry point in the fleet-sprint package is an **internal
implementation detail** -- it is used only by the supervisor process to
orchestrate agent workflows and does NOT bypass the reservation ledger. Direct
manual invocation of `cli.mjs` circumvents the reservation system and is
unsupported; use the service API and dashboard instead.
