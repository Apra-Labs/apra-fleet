# Beads — Persistent Task DB for Fleet Users

Beads (`bd`) is a lightweight, dependency-aware task database installed automatically by `apra-fleet install`.

**`bd` runs on the orchestrator via `Bash` — never expose `bd` commands to the user and never run `bd` via `execute_command` on a member.**

---

## Quick Reference

```bash
bd ready                              # show all unblocked open tasks
bd create "title" -p <n>              # create task (priority: 0=critical .. 4=trivial, 2=default)
bd update <id> --assignee <member>    # assign to a member
bd close <id>                         # mark complete (idempotent)
bd reopen <id>                        # reopen a closed task
bd note <id> "text"                   # append a note (e.g. PR URL, blocker reason)
bd dep add <blocked-id> <blocker-id>  # blocked-id cannot start until blocker-id is done
                                       # (unrelated to --parent below -- that's epic/task
                                       # nesting, this is a scheduling dependency)
bd show <id>                          # full task details
bd list --all --pretty                # full tree: all tasks, all statuses
bd list --assignee <member>           # tasks for a specific member
bd search "text" --status all --json  # find existing issues by title (use for dedup)
```

**Never run `bd init` on a repo that already has a `.beads/` directory** — it pulls from
remote and recreates the database, discarding local issue state. It is NOT idempotent.
Only run it once, on a repo with no `.beads/` yet. For a fresh clone or recovering a
missing/corrupt DB, prefer `bd bootstrap` (non-destructive) over `bd init`.

---

## When to Use Beads

| Scenario | What to do |
|----------|-----------|
| Tracking work across multiple fleet sessions | `bd create` a task per work item; `bd update --assignee <member> --status in_progress` on dispatch |
| Expressing dependencies between tasks | `bd dep add <blocked-id> <blocker-id>` |
| Session restart — instant orientation | `bd ready` — shows all in-flight tasks without reading files |
| Linking a PR to a task | `bd note <id> "PR: <url>"` |

---

## Task Priorities

| Priority | Meaning |
|----------|---------|
| `0` | Critical — must fix now |
| `1` | High — next up |
| `2` | Medium — current sprint (default if `-p` omitted) |
| `3` | Low — backlog / deferred |
| `4` | Trivial |

---

## Typical Fleet-User Workflow

```bash
# Start: init Beads in the repo (ONCE -- skip if .beads/ already exists; see warning above)
bd init

# Create a top-level epic for your current effort
bd create "feat: add SFTP transport" -p 1    # → epic-id

# Break it into tasks
bd create "T1: implement connection" -p 1 --parent <epic-id>   # → t1-id
bd create "T2: add retry logic" -p 2 --parent <epic-id>        # → t2-id
bd dep add <t2-id> <t1-id>    # T2 blocked until T1 is done

# Dispatch a member to T1
bd update <t1-id> --assignee <member> --status in_progress

# After T1 is complete
bd close <t1-id>
bd ready    # confirms T2 is now unblocked

# At completion — link PR
bd close <epic-id>
bd note <epic-id> "PR: https://github.com/org/repo/pull/42"
```

---

## Session Recovery

After any interruption, `bd ready` is the first command to run:

```bash
bd ready    # shows everything in-flight across ALL epics
```

It shows:
- What's in-progress
- What's unblocked and ready to start
- What's blocked and why

