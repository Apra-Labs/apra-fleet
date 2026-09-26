---
name: auto-sprint-args
description: How to construct and pass correct arguments to the auto-sprint workflow -- the required issues+branch fields, optional goal/max_cycles/base_branch/requirementsFile, JSON-object (not string) shape, and common launch mistakes. Trigger when preparing to launch or invoke auto-sprint.
---

# auto-sprint argument contract

Auto-sprint hard-fails on malformed args (`validateSprintArgs` runs first, before any work).
Get the shape right before launching.

## Fields

| Field | Required | Type | Default | Notes |
|-------|----------|------|---------|-------|
| `issues` | **yes** | array of strings | -- | Beads issue IDs (sprint roots), e.g. `["BD-1","BD-2"]`. Must be non-empty; every entry a non-empty string. |
| `branch` | **yes** | string | -- | Sprint branch name, e.g. `"feat/auth"`. Created from `origin/<base_branch>` if it does not exist. |
| `goal` | no | string | `"P1/P2"` | Exit when no open issues at or above this priority. Must be exactly `"P1"`, `"P1/P2"`, or `"P1/P2/P3"`. |
| `max_cycles` | no | positive integer | `5` | Hard cycle ceiling. |
| `base_branch` | no | string | `"main"` | PR target branch. |
| `requirementsFile` | no | string | none | Path to an additional context file for the planner. |
| `skip_dolt_push` | no | boolean | `false` | When `true`, skip the Harvest `bd dolt push` step so the sprint never writes to a real Dolt remote. Set this in CI/e2e runs. |

Do not invent other fields -- these seven are the whole contract.

## Args must be a JSON OBJECT, not a JSON-encoded string

RIGHT -- pass the object itself as the args value:

```json
{ "issues": ["APM-12"], "branch": "feat/x" }
```

Full example:

```json
{
  "issues": ["BD-1", "BD-2"],
  "branch": "feat/auth",
  "goal": "P1/P2",
  "max_cycles": 5,
  "base_branch": "main",
  "requirementsFile": "docs/auth-requirements.md",
  "skip_dolt_push": false
}
```

WRONG -- a JSON string containing escaped JSON:

```
"{\"issues\":[\"APM-12\"],\"branch\":\"feat/x\"}"
```

Also wrong: `{ "issues": "APM-12" }` (issues must be an array), `{ "issue": [...] }`
(field is `issues`), `{ "goal": "P2" }` (not an accepted goal value).

## Tolerant fallback forms (accepted, but don't rely on them)

The parser normalizes these to `{ issues: [...] }`:

- `BD-1` -- bare issue ID
- `BD-1 BD-2` or `BD-1,BD-2` -- space/comma-separated IDs
- `["BD-1","BD-2"]` -- JSON array

In these forms `branch` falls back to the current git branch -- an easy way to
accidentally sprint on the wrong branch. **Always use the full object form** with an
explicit `branch`.

## Pre-launch checklist (mirrors the preflight gate)

1. **Issues exist and are open** -- `bd show <id>` for each root; a missing root hard-fails preflight.
2. **Ready leaf work exists** -- at least some leaves under the roots are unblocked (`bd ready`); an all-blocked backlog deadlocks and aborts.
3. **Branch name chosen** -- explicit `branch`, created if absent.
4. **`base_branch` is the intended PR target** (default `main`).
5. **Branching off latest main** -- the workflow fetches and cuts new branches from `origin/<base_branch>`; if fetch fails, launch fails. Make sure the remote is reachable.

## Common failures and the exact error you'll see

| Mistake | Error emitted |
|---------|---------------|
| Args passed as escaped-JSON string or wrong shape | `invalid args: issues` -- `"issues" must be a non-empty array of beads IDs. Expected a JSON OBJECT, e.g. {"issues":["BD-7"],"branch":"feat/x"}. Received: <your raw args>` |
| No issues at all | `invalid args: issues` -- `"issues" must be a non-empty array of beads IDs` |
| Non-string entries in `issues` | `invalid args: issues entries` |
| Bad `goal` / `max_cycles` / `branch` / `base_branch` value | `invalid args: <field>` with the expected type/values |
| Root issue doesn't exist | `preflight: root <id> not found` |
| All roots already closed | Clean exit: `all sprint roots already closed` (not an error) |
| Open issues but every leaf blocked | `deadlock: open issues but none ready` -- with a per-leaf `blocked_by` diagnostic |
| `git fetch` fails (stale main risk) | `preflight: git fetch failed -- cannot guarantee branch is off latest <base_branch>` |
| Another run live on the same branch | `preflight: another auto-sprint run appears active on <branch> (state age <n>s < TTL)` |
