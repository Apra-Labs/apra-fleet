---
name: fleet-supervisor
description: How to start/smoke-test the supervisor process itself, and start, check, and kill fleet-sprints via its HTTP API only (POST /api/sprints on localhost:8787). Never call the fleet-sprint CLI directly. Trigger whenever asked to start/launch/check/stop/kill the supervisor or a sprint.
---

# fleet-supervisor (supervisor API)

Sprints are started, checked, and killed through the supervisor's HTTP API.
Default port: **8787**. Never invoke `apra-fleet workflow fleet-sprint` or
`bin/cli.mjs` directly -- always go through this API.

## Authentication

The supervisor binds loopback-only and guards its whole `/api/` surface (plus
POST to any `/sprints/:id/live/...` sub-route) with a shared bearer service
token. Per design decision DQ-20: the token source is the shared
`~/.apra-fleet/fleet.key` -- the SAME key `src/services/jwt.ts` signs JWTs
with -- when that file exists and holds a well-formed 64-hex-char value;
otherwise the supervisor falls back to `<dataDir>/private/token`, a
plain-text file it mints on first boot and reuses on every restart against
the same `dataDir`. The supervisor never mints `fleet.key` itself (only
`jwt.ts` does); it only ever reads one if already present. Either way the
token is **never printed** to a log, a terminal, or anywhere else -- the
supervisor's startup log names which source it resolved
(`service token source: fleet-key` or `private-token`), never the token
value itself. Read the token directly from whichever file is in play for
each request instead of echoing it.

Every `curl` example below carries it as
`-H "Authorization: Bearer $(cat ~/.apra-fleet/fleet.key 2>/dev/null || cat <dataDir>/private/token)"`
(bash) or
`-H "Authorization: Bearer $(if (Test-Path "$HOME\.apra-fleet\fleet.key") { Get-Content "$HOME\.apra-fleet\fleet.key" } else { Get-Content <dataDir>\private\token })"`
(PowerShell) -- substitute the real `dataDir` path on the target member. The
`fleet.key` read is tried first and silently falls through to
`private/token` when it is absent, matching the supervisor's own resolution
order.

### Opening the dashboard in a browser

A plain visit to `http://localhost:8787/` renders a read-only view with a
sign-in notice and sets no cookie. To sign the browser in, open the page once
with the service token appended as `?token=`. The supervisor checks it, sets
an HttpOnly `se_token` cookie carrying a value DERIVED from the token (never
the token itself), and redirects to the same page with the token removed from
the address bar. A wrong token sets no cookie and answers 401. The cookie then
authorizes the page's own Stop/Restart/launch controls. The raw token is only
ever accepted as an `Authorization: Bearer` header, never as the cookie.

Build and open the link (bash; macOS uses `open`, Linux `xdg-open`):
```bash
open "http://localhost:8787/?token=$(cat ~/.apra-fleet/fleet.key 2>/dev/null || cat <dataDir>/private/token)"
```
PowerShell:
```powershell
Start-Process "http://localhost:8787/?token=$(if (Test-Path "$HOME\.apra-fleet\fleet.key") { Get-Content "$HOME\.apra-fleet\fleet.key" } else { Get-Content <dataDir>\private\token })"
```
The supervisor's startup log line `dashboard sign-in: open
http://localhost:<port>/?token=<contents of <file>>` names the exact port and
token file in use; it never prints the token value.

## 0. Start the supervisor (if not already running)

Check first (bash):
```bash
curl -s -m 5 -H "Authorization: Bearer $(cat ~/.apra-fleet/fleet.key 2>/dev/null || cat <dataDir>/private/token)" http://localhost:8787/api/sprints
```
PowerShell:
```powershell
curl -s -m 5 -H "Authorization: Bearer $(if (Test-Path "$HOME\.apra-fleet\fleet.key") { Get-Content "$HOME\.apra-fleet\fleet.key" } else { Get-Content <dataDir>\private\token })" http://localhost:8787/api/sprints
```
Connection refused/timeout = not running. `{"sprints": [...]}` = already up,
skip this.

Start it detached (it runs indefinitely -- exits only on `POST
/api/shutdown` or SIGINT/SIGTERM, never on its own).

Supported path -- the installed `apra-fleet` binary runs the supervisor in
the foreground on its own embedded runtime, so no separate `node` on PATH is
needed:

```bash
apra-fleet supervisor          # background/detached; Ctrl-C or POST /api/shutdown stops it
```

Everything after `supervisor` is passed to the supervisor verbatim, so the
options below work unchanged (`apra-fleet supervisor --port 9000`,
`apra-fleet supervisor --beads-dir <path>`, and `apra-fleet supervisor
--help` for the supervisor's own usage). This needs `apra-fleet install` to
have installed the workflow assets; if it has not, the command says so and
tells you to run `apra-fleet install`.

Note you usually do NOT need to start it by hand at all: `apra-fleet
install` already registers the `fleet-supervisor` OS service and starts it
(see "Auto-start on login/boot" below).

Fallback, only in a source checkout (needs a `node` on PATH):

```bash
node ~/.apra-fleet/workflows/fleet-sprint/bin/serve.mjs              # macOS / Linux
```

```powershell
node "$HOME\.apra-fleet\workflows\fleet-sprint\bin\serve.mjs"    # Windows PowerShell
```

(From a source checkout of apra-fleet the same file is
`packages/apra-fleet-se/bin/serve.mjs`.)

Start it from INSIDE the target project (any folder under it): the
supervisor resolves the project's `.beads` by walking up from its cwd,
exactly like `bd`. Starting from elsewhere: pass `--beads-dir <project
folder or its .beads>` (a path that does not exist is a startup error). It
logs one `supervisor beads: <dir> | prefix=<p> | remote=<sync.remote>` line
at startup; the same identity is on `GET /api/health` (`beads`) and at the
top of the dashboard, and every sprint it launches is told to verify its
members against it. If NO `.beads` is found (or its probe fails) it still
starts, but logs `[supervisor] WARNING: no beads database found walking up
from <cwd> ... To fix: ...`, reports `beads: null` plus `beadsWarning` on
`/api/health`, and shows an amber `Beads: NOT RESOLVED -- ...` header on the
dashboard. With NO `.beads` found it also has no backlog member, so every
launch answers `503` until you restart it from the right folder or with
`--beads-dir`. With a `.beads` found but a failed probe, launches still
work (without `--expect-beads`); fix the environment and hit
`GET /api/health?refresh=1` to recover without a restart. `--port <n>`
overrides the default (8787). Self-logs to
`<dataDir>/logs/supervisor.log` in addition to stdout.

**Backlog member.** At startup the supervisor ensures its own backlog
member: a local member with no LLM whose work folder is the project folder.
It adopts an LLM-less local member already registered for that folder (name
kept; adds the `backlog` tag and `unreservable` when missing), or registers
`backlog-<camelCaseFolderName>`. It logs `[supervisor] backlog member:
'<name>' (ready)`; `GET /api/health` reports `backlogMember: {status, name,
reason}`. It refuses to start (exit 1) if that name is taken by a member
for another folder. Fleet unreachable at startup is not fatal: status is
`degraded`, launches answer `503`, and a background retry fixes it.

Smoke test (a few seconds after launch -- give it time to bind), bash:
```bash
curl -s -m 5 -H "Authorization: Bearer $(cat ~/.apra-fleet/fleet.key 2>/dev/null || cat <dataDir>/private/token)" http://localhost:8787/api/sprints   # expect {"sprints":[],...}
curl -s -m 5 -H "Authorization: Bearer $(cat ~/.apra-fleet/fleet.key 2>/dev/null || cat <dataDir>/private/token)" http://localhost:8787/api/members   # expect the registered fleet, non-empty
curl -s -m 5 -H "Authorization: Bearer $(cat ~/.apra-fleet/fleet.key 2>/dev/null || cat <dataDir>/private/token)" http://localhost:8787/api/health    # check `beads.dir`/`beads.prefix` is the intended tracker, `backlogMember.status` is "ready"
```
PowerShell:
```powershell
curl -s -m 5 -H "Authorization: Bearer $(if (Test-Path "$HOME\.apra-fleet\fleet.key") { Get-Content "$HOME\.apra-fleet\fleet.key" } else { Get-Content <dataDir>\private\token })" http://localhost:8787/api/sprints
curl -s -m 5 -H "Authorization: Bearer $(if (Test-Path "$HOME\.apra-fleet\fleet.key") { Get-Content "$HOME\.apra-fleet\fleet.key" } else { Get-Content <dataDir>\private\token })" http://localhost:8787/api/members
curl -s -m 5 -H "Authorization: Bearer $(if (Test-Path "$HOME\.apra-fleet\fleet.key") { Get-Content "$HOME\.apra-fleet\fleet.key" } else { Get-Content <dataDir>\private\token })" http://localhost:8787/api/health
```
(Windows PowerShell 5.1: `curl` is an alias of `Invoke-WebRequest`; use
`curl.exe` with the same arguments, or `Invoke-RestMethod <url>`.)
Both must succeed before treating the supervisor as up -- a bound port with
a 500 on `/api/members` still means something is broken. A wrong
`beads.prefix` means it was started from the wrong folder: stop it and
restart with `--beads-dir`. `beads: null` with a `beadsWarning` means no
tracker was resolved at all: the warning text says what to do.

## Stop the supervisor

Two paths: **graceful** (preferred -- lets in-flight requests finish and every
seam tear down cleanly) and **hard-stop** (only when the API itself is
unresponsive, e.g. a hung event loop). Resolve commands per the target
member's own OS (`agent.os`) -- do not assume the orchestrator's shell; some
members run PowerShell, not POSIX.

### Graceful (preferred)

Bash:
```bash
curl -s -X POST -H "Authorization: Bearer $(cat ~/.apra-fleet/fleet.key 2>/dev/null || cat <dataDir>/private/token)" http://localhost:8787/api/shutdown
```
PowerShell:
```powershell
curl -s -X POST -H "Authorization: Bearer $(if (Test-Path "$HOME\.apra-fleet\fleet.key") { Get-Content "$HOME\.apra-fleet\fleet.key" } else { Get-Content <dataDir>\private\token })" http://localhost:8787/api/shutdown
```
Returns `{"status":"shutting-down"}` immediately; the process then finishes
tearing down every seam (ledger, watchdog, dashboard, etc) and exits on its
own a moment later. Confirm it is actually gone, bash:
```bash
curl -s -m 5 -H "Authorization: Bearer $(cat ~/.apra-fleet/fleet.key 2>/dev/null || cat <dataDir>/private/token)" http://localhost:8787/api/sprints   # expect connection refused
```
PowerShell:
```powershell
curl -s -m 5 -H "Authorization: Bearer $(if (Test-Path "$HOME\.apra-fleet\fleet.key") { Get-Content "$HOME\.apra-fleet\fleet.key" } else { Get-Content <dataDir>\private\token })" http://localhost:8787/api/sprints
```
If that still connects after a few seconds, fall through to hard-stop below.

### Find the supervisor's PID/port (when the API is unresponsive)

`GET /api/health` normally reports the running `pid` directly, bash:
```bash
curl -s -m 5 -H "Authorization: Bearer $(cat ~/.apra-fleet/fleet.key 2>/dev/null || cat <dataDir>/private/token)" http://localhost:8787/api/health
```
PowerShell:
```powershell
curl -s -m 5 -H "Authorization: Bearer $(if (Test-Path "$HOME\.apra-fleet\fleet.key") { Get-Content "$HOME\.apra-fleet\fleet.key" } else { Get-Content <dataDir>\private\token })" http://localhost:8787/api/health
```
but if the API itself is unresponsive that call will hang or refuse -- fall
back to an OS-level lookup by port (default **8787**) or process name
(`serve.mjs`):

**macOS / Linux:**
```bash
lsof -i :8787                 # shows the PID (COMMAND, PID columns) bound to the port
lsof -ti:8787                 # PID only, convenient for command substitution
# or, by process name if the port lookup finds nothing (already unbound but
# the process is still alive/hung):
pgrep -f 'bin/serve.mjs'
```

**Windows (PowerShell):**
```powershell
Get-NetTCPConnection -LocalPort 8787 | Select-Object OwningProcess
Get-Process -Id <pid>          # confirm it is the supervisor before killing it
# or, by process name:
Get-Process | Where-Object { $_.Path -like '*serve.mjs*' -or $_.CommandLine -like '*serve.mjs*' }
```

**Windows (cmd.exe, if PowerShell is unavailable):**
```cmd
netstat -ano | findstr :8787
tasklist /FI "PID eq <pid>"
```

### Hard-stop (PID-based kill)

Only once you have confirmed the PID above is actually the supervisor
process. Try a graceful signal first, then force:

**macOS / Linux:**
```bash
kill <pid>                    # SIGTERM -- gives it a chance to exit cleanly
sleep 2
kill -0 <pid> 2>/dev/null && kill -9 <pid>   # still alive? force it
```

**Windows (PowerShell):**
```powershell
Stop-Process -Id <pid>              # graceful-ish first attempt
Stop-Process -Id <pid> -Force       # still running? force-kill
```

**Windows (cmd.exe):**
```cmd
taskkill /PID <pid>
taskkill /PID <pid> /F
```

After either path, verify the port is free before restarting -- bash:
`curl -s -m 5 -H "Authorization: Bearer $(cat ~/.apra-fleet/fleet.key 2>/dev/null || cat <dataDir>/private/token)" http://localhost:8787/api/sprints`
(PowerShell: `curl -s -m 5 -H "Authorization: Bearer $(if (Test-Path "$HOME\.apra-fleet\fleet.key") { Get-Content "$HOME\.apra-fleet\fleet.key" } else { Get-Content <dataDir>\private\token })" http://localhost:8787/api/sprints`)
must refuse the connection (macOS/Linux), or the port-lookup command above
must return nothing (Windows).

## Restart the supervisor

A discrete stop-then-start procedure -- use this instead of assuming a bare
restart command exists:

1. **Stop** it: graceful shutdown above; if that does not actually stop it
   (still answering after a few seconds), fall back to the hard-stop path
   above.
2. **Confirm it is down**: bash
   `curl -s -m 5 -H "Authorization: Bearer $(cat ~/.apra-fleet/fleet.key 2>/dev/null || cat <dataDir>/private/token)" http://localhost:8787/api/sprints`
   (PowerShell: `curl -s -m 5 -H "Authorization: Bearer $(if (Test-Path "$HOME\.apra-fleet\fleet.key") { Get-Content "$HOME\.apra-fleet\fleet.key" } else { Get-Content <dataDir>\private\token })" http://localhost:8787/api/sprints`)
   must refuse the connection (or the per-OS port lookup above returns
   nothing).
3. **Start** it again: see section 0 ("Start the supervisor") above, then
   run its smoke test (`GET /api/sprints`, `GET /api/members`) to confirm the
   new process is actually serving before treating the restart as done.

**Upgrading apra-fleet.** A running supervisor keeps the code it started
with. Before upgrading, let running sprints finish (or stop them) and stop
the supervisor; start it again afterwards. A
supervisor started under 0.4.3 does not send the install's access secret, so
a 0.4.4 fleet server refuses its requests with HTTP 401. If a sprint was
still running during the upgrade, the first launch may 409 on its stale
member reservations -- see "Common launch-time crashes" below.

## Auto-start on login/boot

Rather than starting the supervisor by hand each session, it can be
registered with the OS to start automatically on login/boot. Resolve commands per the target member's own OS (`agent.os`) --
do not assume the orchestrator's shell; some members run PowerShell, not
POSIX. A service manager does not start in your project folder, so every
hand-registered example passes `--beads-dir`. Substitute the real paths: the user's home
(`/Users/<user>`, `/home/<user>` or `C:\Users\<user>`) and the target
project folder (`/path/to/project` or `C:\path\to\project`). After registering (any OS),
run the same-process smoke test from section 0 above (`GET /api/sprints`,
`GET /api/members`) against the newly auto-started instance to confirm it is
actually serving, not just that the OS accepted the registration.

### Supported path: `apra-fleet install` does this for you

`apra-fleet install` registers the `fleet-supervisor` OS service itself and
starts it, on Linux (a `systemd --user` unit), macOS (a launchd
LaunchAgent) and Windows (a Scheduled Task). The registered service runs the
installed binary's own subcommand -- `<install dir>/bin/apra-fleet
supervisor` -- so no separate `node` on PATH is involved on any platform.

Nothing else is needed for auto-start. To manage it:

```bash
apra-fleet status      # reports "Service (fleet supervisor):" installed/running
apra-fleet uninstall   # removes the fleet-supervisor service registration
```

If `apra-fleet install` cannot register the service it FAILS with a non-zero
exit and names the reason -- it never reports a successful install with the
supervisor silently unregistered. The one exception is `apra-fleet install
--workflows none`, which does not install the supervisor at all and says so.

### Fallback: hand-rolled service recipes for a SOURCE CHECKOUT

Everything below is the fallback for running the supervisor out of a source
checkout with your own `node`, when you are NOT using an installed
`apra-fleet` binary. Prefer `apra-fleet install` above wherever it applies.

WARNING: these recipes deliberately reuse the same task name and launchd
label that `apra-fleet install` registers (`ApraFleetSupervisor`,
`com.apra-fleet.supervisor`), so do not combine them with an
install-registered supervisor on one machine -- register one or the other,
not both, or they will collide and fight over the port.

Resolve commands per the target member's own OS (`agent.os`) -- do not
assume the orchestrator's shell; some members run PowerShell, not POSIX.
Every example below assumes the repo root is `/path/to/apra-fleet` (POSIX)
or `C:\path\to\apra-fleet` (Windows) -- substitute the real path on the
target member. After registering (any OS), run the same-process smoke test
from section 0 above (`GET /api/sprints`, `GET /api/members`) against the
newly auto-started instance to confirm it is actually serving, not just that
the OS accepted the registration.

#### Windows (source checkout)

**Option A -- Task Scheduler, "At log on" trigger** (simplest; runs in the
user's own session):

Register:
```cmd
schtasks /Create /TN "ApraFleetSupervisor" /TR "node C:\Users\<user>\.apra-fleet\workflows\fleet-sprint\bin\serve.mjs --beads-dir C:\path\to\project" /SC ONLOGON /RL LIMITED
```
De-register:
```cmd
schtasks /Delete /TN "ApraFleetSupervisor" /F
```
Confirm it registered:
```cmd
schtasks /Query /TN "ApraFleetSupervisor"
```

**Option B -- a Windows service via NSSM** (runs even with nobody logged
in; requires NSSM installed and on PATH):

Register:
```cmd
nssm install ApraFleetSupervisor node "C:\Users\<user>\.apra-fleet\workflows\fleet-sprint\bin\serve.mjs" --beads-dir "C:\path\to\project"
nssm set ApraFleetSupervisor AppDirectory "C:\path\to\project"
nssm start ApraFleetSupervisor
```
De-register:
```cmd
nssm stop ApraFleetSupervisor
nssm remove ApraFleetSupervisor confirm
```

#### macOS (launchd user LaunchAgent, source checkout)

Create `~/Library/LaunchAgents/com.apra-fleet.supervisor.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.apra-fleet.supervisor</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/<user>/.apra-fleet/workflows/fleet-sprint/bin/serve.mjs</string>
    <string>--beads-dir</string>
    <string>/path/to/project</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>/tmp/apra-fleet-supervisor.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/apra-fleet-supervisor.log</string>
</dict>
</plist>
```
`RunAtLoad` starts it at login; `KeepAlive` is deliberately `false` -- the
supervisor already runs indefinitely on its own (see section 0), so it does
not need launchd to respawn it on exit (an explicit `POST /api/shutdown`
should stay stopped, not bounce back up). launchd runs with a minimal PATH
(`/usr/bin:/bin:/usr/sbin:/sbin`), so a bare `node` command will not resolve
if node is installed via Homebrew or a version manager. Use the real path to
`node` on your system (`which node`) if it differs from `/usr/local/bin/node`.

Register (load) and start now:
```bash
launchctl load ~/Library/LaunchAgents/com.apra-fleet.supervisor.plist
launchctl start com.apra-fleet.supervisor
```
De-register (stop and unload, so it no longer starts at login):
```bash
launchctl stop com.apra-fleet.supervisor
launchctl unload ~/Library/LaunchAgents/com.apra-fleet.supervisor.plist
```

#### Linux (systemd --user unit, source checkout)

Create `~/.config/systemd/user/apra-fleet-supervisor.service`:
```ini
[Unit]
Description=Apra Fleet supervisor

[Service]
ExecStart=/usr/bin/node /home/<user>/.apra-fleet/workflows/fleet-sprint/bin/serve.mjs --beads-dir /path/to/project
Restart=no
WorkingDirectory=/path/to/project

[Install]
WantedBy=default.target
```
`Restart=no` matches the launchd `KeepAlive=false` choice above: the
supervisor is already self-persistent (section 0), and an explicit `POST
/api/shutdown` should stay stopped rather than being auto-respawned by the
unit. Use the real path to `node` on the target member (`which node`) if it
differs from `/usr/bin/node`.

Register and start:
```bash
systemctl --user daemon-reload
systemctl --user enable apra-fleet-supervisor.service
systemctl --user start apra-fleet-supervisor.service
```
De-register (stop and disable, so it no longer starts at login/boot):
```bash
systemctl --user stop apra-fleet-supervisor.service
systemctl --user disable apra-fleet-supervisor.service
```
A user unit only starts at login unless lingering is enabled for boot-time
start with no login (`loginctl enable-linger <username>`).

## 1. Before you launch a sprint

1. If you just created/edited beads locally, push them first:
   `bd dolt commit` then `bd dolt push`. Members pull their own copy; a
   sprint launched before the push works from stale scope.
2. Check no conflicting sprint is already running: `GET /api/sprints`.
3. Multi-member sprints align their members to the sprint base
   automatically at launch (WIP preserved in a named stash, one `[Align]`
   line per member) -- do not align members by hand. The launch refuses only
   for an unreachable member, differing origin URLs, a base missing on
   origin, a fetch auth failure or a diverged sprint branch, naming the
   member, cause and fix. Don't guess a member list -- ask, or default to
   one.

## 2. Start a sprint

Bash:
```bash
curl -s -X POST http://localhost:8787/api/sprints \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat ~/.apra-fleet/fleet.key 2>/dev/null || cat <dataDir>/private/token)" \
  -d '{
    "issue": "<id[,id2,...]>",
    "branch": "<new-or-existing-branch>",
    "base": "<base-branch>",
    "members": ["<member-name>"],
    "goal": "P1/P2"
  }'
```
PowerShell:
```powershell
curl -s -X POST http://localhost:8787/api/sprints `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer $(if (Test-Path "$HOME\.apra-fleet\fleet.key") { Get-Content "$HOME\.apra-fleet\fleet.key" } else { Get-Content <dataDir>\private\token })" `
  -d '{
    "issue": "<id[,id2,...]>",
    "branch": "<new-or-existing-branch>",
    "base": "<base-branch>",
    "members": ["<member-name>"],
    "goal": "P1/P2"
  }'
```

Field names, exactly as the API expects them:

| Field | Required | Notes |
|---|---|---|
| `issue` | yes | comma-separated bead root IDs (parent/epic OR a standalone leaf bead). Alias: `target_issue`. |
| `branch` | yes | created from `base` if it doesn't exist yet. Must differ from `base` (an equal pair is a 400; case and `origin/`/`refs/heads/` prefixes are ignored). |
| `base` | yes | alias: `base_branch`. This is what the sprint branches FROM -- pass the branch you actually want, not always `main`. |
| `members` | yes | array of registered member names. One member = safest default. |
| `goal` | no | `P1`, `P1/P2` (default), or `P1/P2/P3`. |
| `maxCycles` | no | default 5. |
| `allowMissingMembers` | no | bool. |
| `requirementsFile` | no | path on the supervisor's machine; a relative path resolves against the supervisor's project folder. Not found = a run-log warning only, so prefer an absolute path. |
| `roleMap` | no | `{"doer":["m1","m2"], "reviewer":["m3"]}`. Leave out `backlog`: the supervisor injects its own backlog member; naming any other member there is a 400. `orchestrator` is the deprecated alias of `backlog` (removed in v0.5). |
| `budget` | no | USD cap. |
| `phases` | no | `{"regression": "skip"}` skips the regression pass (`"run"` is the default). Any other key or value is a 400. |
| `max_extensions` | no | non-negative integer, default 1; `0` disables. How many times a CI failure or an in-goal Final Review finding may send the sprint back into the cycle loop after Finalization. Anything else is a 400. Alias: `maxExtensions`. |
| `overrideRelaunchGate` | no | bool. See below. |
| `sync` | no | bool. Passes `--sync` so members in separate checkouts pass the topology check. |

Response has `sprintId`, `pid`, `port` (its own dashboard), `logPath`, and
`warnings` (e.g. the deprecation notice when `roleMap.orchestrator` was
used). A `503` means nothing was launched: the backlog member is not ready,
the fleet member list could not be read, the fleet server was stopped by its
user (`apra-fleet stop`), or the beads could not be verified fresh -- the
`error` says which.
**A 201 response does NOT mean the sprint is alive** -- it can crash in the
first few seconds (bad topology, bad member, etc). Always verify (step 3)
a few seconds after launch.

## 3. Check status

All live sprints, bash:
```bash
curl -s -H "Authorization: Bearer $(cat ~/.apra-fleet/fleet.key 2>/dev/null || cat <dataDir>/private/token)" http://localhost:8787/api/sprints
```
PowerShell:
```powershell
curl -s -H "Authorization: Bearer $(if (Test-Path "$HOME\.apra-fleet\fleet.key") { Get-Content "$HOME\.apra-fleet\fleet.key" } else { Get-Content <dataDir>\private\token })" http://localhost:8787/api/sprints
```
Empty `sprints: []` after a launch = it already died. Check its `logPath`.

One sprint (live state, or its terminal record if it finished/crashed), bash:
```bash
curl -s -H "Authorization: Bearer $(cat ~/.apra-fleet/fleet.key 2>/dev/null || cat <dataDir>/private/token)" http://localhost:8787/api/sprints/<sprintId>
```
PowerShell:
```powershell
curl -s -H "Authorization: Bearer $(if (Test-Path "$HOME\.apra-fleet\fleet.key") { Get-Content "$HOME\.apra-fleet\fleet.key" } else { Get-Content <dataDir>\private\token })" http://localhost:8787/api/sprints/<sprintId>
```

Sprint-scoped dashboard (per-role activity, bead DAG, cost, PR link):
`http://localhost:<port>` (the `port` from the launch response).

## 4. Kill a sprint

Bash:
```bash
curl -s -X POST -H "Authorization: Bearer $(cat ~/.apra-fleet/fleet.key 2>/dev/null || cat <dataDir>/private/token)" http://localhost:8787/api/sprints/<sprintId>/stop
```
PowerShell:
```powershell
curl -s -X POST -H "Authorization: Bearer $(if (Test-Path "$HOME\.apra-fleet\fleet.key") { Get-Content "$HOME\.apra-fleet\fleet.key" } else { Get-Content <dataDir>\private\token })" http://localhost:8787/api/sprints/<sprintId>/stop
```

## Relaunch gate

If a prior run of the SAME issue root ended in a deterministic, unaddressed
failure (crash, sync conflict, etc), a relaunch is refused with a 409. Once
you understand and have actually fixed the cause, retry with
`"overrideRelaunchGate": true` in the body. This is not a silent bypass --
only use it once you know why the prior run died.

## Common launch-time crashes

- **Topology refusal**: members are aligned automatically (section 1), so
  this names what could not be reconciled -- an unreachable member,
  differing origin URLs, a base missing on origin, a fetch auth failure or
  a diverged sprint branch. Fix what it names and relaunch; do not align
  members by hand.
- **Beads identity** (`BeadsIdentityError`, before any dispatch): `bd`
  missing on a member, a member resolving to a different beads project, or
  a failed automatic beads set-up on a beads-reading member. The message
  names the member and the fix.
- **Unregistered member**: `GET /api/members` to see valid names.
- **Stale LLM auth**: dispatch fails with `empty_response`. Re-run
  `provision_llm_auth` for that member.
- **Stale member reservation** (`409 member overlap rejects launch: sprint
  '<id or branch>' already claims [...]` while `GET /api/sprints` shows no
  such sprint): a sprint died uncleanly (crash, or an upgrade with
  `--ignore-running-sprints`) and left its members reserved on the fleet
  server. Clear each listed member with the fleet MCP tool
  `member_reservation {member_name: "<member>", action: "force_release"}`
  (no supervisor HTTP route does this), then relaunch.

## Member layout: isolate deploy/test roles from dev roles

For projects where the deployed software runs and is verified LOCALLY on the
member, give `deployer`, `integ-test-runner`, and `regression-test-runner` a
dedicated member with its own independent git clone (not a worktree),
separate from `planner`/`plan-reviewer`/`doer`/`reviewer`, via `roleMap`:
`{"deployer": ["<deploy-member>"], "integ-test-runner": ["<deploy-member>"],
"regression-test-runner": ["<deploy-member>"], "doer": ["<dev-member>"], ...}`.
Dev roles can all safely share one generic member.
