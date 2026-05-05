# Uninstall Command (#245) — V3 Cumulative Code Review

**Reviewer:** claude-opus (code reviewer)
**Date:** 2026-05-05 18:45:00+05:30
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## Prior Review Context

The plan was APPROVED at commit 70ab625. This is the first code review, covering all implementation phases (T1–T5, V1–V3).

---

## Phase 1: Foundation (T1, T2) — Commit cdeeb14

### T1 — Shared Config Refactoring

Code extracted from `install.ts` into `src/cli/config.ts`: `getProviderInstallConfig`, `readConfig`, `writeConfig`, `PROVIDER_STANDARD_MODELS`, plus new `readInstallConfig` / `writeInstallConfig` for the multi-provider schema. PASS.

**Detail:** The multi-provider schema `{ providers: { claude: { skill, installedAt } } }` is correctly implemented. Old-format migration (`{ llm, skill }` → new schema) is handled in `readInstallConfig()` (config.ts:112–119). Merge-not-overwrite semantics confirmed in `writeInstallConfig()`. PASS.

**Minor note:** `readConfig` in config.ts:78 trims the content before parsing (`.trim()`), which the original install.ts did not do. This is a safe defensive addition — not a regression. PASS.

### T2 — Uninstall Command Scaffold

`src/cli/uninstall.ts` registered in `src/index.ts` with proper error handling. Help text documents all six command variants. Argument parsing supports both `--llm value` and `--llm=value` forms. PASS.

**Done criteria check:**
- `apra-fleet uninstall --help` works: PASS (exits after printing usage)
- Dry-run logging: PASS (all mutation paths guarded by `!dryRun`)
- All six variants handled: PASS (full, --llm only, --llm + --skill, --skill only iterates all providers)

### Install Tests Updated

`tests/install.test.ts` updated to assert the new multi-provider schema (`.providers.claude.skill` instead of flat `{ llm, skill }`). PASS.

---

## Phase 2: Core Uninstall Logic (T3, T4) — Commit f79582b

### T3 — Settings Cleanup

**Surgical key removal (cleanupSettings function):**
- `mcpServers.apra-fleet` removal: PASS — handles both JSON (`mcpServers`) and Codex TOML (`mcp_servers`) formats
- `permissions.allow` filtering: PASS — removes `mcp__apra-fleet__*` and skill-directory Read permissions; preserves user-added entries
- `hooks.PostToolUse` filtering: PASS — filters by matcher containing 'apra-fleet'
- `statusLine` removal: PASS — only removes if command contains 'fleet-statusline'
- `defaultModel` removal: PASS — only removes if value matches `PROVIDER_STANDARD_MODELS[provider]` (preserving user customization per plan F2 resolution)

**Claude CLI unregistration (F2):**
Code at uninstall.ts:181–186 calls `claude mcp remove apra-fleet --scope user` via the `run()` helper which uses `shell: 'cmd.exe'` on Windows. Matches the install-time behavior. Try-catch suppresses "not found" errors. PASS.

**Confirm prompt:** Interactive readline with abort on non-'y' answer. `--yes` bypasses. PASS.

### T4 — Skill Directory Removal

Skill removal respects `skillMode`: removes PM dir, fleet dir, or both. Uses `fs.rmSync` with `{ recursive: true, force: true }`. Only removes if directory exists. PASS.

**Fallback scan:** When `readInstallConfig()` returns empty providers and `targetLlm === 'all'`, all four providers are scanned (uninstall.ts:158). Warning logged. PASS.

**Global cleanup:** When full uninstall (`targetLlm === 'all'` && `skillMode === 'all'`), removes BIN_DIR, HOOKS_DIR, SCRIPTS_DIR, and install-config.json. Preserves `~/.apra-fleet/data/` (logs/registry) for potential reinstall. PASS.

---

## Phase 3: Unit Tests (T5) — FAIL

### Problem: T5 claims "Full unit test coverage" but progress.json still marks T5 as pending

`progress.json` shows T5 status as `"pending"`. The task file (.fleet-task.md) states T5 is completed since last review. This is a bookkeeping inconsistency — but more critically, the test coverage does NOT meet T5's done criteria.

### Coverage gaps (BLOCKING):

The current `tests/uninstall.test.ts` has 6 tests (119 lines). Against T5's done criteria ("Full test coverage... Cover multi-provider install-config, Claude CLI removal path, fallback scan, and --yes/confirm prompt"):

1. **Claude CLI unregistration path — NOT TESTED.** `child_process` is mocked but no test asserts that `execSync` is called with `claude mcp remove apra-fleet --scope user`. This was the subject of blocking finding F2 in the plan review — it must have test coverage.

2. **Abort path (user declines confirmation) — NOT TESTED.** No test mocks the readline response as 'N' and verifies the process exits without mutations.

3. **`--skill` flag targeting — NOT TESTED.** No test verifies that `--skill pm` removes only PM directories while leaving fleet directories intact, or vice versa.

4. **`defaultModel` cleanup — NOT TESTED.** No test verifies that a matching defaultModel is removed or that a non-matching one is preserved.

5. **Old format migration — NOT TESTED.** `readInstallConfig()` has logic to migrate `{ llm, skill }` to the new schema. No test covers this path.

These are not obscure edge cases — they are explicitly listed in T5's description and represent the core differentiated logic of the uninstall command.

---

## Build and Tests

- Build (`tsc`): PASS — no errors.
- Tests: 66 files, 1078 passed, 6 skipped, 0 failed. PASS.
- No regressions in previously passing tests. PASS.
- CI: No CI config in repo. N/A.

---

## Risk Register Compliance

| Risk | Status |
|------|--------|
| R1 (missing config) | Implemented — fallback scan + warning. PASS. |
| R2 (partial installs) | Implemented — skips providers with no entry. PASS. |
| R3 (race with running server) | **NOT IMPLEMENTED** — no detect-and-abort logic exists. NOTE (non-blocking for V3, but should be addressed before merge to main). |
| R4 (Windows paths) | Implemented — `path.join` + `shell: 'cmd.exe'`. PASS. |
| R5 (user-edited settings) | Partially — surgical removal is correct, but no post-uninstall warning is logged listing keys that couldn't be cleanly removed (plan says "Log a post-uninstall warning"). NOTE (non-blocking). |

---

## Summary

**What passed:** The core implementation (T1–T4) is solid — the multi-provider config schema, shared utility extraction, surgical settings cleanup, skill directory removal, and CLI integration are all correct and well-structured. Build is green. Existing tests pass. The code matches PLAN.md's design for Phases 1 and 2.

**What must change (BLOCKING):**

1. **T5 test coverage is incomplete.** At minimum, add tests for: (a) Claude CLI `execSync` call assertion, (b) abort path when user declines, (c) `--skill` flag targeting (fleet-only and pm-only), (d) `defaultModel` conditional removal. These cover the differentiated logic paths that the existing 6 tests do not exercise.

2. **Update `progress.json`** to reflect actual task status (T5 completed, V3 completed) once the tests are added.

**Non-blocking notes (address before merge):**

- R3 (server race detection) is specified in the risk register but not implemented. Consider adding a basic PID/port check.
- R5's "post-uninstall warning" for keys that couldn't be cleanly removed is not implemented.
