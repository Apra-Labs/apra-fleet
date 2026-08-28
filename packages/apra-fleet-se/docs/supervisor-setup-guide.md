# Setting Up the fleet-sprint Supervisor for a New Project

This guide walks through standing up fleet-sprint's supervisor -- the
always-on process that owns the reservation ledger and launches sprints --
against **any** git + beads project, not just apra-fleet itself. See
`overview.md` for the mental model of what a sprint actually does and
`architecture.md` for the full internals; this doc is only about the
one-time setup.

`fleet-sprint`/`fleet-se` is deliberately **apra-fleet-agnostic**: it is
plain, user-copyable `.mjs` source (`@apralabs/apra-fleet-se` is
`"private": true` -- there is no npm package to install), designed to be
copied into any target project's repo and wired up there. This guide assumes
you already have the `apra-fleet` MCP server running and connected (its own
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
- Node.js on every machine that will run a member or the supervisor.
- At least one machine with a full git checkout of the target project --
  this is where your `doer`/`reviewer`/`planner` members live.

## Step 1 -- Copy fleet-sprint into the target project

Copy `packages/apra-fleet-se/` (this whole directory) into the target
project's repo, e.g. as `packages/apra-fleet-se/` there too, or any path you
prefer -- nothing hardcodes apra-fleet's own layout. Install its
dependencies (`npm install` inside that copied directory, or fold it into
the target project's own workspace setup if it has one).

Two bin entries matter:

| Script | Role |
|---|---|
| `bin/serve.mjs` | The supervisor HTTP process (`fleet-se-serve`) -- the one users actually run. |
| `bin/cli.mjs` | The per-sprint CLI (`fleet-sprint`) the supervisor spawns as a detached child. **Not a supported direct entry point** -- invoking it yourself bypasses the reservation ledger. |

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

## Step 3 -- Set up a dedicated, git-less orchestrator member

fleet-sprint has an `orchestrator` pseudo-role (outside the normal
doer/reviewer/etc. role roster) used for every beads/Dolt-sync dispatch the
runner itself needs, plus raising the final PR via a REST VCS call --
neither of which needs a working copy of the project's source. Pointing the
orchestrator role at one of your regular dev members works, but ties up a
real checkout for something that doesn't need one, and risks that member's
own branch state interfering with orchestrator-level bd/dolt operations.

The clean pattern is a **dedicated member whose folder holds only a beads
clone, no source checkout at all**:

```bash
mkdir /path/to/<project>-orchestrator
cd /path/to/<project>-orchestrator
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

Then register it:
```
register_member(
  friendly_name: "orchestrator",
  member_type: "local",   // or "remote" if it lives on another machine
  work_folder: "/path/to/<project>-orchestrator",
  llm_provider: "none",   // plain command executor -- no agent dispatches happen on this member
  tags: ["orchestrator", "beads-only"],
  unreservable: true       // shared across concurrently-running sprints, never exclusively reserved
)
```

`llm_provider: "none"` is important: this member only ever runs `bd`/`git`/
`curl` commands via `execute_command`, never an LLM dispatch, so it needs no
LLM auth at all. `unreservable: true` lets multiple sprints share it
concurrently without reservation conflicts (see
`docs/design-orchestrator-worktree-model-v2.md` if that file is present in
your checkout, or the "Multi-member topology" section of `architecture.md`,
for why the orchestrator role is deliberately non-exclusive).

**Gotcha -- this is not auto-wired.** As of this writing, registering a
member with an `orchestrator` tag does *not* automatically make
fleet-sprint use it: you must pass `roleMap: {"orchestrator":
["orchestrator"]}` explicitly on every sprint launch (Step 5). Omitting it
silently falls back to treating one of your regular dev members as the
orchestrator, which defeats the point of this setup -- there is a known,
not-yet-landed fix to make an unmapped orchestrator a hard launch-time
failure instead of a silent fallback; until then, double-check your launch
payload.

## Step 4 -- Launch the supervisor

From wherever you copied `apra-fleet-se` into the target project:
```bash
node packages/apra-fleet-se/bin/serve.mjs   # detached/background; runs indefinitely
```
Default port 8787. Smoke test:
```bash
curl -s http://localhost:8787/api/sprints    # expect {"sprints":[],...}
curl -s http://localhost:8787/api/members    # expect your registered fleet, non-empty
```
See the `fleet-supervisor` skill (or `docs/supervisor-api.md` in this
folder) for start/stop/restart/auto-start-on-login procedures -- they are
fully generic, nothing there is apra-fleet-specific either.

## Step 5 -- Launch your first sprint

```bash
curl -s -X POST http://localhost:8787/api/sprints \
  -H "Content-Type: application/json" \
  -d '{
    "issue": "<a beads root id in the target project>",
    "branch": "<new-or-existing-branch>",
    "base": "<base-branch>",
    "members": ["dev-member"],
    "roleMap": {"orchestrator": ["orchestrator"]}
  }'
```
Remember the `roleMap.orchestrator` line from Step 3's gotcha -- it is what
actually routes bd/dolt/PR-raise dispatches to your beads-only member
instead of a dev checkout. Everything else about launching, checking
status, and killing a sprint is exactly what `docs/supervisor-api.md`
describes.

## Recap: what lives where

| Folder | Contains | Used for |
|---|---|---|
| Dev member checkout(s) | Full git clone of the target project | `doer`/`reviewer`/`planner`/`plan-reviewer` dispatches -- actual code changes |
| Deploy member checkout (optional) | Full git clone, independent of dev members | `deployer`/`integ-test-runner`/`regression-test-runner` dispatches |
| Orchestrator folder | `.git/` (Dolt refs only) + `.beads/` -- no source at all | bd/dolt sync brackets, PR-raise REST calls |
| Supervisor process folder | The copied `apra-fleet-se` source | Running `bin/serve.mjs` itself -- this is a plain Node process launch location, not a registered member |

The last row is worth calling out: the supervisor *process* needs the real
`.mjs` source present somewhere to run at all (it is not bundled into any
compiled binary -- see the "Design decision" section of
`docs/windows-shell-selection.md` if present in your checkout, or
`architecture.md`, for why), but that folder does not need to be, and
usually should not be, the same folder as any registered member's
`work_folder`. Keep the process launch location and the orchestrator
member's beads-only folder conceptually separate even if it's convenient to
put them side by side on disk.
