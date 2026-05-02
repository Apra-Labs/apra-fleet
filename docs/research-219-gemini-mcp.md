# Research: Gemini MCP Exclusion Syntax (Issue #219)

**Date:** 2026-05-02  
**Task:** T1 — Verify Gemini settings.json MCP exclusion syntax on a live member  
**Status:** Research findings with live member verification required

---

## Current State (from code inspection)

### Install time: How `apra-fleet` gets into Gemini settings
From `src/cli/install.ts:mergeGeminiConfig()`:
```typescript
settings.mcpServers = settings.mcpServers || {};
settings.mcpServers['apra-fleet'] = {
  ...mcpConfig,  // { command, args }
  trust: true,
};
```

**Finding:** When `apra-fleet install --llm gemini` runs, it adds `apra-fleet` to the **global** `~/.gemini/settings.json` under the `mcpServers` key. This registers the MCP server so Gemini CLI can call it.

### Permission config time: Attempted exclusion (current bug)
From `src/providers/gemini.ts:composePermissionConfig()` line 132:
```typescript
const settings: Record<string, unknown> = { mode, mcp: { excluded: ['apra-fleet'] } };
```

**Finding:** The per-project `compose_permissions` writes a **project-level** `~/.gemini/settings.json` (delivered to `${projectDir}/.gemini/settings.json` on the member) that attempts to exclude `apra-fleet` using an `mcp.excluded` field.

---

## Problem Identified

**Mismatch in config structure:**
- Install uses: `settings.mcpServers['apra-fleet']` (global config)
- Exclusion attempts: `settings.mcp.excluded` (project config)

These config keys are unrelated. Even if `mcp.excluded` is the correct Gemini CLI syntax, excluding `apra-fleet` in a per-project config does **not** unregister it from the global `mcpServers` where it was installed.

**Potential causes of the bug:**
1. **Field name wrong:** The exclusion field name is not `mcp.excluded` — Gemini CLI may use a different key (e.g., `mcpServersExcluded`, `mcp.disable`, `excludedServers`)
2. **Per-project override fails:** Gemini CLI may not respect per-project `mcp` exclusions — the global `mcpServers` registration always wins
3. **Both:** The field is wrong AND per-project overrides don't work

---

## Research Questions (Require Live Member Verification)

### Q1: What is the correct Gemini CLI syntax for excluding MCP servers?

**How to verify:**
1. On fleet-dev2 (or a live Gemini member):
   - Run `gemini --help` and search for MCP exclusion syntax in the output
   - Inspect `~/.gemini/settings.json` (global) and understand its schema
   - Check Gemini CLI GitHub repo or documentation for `mcp` config options

**Expected outcomes:**
- Field name: `mcp.excluded` (current) or something else (e.g., `mcpServersExcluded`, `excludedMcpServers`)
- Syntax example: `{ "mcp": { "excluded": ["apra-fleet"] } }` or `{ "excludedServers": ["apra-fleet"] }`

### Q2: Does a per-project `.gemini/settings.json` override entries in the global `~/.gemini/settings.json`?

**How to verify:**
1. Create a per-project `.gemini/settings.json` with `mcp: { excluded: ['test-server'] }`
2. Create/register a test MCP server in the global `~/.gemini/settings.json`
3. Run `gemini -p "use the test server"` from the project directory
4. Check if the exclusion takes effect (Gemini should NOT call the test MCP server)

**Expected outcomes:**
- Per-project **completely overrides** global (safest assumption)
- Per-project **merges with** global (likely, but needs verification)
- Per-project is **ignored** (problematic for our exclusion approach)

### Q3: Is `apra-fleet` already in the global settings on test members?

**How to verify:**
1. On fleet-dev2, check `~/.gemini/settings.json`
2. Look for `apra-fleet` entry under `mcpServers` or similar key
3. If found, document:
   - Field name where it appears
   - Configuration (command, args, trust)
   - Whether it got there from `apra-fleet install` or manual setup

**Expected outcome:**
- Yes, `apra-fleet` is registered under `mcpServers.apra-fleet` (from install)

---

## Current Code Issues

### In `src/providers/gemini.ts`
**Line 132:**
```typescript
const settings: Record<string, unknown> = { mode, mcp: { excluded: ['apra-fleet'] } };
```

- **Issue:** Field name unverified; syntax may be wrong
- **Issue:** Does not remove `apra-fleet` from the global registration
- **Issue:** TODO on line 129 notes this doesn't read-merge existing settings

### In `src/tools/compose-permissions.ts`
**Line 153 (Windows write):**
```typescript
`Set-Content -Path "..." -Value '...' -Encoding UTF8`
```

- **Issue:** PowerShell's `-Encoding UTF8` adds a UTF-8 BOM, corrupting JSON
- **Fix in plan:** Replace with `[System.IO.File]::WriteAllText("...", '...', (New-Object System.Text.UTF8Encoding($false)))`

---

## Hypothesis: Most Likely Root Cause

**The global `mcpServers` registration is not being overridden by the per-project exclusion.**

Reasoning:
1. Install registers `apra-fleet` globally — this is persistent
2. Per-project exclusion uses a different config key (`mcp.excluded` vs. `mcpServers`)
3. Even if the exclusion field is correct, it doesn't address the global registration

**Solution approach (Task 3):**
1. Verify the correct exclusion syntax with live member (Task 1)
2. If per-project exclusion doesn't work → also write to the **global** `~/.gemini/settings.json` to remove `apra-fleet` from `mcpServers`
3. If per-project exclusion works but field is wrong → fix the field name
4. If install adds fleet to global settings → also fix install path to not add it (or add a marker to remove it during permissions compose)

---

## Notes for Task 3 Implementation

- Must read existing `~/.gemini/settings.json` before writing (don't overwrite OAuth settings)
- May need to add a second config path in `permissionConfigPaths()` for the global settings file
- Consider whether `apra-fleet install` should add a removal marker instead of direct registration

---

## Summary Table

| Question | Current Code Assumption | Verified? | Blocks |
|----------|------------------------|-----------|--------|
| Correct exclusion field name | `mcp.excluded` | ❌ No | Task 3 |
| Per-project overrides global | Yes (implicit) | ❌ No | Task 3 |
| `apra-fleet` in global settings | Yes (from install) | ⚠️ Likely | Task 3 |
| BOM in Windows write | UTF-8 with BOM | ✅ Yes (confirmed bug) | Task 2 |

---

## Live Verification Results (fleet-dev2, Gemini CLI 0.40.1)

### Q1 — Is apra-fleet in global settings?
YES. `~/.gemini/settings.json` on fleet-dev2 contains:
```json
"mcpServers": {
  "apra-fleet": {
    "command": "C:\\Users\\akhil\\.apra-fleet\\bin\\apra-fleet.exe",
    "args": [],
    "trust": true
  }
}
```
This means every Gemini session on any member where apra-fleet was installed loads apra-fleet.exe automatically.

### Q2 — Correct syntax for MCP exclusion?
`mcp: { excluded: [...] }` is **WRONG** — no such field exists in Gemini settings.

Confirmed mechanisms:
1. **`--allowed-mcp-server-names <names>`** — CLI flag that whitelists specific MCP servers per session. Most reliable. Would need to be passed when fleet launches `gemini -p`.
2. **Remove from `mcpServers`** — if per-project `.gemini/settings.json` can override global `mcpServers`, writing `"mcpServers": {}` per-project would suppress all MCP servers for that project.
3. **Per-project `permissions.allow`** — could omit `mcp__apra-fleet__*` to deny tool access even if server is loaded.

### Q3 — Does per-project override global?
Unknown from current data. The per-project `.gemini/settings.json` on fleet-dev2 only has `{"mode": "auto_edit"}` — no MCP config — so merge behaviour is untested.

### Recommended fix for T3
Option 1 (`--allowed-mcp-server-names`) is the most reliable: pass an empty or non-fleet list when fleet launches `gemini -p` on members. This requires changing `src/providers/gemini.ts` `buildPromptCommand()` to add the flag, rather than writing settings.json. The compose_permissions fix becomes: write `"mcpServers": {}` (remove apra-fleet) in the per-project settings AND investigate if per-project overrides global.
