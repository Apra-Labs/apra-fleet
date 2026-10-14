# Setting Up the fleet-sprint Supervisor for a New Project

This guide walks through standing up fleet-sprint's supervisor -- the
always-on process that owns the reservation ledger and launches sprints --
against **any** git + beads project, not just apra-fleet itself. See
`overview.md` for the mental model of what a sprint actually does and
`architecture.md` for the full internals; this doc is only about the
one-time setup.

`fleet-sprint`/`fleet-se` is deliberately **target-agnostic**: it runs
sprints for any git + beads repo. It ships with apra-fleet: `apra-fleet
install` (the default, full install) places it under
`~/.apra-fleet/workflows/fleet-sprint/` (`bin/serve.mjs` is the supervisor,
`bin/cli.mjs` the per-sprint engine). This guide assumes you already have the
`apra-fleet` MCP server running and connected (its own
`register_member`/`provision_llm_auth`/`provision_vcs_auth` tools are used
throughout) -- see the main apra-fleet `README.md` if you don't yet.

## Prerequisites

- A git repository for the target project, with a beads (`bd`) issue
  tracker set up and a shared Dolt remote configured (`bd config get
  sync.remote` should print a `git+https://...` URL) -- fleet-sprint reads
  and writes real beads issues, it does not create a separate tracking
  system of its own. If the target project has no beads DB yet, run
  `bd init` in it and push once (`bd dolt push`, after adding a git origin)
  so `sync.remote` is real for every member that will clone from it.
- A system Node.js 22.16+ and npm on PATH on the machine that runs the
  supervisor (the apra-fleet installer checks this before installing
  fleet-se and stops if either is missing).
- `bd` runnable in the work folder of every member a sprint uses, and on
  the supervisor's PATH (it probes its own `.beads` with `bd`). `apra-fleet
  install` provides `bd` (it needs npm on that machine; when global npm is
  not writable it places `bd` in `~/.apra-fleet/bin`, which you may need to
  add to PATH for the supervisor). A member without `bd` fails the sprint's
  preflight before any dispatch.
- At least one machine with a full git checkout of the target project --
  this is where your `doer`/`reviewer`/`planner` members live.

## Step 1 -- Locate fleet-sprint

Nothing is copied into the target project. After `apra-fleet install` the
two entry points are:

| Script | Role |
|---|---|
| `~/.apra-fleet/workflows/fleet-sprint/bin/serve.mjs` | The supervisor HTTP process -- the one users actually run. |
| `~/.apra-fleet/workflows/fleet-sprint/bin/cli.mjs` | The per-sprint CLI the supervisor spawns as a detached child (`apra-fleet workflow fleet-sprint` runs the same file). **Not a supported direct entry point** -- invoking it yourself bypasses the reservation ledger. |

On Windows the same files are under `$HOME\.apra-fleet\workflows\fleet-sprint\bin\`.
From a source checkout of apra-fleet they are `packages/apra-fleet-se/bin/`.

## Step 2 -- Register your development members

Use the apra-fleet MCP `register_member` tool for each machine that should
actually implement/review/deploy work -- these need a real git checkout of
the target project as their `work_folder`, and an LLM provider
(`llm_provider: "claude"` etc.) since they run agent dispatches. One member
is enough to start; add more later for parallel doer pools. See the main
apra-fleet `README.md`'s "member registration" section for the full
`register_member` walkthrough (SSH vs. local, `provision_llm_auth`, etc.) --
nothing here is fleet-sprint-specific.

If the target project runs local software that needs to be deployed and
smoke-tested as part of a sprint (a `deploy.md` + `integ-test-playbook.md`
pair -- see `overview.md`'s "Deploy & Integration Test" phase), give
`deployer`/`integ-test-runner` their own dedicated member with an
independent git clone (not a worktree of a dev member's checkout), separate
from the doer/reviewer pool, via a sprint's `roleMap`:
```json
{"deployer": ["deploy-member"], "integ-test-runner": ["deploy-member"], "doer": ["dev-member"]}
```

## Step 3 -- Decide the supervisor's project folder (its backlog member)

fleet-sprint has a `backlog` pseudo-role (outside the normal
doer/reviewer/etc. role roster) used for every beads/Dolt-sync dispatch the
runner itself needs, plus raising the final PR via a REST VCS call --
neither of which needs a working copy of the project's source.

**The supervisor owns this member; you do not register or map it.** At
startup it takes the project folder it runs against (the folder holding
`.beads`, found by walking up from its working directory or given with
`--beads-dir`) and ensures a local, LLM-less, `unreservable` member whose
work folder is that folder:

- an LLM-less local member already registered for that folder is adopted
  (its name is kept; the `backlog` tag and `unreservable` flag are added when
  missing);
- otherwise it registers one named `backlog-<camelCaseFolderName>`, also when
  an LLM member already uses that folder (one LLM and one LLM-less member may
  share a folder);
- it refuses to start (exit 1) if that name is taken by a member for another
  folder; fleet unreachable at startup leaves it `degraded` (launches answer
  `503`) until a background retry succeeds.

Every sprint it launches is pinned to that member (Step 5). The only choice
you make is which folder the supervisor runs against. Running it from your
dev checkout works; the clean pattern is a **folder that holds only a beads
clone, no source checkout at all**, used as the supervisor's `--beads-dir`:

```bash
mkdir /path/to/<project>-backlog
cd /path/to/<project>-backlog
git init
git remote add origin <same git remote the target project's `sync.remote` uses>
bd bootstrap --yes
```

`bd bootstrap` auto-detects that `origin` carries Dolt data
(`refs/dolt/data`) and clones the real, shared beads database into
`.beads/` -- same issues, same prefix as the target project's own clones --
without ever checking out a single source file. The folder ends up
containing just `.git/` (holding only the Dolt refs, not the project
history/working tree) and `.beads/`. Verify with `bd status` in that folder
-- it should report the same issue counts as any other clone of the same
project.

Sprint processes run from the supervisor's project folder, so with a
beads-only folder there are no source files there: a `requirementsFile`
given as a relative path (e.g. `docs/reqs.md`) is not found, and the
sprint only logs a warning and plans without it. Pass `requirementsFile`
as an absolute path on the supervisor's machine (for example into your
dev checkout).

The backlog member has `llm_provider: "none"`: it only ever runs
`bd`/`git`/`curl` commands via `execute_command`, never an LLM dispatch, so
it needs no LLM auth at all.
`unreservable` lets multiple sprints share it concurrently without
reservation conflicts (see the "Multi-member topology" section of
`architecture.md` for why the backlog role is deliberately non-exclusive).

**Deprecated alias.** `roleMap.orchestrator` and the `orchestrator` member
tag are deprecated aliases of `roleMap.backlog` and the `backlog` tag. They
are accepted in 0.4.4 and removed in v0.5. Using `roleMap.orchestrator`
produces a deprecation warning in the launch response (`warnings` array) and
in the run log; giving both keys with different values is rejected with a
400. (The tag itself is only a label -- nothing reads it.)

## Step 4 -- Launch the supervisor

From INSIDE the target project (its root, or any folder under it):
```bash
node ~/.apra-fleet/workflows/fleet-sprint/bin/serve.mjs              # macOS / Linux; detached, runs indefinitely
```
```powershell
node "$HOME\.apra-fleet\workflows\fleet-sprint\bin\serve.mjs"    # Windows PowerShell
```
The supervisor resolves which `.beads` tracker it runs against by walking
up from its own working directory, exactly like `bd` does -- the same rule
applies to the sprints it launches, which run from that project root. If
you must start it from elsewhere (a service manager, a scheduler, another
checkout), pass the project explicitly:
```bash
node ~/.apra-fleet/workflows/fleet-sprint/bin/serve.mjs --beads-dir /path/to/target-project
```
(`--beads-dir` accepts the project folder or its `.beads` directory; a
nonexistent path is a startup error.) Nothing sets `BEADS_DIR` and nothing
is persisted: the resolved identity (`.beads` dir, prefix, `sync.remote`,
git origin) is logged once at startup, reported by `GET /api/health` as
`beads`, shown at the top of the dashboard, and handed to every sprint it
launches so the engine can verify each member's own `bd where` against it.

If no `.beads` is reachable from the working directory (or the identity
probe fails: `bd` not on PATH, project not initialised), the supervisor
STILL STARTS but warns loudly and runs with its beads identity unknown:

```
[supervisor] WARNING: no beads database found walking up from <cwd>. Backlog and scope-overlap checks are disabled and sprints will verify against the backlog member's beads instead. To fix: restart fleet-se from inside the project folder, or pass --beads-dir <project-or-.beads-path>, then GET /api/health?refresh=1.
```

In that state `GET /api/health` returns `beads: null` plus `beadsWarning`
(the same text) and the dashboard header shows an amber `Beads: NOT
RESOLVED -- ...` line in place of the identity line.

- **No `.beads` found at all:** the supervisor has no backlog member
  (`backlogMember.status: "degraded"`, reason naming `--beads-dir`), so
  every launch answers `503`. Only a restart from the right folder / with
  `--beads-dir` fixes it. (The warning's "sprints will verify against the
  backlog member's beads" and `refresh=1` hints predate this and do not
  apply here.)
- **`.beads` found but its probe failed:** the backlog member is still set
  up and launches proceed, without `--expect-beads` (the engine takes the
  expectation from the backlog member's own `bd where`). Fix the
  environment and call `GET /api/health?refresh=1` to recover the identity
  without a restart.

Default port 8787. Smoke test:
```bash
curl -s http://localhost:8787/api/sprints    # expect {"sprints":[],...}
curl -s http://localhost:8787/api/members    # expect your registered fleet, non-empty
curl -s http://localhost:8787/api/health     # expect beads.prefix = your project's prefix, backlogMember.status = "ready"
```
(Windows PowerShell 5.1: use `curl.exe`, since `curl` there is an alias of
`Invoke-WebRequest`.)

**Upgrading apra-fleet.** Let running sprints finish (or stop them) and
stop the supervisor before upgrading; start it again afterwards. It keeps
the code it was started with. A supervisor started under 0.4.3 is refused by a 0.4.4 fleet
server (HTTP 401: it does not send the install's access secret).

**Stale member reservations.** If a sprint died uncleanly (it crashed, or
was still running when you upgraded, e.g. with `--ignore-running-sprints`),
its members can stay reserved on the fleet server and the first launch
fails with `409 member overlap rejects launch: sprint '<id or branch>'
already claims [...]`. Clear each listed member with the fleet MCP tool
`member_reservation {member_name: "<member>", action: "force_release"}`
(from your agent; the supervisor has no HTTP route for it), then launch
again.

See the `fleet-supervisor` skill for the full
start/stop/restart/auto-start-on-login procedures, and `docs/supervisor-api.md`
in this folder for the API's operational semantics -- both are fully generic,
nothing there is apra-fleet-specific either.

## Step 5 -- Launch your first sprint

```bash
curl -s -X POST http://localhost:8787/api/sprints \
  -H "Content-Type: application/json" \
  -d '{
    "issue": "<a beads root id in the target project>",
    "branch": "<new-or-existing-branch>",
    "base": "<base-branch>",
    "members": ["dev-member"]
  }'
```
No `roleMap.backlog`: the supervisor injects its own backlog member (Step
3), and a `roleMap.backlog` naming any other member is rejected with `400`.
`branch` must differ from `base` (`400` otherwise). Everything else about
launching, checking status, and killing a sprint is exactly what
`docs/supervisor-api.md` describes.

## Recap: what lives where

| Folder | Contains | Used for |
|---|---|---|
| Dev member checkout(s) | Full git clone of the target project | `doer`/`reviewer`/`planner`/`plan-reviewer` dispatches -- actual code changes |
| Deploy member checkout (optional) | Full git clone, independent of dev members | `deployer`/`integ-test-runner`/`regression-test-runner` dispatches |
| Supervisor project folder (`--beads-dir`) | `.beads/`, ideally a beads-only clone (`.git/` with Dolt refs only) | The supervisor's own backlog member: bd/dolt sync brackets, PR-raise REST calls |
| `~/.apra-fleet/workflows/fleet-sprint/` | The installed fleet-sprint source | Running `bin/serve.mjs` itself -- a plain Node process, not a registered member |

The supervisor *process* runs the installed `.mjs` source with your system
Node.js (it is not bundled into the `apra-fleet` binary); its project
folder is separate and is the one its backlog member works in.
