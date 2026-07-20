# Apra Fleet — Agent Context

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
