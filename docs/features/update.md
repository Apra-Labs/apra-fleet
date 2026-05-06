# Self-Update Command

## What it does

`apra-fleet update` updates the fleet binary to the latest stable GitHub release without requiring manual download or reinstall steps.

## Behaviour

1. Fetches the latest release metadata from the GitHub releases API
2. Compares the latest tag against the running version — skips pre-release tags (`-alpha`, `-beta`, `-rc`)
3. If a newer version exists: downloads the platform-appropriate installer to a temp directory, then spawns it with the same `--llm` and `--skill` values recorded in `install-config.json`, and exits — the new installer takes over, handles the server stop/restart cycle, and replaces the binary
4. If already up to date: reports the current version and exits cleanly

## Platform detection

| Platform | Installer downloaded |
|----------|---------------------|
| Windows x64 | `apra-fleet-installer-win-x64.exe` |
| macOS ARM | `apra-fleet-installer-darwin-arm64` |
| Linux x64 | `apra-fleet-installer-linux-x64` |

## install-config.json usage

The update command reads `~/.apra-fleet/data/install-config.json` to determine which `--llm` provider and `--skill` set to pass to the new installer, preserving the original install configuration. If the config is missing, it falls back to `--llm claude --skill all`.

## Notes

- There is no `--check` flag — `apra-fleet update` always applies the update if one is available
- The update check has a 5-second network timeout; on failure it prints an error and exits non-destructively
- The old binary is overwritten by the installer (no `.bak` created) — to roll back, download the previous release manually and re-run with `--force` (see `deploy.md`)
