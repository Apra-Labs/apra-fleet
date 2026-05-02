# Review: feat/gemini-mcp-fix (Phases 1–3)

**Reviewer:** fleet-reviewer  
**Date:** 2026-05-02  
**Branch:** `feat/gemini-mcp-fix` (commits `da829b6..6e17319`)  
**Verdict:** APPROVED with minor notes

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

The deferred read-merge TODO (preserving existing OAuth settings during `deliverConfigFile`) remains open but is pre-existing and documented. Tests (T4, T5) will be reviewed separately.

**APPROVED** — ready for test phase.
