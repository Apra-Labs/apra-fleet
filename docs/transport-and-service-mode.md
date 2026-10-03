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

You can override the default port with the `APRA_FLEET_PORT` environment variable.
If the configured port is already in use, the server refuses to start with an error
naming the port, the pid recorded in `server.json` (if any) and `APRA_FLEET_PORT`.
It exits 0 only when launched by a service manager -- `APRA_FLEET_SERVICE=1` (set by
the systemd unit, launchd plist and Windows task wrapper that `apra-fleet install`
writes), or systemd's `INVOCATION_ID` / launchd's `XPC_SERVICE_NAME` for older
installs -- so systemd/launchd do not restart a server that cannot start in a loop.
Every other launch (terminal, CI, nohup, containers, scripts) exits 1. The same
applies to refusing because an unresponsive server holds the data dir. It does not fall back to a random port: every configured MCP
client only knows the configured port, so a re-homed server would be unreachable.
Free the port, or set `APRA_FLEET_PORT` to a free port and re-run `apra-fleet install`
so the MCP clients point at it. `apra-fleet start` and `apra-fleet install` check the
port up front and print the same message. (Only an explicit port 0 -- used
internally and in tests -- binds an OS-assigned port.)

**Singleton probe states.** Before starting, `start`, `run`, `status` and `stop` probe
`server.json`:

- `running` -- the pid is alive and `GET /health` answers 200.
- `unresponsive` -- the pid is alive and the recorded port still accepts TCP, but
  `/health` does not answer (e.g. a blocked event loop). `server.json` is kept;
  `start`/`run` refuse with the pid/port and an `apra-fleet stop` hint, `status`
  shows `State: unresponsive`, and `stop` force-stops it.
- `gone` -- no `server.json`, the pid is dead, or the recorded port refuses TCP. Only
  this state removes `server.json`.

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

The service is always user-level on every OS, never a system service:

- Windows: a per-user Scheduled Task named `ApraFleet` (see below)
- Linux: a systemd user unit (`systemctl --user`, `Restart=on-failure`)
- macOS: a LaunchAgent in `~/Library/LaunchAgents/` (`KeepAlive` `SuccessfulExit=false`)

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

### Windows task definition

Install registers the task from a UTF-16 XML (`schtasks /create /tn ApraFleet /xml <file> /f`);
`/sc onlogon /rl limited` is "Access is denied" for a standard user. The XML has:

- a LogonTrigger scoped to the current `DOMAIN\user` (the only form a standard user may register)
- a TimeTrigger repeating every 5 minutes indefinitely, which revives a server that was killed or crashed
- `MultipleInstancesPolicy` IgnoreNew (the repeat is a no-op while the server runs)
- `ExecutionTimeLimit` PT0S, `StartWhenAvailable`, no stop on battery, InteractiveToken + LeastPrivilege

Task Scheduler RestartOnFailure is deliberately not used: it never fires for a killed or
non-zero-exit process. (`APRA_FLEET_TASK_REPEAT_MINUTES`, 1..1440, overrides the interval at
install time; test-only, not a supported setting.)

The task's action is `wscript.exe //B //Nologo //E:JScript "<bin>\apra-fleet-service.js"`, a
generated JScript launcher that runs `apra-fleet-service.bat` with window style 0 and waits:
no console window appears on the user's desktop (running the .bat directly opened one on every
start/revive, and closing it killed the server), and the server's exit code becomes the task's
Last Result. JScript was chosen over a .vbs (VBScript is being deprecated) and over
`conhost --headless` (undocumented). The .bat sets `APRA_FLEET_SERVICE=1`, re-creates the log dir
if it was deleted (otherwise the `>>` redirect fails before the server starts), and appends the
server's output to `fleet.log`. The HKCU Run fallback uses the same launcher.
Non-ASCII profile paths: the launcher is pure ASCII (non-ASCII path characters are `\uXXXX`
escapes, since WSH reads a .js in the ANSI code page) and the UTF-8 .bat switches cmd to UTF-8
(`chcp 65001`) before using any path. If Windows Script Host is disabled (probed at install), the
task runs the .bat directly instead -- the server then has a visible console window, and install
says so. Install reports "registered and running" only after the server answers /health.

If the XML create fails and an existing `ApraFleet` task already runs our wrapper, it is reused.
Only when there is no reusable task does install fall back to a per-user
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` entry (value `ApraFleet`) that starts the
wrapper at logon: autostart without automatic restart. Install and status say so; uninstall removes it.

### Stop, start, status

- `apra-fleet stop` disables the task first (`schtasks /change /disable`) so the repeating trigger
  cannot undo a deliberate stop. The stop sticks, including across logon, until `apra-fleet start`
  (or install) re-enables it. `uninstall` deletes the task.
- `apra-fleet status` shows `installed (enabled)`, or for a disabled task
  `installed (disabled -- stopped by user -- 'apra-fleet start' re-enables it)` (only when the
  stopped-by-user marker below exists; otherwise `task disabled outside apra-fleet`).
- On every OS `apra-fleet stop` writes `<data dir>/stopped-by-user.json` (time, command, user)
  and the stop sticks across logon and boot until `apra-fleet start` or `apra-fleet install`
  (the only two things that clear it): any service-manager launch (macOS LaunchAgent RunAtLoad,
  the enabled systemd user unit at boot, the Windows HKCU Run fallback, a task that could not be
  disabled) exits 0 without starting while the marker exists, and launchd `SuccessfulExit=false` /
  systemd `Restart=on-failure` do not restart an exit 0. No client auto-starts the server either
  (see below), and `apra-fleet status` shows
  `State: stopped (stopped by <user> at <time> via 'apra-fleet stop' -- run 'apra-fleet start')`.
  A port-only override (`APRA_FLEET_PORT` without `APRA_FLEET_DATA_DIR`) records the stop only
  after confirming the server it stops is on its own port.
- Only `APRA_FLEET_SERVICE=1` (set by our service templates) makes a launch skip on the marker;
  a hand-run `apra-fleet run` starts even in a shell that inherited `INVOCATION_ID` /
  `XPC_SERVICE_NAME`, and the marker stays. `apra-fleet status` then shows
  `State: running (stop marker set -- run 'apra-fleet start' to clear)`: clients still will not
  auto-start it if it dies. The server removes `APRA_FLEET_SERVICE` / `APRA_FLEET_AUTOSTART` from
  its environment at startup so nothing it spawns inherits them.

### Start back-off

Service launches (`APRA_FLEET_SERVICE=1`) back off: after 3 consecutive failed or refused starts,
launches are skipped for 30 minutes (one line to the service log `fleet.log`, exit 0, no new
`fleet-<pid>.log`). A successful start clears it; an explicit `apra-fleet start`/install clears it
first. State: `<data dir>/service-start-failures.json`.

### Client auto-start

Workflow/fleet-sprint clients (not Claude Code or other MCP hosts, which connect by URL and rely on
the service) start the shared HTTP server themselves when it is verifiably gone: they run
`apra-fleet start`, wait for `/health` (default 45s, `APRA_FLEET_AUTOSTART_TIMEOUT_MS`) and attach
over HTTP. They only start an apra-fleet of their own version and refuse on a version skew (run
`apra-fleet install`). After a deliberate `apra-fleet stop` they do not start it: they fail with
"apra-fleet was stopped by the user at <time> ...; run 'apra-fleet start'" -- also on a mid-run
reconnect. A fleet-sprint launched then fails fast with that message (supervisor `POST /api/sprints`
returns 503 with it; a sprint child prints it on stderr). See
`packages/apra-fleet-client/docs/api-reference.md`.

### Upgrading

- Windows: re-run `apra-fleet install` to get the new task definition (hidden launcher, revive
  trigger). An existing onlogon task keeps working (logon start only, no revive) until then.
- Scripts and workflows that relied on the client's private stdio self-spawn now start the SHARED
  HTTP server, which keeps running after they exit. Set `APRA_FLEET_TRANSPORT=stdio` to keep the
  old private, per-process server.
- `apra-fleet stop` now persists across logon and boot on every OS and blocks client auto-start
  until `apra-fleet start` (or `apra-fleet install`).
- The client only auto-starts an apra-fleet of its own version; after an upgrade that left an
  older registered binary, it fails with `AUTOSTART_VERSION_SKEW`. If the service already started
  the mismatched server it stays up (and other clients attach to it): `apra-fleet stop`, then
  `apra-fleet install` and `apra-fleet start`. `apra-fleet status` warns when the running server's
  version differs from the installed apra-fleet.
- The install summary reports "registered and running" only once the server answers /health
  (wait 30s by default; `APRA_FLEET_INSTALL_HEALTH_TIMEOUT_MS` overrides it, `0` skips the
  check).

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
