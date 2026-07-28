# Apra Fleet - Antigravity (agy) Context

<!-- Generated from CLAUDE.md by `node scripts/sync-agent-docs.mjs` -- do not hand-edit the shared sections below (the tool-specific appendix at the end of this file is exempt). Edit CLAUDE.md and rerun the script. -->

> Beads: run `bd prime` first. DB name (`.beads/metadata.json`) is local/gitignored and can differ per clone -- not a sync requirement. If `bd bootstrap` errors "database exists" on a clean clone, retry with `--database <other-name>`.

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
- Permission blocks must be surfaced, not routed around: if a tool or git invocation is blocked by the permission layer, stop and report the block to the user/orchestrator. Do not author a wrapper script, alternate binary, or other workaround whose purpose is to bypass the block, even if the underlying operation is judged safe. See `scripts/recovery.sh` disposition note in the 2026-07-02 incident writeup (RECOVERY.md) for the precedent this guards against.
- `packages/apra-fleet-client` must always be updated to catch up with any changes to the fleet MCP tools (`src/tools/*` schemas/behavior) in the same change -- it is the thin client wrapper other packages (fleet-sprint, apra-pm, workflows) use to call those tools, and a drifted client silently gives callers a stale or inconsistent view of what the server actually accepts/does. This is not optional cleanup; treat it as part of the tool change itself.

## DeepWiki

Always use DeepWiki (MCP server `https://mcp.deepwiki.com/mcp`) while exploring this codebase -- prefer it over cold file reads for architecture/unfamiliar-component questions:
- `mcp__deepwiki__read_wiki_structure(repo)` -- architecture map; call first when starting on an unfamiliar area
- `mcp__deepwiki__read_wiki_contents(repo, topic)` -- a specific doc topic
- `mcp__deepwiki__ask_question(repo, question)` -- faster than local grep for understanding a component

`repo` format: `owner/repo`. Use `Apra-Labs/apra-fleet` for this repo; also useful for related repos this project depends on: `Apra-Labs/apra-pm`, `gastownhall/beads`, `Apra-Labs/fleet-e2e-toy`. To claim what a *specific script does*, read the script -- DeepWiki is for architecture/orientation, not a substitute for reading code you're about to modify.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking - do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge - do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

## Non-Interactive Print Mode Keep-Alive Rule
If you are running in non-interactive print mode (such as via `agy -p` / `--print`) and are waiting for a background task or checkpoint:
- **YOU MUST CALL A TOOL ON EVERY TURN** (e.g. `run_command` checking status, reading a log file, or scheduling a timer/check).
- **NEVER** return a text-only response (a turn with no tool calls) until the entire task/sprint/phase is fully completed. A text-only response will cause the CLI manager to exit immediately, aborting the run.
