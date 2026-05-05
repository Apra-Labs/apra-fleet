# apra-fleet #245 — Uninstall Command — Requirements

## Source
GitHub Issue: https://github.com/Apra-Labs/apra-fleet/issues/245
Repo: Apra-Labs/apra-fleet
Base branch: main

## Problem

There is no way to undo an `apra-fleet install` without manually editing config files. If a user accidentally runs `apra-fleet install --llm gemini` on a machine where only Claude was intended, they must manually remove MCP registrations, permissions, skills, hooks, and statusline entries from the provider's config — with no guidance on what was installed or where.

This was encountered in practice: running install with `--llm gemini` registered apra-fleet as an MCP server in `~/.gemini/settings.json`, which caused Gemini CLI sessions to spawn a second fleet server process (sharing the same `FLEET_DIR`), resulting in split-brain execute_prompt sessions.

## Proposed Solution

Add an `apra-fleet uninstall` command that reverses install operations, with the same targeting flags as install.

### Command Variants

| Command | Effect |
|---------|--------|
| `apra-fleet uninstall` | Full uninstall based on `install-config.json` — removes everything that was installed |
| `apra-fleet uninstall --llm gemini` | Remove only Gemini registrations (MCP, permissions, skills, hooks, statusline, defaultModel) |
| `apra-fleet uninstall --llm claude` | Remove only Claude registrations |
| `apra-fleet uninstall --llm gemini --skill pm` | Remove only the PM skill from Gemini |
| `apra-fleet uninstall --llm gemini --skill fleet` | Remove only the Fleet skill from Gemini |
| `apra-fleet uninstall --skill pm` | Remove PM skill from all installed providers |

### What Gets Removed Per Provider (Gemini)

- `~/.gemini/settings.json` → remove `mcpServers.apra-fleet`, `permissions.allow` (fleet entries), `defaultModel`, `statusLine`, `hooks`
- `~/.gemini/skills/fleet/` → delete directory (if `--skill fleet` or no skill filter)
- `~/.gemini/skills/pm/` → delete directory (if `--skill pm` or no skill filter)

Claude equivalent:
- `~/.claude/settings.json` → remove apra-fleet MCP entry, fleet permissions
- `~/.claude/skills/fleet/` and `~/.claude/skills/pm/` → delete (per skill filter)

### install-config.json as Source of Truth

`install-config.json` (written at install time) records which providers and skills were installed. `apra-fleet uninstall` (no flags) reads this file and reverses exactly what it recorded — no guessing.

If `install-config.json` is missing, fall back to scanning known config paths and warn the user.

### Implementation Notes

- Uninstall logic mirrors `install.ts` — same `getProviderInstallConfig()` path resolution, inverted operations
- For settings files: use the same merge strategy as install but in reverse (remove keys, don't clobber unrelated user settings)
- For skill directories: `rm -rf` only the fleet-managed subdirs, not the entire `~/.gemini/skills/`
- Dry-run flag (`--dry-run`) should print what would be removed without doing it
- Confirm prompt before destructive action unless `--yes` flag is passed

## Acceptance Criteria

- [ ] `apra-fleet uninstall` reads `install-config.json` and reverses all recorded install steps
- [ ] `apra-fleet uninstall --llm <provider>` removes only that provider's registrations
- [ ] `apra-fleet uninstall --llm <provider> --skill <name>` removes only that skill from that provider
- [ ] `apra-fleet uninstall --skill <name>` removes that skill from all providers
- [ ] Settings files are surgically edited — unrelated user settings are preserved
- [ ] `--dry-run` prints the plan without executing
- [ ] Works on Windows and macOS
- [ ] If `install-config.json` is missing, warns and offers best-effort scan
