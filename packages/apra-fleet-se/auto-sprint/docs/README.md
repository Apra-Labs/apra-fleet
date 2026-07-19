# Running auto-sprint

This doc exists because it is easy to reach for the wrong launcher. There are
two different things in this repo/session that are both called "auto-sprint",
and only one of them is the real thing.

## Supported user-facing interfaces

The service HTTP API and web dashboard are the **single supported user-facing
interfaces** for Fleet. Users launch sprints via:

- The **service API** (HTTP on port 7523, with SSE server-push)
- The **web dashboard** in Claude Code (`/mcp` loader)
- The **PM skill commands** in Claude Code (`/pm start`, `/pm status`, etc.)

The `bin/cli.mjs` CLI below is an **internal implementation detail only** --
it is used exclusively by the supervisor process to execute workflows. Manual
direct invocation of `cli.mjs` bypasses the reservation ledger and is
unsupported for user-facing workflows. Always use the service API or dashboard
instead.

## The only correct way to launch a real sprint

Run `packages/apra-fleet-se/bin/cli.mjs` directly with a real Node.js process,
in the background, and watch it via its dashboard viewer HTTP endpoint. This
is a genuine, long-running Node process -- not a Claude Code Skill or
Workflow invocation.

```bash
node packages/apra-fleet-se/bin/cli.mjs \
  --issue apra-fleet-eft \
  --members fleet-reorg \
  --branch auto-sprint/eft-service \
  --base feat/fleet-reorg \
  --viewer-port 18300 \
  > ./sprint-logs/auto-sprint.log 2>&1 &
disown
```

Required flags: `--issue`, `--members`, `--branch`, `--base`. See
`node packages/apra-fleet-se/bin/cli.mjs --help` for the full flag list
(`--goal`, `--max-cycles`, `--allow-missing-members`, `--requirements-file`,
`--role-map`, `--viewer-port`, `--budget`).

Once it starts, `console.log` in `bin/cli.mjs` prints the dashboard URL
(`http://localhost:<viewer-port>`); use a browser tool to watch progress
there rather than tailing raw stdout.

Always use `nohup`-style backgrounding (`&` + `disown` on POSIX, or an
equivalent detached start on Windows) -- a plain `&` tied to a single tool
call's process group can be killed when that tool call returns, silently
orphaning the sprint mid-run.

## What NOT to do: the Claude Code `Workflow` tool

`packages/apra-fleet-se/auto-sprint/runner.js` (the actual sprint engine,
loaded at runtime by `bin/cli.mjs` via `engine.executeFile()`) is plain
Node.js: it uses `require('fs')`, `require('path')`, and shells out to real
`node -e "..."` one-liners for JSON post-processing.

Claude Code's own `Workflow` tool (a separate, unrelated orchestration
feature for fanning out sub-agents) also happens to be invocable with
`name: "auto-sprint"` if a same-named skill/workflow file has been copied
into `~/.claude/workflows/`. Do not use it for this. That tool executes
scripts in a sandboxed JS context with **no `require`, no filesystem
access, and no real Node.js APIs** -- calling
`Workflow({ name: "auto-sprint", args: {...} })` fails immediately with
`Error: require is not defined`, before any sprint phase runs. The two
"auto-sprint" names are unrelated: one is a real Node CLI, the other is a
Claude-Code-internal sub-agent-fanout script format. Only the CLI form
above is the real sprint.

## Dispatch-safety invariant: member_name required on every call site

Every `command()` or `agent()` call site in `runner.js` (the sprint engine)
MUST pass an explicit `member_name` or `member_id` option. This is a hard
invariant, not a convention.

Why this matters: The workflow engine throws immediately if neither
`member_name` nor `member_id` is supplied -- there is no fallback to
local execution or ambient member inference. Once fleet members are
arbitrary remote/heterogeneous machines (not the developer's local checkout),
a silent call site that lacks a member identifier would only surface at
runtime, on a real fleet dispatch, in whatever topology happens to be
running that day. By the time the error surfaces, the doer is mid-streak
with no immediate opportunity to fix it.

The guard is enforced automatically: `npm test` runs the
`dispatch-safety-guard.test.mjs` test, which parses every `command(` and
`agent(` token in `runner.js`, verifies it carries `member_name` or
`member_id`, and asserts the exact baseline call-site counts (29 command()
sites and 11 agent() sites as of 2026-07-19). If a new call site is added
without the required option, or an existing site is dropped, the test fails
and blocks the commit. If a new compliant site is intentionally added, the
baseline count must be bumped (after confirming the site passes the guard).

## How to make one bead represent a whole set (epics / manifest beads)

If you want a single bead to stand in for a group of other beads (an epic,
a "next sprint scope" manifest, etc.), the group members MUST be linked as
**parent-child**, not as **blocked-by**:

- Add each item as a child of the umbrella bead:
  `bd create ... --parent <umbrella-id>` (new beads), or
  `bd update <id> --parent <umbrella-id>` (existing beads).
- The umbrella bead itself must have **zero** blocking dependencies of its
  own -- do not also add `blocks` edges from the umbrella bead to its own
  children. It should only ever be the *target* of parent-child edges
  (children point at it), never the source of a `blocks` edge pointing at
  them.
- "All done" tracking (closing the umbrella bead once every child is
  closed) is a manual/observational step based on child status
  (`dependent_count`), not something enforced by a `blocks` edge.

Why this matters: `bd`'s ready-work engine treats a `blocks` edge as a real
blocker. If the umbrella bead both (a) is `blocked-by` its children (so it
can't close until they do) AND (b) is their `parent` (so they belong to it),
that is a 2-node cycle on every pair -- and `bd` marks every bead caught in
a cycle as **not ready**, deadlocking the umbrella bead and all of its
children simultaneously. This is exactly what "blocked-by" gets you wrong
and "parent-child" gets right: a successful epic (e.g. `apra-fleet-7pm`)
has `dependency_count: 0` (it depends on / is blocked by nothing) and a
nonzero `dependent_count` (its children point at it). A broken manifest
bead that used `blocks` instead had `dependency_count: 5` and, once
children were also parented under it, deadlocked completely.

This also matters for launching a sprint: `auto-sprint`'s `--issue <id>`
flag resolves the sprint's scope via `bd list --parent <id>` internally --
it only ever understands the `parent-child` hierarchy. A `blocked-by`-only
manifest bead is invisible to auto-sprint's scope filter no matter what you
pass to `--issue`; only true children are picked up.

## Preconditions worth checking first

- The target issue (e.g. `apra-fleet-7pm`) must exist and be open:
  `bd show <issue>`.
- Every `--members` name must be registered with the fleet
  (`list_members`); an unregistered member aborts the sprint unless
  `--allow-missing-members` is passed.
- Multi-member sprints require all configured members to share the same
  git HEAD (`checkMemberTopology`) -- see `auto-sprint-diagram.md` for the
  supported-topology notes. Stick to single-member unless that's verified.
- The sprint branch (`--branch`) is created from `--base` if it does not
  already exist; if it already exists (e.g. resuming on the current
  working branch), it is reused as-is.
