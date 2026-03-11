# Fleet Vocabulary

## The Problem

"Agent" is overloaded:
1. A fleet member (registered machine/folder that does work)
2. A background Claude process the PM spawns to coordinate

"The agent is running" — which one? This causes real confusion in logs, conversation, and status updates.

## Approach: Names Over Nouns

Most of the time, use the **specific name** and drop the category word entirely:

- "Sent to dev2" — not "sent to member dev2"
- "review1 passed PR #13" — not "reviewer member passed"
- "dev1 is on main" — not "the dev1 member is on main"

Names are unambiguous. Category nouns are noise when the name is present.

## When You Need the Category

For generic references ("list all ___", "register a new ___"), use:

| Term | Meaning |
|------|---------|
| **member** (or **worker**) | A registered fleet member. The thing that does the work. |
| **subagent** | A background Claude process spawned by the PM. Ephemeral. |
| **session** | A conversation thread on a member. Context persists within it. |
| **fleet** | The collection of all registered members. |
| **PM** | The Project Manager — the master Claude instance that orchestrates everything. |

## Rules

1. **Prefer the name**: "dev2 rebased" not "the dev2 member rebased"
2. **"Subagent" is always "subagent"** — never just "agent" when referring to a background Claude process
3. **"Agent" is banned in PM conversation** — too ambiguous. Use the name or "member/worker" for fleet members, "subagent" for Claude processes.
4. **API keeps `agent_id`** — backwards compat in code. User-facing language evolves separately.

## Example Fleet

```
PM (orchestrator)
  |
  +-- dev1       (apra-focus, local, sonnet)
  +-- dev2       (apra-focus-dev2, remote, sonnet)
  +-- review1    (apra-focus-review, remote, opus)
  +-- review2    (apra-focus-review2, remote, opus)
```

PM spawns **subagents** to interact with **members**. A subagent is ephemeral (dies after task). A member is persistent (registered, has sessions, has state).
