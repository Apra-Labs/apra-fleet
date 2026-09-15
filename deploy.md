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

`## Sandbox Deploy` never runs the installer. It shares the build prefixes
above (`preflight-clear-build-locks`, `npm ci`, `npm run build`) and
additionally needs exactly one more:
- `Bash(node scripts/sandbox-deploy.mjs *)` -- the whole sandbox lifecycle
  (`up`, `env`, `teardown`, ...). Port probes, HTTP checks, pid-scoped kills
  and the final `rm -rf` all happen INSIDE the script, never as separate Bash
  calls, so no `kill`/`rm`/`curl`/`lsof` entries are needed. A broader
  `Bash(node:*)` counts.

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

### Interim manual recovery: `install --force` cannot stop a launchd-managed server (macOS only)

**Applies to macOS only.** On Linux and Windows the server is not supervised by
launchd and this step does not apply -- skip it.

A patched installer stops the registered service through the service manager
before signalling anything, and reports a supervisor RELAUNCH distinctly from a
process that merely refused to die. An UNPATCHED installer binary (one built
before that fix) only runs `pkill -x apra-fleet`, which cannot win the race:
`~/Library/LaunchAgents/com.apra-fleet.server.plist` declares
`KeepAlive/SuccessfulExit=false`, so launchd relaunches the server under a new
pid immediately after the SIGKILL, and the installer exits 1 with

    could not stop the running apra-fleet server (it is still running after
    SIGTERM and a SIGKILL escalation)

while `~/.apra-fleet/data/fleet.log` shows a fresh startup line with a NEW pid.

This is the sanctioned recovery -- take the LaunchAgent out of the picture
first, then install, then bring it back. Do not invent a wrapper script or an
alternate kill loop; those only re-race launchd.

```bash
# macOS only. Take the service down (launchd stops relaunching it), then install.
launchctl bootout "gui/$(id -u)/com.apra-fleet.server" || true
pgrep -x apra-fleet || echo "server is down"

# Run this in place of the plain `"$INSTALLER" install --force` line in the
# Deploy script below ($INSTALLER is resolved there).
"$INSTALLER" install --force

# install re-registers and starts the service (SEA + HTTP transport). If it
# reported "registration skipped", bring it back by hand:
launchctl kickstart -k "gui/$(id -u)/com.apra-fleet.server"
```

Never leave the LaunchAgent booted out: the machine's shared singleton server
stays down for every sprint until it is bootstrapped again.

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
supervisor pair ALONGSIDE production: own data dirs, OS-assigned ports, its
own empty member registry. It never stops, kills, or fights production, and
never calls `install --force`. `scripts/sandbox-deploy.mjs` owns the whole
lifecycle; the rest of this section says what it does and why.

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
   separate fleet-port setting. Setting `APRA_FLEET_DATA_DIR` in the
   supervisor's environment points it at the sandbox server, whose own empty
   `registry.json` gives it an empty member list while production's is
   untouched.

### Why a script, not inline shell

A dispatched agent runs each step as its own stateless shell: an `export` in
one command is gone by the next. An inline recipe therefore launches the
supervisor with `APRA_FLEET_DATA_DIR` unset, and consequence 2 silently
attaches the "sandbox" supervisor to PRODUCTION's `server.json`. So the script
persists every chosen value in ONE file and every subcommand re-reads it:

- values file: `<home>/.fleet-sandbox-<safe-id>.env` (flat `KEY=value` lines)
- sandbox root: `<home>/tmp/fleet-sandbox-<safe-id>` (`mcp/` and `se/` inside)
- `<safe-id>` = sprintId with unsafe characters replaced by `-`, plus
  `-<first 8 hex of sha1(sprintId)>` so `a/b` and `a-b` never share a sandbox
- `<home>` = Node's `os.homedir()` (`USERPROFILE` on Windows), the same under
  Git Bash and PowerShell

Both derive from the sprintId alone -- the literal `Your dispatching sprint's
own supervisor reservation id (sprintId): <id>` line in every phase's
dispatch prompt -- so a later, separately dispatched phase finds the SAME
sandbox with nothing threaded through the orchestrator. The values file lives
OUTSIDE the sandbox root so Teardown's `rm -rf` can never orphan the pids it
needs.

### Non-goals -- hard rules for a sandbox deploy

- **NEVER run the installer** (`install`, `install --force`). The install root
  is hardcoded to `~/.apra-fleet` (`FLEET_BASE` in `src/cli/config.ts`) with
  no override, so any install overwrites the production install AND its OS
  auto-start registration. The script runs the freshly built `dist/index.js`
  in place.
- **NEVER run `apra-fleet stop` / `node dist/index.js stop`** to tear down.
  `runStop()` (`src/cli/stop.ts`) checks `svcMgr.isInstalled()` FIRST with no
  `isNonDefaultInstance()` guard (the asymmetry with `start` is real): with
  the production service registered, `stop` in a sandbox environment stops
  PRODUCTION and leaves your sandbox running. Use the Teardown below.
- **NEVER bind the production ports.** The script asks the OS for free ports
  and refuses `7523`/`8787` (and the regression playbook's `18700`/`18701`).
- **NEVER write into `~/.apra-fleet`, `~/.apra-fleet-se`, or production's
  configured data dirs.** Everything lives under the sandbox root.
- **Do NOT run the `## Deploy` active-sprints gate.** It protects a shared
  singleton you are about to restart; a sandbox restarts nothing, so a live
  foreign sprint is not a reason to stop.

### Lifecycle ownership -- who runs what

| Phase (role) | Runs | Leaves behind |
| --- | --- | --- |
| Deploy (`deployer`) | Step 1 build, Step 2 `up` | the sandbox RUNNING, values file on disk |
| Integration Test (`integ-test-runner`) | `env` to locate it, the tests, then `teardown` LAST, pass or fail | nothing |
| Regression Test (`regression-test-runner`) | `teardown` as a sweep for a sandbox Integ Test never got to (Deploy succeeded, Integ did not run) | nothing |

The deployer never tears down a sandbox that came up: Integration Test runs
AFTER Deploy and is what the sandbox exists for. If `up` fails, the script
tears down whatever it started before exiting non-zero.

### Step 1: build (no install)

Same build steps as `## Deploy` (pre-flight included; a failed `npm ci` leaves
`node_modules` PARTIALLY installed) but STOP before the installer.
`npm run build:binary` is only needed to test the SEA binary itself;
`dist/index.js` is what this section runs. Same commands in POSIX and
PowerShell:

```bash
node scripts/preflight-clear-build-locks.mjs
npm ci
npm run build
```

### Step 2: bring the sandbox up

```bash
node scripts/sandbox-deploy.mjs up --sprint-id "<your-sprint-id>"
```

`up` runs the four subcommands below in order (each is also runnable on its
own, for diagnosis, with the same `--sprint-id`):

- `init` -- if a values file for this id already exists (a prior run leaked),
  runs `teardown` first. Allocates two OS-assigned free ports (never the
  reserved ones above; the OS ephemeral range also clears viewer ports from
  `8081` and the dolt settle range `13300-13400`), creates `<root>/mcp` and
  `<root>/se`, snapshots production (`~/.apra-fleet/data/server.json` pid,
  `:8787/api/health` pid + uptime, when present), writes the values file.
- `start` -- spawns `dist/index.js --transport http` detached with the env
  from the file (what `apra-fleet start` does internally for a non-default
  instance), then REQUIRES `<root>/mcp/server.json` to name the pid it just
  spawned and the port it allocated (the server silently rebinds to an
  OS-assigned port on `EADDRINUSE`, `src/services/http-transport.ts`), and
  `/health` on that port to answer with that pid. Then
  `packages/apra-fleet-se/bin/serve.mjs --port <supervisor-port>` the same
  way; `/api/health` must answer with the spawned pid (on `EADDRINUSE` the
  supervisor exits, `src/supervisor/server.mjs`). Every failure kills what it
  just started before exiting 1 -- a "something answered 200" check would
  pass against an unrelated squatter; a pid match cannot.
- `verify` -- isolation proof: the sandbox supervisor's `/api/members` is
  EMPTY (not production's members), both pids still answer as themselves,
  `server.json` still matches, and production's pids are unchanged with
  supervisor uptime CONTINUOUS (a reset uptime means it was restarted, which
  a sandbox deploy must never do).
- `smoke` -- `/health` of the RUNNING sandbox server must answer with its
  recorded pid and a version matching this checkout's `version.json`. Not
  `dist/index.js --version`: that reads a local file and passes whether or
  not anything is running. Never `## Smoke test`'s
  `$HOME/.apra-fleet/bin/apra-fleet` either -- that is production.

Exit 0 = sandbox up; the values file is printed to stdout. Put its path,
`APRA_FLEET_PORT` and `SUPERVISOR_PORT` in `notes`, return `deployed: true`,
and LEAVE IT RUNNING. Exit 1 = failed; `up` has already torn down what it
started -- return `deployed: false` with the stderr.

Not registered for OS auto-start is guaranteed by construction (consequence 1
above: both env vars are set), so no `launchctl`/`schtasks` survey is needed.

### Locating the sandbox from a later phase

```bash
node scripts/sandbox-deploy.mjs env --sprint-id "<your-sprint-id>"
```

Prints the values file: `APRA_FLEET_PORT`, `SUPERVISOR_PORT`,
`APRA_FLEET_DATA_DIR`, `FLEET_SE_DATA_DIR`, `MCP_PID`, `SUPERVISOR_PID`, ...
Exit 1 = no sandbox exists for this id. A member registered against the
sandbox (`register-member` with those env vars set in THAT command) lands in
the sandbox's own `registry.json`, invisible to production's `list_members`
-- intended; that is what makes throwaway test members safe.

### Teardown

Owned by the integration/regression test phase and run at its END, pass or
fail (see Lifecycle ownership) -- never by the deployer after a successful
`up`. No `stop` subcommand, no installer, no `pkill` by name (`pkill -x
apra-fleet` matches production too).

```bash
node scripts/sandbox-deploy.mjs teardown --sprint-id "<your-sprint-id>"
```

Order, and why it is this order:

1. Reads `<root>/mcp/server.json` and the recorded pids BEFORE deleting
   anything -- `server.json` is the only pid record, and a server whose
   record was `rm -rf`ed first becomes unkillable by this recipe.
2. Supervisor: `POST /api/shutdown` only if `/api/health` answers with the
   recorded pid, then TERM, then KILL.
3. Fleet server: a candidate pid (from `server.json` or the values file) is
   killed only if it is the pid this recipe launched or it answers `/health`
   as itself -- never a process that merely holds "a pid file".
4. Confirms both ports are actually free.
5. Only then removes the sandbox root and the values file.

If anything is still alive or bound after 2-4, exit is 1 and the root AND
values file are KEPT so a retry can still find the pid -- report the stderr
instead of retrying blindly. No values file = "nothing to tear down", exit 0,
so it is safe to run as a sweep. It ends by re-checking production's pids and
uptime against the `init` snapshot and warns on any change.

Windows caveat: the fleet server's auth named pipe
(`\\.\pipe\apra-fleet-auth-<username>`, `src/services/auth-socket.ts`) has no
per-instance suffix outside tests, so a sandbox and production collide on it
the first time either opens the pipe (lazy, on a secret prompt). Tracked
separately; it does not affect the lifecycle above.

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
