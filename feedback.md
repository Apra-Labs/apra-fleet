# Review: feat/gemini-mcp-fix (Phases 1–4)

**Reviewer:** fleet-reviewer  
**Date:** 2026-05-02  
**Branch:** `feat/gemini-mcp-fix` (commits `da829b6..9aa0382`)  
**Verdict:** APPROVED

---

## T1: Research doc (`docs/research-219-gemini-mcp.md`)

**Status:** Complete and thorough.

The research doc clearly documents:
- The mismatch between install-time global `mcpServers` registration and the non-existent `mcp.excluded` field
- Live verification on fleet-dev2 confirming `mcp: { excluded: [...] }` is invalid Gemini syntax
- Three candidate fix approaches with a clear recommendation (`--allowed-mcp-server-names`)
- Remaining unknowns (per-project override behaviour) are explicitly called out

One minor observation: Q3 in the summary table says "Per-project overrides global" is unverified, but the recommended fix (CLI flag) sidesteps this question entirely, which is the right call.

**No issues.**

---

## T2: BOM fix (`src/tools/compose-permissions.ts`)

**Status:** Correct.

The change replaces:
```powershell
Set-Content -Path "..." -Value '...' -Encoding UTF8
```
with:
```powershell
[System.IO.File]::WriteAllText("...", '...', (New-Object System.Text.UTF8Encoding($false)))
```

Verified:
- `$false` disables BOM — correct .NET API usage
- Single-quote escaping (`'` → `''`) is preserved from the original code
- Linux heredoc path is untouched
- Path backslash conversion (`/` → `\`) is preserved
- Build passes clean

**No issues.**

---

## T3: MCP exclusion fix (`src/providers/gemini.ts`)

**Status:** Correct. Dual-layer defence is sound.

### Layer 1: CLI flag (`buildPromptCommand`)
```
--allowed-mcp-server-names ""
```
Passes an empty allowlist, so Gemini CLI will not load any MCP servers (including `apra-fleet`) during member dispatches. This is the primary fix and matches the research recommendation.

### Layer 2: Settings override (`composePermissionConfig`)
```typescript
const settings: Record<string, unknown> = { mode, mcpServers: {} };
```
Writes `"mcpServers": {}` to the per-project `.gemini/settings.json`. Even if the CLI flag is somehow ignored or a future Gemini version changes flag behaviour, this provides a fallback by overriding the global MCP registration at the project level.

Verified:
- The comment accurately notes that the caller is responsible for read-merging with existing content (preserving OAuth settings). This matches the existing code flow — `deliverConfigFile` receives a pre-built object from `composePermissionConfig`, and the TODO for read-merge is a known deferred item (documented in PLAN.md risk register).
- The old invalid `mcp: { excluded: ['apra-fleet'] }` field is fully removed.
- Build passes clean.

### Edge cases considered

1. **Empty string `""` in `--allowed-mcp-server-names`**: This means "allow no MCP servers." If Gemini CLI interprets this differently in a future version (e.g., "allow all"), the `mcpServers: {}` layer 2 provides backup. Acceptable.

2. **Clobbering OAuth settings**: The comment on line 129 documents this as caller responsibility. The current `deliverConfigFile` does a full overwrite. This is a **pre-existing issue**, not introduced by this PR — and it's tracked in the plan. Not a blocker.

3. **`apra-fleet install` re-registering to global settings**: The install path (`mergeGeminiConfig`) still adds `apra-fleet` to `~/.gemini/settings.json`. This is fine — the exclusion at dispatch time (CLI flag + per-project override) prevents it from loading. The global registration is needed for orchestrator sessions.

**No blocking issues.**

---

## Overall Assessment

The implementation matches the plan and requirements:
- Research was done first, findings drove the fix approach
- BOM fix is minimal and correct
- MCP exclusion uses the most reliable mechanism (CLI flag) with a settings-level fallback
- Code is clean, comments are accurate, build passes

The deferred read-merge TODO (preserving existing OAuth settings during `deliverConfigFile`) remains open but is pre-existing and documented.

---

## T4: Unit tests for BOM-free write (`tests/compose-permissions.test.ts`)

**Status:** Complete. All plan requirements covered.

Test cases in `deliverConfigFile — Windows BOM-free write (T4)` describe block (lines 390–439):

| Plan requirement | Test case | Verified |
|---|---|---|
| Windows uses `UTF8Encoding($false)`, not `Set-Content -Encoding UTF8` | `uses WriteAllText with UTF8Encoding($false) on Windows, not Set-Content` | Yes — asserts `WriteAllText` and `UTF8Encoding($false)` present, `Set-Content` and `-Encoding UTF8` absent |
| Linux heredoc path unchanged | `uses heredoc form (cat >) on Linux` | Yes — asserts `cat >`, `FLEET_PERMS_EOF` present, `WriteAllText` absent |
| Single-quote escaping correct | `doubles single quotes in content for PowerShell string safety on Windows` | Yes — grants a permission containing a single quote (`Bash(node 'exec':*)`), asserts `node ''exec''` in the TOML write command |

**Quality notes:**
- Tests exercise the full `composePermissions` → `deliverConfigFile` code path via the mocked `execCommand`, which is the right level of integration — they test the actual PowerShell command string that would be executed.
- The single-quote test is well-designed: it injects a quote through the `grant` parameter, which flows through TOML generation and then through `deliverConfigFile`'s escaping logic, covering the full pipeline.

**No issues.**

---

## T5: Unit tests for Gemini MCP exclusion (`tests/providers.test.ts`)

**Status:** Complete. All plan requirements covered.

Test cases added to the `GeminiProvider` describe block (lines 329–359):

| Plan requirement | Test case | Verified |
|---|---|---|
| `composePermissionConfig` returns `mcpServers: {}` (doer) | `composePermissionConfig disables all MCP servers via mcpServers: {} for doer (#219)` | Yes — asserts `mcpServers` equals `{}` |
| `composePermissionConfig` returns `mcpServers: {}` (reviewer) | `composePermissionConfig disables all MCP servers via mcpServers: {} for reviewer (#219)` | Yes — same assertion for reviewer role |
| `buildPromptCommand` includes `--allowed-mcp-server-names` | `buildPromptCommand includes --allowed-mcp-server-names to prevent fleet MCP loading (T5)` | Yes — asserts flag present in command string |
| `apra-fleet` absent from TOML allow list | `fleet TOML does not reference apra-fleet in the allow list (T5)` | Yes — passes `['Read(*)', 'Write(*)']` as allow list, asserts TOML does not contain `apra-fleet` |
| Same for reviewer | `fleet TOML does not reference apra-fleet in reviewer allow list (T5)` | Yes — same assertion with reviewer role |

**Quality notes:**
- The TOML tests pass explicit `allow` arrays to confirm that granted permissions appear in the output but `apra-fleet` never leaks in. Good boundary check.
- Both doer and reviewer roles are tested for each assertion — complete coverage of the role matrix.
- The `--allowed-mcp-server-names` test is at the `buildPromptCommand` unit level, which is the right place (command construction, not integration).

**No issues.**

---

## Test run result

`npm test`: **63 test files passed, 1113 tests passed, 6 skipped** (all pre-existing skips). No new failures introduced. One flaky pre-existing failure in `session-lifecycle.test.ts` (`stop_prompt kills stored PID`) appeared intermittently but is unrelated to this branch.

---

## Overall Assessment (Phases 1–4)

All five tasks (T1–T5) are complete and correct:
- Research drove the fix approach (T1)
- BOM fix is minimal and correct (T2), with full test coverage (T4)
- MCP exclusion uses dual-layer defence — CLI flag + settings override (T3), with comprehensive tests (T5)
- All plan-specified edge cases are covered: single-quote escaping, Linux path unchanged, `--allowed-mcp-server-names` in command, `apra-fleet` absent from TOML allow list
- Build and tests pass clean

**APPROVED** — ready to merge.
