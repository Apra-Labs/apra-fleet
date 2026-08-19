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

`--port <n>` overrides the default (8787). Self-logs to
`<dataDir>/logs/supervisor.log` in addition to stdout.

Smoke test (a few seconds after launch -- give it time to bind):
```bash
curl -s -m 5 http://localhost:8787/api/sprints   # expect {"sprints":[],...}
curl -s -m 5 http://localhost:8787/api/members   # expect the registered fleet, non-empty
```
Both must succeed before treating the supervisor as up -- a bound port with
a 500 on `/api/members` still means something is broken.

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

## 1. Before you launch a sprint

1. If you just created/edited beads locally, push them first:
   `bd dolt commit` then `bd dolt push`. Members pull their own copy; a
   sprint launched before the push works from stale scope.
2. Check no conflicting sprint is already running: `GET /api/sprints`.
3. Multi-member sprints need all members on the SAME git HEAD, or the
   launch crashes immediately with a topology error. If unsure, use ONE
   member. Don't guess a member list -- ask, or default to one.

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
