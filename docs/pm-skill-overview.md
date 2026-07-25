<!-- llm-context: Deep-dive on the PM skill -- Fleet's reference software-development workflow (doer-reviewer sprints driven by /pm commands). Migrated out of README.md on 2026-07-24 to keep the README landing page short; content unchanged. -->
<!-- keywords: PM skill, /pm, doer, reviewer, beads, sprint, cost accounting, cost.js, auto-sprint -->
<!-- see-also: ../README.md (quickstart), ../skills/pm/SKILL.md (full command reference), beads.md (issue tracker), features/auto-sprint-install.md (cost accounting) -->

# The PM skill

The **PM skill** is Fleet's reference workflow for **software development**
-- it ships today, fully built out. It is one skill on a general
substrate: the same primitives -- members, tasks, git/SSH transport,
doer-reviewer pairing -- coordinate agents for support triage, cost
analysis, ops surveys, or any multi-agent job. PM is the worked example;
the platform is the point.

The Project Manager skill is installed by default and drives structured,
multi-step work: planning with your approval, doer-reviewer loops, verification
checkpoints, and git-synced progress. Task state persists across sessions via
[**Beads**](beads.md), the bundled open-source issue tracker (`bd` CLI, installed alongside Fleet) -- run `bd ready` any time to see
what is in flight.

| Command | Does |
|---------|------|
| `/pm init <project>` | Initialize a project folder and templates. |
| `/pm pair <member> <member>` | Pair a doer with a reviewer. |
| `/pm plan <requirement>` | Draft a plan for your approval. |
| `/pm start <member>` | Begin execution; dispatches doer with plan and task harness. |
| `/pm status <member>` | Check in-flight tasks, progress, and git log. |
| `/pm resume <member>` | Resume after a verification checkpoint. |
| `/pm deploy <member>` | Execute the project deployment runbook. |
| `/pm recover <project>` | Re-orient after a PM restart; reads in-flight tasks and member state. |
| `/pm cleanup <project>` | Finish the sprint, close tasks, and raise a PR. |
| `/pm backlog` | Query and manage deferred items via Beads. |
| `/pm tasks` | Show the current sprint task tree. |
| `/auto-sprint` | Run a fully automated sprint loop with cost accounting. |

See [skills/pm/SKILL.md](../packages/apra-fleet-se/apra-pm/skills/pm/SKILL.md) for the full command reference.

**Cost accounting.** When PM is installed, the installer also writes `cost.js`
to the PM skill directory for every provider. `cost.js` exports the seven pure
cost-computation functions (`computeSprintQuote`, `computeSprintAnalysis`,
`buildSprintSummary`, etc.) extracted from the `auto-sprint.js` workflow. For
Claude, the full `auto-sprint.js` is also copied to `~/.claude/workflows/` and
`Skill(auto-sprint)` / `Workflow(auto-sprint)` are added to the allow-list
automatically. See [features/auto-sprint-install.md](features/auto-sprint-install.md).

Want to build your own skill on top of Fleet? See [writing-skills.md](writing-skills.md).
