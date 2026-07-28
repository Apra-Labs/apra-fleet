---
name: fleet-sprint-cli
description: How to launch and supervise apra-fleet's autonomous sprint workflow from the CLI (`apra-fleet workflow fleet-sprint`) -- the --issue/--members/--branch/--base flag contract, the preconditions to check first, how to launch it as a detached process, and how to watch it via its dashboard. Trigger before running `apra-fleet workflow fleet-sprint`.
---

# fleet-sprint

`fleet-sprint` is apra-fleet's autonomous sprint engine. It drives a full
plan -> develop -> review -> deploy -> integ-test -> harvest cycle across one
or more registered fleet members, working a set of beads issues on a branch
and opening a PR at the end.

## The command

```
apra-fleet workflow fleet-sprint \
  --issue <id[,id2,...]> \
  --members <name[,name2,...]> \
  --branch <branch-name> \
  --base <base-branch> \
  [--goal P1|P1/P2|P1/P2/P3]      # default P1/P2
  [--max-cycles N]                # default 5
  [--allow-missing-members]
  [--requirements-file <path>]
  [--role-map <json|@file>]       # {"doer":["m1","m2"], ...}
  [--viewer-port <port>]          # default 8080
  [--budget <usd>]                # default unlimited
  [--dispatch-timeout-s <s>]      # default 3600
  [--sync]                        # synced-topology mode
```

`--issue`, `--members`, `--branch`, and `--base` are required. Verify the
live flag set with `apra-fleet workflow fleet-sprint --help` before relying
on this list -- flags evolve and this skill can drift.

## Flag notes

- `--issue` takes comma-separated **beads parent/epic IDs**. Scope is
  resolved internally via `bd list --parent <id>`, so it only ever
  understands the parent-child hierarchy. A `blocked-by`-only manifest bead
  is invisible to the scope filter no matter what you pass -- only true
  children are picked up. See the epics/manifest-bead guidance in
  `packages/apra-fleet-se/fleet-sprint/docs/README.md`.
- `--branch` is created from `--base` if it does not already exist. If it
  does exist (e.g. you are resuming), it is reused as-is.
- `--role-map` assigns specific members to specific roles, e.g.
  `--role-map '{"doer":["m1","m2"],"reviewer":["m3"]}'`. Accepts inline JSON
  or `@path/to/file.json`.
- `--goal` controls which bead priorities are in scope for the run.
- `--budget` caps total spend in USD; the run aborts when it is exhausted.

## Preconditions to check first

1. Every `--issue` target exists and is open: `bd show <id>`.
2. Every `--members` name is registered with the fleet (`list_members` /
   `mcp__apra-fleet__list_members`). An unregistered member aborts the
   sprint unless `--allow-missing-members` is passed.
3. Multi-member sprints require all members to share the same git topology
   unless `--sync` is passed. Stick to single-member unless that is
   verified -- see `fleet-sprint-diagram.md` in the package docs.
4. If a member's LLM session is stale or unauthenticated (dispatch fails
   with `empty_response`, or "member CLI likely died"), re-run
   `provision_llm_auth` for that member before retrying.

## Launching it

Run this on your own orchestrating machine, not on a `--members` target --
members are dispatch destinations, not where this command runs.

Use the delivered `apra-fleet` binary (on PATH after `npm run build:binary`),
and start it as a genuinely detached OS process. A harness-owned background
task can be silently killed when its owning tool call's process group ends,
which orphans the sprint mid-run.

Windows:

```powershell
Start-Process -FilePath "apra-fleet" -ArgumentList "workflow","fleet-sprint", `
  "--issue","<id>","--members","<name>","--branch","<branch>","--base","<base>" `
  -RedirectStandardOutput "<log>.log" -RedirectStandardError "<log>.err.log" `
  -WindowStyle Hidden -PassThru
```

POSIX:

```bash
nohup apra-fleet workflow fleet-sprint \
  --issue <id> --members <name> --branch <branch> --base <base> \
  > sprint.log 2>&1 &
disown
```

From a source checkout you can run the same engine directly with
`node packages/apra-fleet-se/bin/cli.mjs <same flags>`. That form runs the
working tree instead of the installed copy -- use it when developing the
engine itself, and the packaged binary otherwise.

## Watching it

On start, the run prints a dashboard URL (`http://localhost:<viewer-port>`,
default port 8080). Watch progress there rather than tailing raw stdout --
the dashboard shows per-role activity, the bead DAG, live cost, and the
final verdict and PR link.
