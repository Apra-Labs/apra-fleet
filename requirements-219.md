# Issue #219 — Gemini members launch apra-fleet.exe

## Problem

Gemini member conversations launch `apra-fleet.exe` (the fleet MCP server) on every dispatch. Only the orchestrator conversation should run the fleet MCP server. This was already fixed for Claude members; Gemini members are still affected.

Two related bugs are fixed together since they share the same code path in `src/tools/compose-permissions.ts` → `deliverConfigFile()`:

1. **MCP launch bug**: `compose_permissions` writes `.gemini/settings.json` with `mcp: { excluded: ['apra-fleet'] }` but the exclusion may not work correctly — either the syntax is wrong or the global `~/.gemini/settings.json` (which may have `apra-fleet` in its MCP server list) overrides the per-project exclusion.

2. **BOM bug**: `deliverConfigFile()` uses `Set-Content -Encoding UTF8` on Windows (PowerShell 5.x), which writes UTF-8 with BOM. This corrupts `.gemini/settings.json` — Gemini CLI may fail to parse it, and git treats it as binary.

## Root cause

- `src/tools/compose-permissions.ts` `deliverConfigFile()` — Windows write path uses `Set-Content -Encoding UTF8` (BOM)
- `src/providers/gemini.ts` `composePermissionConfig()` — exclusion field `mcp: { excluded: [...] }` may use wrong Gemini settings format, or may not override global settings

## Expected behaviour

- After `compose_permissions`, Gemini member dispatches do not launch `apra-fleet.exe`
- `.gemini/settings.json` written by fleet on Windows is valid UTF-8 without BOM
- Gemini CLI parses the settings file correctly

## Files in scope

- `src/tools/compose-permissions.ts` — `deliverConfigFile()` Windows write
- `src/providers/gemini.ts` — `composePermissionConfig()` MCP exclusion logic
- `tests/compose-permissions.test.ts` (new or existing)
- `tests/providers/gemini.test.ts` (new or existing)

## Notes

- Base branch: `main`
- Both bugs must be fixed in the same PR — they share the delivery path
- MCP exclusion fix must work for both global (`~/.gemini/settings.json`) and per-project (`.gemini/settings.json`) Gemini settings
