# Fleet Deploy Runbook

## Permissions

Commands below require these prefixes covered by SOME entry in `permissions.allow` of
EITHER `.claude/settings.json` OR `.claude/settings.local.json` (where the fleet's
compose_permissions tool delivers); a broader prefix entry counts as coverage:
- `Bash(*apra-fleet-installer-* install *)`
- `Bash(*apra-fleet* --version)`
- `Bash(*apra-fleet* run *)`
- `Bash(*apra-fleet* start)` -- `run` is what the Deploy step launches with
  (see its Windows scheduled-task caveat), but `start` is still a real command
  (OS auto-start registration, manual fallback); a member missing it fails
  Step 0a as soon as anything invokes it.
- `Bash(node scripts/preflight-clear-build-locks.mjs*)` -- pre-`npm ci` stale
  build-lock cleanup, see Deploy. Trailing `*` also covers `--dry-run`.
- `Bash(npm ci)`
- `Bash(npm run build)`
- `Bash(npm run build:binary)`
- `Bash(dist/apra-fleet-installer-* install *)`
- `Bash(curl * localhost:8787/api/sprints*)` -- the active-sprints gate. 8787 is
  the supervisor's API; the singleton MCP server that `install --force`
  restarts is a separate process on 7523.
- `Bash(node scripts/check-foreign-sprints.mjs*)` -- the gate's self-vs-foreign
  classifier.
- `Bash(curl * localhost:8787/api/reservations/*)` -- only for the documented
  force-release of a stale reservation.

`## Sandbox Deploy` never runs the installer; it shares the build prefixes
above and additionally needs:
- `Bash(node dist/index.js *)` -- sandbox fleet server `start` and its
  `--version` smoke test. A broader `Bash(node:*)` counts.
- `Bash(node *packages/apra-fleet-se/bin/serve.mjs *)` -- sandbox supervisor.
  Invoked with an ABSOLUTE `<repo-root>/...` path, so a relative-prefix entry
  does not cover it; `Bash(node:*)` does.
- `Bash(curl * localhost:18787/*)` -- sandbox supervisor health, members,
  shutdown. Substitute your actual sandbox port.
- `Bash(mkdir *)` and `Bash(rm -rf *fleet-sandbox-*)` -- sandbox root lifecycle.
- `Bash(kill:*)` -- teardown's pid-scoped kill of the sandbox fleet server.
- `Bash(lsof:*)` / `Bash(launchctl list*)` -- Step 0's port and auto-start
  survey (POSIX). Windows equivalents: `Get-NetTCPConnection`, `schtasks /query`.

## Deploy

> **Deploying for integration or regression testing? Stop -- use
> `## Sandbox Deploy (for integration/regression testing)` below.** This
> section replaces the machine's shared production singleton and is only for
> a real production rollout. A test deploy must not restart production
> infrastructure; the sandbox runs alongside it.

Builds from source, then installs with the `./dist` installer binary and
`install --force`.

**Caution: `install --force` stops the running fleet server first.** That is
the shared singleton MCP server (`localhost:7523`) every live supervisor
sprint's dispatches depend on, not just your own MCP connection; restarting
it can collaterally kill their child processes. Run the active-sprints gate
below first and stop only for a FOREIGN sprint.

### Active-sprints gate: your own reservation vs. a foreign one

`GET /api/sprints` lists the supervisor's reservation ledger; each entry has a
`sprintId` (incarnation-unique) and a `childPid`. A deploy dispatched BY a
sprint always finds that sprint's OWN reservation there, so "the list is
non-empty" is NOT by itself a reason to stop -- otherwise no sprint could ever
deploy its own work.

**Your own sprint identity** is stated in your dispatch prompt as `Your
dispatching sprint's own supervisor reservation id (sprintId): <id>`. If the
prompt does NOT state one (manual/human-triggered deploy), you have no self
identity: treat EVERY live reservation as foreign and stop on any of them.

**Classify, then decide** (EXACT-match on `sprintId`, never substring/prefix
match against issue-root text -- unrelated sprints can share an issue root):

- Only your own reservation(s), or none -> PROCEED.
- Any reservation with a different `sprintId` -> STOP. Do not run
  `install --force`. Return `deployed: false` naming the foreign sprintId(s);
  wait for them to finish, or ask the operator to force-release genuinely
  stale ones and relaunch afterward.

**Stale SELF-reservation.** If your only matching reservation's child is gone
(the sprint died and left the entry behind), it is stale. It does not block
your deploy; do not clear it yourself -- report it in `notes` so the
orchestrator/operator can release it against the supervisor:

```bash
curl -s -X POST http://localhost:8787/api/reservations/<sprintId>/force-release
```

Same route the dashboard's Stop/Restart controls use. Force-release does not
restart anything; the sprint must be relaunched (`POST /api/sprints`).

```bash
# Pre-flight: kills any process holding a lock on a file under THIS repo's
# node_modules so `npm ci` doesn't fail with EPERM / errno -4048 unlink.
# Matches by absolute path (never by process name), two holder classes:
#   1. a process whose OWN image lives in this node_modules (stale esbuild.exe);
#   2. any process that has LOADED a native addon from this node_modules
#      (system node.exe, editor language server, leftover vitest worker) --
#      the class behind `npm ci` dying on @rollup/*/rollup.win32-x64-msvc.node.
# Never touches a holder of a same-named addon from a DIFFERENT checkout,
# nor this script or its ancestors.
# Exit 0     = nothing locked, or every lock cleared (verified by re-probing).
# Exit non-0 = still locked; output names the PID, image path, locked file,
#              and how many processes it could NOT inspect (access denied /
#              protected / cross-bitness) -- rerun elevated if unattributed.
#              Do NOT proceed to `npm ci`; fix the named holder first.
# --dry-run reports holders without killing.
node scripts/preflight-clear-build-locks.mjs

# `npm ci` DELETES node_modules and reinstalls. A partial failure (EPERM on a
# locked file included) leaves node_modules PARTIALLY installed, not merely
# stale: clear the named lock and rerun `npm ci` to completion before
# `npm run build`.
npm ci
npm run build
npm run build:binary

# Active-sprints gate (rules above). Substitute your dispatch prompt's sprintId
# for <your-sprint-id>; the script does an EXACT id comparison:
#   exit 0 -> proceed (no reservations, or only your own)
#   exit 3 -> STOP: a foreign sprint is live; do not run install --force
#   exit 1 -> usage error (fix the arguments, do not proceed)
# Unreachable supervisor = exit 0 (no live sprint to collide with). Omit
# --self-sprint-id only when given no identity: every reservation is then foreign.
curl -s http://localhost:8787/api/sprints
node scripts/check-foreign-sprints.mjs --self-sprint-id "<your-sprint-id>"

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  Darwin) PLATFORM=darwin ;;
  Linux)  PLATFORM=linux ;;
  *)      PLATFORM=win ;;
esac
case "$ARCH" in
  x86_64) SEA_ARCH=x64 ;;
  arm64|aarch64) SEA_ARCH=arm64 ;;
  *) SEA_ARCH="$ARCH" ;;
esac

INSTALLER="dist/apra-fleet-installer-${PLATFORM}-${SEA_ARCH}"
[ "$PLATFORM" = "win" ] && INSTALLER="${INSTALLER}.exe"

"$INSTALLER" install --force

# Use `run`, not `start` -- `start`'s Windows scheduled task requires an
# interactive logon session and silently no-ops without one. Launch detached:
# POSIX:   nohup "$HOME/.apra-fleet/bin/apra-fleet" run --transport http >> "$HOME/.apra-fleet/data/fleet.log" 2>&1 & disown
# Windows: plain background launch dies with the SSH channel -- use a real
#          detached child process (e.g. Invoke-CimMethod Win32_Process Create)
#          running: apra-fleet.exe run --transport http >> fleet.log 2>&1
# Then poll fleet.log / port 7523 to confirm it actually came up.
```

## Sandbox Deploy (for integration/regression testing)

**Use this section INSTEAD of `## Deploy` whenever you were dispatched for
integration or regression testing** (dispatch prompt says test environment /
integration / regression tests). Only a deploy that genuinely intends to
REPLACE this machine's live singleton belongs in `## Deploy`.

A sandbox deploy stands up a throwaway fleet MCP server + fleet-sprint
supervisor pair ALONGSIDE production: separate data dirs, separate ports, its
own empty member registry. It never stops, kills, or fights production, and
never calls `install --force`.

### Why this section exists

`install --force` stops the running fleet server with a plain process kill
(`pkill -x apra-fleet` / `taskkill /F /IM apra-fleet.exe` -- `killApraFleet()`
in `src/cli/install.ts`). Where the server is registered for OS auto-start,
that kill does not stick:

- **macOS**: the LaunchAgent is written with `KeepAlive.SuccessfulExit=false`
  (`src/services/service-manager/macos.ts`), so `launchd` relaunches under a
  NEW pid as fast as it is killed; the installer's `waitForApraFleetToStop()`
  poll never converges and the deploy fails. Only `launchctl bootout
  gui/<uid> <plist>` unregisters it, and the installer never calls that.
- **Linux/Windows**: same shape via the systemd user unit / `schtasks onlogon`.

A real sprint hit this: five consecutive Deploy failures, one root cause, so
its Deploy/Integration/Regression phases never ran against a fresh binary.
Making the installer's stop launchd-aware is separate, tracked work; this
section removes the need to stop anything.

### How isolation works (the three knobs)

Env-var driven only; there are no port/data-dir CLI flags.

| Knob | What it moves | Default |
| --- | --- | --- |
| `APRA_FLEET_DATA_DIR` | Fleet MCP server data dir: `server.json`, `registry.json`, credentials, salt, logs (`FLEET_DIR` in `src/paths.ts`) | `~/.apra-fleet/data` |
| `APRA_FLEET_PORT` | Fleet MCP server HTTP port (`DEFAULT_PORT` in `src/paths.ts`) | `7523` |
| `FLEET_SE_DATA_DIR` | Supervisor data dir: reservation ledger, sprint history, logs | `~/.apra-fleet-se` |

Two load-bearing consequences:

1. **A non-7523 `APRA_FLEET_PORT`, or `APRA_FLEET_DATA_DIR` set at all, marks
   the process a non-default instance** (`isNonDefaultInstance()` in
   `src/paths.ts`). `apra-fleet start` then ALWAYS direct-spawns and never
   calls the service manager, so a sandbox cannot register, start, or disturb
   the launchd plist / systemd unit / scheduled task.
2. **The supervisor finds its fleet server solely by reading
   `<APRA_FLEET_DATA_DIR>/server.json`** (`resolveFleetServerConnection` ->
   `checkRunningInstance`,
   `packages/apra-fleet-client/src/client/server-resolution.mjs`); there is no
   separate fleet-port setting. Exporting `APRA_FLEET_DATA_DIR` for the
   supervisor points it at the sandbox server, whose own empty `registry.json`
   gives it an empty member list while production's is untouched.

### Non-goals -- hard rules for a sandbox deploy

- **NEVER run the installer** (`install`, `install --force`). The install root
  is hardcoded to `~/.apra-fleet` (`FLEET_BASE` in `src/cli/config.ts`) with
  no override, so any install overwrites the production install AND its OS
  auto-start registration. Run the freshly built `dist/index.js` in place.
- **NEVER run `apra-fleet stop` / `node dist/index.js stop`** to tear down.
  `runStop()` (`src/cli/stop.ts`) checks `svcMgr.isInstalled()` FIRST with no
  `isNonDefaultInstance()` guard (the asymmetry with `start` is real): with
  the production service registered, `stop` in a sandbox environment stops
  PRODUCTION and leaves your sandbox running. Use the Teardown below.
- **NEVER bind the production ports.** `7523` (fleet MCP) and `8787`
  (supervisor) are off limits, as is whatever port production actually uses on
  this member if it differs -- check first (Step 0).
- **NEVER write into `~/.apra-fleet`, `~/.apra-fleet-se`, or production's
  configured data dirs.** Everything lives under the sandbox root.
- **Do NOT run the `## Deploy` active-sprints gate.** It protects a shared
  singleton you are about to restart; a sandbox restarts nothing, so a live
  foreign sprint is not a reason to stop.

### Step 0: record production's real ports and data dirs

Do not assume defaults: a member may run production on a non-default port
(fleet-mac serves on `7524` while a launchd-managed instance holds `7523`).
Capture what is live, then pick sandbox ports that collide with none of it.

POSIX:
```bash
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E 'node|apra-flee' || true
launchctl list 2>/dev/null | grep -i apra-fleet || true   # macOS
systemctl --user list-units 2>/dev/null | grep -i apra-fleet || true  # Linux
```

Windows (PowerShell):
```powershell
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalPort -in 7523,8787,17523,18787 } |
  Select-Object LocalPort, OwningProcess
schtasks /query /tn "*apra-fleet*" 2>$null
```

### Step 1: build (no install)

Same build steps as `## Deploy` (pre-flight included; a failed `npm ci` leaves
`node_modules` PARTIALLY installed) but STOP before the installer.
`npm run build:binary` is only needed to test the SEA binary itself;
`dist/index.js` is what this section runs.

POSIX:
```bash
node scripts/preflight-clear-build-locks.mjs
npm ci
npm run build
```

Windows (PowerShell):
```powershell
node scripts/preflight-clear-build-locks.mjs
npm ci
npm run build
```

### Step 2: choose the sandbox root and ports

Conventions (override if Step 0 shows a collision):

- Sandbox root: `<tmp>/fleet-sandbox-<sprint-or-cycle-id>` -- per-dispatch, so
  concurrent sandbox deploys never share state.
- Fleet MCP port: `17523` (`7523` + 10000).
- Supervisor port: `18787` (`8787` + 10000).

These avoid the ranges already reserved elsewhere: the regression smoke test's
`18700`/`18701`, viewer ports from `8081` (`DEFAULT_SPAWNER_BASE_PORT`), and
the dolt settle range `13300-13400` (`DEFAULT_PORT_RANGE`). If a chosen port
is occupied, pick another and record it -- do NOT kill whatever holds it. The
fleet MCP server silently rebinds to an OS-assigned port on `EADDRINUSE`
(`src/services/http-transport.ts`), so Step 3 verifies the recorded port.

### Step 3: launch the sandbox fleet MCP server

POSIX:
```bash
REPO="$(pwd)"                       # this checkout
SB="$HOME/tmp/fleet-sandbox-$SPRINT_ID"
rm -rf "$SB"; mkdir -p "$SB/mcp" "$SB/se"
export APRA_FLEET_DATA_DIR="$SB/mcp"
export APRA_FLEET_PORT=17523
export FLEET_SE_DATA_DIR="$SB/se"
export FLEET_SE_SWEEP_OWNER_DATA_DIR="$SB"

node "$REPO/dist/index.js" start > "$SB/start.log" 2>&1 || {
  echo "sandbox fleet server failed to start -- see $SB/start.log" >&2; exit 1; }
sleep 4
```

Windows (PowerShell):
```powershell
$Repo = (Get-Location).Path
$SB = Join-Path $env:USERPROFILE "tmp\fleet-sandbox-$SprintId"
if (Test-Path $SB) { Remove-Item -Recurse -Force $SB }
New-Item -ItemType Directory -Force (Join-Path $SB "mcp"), (Join-Path $SB "se") | Out-Null
$env:APRA_FLEET_DATA_DIR = Join-Path $SB "mcp"
$env:APRA_FLEET_PORT = "17523"
$env:FLEET_SE_DATA_DIR = Join-Path $SB "se"
$env:FLEET_SE_SWEEP_OWNER_DATA_DIR = $SB

node (Join-Path $Repo "dist\index.js") start *> (Join-Path $SB "start.log")
Start-Sleep -Seconds 4
```

`start`, not `run`: `start` direct-spawns a detached child (guaranteed by
`isNonDefaultInstance()`) and the spawned server writes `server.json`, the
ONLY thing that makes the instance discoverable to the supervisor in Step 4.

**Verify the recorded port, do not trust the launch** (silent-rebind hazard,
Step 2):

POSIX:
```bash
ACTUAL_PORT="$(node -e '
  const fs=require("node:fs"), path=require("node:path");
  const p=path.join(process.env.APRA_FLEET_DATA_DIR,"server.json");
  process.stdout.write(String(JSON.parse(fs.readFileSync(p,"utf8")).port ?? ""));
')"
[ "$ACTUAL_PORT" = "$APRA_FLEET_PORT" ] || {
  echo "sandbox server bound $ACTUAL_PORT, not $APRA_FLEET_PORT -- refusing to continue" >&2
  exit 1; }
```

Windows (PowerShell):
```powershell
$Info = Get-Content (Join-Path $env:APRA_FLEET_DATA_DIR "server.json") | ConvertFrom-Json
if ("$($Info.port)" -ne $env:APRA_FLEET_PORT) {
  Write-Error "sandbox server bound $($Info.port), not $env:APRA_FLEET_PORT"; exit 1
}
```

### Step 4: launch the sandbox supervisor

Inherits `APRA_FLEET_DATA_DIR` (points it at the sandbox fleet server) and
`FLEET_SE_SWEEP_OWNER_DATA_DIR` (scopes its dolt-orphan-sweep to the sandbox
so it can never kill a production sprint's ephemeral `dolt sql-server`).

POSIX:
```bash
nohup node "$REPO/packages/apra-fleet-se/bin/serve.mjs" --port 18787 \
  > "$SB/supervisor.log" 2>&1 &
sleep 5
curl -sf http://localhost:18787/api/health || {
  echo "sandbox supervisor did not come up -- see $SB/supervisor.log" >&2; exit 1; }
```

Windows (PowerShell):
```powershell
Start-Process -FilePath "node" `
  -ArgumentList (Join-Path $Repo "packages\apra-fleet-se\bin\serve.mjs"), "--port", "18787" `
  -RedirectStandardOutput (Join-Path $SB "supervisor.log") `
  -RedirectStandardError  (Join-Path $SB "supervisor.err.log") `
  -WindowStyle Hidden
Start-Sleep -Seconds 5
Invoke-RestMethod http://localhost:18787/api/health
```

### Step 5: prove isolation before testing anything

A sandbox that silently attached to production is worse than none. All three
must hold:

POSIX:
```bash
# 1. Sandbox supervisor sees an EMPTY registry, not production's members.
curl -sf http://localhost:18787/api/members     # expect {"members":[]}

# 2. Production still answers on its own port, with its own members.
curl -sf http://localhost:8787/api/health       # substitute production's real port

# 3. The sandbox is NOT registered for OS auto-start.
launchctl list 2>/dev/null | grep -i apra-fleet || true   # macOS: only production's label
```

Windows (PowerShell):
```powershell
Invoke-RestMethod http://localhost:18787/api/members
Invoke-RestMethod http://localhost:8787/api/health
schtasks /query /tn "*apra-fleet*" 2>$null
```

A member registered against the sandbox (`register-member` with these env
vars exported) lands in the sandbox's own `registry.json`, invisible to
production's `list_members` -- intended; that is what makes throwaway test
members safe.

### Step 6: smoke test the sandbox

```bash
node "$REPO/dist/index.js" --version
```
Confirm the version/commit matches Step 1's build. Do NOT use `## Smoke
test`'s `$HOME/.apra-fleet/bin/apra-fleet` path -- that is the production
install and reports a stale version while your sandbox runs the new code.

### Teardown

Run at the end of the integration/regression test phase, pass or fail. No
`stop` subcommand, no installer, no `pkill` by name (`pkill -x apra-fleet`
matches production too).

POSIX:
```bash
# 1. Graceful supervisor shutdown.
curl -sf -X POST http://localhost:18787/api/shutdown > /dev/null 2>&1 || true
sleep 3

# 2. Kill the sandbox fleet server by the pid in ITS OWN server.json --
#    never by process name, never via `stop`.
MCP_PID="$(node -e '
  try { process.stdout.write(String(JSON.parse(
    require("fs").readFileSync(process.argv[1],"utf8")).pid)); } catch {}
' "$SB/mcp/server.json")"
if [ -n "$MCP_PID" ]; then
  kill "$MCP_PID" 2>/dev/null || true
  sleep 3
  kill -9 "$MCP_PID" 2>/dev/null || true
fi

# 3. Remove the sandbox root wholesale.
rm -rf "$SB"
```

Windows (PowerShell):
```powershell
try { Invoke-RestMethod -Method Post http://localhost:18787/api/shutdown } catch {}
Start-Sleep -Seconds 3

$InfoPath = Join-Path $SB "mcp\server.json"
if (Test-Path $InfoPath) {
  $McpPid = (Get-Content $InfoPath | ConvertFrom-Json).pid
  if ($McpPid) { Stop-Process -Id $McpPid -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 2
Remove-Item -Recurse -Force $SB -ErrorAction SilentlyContinue
```

Then re-verify production matches Step 0 exactly: same pids, same ports,
supervisor uptime CONTINUOUS (a reset uptime means you restarted it, which a
sandbox deploy must never do).

## Smoke test

```bash
"$HOME/.apra-fleet/bin/apra-fleet" --version || "$HOME/.apra-fleet/bin/apra-fleet.exe" --version
```
Exit 0 = healthy. Call `version` (`mcp__apra-fleet__version` in Claude Code) and
confirm it matches the version/commit just built, then call `fleet_status` to
check online members. If `version` doesn't match, reconnect your MCP client
(`/mcp` in Claude Code, or restart your provider CLI) and retry.

## Rollback

No automated rollback. Check out the previous commit and re-run `## Deploy`
above.
