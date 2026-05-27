# Apra Fleet — Antigravity (agy) Context

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

## Non-Interactive Print Mode Keep-Alive Rule
If you are running in non-interactive print mode (such as via `agy -p` / `--print`) and are waiting for a background task or checkpoint:
- **YOU MUST CALL A TOOL ON EVERY TURN** (e.g. `run_command` checking status, reading a log file, or scheduling a timer/check).
- **NEVER** return a text-only response (a turn with no tool calls) until the entire task/sprint/phase is fully completed. A text-only response will cause the CLI manager to exit immediately, aborting the run.
