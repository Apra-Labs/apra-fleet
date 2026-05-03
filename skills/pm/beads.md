# Beads — Persistent Task DB for PM

Beads (`bd`) is installed automatically by `apra-fleet install`. It gives PM a persistent, dependency-aware task database that survives across sessions, branches, and team members — solving the core weakness of file-only sprint tracking.

**PM uses `bd` via `Bash` directly — never via `execute_command` on a member.** `bd` runs on the orchestrator.

---

## Why Beads

| Problem (file-only) | Solution (Beads) |
|---|---|
| Session restart requires `/pm recover` | `bd ready` instantly shows all open tasks |
| `backlog.md` is a flat unqueryable file | Backlog items are Beads tasks — filterable, prioritizable |
| `progress.json` dies with the branch | Beads persists across all sprints |
| No cross-sprint visibility | One global DB — query any project, any state |
| Review findings lose history | Each finding is a task with full audit trail |
| Dependencies implicit in prose | `bd dep add` makes them machine-checkable |

---

## Essential Commands

```bash
bd init                          # init Beads in current dir (once per repo)
bd ready                         # show all unblocked, unclaimed tasks
bd create "title" -p <n>         # create task (priority: 0=critical, 1=high, 2=med, 3=low)
bd update <id> --claim           # mark in-progress (dispatch)
bd update <id> --done            # mark complete (verify/approval)
bd dep add <child-id> <parent-id># express dependency (child blocked until parent done)
bd show <id>                     # full task details
bd show <id> --tree              # task + all dependencies
```

---

## Lifecycle Hooks

PM calls `bd` at these points in every sprint:

### `/pm init`
```bash
cd <repo>
bd init                          # idempotent — safe to re-run
bd create "sprint: <project>" -p 1   # → epic-id (record in status.md)
```

### `/pm plan` — after PLAN.md is approved
For each task in PLAN.md:
```bash
bd create "T1.1: <title>" -p 1 --parent <epic-id>    # → task-id
bd create "T1.2: <title>" -p 2 --parent <epic-id>    # → task-id
bd dep add <T1.2-id> <T1.1-id>   # 1.2 blocked until 1.1 done
```
Record all task IDs in `<project>/status.md` under a `## Beads` section.

### `/pm start` — dispatching doer to a task
```bash
bd update <task-id> --claim
```

### VERIFY checkpoint reached (doer stops)
```bash
bd update <verify-task-id> --done   # close the verify task
bd ready                             # confirm what's next
```

### Reviewer returns CHANGES NEEDED — each HIGH finding
```bash
bd create "fix: <finding title>" -p 0 --parent <epic-id>   # → finding-id
```
When doer fixes it and reviewer approves: `bd update <finding-id> --done`

### `/pm cleanup` — sprint complete
```bash
bd update <epic-id> --done
```

---

## `/pm backlog` — query deferred items

When user says "add to backlog" or "defer this":
```bash
bd create "<description>" -p 3 --parent <epic-id>   # low priority
```

When user says "show backlog" or "what's deferred":
```bash
bd ready --all   # or bd show <epic-id> --tree to see all items
```

---

## `/pm tasks` — sprint task view

Show current sprint's Beads state at any time:
```bash
bd show <epic-id> --tree
bd ready
```

---

## `/pm status` — session-start orientation

At the start of every PM session, before reading any file:
```bash
bd ready
```
This shows all unblocked tasks across ALL sprints. PM uses this to know what's in flight before opening any `status.md`.

---

## Innovative Use Patterns

### Cross-sprint dependency
When sprint B can't start until sprint A's PR merges:
```bash
bd dep add <sprint-B-epic-id> <sprint-A-epic-id>
```
`bd ready` won't surface sprint B tasks until sprint A closes.

### Reviewer findings as tasks
Every HIGH finding from code review becomes a tracked task. PM never loses a finding — it either gets fixed (done) or deferred (low priority backlog task). Full audit trail in `bd show`.

### Backlog grooming
```bash
bd ready --all   # PM presents all open low-priority tasks to user for re-prioritization or close
```

### Recovery without `/pm recover`
Session crash? Just run `bd ready`. PM sees exactly what's in-flight across every active project without reading a single file. Then `bd show <task-id>` for full context on any item.

### PR linking
At cleanup, PM adds the PR URL to the epic:
```bash
bd update <epic-id> --note "PR: https://github.com/Apra-Labs/apra-fleet/pull/N"
```

---

## Status.md Beads Section

Add this block to `<project>/status.md` after init:

```markdown
## Beads
- **Epic:** `<epic-id>` — sprint: <project>
- Tasks:
  - `<task-id>` T1.1: <title>
  - `<task-id>` T1.2: <title>
  - ...
```

Update task status inline as tasks move through the lifecycle.
