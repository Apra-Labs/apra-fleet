# Apra Fleet — MCP Server + PM Skill

## What This Repo Is
MCP server (`src/`) managing a fleet of remote/local Claude Code members via SSH. Ships with a PM skill (`skills/pm/`) that orchestrates multi-step work across members.

## Key Paths
- `src/` — MCP server source (TypeScript)
- `skills/pm/` — PM skill (`SKILL.md` + supporting docs + templates)
- `docs/` — server documentation and design docs
- `tests/` — unit + integration tests
- `hooks/` — post-registration hook
- `scripts/` — statusline, SEA build pipeline

## Terminology
- **member** = registered machine in the fleet
- **agent** = Claude Code session running on a member (internal code type)
- See `docs/vocabulary.md` for full definitions

## Fleet MCP Essentials
- **Fleet operations** run as background subagents (`run_in_background: true`)
- **Never two concurrent ops on the same member** — one member, one task at a time
- **3-file pattern**: CLAUDE.md + PLAN.md + progress.json pushed to member's work_folder
- **planned.json** (pm's immutable copy) vs **progress.json** (member's living state)
- **Dev vs deploy**: code committed != code deployed. Pull → install → build → restart.
- **Verify checkpoints**: member stops, pm reviews, resumes. Never skip.

## Development Gotchas
- **After `npm run build`**: call `shutdown_server` → user runs `/mcp` → confirm before live testing. The running process serves old code until restarted.
- **Claude CLI invocations**: `getClaudeCommand(os, args)` in `src/utils/platform.ts` is the single source of truth.
- **ssh2 streams**: require `stream.end()` after exec to close stdin (prevents `claude -p` from hanging).
- **Auth validation**: always use `claude -p "hello"` not `claude auth status` (the latter doesn't validate API keys).
