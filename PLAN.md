# Apra Fleet -- OS Service Lifecycle Implementation Plan

> Make apra-fleet behave like a normal OS service: top-level start/stop/restart/status
> verbs, per-user service registration folded into install/uninstall, and cross-platform
> support for Windows (schtasks), Linux (systemd --user), and macOS (launchd LaunchAgent)
> -- all without elevation or admin rights. Extends PR #273 on feat/mcp-sse-transport.

---

## Design Summary

The implementation adds three new layers to the existing codebase:

1. **Service Manager Adapter** (`src/services/service-manager/`) -- a single TypeScript
   interface (`ServiceManager`) with three OS-specific implementations (Windows schtasks,
   Linux systemd, macOS launchd). The factory selects the right adapter at runtime via
   `process.platform`. All adapters operate in per-user scope with no elevation.

2. **Graceful Shutdown Endpoint** -- a `POST /shutdown` handler on the existing HTTP
   server (localhost-only, same trust boundary as `/mcp`). This enables cross-platform
   graceful stop without relying on OS signal semantics (Windows cannot send SIGTERM to
   external processes).

3. **CLI Verbs** (`src/cli/start.ts`, `stop.ts`, `restart.ts`, `status.ts`) -- thin
   command modules wired into the existing dispatch table in `src/index.ts`. Each verb
   is idempotent. `start` goes through the service manager when a unit is installed,
   otherwise spawns the process directly. `stop` always uses the HTTP /shutdown endpoint
   for cross-platform graceful shutdown. `status` queries both server.json/health and the
   service manager.

**Service unit configuration by OS:**
- **Windows:** Per-user Scheduled Task "ApraFleet" with at-logon trigger, /rl limited
  (no elevation). A wrapper .bat script in BIN_DIR handles stdout/stderr redirection to
  the log file (schtasks cannot redirect output natively).
- **Linux:** systemd user unit at `~/.config/systemd/user/apra-fleet.service`.
  Type=simple, Restart=on-failure, StandardOutput/StandardError=append:logPath.
  loginctl enable-linger attempted with a warning on failure.
- **macOS:** LaunchAgent plist at `~/Library/LaunchAgents/com.apra-fleet.server.plist`.
  RunAtLoad=true, KeepAlive.SuccessfulExit=false (restart on crash, not on clean exit).
  StandardOutPath/StandardErrorPath point to the log file.

**Graceful stop mechanism:** The server's existing SIGINT/SIGTERM handlers exit with
code 0 after cleaning up server.json, lock file, and connections. Service managers
configured with Restart=on-failure (systemd) and KeepAlive.SuccessfulExit=false (launchd)
will NOT restart the process after a clean exit. This means the CLI `stop` command
(which triggers a clean exit via /shutdown) is compatible with managed services.

---

## Verb x OS Matrix

The table below defines the exact behavior for every verb on every OS, both when a
service unit is installed and when it is not. No "and similarly for X" -- each cell is
explicit.

### start

| OS      | Service Installed                                          | No Service Installed                                    |
|---------|------------------------------------------------------------|---------------------------------------------------------|
| Windows | `schtasks /run /tn "ApraFleet"`                            | Spawn detached: `apra-fleet.exe --transport http`       |
| Linux   | `systemctl --user start apra-fleet`                        | Spawn detached: `apra-fleet --transport http`           |
| macOS   | `launchctl kickstart gui/<uid>/com.apra-fleet.server`      | Spawn detached: `apra-fleet --transport http`           |

All: Idempotent -- checkRunningInstance() first; if already running, report and exit 0.
When spawning directly, stdout/stderr redirect to ~/.apra-fleet/data/fleet.log.

### stop

| OS      | Behavior                                                                              |
|---------|---------------------------------------------------------------------------------------|
| Windows | Read server.json -> POST /shutdown -> wait up to 5s for exit -> fallback taskkill /F  |
| Linux   | Read server.json -> POST /shutdown -> wait up to 5s for exit -> fallback kill -TERM   |
| macOS   | Read server.json -> POST /shutdown -> wait up to 5s for exit -> fallback kill -TERM   |

All: Idempotent -- if not running (server.json missing or pid dead), report and exit 0.
Clean up stale server.json and lock file if found. The HTTP /shutdown approach is used
on all OSes for consistency; service managers do not restart because the process exits 0.

### restart

| OS      | Behavior              |
|---------|-----------------------|
| Windows | stop (above) then start (above) |
| Linux   | stop (above) then start (above) |
| macOS   | stop (above) then start (above) |

### status

| OS      | Behavior                                                                              |
|---------|---------------------------------------------------------------------------------------|
| Windows | server.json + GET /health + `schtasks /query /tn "ApraFleet" /fo csv /nh`             |
| Linux   | server.json + GET /health + `systemctl --user is-active` + `is-enabled`               |
| macOS   | server.json + GET /health + `launchctl print gui/<uid>/com.apra-fleet.server`         |

All: Works whether or not service unit is installed. Reports: running/stopped, pid, port,
url, version, uptime, active sessions, service unit state (installed/not, enabled/not).

### install (extended)

| OS      | Additional Steps (after existing install)                                             |
|---------|---------------------------------------------------------------------------------------|
| Windows | Write wrapper.bat to BIN_DIR. `schtasks /create /tn "ApraFleet" /tr "<wrapper>" /sc onlogon /rl limited /f`. `schtasks /run /tn "ApraFleet"`. |
| Linux   | Write unit file to ~/.config/systemd/user/apra-fleet.service. `systemctl --user daemon-reload`. `systemctl --user enable apra-fleet`. `systemctl --user start apra-fleet`. Attempt `loginctl enable-linger $USER` (warn on failure). |
| macOS   | Write plist to ~/Library/LaunchAgents/com.apra-fleet.server.plist. `launchctl bootstrap gui/<uid> <plist>`. |

All: Only when --transport http (default). Skipped for --transport stdio. Skipped in
dev mode (non-SEA). Server is running immediately after install.

### uninstall (extended)

| OS      | Additional Steps (before existing uninstall)                                          |
|---------|---------------------------------------------------------------------------------------|
| Windows | POST /shutdown (graceful stop). `schtasks /delete /tn "ApraFleet" /f`. Remove wrapper.bat. |
| Linux   | `systemctl --user stop apra-fleet`. `systemctl --user disable apra-fleet`. Remove unit file. `systemctl --user daemon-reload`. |
| macOS   | `launchctl bootout gui/<uid>/com.apra-fleet.server`. Remove plist file.               |

All: Idempotent -- each step tolerates "not found" errors. Replaces the existing
isApraFleetRunning/killApraFleet approach with graceful /shutdown + service cleanup.

---

## Tasks

### Phase 1: Platform Service Foundation

Front-loads the two riskiest assumptions: (a) per-user service management without
elevation on all three OSes, (b) cross-platform graceful stop. If schtasks/systemctl/
launchctl cannot be called without elevation, this phase fails immediately -- before
any CLI verb or install integration work is done.

#### Task 1: Shutdown endpoint and service constants

- **Change:** Add a POST /shutdown endpoint to the HTTP server in http-transport.ts.
  When hit, send a 200 JSON response (`{ "status": "shutting-down" }`), then trigger
  graceful shutdown after a 100ms delay by emitting the process SIGINT event (which
  fires the existing shutdown handler chain in index.ts). Add LOG_FILE_PATH constant
  to paths.ts (`~/.apra-fleet/data/fleet.log`). Create the service-manager types file
  with service name constants: WINDOWS_TASK_NAME="ApraFleet",
  LINUX_UNIT_NAME="apra-fleet.service",
  MACOS_PLIST_LABEL="com.apra-fleet.server".
- **Files:** src/services/http-transport.ts, src/paths.ts,
  src/services/service-manager/types.ts (new)
- **Tier:** cheap
- **Done when:** POST to /shutdown triggers clean server shutdown (server.json deleted,
  lock released, process exits 0). LOG_FILE_PATH and service name constants exported.
- **Blockers:** None -- builds on existing HTTP handler infrastructure.

#### Task 2: ServiceManager interface and factory

- **Change:** Define the ServiceManager interface with methods: register(binaryPath,
  args, logPath), unregister(), start(), stop(), query() returning ServiceStatus,
  isInstalled() returning boolean. ServiceStatus includes fields: installed, running,
  pid (optional), enabled (optional). Create a factory function getServiceManager()
  that returns the correct adapter based on process.platform ('win32' -> Windows,
  'linux' -> Linux, 'darwin' -> macOS). For unsupported platforms, return a no-op stub
  that logs a warning and returns safe defaults (installed=false, running=false).
- **Files:** src/services/service-manager/types.ts (extend),
  src/services/service-manager/index.ts (new)
- **Tier:** standard
- **Done when:** Interface compiles. Factory returns per-platform implementation. Stub
  adapter returns safe defaults without throwing on unsupported platforms.
- **Blockers:** None.

#### Task 3: Windows Scheduled Task adapter

- **Change:** Implement WindowsServiceManager class.
  - register(binaryPath, args, logPath): Write a wrapper batch script to BIN_DIR
    (`apra-fleet-service.bat`) that runs the binary with args and redirects
    stdout/stderr to logPath. Create a per-user Scheduled Task via
    `schtasks /create /tn "ApraFleet" /tr "<wrapper-path>" /sc onlogon /rl limited /f`.
    No elevation required for per-user tasks.
  - unregister(): `schtasks /delete /tn "ApraFleet" /f`. Remove wrapper script.
    Tolerate "task not found" error.
  - start(): `schtasks /run /tn "ApraFleet"`.
  - stop(): Read server.json for URL. POST /shutdown. Wait up to 5s for process exit
    (poll pid). Fallback: `taskkill /F /PID <pid>`.
  - query(): Parse `schtasks /query /tn "ApraFleet" /fo csv /nh` output. Extract
    status (Running/Ready/Disabled) and combine with server.json data.
  - isInstalled(): Run `schtasks /query /tn "ApraFleet"` -- success means installed.
- **Files:** src/services/service-manager/windows.ts (new)
- **Tier:** standard
- **Done when:** All methods implemented. No UAC prompt triggered. Commands use
  child_process.execFile (not shell) where possible for safety.
- **Blockers:** "Log on as a batch job" right -- may be restricted on domain-joined
  machines. See risk register.

#### Task 4: Linux systemd user unit adapter

- **Change:** Implement LinuxServiceManager class.
  - register(binaryPath, args, logPath): Write a systemd user unit file to
    `~/.config/systemd/user/apra-fleet.service` with [Unit] Description, [Service]
    Type=simple, ExecStart=<binaryPath> <args>, Restart=on-failure,
    StandardOutput=append:<logPath>, StandardError=append:<logPath>, [Install]
    WantedBy=default.target. Run `systemctl --user daemon-reload` then
    `systemctl --user enable apra-fleet`. Attempt `loginctl enable-linger $USER` and
    warn (not error) if it fails.
  - unregister(): `systemctl --user disable apra-fleet`,
    `systemctl --user stop apra-fleet` (tolerate not-running),
    remove unit file, `systemctl --user daemon-reload`.
  - start(): `systemctl --user start apra-fleet`.
  - stop(): `systemctl --user stop apra-fleet` (sends SIGTERM, handled gracefully by
    existing handler). Tolerate not-running.
  - query(): `systemctl --user is-active apra-fleet` (active/inactive/failed),
    `systemctl --user is-enabled apra-fleet` (enabled/disabled).
  - isInstalled(): Check if unit file exists at the expected path.
  - Non-systemd detection: Before any operation, check for systemd user bus
    (XDG_RUNTIME_DIR + /run/user/<uid>/systemd). If absent, throw with clear message:
    "systemd user mode is not available. Service management requires systemd."
- **Files:** src/services/service-manager/linux.ts (new)
- **Tier:** standard
- **Done when:** All methods implemented. Non-systemd systems get a clear, actionable
  error. loginctl linger is attempted with a non-fatal warning on failure.
- **Blockers:** loginctl enable-linger may need root. See risk register.

#### Task 5: macOS launchd LaunchAgent adapter

- **Change:** Implement MacOSServiceManager class.
  - register(binaryPath, args, logPath): Write a plist to
    `~/Library/LaunchAgents/com.apra-fleet.server.plist` with Label, ProgramArguments
    (array: [binaryPath, ...args]), RunAtLoad=true, KeepAlive with
    SuccessfulExit=false, StandardOutPath=logPath, StandardErrorPath=logPath. Load via
    `launchctl bootstrap gui/<uid> <plist-path>`.
  - unregister(): `launchctl bootout gui/<uid>/com.apra-fleet.server`. Remove plist.
    Tolerate "not loaded" error.
  - start(): `launchctl kickstart gui/<uid>/com.apra-fleet.server`.
  - stop(): POST /shutdown to server URL from server.json (same as Windows approach --
    clean exit 0 prevents KeepAlive restart). Wait up to 5s, fallback kill -TERM.
  - query(): Parse output of `launchctl print gui/<uid>/com.apra-fleet.server` for
    pid and state. If command fails (not loaded), return installed=false.
  - isInstalled(): Check plist file exists at expected path.
  - uid retrieval: Use `id -u` or process.getuid() to get the current user's uid for
    the gui/<uid> domain specifier.
- **Files:** src/services/service-manager/macos.ts (new)
- **Tier:** standard
- **Done when:** All methods implemented. No elevation required. bootstrap/bootout
  API used (available since macOS 10.10).
- **Blockers:** None significant. See risk register for macOS version note.

#### Task 6: Service manager unit tests

- **Change:** Write vitest tests for all three adapters. Use vi.mock to mock
  child_process.execFile and child_process.execFileSync. For each adapter, test:
  register (verifies correct command/args), unregister (verifies cleanup commands),
  start (verifies start command), stop (verifies graceful shutdown attempt), query
  (mock command output, verify parsed ServiceStatus), isInstalled (mock success/failure).
  Test edge cases: already registered (idempotent register), not installed (idempotent
  unregister), process not running (stop is no-op), non-systemd Linux (clear error
  thrown). Use vi.hoisted for mock definitions per existing test conventions.
- **Files:** tests/service-manager.test.ts (new)
- **Tier:** standard
- **Done when:** Tests cover all adapter methods and key error paths. All pass.
  Existing test suite (npm test) stays fully green.
- **Blockers:** None -- tests mock OS commands, no real services created.

#### VERIFY: Platform Service Foundation
- Run full test suite (npm test)
- Confirm all Phase 1 changes compile cleanly
- Confirm no regressions in existing tests
- Report: tests passing, adapter coverage, any issues

---

### Phase 2: CLI Verbs

Build the four new top-level commands. Each is a thin module in src/cli/ wired into
the dispatch table in src/index.ts.

#### Task 7: start and stop commands

- **Change:** Create src/cli/start.ts with exported runStart(args). Logic:
  (1) checkRunningInstance() -- if running, log "Server already running at <url>
  pid=<pid>" and exit 0 (idempotent). (2) Get service manager via getServiceManager().
  If service is installed, call serviceManager.start(). (3) If no service installed,
  spawn the binary in detached mode with stdout/stderr redirected to LOG_FILE_PATH.
  Binary path: process.execPath for SEA mode; for dev mode, use process.execPath (node)
  with args [dist/index.js, --transport, http]. Wait 2s then verify server started via
  checkRunningInstance. Report success or failure.
  Create src/cli/stop.ts with exported runStop(args). Logic: (1) checkRunningInstance()
  -- if not running, log "Server is not running." and exit 0 (idempotent). (2) Read URL
  from server.json. POST /shutdown to the URL. (3) Poll pid alive every 500ms for up to
  5s. (4) If process still alive after timeout, force kill: process.kill(pid, 'SIGTERM')
  on Unix, taskkill /F /PID on Windows. (5) Clean up stale server.json and lock file.
  Report "Server stopped."
  Wire both commands into src/index.ts dispatch: `arg === 'start'` and `arg === 'stop'`
  with dynamic imports, same pattern as existing install/uninstall/secret/auth dispatch.
- **Files:** src/cli/start.ts (new), src/cli/stop.ts (new), src/index.ts
- **Tier:** cheap
- **Done when:** `apra-fleet start` starts the server (or reports already running).
  `apra-fleet stop` stops the server gracefully (or reports not running). Both are
  idempotent with exit code 0.
- **Blockers:** Depends on Phase 1 (service manager, /shutdown endpoint).

#### Task 8: restart command

- **Change:** Create src/cli/restart.ts with exported runRestart(args). Import and call
  runStop(args) then runStart(args). Wire into src/index.ts dispatch table.
- **Files:** src/cli/restart.ts (new), src/index.ts
- **Tier:** cheap
- **Done when:** `apra-fleet restart` stops then starts the server. Works whether or not
  the server was running (stop is idempotent).
- **Blockers:** Depends on T7.

#### Task 9: status command

- **Change:** Create src/cli/status.ts with exported runStatus(args). Logic:
  (1) Read server.json -- if present and pid alive, GET /health to obtain version,
  uptime, sessions, port, url. (2) Query service manager via getServiceManager().query()
  for unit state (installed, enabled, running from service perspective). (3) Format
  output:
  ```
  apra-fleet status
    State:    running | stopped
    PID:      <pid>
    Port:     <port>
    URL:      <url>
    Version:  <version>
    Uptime:   <Xh Ym Zs>
    Sessions: <count>
    Service:  installed (enabled) | installed (disabled) | not installed
  ```
  If server is not running, show "State: stopped" and omit pid/port/url/uptime/sessions.
  Service line always shown regardless of server state.
  Wire into src/index.ts dispatch table.
- **Files:** src/cli/status.ts (new), src/index.ts
- **Tier:** standard
- **Done when:** `apra-fleet status` shows all required fields. Works correctly whether
  server is running or not, and whether service unit is installed or not.
- **Blockers:** Depends on Phase 1 (service manager query).

#### Task 10: CLI verb tests and --help update

- **Change:** Update the --help output in src/index.ts to include the four new verbs:
  ```
  apra-fleet start                    Start the fleet server
  apra-fleet stop                     Stop the fleet server
  apra-fleet restart                  Restart the fleet server
  apra-fleet status                   Show server and service status
  ```
  Write tests in tests/cli-verbs.test.ts covering: start when already running (idempotent),
  start when not running (spawns process or uses service manager), stop when running
  (sends /shutdown), stop when not running (idempotent), restart (stop then start),
  status with running server (full output), status with stopped server (partial output),
  status with/without service installed. Mock checkRunningInstance, HTTP calls, service
  manager, and child_process.spawn.
- **Files:** src/index.ts, tests/cli-verbs.test.ts (new)
- **Tier:** standard
- **Done when:** --help lists all verbs. Tests cover all verb logic and edge cases. All
  tests pass. Pre-commit ASCII hook passes.
- **Blockers:** None.

#### VERIFY: CLI Verbs
- Run full test suite (npm test)
- Verify `apra-fleet --help` includes all new verbs
- Confirm no regressions in existing tests
- Report: tests passing, verb behavior verified

---

### Phase 3: Install/Uninstall Integration

Wire the service manager adapter into the existing install and uninstall commands. The
existing install steps (binary, hooks, scripts, settings, MCP, skills) are unchanged;
service registration is additive. For uninstall, service removal is prepended.

#### Task 11: Extend install to register and start service

- **Change:** In src/cli/install.ts, after the existing final step (Beads tracker
  install + permissions + install-config.json), add a new step:
  (1) If transport === 'http' and isSea() (installed binary exists), call
  serviceManager.register(binaryPath, ['--transport', 'http'], LOG_FILE_PATH) then
  serviceManager.start(). (2) If transport === 'stdio', skip service registration (stdio
  transport is per-client, not a persistent service). (3) In dev mode (!isSea()), skip
  service registration but optionally start the server directly.
  Update the install output to include a "Service: registered and running" line.
  Update totalSteps calculation to include the new step.
- **Files:** src/cli/install.ts
- **Tier:** standard
- **Done when:** `apra-fleet install` registers the per-user service and the server is
  running immediately afterward. A fresh MCP client connects without any manual step.
  The existing install behavior (binary, hooks, settings, MCP, skills) is unchanged.
- **Blockers:** Service manager adapter must be complete (Phase 1).

#### Task 12: Extend uninstall to stop and remove service

- **Change:** In src/cli/uninstall.ts, before the existing provider cleanup loop, add:
  (1) If server is running, stop it gracefully via POST /shutdown (replacing the existing
  isApraFleetRunning/killApraFleet approach -- which does a hard kill -- with the graceful
  /shutdown endpoint). Wait for exit. (2) Call serviceManager.unregister() to remove the
  service unit on the current OS. Tolerate "not installed" (idempotent).
  The existing cleanup steps (settings cleanup, skill removal, binary removal) remain
  unchanged. The --force flag triggers the graceful /shutdown approach instead of the
  old killApraFleet hard kill.
- **Files:** src/cli/uninstall.ts
- **Tier:** standard
- **Done when:** `apra-fleet uninstall` stops the server gracefully, removes the service
  unit, and removes MCP config. No orphaned service units, plist files, or scheduled
  tasks remain.
- **Blockers:** Depends on T11 (service registration during install).

#### Task 13: Install/uninstall service integration tests

- **Change:** Add or extend tests covering: (1) install with HTTP transport calls
  serviceManager.register and start, (2) install with stdio transport skips service
  registration, (3) install in dev mode skips service registration, (4) uninstall calls
  graceful /shutdown and serviceManager.unregister, (5) uninstall with no service
  installed is idempotent (unregister tolerates "not found"), (6) uninstall with server
  not running skips /shutdown (idempotent). Mock service manager and HTTP calls.
- **Files:** tests/install.test.ts (extend or new), tests/uninstall.test.ts (new)
- **Tier:** standard
- **Done when:** Tests verify service lifecycle during install/uninstall. Existing
  install tests remain unchanged and passing.
- **Blockers:** None.

#### VERIFY: Install/Uninstall Integration
- Run full test suite (npm test)
- Confirm install registers service and server starts
- Confirm uninstall removes service cleanly with no orphans
- Report: tests passing, no regressions

---

### Phase 4: Documentation

#### Task 14: Update README with service model and verbs

- **Change:** Add a "Service Management" section to README.md documenting:
  - The four new verbs: start, stop, restart, status (with usage examples)
  - Automatic service registration during install (per-user, no elevation)
  - Per-OS mechanisms at a glance (schtasks, systemd, launchd)
  - Log file location (~/.apra-fleet/data/fleet.log)
  - Troubleshooting: how to check logs, restart after issues, verify service state
  Update the existing command reference table to include the new verbs. Update the
  install/uninstall sections to mention service registration/removal.
- **Files:** README.md
- **Tier:** cheap
- **Done when:** README documents all service verbs and behavior. ASCII-only.
- **Blockers:** None.

#### Task 15: Update architecture docs with service manager adapter

- **Change:** Add a "Service Manager" section to docs/architecture.md documenting:
  - The adapter pattern: ServiceManager interface + per-OS implementations
  - How install/uninstall interact with the service manager
  - The /shutdown endpoint and why it exists (cross-platform graceful stop)
  - The verb -> adapter -> OS command flow
  - How the singleton lifecycle interacts with service management (startup lock,
    server.json, clean exit preventing auto-restart)
  Update the existing "Singleton lifecycle" paragraph to reference service management.
  Update the ASCII diagram to show the service manager layer.
- **Files:** docs/architecture.md
- **Tier:** cheap
- **Done when:** Architecture docs explain the service manager design. ASCII-only.
- **Blockers:** None.

#### VERIFY: Documentation
- Confirm ASCII-only in all doc files (pre-commit hook)
- Confirm docs accurately reflect the planned implementation
- Report: docs updated, hook passes

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Windows schtasks /end is TerminateProcess (hard kill, not SIGTERM) | High | Never use schtasks /end for graceful stop. Always use HTTP /shutdown endpoint. Force kill via taskkill only as last-resort fallback. |
| loginctl enable-linger may require root on some Linux distros | Medium | Attempt and warn (non-fatal). Server starts on login but may not persist across reboots without an active session on those systems. Document the manual sudo command in README. |
| Non-systemd Linux (Alpine, older distros, containers, WSL1) | Medium | Detect systemd absence at register time. Return clear, actionable error. start/stop/status CLI verbs still work via direct process management and HTTP /shutdown -- only automatic service registration is unavailable. |
| Windows "Log on as a batch job" right restricted (domain-joined) | Medium | Detect schtasks /create failure. Provide actionable error naming the specific right. start/stop/status still work via direct process management. |
| launchctl API differences across macOS versions | Low | Use bootstrap/bootout/kickstart API (available since macOS 10.10 Yosemite, 2014). All currently-supported macOS versions have this API. |
| Binary path changes after update break service unit | Medium | install command re-registers the service unit (updates binary path). update command calls install --force, which also re-registers. Document this interaction. |
| Backward compat: existing install/uninstall behavior changes | Medium | Service registration is purely additive -- all existing install steps unchanged. Service removal is prepended to uninstall. All existing tests must pass. |
| Concurrent start race (two starts at the same time) | Low | Existing claimStartupLock prevents double-start. The binary exits 0 when another instance is running (checkRunningInstance). No change needed. |
| /shutdown endpoint security | Low | Localhost-only binding (127.0.0.1). Same trust boundary as the /mcp endpoint, which has full tool access. No auth token needed (parity with existing MCP surface). |
| Stale server.json after crash or kill -9 | Low | Existing checkRunningInstance validates pid + /health and cleans up stale files. No change needed. |

---

## Notes

- Each task should result in a git commit
- Verify tasks are checkpoints -- stop and report after each one
- Base branch: main
- Implementation branch: feat/mcp-sse-transport (extends PR #273)
- Service name constants:
  - Windows task: "ApraFleet"
  - Linux unit: "apra-fleet.service"
  - macOS label: "com.apra-fleet.server"
- Log file: ~/.apra-fleet/data/fleet.log
- /shutdown endpoint: POST http://127.0.0.1:<port>/shutdown (localhost-only)
- The /shutdown endpoint reuses the existing SIGINT handler chain in index.ts
- ASCII-only in all committed files (pre-commit hook enforced)
