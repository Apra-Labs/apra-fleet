# Apra Fleet — MCP Server + PM Skill

## What This Repo Is
An MCP server (`src/`) that manages a fleet of remote/local Claude Code agents via SSH. Ships with a pm skill (`skills/pm/`) that orchestrates long-running work across those agents.

## Current Focus: PM Skill Rewrite
We are rewriting `skills/pm/SKILL.md` using the reviewed materials in `materials/index.md`. That index tracks only files that have been reviewed and confirmed useful — start there.

## Key Paths
- `skills/pm/SKILL.md` — the skill being rewritten (the baseline)
- `materials/index.md` — reviewed materials driving the rewrite
- `materials/progress.md` — prioritized improvement list with status tracking (pending → proposed → drafted → done)
- `materials/change-proposals.md` — concrete proposals (P1, P2, ...) that feed the rewrite
- `materials/improvements-needed.md` — full analysis of all gaps (B1-B10, K1-K5, A1-A10, etc.)
- `materials/` — collected reference files (templates, real examples, friction analysis, learnings)
- `src/` — MCP server source (TypeScript, do not modify during skill work)
- `docs/` — server documentation

## Fleet MCP Essentials (retain for context)
- **Fleet operations** always run as background subagents (`run_in_background: true`)
- **Never two concurrent ops on the same agent** — one agent, one task at a time
- **3-file pattern**: CLAUDE.md + PLAN.md + progress.json pushed to agent's work_folder
- **planned.json** (pm's immutable copy) vs **progress.json** (agent's living state)
- **Dev vs deploy**: code committed != code deployed. Pull → install → build → restart.
- **Verify checkpoints**: agent stops, pm reviews, resumes. Never skip.
