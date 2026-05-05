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
