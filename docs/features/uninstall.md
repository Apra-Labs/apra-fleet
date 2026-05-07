# Uninstall Command

## Why it exists

Running `apra-fleet install --llm gemini` on a machine where only Claude was intended caused a split-brain problem: Gemini CLI sessions would spawn a second fleet server process sharing the same `FLEET_DIR`, resulting in `execute_prompt` sessions routing to the wrong server instance. There was no clean way to reverse an install — users had to manually edit provider config files with no guidance on what was installed or where.

## Design

### install-config.json as source of truth

At install time, fleet writes `~/.apra-fleet/data/install-config.json` with a keyed-by-provider schema:

```json
{
  "providers": {
    "claude": { "skill": "all" },
    "gemini": { "skill": "fleet" }
  }
}
```

`apra-fleet uninstall` (no flags) reads this file and reverses exactly what it recorded. If the file is missing or corrupt, the command falls back to scanning all known provider config paths and warns the user before proceeding.

Multiple installs (e.g. first `--llm claude`, later `--llm gemini`) merge into the map rather than overwriting, so the uninstall can target each provider independently.

### Surgical settings cleanup

Uninstall does not rewrite settings files wholesale — it removes only the keys fleet installed:

| Key | Action |
|-----|--------|
| `mcpServers.apra-fleet` / `mcp_servers.apra-fleet` | Delete key |
| `permissions.allow` | Filter out fleet-specific entries; preserve user-added ones |
| `hooks.PostToolUse` | Filter out entries with fleet matchers; preserve user hooks |
| `statusLine` | Delete key |
| `defaultModel` | Delete only if it matches the fleet-installed standard model for that provider |

For Claude, MCP removal uses the CLI command `claude mcp remove apra-fleet --scope user` rather than direct settings.json editing (matching how install registers it).

### --skill scoping

`--skill pm` or `--skill fleet` removes only skill directories. Settings/MCP/hooks/permissions cleanup only runs for `--skill all` (the default). This allows targeted skill removal without touching provider config.

### Running server guard

If the fleet server is running when uninstall is invoked, the command aborts with a clear error suggesting `--force`. With `--force`, the server is stopped automatically before proceeding. With `--dry-run --force`, the server-running state is reported but the server is not actually stopped — dry-run is purely observational.

### anythingRemoved tracking

The footer message is gated on whether the command actually found and removed anything. If no fleet installation is found for the specified scope, the command reports "Nothing to remove" rather than a misleading "Uninstall complete".

## Flags

| Flag | Effect |
|------|--------|
| `--dry-run` | Preview without modifying anything |
| `--force` | Auto-stop running server before uninstall |
| `--yes` | Skip confirmation prompt |
| `--llm <provider>` | Target a single provider |
| `--skill fleet\|pm\|all` | Scope skill directory removal (default: `all`) |

## SEA compatibility note

`readline` must use a static top-level import (`import * as readlinePromises from 'node:readline/promises'`). Dynamic `import()` is not supported in Node.js SEA (Single Executable Application) mode and will throw at runtime.
