# apra-fleet #245 — Uninstall Command — Plan

## Branch
feat/uninstall-command (base: main)

## Phase 1 — Foundation

### Task T1 — Refactor Shared Config
- **Tier:** cheap
- **Files:** src/cli/install.ts, src/cli/config.ts
- **What:** Extract getProviderInstallConfig, readConfig, writeConfig from install.ts into a new config.ts shared utility. **F1:** Extend install-config.json schema from a single `{ llm, skill }` object to a keyed-by-provider map: `{ "providers": { "claude": { "skill": "all" }, "gemini": { "skill": "all" } } }`. Update install.ts to merge (not overwrite) on each install so multiple providers accumulate correctly. This enables `uninstall --skill pm` (no --llm) to iterate all recorded providers.
- **Done:** Shared config functions are imported and used by install.ts without breaking existing logic. install-config.json merges provider entries on successive installs.
- **Blockers:** None

### Task T2 — Scaffold Uninstall Command
- **Tier:** cheap
- **Files:** src/cli/uninstall.ts, src/index.ts
- **What:** Add uninstall.ts handling flags (--llm, --skill, --dry-run, --yes) and reading ~/.apra-fleet/data/install-config.json using the updated multi-provider schema from T1. `uninstall --skill pm` (no --llm) iterates all providers recorded in install-config.json. Register in index.ts dispatcher.
- **Done:** `apra-fleet uninstall --help` works. Command safely executes dry-run logging. All six command variants are handled (full, --llm only, --llm + --skill, --skill only across providers).
- **Blockers:** T1

### VERIFY V1
- Build + test must pass
- Push to origin
- STOP for review

## Phase 2 — Core Uninstall Logic

### Task T3 — Settings Cleanup
- **Tier:** standard
- **Files:** src/cli/uninstall.ts
- **What:** Revert changes in provider settings files. Surgical per-key removal — do not clobber user settings:
  - `mcpServers.apra-fleet` — delete key (Gemini, Codex, Copilot JSON settings)
  - `permissions.allow` — filter out fleet-specific entries, preserve user-added ones
  - `hooks.PostToolUse` — filter out hooks with fleet matchers, preserve user hooks
  - `defaultModel` — only remove if it matches the fleet-installed value (preserve user customization)
  - `statusLine` — delete key
  - **F2 (Claude-specific):** For Claude, MCP unregistration must use the CLI command `claude mcp remove apra-fleet --scope user` — NOT direct settings.json editing. On Windows, spawn with `shell: 'cmd.exe'` (matching install.ts line 321).
- **Done:** Targeted or full removal works in settings files for all providers. Claude MCP is removed via CLI. --dry-run logs correctly. --yes bypasses confirm prompt; interactive confirm shown otherwise.
- **Blockers:** T2

### Task T4 — Skill Directories Removal
- **Tier:** standard
- **Files:** src/cli/uninstall.ts
- **What:** Safely delete fleet and pm skill directories per provided flags. When install-config.json is missing or corrupt, fall back to scanning the four providers' known config dirs from getProviderInstallConfig (warn user before proceeding).
- **Done:** Correct directories are removed. Fallback scan covers all known provider paths. --dry-run logs correctly.
- **Blockers:** T3

### VERIFY V2
- Build + test must pass
- Push to origin
- STOP for review

## Phase 3 — Testing

### Task T5 — Unit Tests
- **Tier:** premium
- **Files:** tests/uninstall.test.ts
- **What:** Full test coverage for uninstall command covering full, targeted, and dry-run flows. Mock fs operations. Cover multi-provider install-config, Claude CLI removal path, fallback scan, and --yes/confirm prompt.
- **Done:** All test cases pass.
- **Blockers:** T4

### VERIFY V3
- Build + test must pass
- Push to origin
- STOP for review

## Risk Register

| # | Risk | Mitigation |
|---|------|------------|
| R1 | **install-config.json missing or corrupt** — uninstall cannot determine what was installed | Fall back to scanning all known provider config paths (getProviderInstallConfig). Warn user and require --yes to proceed. |
| R2 | **Partial installs** — some providers registered, others not | Multi-provider schema tracks each provider independently. Uninstall skips providers with no recorded installation and logs a warning. |
| R3 | **Race with running fleet server** — uninstall removes files while server process holds handles | Detect running server (check pid file / port). Abort with clear error: "Fleet server is running — stop it first (`apra-fleet stop`) then retry uninstall." |
| R4 | **Windows vs macOS path differences** — config dirs, path separators, CLI spawn options differ | All paths use path.join from getProviderInstallConfig. Claude CLI spawn uses `shell: 'cmd.exe'` on Windows (matches install.ts line 321). Tests run on both platforms in CI. |
| R5 | **User-edited settings files** — surgical removal may miss manually-added entries or fail to remove fleet entries that were hand-modified | Log a post-uninstall warning listing any settings keys that could not be cleanly removed. Advise manual review of settings files. |
