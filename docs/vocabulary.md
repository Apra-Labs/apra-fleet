# Fleet Vocabulary (Brainstorming)

Status: evolving. Not yet applied to code or docs.

## The Problem

"Agent" is overloaded:
1. A fleet member (registered machine/folder that does work)
2. A background Claude process the PMO spawns to coordinate

"The agent is running" — which one? This causes real confusion in logs, conversation, and status updates.

## Approach: Names Over Nouns

Most of the time, use the **specific name** and drop the category word entirely:

- "Sent to dev2" — not "sent to worker dev2"
- "review1 passed PR #13" — not "reviewer agent passed"
- "dev1 is on main" — not "the dev1 agent is on main"

Names are unambiguous. Category nouns are noise when the name is present.

## When You Need the Category

For generic references ("list all ___", "register a new ___"), use:

| Term | Meaning |
|------|---------|
| **crew** (or **worker**) | A registered fleet member. The thing that does the work. |
| **subagent** | A background Claude process spawned by the PMO. Ephemeral. |
| **session** | A conversation thread on a crew member. Context persists within it. |
| **fleet** | The collection of all registered crew members. |
| **PMO** | The master Claude instance that orchestrates everything. |

"Crew" fits the fleet metaphor naturally. "List the crew." "Add a new crew member." But the name alone should be the default.

## Rules

1. **Prefer the name**: "dev2 rebased" not "the dev2 agent rebased"
2. **"Subagent" is always "subagent"** — never just "agent" when referring to a background Claude process
3. **"Agent" is banned in PMO conversation** — too ambiguous. Use the name or "crew/worker" for fleet members, "subagent" for Claude processes.
4. **API keeps `agent_id`** — backwards compat in code. User-facing language evolves separately.

## Current Fleet (apra-focus)

```
PMO (orchestrator)
  |
  +-- dev1       (apra-focus, local, sonnet)
  +-- dev2       (apra-focus-dev2, remote, sonnet)
  +-- review1    (apra-focus-review, remote, opus)
  +-- review2    (apra-focus-review2, remote, opus)
```

PMO spawns **subagents** to interact with **crew members**. A subagent is ephemeral (dies after task). A crew member is persistent (registered, has sessions, has state).

## Open Questions

- Is "crew" the right word? Alternatives: worker, hand, unit
- Should fleet tool descriptions say "crew member" instead of "agent"?
- How does this vocabulary extend beyond PMO? (e.g., standalone fleet use without a PMO)
- Does the fleet concept need further layering? (fleet > team > crew member?)
