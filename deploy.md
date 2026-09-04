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

## Deploy

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
