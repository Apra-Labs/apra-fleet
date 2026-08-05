# apra-fleet v0.4.0 Release Notes (DRAFT)

*Covers everything since v0.3.6: the auto-sprint engine hardening, the
apra-fleet-se/apra-fleet-workflow product, fleet server reliability work,
and dashboard/e2e improvements.*

## Breaking changes

### MCP transport now defaults to HTTP, not stdio

Every prior release connected LLM providers to apra-fleet over **stdio** --
each provider spawned its own `apra-fleet` subprocess per session. As of
v0.4.0, a fresh `apra-fleet install` registers providers against the
**streamable HTTP** transport instead, talking to one long-lived
`apra-fleet run` server on `http://localhost:7523/mcp`.

**If you installed or updated via `apra-fleet install` / `apra-fleet
update`, this is automatic -- nothing to do.** The installer re-registers
your MCP config for you.

**If you hand-edited your provider's MCP config** (e.g. you wrote
`{"command": "apra-fleet", "args": ["--stdio"]}` or `["run"]` yourself),
you're unaffected either way: `--stdio` and the old bare invocation both
still work as documented aliases. You only need to act if you want to pick
up the new default explicitly -- run `apra-fleet install --transport http`,
or `apra-fleet install --transport stdio` to opt back out.

Why this matters: HTTP mode means one shared server backs every provider on
a machine instead of one subprocess per provider per session -- faster
reconnects, and fleet state (members, sprints, reservations) is consistent
across every tool you have talking to it at once.

### `auto-sprint` (the CLI workflow) is now `fleet-sprint`

apra-fleet's own autonomous sprint engine -- `apra-fleet workflow auto-sprint
...`, the `auto-sprint` npm bin, and the installed
`~/.apra-fleet/workflows/auto-sprint/` directory -- is renamed to
**`fleet-sprint`** across the board.

This does **not** touch Claude Code's separate `/auto-sprint` slash command
(a different, Claude-Code-specific workflow script) -- that keeps its name.
The two were being routinely confused for the same thing, which is exactly
why the rename happened.

**Migration:** re-run `apra-fleet install` to lay down the renamed workflow
directory and its skill, and swap `apra-fleet workflow auto-sprint` for
`apra-fleet workflow fleet-sprint` in any scripts you have.

## What's new

### fleet-sprint got substantially more reliable

If you've run multi-hour autonomous sprints before, the biggest practical
win in this release is that they now survive things that used to kill them:

- **No more false "empty response" failures.** A flaky SSH channel could
  previously report a dispatch as done-with-nothing while the remote LLM
  process was still genuinely working -- burning a retry, or worse, losing
  the turn's output. apra-fleet now checks whether the process is actually
  still alive before declaring failure, waits it out, and recovers the real
  output from a durable log instead of giving up.
- **Real stalls are now actually caught.** The stall detector used to miss
  turns that were mostly running tools (as opposed to talking) -- exactly
  the kind of turn a coding agent spends most of its time in. It now
  watches all activity, not just chat output, and will kill a genuinely
  stuck dispatch instead of leaving it to hang. Stall detection also now
  cross-checks the transcript file's own OS-level modification time against
  its content timestamps, so a slow-writing (but still working) process is
  no longer mistaken for a stuck one.
- **Sync failures no longer masquerade as dispatch failures.** A git/Dolt
  push hiccup after a successful LLM turn no longer triggers a full,
  wasteful re-dispatch of that turn -- the two failure modes are now
  distinguished and handled separately. A credential/auth failure is also
  now told apart from a genuine data-divergence conflict, so a lapsed token
  triggers the existing auth self-heal instead of exhausting the divergence
  retry ladder against a wall it can't actually fix.
- **A wedged beads clone can now recover itself.** When two clones'
  histories genuinely conflict (not just "remote moved first," which was
  already handled), apra-fleet now attempts a graduated recovery -- resolve
  the conflict in place if it's simple enough, fall back to a clean
  re-bootstrap from the shared remote if not, and escalate to an agent with
  a runbook only if both of those fail -- instead of the sprint simply
  aborting on the spot.
- Sprints now run against a **shared fleet safely** -- concurrent sprints
  can no longer collide over the same member or the same issue-scope
  subtree, and simultaneous git/Dolt writes across members are
  coordinated instead of racing.
- Windows build fix: `npm run build:binary` was silently producing nothing
  on Windows (a path-comparison bug in the packaging script never matched);
  this is fixed, so Windows users can once again build their own binary
  from source. Windows reliability was hardened more broadly this release
  too -- a watchdog event-loop-starvation bug (from a blocking process
  read) is fixed, and several scripts that previously only worked correctly
  from a bash-style shell now resolve and invoke `bd`/`npm` correctly on
  native Windows as well.
- A real npm install now actually works end to end: the fleet-sprint engine
  and its workspace files are shipped in the published tarball, and
  `@apralabs/apra-fleet-client` now resolves for a genuine npm install
  (previously it silently only worked from a dev workspace checkout,
  quietly degrading every npm-installed sprint's dolt-mutex/id-allocator
  coordination to a no-op).

### Integ Test and Regression Test are now separate phases

Previously a single "Integ Test" phase tried to do double duty: verify
just-closed work every cycle, and also catch broader regressions. These are
now split -- Integ Test stays scoped to verifying the current cycle's closed
features, and a new once-per-sprint **Regression Test** phase runs the full
regression suite separately, filing carry-over bugs for anything it finds
without aborting the sprint over a regression-phase failure.

### An always-on, multi-sprint supervisor service (preview)

`apra-fleet-se` gained a supervisor mode that runs several sprints
concurrently against a shared fleet, with a live dashboard (running
sprints, history, a backlog tree), member/issue-scope reservations so
sprints can't step on each other, and orchestrator-managed git+Dolt sync.
This release adds:

- Per-sprint **Stop** and **Restart** controls (Restart releases the old
  reservation and relaunches the same scope from the dashboard).
- Launching a sprint against multiple issue roots at once (comma-separated),
  with a scope guard that refuses to launch a sprint whose member or issue
  scope overlaps one already running.
- A relaunch guard that refuses to silently resume a prior sprint
  incarnation against a stale build.
- Dashboard cost totals now include failed-but-token-consuming dispatches
  and break out a distinct integ-test-runner line, so the total reported
  actually matches spend.
- Viewer parity with fleet-sprint's own dashboard -- Sprints/Backlog tabs,
  goal-based placement, and quick-task actions (rename, move to Launch
  Sprint, filters, multi-select).

**This is still a preview, not yet fully proven end-to-end** -- the full
plan-develop-review-harvest cycle has not yet passed cleanly against a live
smoke test in this release. Unit and build coverage is solid, and a real
amount of hardening landed (see above), but treat multi-sprint supervisor
mode as experimental for now if you're relying on unattended runs.

### Member management: categories, tags, and no-LLM members

- `register_member` / `update_member` now accept a `category` (grouped
  display in `list_members` / `check_status`) and up to 10 `tags`.
- Tags aren't just labels: `compose_permissions` can now merge permission
  profiles by tag (e.g. a `gpu` tag pulls in a GPU-specific profile) instead
  of only the fixed doer/reviewer roles, and `list_members` can filter by
  tag. `register_member` now runs `compose_permissions` automatically for a
  new member's role/tags rather than requiring a separate manual call.
- You can now register a member with `llm_provider: none` for machines that
  only run commands or host services and never dispatch to an LLM (GPU
  nodes, relay-only members, etc). *(Currently supported at registration
  time; switching an existing member to `none` via `update_member` is not
  yet wired up -- tracked as a follow-up.)*

### `apra-fleet workflow`: a general-purpose workflow runner

The SEA binary can now run installed workflow scripts directly --
`apra-fleet workflow <name> [args...]` -- backed by a real workflow engine
(`apra-fleet-workflow`) with typed errors, real budget enforcement,
resumable/replayable runs, and cooperative `/stop` cancellation instead of
a hard process kill. fleet-sprint itself is the first workflow shipped on
this engine; it's designed for others to build on.

### Dashboard / viewer improvements

The live sprint dashboard is substantially more usable on long or large
sprints:
- No more near-freezes on big sprints -- updates are coalesced, finished
  activity renders once instead of every tick, and full bead/output detail
  loads on demand instead of being re-sent on every poll.
- The task tree now reflects real parent/child structure (blocking
  relationships are shown as a note, not folded into tree placement), and a
  blocked-but-open task is visually distinct from ready work.
- Sprint state is now saved automatically on completion, stop, or
  interruption -- not only when the dashboard happened to be open.
- The dashboard page title correctly reads "Fleet-Sprint" rather than the
  old "Auto-Sprint" label.
- A per-sprint log file (stdout/stderr) is now captured and linked directly
  from the dashboard, so a failed run's raw output is one click away
  instead of a manual log hunt.

## Known issues

- The multi-sprint supervisor's end-to-end smoke test (a full
  plan-develop-review-harvest cycle against a live sandbox) has not yet
  passed cleanly -- see "preview" note above.
- A member whose remote shell is strict POSIX sh/dash (not bash/zsh) may
  fail the new durable-output recovery mechanism, which relies on `set -o
  pipefail`. All current members use bash/zsh, so this is a defensive
  follow-up, not an active bug.
- Hub-spoke cloud migration (`apra-fleet join` / `apra-fleet spoke`) is
  early groundwork in this release -- the shared API contract and identity
  model landed, but end-to-end spoke mode is not yet usable.
- An automated `permissions.json` ledger (auto-seeded from playbook-declared
  permissions, with a drift guard) was prototyped this cycle and then
  reverted pending a broader design pass -- see
  `docs/missing-grant-recovery-and-playbook-evolution.md`. Until that lands,
  granting a role's permissions is still a manual `settings.json` /
  `settings.local.json` edit.

## Upgrade

```bash
apra-fleet update
```

or download the latest installer from GitHub Releases and run it with
`install --force`. See `deploy.md` for platform-specific details.
