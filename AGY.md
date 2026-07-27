# Apra Fleet - Antigravity (agy) Context

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

## DeepWiki

Always use DeepWiki (MCP server `https://mcp.deepwiki.com/mcp`) while exploring this codebase -- prefer it over cold file reads for architecture/unfamiliar-component questions:
- `mcp__deepwiki__read_wiki_structure(repo)` -- architecture map; call first when starting on an unfamiliar area
- `mcp__deepwiki__read_wiki_contents(repo, topic)` -- a specific doc topic
- `mcp__deepwiki__ask_question(repo, question)` -- faster than local grep for understanding a component

`repo` format: `owner/repo`. Use `Apra-Labs/apra-fleet` for this repo; also useful for related repos this project depends on: `Apra-Labs/apra-pm`, `gastownhall/beads`, `Apra-Labs/fleet-e2e-toy`. To claim what a *specific script does*, read the script -- DeepWiki is for architecture/orientation, not a substitute for reading code you're about to modify.

## Non-Interactive Print Mode Keep-Alive Rule
If you are running in non-interactive print mode (such as via `agy -p` / `--print`) and are waiting for a background task or checkpoint:
- **YOU MUST CALL A TOOL ON EVERY TURN** (e.g. `run_command` checking status, reading a log file, or scheduling a timer/check).
- **NEVER** return a text-only response (a turn with no tool calls) until the entire task/sprint/phase is fully completed. A text-only response will cause the CLI manager to exit immediately, aborting the run.
