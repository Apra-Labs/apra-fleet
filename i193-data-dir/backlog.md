# i193-data-dir — Backlog

## Deferred Items

- **BL-1** `workspace.ts` re-declares `APRA_BASE`, `WORKSPACES_DIR`, `WORKSPACES_INDEX` locally instead of importing from `paths.ts` — DRY violation (MEDIUM)
- **BL-2** No unit tests for `workspace` subcommands (`list` / `add` / `remove` / `use` / `status`) (MEDIUM)
- **BL-3** No test for `--data-dir` + `--instance` precedence/conflict behaviour (LOW)
