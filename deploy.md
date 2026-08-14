# Fleet Deploy Runbook

## Permissions

Commands below require these prefixes in `.claude/settings.json` under `permissions.allow`:
- `Bash(*apra-fleet-installer-* install *)`
- `Bash(*apra-fleet* --version)`
- `Bash(*apra-fleet* run *)`
- `Bash(node scripts/preflight-clear-build-locks.mjs)` -- pre-`npm ci` stale
  build-tool lock cleanup, see Deploy below
- `Bash(npm ci)`
- `Bash(npm run build)`
- `Bash(npm run build:binary)`
- `Bash(dist/apra-fleet-installer-* install *)`
- `Bash(curl * localhost:8787/api/sprints*)` -- for the pre-`install --force`
  active-sprints check below. Port 8787 is the supervisor's own API; the
  singleton MCP server `install --force` restarts is a separate process on
  7523, not what you're querying here.

## Deploy

Builds from source and installs locally using installer binary is found inside ./dist folder with install --force arguments

**Caution: `install --force` stops the running fleet server first.** This is
the shared singleton MCP server (`localhost:7523`) that every live supervisor
sprint's dispatches depend on, not just your own MCP connection. If a
supervisor is running sprints when you deploy, the restart can collaterally
kill their child processes. Before deploying onto a machine running the
supervisor, check `GET /api/sprints` for active sprints; if any are running,
either wait for them to finish or be ready to force-release their stale
reservations and relaunch afterward.

```bash
# Ownership-scoped pre-flight: finds any process still holding a lock on a
# file under THIS repo's node_modules -- both an orphaned in-tree build tool
# (node_modules/@esbuild/*/esbuild.exe) and an OUT-OF-TREE node.exe that has
# one of this repo's native modules (@rollup/*/*.node) mapped -- so `npm ci`
# doesn't fail with EPERM/unlink. Never name-based: a kill requires the
# holder's own executable to live inside this exact checkout's node_modules,
# or its image to be in the script's small build-toolchain allowlist; this
# process and every ancestor of it are never killed, and anything else (AV,
# editors) is reported for manual resolution rather than killed.
#
# Exits non-zero and names the holder PID + image + locked file path when a
# lock cannot be cleared (2 = "holder unknown"), so STOP and resolve it before
# running `npm ci` -- npm ci prunes before installing, so a failure here
# leaves node_modules unusable for every later build/test step. Add
# `--report-only` to diagnose without killing anything.
node scripts/preflight-clear-build-locks.mjs

npm ci
npm run build
npm run build:binary

# Active-sprints check (see Caution above): if this returns a non-empty
# "sprints" array, STOP -- wait for them to finish, or be ready to
# force-release their stale reservations and relaunch afterward.
curl -s http://localhost:8787/api/sprints

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

# Use `run`, not `start` -- on Windows, `apra-fleet start`'s scheduled-task
# registration falls back to an interactive-logon-only trigger whenever it
# cannot obtain elevated/stored credentials, so it silently no-ops with no
# interactive session present (apra-fleet-i8qj.2); see README.md and
# docs/transport-and-service-mode.md / docs/fleet-sprint-getting-started.md
# (owned by apra-fleet-i8qj.7) for the full treatment. Launch detached instead:
#
# POSIX:
#   nohup "$HOME/.apra-fleet/bin/apra-fleet" run --transport http >> "$HOME/.apra-fleet/data/fleet.log" 2>&1 & disown
#
# Windows: a plain background launch dies with the SSH channel. Use the
# single supported launch path below -- both commands route through the
# hidden-launch helper (launchDetachedHidden, src/os/windows.ts) so the
# child gets no visible console window and survives the launching shell
# exiting. Do NOT hand-roll Invoke-CimMethod / "cmd /c start" launches:
# cmd.exe's quote-stripping silently killed earlier ad hoc attempts, and an
# un-hidden window alarms the user for no reason. These two commands are the
# only sanctioned way to start these processes on Windows.
#
#   MCP server (port 7523), from the installed binary:
#     node dist/cli/launch-mcp-server-windows.js
#   Poll: port 7523 and %USERPROFILE%\.apra-fleet\data\fleet.log
#
#   Fleet-sprint supervisor (port 8787), from this repo checkout:
#     node dist/cli/launch-fleet-supervisor-windows.js <repoRoot> [port]
#   Poll: port 8787 and %USERPROFILE%\.apra-fleet\data\fleet-supervisor.log
#
# Neither launcher ever passes the opt-out `showWindow: true` flag, so on
# Windows neither process can produce a console window through this path --
# hiding is not just the default, it is the only behaviour these two call
# sites can produce. If you ever DO see a console window for one of these
# processes, it did not come from these launchers; it is a hand-rolled
# fallback outside this contract, titled "Apra Fleet MCP Server -- do not
# close" (the helper's only defined opt-out title, src/os/windows.ts
# DETACHED_VISIBLE_WINDOW_TITLE), and closing that window kills the service.
# The supervisor has no distinct opt-out title yet (follow-up:
# apra-fleet-1vq0); treat any visible window carrying either process's
# launch command as that process regardless of title.
```

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
