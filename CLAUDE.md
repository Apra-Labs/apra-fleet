# Apra Fleet — Claude Code Context

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
- Commit style: `<type>(<scope>): <description>` — e.g. `fix(ssh): handle key rotation timeout`
- Never push to `main` directly; open a PR
- See [Architecture](docs/architecture.md) for internal structure
