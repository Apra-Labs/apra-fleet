# Fleet Deploy Runbook

## Permissions

Commands below require these prefixes covered by SOME entry in `permissions.allow` of
EITHER `.claude/settings.json` OR `.claude/settings.local.json` (where the fleet's
compose_permissions tool delivers); a broader prefix entry counts as coverage:
- `Bash(*apra-fleet-installer-* install *)`
- `Bash(*apra-fleet* --version)`
- `Bash(*apra-fleet* run *)`
- `Bash(*apra-fleet* start)` -- kept alongside `run` above: `run` is what this
  runbook's own Deploy step launches with (see the Windows scheduled-task
  caveat there), but `start` is still a real, separately-invoked command
  (e.g. OS-level auto-start registration, manual fallback) and a member
  missing this grant fails Step 0a the moment anything tries it.
- `Bash(node scripts/preflight-clear-build-locks.mjs*)` -- pre-`npm ci` stale
  build-tool lock cleanup, see Deploy below. Trailing `*` so the diagnostic
  `--dry-run` form is covered by the same grant.
- `Bash(npm ci)`
- `Bash(npm run build)`
- `Bash(npm run build:binary)`
- `Bash(dist/apra-fleet-installer-* install *)`
- `Bash(curl * localhost:8787/api/sprints*)` -- for the pre-`install --force`
  active-sprints check below. Port 8787 is the supervisor's own API; the
  singleton MCP server `install --force` restarts is a separate process on
  7523, not what you're querying here.
- `Bash(node scripts/check-foreign-sprints.mjs*)` -- the self-vs-foreign
  classifier the active-sprints gate below runs against that same endpoint.
- `Bash(curl * localhost:8787/api/reservations/*)` -- only for the documented
  force-release of a stale reservation below.

For `## Sandbox Deploy` below (which never runs the installer) these are the
prefixes that matter instead -- the build steps above are shared:
- `Bash(node dist/index.js *)` -- the sandbox fleet server's `start`, and its
  `--version` smoke test. A broader `Bash(node:*)` counts as coverage.
- `Bash(node *packages/apra-fleet-se/bin/serve.mjs *)` -- the sandbox
  supervisor. Note the invocation uses an ABSOLUTE `<repo-root>/...` path, so
  a relative-prefix entry does not cover it; `Bash(node:*)` does.
- `Bash(curl * localhost:18787/*)` -- the sandbox supervisor's health,
  members, and shutdown endpoints. Substitute your actual sandbox port.
- `Bash(mkdir *)` and `Bash(rm -rf *fleet-sandbox-*)` -- sandbox root
  lifecycle.
- `Bash(kill:*)` -- teardown's pid-scoped kill of the sandbox fleet server.
- `Bash(lsof:*)` / `Bash(launchctl list*)` -- Step 0's production port and
  auto-start survey (POSIX). On Windows the equivalents are PowerShell
  `Get-NetTCPConnection` and `schtasks /query`.

## Deploy

> **Deploying for integration or regression testing? Stop -- use
> `## Sandbox Deploy (for integration/regression testing)` below instead.**
> This section replaces the machine's shared production singleton and is only
> for a real production rollout. A test deploy must not restart production
> infrastructure; the sandbox section stands up an isolated instance that runs
> alongside it. See that section's "Why this section exists" for the launchd
> `KeepAlive` failure that motivated the split.

Builds from source and installs locally using installer binary is found inside ./dist folder with install --force arguments

**Caution: `install --force` stops the running fleet server first.** This is
the shared singleton MCP server (`localhost:7523`) that every live supervisor
sprint's dispatches depend on, not just your own MCP connection. If a
supervisor is running sprints when you deploy, the restart can collaterally
kill their child processes. Before deploying onto a machine running the
supervisor, check `GET /api/sprints` and stop only for a FOREIGN sprint --
see "Active-sprints gate" immediately below.

### Active-sprints gate: your own reservation vs. a foreign one

`GET /api/sprints` lists the supervisor's reservation ledger. Every entry
carries a `sprintId` (the incarnation-unique reservation key) and a
`childPid`. A deploy dispatched BY a sprint always finds that sprint's OWN
reservation in this list -- the sprint is live, that is what dispatched you --
so "the list is non-empty" is NOT by itself a reason to stop. Stopping on it
means no sprint can ever deploy its own work.

**How you obtain your own sprint identity:** your dispatch prompt states it
explicitly, as `Your dispatching sprint's own supervisor reservation id
(sprintId): <id>`. That string is the ledger key for your dispatching sprint.
If your dispatch prompt does NOT state one (a manual/human-triggered deploy),
you have no self identity: treat EVERY live reservation as foreign and stop
on any of them.

**Classify, then decide** (exact-match comparison on `sprintId`, never a
substring or prefix match against issue-root text -- two unrelated sprints can
share an issue root):

- Only your own reservation(s) present, or none at all -> PROCEED with the
  deploy.
- Any reservation with a different `sprintId` -> STOP. Do not run
  `install --force`. Return `deployed: false` naming the foreign sprintId(s);
  wait for them to finish, or ask the operator to force-release genuinely
  stale ones and relaunch afterward.

**Stale SELF-reservation (orchestrator-side force-release).** If the only
matching reservation is your own but its child is gone (the sprint died and
left the ledger entry behind), the entry is stale. You do not clear it -- it
does not block your deploy anyway. Report it in `notes` so the orchestrator
or operator can release it, which is done against the supervisor:

```bash
curl -s -X POST http://localhost:8787/api/reservations/<sprintId>/force-release
```

The same route is what the supervisor dashboard's Stop/Restart controls use.
After a force-release the sprint must be relaunched (`POST /api/sprints`) --
releasing the reservation does not restart anything.

```bash
# Path-scoped pre-flight: clears any process still holding a lock on a file
# under THIS repo's node_modules so `npm ci` doesn't fail with EPERM /
# errno -4048 unlink. It finds two holder classes, both scoped to this exact
# checkout by absolute path (never by process name):
#   1. a process whose OWN image lives in this node_modules (stale esbuild.exe);
#   2. a process living ANYWHERE that has LOADED a native addon from this
#      node_modules as a mapped module (a system node.exe, an editor language
#      server, a leftover vitest worker). This class is the one that made
#      earlier runs report success while `npm ci` died anyway on
#      @rollup/*/rollup.win32-x64-msvc.node.
# A process that loaded a same-named addon from a DIFFERENT checkout is never
# reported and never killed; neither is this script or any of its ancestors.
#
# Exit 0 = nothing was locked, or every lock was cleared (verified by
# re-probing the files, not by assuming the kill worked).
# Exit NON-ZERO = something is still locked; the output names the blocking
# PID, its image path and the locked file, plus how many processes it could
# NOT inspect (access denied / protected / cross-bitness) -- rerun elevated
# if the holder was not attributable. Do NOT proceed to `npm ci` on a
# non-zero exit; fix the named holder first.
#
# Add --dry-run to report holders without killing anything.
node scripts/preflight-clear-build-locks.mjs

# `npm ci` DELETES node_modules and reinstalls from scratch. A run that fails
# partway (EPERM on a locked file included) therefore leaves node_modules
# PARTIALLY INSTALLED, not merely stale: the following steps must not assume
# a usable tree. Clear the lock the pre-flight named and rerun `npm ci` to
# completion before running `npm run build` or anything else.
npm ci
npm run build
npm run build:binary

# Active-sprints gate (see "Active-sprints gate" above). Substitute the
# sprintId your dispatch prompt gave you for <your-sprint-id>. The script
# classifies each live reservation against it with an EXACT id comparison:
#   exit 0 -> proceed (no reservations, or only your own)
#   exit 3 -> STOP: a foreign sprint is live; do not run install --force
#   exit 1 -> usage error (fix the arguments, do not proceed)
# An unreachable supervisor is exit 0 -- there is no live sprint to collide
# with. Omit --self-sprint-id only when you were given no identity: then every
# reservation counts as foreign.
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

**Use this section INSTEAD of `## Deploy` above whenever you were dispatched
for integration or regression testing purposes rather than a real production
deploy.** If your dispatch prompt says you are deploying to a test
environment, or for integration/regression tests, this is your section. Only
a deploy that genuinely intends to REPLACE the live singleton on this machine
(a real production rollout) belongs in `## Deploy`.

A sandbox deploy stands up a complete, throwaway fleet MCP server +
fleet-sprint supervisor pair that runs peacefully ALONGSIDE the production
pair -- separate data directories, separate ports, its own empty member
registry. It therefore never needs to stop, kill, or fight the running
production infrastructure, and it never calls `install --force` at all.

### Why this section exists

`install --force` stops the running fleet server with a plain process kill
(`pkill -x apra-fleet` on POSIX, `taskkill /F /IM apra-fleet.exe` on Windows
-- `killApraFleet()` in `src/cli/install.ts`). On a machine where the server
is registered for OS-level auto-start, that kill does not stick:

- **macOS**: the LaunchAgent this runbook's "Auto-start on login/boot"
  guidance installs is written with `KeepAlive.SuccessfulExit=false`
  (`src/services/service-manager/macos.ts`), so `launchd` relaunches the
  process under a NEW pid as fast as it is killed. The installer's
  `waitForApraFleetToStop()` poll keeps observing a live `apra-fleet`, never
  converges, and the deploy fails. Nothing short of
  `launchctl bootout gui/<uid> <plist>` actually unregisters it, and the
  installer never calls that.
- **Linux/Windows** have the same shape via their systemd user unit /
  `schtasks onlogon` registration.

A real sprint hit exactly this: five consecutive Deploy-phase failures with
one root cause, which meant that sprint's Deploy, Integration Test and
Regression Test phases never ran against a freshly built binary at all.
Fixing the installer's stop logic to be launchd-aware is separate, already-
tracked work. This section removes the need to stop anything in the first
place: a test deploy has no business restarting the machine's shared
production singleton.

### How isolation works (the three knobs)

Everything is env-var driven; there are no port/data-dir CLI flags.

| Knob | What it moves | Default |
| --- | --- | --- |
| `APRA_FLEET_DATA_DIR` | Fleet MCP server data dir: `server.json`, `registry.json`, credentials, salt, logs (`FLEET_DIR` in `src/paths.ts`) | `~/.apra-fleet/data` |
| `APRA_FLEET_PORT` | Fleet MCP server HTTP port (`DEFAULT_PORT` in `src/paths.ts`) | `7523` |
| `FLEET_SE_DATA_DIR` | Supervisor data dir: reservation ledger, sprint history, logs | `~/.apra-fleet-se` |

Two consequences make this safe, and both are load-bearing:

1. **Setting either `APRA_FLEET_PORT` (to a non-7523 value) or
   `APRA_FLEET_DATA_DIR` (at all) marks the process a non-default instance**
   -- `isNonDefaultInstance()` in `src/paths.ts`. `apra-fleet start` checks
   it and ALWAYS direct-spawns such an instance, deliberately never calling
   the service manager. A sandbox instance therefore cannot register, start,
   or disturb the launchd plist / systemd unit / scheduled task, even on a
   machine where production is registered.
2. **The supervisor finds its fleet server purely by reading
   `<APRA_FLEET_DATA_DIR>/server.json`** (`resolveFleetServerConnection` ->
   `checkRunningInstance` in
   `packages/apra-fleet-client/src/client/server-resolution.mjs`). There is
   no separate "which fleet port do I talk to" setting. Exporting
   `APRA_FLEET_DATA_DIR` for the supervisor process is what points it at the
   sandbox fleet server instead of production's -- and, because the sandbox
   data dir has its own empty `registry.json`, the sandbox supervisor sees an
   empty member list while production's is untouched.

### Non-goals -- hard rules for a sandbox deploy

- **NEVER run the installer** (`install`, `install --force`). The install
  root is hardcoded to `~/.apra-fleet` (`FLEET_BASE` in `src/cli/config.ts`)
  with no env var or flag to redirect it, so any install necessarily writes
  over the shared production install AND its OS auto-start registration.
  Run the freshly built `dist/index.js` in place instead; that is the whole
  point of this section.
- **NEVER run `apra-fleet stop` / `node dist/index.js stop`** to tear a
  sandbox down. `runStop()` (`src/cli/stop.ts`) checks
  `svcMgr.isInstalled()` FIRST and has no `isNonDefaultInstance()` guard --
  the asymmetry with `start` is real. On a machine with the production
  service registered, `stop` in a sandbox environment stops the PRODUCTION
  service and leaves your sandbox server running. Use the teardown below.
- **NEVER bind the production ports.** `7523` (fleet MCP default) and `8787`
  (supervisor default) are off limits, and so is whatever port production
  actually uses on this member if it differs -- check first (see Step 0).
- **NEVER write into `~/.apra-fleet`, `~/.apra-fleet-se`, or production's
  configured data dirs.** Everything lives under the sandbox root.
- **Do NOT run the `## Deploy` active-sprints gate.** It exists to protect a
  shared singleton you are about to restart. A sandbox deploy restarts
  nothing, so a live foreign sprint is not a reason to stop -- that is
  precisely the cross-talk this section eliminates.

### Step 0: record production's real ports and data dirs

Do not assume the defaults. A member may run production on a non-default
port (fleet-mac runs its production MCP server on `7524`, with a launchd-
managed instance separately holding `7523`). Capture what is live, then pick
sandbox ports that collide with none of it.

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

Same build steps as `## Deploy` -- including the `preflight-clear-build-locks`
pre-flight and the note that a failed `npm ci` leaves `node_modules` PARTIALLY
installed -- but STOP before the installer. `npm run build:binary` is only
needed if you specifically intend to test the SEA binary; `dist/index.js` is
what this section runs.

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

Conventions used below (override if Step 0 shows a collision):

- Sandbox root: `<tmp>/fleet-sandbox-<sprint-or-cycle-id>` -- per-dispatch, so
  two concurrent sandbox deploys on one machine never share state.
- Fleet MCP port: `17523` (production default `7523` + 10000).
- Supervisor port: `18787` (production default `8787` + 10000).

Both offsets deliberately avoid the ranges the regression playbook and the
engine already reserve: the regression smoke test's `18700`/`18701`, viewer
ports from `8081` (`DEFAULT_SPAWNER_BASE_PORT`), and the dolt settle range
`13300-13400` (`DEFAULT_PORT_RANGE`). If Step 0 shows any chosen port is
occupied, pick another and record it -- do NOT kill whatever holds it. The
fleet MCP server silently rebinds to an OS-assigned port on `EADDRINUSE`
(`src/services/http-transport.ts`) rather than failing loud, so Step 3
verifies the recorded port rather than trusting the launch.

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

`start` is correct here and `run` is not: `start` direct-spawns a detached
child (guaranteed by `isNonDefaultInstance()`, see above) and the spawned
server writes `server.json`, which is the ONLY thing that makes the instance
discoverable to the supervisor in Step 4.

**Verify the recorded port, do not trust the launch** (the silent-rebind
hazard from Step 2):

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

It inherits the same `APRA_FLEET_DATA_DIR`, which is what points it at the
sandbox fleet server rather than production's. `FLEET_SE_SWEEP_OWNER_DATA_DIR`
(exported in Step 3) additionally scopes this supervisor's dolt-orphan-sweep
to the sandbox so it can never kill a production sprint's ephemeral
`dolt sql-server`.

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

A sandbox that silently attached to production is worse than no sandbox, so
assert it rather than assuming it. All three must hold:

POSIX:
```bash
# 1. The sandbox supervisor sees an EMPTY registry, not production's members.
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

Any member registered against the sandbox (`register-member` run with these
env vars exported) lands in the sandbox's own `registry.json` and is
invisible to production's `list_members` -- that is the intended behaviour
and what makes throwaway test members safe.

### Step 6: smoke test the sandbox

```bash
node "$REPO/dist/index.js" --version
```
Confirm the version/commit matches what Step 1 just built. Do NOT use the
`## Smoke test` section's `$HOME/.apra-fleet/bin/apra-fleet` path -- that is
the production install, and it will happily report a stale version while your
sandbox runs the new code.

### Teardown

Run this at the end of the integration/regression test phase, pass or fail.
Note again: no `stop` subcommand, no installer, no `pkill` by process name
(`pkill -x apra-fleet` matches production's process too).

POSIX:
```bash
# 1. Graceful supervisor shutdown.
curl -sf -X POST http://localhost:18787/api/shutdown > /dev/null 2>&1 || true
sleep 3

# 2. Kill the sandbox fleet server by the pid recorded in ITS OWN server.json
#    -- never by process name, and never via `stop`.
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

Then re-verify production is exactly as you found it in Step 0 -- same pids,
same ports, supervisor uptime CONTINUOUS (an uptime that reset means you
restarted it, which a sandbox deploy must never do).

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
