<!-- llm-context: Reference for how Apra Fleet uses Beads, the bundled open-source issue tracker. Consult when a user asks about bd commands, task tracking, sprint epics, backlog management, or the PM skill's persistent task state. -->
<!-- keywords: Beads, bd, task, epic, sprint, backlog, pm, lifecycle, dependency, issue tracker, bd ready, bd create, bd close -->
<!-- see-also: ../README.md (PM skill overview), ../skills/pm/SKILL.md (PM skill reference), ../skills/pm/beads.md (internal PM Beads rules) -->

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

---

See [skills/pm/SKILL.md](../skills/pm/SKILL.md) for the full PM skill reference.
