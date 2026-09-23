---
name: fleet-supervisor
description: How to start/smoke-test the supervisor process itself, and start, check, and kill fleet-sprints via its HTTP API only (POST /api/sprints on localhost:8787). Never call the fleet-sprint CLI directly. Trigger whenever asked to start/launch/check/stop/kill the supervisor or a sprint.
---

# fleet-supervisor (supervisor API)

Sprints are started, checked, and killed through the supervisor's HTTP API.
Default port: **8787**. Never invoke `apra-fleet workflow fleet-sprint` or
`bin/cli.mjs` directly -- always go through this API.

## 0. Start the supervisor (if not already running)

Check first: `curl -s -m 5 http://localhost:8787/api/sprints`. Connection
refused/timeout = not running. `{"sprints": [...]}` = already up, skip this.

Start it detached (it runs indefinitely -- exits only on `POST
/api/shutdown` or SIGINT/SIGTERM, never on its own):

```bash
node packages/apra-fleet-se/bin/serve.mjs   # background/detached, from repo root
```

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
`/api/health`, shows an amber `Beads: NOT RESOLVED -- ...` header on the
dashboard, and launches sprints WITHOUT `--expect-beads` (they then verify
members against the orchestrator member's own beads). Treat that as
"restart from the right folder / with `--beads-dir`", or fix the
environment and hit `GET /api/health?refresh=1` to recover without a
restart. `--port <n>` overrides the default (8787). Self-logs to
`<dataDir>/logs/supervisor.log` in addition to stdout.

Smoke test (a few seconds after launch -- give it time to bind):
```bash
curl -s -m 5 http://localhost:8787/api/sprints   # expect {"sprints":[],...}
curl -s -m 5 http://localhost:8787/api/members   # expect the registered fleet, non-empty
curl -s -m 5 http://localhost:8787/api/health    # check `beads.dir`/`beads.prefix` is the intended tracker
```
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

```bash
curl -s -X POST http://localhost:8787/api/shutdown
```
Returns `{"status":"shutting-down"}` immediately; the process then finishes
tearing down every seam (ledger, watchdog, dashboard, etc) and exits on its
own a moment later. Confirm it is actually gone:
```bash
curl -s -m 5 http://localhost:8787/api/sprints   # expect connection refused
```
If that still connects after a few seconds, fall through to hard-stop below.

### Find the supervisor's PID/port (when the API is unresponsive)

`GET /api/health` normally reports the running `pid` directly (`curl -s -m 5
http://localhost:8787/api/health`), but if the API itself is unresponsive
that call will hang or refuse -- fall back to an OS-level lookup by port
(default **8787**) or process name (`serve.mjs`):

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

After either path, verify the port is free before restarting:
`curl -s -m 5 http://localhost:8787/api/sprints` must refuse the connection
(macOS/Linux), or the port-lookup command above must return nothing
(Windows).

## Restart the supervisor

A discrete stop-then-start procedure -- use this instead of assuming a bare
restart command exists:

1. **Stop** it: graceful shutdown above; if that does not actually stop it
   (still answering after a few seconds), fall back to the hard-stop path
   above.
2. **Confirm it is down**: `curl -s -m 5 http://localhost:8787/api/sprints`
   must refuse the connection (or the per-OS port lookup above returns
   nothing).
3. **Start** it again: see section 0 ("Start the supervisor") above, then
   run its smoke test (`GET /api/sprints`, `GET /api/members`) to confirm the
   new process is actually serving before treating the restart as done.

## Auto-start on login/boot

Instead of a human running `node bin/serve.mjs` by hand each session, the
supervisor can be registered with the OS to start automatically on
login/boot. Resolve commands per the target member's own OS (`agent.os`) --
do not assume the orchestrator's shell; some members run PowerShell, not
POSIX. Every example below assumes the repo root is
`/path/to/apra-fleet` (POSIX) or `C:\path\to\apra-fleet` (Windows) --
substitute the real path on the target member. After registering (any OS),
run the same-process smoke test from section 0 above (`GET /api/sprints`,
`GET /api/members`) against the newly auto-started instance to confirm it is
actually serving, not just that the OS accepted the registration.

### Windows

**Option A -- Task Scheduler, "At log on" trigger** (simplest; runs in the
user's own session):

Register:
```cmd
schtasks /Create /TN "ApraFleetSupervisor" /TR "node C:\path\to\apra-fleet\packages\apra-fleet-se\bin\serve.mjs" /SC ONLOGON /RL LIMITED
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
nssm install ApraFleetSupervisor node "C:\path\to\apra-fleet\packages\apra-fleet-se\bin\serve.mjs"
nssm set ApraFleetSupervisor AppDirectory "C:\path\to\apra-fleet"
nssm start ApraFleetSupervisor
```
De-register:
```cmd
nssm stop ApraFleetSupervisor
nssm remove ApraFleetSupervisor confirm
```

### macOS (launchd user LaunchAgent)

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
    <string>/path/to/apra-fleet/packages/apra-fleet-se/bin/serve.mjs</string>
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

### Linux (systemd --user unit)

Create `~/.config/systemd/user/apra-fleet-supervisor.service`:
```ini
[Unit]
Description=Apra Fleet supervisor

[Service]
ExecStart=/usr/bin/node /path/to/apra-fleet/packages/apra-fleet-se/bin/serve.mjs
Restart=no
WorkingDirectory=/path/to/apra-fleet

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
3. Multi-member sprints need all members on the SAME git HEAD, or the
   launch crashes immediately with a topology error. If unsure, use ONE
   member. Don't guess a member list -- ask, or default to one.

### Prepare each remote member

Before dispatching any role to a member, run these four steps against it, in
order. Each step follows the same command shape and safety rules the engine's
own member-prep primitives use, so preparing a member by hand behaves
identically to however the engine performs the same step.

WINDOWS COMMAND CONVENTION -- read once, applies to every PowerShell command
below: a Windows member with no POSIX-compatible shell available takes a
command as `powershell -EncodedCommand <base64>`, never a raw script string.
Build `<base64>` by wrapping the script as
`$ErrorActionPreference = 'Stop'; try { <script>; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 0 } catch { Write-Error $_; exit 1 }`
and base64-encoding that wrapped string as UTF-16LE. This is a MIRROR of the
engine's own convention, never shell-level variable expansion left for an
unknown member shell to interpret: every `$variable` below is PowerShell's
own pipeline/local variable, evaluated by the `powershell.exe` the wrapper
explicitly execs, not an orchestrator-side value.

1. **Provision/verify auth (LLM and VCS).** Call the fleet `provision_llm_auth`
   and `provision_vcs_auth` tools for the member. Both are idempotent -- a
   call when auth is already valid is a safe no-op -- so re-running them is
   also how you verify auth without a separate check. This step has no
   separate POSIX/Windows form: it is a fleet tool call, and the tool itself
   does whatever the member's OS needs internally.
2. **Sweep stray fleet processes.** List processes and listening TCP sockets,
   decide, then kill only what survives every safety predicate below.
   - POSIX: list processes with `ps -eo pid=,ppid=,etime=,args=`; list
     listening sockets with `lsof -nP -iTCP -sTCP:LISTEN -Fpn` (fall back to
     `ss -H -l -t -n -p` if `lsof` is absent or prints nothing for an
     unprivileged user -- run both and union the results rather than
     picking one). Kill a selected pid with `kill -9 <pid>`.
   - Windows PowerShell (wrapped per the convention above): list processes
     with `Get-CimInstance Win32_Process`; list listening sockets with
     `Get-NetTCPConnection -State Listen`. Kill a selected pid with
     `Stop-Process -Id <pid> -Force -ErrorAction SilentlyContinue`.
3. **G-pull (git).** `git fetch <remote> <branch>`, then -- only if the fetch
   succeeds -- `git merge --ff-only <remote>/<branch>`. A non-fast-forward
   merge means the member has DIVERGED from the shared branch; stop and
   reconcile it rather than force-merging. Identical command text on POSIX
   and (wrapped) Windows PowerShell -- plain git, no OS-specific form needed.
4. **D-pull (beads).** `bd dolt pull`. Identical command text on POSIX and
   (wrapped) Windows PowerShell.

LOCAL-MEMBER RULE (step 2 only, explicit): the stray-process sweep NEVER
kills on a local member. A local member is the same machine as the
orchestrator -- it hosts the production fleet MCP server, the supervisor,
and possibly the operator's own session and checkout. On a local member (or
any member whose locality cannot be verified as remote), at most REPORT
candidates found by the sweep; never kill.

KILL RULES the operator must follow by hand (step 2, on a verified remote
member only): kill only a process fleet itself started -- evidenced by a
fleet-chosen path or flag on its command line, never by process name alone;
only when its parent process is gone; and never a process listening on the
member's production fleet or supervisor port. Log every kill: pid, full
command line, start time, and the reason it was selected.

SWEEP-FAILURE POLICY (step 2 only, explicit -- this is the DECIDED
behaviour, not a choice left to the operator): **a sweep failure does not
abort the sprint.** If the sweep cannot run on a member -- the probe command
will not execute, the member has none of the supported process-enumeration
or listening-socket tools, or a selected pid's kill is genuinely refused
(permission denied) -- the engine records a loud per-member
`sweep -- FAILURE` line naming that member and the specific cause, and then
CONTINUES: to that member's remaining prep steps, to every other member, and
on to the sprint's first dispatch. Doing the same by hand means the same
thing: note the failure against that member and carry on.

Read a FAILURE line as **"this member was not swept"**, never as "this
member is clean" and never as "the sweep was skipped here" -- those are
three distinct outcomes and the engine reports them as three distinct
statuses. The only consequence of a FAILURE is that a leftover process from
an earlier run may still be running on that member; fix it by installing a
supported enumeration tool on the member, or by clearing the leftovers
there by hand.

Contrast with step 1: an unprovisionable LLM credential DOES abort the
sprint before the first dispatch. The two differ because auth is a
precondition for dispatching to a member at all, whereas the sweep is
hygiene -- an unswept member still builds, tests and commits normally, so
ending an otherwise healthy multi-member sprint over one member's missing
tool would cost more than it protects. Nothing in this sweep policy changes
the auth policy.

## 2. Start a sprint

```bash
curl -s -X POST http://localhost:8787/api/sprints \
  -H "Content-Type: application/json" \
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
| `branch` | yes | created from `base` if it doesn't exist yet. |
| `base` | yes | alias: `base_branch`. This is what the sprint branches FROM -- pass the branch you actually want, not always `main`. |
| `members` | yes | array of registered member names. One member = safest default. |
| `goal` | no | `P1`, `P1/P2` (default), or `P1/P2/P3`. |
| `maxCycles` | no | default 5. |
| `allowMissingMembers` | no | bool. |
| `requirementsFile` | no | path. |
| `roleMap` | no | `{"doer":["m1","m2"], "reviewer":["m3"]}`. |
| `budget` | no | USD cap. |
| `overrideRelaunchGate` | no | bool. See below. |

Response has `sprintId`, `pid`, `port` (its own dashboard), `logPath`.
**A 201 response does NOT mean the sprint is alive** -- it can crash in the
first few seconds (bad topology, bad member, etc). Always verify (step 3)
a few seconds after launch.

## 3. Check status

All live sprints:
```bash
curl -s http://localhost:8787/api/sprints
```
Empty `sprints: []` after a launch = it already died. Check its `logPath`.

One sprint (live state, or its terminal record if it finished/crashed):
```bash
curl -s http://localhost:8787/api/sprints/<sprintId>
```

Sprint-scoped dashboard (per-role activity, bead DAG, cost, PR link):
`http://localhost:<port>` (the `port` from the launch response).

## 4. Kill a sprint

```bash
curl -s -X POST http://localhost:8787/api/sprints/<sprintId>/stop
```

## Relaunch gate

If a prior run of the SAME issue root ended in a deterministic, unaddressed
failure (crash, sync conflict, etc), a relaunch is refused with a 409. Once
you understand and have actually fixed the cause, retry with
`"overrideRelaunchGate": true` in the body. This is not a silent bypass --
only use it once you know why the prior run died.

## Common launch-time crashes

- **Topology mismatch**: members are on different git commits. Fix: use one
  member, or align them first (`git fetch && git checkout <branch>` on
  each), or pass whatever sync option the engine currently exposes -- check
  `docs/architecture.md` "Multi-member topology" section, don't guess.
- **Unregistered member**: `GET /api/members` to see valid names.
- **Stale LLM auth**: dispatch fails with `empty_response`. Re-run
  `provision_llm_auth` for that member.

## Member layout: isolate deploy/test roles from dev roles

For projects where the deployed software runs and is verified LOCALLY on the
member, give `deployer`, `integ-test-runner`, and `regression-test-runner` a
dedicated member with its own independent git clone (not a worktree),
separate from `planner`/`plan-reviewer`/`doer`/`reviewer`, via `roleMap`:
`{"deployer": ["<deploy-member>"], "integ-test-runner": ["<deploy-member>"],
"regression-test-runner": ["<deploy-member>"], "doer": ["<dev-member>"], ...}`.
Dev roles can all safely share one generic member.
