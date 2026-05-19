# Requirements -- apra-fleet OS Service Lifecycle

## Source
Follow-up to apra-fleet#258 / PR #273 (HTTP+SSE transport). Closes the live-test gap
filed as Beads apra-fleet-projects-jxj: the HTTP-transport install configures MCP clients
but nothing starts or registers the singleton server, so every install fails on first
connect (-32000) and again after every reboot.

## Base Branch
`feat/mcp-sse-transport` -- this work EXTENDS PR #273 (user decision 2026-05-19). Commit
directly onto that branch; no new branch. PR #273 stays open until this lands too, so
#273 ships a complete, self-installing HTTP transport.

## Goal
Make `apra-fleet` behave like a normal OS service: a small set of regular verbs to
install, start, stop, restart, check, and uninstall the singleton HTTP+SSE MCP server,
working uniformly on Windows, Linux, and macOS without requiring admin/root.

## Key Decisions (user, 2026-05-19)
1. **Land on PR #273** -- extend the existing branch, not a separate PR.
2. **Top-level verbs** -- `apra-fleet start | stop | restart | status` are top-level
   commands. Service registration/removal folds into the EXISTING `apra-fleet install`
   and `apra-fleet uninstall` (no separate `service` subcommand group).
3. **Per-user scope, no elevation** -- the service is registered and runs as the current
   user. No admin/root, no UAC prompt. One service per logged-in user.

## Scope

### Verbs
- `apra-fleet start` -- start the singleton HTTP server if not already running. Idempotent
  (if already running, report that and exit 0). Goes through the OS service manager when a
  service unit is installed; otherwise starts the process directly.
- `apra-fleet stop` -- stop the running server gracefully (SIGTERM/equivalent -> server
  cleans up server.json, lock file, sockets). Idempotent.
- `apra-fleet restart` -- stop then start.
- `apra-fleet status` -- report running/stopped, pid, port, url, version, uptime, active
  session count (query GET /health), and whether the service unit is installed. Must work
  whether or not the service unit is installed.
- `apra-fleet install` -- EXTENDED: after installing the binary and writing MCP client
  config (existing behaviour), also register the per-user service unit and start it, so
  the server is live immediately and on every login. ASCII-only output.
- `apra-fleet uninstall` -- EXTENDED: stop the server, remove the service unit, and remove
  the MCP client config. Fully reverses `install`, leaving no orphaned unit or config.

### Per-OS service mechanism (per-user, no elevation)
- **Windows:** per-user Scheduled Task (schtasks) with an at-logon trigger, startable and
  stoppable on demand. No Windows Service / SCM (that needs admin). Built-in tooling only.
- **Linux:** systemd user unit at `~/.config/systemd/user/apra-fleet.service`, managed via
  `systemctl --user`. Plan must address start-on-boot-without-login (loginctl
  enable-linger) and a graceful fallback/clear error if systemd user mode is unavailable.
- **macOS:** launchd LaunchAgent plist at `~/Library/LaunchAgents/<label>.plist`, managed
  via `launchctl` (bootstrap/bootout/kickstart), RunAtLoad for start-on-login.

The plan MUST explicitly walk through all three OSes for every verb -- no
"and similarly for X". Each verb x each OS is a defined behaviour.

## Cross-cutting requirements
- The service invokes the INSTALLED binary at its stable path (e.g.
  `~/.apra-fleet/bin/apra-fleet.exe`), never a transient build path.
- The service runs the server in HTTP transport mode (the singleton on port 7523 /
  fallback). Interplays correctly with the existing server.json, the singleton startup
  lock, and `--transport`.
- Service stdout/stderr is redirected to a log file under the fleet data dir.
- `start`/`stop`/`install`/`uninstall` are all idempotent -- safe to run twice.
- Graceful stop: the server's existing SIGINT/SIGTERM handlers must fire so server.json
  and the lock file are cleaned up.
- `status` is useful even with no service unit installed (read server.json + GET /health).
- All command output is ASCII-only (pre-commit hook); cross-platform with no platform or
  provider assumptions in shared code.

## Out of Scope
- System-wide service (Windows SCM service, systemd system unit, launchd LaunchDaemon) --
  excluded by the per-user decision; would require elevation.
- TLS / auth on the HTTP endpoint; remote (non-localhost) serving -- separate follow-up.
- Auto-update / self-update of the running service.

## Constraints
- Per-user only -- no command in this sprint may require admin/root or trigger UAC.
- Cross-platform: Windows / Linux / macOS. Built-in OS tooling preferred (schtasks,
  systemctl --user, launchctl) over new npm dependencies.
- ASCII-only in all committed files (pre-commit hook).
- No regression to the existing `install` MCP-config behaviour or the stdio transport.
- Extends PR #273 -- all existing #258 acceptance criteria must still hold.

## Acceptance Criteria
- [ ] `apra-fleet install` (default) registers a per-user service and the server is
      running immediately afterwards -- a fresh MCP client connects with no manual step.
- [ ] The server comes back automatically after a reboot / re-login, on all three OSes.
- [ ] `apra-fleet start | stop | restart | status` work as described, idempotently, on
      Windows, Linux, and macOS.
- [ ] `apra-fleet status` reports pid/port/url/version/uptime/sessions and service-unit
      state, and works whether or not the unit is installed.
- [ ] `apra-fleet uninstall` stops the server and removes the service unit and MCP config
      with nothing orphaned.
- [ ] No elevation/admin/root or UAC prompt is required by any verb.
- [ ] Tests cover the verb logic and the per-OS service-manager adapter; full existing
      suite stays green; pre-commit ASCII hook passes.
- [ ] Docs (README + docs/architecture.md) updated for the service model and verbs.
