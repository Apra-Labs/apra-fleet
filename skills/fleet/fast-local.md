# Fast Local Workers

The default path. A worker on this machine costs four steps and no credentials.
Use it whenever the fan-out test in `autonomy.md` says to split work.

`onboarding.md` describes the eight-step sequence for **remote** members. Most of
those steps exist to move credentials onto another machine. A local member needs
none of them: it inherits this machine's LLM auth and git credentials directly.

## The four steps

**1. Isolate the work folder.**

```bash
git worktree add .claude/worktrees/<name> -b <type>/<topic>
```

One worktree per worker, always. Two workers sharing a folder will overwrite each
other's edits. Branch names follow the repo convention (`feat/`, `fix/`, `chore/`).

**2. Register.**

```
register_member
  friendly_name: "<name>"
  member_type:   "local"
  work_folder:   "<absolute path to the worktree>"
  tags:          ["auto", "doer"]
  unattended:    "auto"
```

The `auto` tag marks this worker for cleanup later. `unattended: "auto"` lets it
work without stopping for approvals, scoped to the permissions composed in step 3.
Prefer it over `"dangerous"`, which bypasses the allow list entirely.

**3. Compose permissions.**

```
compose_permissions
  member_name:    "<name>"
  tags:           ["doer"]
  project_folder: "<the repo root>"
```

Always before the first dispatch. The config file has to be on disk before the
provider CLI starts, and the server detects the project stack automatically.

**4. Ignore fleet scratch files.**

```bash
echo '.fleet-task.md' >> <worktree>/.gitignore
```

Ephemeral prompt-delivery files. They must never be committed.

## What is deliberately skipped, and why

| Step in `onboarding.md` | Skipped locally because |
|---|---|
| 1 - SSH key auth | No SSH. The member is this machine. |
| 1.5 - Verify CLI install | The CLI is already running as the orchestrator. |
| 1.7 - Provision LLM auth | Inherited from this machine. |
| 2 - Disable AI attribution | Already configured in the user's own settings. |
| 3 - Detect VCS provider | Same repo, same remote, already known. |
| 5 - VCS auth | Inherited from the user's native git credentials. |
| 6 - Install skills | Same machine, same `~/.claude/skills`. |

Steps 4 (roles) and 8 (status file) collapse into the `tags` passed at
registration. Step 7 becomes step 4 above.

## Reaping

When the work is merged, remove every worker created this way:

```
list_members  tags: ["auto"]      -> for each: remove_member
git worktree remove <path>
```

Do this without asking - the user did not ask for these workers to exist, so they
should not have to ask for them to go away. Members the user registered by hand
are never swept; only the `auto` tag is.
