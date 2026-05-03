# Review Feedback — Gemini MCP Fix (#219)

## Phase 1-3: APPROVED (commit 1a32cba)

Phases 1-3 implemented research (T1), BOM-free write fix (T2), and Gemini MCP
server exclusion (T3). Dual-layer defence validated: CLI flag
`--allowed-mcp-server-names ""` blocks MCP at launch; `mcpServers: {}` in
settings blocks at config level.

## Phase 4: APPROVED (commit 9aa0382)

### T4 — BOM-free write tests (`tests/compose-permissions.test.ts:390-438`)

Three test cases covering `deliverConfigFile()`:

- **Windows**: asserts `WriteAllText` + `UTF8Encoding($false)` used, no
  `Set-Content` or `-Encoding UTF8` present.
- **Linux**: asserts heredoc `cat >` with `FLEET_PERMS_EOF` marker, no
  `WriteAllText`.
- **Single-quote escaping**: grants a permission containing `'exec'`, asserts
  it becomes `''exec''` (doubled for PowerShell single-quoted strings).

All three criteria met.

### T5 — Gemini MCP exclusion tests (`tests/providers.test.ts:342-359`)

Four test cases:

- `buildPromptCommand` includes `--allowed-mcp-server-names` flag (CLI layer).
- `composePermissionConfig` returns `mcpServers: {}` for both doer and reviewer
  roles (config layer).
- Fleet TOML does not reference `apra-fleet` in the allow list for either role.

Dual-layer defence fully validated at both provider-method and
compose-permissions integration levels.

### Test suite health

All 1113 tests pass across 63 test files. No regressions introduced.

## PR #232: Beads Install Step Bug Fix

### Issue
When `bd --version` call fails during Beads post-install validation, the banner section left `beadsVersion` as `'installed'` instead of showing the actual failure state.

**Doer:** fixed in commit f4e2a99 — catch block now sets beadsVersion to 'not available'

### Re-review (commit b1c111b) — APPROVED

Verified the one-line fix in `src/cli/install.ts`:

- **Before:** catch block was empty (`// not installed or unavailable`), leaving `beadsVersion` as `'installed'` even when `bd --version` fails.
- **After:** catch block sets `beadsVersion = 'not available'`, so the post-install banner correctly reflects failure.

All three code paths are sound:
1. `bd --version` succeeds with output → banner shows actual version string.
2. `bd --version` succeeds but returns empty → banner shows `'installed'` (fallback).
3. `bd --version` throws → banner shows `'not available'` (the fix).

**Tests:** 1066 passed, 7 skipped across 64 test files. No regressions.
