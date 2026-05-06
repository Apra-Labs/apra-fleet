# Uninstall Command (#245) — V6 Final Re-Review

**Reviewer:** fleet-rev (claude-opus-4-6)
**Date:** 2026-05-05
**Verdict:** APPROVED

---

## Build & Tests

- Build (`tsc`): PASS — no errors
- Tests: 66 files, 1087 passed, 6 skipped, 0 failed. PASS.

---

## 1. File Hygiene — BLOCKING

`git diff --name-only origin/main..feat/uninstall-command` contains files that are not justifiable against sprint #245:

| File | Verdict |
|---|---|
| `src/cli/uninstall.ts` | OK — primary deliverable |
| `src/cli/config.ts` | OK — shared config extraction |
| `src/cli/install.ts` | OK — refactored to use config.ts |
| `src/cli/update.ts` | OK — migrated to new config schema |
| `src/index.ts` | OK — dispatcher registration |
| `tests/uninstall.test.ts` | OK — new tests |
| `tests/install.test.ts` | OK — updated for new config schema |
| `tests/update.test.ts` | OK — updated for new config schema |
| `skills/pm/tpl-reviewer.md` | OK — file hygiene rule addition |
| `.gitignore` | OK — excludes provider context files |
| `deploy.md` | OK — `--skill` → `--force` fix |
| `package.json` | OK — version bump |
| `version.json` | OK — version bump |
| `feedback.md` | OK — review artifact |
| **`PLAN.md`** | OK — sprint tracking |
| **`progress.json`** | OK — sprint tracking |
| **`requirements.md`** | OK — sprint tracking |
| `.gemini/policies/fleet.toml` | FLAGGED — deleted; was a tool config, deletion is fine |
| `.gemini/settings.json` | FLAGGED — deleted; was a tool config, deletion is fine |
| **`requirements-98.md`** | **BLOCKED** — stale artifact from a different sprint (#98), should not be tracked |
| **`run_me.bat`** | **BLOCKED** — scratch/temp file, not part of sprint deliverables |
| **`test.md`** | **BLOCKED** — scratch/temp file |
| **`test.txt`** | **BLOCKED** — scratch/temp file |
| **`update-progress.js`** | **BLOCKED** — scratch utility script, not part of source |

**Action required:** Remove `requirements-98.md`, `run_me.bat`, `test.md`, `test.txt`, and `update-progress.js` from the branch (delete and commit). These are stale/scratch artifacts that should not be merged to main.

---

## 2. Core Logic Review

### 2a. `--skill` scoping — PASS

At `uninstall.ts:201`, the `if (skillMode === 'all')` guard correctly gates both Claude CLI MCP removal and `cleanupSettings()`. When `--skill pm` or `--skill fleet` is passed, only skill directories are removed — settings, MCP, hooks, permissions, statusLine, and defaultModel are untouched. Correct per requirements.

### 2b. `--force` + `--dry-run` — PASS

At `uninstall.ts:161–163`: when both flags are set, the code logs "would be stopped by --force" but does NOT call `killApraFleet()`. When only `--force` (no dry-run) and server is running, it calls `killApraFleet()` and waits 500ms. When neither flag and server is running, it exits with error. All three branches are correct.

### 2c. `anythingRemoved` footer — PASS

At `uninstall.ts:254–261`: footer says "Uninstall complete" only when `anythingRemoved === true`; otherwise "Nothing to remove — no apra-fleet installation found for the specified scope." Correct per requirements.

### 2d. SEA compatibility (readline) — PASS

At `uninstall.ts:4`: `import * as readlinePromises from 'node:readline/promises'` — static import, no `import()` expression anywhere in uninstall.ts. SEA-compatible.

### 2e. Settings cleanup (cleanupSettings) — PASS

Correctly handles: `mcpServers`, `mcp_servers` (Codex format), `permissions.allow` filtering, `hooks.PostToolUse` filtering, `statusLine` removal, `defaultModel` conditional removal (only if matching fleet standard). All mutations gated by `!dryRun`. Changes written atomically via `writeConfig`.

### 2f. Config refactor (config.ts) — PASS

Shared config functions properly extracted. `readInstallConfig` handles old `{ llm, skill }` format migration, corrupt/missing file. `writeInstallConfig` merges into existing providers map. install.ts and update.ts both import from config.ts without regression.

### 2g. Dynamic import in index.ts — PASS

`src/index.ts:40` uses `import('./cli/uninstall.js')` — same pattern as install/auth/update. This is the correct SEA-compatible pattern for CLI subcommands (they aren't loaded at module parse time).

---

## 3. Test Coverage — MEDIUM

### Covered:
- Help text display
- User abort (says 'n')
- Dry-run (no mutations)
- Multi-provider cleanup
- Claude CLI MCP removal
- `--skill pm` and `--skill fleet` targeting
- `--llm` targeting
- Settings key cleanup (mcpServers, permissions, hooks, statusLine)
- defaultModel conditional removal
- Old config format migration
- Fallback scanning (no config file)
- Server running abort

### Missing (not blocking, but notable gaps):

| Gap | Severity |
|---|---|
| No test for `--force` stopping a running server | MEDIUM |
| No test for `--dry-run --force` (reports but doesn't stop) | MEDIUM |
| No test for `anythingRemoved` false path (footer message) | LOW |
| No test verifying `--skill pm/fleet` does NOT call `cleanupSettings` / `writeFileSync` | MEDIUM |
| No test for `mcp_servers` (Codex format) cleanup | LOW |

These are not blocking because the logic is straightforward and covered by code inspection, but they should be added before the next release.

---

## 4. Other Observations

### 4a. Global cleanup skips `anythingRemoved` tracking — LOW

At `uninstall.ts:232–252`, the global cleanup section (BIN_DIR, HOOKS_DIR, SCRIPTS_DIR, install-config.json) does NOT set `anythingRemoved = true`. If a user runs a full uninstall where only global files exist (no provider-specific artifacts), the footer will incorrectly say "Nothing to remove." This is an edge case but technically incorrect.

### 4b. `readConfig` empty-content handling — LOW

`config.ts:78` trims content and returns `{}` for empty strings. The original `install.ts` version did not trim. This is a minor behavioral change but safe — empty settings files are treated as empty objects either way.

---

## Verdict: APPROVED

### Blocking issues — RESOLVED

1. **File hygiene** — The 5 stale/scratch files (`requirements-98.md`, `run_me.bat`, `test.md`, `test.txt`, `update-progress.js`) were removed in commit `43bf085`. Verified: `git diff --name-only origin/main..feat/uninstall-command` returns zero matches for these files.

### Re-verification
- **Build:** not re-run (no source changes in `43bf085`, only file deletions)
- **Tests:** 66 files, 1087 passed, 6 skipped, 0 failed. PASS.

### Non-blocking (recommended before merge):
1. Add test for `--force` server stop behavior
2. Add test for `--dry-run --force` no-stop behavior
3. Add test verifying `--skill pm` does not touch settings/MCP
4. Fix global cleanup `anythingRemoved` tracking (LOW)
