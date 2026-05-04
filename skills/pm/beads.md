# Beads — Persistent Task DB for PM

Beads (`bd`) is installed automatically by `apra-fleet install`. It gives PM a persistent, dependency-aware task database that survives across sessions, branches, and team members — solving the core weakness of file-only sprint tracking.

**PM uses `bd` via `Bash` directly — never via `execute_command` on a member.** `bd` runs on the orchestrator.

---

## Rules

**Terse, enforced. No exceptions.**

| Rule | Command |
|------|---------|
| **Check before create epic** — never duplicate | `bd search "sprint: <project>" --status all --json` → use existing ID if found |
| **Check before create task** — never duplicate | `bd search "<task title>" --status all --json` → skip if found under epic |
| **Check before dispatch** — never steal a claimed task | `bd show <task-id> --json \| jq -r .status` → dispatch only if `"open"` |
| **`bd init`** — idempotent, always safe to re-run | — |
| **`bd close`** — idempotent, safe to repeat | — |
| **`bd update --status in_progress`** — NOT protected; last write wins | Always check status first |
| **Premature close** — reopen with | `bd reopen <id>` |
| **Lost epic-id** | `bd search "sprint: <project>" --status all --json \| jq -r '.[0].id'` |
| **Lost task-id** | `bd search "<task title>" --status all --json \| jq -r '.[0].id'` |
| **`blocked` status** | Explicitly set only — dep-blocked issues remain `open` in `bd list --status blocked` |

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
bd init                               # init Beads in current dir (once per repo, idempotent)
bd ready                              # show PM dispatch state — open tasks with no blockers
bd create "title" -p <n>              # create task (priority: 0=critical 1=high 2=med 3=low)
bd update <id> --status in_progress   # mark in-progress on dispatch
bd close <id>                         # mark complete (idempotent)
bd reopen <id>                        # reopen a closed task (e.g. CI fails post-cleanup)
bd note <id> "text"                   # append note (PR URL, finding, blocker)
bd dep add <child-id> <parent-id>     # child blocked until parent is done
bd list --all --pretty                # full tree: all tasks, all statuses
bd search "text" --status all --json  # find by title — use for dedup before create
```

---

## Lifecycle Hooks

PM calls `bd` at these points in every sprint:

### `/pm init`
```bash
cd <repo>
bd init   # idempotent

# Check before create — avoid duplicate epics
EXISTING=$(bd search "sprint: <project>" --status all --json | jq -r '.[0].id // empty')
if [ -n "$EXISTING" ]; then
  EPIC_ID=$EXISTING   # reuse existing epic
else
  EPIC_ID=$(bd create "sprint: <project>" -p 1 --json | jq -r .id)
fi
# Record EPIC_ID in <project>/status.md
```

### `/pm plan` — after PLAN.md is approved
For each task in PLAN.md, assign to the member who will do it:
```bash
bd create "T1.1: <title>" -p 1 --parent <epic-id> --assignee <member>   # → task-id
bd create "T1.2: <title>" -p 2 --parent <epic-id> --assignee <member>   # → task-id
bd dep add <T1.2-id> <T1.1-id>   # T1.2 blocked until T1.1 done
```
Record all task IDs in `<project>/status.md` under a `## Beads` section.

### `/pm start` — dispatching a member to a task
```bash
# Check before dispatch — never steal a claimed task
STATUS=$(bd show <task-id> --json | jq -r .status)
if [ "$STATUS" = "open" ]; then
  bd update <task-id> --status in_progress --assignee <member>
else
  echo "Task already $STATUS — skip or escalate"
fi
```

### VERIFY checkpoint reached (member stops)
```bash
bd close <task-id>   # mark complete
bd ready             # confirm what's next
```

### Reviewer returns CHANGES NEEDED — each HIGH finding
```bash
bd create "fix: <finding title>" -p 0 --parent <epic-id> --assignee <doer>   # → finding-id
```
When doer fixes it and reviewer approves: `bd close <finding-id>`

### `/pm cleanup` — sprint complete
```bash
bd close <epic-id>
bd note <epic-id> "PR: <url>"   # link PR to epic
# If CI fails post-cleanup and another fix cycle is needed:
# bd reopen <epic-id>
```

---

## `/pm backlog` — query deferred items

When user says "add to backlog" or "defer this":
```bash
bd create "<description>" -p 3 --parent <epic-id>   # low priority
```

When user says "show backlog" or "what's deferred":
```bash
bd list --all --pretty   # full tree view including backlog
```

---

## `/pm tasks` — sprint task view

Show current sprint's Beads state at any time:
```bash
bd list --all --pretty   # full tree: all members, all tasks, status at a glance
bd ready                 # what's claimable right now (no blockers)
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

### Multi-member tracking (10+ members)

Each task is assigned to a member at creation time. PM gets a per-member view or a global view instantly:

```bash
# Global view — all members, all tasks, tree format
bd list --all --pretty

# Per-member view — what is alice working on?
bd list --assignee alice --status open,in_progress

# What's blocked across all members?
bd list --status blocked

# What's ready to pick up (no blockers, any member)?
bd ready

# What's in-progress right now (who is busy)?
bd list --status in_progress
```

PM dispatches: `bd update <task-id> --status in_progress --assignee <member>`  
Member completes: `bd close <task-id>`  
`bd ready` immediately shows what that member can pick up next.

This replaces the need to read `progress.json` on each member — one `bd list --all --pretty` gives the full picture across every member in the fleet.

### Cross-sprint dependency
When sprint B can't start until sprint A's PR merges:
```bash
bd dep add <sprint-B-epic-id> <sprint-A-epic-id>
```
`bd ready` won't surface sprint B tasks until sprint A closes.

### Reviewer findings as tasks
Every HIGH finding from code review becomes a tracked task assigned back to the doer. PM never loses a finding — it either gets fixed (`bd close`) or deferred (low-priority backlog task). Full audit trail in `bd show`.

### Backlog grooming
```bash
bd list --all --pretty   # PM presents full tree to user for re-prioritization or close
```

### Recovery without `/pm recover`
Session crash? Just run `bd list --all --pretty`. PM sees every member's state across every active project without reading a single file. Then `bd show <task-id>` for full context on any item.

### PR linking
At cleanup, PM adds the PR URL to the epic:
```bash
bd note <epic-id> "PR: https://github.com/Apra-Labs/apra-fleet/pull/N"
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
