# i193-data-dir — Implementation Plan
> Per-instance data directory isolation: --data-dir / --instance install flags + workspace subcommand

---
## Tasks

### Phase 1: Core Install Flags

#### Task 1.1: Add --data-dir flag to install command
- **Change:** Parse `--data-dir <path>` (both `--data-dir=<path>` and `--data-dir <path>` forms); resolve `~` to `$HOME`. When set, populate `envVars = { APRA_FLEET_DATA_DIR: dataDir }` and pass it through to every provider-specific MCP registration function (`claude mcp add -e`, `mergeGeminiConfig`, `mergeCodexConfig`, `mergeCopilotConfig`). Install output banner shows `Data Dir:` line when flag is present.
- **Files:** src/cli/install.ts
- **Tier:** standard
- **Done when:** install --data-dir <path> writes APRA_FLEET_DATA_DIR to MCP env config

#### Task 1.2: Add --instance flag to install command
- **Change:** Parse `--instance <name>` (validates `/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/`). Expands to `dataDir = ~/.apra-fleet/workspaces/<name>` if `--data-dir` is not also provided. Sets `serverName = apra-fleet-<name>` so the MCP server is registered under a unique name. After MCP registration, updates `~/.apra-fleet/workspaces.json` index with `{name, path, created}`. Creates the data directory on disk.
- **Files:** src/cli/install.ts
- **Tier:** standard
- **Done when:** install --instance <name> registers as apra-fleet-<name> with isolated data dir

#### Task 1.3: Wire paths.ts for data dir resolution
- **Change:** `FLEET_DIR` now resolves via `process.env.APRA_FLEET_DATA_DIR ?? path.join(homedir(), '.apra-fleet', 'data')` so the running server always honours the env var set by the MCP registration. Also added `APRA_BASE`, `WORKSPACES_DIR`, and `WORKSPACES_INDEX` exports used by workspace.ts.
- **Files:** src/paths.ts
- **Tier:** cheap
- **Done when:** FLEET_DIR resolves correctly from env var

#### VERIFY: Phase 1
- Run full test suite
- Confirm install flags work end to end

---
### Phase 2: Workspace Subcommand

#### Task 2.1: Implement workspace CLI
- **Change:** New `src/cli/workspace.ts` with five subcommands:
  - `list` — tabular display of all workspaces (default + named) with member count and active indicator
  - `add <name> [--install]` — creates `~/.apra-fleet/workspaces/<name>`, registers in workspaces.json, optionally chains `apra-fleet install --instance <name>`
  - `remove <name> [--force]` — removes from index (refuses if members registered unless `--force`); data dir preserved
  - `use <name>` — prints `export APRA_FLEET_DATA_DIR=<path>` for shell activation
  - `status [<name>]` — shows path existence, member count, statusline age, salt presence, and active state
  
  `src/index.ts` gains a `workspace` dispatch branch (alongside `install` and `auth`) that dynamically imports and calls `runWorkspace`.
- **Files:** src/cli/workspace.ts, src/index.ts
- **Tier:** standard
- **Done when:** `apra-fleet workspace` lists/switches instances

#### VERIFY: Phase 2
- Run full test suite
- Confirm workspace subcommand works

---
### Phase 3: Tests & Documentation

#### Task 3.1: Unit tests for --data-dir, --instance, workspace
- **Change:** New `tests/install-data-dir.test.ts` covering `runInstall` with mocked `node:fs` and `node:child_process`. Tests verify that `--data-dir` injects `APRA_FLEET_DATA_DIR` into the Claude MCP add command, that `--instance <name>` derives the correct data dir and server name `apra-fleet-<name>`, that the workspaces index is written, and that invalid instance names are rejected.
- **Files:** tests/install-data-dir.test.ts
- **Tier:** standard
- **Done when:** all new tests pass

#### Task 3.2: Documentation
- **Change:** Update README and/or fleet skill with multi-instance setup guide
- **Files:** README.md, skills/fleet/SKILL.md
- **Tier:** cheap
- **Done when:** multi-instance setup documented, salt isolation noted

#### VERIFY: Phase 3
- Full test suite passes
- Docs accurate

---
## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Salt isolation confusion | Med | Document explicitly — credentials in one instance unreadable by another |
| Default behaviour regression | High | No-flag install path unchanged; tested |

## Notes
- Base branch: main
- Branch: feat/per-instance-data-dir
