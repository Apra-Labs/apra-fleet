<!-- llm-context: Reference for how Apra Fleet uses Beads, the bundled open-source issue tracker. Consult when a user asks about bd commands, task tracking, sprint epics, backlog management, or the PM skill's persistent task state. -->
<!-- keywords: Beads, bd, task, epic, sprint, backlog, pm, lifecycle, dependency, issue tracker, bd ready, bd create, bd close -->
<!-- see-also: ../README.md (PM skill overview), ../packages/apra-fleet-se/apra-pm/skills/pm/SKILL.md (PM skill reference), ../packages/apra-fleet-se/apra-pm/skills/pm/beads.md (internal PM Beads rules) -->

# Beads -- Fleet's Persistent Task Tracker

Beads is a bundled open-source local issue tracker installed alongside Fleet by
`apra-fleet install`. It provides the `bd` CLI and serves as the PM skill's
persistent task database across all sprints and sessions.

## What Beads Does

- **One central DB** -- the PM agent runs `bd init` once in its own working
  directory. A single Beads database tracks all projects, all members, and all
  sprints. Run `bd list --all --pretty` for a global view without reading files.
- **Epics and tasks** -- each sprint gets an epic; each PLAN.md task gets a child
  task with priority, assignee, and dependency links (`bd dep add`).
- **Cross-session persistence** -- task state survives PM restarts. On session
  start, run `bd ready` for an instant cross-sprint view of what is in flight.
- **Lifecycle hooks** -- the PM skill calls `bd` at every phase boundary: init,
  plan approval, task dispatch, verify checkpoint, reviewer findings, and cleanup.

## Common Commands

| Command | What it does |
|---------|-------------|
| `bd ready` | Show all unblocked, open tasks across all sprints |
| `bd list --all --pretty` | Full tree: all projects, members, tasks, status |
| `bd create "<title>" -p <pri> --parent <epic-id> --assignee <member>` | Create a task |
| `bd create "<title>" --id <explicit-id>` then `bd update <explicit-id> --parent <epic-id>` | Create a task with a pre-decided id under a parent -- `bd create` rejects a call that combines `--id` and `--parent` in the same invocation, so an explicit id and a parent link are always two separate calls, never one |
| `bd show <id> --json` | Full detail for one task |
| `bd update <id> --status in_progress --assignee <member>` | Mark a task in progress |
| `bd close <id>` | Mark a task complete (idempotent) |
| `bd reopen <id>` | Reopen a prematurely closed task |
| `bd dep add <task-id> <blocks-id>` | Declare a dependency |
| `bd search "<term>" --status all --json` | Search tasks; check before creating to avoid duplicates |
| `bd note <id> "<text>"` | Attach a note (e.g. PR URL at sprint close) |

Priority values: `0` = highest, `3` = lowest (backlog).

## PM Lifecycle Hooks

The PM skill integrates Beads at these points in every sprint:

| PM command | Beads action |
|-----------|-------------|
| `/pm init` | `bd init` (idempotent); create sprint epic; record epic ID in status.md |
| `/pm plan` (after approval) | `bd create` one task per PLAN.md item; `bd dep add` for dependencies |
| `/pm start` / task dispatch | `bd update <id> --status in_progress --assignee <member>` |
| VERIFY checkpoint done | `bd close <id>` |
| Reviewer CHANGES NEEDED | `bd create` a task per HIGH finding |
| `/pm cleanup` | `bd close <epic-id>`; `bd note <epic-id> "PR: <url>"` |

## Backlog and Deferred Items

```bash
# Defer an item at low priority
bd create "<description>" -p 3 --parent <epic-id>

# Show full tree including deferred items
bd list --all --pretty
```

## Cross-Sprint Dependencies

Block sprint B on sprint A:

```bash
bd dep add <sprint-B-epic-id> <sprint-A-epic-id>
```

`bd ready` will not surface sprint B tasks until sprint A closes.

## Recovery After a PM Restart

Session crash? Run `bd list --all --pretty`. The PM sees every member's state
across every active project without reading a single file. Then `bd show <id>`
for full context on any item.

## Multi-member sync (Dolt-backed clones)

The dolt-settle step only ever kills dolt servers this member started: it
stops pids recorded in a per-member pidfile, re-checked against the live command
line and port, and falls back to the dolt already present when it kills nothing.

Each member's beads DB is an embedded Dolt clone. `apra-fleet install` also
provisions a portable Dolt CLI binary alongside `bd` (verified with a version
check at install time) -- this is a hard prerequisite for any sync path that
needs to inspect or resolve a Dolt clone directly, not merely an optional
extra. When more than one member's clone needs to reconcile against a shared
Dolt remote (for example, an autonomous multi-member sprint whose members are
genuinely independent checkouts rather than one shared workspace), reads and
writes are bracketed with a pull before and a push after so no member's clone
observes stale state for long, and every cross-member push is serialized
through a single coordinating authority -- a Dolt clone can hard-conflict on a
concurrent same-row write, and one unresolved conflict wedges that clone's
sync entirely, so multi-writer coordination is a correctness requirement, not
a performance nicety. See `packages/apra-fleet-se/docs/architecture.md`'s
"Dolt sync discipline" section for the full mechanism and its conflict
recovery ladder.

### Link preservation on conflicted pulls

On the pinned `bd` (1.3.x), a conflicted `bd dolt pull` auto-resolves and
commits only the tables it resolved; cleanly merged tables (notably the
dependency table holding parent-child and `blocks` edges) keep the local copy.
The next push can then silently revert other clones' links. Defences:

- Every engine `bd dolt pull` is bracketed: the pulling clone's in-scope
  parent-child and `blocks` links are read just before and just after it. A
  link present before and missing after (both endpoints still present) is
  owed by that clone and restored before its next push (and, on the backlog
  clone, on the next scope read). A link that disappeared between two reads
  with no pull in between was removed on purpose (an agent retargeting an
  edge, breaking a cycle or reparenting a bead) and is never restored.
- Because `bd` reports a pull conflict only on stderr, a clean pull carrying
  another clone's deliberate removal looks like a lossy one. So before every
  push the engine also reads the pushing clone and records each link it lost
  since its previous read with no pull in between, in a run-wide
  agent-removal record shared by all members. Links the engine removes
  through its own `bd dep remove` / `bd update --parent` go on it too. No
  pull comparison on any clone restores a link on the record; a link comes
  off it when it is deliberately re-added. This costs one `bd list` read per
  push while the sprint scope is known.
- A read can only be compared with an earlier read of the same clone, so
  every clone gets a baseline before an agent edits it. Each fresh scope
  snapshot counts as a read of the backlog clone (its launch pull runs before
  the scope is known, and the first planner's pull is skipped). A dispatch
  that pushes beads, on a clone with no baseline yet (its pull was skipped or
  its pull could not be bracketed), reads that clone once before the agent
  runs. A read that overlaps a pull on the same clone is not used as a
  baseline.
- Before a push publishes a reconcile pull, the engine commits the merged
  working set and runs a link verification (both parent-child and `blocks`
  edges must survive). The same commit and verification run before the
  first push of a member whose pre-dispatch or launch pull merged remote
  changes, even when that push fast-forwards. A failed restore issues no
  push and leaves the member owing a verification before its next first
  push.
- `apra-fleet install` and sprint launch print a warning while the pinned `bd`
  is a version that can drop links. The install-side and engine-side version
  constants are kept in step by a test. Until a fixed `bd` is verified, the
  warning prints on every install and launch.
- Known gap: a removal made on a clone the engine never reads (an operator
  checkout outside the sprint) is not on the agent-removal record, so when a
  sprint member pulls it, the engine restores the link. Re-remove it from a
  sprint member, or make the change before the sprint starts.

### Flattened-remote recovery

If the shared Dolt remote is rebuilt with a flattened history, a clone's pull
and push classify as unrelated-history (checked before diverged). The launch
health gate, member setup and repair automatically re-bootstrap such a clone:
export, read back with a count check, rename the old clone (never delete),
seed config, dry-run bootstrap that must plan a sync, bootstrap, export the
fresh clone and compare. Any failure after the rename restores the original,
and a backup left by a crash is restored first. A clone holding work that is
absent from the remote is refused intact, never overwritten. The comparison
is a full record diff, because the failing pull has already moved the
remote-tracking ref and `bd diff` ignores labels. An unpushed bead or field
change, dependency add, label add or comment add refuses the recovery, and so
does a delete of a bead the remote still holds (a remote-only id the old
clone's own history knew; one read-only `bd --db` probe per such id). The
refusal names the kind of work found. Closed beads the remote pruned before
the rebuild are not local work when their last change is older than the
clone's last sync (the newest record both sides hold identically). A closed
bead changed after that point still refuses. Removing a label, dependency or
comment cannot be told apart from another clone's add, so it is not counted.

Sprint launch also pulls every non-backlog member that already has a beads DB,
through the same health gate and recovery. A diverged clone is settled there
exactly as at its first dispatch pull; only a divergence settle cannot resolve
stops the launch.

---

See [the PM skill](../packages/apra-fleet-se/apra-pm/skills/pm/SKILL.md) for the full PM skill reference.
