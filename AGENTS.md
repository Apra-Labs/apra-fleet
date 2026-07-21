# Apra Fleet - Agent Context

Read `README.md` in this repo for the full tool reference, installation, member registration, multi-provider setup, git authentication, PM skill commands, and troubleshooting.

## Dev commands

```bash
npm install && npm run build   # Build from source
npm test                       # Unit tests (vitest)
npm run build:binary           # Build single-executable binary
node dist/index.js install     # Dev-mode install
```

## Conventions

- Branch naming: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`
- Commit style: `<type>(<scope>): <description>` - e.g. `fix(ssh): handle key rotation timeout`
- Never push to `main` directly; open a PR
- See [Architecture](docs/architecture.md) for internal structure
- ASCII only: never write non-ASCII characters to any file. Use `-` for dashes, `->` for arrows, `[OK]` for checkmarks, etc.

## Permissions (pre-grant rule)

At the start of any task that involves multiple file writes:

1. Call `ask_permission(Action='write_file', Target=<narrowest directory covering all writes>)` ONCE before any file is written.
2. Never call `ask_permission` again for files inside an already-granted directory in the same session.
3. For pm-lite sprints: grant the worktree root immediately after `git worktree add`, before dispatching any subagent.
4. For single-repo work: grant the repo root at task start.
5. Subagents inherit the grant - the orchestrator requests it once on their behalf before spawning them.
6. Never call `ask_permission` for an individual file when its parent directory is already granted.

