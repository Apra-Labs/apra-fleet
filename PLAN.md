# apra-fleet #245 — Uninstall Command — Plan

## Branch
feat/uninstall-command (base: main)

## Phase 1 — Foundation

### Task T1 — Refactor Shared Config
- **Tier:** cheap
- **Files:** src/cli/install.ts, src/cli/config.ts
- **What:** Extract getProviderInstallConfig, readConfig, writeConfig from install.ts into a new config.ts shared utility.
- **Done:** Shared config functions are imported and used by install.ts without breaking existing logic.
- **Blockers:** None

### Task T2 — Scaffold Uninstall Command
- **Tier:** cheap
- **Files:** src/cli/uninstall.ts, src/index.ts
- **What:** Add uninstall.ts handling flags (--llm, --skill, --dry-run, --yes) and reading ~/.apra-fleet/data/install-config.json. Register in index.ts dispatcher.
- **Done:** `apra-fleet uninstall --help` works. Command safely executes dry-run logging.
- **Blockers:** T1

### VERIFY V1
- Build + test must pass
- Push to origin
- STOP for review

## Phase 2 — Core Uninstall Logic

### Task T3 — Settings Cleanup
- **Tier:** standard
- **Files:** src/cli/uninstall.ts
- **What:** Revert changes in provider settings files (mcpServers.apra-fleet, permissions, defaultModel, hooks, statusLine). Ensure we don't clobber user settings.
- **Done:** Targeted or full removal works in settings files. --dry-run logs correctly.
- **Blockers:** T2

### Task T4 — Skill Directories Removal
- **Tier:** standard
- **Files:** src/cli/uninstall.ts
- **What:** Safely delete fleet and pm skill directories per provided flags. Correct directories are removed. --dry-run logs correctly. Missing install-config falls back to scanning.
- **Done:** Correct directories are removed. --dry-run logs correctly. Missing install-config falls back to scanning.
- **Blockers:** T3

### VERIFY V2
- Build + test must pass
- Push to origin
- STOP for review

## Phase 3 — Testing

### Task T5 — Unit Tests
- **Tier:** premium
- **Files:** tests/uninstall.test.ts
- **What:** Full test coverage for uninstall command covering full, targeted, and dry-run flows. Mock fs operations.
- **Done:** All test cases pass.
- **Blockers:** T4

### VERIFY V3
- Build + test must pass
- Push to origin
- STOP for review
