<!-- llm-context: Deep-dive on how the Fleet server runs and how clients connect to it -- transport protocol, the event bus, OS service registration, and which interfaces are actually supported. -->
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

## Reported service state: installed / enabled / running

`apra-fleet status` and the `ServiceManager.query()` contract each service
manager implements report state as three independent fields, not one
collapsed label:

- `installed` -- the OS service registration exists at all.
- `enabled` -- the registration is armed to auto-start. This field is
  genuinely **tri-state**: `true`, `false`, or `undefined` when the platform
  cannot determine it. `undefined` is not a synonym for `false` -- it means
  "no claim either way," and the CLI renders it as a bare `"installed"` label
  with no enable claim, never as `"installed (disabled)"`. Collapsing
  "unknown" into "disabled" is a definite wrong claim where saying less is
  correct, and this distinction exists because that exact collapse used to
  make a fully running, auto-starting service read as disabled.
- `running` -- whether the service process is currently up, independent of
  registration/enable state, and reported for every service line the CLI
  prints (not only the supervisor line), so a user checking health can see
  the run state of every managed service, not just one of them.

### Windows: two-tier query with an honest fallback

The Windows service manager's `query()` prefers a `Get-ScheduledTask`
PowerShell probe over the legacy `schtasks /query` CSV read, for two reasons:

1. **It is the only source that can answer `enabled` at all.** `schtasks`
   collapses "registered and armed" and "registered but disabled" into one
   localized `Status` string that cannot be mapped to an enable state
   reliably.
2. **It reports the numeric ScheduledTask state enum**, not a
   locale-dependent status string -- comparing a CSV `Status` column against
   an English literal like `"Running"` breaks on a non-English Windows
   install.

The probe is invoked as PowerShell with an explicit `-EncodedCommand`
(never string-interpolated shell invocation), per the project-wide rule
against relying on shell-level expansion for a member-bound or host-bound
command string; only a fixed, escaped, ASCII task name is interpolated into
the script body.

The probe is not a strict replacement for the CSV read -- it is consulted
first, and the CSV path remains as a fallback for hosts where the probe
cannot produce an interpretable result (no PowerShell available, non-zero
exit, or output this cannot parse). The fallback never invents an `enabled`
value for a status string it does not recognize; an unrecognized or
localized CSV status is reported as registered, not observably running, with
`enabled` left absent. A probe that runs but fails partway (cmdlet missing,
access denied) is a distinct, still-open hazard from a probe that cleanly
answers "no such task" -- treating the two as indistinguishable would
silently deny that an actually-registered, actually-running service exists,
which is the same class of failure this two-tier design exists to prevent
in the other direction.

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
